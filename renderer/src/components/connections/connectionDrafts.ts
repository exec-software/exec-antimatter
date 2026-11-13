import type { ConnectionDraft } from '../../../../src/api/connections';

export interface DraftState { draft: ConnectionDraft; uncertain: boolean; submitted?: boolean }
export const CONNECTION_DRAFT_STORAGE_KEY = 'antimatter.connections.drafts.v1';
interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const MAX_STORAGE = 4 * 1024 * 1024;

function validate(value: unknown): DraftState {
  const entry = value as DraftState;
  const draft = entry?.draft;
  if (!draft || typeof entry.uncertain !== 'boolean' || entry.submitted !== undefined && typeof entry.submitted !== 'boolean' ||
      typeof draft.account !== 'string' || !draft.account || draft.account.length > 128 ||
      typeof draft.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(draft.requestId) ||
      typeof draft.destination !== 'string' || draft.destination.length > 2048 || typeof draft.subject !== 'string' || draft.subject.length > 998 ||
      typeof draft.text !== 'string' || draft.text.length > 65536 || draft.replyTo !== undefined && (typeof draft.replyTo !== 'string' || draft.replyTo.length > 1024)) {
    throw new Error('Invalid saved message draft.');
  }
  return { draft: { account: draft.account, requestId: draft.requestId, destination: draft.destination, subject: draft.subject, text: draft.text,
    ...(draft.replyTo ? { replyTo: draft.replyTo } : {}) }, uncertain: entry.uncertain, submitted: entry.submitted || entry.uncertain || false };
}

/** Corrupt storage is never overwritten implicitly, including by a newly opened account. */
export class ConnectionDraftStore {
  private drafts = new Map<string, DraftState>();
  error = '';
  corrupt = false;
  constructor(private readonly storage: DraftStorage) {
    try {
      const raw = storage.getItem(CONNECTION_DRAFT_STORAGE_KEY);
      if (!raw) { return; }
      if (raw.length > MAX_STORAGE) { throw new Error('Draft storage is too large.'); }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length > 50) { throw new Error('Invalid draft storage.'); }
      const drafts = new Map<string, DraftState>();
      for (const value of parsed) {
        const entry = validate(value);
        if (drafts.has(entry.draft.account)) { throw new Error('Duplicate draft account.'); }
        drafts.set(entry.draft.account, entry);
      }
      this.drafts = drafts;
    } catch {
      this.corrupt = true;
      this.error = 'Saved drafts could not be read. Download them for recovery, then reset draft storage to continue.';
    }
  }
  get(account: string): DraftState | undefined { const entry = this.drafts.get(account); return entry && structuredClone(entry); }
  has(account: string): boolean { return this.drafts.has(account); }
  set(account: string, entry: DraftState): boolean {
    if (this.corrupt) { throw new Error(this.error); }
    const next = validate(entry);
    if (next.draft.account !== account) { throw new Error('Draft belongs to another account.'); }
    if (!this.drafts.has(account) && this.drafts.size >= 50) { throw new Error('Keep at most 50 message drafts. Discard an existing draft first.'); }
    this.drafts.set(account, next);
    return this.save();
  }
  delete(account: string): boolean {
    if (this.corrupt) { throw new Error(this.error); }
    this.drafts.delete(account);
    return this.save();
  }
  private save(): boolean {
    try {
      const serialized = JSON.stringify([...this.drafts.values()]);
      if (serialized.length > MAX_STORAGE) { throw new Error('Draft storage is too large.'); }
      this.storage.setItem(CONNECTION_DRAFT_STORAGE_KEY, serialized);
      this.error = '';
      return true;
    } catch {
      this.error = 'Draft changes could not be saved. Keep this window open and copy your text before closing.';
      return false;
    }
  }
  download(): string { return this.storage.getItem(CONNECTION_DRAFT_STORAGE_KEY) ?? '[]'; }
  reset(): void {
    this.storage.removeItem(CONNECTION_DRAFT_STORAGE_KEY);
    this.drafts.clear(); this.corrupt = false; this.error = '';
  }
}

export const connectionDraftStore = new ConnectionDraftStore({
  getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: (key) => localStorage.removeItem(key),
});
export const connectionDraftBlockers = (): string[] => connectionDraftStore.error ? [connectionDraftStore.error] : [];
