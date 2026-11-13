import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { LibraryEntry, LibraryLanguage, LibraryMutation, PensieveLibraryState } from '../api/pensieveLibrary';
import { PENSIEVE_CATALOG } from './pensieveCatalog';
import { writePrivateFileAtomic } from './privateState';

interface SavedEntry extends LibraryEntry { projectId: string | null }
interface Saved {
  version: 1; revision: number; enabled: boolean; entries: SavedEntry[]; disabled: string[];
}
const empty = (): Saved => ({ version: 1, revision: 0, enabled: false, entries: [], disabled: [] });
const MAX_BYTES = 8 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid library data.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return value;
};
const language = (value: unknown): LibraryLanguage => {
  if (!['shared', 'rust', 'cpp', 'matrix', 'ny', 'nil'].includes(value as string)) throw new Error('Choose a supported language.');
  return value as LibraryLanguage;
};
function projectScope(workspace?: string | null): { id: string; title: string } | null {
  if (workspace == null || workspace === '') return null;
  const canonical = realpathSync(text(workspace, 4096, 'project folder'));
  if (!statSync(canonical).isDirectory()) throw new Error('Choose a project folder.');
  return { id: createHash('sha256').update(canonical).digest('hex'), title: basename(canonical) };
}
function normalizeEntry(raw: unknown): SavedEntry {
  const value = object(raw);
  if (!['note', 'schema', 'reference'].includes(value.kind as string) || value.origin !== 'custom'
      || !['global', 'project'].includes(value.scope as string) || typeof value.enabled !== 'boolean'
      || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0
      || (value.scope === 'global' ? value.projectId !== null : !/^[a-f0-9]{64}$/.test(String(value.projectId)))) throw new Error('Invalid library entry.');
  const id = text(value.id, 160, 'entry identifier');
  if (!/^custom:[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid custom entry identifier.');
  return { id, title: text(value.title, 240, 'entry title'), content: text(value.content, 128 * 1024, 'entry content'),
    kind: value.kind as SavedEntry['kind'], origin: 'custom', language: language(value.language),
    scope: value.scope as SavedEntry['scope'], projectId: value.projectId as string | null,
    enabled: value.enabled, updatedAt: Number(value.updatedAt) };
}
function readSaved(file: string): Saved {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Library file is invalid or too large.');
    const buffer = Buffer.alloc(stat.size + 1); const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size !== stat.size) throw new Error('Library file changed while reading.');
    const value = object(JSON.parse(buffer.subarray(0, size).toString('utf8')));
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.enabled !== 'boolean'
        || !Array.isArray(value.entries) || value.entries.length > 1000 || !Array.isArray(value.disabled) || value.disabled.length > 100_000) throw new Error('Unsupported library data.');
    const entries = value.entries.map(normalizeEntry);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error('Duplicate library entries.');
    const disabled = value.disabled.map((id) => text(id, 1024, 'disabled entry identifier'));
    return { version: 1, revision: Number(value.revision), enabled: value.enabled, entries, disabled };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export class PensieveLibrary {
  constructor(private readonly options: { file: string; curriculumPath?: string; write?: typeof writePrivateFileAtomic }) {}
  private catalog(): { entries: LibraryEntry[]; notice: string | null } {
    const entries = PENSIEVE_CATALOG.map((entry) => ({ ...entry }));
    if (!this.options.curriculumPath) return { entries, notice: null };
    try {
      // This path belongs to host configuration. It is never supplied by an agent or renderer.
      if (statSync(this.options.curriculumPath).size > 64 * 1024 * 1024) throw new Error('Curriculum exceeds 64 MiB.');
      const bundle = object(JSON.parse(readFileSync(this.options.curriculumPath, 'utf8')));
      if (bundle.schema_version !== 1 || !Array.isArray(bundle.entries)) throw new Error('Unsupported curriculum.');
      const ids = new Set<string>();
      const imported = bundle.entries.map((raw) => {
        const item = object(raw); const id = `curriculum:${text(item.id, 900, 'reference identifier')}`;
        if (ids.has(id)) throw new Error('Duplicate curriculum reference.');
        ids.add(id);
        const content = typeof item.content === 'string' ? item.content : '';
        if (createHash('sha256').update(content).digest('hex') !== item.sha256) throw new Error('Curriculum content hash mismatch.');
        return { id, title: typeof item.path === 'string' ? item.path : id,
          content, language: language(item.language), kind: 'reference' as const,
          origin: 'shipped' as const, scope: 'global' as const, enabled: true, updatedAt: null };
      });
      entries.push(...imported);
      return { entries, notice: null };
    } catch (error) {
      return { entries, notice: (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'The optional curriculum could not be verified.' };
    }
  }
  get(workspace?: string | null): PensieveLibraryState {
    const saved = readSaved(this.options.file), project = projectScope(workspace), catalog = this.catalog();
    return { revision: saved.revision, enabled: saved.enabled, project: project?.title ?? null, notice: catalog.notice,
      entries: [...catalog.entries.map((entry) => ({ ...entry, enabled: !saved.disabled.includes(entry.id) })),
        ...saved.entries.filter((entry) => entry.scope === 'global' || entry.projectId === project?.id)
          .map(({ projectId: _private, ...entry }) => entry)] };
  }
  update(input: { workspace?: string | null; revision: number; mutation: LibraryMutation }): PensieveLibraryState {
    object(input); const current = readSaved(this.options.file);
    if (input.revision !== current.revision) throw new Error('The library changed. Reload it before saving.');
    const mutation = object(input.mutation) as unknown as LibraryMutation;
    const project = projectScope(input.workspace), view = this.get(input.workspace);
    const next = structuredClone(current);
    if (mutation.kind === 'enable') {
      if (typeof mutation.enabled !== 'boolean') throw new Error('Choose on or off.');
      next.enabled = mutation.enabled;
    } else if (mutation.kind === 'toggle') {
      if (typeof mutation.enabled !== 'boolean' || !view.entries.some((entry) => entry.id === mutation.id)) throw new Error('Unknown library entry.');
      const entry = next.entries.find((entry) => entry.id === mutation.id);
      if (entry) entry.enabled = mutation.enabled;
      else next.disabled = mutation.enabled ? next.disabled.filter((id) => id !== mutation.id) : [...new Set([...next.disabled, mutation.id])];
    } else if (mutation.kind === 'save') {
      const existing = mutation.id ? next.entries.find((entry) => entry.id === mutation.id) : null;
      if (mutation.id && (!existing || !view.entries.some((entry) => entry.id === mutation.id))) throw new Error('Shipped content is read-only.');
      if (mutation.scope === 'project' && !project) throw new Error('Choose a project before saving a project note.');
      if (mutation.entryKind === 'schema') { try { object(JSON.parse(mutation.content)); } catch { throw new Error('A schema must be a JSON object.'); } }
      const entry = normalizeEntry({ id: existing?.id ?? `custom:${randomUUID()}`, title: mutation.title, content: mutation.content,
        kind: mutation.entryKind, language: mutation.language, origin: 'custom', scope: mutation.scope,
        projectId: mutation.scope === 'project' ? project!.id : null, enabled: existing?.enabled ?? true, updatedAt: Date.now() });
      next.entries = [...next.entries.filter((item) => item.id !== entry.id), entry];
      if (next.entries.length > 1000) throw new Error('The library supports up to 1,000 custom entries.');
    } else if (mutation.kind === 'delete') {
      if (!view.entries.some((entry) => entry.id === mutation.id && entry.origin === 'custom')) throw new Error('Shipped content is read-only.');
      next.entries = next.entries.filter((entry) => entry.id !== mutation.id);
    } else throw new Error('Unknown library action.');
    next.revision++;
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('The library exceeds 8 MiB.');
    (this.options.write ?? writePrivateFileAtomic)(this.options.file, serialized);
    return this.get(input.workspace);
  }
  recall(workspace: string, cue: string, requestedLanguage: LibraryLanguage = 'shared', budget = 10_000): { text: string; items: unknown[] } {
    text(cue, 8000, 'memory cue'); language(requestedLanguage);
    const state = this.get(workspace);
    if (!state.enabled) return { text: '', items: [] };
    const terms = new Set(cue.toLocaleLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
    const ranked = state.entries.filter((entry) => entry.enabled && (entry.language === 'shared' || entry.language === requestedLanguage))
      .map((entry) => ({ entry, score: [...terms].reduce((score, word) => score + (`${entry.title}\n${entry.content}`.toLocaleLowerCase().includes(word) ? 1 : 0), 0) }))
      .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    const parts: string[] = [], items: unknown[] = []; let remaining = Math.max(0, Math.min(24_000, budget));
    for (const { entry } of ranked) {
      const part = `[${entry.origin === 'custom' ? 'User-authored guidance; not independently verified' : 'Shipped reference'}; ${entry.kind}; ${entry.language}; ${entry.title}]\n${entry.content}`;
      if (part.length + 2 > remaining) continue;
      parts.push(part); remaining -= part.length + 2;
      items.push({ id: entry.id, source: entry.origin, text: entry.content });
    }
    return { text: parts.join('\n\n'), items };
  }
  /** Rebuild from structured items so disabled content cannot survive in a preformatted response. */
  filterRuntimeRecall(value: unknown, query?: { workspace: string; cue: string; language: LibraryLanguage }): unknown {
    const saved = readSaved(this.options.file), result = object(value);
    if (!Array.isArray(result.items)) throw new Error('Pensieve returned an unsupported recall response.');
    const items = result.items.map(object).filter((entry) => entry.source !== 'curriculum' || !saved.disabled.includes(`curriculum:${entry.id}`));
    const budget = typeof result.budget_chars === 'number' ? Math.max(0, Math.min(24_000, result.budget_chars)) : 10_000;
    const extra = query ? this.recall(query.workspace, query.cue, query.language, Math.floor(budget / 3)) : null;
    const parts: string[] = extra?.text ? [extra.text] : [], kept: Record<string, unknown>[] = (extra?.items ?? []) as Record<string, unknown>[];
    let used = extra?.text ? extra.text.length + 2 : 0;
    for (const item of items) {
      if (typeof item.text !== 'string') continue;
      const part = `[${String(item.source)}; ${String(item.language)}; ${String(item.verification)}; ${String(item.path ?? item.id)}]\n${item.text}`;
      if (used + part.length + 2 > budget) continue;
      used += part.length + 2; parts.push(part); kept.push(item);
    }
    return { text: parts.join('\n\n'), items: kept, current: kept.filter((item) => item.source === 'current_failure'),
      budget_chars: budget, used_chars: parts.join('\n\n').length, curriculumId: result.curriculumId };
  }
}
