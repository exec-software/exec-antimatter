import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clip, num, str, type ToolDef } from '../types';
import { display, insideWorkspace, workspaceRoot } from '../workspace';

/**
 * Image output for models that cannot emit an encoded image.
 *
 * A language model cannot produce PNG or JPEG bytes: both are compressed streams with
 * checksums, so every byte depends on global state the decoder re-derives. These tools take
 * the part a model *can* produce — plain pixel values, or SVG text — and do the encoding here.
 */

/** 4096² truecolour is already 50 MB of scanlines; past that a mistake stops being recoverable. */
const MAX_EDGE = 4096;
const MAX_PIXELS = 4_000_000;

/** Enough names to describe a diagram without the model guessing hex. */
const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
  gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], maroon: [128, 0, 0],
  olive: [128, 128, 0], navy: [0, 0, 128], purple: [128, 0, 128], teal: [0, 128, 128],
  orange: [255, 165, 0], transparent: [255, 255, 255],
};

/** Accepts `#rgb`, `#rrggbb`, bare hex, or a name from the table above. */
function colour(raw: unknown, where: string): [number, number, number] {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text in NAMED) return NAMED[text];
  const hex = text.startsWith('#') ? text.slice(1) : text;
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16)) as [number, number, number];
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  throw new Error(
    `${where}: "${raw}" is not a colour. Use #rrggbb, #rgb, or one of: ${Object.keys(NAMED).join(', ')}.`,
  );
}

function checkedSize(args: Record<string, any>): { width: number; height: number } {
  const width = Number(args.width);
  const height = Number(args.height);
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a whole number of at least 1, got ${JSON.stringify(args[name])}.`);
    }
    if (value > MAX_EDGE) throw new Error(`${name} ${value} exceeds the ${MAX_EDGE} pixel limit.`);
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`${width}x${height} is ${width * height} pixels; the limit is ${MAX_PIXELS}.`);
  }
  return { width, height };
}

/**
 * Reads the three supported spellings of a pixel grid into one RGB buffer.
 *
 * Every failure names the index it failed at and how many values it expected. A model that
 * gets "expected 3072 values, received 3069" can fix the row it truncated; "invalid input"
 * leaves it guessing, and a guess costs another whole generation.
 */
function readPixels(args: Record<string, any>, width: number, height: number): Buffer {
  // A palette is only meaningful for the indexed grid, so its presence settles the format when
  // the caller did not state one. Without this, a palette plus a character grid parses as "rgb"
  // and the channel-count error sends the caller away from the approach it already had right.
  const format = String(args.format ?? (args.palette ? 'indexed' : 'rgb')).toLowerCase();
  const count = width * height;
  const rgb = Buffer.alloc(count * 3);

  if (format === 'indexed') {
    const palette = args.palette;
    if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
      throw new Error('format "indexed" needs a palette object mapping each key character to a colour.');
    }
    const table = new Map<string, [number, number, number]>();
    for (const [key, value] of Object.entries(palette as Record<string, unknown>)) {
      if ([...key].length !== 1) {
        throw new Error(`palette key "${key}" must be exactly one character.`);
      }
      table.set(key, colour(value, `palette["${key}"]`));
    }
    const rows = Array.isArray(args.pixels)
      ? (args.pixels as unknown[]).map(String)
      : String(args.pixels ?? '').split('\n');
    // A grid is often written as nested JSON — `[[IIII…], [IIII…]]`. Punctuation and spacing are
    // dropped, but only where the palette has not declared that character as a cell, so a palette
    // remains free to use a bracket or a comma as a key.
    const STRUCTURAL = new Set([...'[](){}," \'', '\t', '\r']);
    const clean = (row: string) =>
      [...row].filter((character) => table.has(character) || !STRUCTURAL.has(character)).join('');
    const grid = rows.map(clean).filter((row) => row.length > 0);
    if (grid.length !== height) {
      throw new Error(`format "indexed" expected ${height} rows for height ${height}, received ${grid.length}.`);
    }
    for (let y = 0; y < height; y++) {
      const cells = [...grid[y]];
      if (cells.length !== width) {
        throw new Error(`row ${y + 1} has ${cells.length} characters, expected ${width} for width ${width}.`);
      }
      for (let x = 0; x < width; x++) {
        const entry = table.get(cells[x]);
        if (!entry) throw new Error(`row ${y + 1}, column ${x + 1}: "${cells[x]}" is not a palette key.`);
        rgb.set(entry, (y * width + x) * 3);
      }
    }
    return rgb;
  }

  const tokens = (Array.isArray(args.pixels) ? (args.pixels as unknown[]).map(String).join(' ') : String(args.pixels ?? ''))
    .trim()
    .split(/[\s,]+/)
    .filter((token) => token.length > 0);
  if (!tokens.length) throw new Error('pixels is empty.');

  if (format === 'hex') {
    if (tokens.length !== count) {
      throw new Error(`format "hex" expected ${count} colours for ${width}x${height}, received ${tokens.length}.`);
    }
    tokens.forEach((token, index) => rgb.set(colour(token, `pixel ${index + 1}`), index * 3));
    return rgb;
  }

  if (format !== 'rgb') {
    throw new Error(`format must be "rgb", "hex", or "indexed", got "${format}".`);
  }
  // A P3 body may carry its own header; accept and verify it rather than rejecting the
  // most natural thing for a model that has been taught Netpbm.
  let values = tokens;
  if (values[0]?.toUpperCase() === 'P3') {
    const declared = values.slice(1, 4).map(Number);
    if (declared[0] !== width || declared[1] !== height) {
      throw new Error(
        `the P3 header declares ${declared[0]}x${declared[1]} but width/height say ${width}x${height}.`,
      );
    }
    values = values.slice(4);
  }
  if (values.length !== count * 3) {
    // A count alone does not say what was misunderstood, and the usual mistakes are specific:
    // one value per pixel, four channels, or a palette that was meant to select indexed mode.
    const hint =
      values.length === count
        ? ' That is one value per pixel; "rgb" wants three — red, green and blue — for each.' +
          ' For one token per pixel use format "hex", or "indexed" with a palette.'
        : values.length === count * 4
          ? ' That is four channels per pixel; this tool writes RGB, so supply three and drop alpha.'
          : args.palette
            ? ' A palette was supplied: set format to "indexed" to use it with a grid of key characters.'
            : '';
    throw new Error(
      `format "rgb" expected ${count * 3} values (${count} pixels x 3 channels) for ${width}x${height}, received ${values.length}.${hint}`,
    );
  }
  for (let index = 0; index < values.length; index++) {
    const value = Number(values[index]);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`value ${index + 1} is "${values[index]}"; every channel must be a whole number 0-255.`);
    }
    rgb[index] = value;
  }
  return rgb;
}

/** CRC-32 as PNG specifies it. Table built once; the polynomial is the standard 0xEDB88320. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Truecolour, 8 bits per channel, no interlacing, filter 0 on every scanline. */
function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1);
    raw[start] = 0;
    rgb.copy(raw, start + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeInto(path: unknown, bytes: Buffer | string, extension: string): string {
  const root = workspaceRoot();
  let requested = String(path ?? '').trim();
  if (!requested) throw new Error('path is required, relative to the workspace.');
  if (!requested.toLowerCase().endsWith(extension)) requested += extension;
  const target = insideWorkspace(root, requested);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return display(root, target);
}

export const imageTools: ToolDef[] = [
  {
    name: 'image_from_pixels',
    description:
      'Write a PNG from pixel values you supply. You provide the grid; this tool does the PNG ' +
      'encoding, so you never have to produce compressed bytes. Three spellings of the grid: ' +
      '"rgb" is whitespace-separated channel values, three per pixel, left-to-right then ' +
      'top-to-bottom (a Netpbm P3 body, with or without its "P3 width height 255" header). ' +
      '"hex" is one colour token per pixel. "indexed" is one line of single-character keys per ' +
      'row plus a palette, which is by far the fewest tokens for flat-coloured images. Supplying a ' +
      'palette selects "indexed" on its own, and a grid written as nested JSON arrays is accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Output file, relative to the workspace. ".png" is appended if missing.'),
        width: num('Image width in pixels.'),
        height: num('Image height in pixels.'),
        format: str('How "pixels" is spelled: "rgb" (default), "hex", or "indexed".'),
        pixels: {
          description:
            'The grid. A string, or an array of strings which is joined (for "indexed", one array entry per row).',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        palette: {
          type: 'object',
          description: 'For "indexed": each single-character key mapped to #rrggbb or a colour name.',
        },
      },
      required: ['path', 'width', 'height', 'pixels'],
    },
    async run(args) {
      const { width, height } = checkedSize(args);
      const rgb = readPixels(args, width, height);
      const png = encodePng(rgb, width, height);
      const shown = writeInto(args.path, png, '.png');
      const distinct = new Set<string>();
      for (let index = 0; index < rgb.length && distinct.size <= 64; index += 3) {
        distinct.add(`${rgb[index]},${rgb[index + 1]},${rgb[index + 2]}`);
      }
      return clip(
        `Wrote ${shown} — ${width}x${height} PNG, ${png.length} bytes, ` +
          `${distinct.size > 64 ? 'more than 64' : distinct.size} distinct colours.`,
      );
    },
  },

  {
    name: 'image_from_svg',
    description:
      'Write an SVG file from markup you supply. Use this for shapes, charts and diagrams, where ' +
      'describing the drawing is far fewer tokens than enumerating pixels. Saved as-is, not rasterised.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Output file, relative to the workspace. ".svg" is appended if missing.'),
        svg: str('Complete SVG markup, starting with <svg …> and ending with </svg>.'),
      },
      required: ['path', 'svg'],
    },
    async run(args) {
      const markup = String(args.svg ?? '').trim();
      if (!markup) throw new Error('svg is empty.');
      if (!/^<(\?xml|svg)\b/i.test(markup)) {
        throw new Error('svg must begin with "<svg" (or an <?xml …?> declaration followed by <svg>).');
      }
      if (!/<\/svg>\s*$/i.test(markup)) throw new Error('svg must end with "</svg>".');
      const shown = writeInto(args.path, markup, '.svg');
      return clip(`Wrote ${shown} — ${Buffer.byteLength(markup)} bytes of SVG.`);
    },
  },
];
