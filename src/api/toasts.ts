/**
 * Transient notices.
 *
 * The app had two ways to tell someone something and neither fit. A `role="status"` line inside
 * a panel only works while that panel is open, and a modal stops the thing being worked on. A
 * toast is for the third case: something happened that is worth knowing and not worth blocking
 * on — a download finished, an engine gave up, a project has never been looked at.
 *
 * Rules that the type enforces rather than leaves to each caller:
 *
 *  - **A toast is dismissible.** Everything can be got rid of; nothing demands an answer. A
 *    notice that must be answered is a dialog, and this is deliberately not that.
 *  - **A repeat replaces.** Anything with a `key` collapses onto its predecessor, so an engine
 *    restarting five times is one notice with the latest reason, not five stacked ones.
 *  - **Text is bounded.** A toast is a line, not a log. Callers include ones relaying a server's
 *    error string, so the cap is in the validator and not in the caller's discipline.
 *  - **Actions are identifiers, not functions.** An action crosses from wherever it was raised to
 *    whoever handles it, so it carries an id to switch on. A toast is data, which is what lets
 *    the main process raise one.
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export const TOAST_TONES: readonly ToastTone[] = Object.freeze(['info', 'success', 'warning', 'danger']);

export const MAX_TOAST_TITLE = 120;
export const MAX_TOAST_BODY = 400;
export const MAX_TOAST_ACTIONS = 3;
export const MAX_TOAST_ACTION_LABEL = 40;
/** More than this on screen stops being a notice and becomes a wall. Oldest are dropped. */
export const MAX_VISIBLE_TOASTS = 4;

/** How long a tone lingers when the caller does not say. Bad news waits to be read. */
export const DEFAULT_TOAST_TIMEOUT: Record<ToastTone, number | null> = Object.freeze({
  info: 6_000,
  success: 4_000,
  warning: 12_000,
  danger: null,
});

export interface ToastAction {
  /** Switched on by the handler. Not a label and not a function. */
  id: string;
  label: string;
  /** Draws the eye; at most one per toast is honoured by the host. */
  primary?: boolean;
}

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  body?: string;
  actions?: ToastAction[];
  /** Milliseconds, or null to stay until dismissed. The tone's default when omitted. */
  timeoutMs?: number | null;
  /** Collapse key. A later toast with the same key replaces the earlier one in place. */
  key?: string;
}

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body: string | null;
  actions: ToastAction[];
  timeoutMs: number | null;
  key: string | null;
  createdAt: number;
}

const text = (value: unknown, limit: number): string | null => {
  if (typeof value !== 'string') return null;
  // Control characters would let a relayed server string break the layout, and a toast is one
  // line of prose: newlines and tabs collapse rather than being rendered.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
};

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value);

/**
 * Turn a caller's input into a toast, or throw. Toasts can originate in the main process and
 * relay text this app did not write, so this is a boundary and not a convenience.
 */
export function buildToast(input: unknown, id: string, now: number): Toast {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A toast must be an object.');
  const record = input as Record<string, unknown>;
  const title = text(record.title, MAX_TOAST_TITLE);
  if (!title) throw new Error('A toast needs something to say.');
  const tone: ToastTone = TOAST_TONES.includes(record.tone as ToastTone) ? record.tone as ToastTone : 'info';

  let actions: ToastAction[] = [];
  if (record.actions !== undefined) {
    if (!Array.isArray(record.actions)) throw new Error('Toast actions must be a list.');
    if (record.actions.length > MAX_TOAST_ACTIONS) throw new Error(`A toast offers at most ${MAX_TOAST_ACTIONS} actions.`);
    actions = record.actions.map((value) => {
      const action = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const label = text(action.label, MAX_TOAST_ACTION_LABEL);
      if (!isIdentifier(action.id)) throw new Error('A toast action needs an id of letters, digits and _.:- only.');
      if (!label) throw new Error('A toast action needs a label.');
      return { id: action.id, label, ...(action.primary === true ? { primary: true } : {}) };
    });
    // Two primaries is an ambiguous ask; only the first keeps the emphasis.
    let seenPrimary = false;
    actions = actions.map((action) => {
      if (!action.primary) return action;
      if (seenPrimary) return { id: action.id, label: action.label };
      seenPrimary = true;
      return action;
    });
  }

  let timeoutMs: number | null;
  if (record.timeoutMs === undefined) timeoutMs = DEFAULT_TOAST_TIMEOUT[tone];
  else if (record.timeoutMs === null) timeoutMs = null;
  else if (typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) && record.timeoutMs >= 1_000 && record.timeoutMs <= 120_000) {
    timeoutMs = Math.round(record.timeoutMs);
  } else throw new Error('A toast timeout is null, or between 1000 and 120000 milliseconds.');

  if (record.key !== undefined && !isIdentifier(record.key)) {
    throw new Error('A toast key is letters, digits and _.:- only.');
  }

  return {
    id,
    tone,
    title,
    body: text(record.body, MAX_TOAST_BODY),
    actions,
    timeoutMs,
    key: (record.key as string | undefined) ?? null,
    createdAt: now,
  };
}

/**
 * Place a toast in a list, collapsing a keyed repeat onto its predecessor **in place** rather
 * than moving it to the end: a notice that keeps updating should not keep jumping position under
 * the pointer heading for its dismiss button.
 */
export function placeToast(existing: readonly Toast[], toast: Toast, limit = MAX_VISIBLE_TOASTS): Toast[] {
  const at = toast.key === null ? -1 : existing.findIndex((candidate) => candidate.key === toast.key);
  if (at >= 0) {
    const next = [...existing];
    next[at] = toast;
    return next;
  }
  // Oldest first, so the newest is the one kept when the list is full.
  return [...existing, toast].slice(-limit);
}
