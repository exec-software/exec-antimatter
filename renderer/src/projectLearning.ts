import { showToast } from './toasts';

/**
 * The offer to learn a project.
 *
 * A local model with no notes and no AGENTS.md starts every conversation about a codebase by
 * rediscovering it, and on this hardware rediscovery is expensive: a 34k-token prefix at 7 tok/s
 * is over an hour of prefill. Notes are the cheap half of the fix and the prompt cache is the
 * other, so the offer is worth making once per project and never worth making twice.
 *
 * What it deliberately does **not** do is run anything. The action fills the composer and
 * focuses it; the person presses Enter. Firing a long inference run off the back of a dismissible
 * notice would be the kind of surprise that teaches people to dismiss notices unread — and on a
 * dense 123B it would occupy the only slot for several minutes.
 */

export const LEARN_PROJECT_ACTION = 'learn.project';
export const DECLINE_PROJECT_ACTION = 'learn.project.decline';
export const LEARN_PROJECT_KEY = 'learn.project';

const DECLINED_KEY = 'antimatter.learnProject.declined';
/** A person with more projects than this does not need the oldest decision remembered. */
const MAX_DECLINED = 200;

/** Offered at most once per window, so a memory:changed burst cannot re-raise it repeatedly. */
const offered = new Set<string>();

export interface LearnableProject {
  /** The project root the workspace belongs to. Empty when there is no project. */
  current: string;
  notes: number;
  instructions: number;
  memoryEnabled: boolean;
}

export function declinedProjects(): string[] {
  try {
    const raw = localStorage.getItem(DECLINED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    // A corrupt or unavailable store means the offer may be made again, which is the harmless
    // direction to fail in.
    return [];
  }
}

export function declineProject(root: string): void {
  if (!root) return;
  try {
    const next = [...declinedProjects().filter((entry) => entry !== root), root].slice(-MAX_DECLINED);
    localStorage.setItem(DECLINED_KEY, JSON.stringify(next));
  } catch { /* The in-session guard still suppresses it until the window closes. */ }
}

/**
 * Whether this project has never been looked at. Both halves matter: a project with an AGENTS.md
 * has been described by hand and does not need to be asked about, and one with notes has already
 * been through this.
 */
export function needsLearning(project: LearnableProject): boolean {
  if (!project.memoryEnabled) return false;
  if (!project.current) return false;
  return project.notes === 0 && project.instructions === 0;
}

/**
 * The prompt the action puts in the composer.
 *
 * Written as an instruction to explore and record rather than to summarise, because a summary in
 * the transcript is lost at the end of the conversation and a note is not. It names the tool, so
 * a smaller local model does not have to infer that recording is possible.
 */
export function learnProjectPrompt(root: string): string {
  return [
    `Learn this project so you don't have to rediscover it every conversation.`,
    ``,
    `Explore ${root} — start with the README, the build/package manifest, and the top-level`,
    `directory layout, then follow whatever those point at. Read enough to be useful, not`,
    `everything.`,
    ``,
    `Then use the \`remember\` tool to record project notes covering:`,
    ``,
    `- what this project is, in a sentence or two`,
    `- how it is built, run and tested, with the actual commands`,
    `- the layout: which directory holds what, and where to start reading`,
    `- conventions a newcomer would otherwise get wrong`,
    `- anything load-bearing that is surprising`,
    ``,
    `One fact per note, each with a short description. Prefer things that will still be true`,
    `next month over anything you had to guess at — if you are unsure, say so in the note`,
    `rather than recording it as fact.`,
  ].join('\n');
}

/**
 * Raise the offer if it is warranted and has not been answered. Returns whether it was shown,
 * which is what the tests assert on.
 */
export function offerProjectLearning(project: LearnableProject): boolean {
  if (!needsLearning(project)) return false;
  if (offered.has(project.current)) return false;
  if (declinedProjects().includes(project.current)) return false;
  offered.add(project.current);
  const name = project.current.split('/').filter(Boolean).pop() ?? project.current;
  showToast({
    tone: 'info',
    key: LEARN_PROJECT_KEY,
    // Sticky: this is an offer, not a status, and one that scrolls away unread was not made.
    timeoutMs: null,
    title: `Antimatter doesn't know ${name} yet`,
    body: 'It works better on a project it has notes for, and learning it once also warms the prompt cache for later turns.',
    actions: [
      { id: LEARN_PROJECT_ACTION, label: 'Learn this project', primary: true },
      { id: DECLINE_PROJECT_ACTION, label: 'Not for this project' },
    ],
  });
  return true;
}

/** Tests, and a window tearing down. */
export function resetProjectLearning(): void {
  offered.clear();
}
