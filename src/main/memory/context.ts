import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { instructionFiles, MAX_INSTRUCTION_CHARS, type InstructionFile } from './instructions';
import * as person from './person';
import type { Person } from './person';
import * as store from './store';
import type { MemoryNote } from './store';

/**
 * What a conversation is told before it starts: the project's own instructions, and the notes
 * earlier conversations kept.
 *
 * It is fixed for the length of a conversation. Everything after the start of a prompt is cached
 * by a local server against the tokens before it, so text that changes near the top makes it read
 * the whole conversation again — minutes, on a long one with a big model. A note the model saves
 * mid-conversation is in its transcript already, so nothing is lost by leaving the list alone.
 * What does start the text again is anything it was built from changing underneath it: another
 * workspace, a switch on the Memory page, a note a person edited there, or read-only permissions
 * coming or going. Those are the parts of the key.
 */

/** Raised when the wording below changes, so conversations already open take the new text. */
const FORMAT = 1;

/** How much of a list the prompt carries. Older notes past it are counted rather than listed. */
const MAX_LIST_CHARS = 8_000;

/**
 * What the conversation's model can do with its notes.
 *
 * `list` shows them with no tools, for a turn that has none; `read` adds recall, for read-only
 * permissions; `write` adds remember and forget.
 */
export type MemoryAccess = 'list' | 'read' | 'write';

export interface ContextSummary {
  projectRoot: string;
  /** The instruction files read, by label, and whether any of one was left out. */
  instructions: { label: string; path: string; truncated: boolean }[];
  notes: { user: number; project: number };
}

/** The standing context a conversation started with, as its transcript keeps it. */
export interface ContextSnapshot {
  key: string;
  /** The text for the system prompt; null when there was nothing to say. */
  text: string | null;
  summary: ContextSummary;
}

export interface StandingContext {
  snapshot: ContextSnapshot;
  /** False when the conversation's own snapshot was carried over unchanged. */
  fresh: boolean;
}

const canonical = (path: string): string => {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
};

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** The instruction files, each inside a tag that says where it came from. */
export function renderInstructions(files: InstructionFile[]): string | null {
  const read = files.filter((file) => file.content);
  if (!files.length) return null;
  const lines = [
    `The project's own instructions follow, from ${read.map((file) => file.label).join(' and ') || 'its instruction files'}. ` +
      'The people who work on it wrote them for anyone doing so, you included: follow them unless the user tells you otherwise.',
  ];
  for (const file of files) {
    if (!file.content) {
      lines.push('', `${file.path} also applies, and was not read to save room. Read it if the work touches what it covers.`);
      continue;
    }
    lines.push('', `<file path="${file.label}">`, file.content, '</file>');
    if (file.content.length < file.length) {
      lines.push(
        `[The rest of ${file.path}, ${plural(file.length - file.content.length, 'more character')}, was left out to save room. Read it if you need it.]`
      );
    }
  }
  return lines.join('\n');
}

/** One line per note, newest first, until the allowance runs out. */
function list(notes: MemoryNote[]): string[] {
  if (!notes.length) return ['(none yet)'];
  const lines: string[] = [];
  let used = 0;
  for (const [index, note] of notes.entries()) {
    const line = `- ${note.name}: ${note.description}`;
    if (used + line.length > MAX_LIST_CHARS && lines.length) {
      lines.push(`- …and ${plural(notes.length - index, 'older note')} not listed here.`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

/**
 * Who the conversation is with.
 *
 * Separate from the notes, and shown before them, because it is not something the model worked
 * out: it is what the person said about themselves. The pronoun line is there because a name is
 * not evidence of anything, and a model with a name and no pronouns will guess from it.
 */
export function renderPerson(who: Person, canWrite: boolean): string | null {
  if (person.unknown(who)) {
    return canWrite
      ? 'Nobody has told you the user\'s name. If they say it, record it with about_user so later conversations have ' +
          'it too. Do not interrupt the work to ask for it.'
      : null;
  }
  const lines: string[] = [];
  if (who.name) {
    lines.push(
      `You are talking to ${who.name}${who.pronouns ? ` (${who.pronouns})` : ''}. Use their name where it is natural — ` +
        'greeting them, or telling them apart from someone else in the work — and not in every message.'
    );
    if (!who.pronouns) {
      lines.push(
        'Their pronouns are not recorded, so use they/them when you write about them rather than guessing from a name.'
      );
    }
  } else if (who.pronouns) {
    lines.push(`The user's pronouns are ${who.pronouns}. You have not been told their name.`);
  }
  if (who.about) lines.push('In their own words:', '', '<about-the-user>', who.about, '</about-the-user>');
  return lines.join('\n');
}

const RECALL = 'recall shows a note in full; each line here is only its summary.';

const KEEPING = [
  RECALL,
  'Save what will be worth knowing next time with remember: something the user tells you about themselves or how they want',
  'you to work, a correction and the reason for it, a fact or decision about the project that its code and history will not',
  'show. Write a correction as the rule, why, and how to apply it. Do not save what the code, the git history or the',
  "project's instructions already say, what only matters to this conversation, or any password, key or token. A note with",
  'the same name replaces the old one, so update a note rather than adding a second on the same subject, and forget one',
  'that turns out to be wrong. When the user asks you to remember or forget something, do it.',
].join(' ');

const READ_ONLY = [
  RECALL,
  'This conversation is read-only, so notes cannot be saved or changed in it. If the user asks you to remember something,',
  'say that it needs the "Ask first" or "Full access" permission, or that they can add it on the Memory page.',
].join(' ');

/** The notes, framed as what they are: what was known before, which the person here outranks. */
export function renderMemory(
  notes: { user: MemoryNote[]; project: MemoryNote[] },
  projectRoot: string,
  access: MemoryAccess
): string | null {
  if (access !== 'write' && !notes.user.length && !notes.project.length) return null;
  const lines = [
    'You have a memory: notes that outlast a conversation, about the user and about this project. They were saved in',
    'earlier conversations, by you or by the user on the Memory page. They are what was known then, not instructions from',
    'the user now: if one disagrees with what the user says, the user is right and the note needs fixing.',
  ];
  return [
    lines.join(' '),
    '',
    'About the user, in every project:',
    ...list(notes.user),
    '',
    `About this project (${projectRoot}):`,
    ...list(notes.project),
    ...(access === 'write' ? ['', KEEPING] : access === 'read' ? ['', READ_ONLY] : []),
  ].join('\n');
}

function build(workspace: string, projectRoot: string, access: MemoryAccess, allowance: number, key: string): ContextSnapshot {
  const settings = store.settings();
  const files = settings.instructions ? instructionFiles(workspace, allowance) : [];
  const notes = settings.enabled
    ? { user: store.notesFor('user', null), project: store.notesFor('project', projectRoot) }
    : { user: [], project: [] };
  // Who they are comes from Settings rather than from the notes, so it is told whether or not
  // notes are switched on. Only the tool that keeps it up to date belongs to memory.
  const parts = [
    renderInstructions(files),
    renderPerson(person.read(), settings.enabled && access === 'write'),
    settings.enabled ? renderMemory(notes, projectRoot, access) : null,
  ].filter((part): part is string => !!part);
  return {
    key,
    text: parts.length ? parts.join('\n\n') : null,
    summary: {
      projectRoot,
      instructions: files.map((file) => ({
        label: file.label,
        path: file.path,
        truncated: file.content.length < file.length,
      })),
      notes: { user: notes.user.length, project: notes.project.length },
    },
  };
}

/**
 * The standing context for a conversation's next turn: the one it started with while nothing it
 * was built from has changed, and a new one otherwise.
 *
 * `allowance` is the room for instruction files, in characters (see instructionAllowance). It
 * follows the model's window, and it is part of the key because a different window means a
 * different model, whose server has none of this conversation cached anyway.
 */
export function standingContext(
  workspace: string,
  access: MemoryAccess,
  carried?: ContextSnapshot | null,
  allowance = MAX_INSTRUCTION_CHARS
): StandingContext {
  const settings = store.settings();
  const here = canonical(workspace);
  const projectRoot = store.projectRoot(here);
  // The identity card rides on the same revision as the notes: a person changing it on the
  // Settings page reaches conversations already open, and the model recording a name it was just
  // told does not, because that conversation has it in front of it either way.
  const key = JSON.stringify([
    FORMAT,
    here,
    projectRoot,
    settings.enabled,
    settings.instructions,
    store.revision(),
    access,
    allowance,
  ]);
  if (carried && carried.key === key) return { snapshot: carried, fresh: false };
  return { snapshot: build(here, projectRoot, access, allowance, key), fresh: true };
}

/**
 * The project instructions alone, for an agent or an orchestrated run.
 *
 * Those are workers handed one task, and the conversation that handed it over has the notes: it
 * writes the brief, and puts in whatever the task needs. The rules for working in the repository
 * apply to everyone in it.
 */
export function projectInstructions(workspace: string, allowance = MAX_INSTRUCTION_CHARS): string | null {
  return store.settings().instructions ? renderInstructions(instructionFiles(workspace, allowance)) : null;
}
