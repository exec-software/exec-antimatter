/** Public Execute labels; transport versions stay unchanged for existing updaters. */
export function displayReleaseVersion(version: string | null | undefined): string {
  if (!version) {
    return '';
  }
  const match = /^([1-9]\d*)\.0\.0$/.exec(version);
  if (match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) >= 2) {
    return `v${match[1]}`;
  }
  return version;
}
