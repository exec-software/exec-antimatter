import { MAX_CHAT_NOTE_BYTES, type ChatNote, type ChatNotesAPI } from '../../../src/api/chatNotes';

const DRAFT_PREFIX = 'antimatter.chat-notes.draft.';
interface Draft { markdown: string; expectedRevision: number }
interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface NotesState {
  markdown: string;
  revision: number;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  deleted: boolean;
  error: string;
  conflict: ChatNote | null;
}

/** One save queue per chat, independent of modal mounts and active-chat changes. */
export class ChatNoteDraft {
  private state: NotesState = { markdown: '', revision: 0, loading: true, saving: false, dirty: false, deleted: false, error: '', conflict: null };
  private savedMarkdown = '';
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<void> | null = null;
  private composing = false;
  private readonly ready: Promise<void>;
  private unsubscribe: () => void;
  private key: string;

  constructor(readonly threadId: string, private api: ChatNotesAPI, private storage: DraftStorage, private debounce = 450) {
    this.key = DRAFT_PREFIX + encodeURIComponent(threadId);
    this.unsubscribe = api.onChanged((change) => {
      if (change.threadId !== threadId) {
        return;
      }
      if (change.kind === 'deleted') {
        this.deleted();
      } else if (!this.composing && !this.state.dirty && !this.state.saving && !this.state.loading && change.revision > this.state.revision) {
        void this.refresh();
      }
    });
    this.ready = this.load();
  }

  getSnapshot = (): NotesState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<NotesState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private persist(): void {
    try {
      if (this.state.dirty && !this.state.deleted) {
        this.storage.setItem(this.key, JSON.stringify({ markdown: this.state.markdown, expectedRevision: this.state.revision }));
      } else {
        this.storage.removeItem(this.key);
      }
    } catch {
      // The host save remains authoritative when browser storage is full or unavailable.
    }
  }
  private deleted(): void {
    clearTimeout(this.timer);
    this.composing = false;
    this.update({ deleted: true, loading: false, saving: false, dirty: false, conflict: null, error: 'This chat was deleted. Its notes can no longer be saved.' });
    this.persist();
  }
  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('This chat no longer exists')) {
      this.deleted();
    } else {
      this.update({ loading: false, saving: false, error: message });
    }
  }
  private async load(): Promise<void> {
    try {
      const note = await this.api.get(this.threadId);
      if (this.state.deleted) {
        return;
      }
      let draft: Draft | null = null;
      try {
        const value = JSON.parse(this.storage.getItem(this.key) ?? 'null') as Draft | null;
        if (value && typeof value.markdown === 'string' && !value.markdown.includes('\0') &&
            new TextEncoder().encode(value.markdown).length <= MAX_CHAT_NOTE_BYTES &&
            Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0) {
          draft = value;
        }
      } catch { /* A damaged browser draft must not prevent opening the saved notes. */ }
      this.savedMarkdown = note.markdown;
      const dirty = !!draft && draft.markdown !== note.markdown;
      this.update({ loading: false, markdown: dirty ? draft!.markdown : note.markdown,
        revision: dirty ? draft!.expectedRevision : note.revision, dirty,
        conflict: dirty && draft!.expectedRevision !== note.revision ? note : null, error: '' });
      this.persist();
      if (dirty && !this.state.conflict) {
        this.schedule();
      }
    } catch (error) {
      this.fail(error);
    }
  }
  private async refresh(): Promise<void> {
    try {
      const revision = this.state.revision;
      const note = await this.api.get(this.threadId);
      if (!this.composing && !this.state.dirty && !this.state.saving && !this.state.deleted && this.state.revision === revision) {
        this.savedMarkdown = note.markdown;
        this.update({ markdown: note.markdown, revision: note.revision, error: '' });
      }
    } catch (error) {
      this.fail(error);
    }
  }
  change(markdown: string): void {
    if (this.state.loading || this.state.deleted) {
      return;
    }
    if (new TextEncoder().encode(markdown).length > MAX_CHAT_NOTE_BYTES || markdown.includes('\0')) {
      this.update({ error: 'Chat notes must be Markdown text smaller than 512 KiB.' });
      return;
    }
    this.update({ markdown, dirty: markdown !== this.savedMarkdown || this.state.saving, error: '' });
    this.persist();
    this.schedule();
  }
  setComposing(composing: boolean): void {
    this.composing = composing;
    if (!composing) {
      this.schedule();
    }
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.state.dirty && !this.state.conflict && !this.state.deleted) {
      this.timer = setTimeout(() => { void this.flush(); }, this.debounce);
    }
  }
  async flush(): Promise<string | null> {
    clearTimeout(this.timer);
    await this.ready;
    if (this.composing) {
      return 'Finish entering text in chat notes before closing.';
    }
    if (this.state.deleted) {
      return null;
    }
    if (this.state.conflict) {
      return 'Chat notes have conflicting edits. Open notes to choose which version to keep.';
    }
    if (this.state.dirty && !this.flight) {
      const flight = this.save();
      this.flight = flight;
      void flight.finally(() => {
        if (this.flight === flight) {
          this.flight = null;
        }
      });
    }
    if (this.flight) {
      await this.flight;
    }
    return this.state.conflict ? 'Chat notes have conflicting edits. Open notes to choose which version to keep.' :
      this.state.dirty || this.state.error ? this.state.error || 'Chat notes have unsaved edits.' : null;
  }
  private async save(): Promise<void> {
    this.update({ saving: true, error: '' });
    try {
      while (this.state.dirty && !this.state.deleted && !this.state.conflict) {
        const markdown = this.state.markdown;
        const result = await this.api.save({ threadId: this.threadId, markdown, expectedRevision: this.state.revision });
        if (this.state.deleted) {
          break;
        }
        if (!result.saved && result.note.markdown !== this.state.markdown) {
          this.update({ conflict: result.note });
          break;
        }
        this.savedMarkdown = result.note.markdown;
        this.update({ revision: result.note.revision, dirty: this.state.markdown !== result.note.markdown });
        this.persist();
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.update({ saving: false });
    }
  }
  useSaved(): void {
    const note = this.state.conflict;
    if (!note) {
      return;
    }
    this.savedMarkdown = note.markdown;
    this.update({ markdown: note.markdown, revision: note.revision, dirty: false, conflict: null, error: '' });
    this.persist();
  }
  keepDraft(): void {
    const note = this.state.conflict;
    if (!note) {
      return;
    }
    this.savedMarkdown = note.markdown;
    this.update({ revision: note.revision, dirty: this.state.markdown !== note.markdown, conflict: null, error: '' });
    this.persist();
    void this.flush();
  }
  async retry(): Promise<void> {
    if (!this.state.dirty && this.state.error && !this.state.deleted) {
      this.update({ loading: true });
      await this.load();
    } else {
      await this.flush();
    }
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.unsubscribe();
    this.listeners.clear();
  }
}

const drafts = new Map<string, ChatNoteDraft>();
export function chatNoteDraft(threadId: string): ChatNoteDraft {
  let draft = drafts.get(threadId);
  if (!draft) {
    draft = new ChatNoteDraft(threadId, window.electronAPI.chatNotes, window.localStorage);
    drafts.set(threadId, draft);
  }
  return draft;
}

/** Used by the desktop close/update handshake, including recovered drafts not opened this run. */
export async function flushChatNoteDrafts(): Promise<string[]> {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(DRAFT_PREFIX)) {
        chatNoteDraft(decodeURIComponent(key.slice(DRAFT_PREFIX.length)));
      }
    }
  } catch { /* Existing live drafts are still flushed when storage cannot be enumerated. */ }
  const results = await Promise.all([...drafts.values()].map((draft) => draft.flush()));
  return results.filter((result): result is string => result !== null);
}
