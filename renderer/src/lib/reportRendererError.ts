/**
 * Tells someone when the renderer throws.
 *
 * Nothing did. There was no `window.onerror`, no unhandled-rejection handler and no error
 * boundary anywhere in the renderer, so a component that threw unmounted its subtree and the
 * window went blank or partial with the cause recorded nowhere — not in the log, not on screen.
 * On 2026-11-17 that turned "clicking the model selection crashes the renderer" into three wrong
 * hypotheses in a row, because the only evidence available was the shape of the hole.
 *
 * The point of this file is that the next such failure names itself.
 */

/** Where a report came from, so a stack with no component context is still placed. */
export type RendererErrorSource = 'window' | 'promise' | 'boundary';

export interface RendererErrorReport {
  source: RendererErrorSource;
  message: string;
  stack?: string;
  /** The React component stack, when a boundary caught it: the actual "which view" answer. */
  componentStack?: string;
  at: string;
}

const LIMIT = 8_000;

const clip = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length > LIMIT ? `${value.slice(0, LIMIT)}\n… [truncated]` : value;
};

/** Normalizes whatever was thrown — an Error, a string, a DOM event, an object. */
export function describeThrown(thrown: unknown): { message: string; stack?: string } {
  if (thrown instanceof Error) {
    return { message: thrown.message || thrown.name || 'Error', stack: clip(thrown.stack) };
  }
  if (typeof thrown === 'string') return { message: clip(thrown) ?? 'Unknown error' };
  try {
    return { message: clip(JSON.stringify(thrown)) ?? 'Unknown error' };
  } catch {
    return { message: String(thrown) };
  }
}

/**
 * Sends one report to main, which logs it where the terminal and the dev log can see it.
 *
 * Never throws and never awaits. A reporter that can fail while reporting a failure is worse
 * than none: it replaces a diagnosable crash with an undiagnosable one.
 */
export function reportRendererError(report: Omit<RendererErrorReport, 'at'>): void {
  const full: RendererErrorReport = { ...report, at: new Date().toISOString() };
  // Always to the console too: if the IPC is missing — an older preload — the console is the
  // only place left, and that is exactly the situation this was written for.
  console.error(`[renderer:${full.source}]`, full.message, full.stack ?? '', full.componentStack ?? '');
  try {
    const send = (window as { electronAPI?: { reportError?: (value: unknown) => void } }).electronAPI?.reportError;
    if (typeof send === 'function') send(full);
  } catch {
    // Deliberately silent; the console line above has already landed.
  }
}

let installed = false;

/** Call once, as early as the renderer can manage. Repeat calls are ignored. */
export function installRendererErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    const { message, stack } = describeThrown(event.error ?? event.message);
    reportRendererError({ source: 'window', message, stack });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const { message, stack } = describeThrown((event as PromiseRejectionEvent).reason);
    reportRendererError({ source: 'promise', message, stack });
  });
}
