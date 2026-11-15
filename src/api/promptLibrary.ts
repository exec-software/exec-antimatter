import type { ReinterpretRequest, ReinterpretResult } from './promptReinterpret';

/**
 * The Prompt Studio library: prompts the person wrote and kept, separate from any one chat.
 *
 * A chat draft is already durable, but it dies with the conversation it belongs to. A prompt you
 * worked on — the brief you re-run against four models, the review instruction you refine over a
 * month — outlives every chat it was ever sent to, so it is kept per install, in the main process
 * for the same reason the model choice is: it has to be readable before any window exists.
 */

export const PROMPT_LIBRARY_IPC = {
  get: 'prompt-library:get',
  save: 'prompt-library:save',
  remove: 'prompt-library:remove',
  /** One model-backed rewrite into an agent-ready prompt; it never writes to the library. */
  reinterpret: 'prompt-library:reinterpret',
} as const;

/** One prompt. Generous for a brief with pasted context, far below an attachment's own limit. */
export const MAX_PROMPT_BODY_BYTES = 64 * 1024;
export const MAX_PROMPT_TITLE_LENGTH = 120;
/** A ceiling rather than a quota: the whole library crosses IPC on every change. */
export const MAX_PROMPT_ENTRIES = 200;
/** Per prompt, so a saved set of variable values cannot grow without bound. */
export const MAX_PROMPT_VARIABLES = 64;
export const MAX_PROMPT_VARIABLE_VALUE_LENGTH = 2000;

/** A saved prompt, with the variable values it was last filled in with. */
export interface PromptEntry {
  id: string;
  title: string;
  body: string;
  /** `{{name}}` values last used, so reopening a template does not start from blank fields. */
  variables: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface PromptLibrary {
  /** Bumped on every accepted change, so a stale window can tell it is behind. */
  revision: number;
  entries: PromptEntry[];
}

/** What the renderer sends. An absent id is a new prompt; a known id replaces that one. */
export interface PromptEntryInput {
  id?: string;
  title: string;
  body: string;
  variables?: Record<string, string>;
}

export interface PromptLibraryAPI {
  get(): Promise<PromptLibrary>;
  save(entry: PromptEntryInput): Promise<PromptLibrary>;
  remove(id: string): Promise<PromptLibrary>;
  /**
   * Asks the active model to rewrite a prompt for an agentic coding run. The result is returned
   * to the editor and saved nowhere; the person decides whether to keep it.
   */
  reinterpret(request: ReinterpretRequest): Promise<ReinterpretResult>;
}

export const EMPTY_PROMPT_LIBRARY: PromptLibrary = { revision: 0, entries: [] };

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** TextEncoder rather than Buffer: this module is read by the renderer as well as the main process. */
const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/** Ids are generated here, never accepted from a file: a path is never derived from one. */
export const isPromptId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

const cleanTitle = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_TITLE_LENGTH) : '';

/**
 * A title is a label, not content: a prompt saved with no label is named from its first line.
 *
 * Markdown furniture is stripped on the way, because a prompt that opens with `## Task` would
 * otherwise be filed under "## Task", as would every other prompt written the same way.
 */
export function promptTitleFrom(title: string, body: string): string {
  const label = cleanTitle(title);
  if (label) return label;
  const firstLine = body.split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+/, '').trim())
    .find(Boolean) ?? '';
  return cleanTitle(firstLine) || 'Untitled prompt';
}

function cleanBody(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A prompt must be text.');
  const body = value.replace(/\r\n?/g, '\n');
  if (CONTROL_CHARACTERS.test(body)) throw new Error('A prompt must be plain text.');
  if (utf8Length(body) > MAX_PROMPT_BODY_BYTES) {
    throw new Error(`A prompt must be smaller than ${Math.round(MAX_PROMPT_BODY_BYTES / 1024)} KiB.`);
  }
  return body;
}

function cleanVariables(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Prompt variables must be named values.');
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([name, filled]) => isPromptVariableName(name) && typeof filled === 'string' && filled !== '')
    .slice(0, MAX_PROMPT_VARIABLES)
    .map(([name, filled]) => [name, (filled as string).replace(/\r\n?/g, '\n').slice(0, MAX_PROMPT_VARIABLE_VALUE_LENGTH)] as const);
  return Object.fromEntries(entries);
}

/** The same shape the editor recognises in `{{…}}`, so a value can never be saved unreachable. */
export const isPromptVariableName = (value: string): boolean => /^[A-Za-z][\w .-]{0,60}$/.test(value);

/** Drops what cannot be read rather than refusing the file: one bad prompt is not the library. */
export function normalizePromptLibrary(value: unknown): PromptLibrary {
  const source = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const revision = Number.isSafeInteger(source.revision) && Number(source.revision) >= 0 ? Number(source.revision) : 0;
  const list = Array.isArray(source.entries) ? source.entries : [];
  const seen = new Set<string>();
  const entries: PromptEntry[] = [];
  for (const candidate of list) {
    if (entries.length >= MAX_PROMPT_ENTRIES) break;
    const record = (candidate && typeof candidate === 'object' ? candidate : {}) as Record<string, unknown>;
    if (!isPromptId(record.id) || seen.has(record.id)) continue;
    let body: string;
    let variables: Record<string, string>;
    try {
      body = cleanBody(record.body);
      variables = cleanVariables(record.variables);
    } catch {
      continue;
    }
    const createdAt = Number.isFinite(record.createdAt) && Number(record.createdAt) >= 0 ? Number(record.createdAt) : 0;
    const updatedAt = Number.isFinite(record.updatedAt) && Number(record.updatedAt) >= 0 ? Number(record.updatedAt) : createdAt;
    seen.add(record.id);
    entries.push({ id: record.id, title: promptTitleFrom(String(record.title ?? ''), body), body, variables, createdAt, updatedAt });
  }
  return { revision, entries: sortPromptEntries(entries) };
}

/** Most recently touched first: the library is a work surface, not an archive. */
export const sortPromptEntries = (entries: PromptEntry[]): PromptEntry[] =>
  [...entries].sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title));

interface UpsertOptions {
  now: () => number;
  newId: () => string;
}

/** Pure: the store writes whatever this returns, and the renderer renders it unchanged. */
export function upsertPromptEntry(library: PromptLibrary, input: unknown, { now, newId }: UpsertOptions): PromptLibrary {
  if (!input || typeof input !== 'object') throw new Error('Invalid prompt.');
  const source = input as PromptEntryInput;
  const body = cleanBody(source.body);
  if (!body.trim()) throw new Error('A prompt needs some text before it can be saved.');
  const variables = cleanVariables(source.variables);
  const title = promptTitleFrom(String(source.title ?? ''), body);
  const existing = source.id === undefined ? undefined : library.entries.find((entry) => entry.id === source.id);
  if (source.id !== undefined && !existing) throw new Error('That prompt is no longer in the library.');
  const at = now();
  if (existing) {
    const next = { ...existing, title, body, variables, updatedAt: at };
    const unchanged = existing.title === title && existing.body === body
      && JSON.stringify(existing.variables) === JSON.stringify(variables);
    if (unchanged) return library;
    return { revision: library.revision + 1, entries: sortPromptEntries(library.entries.map((entry) => entry.id === existing.id ? next : entry)) };
  }
  if (library.entries.length >= MAX_PROMPT_ENTRIES) {
    throw new Error(`The prompt library holds ${MAX_PROMPT_ENTRIES} prompts. Delete one to save another.`);
  }
  const id = newId();
  if (!isPromptId(id)) throw new Error('Could not name the new prompt.');
  return { revision: library.revision + 1, entries: sortPromptEntries([...library.entries, { id, title, body, variables, createdAt: at, updatedAt: at }]) };
}

export function removePromptEntry(library: PromptLibrary, id: unknown): PromptLibrary {
  if (!isPromptId(id)) throw new Error('Invalid prompt.');
  if (!library.entries.some((entry) => entry.id === id)) return library;
  return { revision: library.revision + 1, entries: library.entries.filter((entry) => entry.id !== id) };
}
