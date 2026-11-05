const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Only ordinary web and email links may cross from untrusted transcript content to the OS. */
export function isAllowedExternalUrl(value: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}
