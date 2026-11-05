import { BrowserWindow, desktopCapturer, nativeImage, screen, type NativeImage } from 'electron';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { boundedDimensions, boundedEncodedImageDimensions } from './imageDimensions';
import {
  captureSourceTypes,
  isOwnedCaptureSource,
  mediaTypeOf,
  publishesNoWindowTitles,
  READABLE_IMAGES,
  uniqueNamedCaptureSource,
} from './targets';
import { insideWorkspace } from '../../../mcp/workspace';

/**
 * Pictures: taking them, reading them, and shrinking them for whoever is going to look.
 *
 * Screenshots come from Electron's own desktopCapturer rather than a command-line tool. That is
 * not a preference — this machine has `xwd` and nothing else, and a packaged Antimatter cannot
 * assume even that. The capturer is already in the process, works the same on every platform we
 * ship to, and returns pixels instead of a file in a format from 1986.
 */

/**
 * The long edge a screenshot is scaled to before the seeing model gets it.
 *
 * A 1080p window passes through untouched, which is the common case and the one where reading a
 * label correctly matters. Above that the cost is real — every extra pixel is prompt the model
 * has to process before it says anything — and a 4K screenshot halved is still sharper than the
 * question being asked of it.
 */
export const LOOK_LONG_EDGE = 1920;

/** The long edge of the copy that goes in the transcript, where it is a thumbnail people click. */
export const INLINE_LONG_EDGE = 900;

/** Beyond this a file is not a screenshot, and turning it into base64 would cost more than it is worth. */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** A 1920×1920 RGBA image is under 15 MiB; leave headroom for encoder overhead, not metadata. */
export const MAX_RENDERED_IMAGE_BYTES = 24 * 1024 * 1024;

export interface LoadedImage {
  bytes: Buffer;
  mediaType: string;
  width: number;
  height: number;
  /** Main-process-only decoded pixels, retained so fitting does not decode the same 40 MP twice. */
  native: NativeImage;
}

/**
 * Opens and reads the same regular file descriptor, then proves its inode still belongs to the
 * workspace. This closes both ordinary symlink substitution and the stat/read growth race.
 */
function readWorkspaceFile(path: string, workspace: string): Buffer {
  // Refuse an out-of-root name before opening it, then re-prove the opened inode below so a
  // symlink or parent-directory swap between these operations cannot change the decision.
  insideWorkspace(workspace, path);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${path} is not a regular image file.`);
    if (before.size === 0) throw new Error(`${path} is empty.`);
    if (before.size > MAX_IMAGE_BYTES) {
      throw new Error(`${path} is ${Math.round(before.size / 1e6)} MB, which is too large to look at.`);
    }

    const realTarget = realpathSync(path);
    insideWorkspace(workspace, realTarget);
    const named = statSync(realTarget);
    if (named.dev !== before.dev || named.ino !== before.ino) {
      throw new Error(`${path} changed while it was being opened; try again.`);
    }

    // Allocate from the trusted pre-read size plus one sentinel byte, never from a later size.
    // If the file grows, the sentinel proves it without allowing readFileSync to keep allocating.
    const bounded = Buffer.allocUnsafe(Number(before.size) + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const read = readSync(descriptor, bounded, offset, bounded.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > before.size) {
      throw new Error(`${path} changed while it was being read; try again.`);
    }
    const bytes = bounded.subarray(0, offset);
    const after = fstatSync(descriptor);
    // Recheck the descriptor after the bounded read and reject a moving target rather than
    // handing a torn image to a native decoder.
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`${path} is ${Math.round(bytes.length / 1e6)} MB, which is too large to look at.`);
    }
    if (bytes.length === 0) throw new Error(`${path} is empty.`);
    if (
      before.size !== after.size ||
      after.size !== bytes.length ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`${path} changed while it was being read; try again.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** Reads an image file, or says why it is not one. The path is rebound to its workspace here. */
export function loadImage(path: string, workspace: string): LoadedImage {
  const bytes = readWorkspaceFile(path, workspace);
  const mediaType = mediaTypeOf(bytes);
  if (!mediaType) {
    throw new Error(`${path} is not an image Antimatter can read — ${READABLE_IMAGES} are.`);
  }

  // Header inspection happens before nativeImage is allowed to allocate decoded pixels. The
  // compressed byte ceiling above does not protect against a tiny decompression bomb.
  boundedEncodedImageDimensions(bytes, mediaType);

  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error(`${path} is a ${mediaType} file that could not be decoded.`);
  const { width, height } = image.getSize();
  boundedDimensions(width, height);
  return { bytes, mediaType, width, height, native: image };
}

/**
 * The same picture, no larger than `longEdge` on its longest side, as PNG.
 *
 * Scaling up never happens: a 400px screenshot asked to fit 1920 comes back as itself, because
 * inventing pixels only costs the model time.
 */
export function fit(
  loaded: LoadedImage,
  longEdge: number
): { bytes: Buffer; mediaType: string; width: number; height: number } {
  const { native: image, width, height } = loaded;
  const longest = Math.max(width, height);
  const resized =
    longest <= longEdge
      ? image
      : image.resize({
          width: Math.max(1, Math.round(width * (longEdge / longest))),
          height: Math.max(1, Math.round(height * (longEdge / longest))),
          quality: 'good',
        });
  const size = resized.getSize();
  const rendered = resized.toPNG();
  if (rendered.length > MAX_RENDERED_IMAGE_BYTES) {
    throw new Error('The rendered preview is too large to send to the interface safely.');
  }
  // Always encode a fresh PNG, even when no resize was needed. This strips arbitrarily large
  // metadata and animation payloads before base64 expands the bytes across IPC.
  return { bytes: rendered, mediaType: 'image/png', width: size.width, height: size.height };
}

/** What the renderer puts in an <img src>. */
export const dataUrl = (bytes: Buffer, mediaType: string): string =>
  `data:${mediaType};base64,${bytes.toString('base64')}`;

export interface CaptureTarget {
  /** Part of a window's title, matched case-insensitively. Absent captures one display. */
  window?: string;
}

export interface Capture {
  bytes: Buffer;
  width: number;
  height: number;
  /** The window title, or the display, that was actually captured. */
  name: string;
}

/** The pixel size the capturer is asked for, so a returned thumbnail is the real thing. */
function fullSize(): { width: number; height: number } {
  const displays = screen.getAllDisplays();
  const width = Math.max(1280, ...displays.map((display) => display.size.width * display.scaleFactor));
  const height = Math.max(800, ...displays.map((display) => display.size.height * display.scaleFactor));
  return { width: Math.round(width), height: Math.round(height) };
}

const asBuffer = (image: NativeImage): Buffer => image.toPNG();

/**
 * A picture of a window, or of the screen.
 *
 * `desktopCapturer` returns a thumbnail per source, and the thumbnail is the capture: asked for
 * the display's own size it hands back the real pixels. Sources are matched on title rather than
 * id because the caller is a model that has just launched a program and knows what it called it,
 * not an opaque id it has never seen.
 */
export async function capture(target: CaptureTarget = {}): Promise<Capture> {
  const wanted = target.window?.trim().toLowerCase() ?? '';
  const sources = await desktopCapturer.getSources({
    types: captureSourceTypes(wanted),
    thumbnailSize: fullSize(),
    fetchWindowIcons: false,
  });

  if (!sources.length) {
    throw new Error(
      wanted
        ? 'The system returned no capturable windows.'
        : 'The system returned no capturable displays. Check screen-capture permissions and try again.'
    );
  }

  // Saying "no window matching X" to a session that publishes no titles invites the retry that
  // reads as obvious — name it better — and that retry fails identically, however exactly the model
  // named the window it can see on the display in front of it.
  if (wanted && publishesNoWindowTitles(sources)) {
    throw new Error(
      'This desktop session does not publish window titles, so no window can be captured by name. ' +
        'Take the screenshot with no window argument to photograph the display instead — the user is asked to approve that.'
    );
  }

  // Window titles can contain document names, account names and message text. Selection either
  // proves one title match or refuses without inventorying the other windows.
  const chosen = wanted ? uniqueNamedCaptureSource(sources, target.window?.trim() ?? '') : sources[0];

  if (chosen.thumbnail.isEmpty()) {
    throw new Error(wanted
      ? `"${chosen.name}" was captured as an empty image. A window that is minimised or on another ` +
          'workspace cannot be photographed; bring it to the front and try again.'
      : `The selected display, "${chosen.name}", returned an empty image. Check screen-capture permissions and try again.`);
  }

  const { width, height } = chosen.thumbnail.getSize();
  return { bytes: asBuffer(chosen.thumbnail), width, height, name: chosen.name };
}

/**
 * Whether the window a capture would select is one of Antimatter's own.
 *
 * Answered by resolving the name exactly as `capture` will, then comparing the chosen source
 * against this process's own windows — so the answer is about the window that would actually be
 * photographed, not about the string that named it. A model can call a window anything; it
 * cannot make one of ours out of somebody else's.
 *
 * False for every failure: no name, no match, an ambiguous match, or an error reaching the
 * window server. The caller treats false as "ask the person", which is the safe direction.
 */
export async function capturesOwnWindow(window: string | undefined): Promise<boolean> {
  const wanted = window?.trim();
  if (!wanted) return false;
  try {
    const owned = BrowserWindow.getAllWindows()
      .filter((candidate) => !candidate.isDestroyed())
      .map((candidate) => candidate.getMediaSourceId());
    if (!owned.length) return false;
    // No thumbnails: this resolves identity, and decoding every window's pixels to answer a
    // policy question would cost more than the capture it is deciding about.
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    return isOwnedCaptureSource(uniqueNamedCaptureSource(sources, wanted).id, owned);
  } catch {
    return false;
  }
}
