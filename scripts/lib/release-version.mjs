/** The publishing contract supports stable SemVer and numbered alpha releases. */
export function parseReleaseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  const alpha = match[4] === undefined ? null : Number(match[4]);
  if (!numbers.every(Number.isSafeInteger) || (alpha !== null && !Number.isSafeInteger(alpha))) return null;
  return { numbers, alpha, channel: alpha === null ? 'stable' : 'alpha' };
}

export const releaseChannel = (version) => parseReleaseVersion(version)?.channel ?? null;

/** Execute's public rolling version, independent of the legacy SemVer transport spelling. */
export function parseRollingVersion(value) {
  if (typeof value !== 'string' || !/^v[1-9]\d*$/.test(value)) return null;
  const number = Number(value.slice(1));
  return Number.isSafeInteger(number) ? number : null;
}

/** Keep installed SemVer updaters working: public vN ships as package/feed version N.0.0. */
export function rollingPackageVersion(value) {
  const number = parseRollingVersion(value);
  return number === null ? null : `${number}.0.0`;
}

/** Legacy manifests remain valid; new rolling manifests additionally bind their public name. */
export function isReleaseIdentity(manifest) {
  const channel = releaseChannel(manifest?.version);
  return !!channel && manifest.channel === channel && manifest.tag === `v${manifest.version}` &&
    (manifest.releaseVersion === undefined || (channel === 'stable' && rollingPackageVersion(manifest.releaseVersion) === manifest.version));
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  if (!a || !b) throw new Error('Expected stable or numbered-alpha release versions.');
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.alpha === b.alpha) return 0;
  if (a.alpha === null) return 1;
  if (b.alpha === null) return -1;
  return a.alpha - b.alpha;
}

export function nextReleaseVersion(version) {
  const current = parseReleaseVersion(version);
  if (!current) throw new Error('Expected a stable or numbered-alpha release version.');
  if (current.alpha !== null) return `${current.numbers.join('.')}-alpha.${current.alpha + 1}`;
  const [major, minor, patch] = current.numbers;
  return `${major}.${minor}.${patch + 1}`;
}
