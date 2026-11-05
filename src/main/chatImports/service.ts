import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { ChatImportPreview, ChatImportResult, ChatImportSource, ImportedChatOrigin } from '../../api/chatImports';
import { parseChatImport, type ParsedImportConversation } from './parsers';

const MAX_FILE = 32 * 1024 * 1024;
const MAX_BATCH = 64 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_CANDIDATES = 1000;
const MAX_VISITED_ENTRIES = 10_000;
const MAX_WARNINGS = 100;
const MAX_ACTIVE_BATCHES = 4;
const LIFETIME = 15 * 60_000;
const identity = (item: Pick<ImportedChatOrigin, 'source' | 'format' | 'externalId'>) => JSON.stringify([item.source, item.format, item.externalId]);
type Batch = { id: string; expiresAt: number; rows: Map<string, ParsedImportConversation>; timer: ReturnType<typeof setTimeout> };
class ImportFileError extends Error {}
class ImportLimitError extends Error {}
const assertOwner = (owner: number): void => {
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Invalid import owner.');
};
interface Storage {
  origins(): ImportedChatOrigin[];
  import(input: { projectId: string; conversations: ParsedImportConversation[] }): { imported: Array<{ id: string }>; skipped: number };
}

/** Reads only paths returned by the main-process picker; the renderer never supplies a path. */
export class ChatImportService {
  private batches = new Map<number, Batch>();
  private preparing = new Map<number, { cancelled: boolean }>();
  constructor(private readonly storage: Storage) {}

  discard(owner: number, id?: string): void {
    assertOwner(owner);
    if (id !== undefined && (typeof id !== 'string' || !id || id.length > 64)) throw new Error('Invalid import preview.');
    // Destroyed owners can cancel reads before any preview id exists. A stale preview id must
    // not cancel a newer inspection belonging to the same window.
    if (id === undefined) {
      const preparing = this.preparing.get(owner);
      if (preparing) preparing.cancelled = true;
    }
    const batch = this.batches.get(owner);
    if (batch && (id === undefined || batch.id === id)) { clearTimeout(batch.timer); this.batches.delete(owner); }
  }

  async prepare(owner: number, paths: string[], source: ChatImportSource, mode: 'files' | 'folder'): Promise<ChatImportPreview> {
    assertOwner(owner);
    if (this.preparing.has(owner)) throw new Error('Another import is being inspected. Please wait.');
    if (!['claude', 'codex', 'opencode'].includes(source) || !['files', 'folder'].includes(mode)) throw new Error('Invalid import choice.');
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_FILES) throw new Error(`Choose between 1 and ${MAX_FILES} files.`);
    if (paths.some((file) => typeof file !== 'string' || !isAbsolute(file) || file.length > 4096 || file.includes('\0'))) throw new Error('Choose valid local files or a session folder.');
    this.discard(owner);
    if (this.batches.size + this.preparing.size >= MAX_ACTIVE_BATCHES) throw new Error('Too many import previews are open. Close an existing preview and try again.');
    const preparation = { cancelled: false };
    this.preparing.set(owner, preparation);
    const folderExtension = source === 'opencode' ? '.json' : '.jsonl';
    const fileExtensions = source === 'opencode' ? ['.json'] : ['.json', '.jsonl'];
    const checkCancelled = () => { if (preparation.cancelled) throw new Error('The import inspection was cancelled. Choose the files again.'); };
    try {
      const warnings: string[] = [];
      const warningKeys = new Set<string>();
      let omittedWarnings = 0;
      const warn = (value: string) => {
        const safe = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ');
        const warning = safe.length > 1000 ? `${safe.slice(0, 997)}...` : safe;
        if (warningKeys.has(warning)) return;
        if (warnings.length >= MAX_WARNINGS) { omittedWarnings++; return; }
        warningKeys.add(warning);
        warnings.push(warning);
      };
      const files: string[] = [];
      let visited = 0;
      const walk = async (directory: string, depth = 0): Promise<void> => {
        checkCancelled();
        if (++visited > MAX_VISITED_ENTRIES || depth > 12) throw new ImportLimitError('This folder is too large or deeply nested. Choose a smaller session folder.');
        const info = await lstat(directory).catch(() => { throw new Error('Could not inspect the selected session folder. Check access and choose it again.'); });
        checkCancelled();
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Choose a regular session folder, not a symbolic link.');
        // Streaming iteration bounds even a folder with millions of irrelevant filenames.
        const handle = await opendir(directory).catch(() => { throw new Error('Could not read the selected session folder. Check access and choose it again.'); });
        for await (const entry of handle) {
          checkCancelled();
          if (++visited > MAX_VISITED_ENTRIES) throw new ImportLimitError('This folder contains too many entries. Choose a smaller session folder.');
          if (entry.isSymbolicLink()) { warn('Symbolic links inside the selected folder were skipped; linked files and folders were not followed.'); continue; }
          if (entry.isDirectory()) await walk(join(directory, entry.name), depth + 1);
          else if (entry.isFile() && entry.name.toLowerCase().endsWith(folderExtension)) {
            files.push(join(directory, entry.name));
            if (files.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} session files found. Choose a smaller folder.`);
          } else if (!entry.isFile()) warn('Special files inside the selected folder were skipped.');
        }
      };
      if (mode === 'folder') {
        if (paths.length !== 1) throw new Error('Choose one session folder.');
        await walk(paths[0]);
      } else files.push(...new Set(paths));
      if (!files.length) throw new Error(source === 'opencode'
        ? 'No OpenCode JSON export files found in that folder. Raw databases and storage directories are not supported.'
        : 'No JSONL session files found in that folder.');
      const existing = new Set(this.storage.origins().map(identity));
      const seen = new Set<string>();
      const rows = new Map<string, ParsedImportConversation>();
      let bytes = 0;
      for (const file of files) {
        checkCancelled();
        if (!fileExtensions.includes(extname(file).toLowerCase())) {
          warn(`${basename(file)}: ${source === 'opencode' ? 'choose an OpenCode JSON export; raw databases, storage files, and JSONL are not supported.' : 'choose an extracted JSON export or a JSONL session file.'}`);
          continue;
        }
        let text: string;
        try {
          const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            checkCancelled();
            const before = await handle.stat();
            if (!before.isFile() || before.size > MAX_FILE) throw new ImportFileError('File must be regular and at most 32 MiB.');
            if (bytes + before.size > MAX_BATCH) throw new ImportLimitError('The selected files exceed 64 MiB. Choose a smaller batch.');
            // Reserve before reading: unstable files still consumed I/O and memory budget.
            bytes += before.size;
            const data = Buffer.alloc(before.size + 1);
            let offset = 0;
            while (offset < data.length) {
              checkCancelled();
              const next = await handle.read(data, offset, data.length - offset, offset);
              if (!next.bytesRead) break;
              offset += next.bytesRead;
            }
            const after = await handle.stat();
            checkCancelled();
            if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ImportFileError('The session changed while being read. Retry after it finishes.');
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, offset)); }
            catch { throw new ImportFileError('The file contains invalid UTF-8 text. Export it again before importing.'); }
          } finally { await handle.close(); }
        } catch (error) {
          checkCancelled();
          if (error instanceof ImportLimitError) throw error;
          const reason = error instanceof ImportFileError ? error.message : 'Could not read this regular file; symbolic links and special files are not supported.';
          warn(`${basename(file)}: ${reason}`); continue;
        }
        try {
          const parsed = parseChatImport(text, basename(file));
          for (const warning of parsed.warnings) warn(`${basename(file)}: ${warning}`);
          for (const item of parsed.conversations) {
            if (item.source !== source) { warn(`${basename(file)}: a different source was detected; choose the matching import section.`); continue; }
            const key = identity(item);
            if (seen.has(key)) { warn(`${basename(file)}: duplicate session in the selected files was skipped.`); continue; }
            if (rows.size >= MAX_CANDIDATES) throw new ImportLimitError(`More than ${MAX_CANDIDATES} conversations found. Choose a smaller export.`);
            seen.add(key);
            rows.set(randomUUID(), item);
          }
        } catch (error) {
          if (error instanceof ImportLimitError) throw error;
          warn(`${basename(file)}: ${error instanceof Error ? error.message : 'Unsupported or invalid chat data.'}`);
        }
        await setImmediate();
      }
      checkCancelled();
      const id = randomUUID();
      const expiresAt = Date.now() + LIFETIME;
      const timer = setTimeout(() => this.discard(owner, id), LIFETIME); timer.unref();
      this.batches.set(owner, { id, expiresAt, rows, timer });
      return { batchId: id, expiresAt, fileCount: files.length,
        warnings: [...warnings, ...(omittedWarnings ? [`${omittedWarnings} additional warnings were omitted. Choose a smaller batch to inspect every diagnostic.`] : [])],
        candidates: [...rows].map(([rowId, item]) => ({
        id: rowId, source: item.source, format: item.format, title: item.title, createdAt: item.createdAt,
        messageCount: item.messages.length, toolCount: item.messages.reduce((total, message) => total + (message.meta.tools?.length ?? 0), 0),
        alreadyImported: existing.has(identity(item)),
      })) };
    } finally { this.preparing.delete(owner); }
  }

  commit(owner: number, value: unknown): ChatImportResult {
    assertOwner(owner);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid import selection.');
    const { batchId, ids, projectId } = value as Record<string, unknown>;
    const batch = this.batches.get(owner);
    if (!batch || batch.id !== batchId || batch.expiresAt <= Date.now()) { if (batch && batch.expiresAt <= Date.now()) this.discard(owner); throw new Error('This import preview expired. Choose the files again.'); }
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((id) => typeof id !== 'string' || !batch.rows.has(id)) || new Set(ids).size !== ids.length) throw new Error('Select between 1 and 200 conversations from this preview.');
    if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 256 || /[\u0000-\u001f]/.test(projectId)) throw new Error('Choose a valid destination project.');
    const result = this.storage.import({ projectId, conversations: ids.map((id) => batch.rows.get(id)!) });
    this.discard(owner, batch.id);
    return { importedThreadIds: result.imported.map((thread) => thread.id), skipped: result.skipped };
  }
}
