import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_CHAT_NOTE_BYTES, type ChatNote, type SaveChatNoteInput, type SaveChatNoteResult } from '../api/chatNotes';
import { migratePrivateFile, writePrivateFileAtomic } from './privateState';

interface Options {
  directory: () => string;
  conversationExists: (threadId: string) => boolean;
  now?: () => number;
}

function checkThreadId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid chat ID.');
  }
}

function checkMarkdown(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_CHAT_NOTE_BYTES) {
    throw new Error('Chat notes must be Markdown text smaller than 512 KiB.');
  }
}

/** Separate revisions keep note edits independent of streamed transcript checkpoints. */
export class ChatNotesStore {
  constructor(private readonly options: Options) {}

  private file(threadId: string): string {
    const digest = createHash('sha256').update(threadId).digest('hex');
    return join(this.options.directory(), `${digest}.json`);
  }

  private checkConversation(threadId: unknown): asserts threadId is string {
    checkThreadId(threadId);
    if (!this.options.conversationExists(threadId)) {
      throw new Error('This chat no longer exists.');
    }
  }

  private hasDirectory(): boolean {
    try {
      const stat = lstatSync(this.options.directory());
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('The chat notes directory is not safe to read.');
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private readFile(path: string): ChatNote {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHAT_NOTE_BYTES * 6 + 4096) {
      throw new Error('The saved chat notes could not be read safely.');
    }
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') {
      throw new Error('The saved chat notes are invalid.');
    }
    const record = value as Record<string, unknown>;
    checkThreadId(record.threadId);
    checkMarkdown(record.markdown);
    if (record.version !== 1 || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1 ||
        typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt) || record.updatedAt < 0) {
      throw new Error('The saved chat notes are invalid.');
    }
    migratePrivateFile(path);
    return { threadId: record.threadId, markdown: record.markdown, revision: Number(record.revision), updatedAt: record.updatedAt };
  }

  get(threadId: string): ChatNote {
    this.checkConversation(threadId);
    const path = this.file(threadId);
    if (!this.hasDirectory()) {
      return { threadId, markdown: '', revision: 0, updatedAt: null };
    }
    let note: ChatNote;
    try {
      note = this.readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { threadId, markdown: '', revision: 0, updatedAt: null };
      }
      throw error;
    }
    if (note.threadId !== threadId) {
      throw new Error('The saved notes belong to a different chat.');
    }
    return note;
  }

  save(input: SaveChatNoteInput): SaveChatNoteResult {
    if (!input || typeof input !== 'object') {
      throw new Error('Invalid chat note request.');
    }
    this.checkConversation(input.threadId);
    checkMarkdown(input.markdown);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('Invalid chat note revision.');
    }
    const current = this.get(input.threadId);
    if (input.expectedRevision !== current.revision) {
      return { saved: false, reason: 'conflict', note: current };
    }
    if (current.markdown === input.markdown) {
      return { saved: true, note: current };
    }
    const revision = current.revision + 1;
    if (!Number.isSafeInteger(revision)) {
      throw new Error('The chat note revision limit was reached.');
    }
    const note: ChatNote = {
      threadId: input.threadId,
      markdown: input.markdown,
      revision,
      updatedAt: (this.options.now ?? Date.now)(),
    };
    writePrivateFileAtomic(this.file(input.threadId), JSON.stringify({ version: 1, ...note }) + '\n');
    return { saved: true, note };
  }

  /** Called after a conversation deletion, never as part of saving a transcript. */
  remove(threadId: string): void {
    checkThreadId(threadId);
    if (!this.hasDirectory()) {
      return;
    }
    const path = this.file(threadId);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /** Clean up only owned, valid note files whose conversation has been removed. */
  pruneDeleted(): string[] {
    const directory = this.options.directory();
    if (!this.hasDirectory()) {
      return [];
    }
    const removed: string[] = [];
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) {
        continue;
      }
      const path = join(directory, name);
      const note = this.readFile(path);
      if (this.file(note.threadId) !== path) {
        throw new Error('The saved notes belong to a different chat.');
      }
      if (!this.options.conversationExists(note.threadId)) {
        this.remove(note.threadId);
        removed.push(note.threadId);
      }
    }
    return removed;
  }
}
