import { Component, type ErrorInfo, type ReactNode } from 'react';
import { describeThrown, reportRendererError } from '../lib/reportRendererError';

interface Props {
  children: ReactNode;
  /** Returns the person to somewhere that works; the boundary cannot know where that is. */
  onLeave?: () => void;
}

interface State {
  message: string | null;
  componentStack?: string;
}

/**
 * Keeps one broken view from taking the window with it.
 *
 * Without a boundary, a component that throws unmounts its whole subtree: the window goes blank
 * or partial, nothing says why, and the person is left guessing whether their build is stale.
 * That happened three times in one session, each time reported as something other than what it
 * was, because a hole in the page carries no information.
 *
 * Deliberately placed around the page content rather than the whole app, so the sidebar survives
 * and there is still a way out. A boundary that replaced everything would be the same trap with
 * better copy.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(thrown: unknown): State {
    return { message: describeThrown(thrown).message };
  }

  componentDidCatch(thrown: unknown, info: ErrorInfo): void {
    const { message, stack } = describeThrown(thrown);
    // The component stack is the part that actually locates it: a minified frame says nothing,
    // "in ModelLibrary (at App.tsx)" says everything.
    this.setState({ componentStack: info.componentStack ?? undefined });
    reportRendererError({ source: 'boundary', message, stack, componentStack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <PageErrorFallback
        message={this.state.message}
        componentStack={this.state.componentStack}
        onLeave={this.props.onLeave && (() => {
          this.setState({ message: null, componentStack: undefined });
          this.props.onLeave?.();
        })}
      />
    );
  }
}

/**
 * The fallback, separate from the boundary that catches.
 *
 * React only runs error boundaries on the client, so a boundary's own fallback cannot be rendered
 * by the static renderer the tests use. Splitting it means the thing that matters — that the
 * message and a way out actually appear — is testable without a DOM.
 */
export function PageErrorFallback(
  { message, componentStack, onLeave }: { message: string; componentStack?: string; onLeave?: () => void }
) {
  return (
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-8">
        <div className="w-full max-w-xl">
          <h2 className="text-sm font-medium text-ink">This view stopped working</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            The rest of Antimatter is still running, and nothing you have said or done in this conversation is lost.
            The error below has also been written to the log.
          </p>
          <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-[11px] leading-relaxed text-danger">
            {message}
            {componentStack ? `\n${componentStack}` : ''}
          </pre>
          <div className="mt-3 flex gap-2">
            {onLeave && (
              <button
                type="button"
                onClick={onLeave}
                className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink"
              >
                Back to chat
              </button>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-2 hover:text-ink"
            >
              Reload the window
            </button>
          </div>
        </div>
      </div>
    );
}
