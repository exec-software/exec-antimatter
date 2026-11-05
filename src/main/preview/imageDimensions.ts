/**
 * Dimensions are inspected from the encoded container before Electron is allowed to decode it.
 * A small compressed file can otherwise expand into gigabytes of pixels in the main process.
 *
 * Electron only guarantees portable `nativeImage` decoding for PNG and JPEG, so this parser
 * intentionally mirrors that exact public surface.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

/** 8K screenshots fit; pathological canvases and decompression bombs do not. */
export const MAX_IMAGE_EDGE = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;

const malformed = (mediaType: string): never => {
  throw new Error(`The ${mediaType} image header is incomplete or malformed.`);
};

export function boundedDimensions(width: number, height: number): ImageDimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('The image has invalid dimensions.');
  }
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width > MAX_IMAGE_PIXELS / height) {
    throw new Error(
      `The image is ${width}×${height}, beyond the safe preview limit of ${MAX_IMAGE_EDGE}px per edge and ` +
        `${Math.round(MAX_IMAGE_PIXELS / 1_000_000)} megapixels.`
    );
  }
  return { width, height };
}

function pngDimensions(bytes: Buffer): ImageDimensions {
  if (bytes.length < 33 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR' || bytes.readUInt32BE(8) !== 13) {
    return malformed('PNG');
  }
  const canvas = boundedDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));

  // APNG frame controls carry their own dimensions. Bound every one rather than trusting only
  // the logical canvas before a decoder sees the file.
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const data = offset + 8;
    const end = data + length;
    if (!Number.isSafeInteger(end) || end + 4 > bytes.length) return malformed('PNG');
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    if (type === 'fcTL') {
      if (length !== 26) return malformed('PNG');
      const frame = boundedDimensions(bytes.readUInt32BE(data + 4), bytes.readUInt32BE(data + 8));
      const x = bytes.readUInt32BE(data + 12);
      const y = bytes.readUInt32BE(data + 16);
      if (x > canvas.width - frame.width || y > canvas.height - frame.height) return malformed('PNG');
    }
    offset = end + 4;
    if (type === 'IEND') return canvas;
  }
  return malformed('PNG');
}

const JPEG_SIZE_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Buffer): ImageDimensions {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return malformed('JPEG');
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return malformed('JPEG');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return malformed('JPEG');
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return malformed('JPEG');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return malformed('JPEG');
    if (JPEG_SIZE_MARKERS.has(marker)) {
      if (length < 7) return malformed('JPEG');
      // SOF stores sample precision, then height, then width.
      return boundedDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  return malformed('JPEG');
}

/** Reads and bounds dimensions without asking an image decoder to allocate the pixels first. */
export function boundedEncodedImageDimensions(bytes: Buffer, mediaType: string): ImageDimensions {
  switch (mediaType) {
    case 'image/png':
      return pngDimensions(bytes);
    case 'image/jpeg':
      return jpegDimensions(bytes);
    default:
      throw new Error(`Unsupported image type: ${mediaType}. Antimatter preview supports PNG and JPEG.`);
  }
}
