/**
 * What a preview is allowed to point at.
 *
 * Both halves are checks on a string a model chose, and both are the boundary rather than a
 * convenience: a URL decides what a browser engine inside the app will load, and a media type
 * decides what is handed to a decoder. They live apart from the code that acts on them so they
 * can be tested without a running Electron, which is also the reason to keep them small.
 */

const SIGNATURES: { media: string; bytes: number[] }[] = [
  { media: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { media: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
];

/**
 * What an image actually is, from its first bytes, or null when it is not one.
 *
 * The extension is a claim, not a fact, and a model that has just written a PNG to `shot.jpg` is
 * exactly the caller this has to survive. Electron only promises portable nativeImage decoding
 * for PNG and JPEG, so those are the complete alpha surface rather than an optimistic extension
 * list that behaves differently by operating system.
 */
export function mediaTypeOf(bytes: Buffer): string | null {
  for (const { media, bytes: signature } of SIGNATURES) {
    if (signature.every((byte, index) => bytes[index] === byte)) return media;
  }
  return null;
}

/** The formats named in a message to the model, so a refusal says what would have worked. */
export const READABLE_IMAGES = 'PNG and JPEG';

/**
 * A named capture is a window capture, never a display whose title happened to match the model's
 * substring. Untargeted captures are the only calls allowed to ask Electron for screens.
 */
export const captureSourceTypes = (window?: string): Array<'window' | 'screen'> =>
  window?.trim() ? ['window'] : ['screen'];

/** All exact or substring title matches; capture proceeds only when this contains one source. */
export const namedCaptureMatches = <T extends { name: string }>(sources: readonly T[], wanted: string): T[] => {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return [];
  return sources.filter((source) => {
    const title = source.name.toLowerCase();
    return title === needle || title.includes(needle);
  });
};

/**
 * Whether the capturer named nothing at all, which is a session no window can be asked for.
 *
 * A Wayland/PipeWire desktop answers a window enumeration with one nameless entry, so a title match
 * cannot succeed however it is spelled. Told "no window matching X", a model retries with a better
 * guess; told this, it can photograph the display instead. Empty is not the same answer — there the
 * capturer offered no windows at all, which the caller already reports in its own words.
 */
export const publishesNoWindowTitles = <T extends { name: string }>(sources: readonly T[]): boolean =>
  sources.length > 0 && sources.every((source) => !source.name.trim());

/** Refuses both guesses and ambiguous partial matches, without disclosing candidate titles. */
export function uniqueNamedCaptureSource<T extends { name: string }>(sources: readonly T[], wanted: string): T {
  const matches = namedCaptureMatches(sources, wanted);
  if (matches.length === 0) {
    throw new Error(`No window matching "${wanted}" is open. Check its title and try again.`);
  }
  if (matches.length > 1) {
    throw new Error(`More than one window matches "${wanted}". Use a more specific title and try again.`);
  }
  return matches[0];
}

export interface PreviewRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Turns an untrusted renderer measurement into a rectangle Electron can safely apply.
 *
 * A `WebContentsView` is not clipped by the renderer's DOM. A stale, negative, infinite or
 * over-large rectangle would therefore either make `setBounds` throw or let the page cover app
 * chrome outside the preview hole. Work in edges so clipping a rectangle that starts off-screen
 * also reduces its width rather than moving the whole page.
 */
export function boundedPreviewRectangle(
  bounds: PreviewRectangle | null,
  viewport: { width: number; height: number }
): PreviewRectangle | null {
  if (!bounds) return null;
  const values = [bounds.x, bounds.y, bounds.width, bounds.height, viewport.width, viewport.height];
  if (
    !values.every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }

  const left = Math.max(0, Math.min(viewport.width, Math.round(bounds.x)));
  const top = Math.max(0, Math.min(viewport.height, Math.round(bounds.y)));
  const right = Math.max(left, Math.min(viewport.width, Math.round(bounds.x + bounds.width)));
  const bottom = Math.max(top, Math.min(viewport.height, Math.round(bounds.y + bounds.height)));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A URL the Preview pane may load, or a refusal saying why not.
 *
 * Only http and https. The pane is a real browser engine inside the application, and a `file://`
 * URL in it would read the disk from outside every workspace boundary the tools enforce; a
 * `data:` URL would run whatever script was written into it.
 */
export function previewableUrl(value: string): string {
  if (value.length > 4096) throw new Error('The preview address is too long.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `"${value}" is not a URL. Give a whole one, such as http://localhost:5173 — a bare path has no host to fetch it from.`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Preview only opens http and https pages, not ${parsed.protocol.replace(':', '')}.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Preview does not accept usernames or passwords embedded in an address.');
  }
  return parsed.toString();
}

/**
 * The argument carrying "Antimatter owns this window", set by prepareTool and never by a model.
 *
 * A screen capture is put to the person on every call because a display, or a window picked out
 * by a substring a model chose, can hold anything — the mail client, the password manager. That
 * is worth an interruption. What is not is a capture of Antimatter's own window, which holds only
 * what Antimatter is already showing, and which a validation loop takes over and over.
 *
 * The difference between the two is provenance, and a title match is not provenance: a model can
 * name any substring. This carries the one fact that is provenance — that the window selected for
 * capture is one of this process's own — resolved from Electron and stamped on the arguments
 * before policy sees them. It is a reserved name: whatever a model puts here is discarded.
 */
export const OWNED_WINDOW_ARG = 'window_owned_by_antimatter';

/**
 * Whether a capture source is one of this process's windows.
 *
 * Electron gives a `BrowserWindow` its capture identity as `window:<handle>:<n>`, and
 * desktopCapturer names the same window the same way — but the trailing field has differed
 * across platforms and versions, so both sides are reduced to the handle that identifies the
 * window itself before they are compared.
 */
export const isOwnedCaptureSource = (sourceId: string, ownedIds: readonly string[]): boolean => {
  const handle = captureHandle(sourceId);
  if (!handle) return false;
  return ownedIds.some((owned) => captureHandle(owned) === handle);
};

/** `window:12345:0` → `12345`. Null for a display, an empty id, or anything unrecognised. */
export function captureHandle(sourceId: string): string | null {
  const match = /^window:([^:]+)/.exec(sourceId.trim());
  return match ? match[1] : null;
};
