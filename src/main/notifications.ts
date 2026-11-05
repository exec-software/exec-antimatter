import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  DEFAULT_NOTIFICATIONS,
  DEFAULT_SOUND_ID,
  detectSoundType,
  MAX_CUSTOM_SOUND_BYTES,
  normalizeNotifications,
  notificationsEqual,
  validateNotificationsPatch,
  type CustomSound,
  type NotificationSettings,
} from '../api/notifications';
import { writePrivateFileAtomic } from './privateState';

/** Big enough for the settings with a file name and a path in them, small enough to bound. */
const MAX_SETTINGS_BYTES = 8192;

/**
 * Notification preferences on disk, read once at startup.
 *
 * The same shape as the appearance store, for the same reasons: one bounded synchronous read so
 * nothing on the first-paint path waits on the filesystem, an atomic private write, and a
 * published value that only moves after the write has succeeded.
 */
export class NotificationSettingsStore {
  private current: NotificationSettings;

  constructor(private readonly file: string, private readonly write = writePrivateFileAtomic) {
    this.current = this.read();
  }

  private read(): NotificationSettings {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.size > MAX_SETTINGS_BYTES) return { ...DEFAULT_NOTIFICATIONS };
      const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
      const length = readSync(descriptor, bytes, 0, bytes.length, 0);
      if (length > MAX_SETTINGS_BYTES) return { ...DEFAULT_NOTIFICATIONS };
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { version?: unknown }).version !== 1) {
        return { ...DEFAULT_NOTIFICATIONS };
      }
      return normalizeNotifications(value);
    } catch {
      return { ...DEFAULT_NOTIFICATIONS };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  get(): NotificationSettings { return { ...this.current }; }

  private commit(next: NotificationSettings): NotificationSettings {
    if (notificationsEqual(next, this.current)) return this.get();
    // Do not publish a new in-memory value when the durable write fails.
    this.write(this.file, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
    this.current = next;
    return this.get();
  }

  update(value: unknown): NotificationSettings {
    return this.commit(normalizeNotifications({ ...this.current, ...validateNotificationsPatch(value) }));
  }

  /**
   * Record, or forget, the chosen sound file.
   *
   * Separate from `update` because the renderer may not name a path: this is only ever called
   * with a file the main process opened itself. Choosing one selects it — nobody picks a sound
   * and then expects to still hear the chime — and forgetting one puts the selection back on a
   * built-in rather than leaving it pointing at nothing.
   */
  setCustomSound(sound: CustomSound | null): NotificationSettings {
    return this.commit(normalizeNotifications({
      ...this.current,
      customSound: sound,
      soundId: sound ? 'custom' : this.current.soundId === 'custom' ? DEFAULT_SOUND_ID : this.current.soundId,
    }));
  }
}

/** Read a whole small file through a descriptor that cannot be redirected by a symlink. */
function readBounded(path: string, limit: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('That is not a file.');
    if (stats.size === 0) throw new Error('That file is empty.');
    if (stats.size > limit) {
      throw new Error(`A notification sound must be under ${Math.round(limit / (1024 * 1024))} MB.`);
    }
    const bytes = Buffer.alloc(stats.size);
    let read = 0;
    while (read < bytes.length) {
      const chunk = readSync(descriptor, bytes, read, bytes.length - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
    return bytes.subarray(0, read);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Vet a chosen sound file and keep a copy of it.
 *
 * Copied rather than referenced, so the sound survives the Downloads folder it was picked out
 * of being emptied, and so the only path this app ever reads a sound from is one inside its own
 * state directory. The copy's name is fixed: one stored sound at a time, and replacing it leaves
 * nothing behind to accumulate.
 */
export function adoptSoundFile(
  source: string,
  directory: string,
  write = writePrivateFileAtomic,
): CustomSound {
  const bytes = readBounded(source, MAX_CUSTOM_SOUND_BYTES);
  const type = detectSoundType(bytes.subarray(0, 16));
  if (!type) throw new Error('That file is not a WAV, MP3, Ogg, FLAC or M4A sound.');
  const path = join(directory, `notification-sound.${type.extension}`);
  write(path, bytes);
  return { path, name: basename(source).slice(0, 120) || `sound.${type.extension}`, mime: type.mime, bytes: bytes.length };
}

/**
 * The stored sound as a data URL.
 *
 * A data URL rather than a file:// reference or a custom protocol: the renderer decodes it once
 * into an AudioBuffer and plays from memory after that, so the cost is one bounded read per
 * change of sound and the window never gets a filesystem path it could ask for anything else by.
 *
 * The type is re-detected from the bytes on the way out. This is Antimatter's own copy, so it
 * should always agree with what was recorded; disagreeing means the file was replaced underneath
 * us, and the bytes are the thing that will actually be decoded.
 */
export function readSoundDataUrl(sound: CustomSound): { dataUrl: string; mime: string } | null {
  try {
    const bytes = readBounded(sound.path, MAX_CUSTOM_SOUND_BYTES);
    const type = detectSoundType(bytes.subarray(0, 16));
    if (!type) return null;
    return { dataUrl: `data:${type.mime};base64,${bytes.toString('base64')}`, mime: type.mime };
  } catch (cause) {
    console.warn('[notifications] could not read the chosen sound:', cause);
    return null;
  }
}
