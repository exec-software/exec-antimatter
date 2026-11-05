/**
 * Semantic Versioning 2.0.0 precedence, which is what makes 0.1.0-alpha.10 newer than
 * 0.1.0-alpha.9 and 0.1.0 newer than any 0.1.0 prerelease. A string comparison gets both wrong.
 *
 * Spec: https://semver.org/#spec-item-11
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; numeric ones are numbers so they compare as numbers. */
  prerelease: (string | number)[];
}

const PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(value: string): Version | null {
  const match = PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  };
}

/** Negative when `left` is older, positive when newer, zero when they are the same release. Build metadata is ignored. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Cannot compare versions ${JSON.stringify(left)} and ${JSON.stringify(right)}.`);

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  // A release outranks every prerelease of the same version.
  if (!a.prerelease.length || !b.prerelease.length) return b.prerelease.length - a.prerelease.length;

  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const isNewer = (candidate: string, than: string): boolean => compareVersions(candidate, than) > 0;
