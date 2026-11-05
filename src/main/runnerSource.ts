/**
 * Which source and model the orchestrator dispatches on.
 *
 * `codex.provider` in WORKFLOW.md pins the runner so an unattended run is deterministic. When it
 * is absent the fallback used to be `sources[0]`, which is not a choice so much as an accident of
 * list order — WORKFLOW.md's own comment records a reconnect reordering the list and silently
 * changing the default model, and that first entry can even be a source whose server is stopped.
 * Following the chat instead makes the unpinned case mean "the model doing the work", which is
 * what an orchestrator dispatching subagents should inherit.
 *
 * Lives outside index.ts so the rule that picks every subagent's model can be tested directly.
 */

export interface RunnerSource {
  id: string;
  name: string;
  models: { id: string }[];
}

export interface InteractiveTurn {
  providerId: string;
  model: string;
}

let lastInteractiveTurn: InteractiveTurn | null = null;

/**
 * Record a turn the person started.
 *
 * Renderer-owned turns only. An agent run must not redefine the default it was itself dispatched
 * under, or the orchestrator would drift onto whichever model a subagent happened to use.
 */
export function rememberInteractiveTurn(turn: { providerId?: string | null; model?: string | null }): void {
  if (turn.providerId && turn.model) lastInteractiveTurn = { providerId: turn.providerId, model: turn.model };
}

export const interactiveTurn = (): InteractiveTurn | null => lastInteractiveTurn;

/** Test seam. Production never clears this; a test must not inherit another test's chat. */
export const resetInteractiveTurn = (): void => {
  lastInteractiveTurn = null;
};

/** Shared by the orchestrator page and by dispatch, so the page cannot report one source while the run uses another. */
export function resolveRunnerSource<T extends RunnerSource>(sources: readonly T[], pinned?: string | null): T | undefined {
  // A pin is a hard constraint: if it names nothing, that is an error to report, not something
  // to paper over by quietly running on a different model than the workflow asked for.
  if (pinned) return sources.find((entry) => entry.id === pinned || entry.name === pinned);
  const following = lastInteractiveTurn
    ? sources.find((entry) => entry.id === lastInteractiveTurn!.providerId)
    : undefined;
  return following ?? sources[0];
}

export function resolveRunnerModel(source: RunnerSource, pinned?: string | null): string | undefined {
  if (pinned) return pinned;
  // Only inherit the chat's model when it belongs to that same source.
  if (lastInteractiveTurn && source.id === lastInteractiveTurn.providerId) return lastInteractiveTurn.model;
  return source.models[0]?.id;
}
