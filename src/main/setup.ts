import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { DEFAULT_ASSISTANT, validateAssistantPatch, type AssistantSettings, type SetupState } from '../api/setup';
import { writePrivateFileAtomic } from './privateState';

interface SetupFile { version: 1; assistant: AssistantSettings; completedAt: number | null; }
const MAX_BYTES = 32 * 1024;

/** Private, atomic persistence. A failed save must never dismiss the first-run wizard. */
export class SetupStore {
  private current: SetupFile = { version: 1, assistant: { ...DEFAULT_ASSISTANT }, completedAt: null };
  private readonly existing: boolean;

  constructor(
    private readonly file: string,
    hasExistingConfiguration: () => boolean,
    private readonly write = writePrivateFileAtomic,
  ) {
    // Snapshot before startup services create empty stores. A corrupt setup file is existing
    // state too: do not interrupt an established installation with a fresh wizard.
    this.existing = hasExistingConfiguration();
    let descriptor: number | undefined;
    let missing = false;
    try {
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.existing = true;
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.size > MAX_BYTES) return;
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const length = readSync(descriptor, bytes, 0, bytes.length, 0);
      if (length > MAX_BYTES) return;
      const parsed: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const value = parsed as SetupFile;
      if (value.version !== 1) return;
      this.current = {
        version: 1,
        assistant: { ...DEFAULT_ASSISTANT, ...validateAssistantPatch(value.assistant) },
        completedAt: typeof value.completedAt === 'number' && Number.isFinite(value.completedAt) && value.completedAt > 0 ? value.completedAt : null,
      };
      // An interrupted first run must resume; the stored record is stronger evidence than
      // the incidental stores that first launch generated after the initial decision.
      this.existing = value.completedAt !== null || (value as SetupFile & { existingInstallation?: boolean }).existingInstallation === true;
    } catch (error) {
      missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) this.existing = true;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    // Other startup services create empty configuration files. Record the initial decision
    // now so an interrupted first launch still offers setup after those files exist.
    if (missing && !this.existing) this.persist(this.current);
  }

  get(): SetupState {
    return { assistant: { ...this.current.assistant }, completedAt: this.current.completedAt, showOnStartup: !this.existing && this.current.completedAt === null };
  }

  updateAssistant(value: unknown): SetupState {
    const assistant = { ...this.current.assistant, ...validateAssistantPatch(value) };
    if (assistant.name === this.current.assistant.name && assistant.personality === this.current.assistant.personality) return this.get();
    this.persist({ ...this.current, assistant });
    return this.get();
  }

  complete(now = Date.now()): SetupState {
    if (!Number.isFinite(now) || now <= 0) throw new Error('Invalid setup completion time.');
    if (this.current.completedAt === null) this.persist({ ...this.current, completedAt: now });
    return this.get();
  }

  private persist(next: SetupFile): void {
    this.write(this.file, `${JSON.stringify({ ...next, existingInstallation: this.existing }, null, 2)}\n`);
    this.current = next;
  }
}
