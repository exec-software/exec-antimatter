import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { isFamilyName, type SystemFontFamily } from '../api/fonts';

/**
 * The font families installed on this machine, so the picker can offer them.
 *
 * There is no Electron API for this. Chromium knows, but only privately; the Local Font Access
 * API needs a permission prompt and is not in Electron. So fontconfig is asked directly, which
 * is the same source every GTK and Qt application uses on this platform, and the answer is
 * cached because it changes when someone installs a font and not otherwise.
 *
 * A family that cannot be put in a CSS custom property safely is dropped here rather than
 * offered and refused later: `fc-list` reports whatever is in the font's name table, including
 * names with quotes and commas in them, and none of that should reach the renderer.
 */

const exec = promisify(execFile);
/** Installing a font is a deliberate act; an hour is far below the rate it happens. */
const CACHE_MS = 60 * 60_000;
/** A picker is unusable past a few hundred entries, and a pathological fontconfig is possible. */
const MAX_FAMILIES = 2_000;

let cache: { at: number; families: SystemFontFamily[] } | null = null;

/** `fc-list` prints one family per line; a family with aliases prints them comma-separated. */
export function parseFcList(stdout: string, monospace: Set<string>): SystemFontFamily[] {
  const seen = new Map<string, SystemFontFamily>();
  for (const line of stdout.split('\n')) {
    // Only the first alias is taken. The rest are localized or legacy spellings of the same
    // family, and offering "Noto Sans CJK JP" three times in three scripts helps nobody.
    const family = line.split(',')[0].trim();
    if (!family || !isFamilyName(family) || seen.has(family)) continue;
    seen.set(family, { family, monospace: monospace.has(family) });
    if (seen.size >= MAX_FAMILIES) break;
  }
  return [...seen.values()].sort((a, b) => a.family.localeCompare(b.family));
}

async function query(args: string[]): Promise<string> {
  const { stdout } = await exec('fc-list', args, { timeout: 5_000, maxBuffer: 8 * 1_048_576 });
  return stdout;
}

/**
 * Enumerate installed families. Returns an empty list rather than throwing: a machine with no
 * fontconfig is a machine where the picker offers the bundled faces and the system default,
 * which is a smaller feature and not a broken one.
 */
export async function listSystemFonts(now: () => number = Date.now): Promise<SystemFontFamily[]> {
  if (cache && now() - cache.at < CACHE_MS) return cache.families;
  if (platform() !== 'linux') return [];
  try {
    // `:spacing=100` is fontconfig's fixed-advance class, asked separately so the code picker can
    // lead with faces that will actually align. A failure here only costs the distinction.
    const [all, mono] = await Promise.all([
      query([':', 'family']),
      query([':spacing=100', 'family']).catch(() => ''),
    ]);
    const monoNames = new Set(parseFcList(mono, new Set()).map((entry) => entry.family));
    const families = parseFcList(all, monoNames);
    cache = { at: now(), families };
    return families;
  } catch {
    // Negative results are cached too, so a box without fc-list is not probed on every open.
    cache = { at: now(), families: [] };
    return [];
  }
}

/** For tests, and for the case where someone installs a font with Antimatter open. */
export function forgetSystemFonts(): void {
  cache = null;
}
