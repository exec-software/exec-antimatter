/** Small settings drafts survive navigation; failed storage stays in memory and blocks restart. */
const prefix = 'antimatter.form-draft.';
const MAX_DRAFT_CHARS = 2 * 1024 * 1024;
const MAX_RECOVERY_CHARS = 16 * 1024 * 1024;
interface DraftRecord {
  value: string | null;
  dirty: boolean;
  recovery: boolean;
  invalid: boolean;
  error: string | null;
}
const drafts = new Map<string, DraftRecord>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version++; queueMicrotask(() => { for (const listener of listeners) listener(); }); };
export const subscribeFormDrafts = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const formDraftVersion = (): number => version;
export function formDraftStatus(key: string): { error: string | null; recovery: boolean } {
  const record = drafts.get(key);
  return { error: record?.error ?? null, recovery: record?.recovery ?? false };
}
const empty = (): DraftRecord => ({ value: null, dirty: false, recovery: false, invalid: false, error: null });
const recordFor = (key: string) => {
  let record = drafts.get(key);
  if (!record) { record = empty(); drafts.set(key, record); }
  return record;
};
function persist(key: string, record: DraftRecord): boolean {
  if (record.recovery || record.invalid) return false;
  if (!record.dirty) return !record.error;
  try {
    if (record.value === null) localStorage.removeItem(prefix + key);
    else localStorage.setItem(prefix + key, record.value);
    record.dirty = false; record.error = null; changed(); return true;
  } catch {
    record.error = record.value === null ? 'Could not remove the saved draft. Retry before restarting.'
      : 'Could not save the draft on this device. Your edits are kept in this window. Retry or download a copy before restarting.';
    changed(); return false;
  }
}
export function readFormDraft<T>(key: string, valid: (value: unknown) => value is T): T | null {
  let record = drafts.get(key);
  if (!record) {
    record = empty(); drafts.set(key, record);
    try {
      const text = localStorage.getItem(prefix + key);
      if (text !== null) {
        if (text.length > MAX_DRAFT_CHARS) throw new Error('Oversized draft.');
        const value: unknown = JSON.parse(text);
        if (!valid(value)) throw new Error('Invalid draft.');
        record.value = text;
      }
    } catch {
      record.recovery = true;
      record.error = 'The saved draft could not be read. It has been preserved. Download it before resetting saved draft storage.';
      changed();
    }
  }
  if (record.value === null) return null;
  try { const value: unknown = JSON.parse(record.value); return valid(value) ? value : null; }
  catch { return null; }
}
export function writeFormDraft(key: string, value: unknown): boolean {
  const record = recordFor(key);
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { /* Report serialization errors without losing the previous draft. */ }
  if (text === undefined || text.length > MAX_DRAFT_CHARS) {
    record.invalid = true;
    record.error = 'This draft is too large or could not be encoded. Save or shorten your edits before restarting.';
    changed(); return false;
  }
  record.value = text; record.dirty = true; record.invalid = false;
  if (record.recovery) { changed(); return false; }
  return persist(key, record);
}
export function clearFormDraft(key: string, expected?: unknown): boolean {
  const record = recordFor(key);
  if (expected !== undefined) {
    let text: string | undefined;
    try { text = JSON.stringify(expected); } catch { return false; }
    if (record.value !== text) return false;
  }
  // A blank newly mounted form must never erase unreadable saved bytes.
  record.value = null; record.invalid = false;
  if (record.recovery) { record.dirty = false; changed(); return false; }
  record.dirty = true;
  return persist(key, record);
}
export function retryFormDraft(key: string): boolean { return persist(key, recordFor(key)); }
export function resetFormDraft(key: string): boolean {
  const record = recordFor(key);
  try { localStorage.removeItem(prefix + key); }
  catch { record.error = 'Could not reset saved draft storage. The saved copy and current edits are unchanged.'; changed(); return false; }
  record.recovery = false;
  record.error = record.invalid ? 'This draft is too large or could not be encoded. Save or shorten your edits before restarting.' : null;
  // Preserve a new valid draft the user typed while the old saved copy was unreadable.
  record.dirty = record.value !== null;
  changed(); return persist(key, record);
}
export function downloadFormDraft(key: string, saved = false): string {
  const record = recordFor(key);
  let text: string | null;
  try { text = saved ? localStorage.getItem(prefix + key) : record.value; }
  catch { throw new Error('Saved draft storage is unavailable. Keep this window open and retry.'); }
  if (text === null) throw new Error('There is no saved draft to download. Current edits remain in this window.');
  if (text.length > MAX_RECOVERY_CHARS) throw new Error('The saved copy exceeds the 16 MiB recovery limit. Keep it in storage until you can recover it externally.');
  return text;
}
/** Used by close/update guards. Never erase an unreadable copy to make a restart proceed. */
export function flushFormDrafts(): string[] {
  for (const [key, record] of drafts) persist(key, record);
  return [...drafts].filter(([, record]) => record.error || record.dirty || record.recovery)
    .map(([key, record]) => `${key === 'feature-management' ? 'Feature draft' : 'Memory draft'}: ${record.error ?? 'Save is still pending.'}`);
}
