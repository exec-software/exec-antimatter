/**
 * Announces that developer settings were written, so anything showing one can re-read it.
 *
 * The sidebar reads the whiteboard flag to decide whether the Desk lists it, and read it once on
 * mount. Ticking the box in Settings wrote the setting and nothing told the rail, so the entry
 * only appeared after a reload — the setting worked, the seam did not. Same shape as
 * `SIDEBAR_VISIBILITY_EVENT`, which exists for the same reason.
 *
 * Deliberately carries no payload. A listener re-reads from main rather than trusting what the
 * writer thought it saved: main normalizes, so the stored value is the only authority.
 */
export const DEVELOPER_SETTINGS_EVENT = 'antimatter:developer-settings';

/** Called by whatever just wrote developer settings. Safe before a window exists. */
export function announceDeveloperSettings(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(DEVELOPER_SETTINGS_EVENT));
}

/** Returns the unsubscribe, so a caller can hand it straight back from an effect. */
export function onDeveloperSettingsChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(DEVELOPER_SETTINGS_EVENT, listener);
  return () => window.removeEventListener(DEVELOPER_SETTINGS_EVENT, listener);
}
