import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  migratePrivateDirectory,
  migratePrivateFile,
  writePrivateFileAtomic,
} from './privateState';
import type { ToolActivity } from './toolLoop';

/**
 * Carbons — a copy of what actually happened, kept on disk.
 *
 * The name is the old one: a carbon copy, made as you write rather than reconstructed
 * afterwards. Antimatter's version records the turn as the main process saw it, which is
 * deliberately not the same as what the transcript shows. The UI can only report what the model
 * said it did; a carbon records what was sent, which directory it was sent about, and what each
 * tool was actually called with.
 *
 * That distinction has already earned its place. A turn reported writing files and none appeared
 * where they were expected — because the tool servers were pointed at a directory nobody had
 * nominated, which the chat window never showed. A carbon would have had the answer in its
 * header.
 */

export interface CarbonMeta {
  threadId: string;
  model: string;
  sourceName: string;
  /** The non-secret endpoint a turn was dispatched to. This distinguishes local CPU and GPU sources. */
  sourceUrl?: string;
  /** The directory the tool servers were pointed at. The single most useful line in the file. */
  workspace: string;
  accessMode: string;
  contextTokens?: number;
  compacted?: number;
}

export interface CarbonEntry {
  kind: 'system' | 'user' | 'assistant' | 'tool' | 'note';
  /** Tool name, or the role label to print. */
  label?: string;
  body: string;
  /** When this event reached the main process. Added automatically for new entries. */
  at?: string;
  /** The inference run that produced the event, when there was one. */
  runId?: string;
  /** The model used for this event, so mixed-model conversations remain auditable. */
  model?: string;
}

/** The durable form of a settled tool event, shared with the live transcript event semantics. */
export function toolActivityEntry(
  activity: Pick<ToolActivity, 'toolName' | 'status' | 'args' | 'result'>
): CarbonEntry {
  return {
    kind: 'tool',
    label: `${activity.toolName} — ${activity.status}`,
    body: `arguments:\n${activity.args}\n\nresult:\n${activity.result ?? '(nothing)'}`,
  };
}

interface Carbon {
  /** The conversation's own id; also the carbon's, so one names the other. */
  id: string;
  path: string;
  startedAt: string;
  meta: CarbonMeta;
  entries: CarbonEntry[];
  /** An older build's complete Markdown, retained verbatim when first adopting its carbon. */
  legacyMarkdown?: string;
}

let root = join(homedir(), '.antimatter', 'carbons');
const open = new Map<string, Carbon>();
const STATE_VERSION = 1;

interface SerializedCarbon {
  version: typeof STATE_VERSION;
  id: string;
  markdownName: string;
  startedAt: string;
  meta: CarbonMeta;
  entries: CarbonEntry[];
  legacyMarkdown?: string;
}

export const useRoot = (path: string): void => {
  root = path;
  open.clear();
};

/** Tighten carbons written by older builds once, when the application selects its state root. */
export const migratePermissions = (): void => {
  if (!migratePrivateDirectory(root)) return;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
        migratePrivateFile(join(root, entry.name));
      }
    }
  } catch (error) {
    console.warn(`[carbon] could not inspect existing carbons in ${root}:`, error);
  }
};

export const location = (): string => root;

/**
 * Keep enough of a source URL to identify the server without persisting credentials or query
 * tokens a compatible endpoint may have been configured with.
 */
export function publicEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');
const shortName = (threadId: string): string => {
  const readable = threadId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 8);
  const identity = createHash('sha256').update(threadId).digest('hex').slice(0, 12);
  return `${readable || 'thread'}-${identity}`;
};
/** Stable per-thread identity prevents equal-clock, equal-prefix conversations sharing a file. */
export const markdownName = (threadId: string, date: Date): string =>
  `carbon-${stamp(date)}_${shortName(threadId)}.md`;
const statePath = (threadId: string): string =>
  join(root, `.carbon-${createHash('sha256').update(threadId).digest('hex')}.json`);

function insideRoot(path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return !!fromRoot && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

const isEntry = (entry: unknown): entry is CarbonEntry => {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<CarbonEntry>;
  return (
    (candidate.kind === 'system' ||
      candidate.kind === 'user' ||
      candidate.kind === 'assistant' ||
      candidate.kind === 'tool' ||
      candidate.kind === 'note') &&
    typeof candidate.body === 'string'
  );
};

function restore(threadId: string): Carbon | null {
  const cached = open.get(threadId);
  if (cached) return cached;
  const path = statePath(threadId);
  if (!existsSync(path)) return null;

  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    migratePrivateFile(path);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<SerializedCarbon>;
    if (
      stored.version !== STATE_VERSION ||
      stored.id !== threadId ||
      typeof stored.markdownName !== 'string' ||
      basename(stored.markdownName) !== stored.markdownName ||
      !stored.markdownName.endsWith('.md') ||
      typeof stored.startedAt !== 'string' ||
      !stored.meta ||
      stored.meta.threadId !== threadId ||
      typeof stored.meta.model !== 'string' ||
      typeof stored.meta.sourceName !== 'string' ||
      typeof stored.meta.workspace !== 'string' ||
      typeof stored.meta.accessMode !== 'string' ||
      !Array.isArray(stored.entries) ||
      !stored.entries.every(isEntry) ||
      (stored.legacyMarkdown !== undefined && typeof stored.legacyMarkdown !== 'string')
    ) {
      return null;
    }
    const markdownPath = join(root, stored.markdownName);
    if (!insideRoot(markdownPath)) return null;
    const carbon: Carbon = {
      id: threadId,
      path: markdownPath,
      startedAt: stored.startedAt,
      meta: stored.meta,
      entries: stored.entries,
      legacyMarkdown: stored.legacyMarkdown,
    };
    open.set(threadId, carbon);
    return carbon;
  } catch (error) {
    console.warn(`[carbon] could not restore ${threadId}:`, error);
    return null;
  }
}

/**
 * Builds before durable sidecars still wrote one readable Markdown file per process lifetime.
 * Adopt the newest exact thread match verbatim so the first run after an upgrade continues that
 * record rather than creating one final fragment. New structured entries follow it below.
 */
function adoptLegacy(threadId: string, meta: CarbonMeta): Carbon | null {
  if (!existsSync(root)) return null;
  try {
    const candidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => ({ name: entry.name, modified: statSync(join(root, entry.name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    for (const candidate of candidates) {
      const path = join(root, candidate.name);
      const markdown = readFileSync(path, 'utf8');
      if (markdown.split(/\r?\n/, 1)[0] !== `# Carbon — ${threadId}`) continue;
      migratePrivateFile(path);
      const carbon: Carbon = {
        id: threadId,
        path,
        startedAt: /- \*\*started:\*\* (.+)/.exec(markdown.slice(0, 1_000))?.[1]?.trim() ?? new Date().toISOString(),
        meta,
        entries: [],
        legacyMarkdown: markdown.trimEnd(),
      };
      open.set(threadId, carbon);
      return carbon;
    }
  } catch (error) {
    console.warn(`[carbon] could not inspect legacy carbons for ${threadId}:`, error);
  }
  return null;
}

/** Long tool results are the bulk of a carbon; keep enough to be evidence, not the whole file. */
const clip = (text: string, max = 8_000): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} more characters]`;

const fence = (body: string): string => {
  // A body containing ``` needs a longer fence, or the file stops making sense at that point.
  const longest = Math.max(2, ...[...body.matchAll(/`{3,}/g)].map((match) => match[0].length));
  const rail = '`'.repeat(longest + 1);
  return `${rail}\n${body}\n${rail}`;
};

function render(carbon: Carbon): string {
  const { meta } = carbon;
  const lines = carbon.legacyMarkdown
    ? [carbon.legacyMarkdown, '', '---', '', `# Continued — ${carbon.id}`]
    : [`# Carbon — ${carbon.id}`];
  lines.push(
    '',
    `- **started:** ${carbon.startedAt}`,
    `- **updated:** ${new Date().toISOString()}`,
    `- **model:** ${meta.model} (${meta.sourceName})`,
    ...(meta.sourceUrl ? [`- **source:** ${meta.sourceUrl}`] : []),
    `- **working dir:** ${meta.workspace}`,
    `- **permissions:** ${meta.accessMode}`,
    `- **messages${carbon.legacyMarkdown ? ' in this continuation' : ''}:** ${carbon.entries.length}`,
  );
  if (meta.contextTokens) lines.push(`- **context window:** ${meta.contextTokens.toLocaleString()} tokens`);
  if (meta.compacted) lines.push(`- **compacted:** ${meta.compacted} earlier messages folded away`);
  lines.push('', '---', '');

  carbon.entries.forEach((entry, index) => {
    lines.push(`## [${index}] ${entry.label ?? entry.kind}`, '');
    const provenance = [
      entry.at,
      entry.runId ? `run \`${entry.runId}\`` : null,
      entry.model ? `model \`${entry.model}\`` : null,
    ].filter(Boolean);
    if (provenance.length) lines.push(provenance.join(' · '), '');
    // Prose reads better unfenced; anything machine-shaped keeps its fence.
    lines.push(entry.kind === 'user' || entry.kind === 'assistant' ? entry.body : fence(entry.body), '');
  });

  return `${lines.join('\n')}\n`;
}

function flush(carbon: Carbon): void {
  try {
    const durable: SerializedCarbon = {
      version: STATE_VERSION,
      id: carbon.id,
      markdownName: basename(carbon.path),
      startedAt: carbon.startedAt,
      meta: carbon.meta,
      entries: carbon.entries,
      legacyMarkdown: carbon.legacyMarkdown,
    };
    writePrivateFileAtomic(statePath(carbon.id), `${JSON.stringify(durable, null, 2)}\n`);
    writePrivateFileAtomic(carbon.path, render(carbon));
  } catch (error) {
    // A carbon is a record, never a dependency: failing to write one must not fail the turn.
    console.error('[carbon] could not write:', error);
  }
}

/**
 * Opens the conversation's carbon, or returns the one it already has.
 *
 * One file per conversation rather than per turn. A turn is not a unit anyone wants to read: the
 * question is always "what happened in this chat", and the answer should not be spread across
 * nine files that have to be reassembled in timestamp order.
 */
export function ensure(meta: CarbonMeta): { id: string; path: string } {
  const existing = restore(meta.threadId) ?? adoptLegacy(meta.threadId, meta);
  if (existing) {
    // Later turns may use a different model or directory; the header tracks the latest.
    existing.meta = { ...existing.meta, ...meta };
    flush(existing);
    return { id: existing.id, path: existing.path };
  }

  const now = new Date();
  const carbon: Carbon = {
    id: meta.threadId,
    path: join(root, markdownName(meta.threadId, now)),
    startedAt: now.toISOString(),
    meta,
    entries: [],
  };
  open.set(meta.threadId, carbon);
  flush(carbon);
  return { id: carbon.id, path: carbon.path };
}

export function add(threadId: string, entry: CarbonEntry): void {
  const carbon = restore(threadId);
  if (!carbon) return;
  carbon.entries.push({ ...entry, at: entry.at ?? new Date().toISOString(), body: clip(entry.body) });
  flush(carbon);
}

export function update(threadId: string, patch: Partial<CarbonMeta>): void {
  const carbon = restore(threadId);
  if (!carbon) return;
  carbon.meta = { ...carbon.meta, ...patch };
  flush(carbon);
}

/** Marks the end of one turn. The carbon stays open: the conversation is not over. */
export function note(threadId: string, text: string): void {
  add(threadId, { kind: 'note', label: 'note', body: text });
}

export const pathFor = (threadId: string): string | null => restore(threadId)?.path ?? null;

/** The whole conversation as Markdown, ready to be written wherever the user wants it. */
export function contents(threadId: string): string | null {
  const carbon = restore(threadId);
  return carbon ? render(carbon) : null;
}

export interface CarbonSummary {
  path: string;
  name: string;
  bytes: number;
  modified: number;
  /** First line of the header, so a list is readable without opening anything. */
  title: string;
}

export function list(limit = 50): CarbonSummary[] {
  if (!existsSync(root)) return [];
  migratePrivateDirectory(root);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const name = entry.name;
      const path = join(root, name);
      migratePrivateFile(path);
      const stats = statSync(path);
      let title = name;
      try {
        // The working dir line is what anyone scanning this list is actually looking for.
        const head = readFileSync(path, 'utf8').slice(0, 600);
        title = /- \*\*working dir:\*\* (.+)/.exec(head)?.[1]?.trim() ?? name;
      } catch {
        // Unreadable: the file name still identifies it.
      }
      return { path, name, bytes: stats.size, modified: stats.mtimeMs, title };
    })
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit);
}

export const read = (path: string): string => {
  // Only ever our own directory: a carbon viewer is not a file browser.
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const fromRoot = relative(resolvedRoot, resolvedPath);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('That file is not a carbon.');
  }
  if (!resolvedPath.endsWith('.md')) throw new Error('That file is not a carbon.');
  const stats = lstatSync(resolvedPath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('That file is not a carbon.');
  migratePrivateFile(resolvedPath);
  return readFileSync(resolvedPath, 'utf8');
};
