import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appearanceEquals, DEFAULT_APPEARANCE, normalizeAppearance, resolveTheme, validateAppearancePatch, type AppearanceSettings } from '../api/appearance';
import { writePrivateFileAtomic } from './privateState';

const MAX_SETTINGS_BYTES = 4096;

/** One bounded startup read; synchronous first-paint IPC only returns the cached snapshot. */
export class AppearanceSettingsStore {
  private current: AppearanceSettings;

  constructor(private readonly file: string, private readonly write = writePrivateFileAtomic) {
    this.current = this.read();
  }

  private read(): AppearanceSettings {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.size > MAX_SETTINGS_BYTES) return { ...DEFAULT_APPEARANCE };
      const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
      const length = readSync(descriptor, bytes, 0, bytes.length, 0);
      if (length > MAX_SETTINGS_BYTES) return { ...DEFAULT_APPEARANCE };
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { version?: unknown }).version !== 1) return { ...DEFAULT_APPEARANCE };
      return normalizeAppearance(value);
    } catch {
      return { ...DEFAULT_APPEARANCE };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  get(): AppearanceSettings { return { ...this.current }; }

  update(value: unknown): AppearanceSettings {
    const next = normalizeAppearance({ ...this.current, ...validateAppearancePatch(value) });
    if (appearanceEquals(next, this.current)) return this.get();
    // Do not publish a new in-memory value when the durable write fails.
    this.write(this.file, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`);
    this.current = next;
    return this.get();
  }
}

/** Matches Clay's and Clay Light's page tiers, so a cold window never flashes the wrong lightness. */
export const appearanceBackground = (settings: AppearanceSettings, now?: Date): string =>
  resolveTheme(settings, now) === 'light' ? '#f6f5f2' : '#141414';

/** Identity is checked separately: same-origin preview pages are not app-owned windows. */
export function isAppearancePage(url: string, entry: 'index.html' | 'about.html' | 'avatar.html' | 'recovery.html' | 'detached.html', rendererDirectory: string, devServerUrl?: string): boolean {
  try {
    const actual = new URL(url);
    if (actual.username || actual.password) return false;
    if (devServerUrl) {
      const expected = new URL(entry === 'index.html' ? './' : entry, devServerUrl);
      const paths = entry === 'index.html' ? [expected.pathname, new URL('index.html', expected).pathname] : [expected.pathname];
      return actual.origin === expected.origin && paths.includes(actual.pathname);
    }
    return actual.protocol === 'file:' && fileURLToPath(actual) === join(rendererDirectory, entry);
  } catch { return false; }
}

export function mayReadAppearance(surface: 'main' | 'about' | 'avatar' | 'recovery' | 'detached' | null, mainFrame: boolean, trustedPage: boolean): boolean {
  return surface !== null && mainFrame && trustedPage;
}

export function mayUpdateAppearance(surface: 'main' | 'about' | 'avatar' | 'recovery' | 'detached' | null, mainFrame: boolean, trustedPage: boolean): boolean {
  return surface === 'main' && mainFrame && trustedPage;
}
