import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { CREATE_ONLY_TOOL_ARGUMENT } from '../../src/api/toolArguments';
import { bool, clip, num, str, type ToolDef } from '../types';
import { display, insideWorkspace, looksBinary, walkFiles } from '../workspace';

const MAX_READ_BYTES = 2 * 1024 * 1024;

/**
 * Source files in which a prose stand-in can turn a large rewrite into a plausible-looking,
 * compilable truncation. Documentation and tests are deliberately outside this guard: examples
 * commonly discuss these phrases, and a TODO is not by itself evidence that content was lost.
 */
const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.svelte',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
]);

const OMITTED_IMPLEMENTATION = [
  /\b(?:rest|remainder)\s+of\s+(?:the\s+)?(?:file|code|component|implementation)\s+(?:(?:is|remains)\s+)?(?:unchanged|omitted)\b/gi,
  /\b(?:code|implementation)\s+(?:is\s+)?omitted\s+for\s+brevity\b/gi,
  /\b(?:insert|paste)\s+(?:the\s+)?(?:rest|remaining|existing)\s+(?:of\s+the\s+)?(?:code|implementation|file)\s+here\b/gi,
  /\b(?:same|existing)\s+(?:code|implementation)\s+as\s+(?:before|above)\b/gi,
];

const lineCount = (content: string): number => content.split('\n').length;

function guardedSource(target: string): boolean {
  const normalized = target.replace(/\\/g, '/').toLowerCase();
  if (/\/(?:test|tests|__tests__)\//.test(normalized) || /\.(?:test|spec)\.[^.]+$/.test(normalized)) return false;
  return SOURCE_EXTENSIONS.has(extname(normalized));
}

const omissionMarkers = (content: string): string[] =>
  OMITTED_IMPLEMENTATION.flatMap((pattern) =>
    [...content.matchAll(pattern)].map((match) => match[0].toLowerCase().replace(/\s+/g, ' '))
  );

function introducesOmission(before: string, after: string): boolean {
  const available = new Map<string, number>();
  for (const marker of omissionMarkers(before)) available.set(marker, (available.get(marker) ?? 0) + 1);
  for (const marker of omissionMarkers(after)) {
    const count = available.get(marker) ?? 0;
    if (!count) return true;
    available.set(marker, count - 1);
  }
  return false;
}

function destructivelyShrank(before: string, after: string): boolean {
  const lostCharacters = before.length - after.length;
  const beforeLines = lineCount(before);
  const afterLines = lineCount(after);
  return (
    (before.length >= 4_096 && lostCharacters >= 2_048 && after.length * 2 < before.length) ||
    (beforeLines >= 200 && beforeLines - afterLines >= 100 && afterLines * 2 < beforeLines)
  );
}

/**
 * Rejects only the high-confidence combination seen in failed model rewrites: most of an existing
 * source file disappeared and a new prose marker says that the missing implementation is still
 * elsewhere. Ordinary refactors, small edits, existing markers, tests, and documentation pass.
 */
function refuseOmittedRewrite(target: string, before: string | null, after: string): void {
  if (!before || !guardedSource(target) || !destructivelyShrank(before, after)) return;
  if (!introducesOmission(before, after)) return;
  throw new Error(
    `Refused a destructive rewrite of ${basename(target)}: it removed most of an existing source file ` +
      'and introduced a placeholder saying implementation was omitted. The existing file was left unchanged; ' +
      'write the complete replacement or make smaller exact edits.'
  );
}

/**
 * The edits an agent writes must not be lost or half-applied when the app restarts over them —
 * developing Antimatter from inside Antimatter means a write to the app's own source (say
 * `src/main/index.ts`) triggers a dev reload in the middle of the tool call that made it. Three
 * properties make that safe:
 *
 *  - The new content is written to a hidden directory at the workspace root, never beside the
 *    target. Nothing that watches the tree — the app's dev build, the file picker — ever sees a
 *    partial file next to the real one.
 *  - The bytes are flushed to disk before the rename, and the rename is flushed before the tool
 *    answers. After the process dies at any moment, the path holds either the old file whole or
 *    the new file whole, never a mixture.
 *  - Every write runs one at a time in this process. An append or edit is a read-modify-write,
 *    and two of those racing would drop content even when each individual write is atomic.
 */

/** How many writes are in flight, so the server can defer a shutdown signal until they have answered. */
let activeWrites = 0;

/** Whether a write is mid-flight (fs write done, reply about to be sent). The server defers exit on it. */
export const activeWriteCount = (): number => activeWrites;

/** One mutex for every file mutation, so concurrent read-modify-writes never interleave. */
let writeTail: Promise<void> = Promise.resolve();

function runWriting<T>(task: () => T): Promise<T> {
  const run = writeTail.then(
    () => {
      activeWrites += 1;
      try {
        return task();
      } finally {
        activeWrites -= 1;
      }
    },
    () => {
      activeWrites += 1;
      try {
        return task();
      } finally {
        activeWrites -= 1;
      }
    }
  );
  writeTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Directory entry is durable only once the rename into it has been flushed too. */
function fsyncDir(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Some platforms and filesystems cannot open or fsync a directory handle; the file's own
    // fsync already happened, and the rename is the durable step this is merely complementing.
    if (code !== 'EISDIR' && code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/**
 * The hidden per-workspace directory the durable write stages into. It must be a real directory:
 * a symlink planted at this name would send every staged write outside the workspace, and the
 * write's own `insideWorkspace` check would never see it because the staging path is built here.
 */
function stagingDir(workspace: string): string {
  const directory = join(workspace, '.antimatter-tmp');
  try {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Refused: the workspace staging directory is not a real directory.');
    }
    return directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * Writes beside the destination, into a hidden per-workspace temp directory, using an
 * unpredictable, exclusively-created file, fsynced before rename and renamed before answering.
 * A fixed `target.tmp` beside the target would let a workspace symlink that name outside the
 * workspace and turn an otherwise confined write into an overwrite elsewhere before rename()
 * ever runs; a temp dotfile beside the target would also be visible to a dev watcher that scans
 * the directory — that visibility is exactly what races an agent's own edit and the reload it
 * triggers.
 */
function durableWriteText(workspace: string, target: string, content: string, createOnly = false): void {
  const temporary = join(stagingDir(workspace), `.${basename(target)}.${randomUUID()}.antimatter.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o666
    );
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (createOnly) {
      try {
        // link(2) is the portable no-replace publish primitive available in Node: the target name
        // appears atomically only if it is still absent, and it points at the already-fsynced
        // inode. A separate exists check followed by rename would simply recreate the race.
        linkSync(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(
            `Refused the create-only write to ${display(workspace, target)}: the path appeared after the cut-off call was inspected. ` +
              'The existing file was left unchanged.'
          );
        }
        throw error;
      }
    } else {
      renameSync(temporary, target);
    }
    fsyncDir(dirname(target));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Turns a glob-ish pattern into a regex over the workspace-relative path:
 * `*` stays within one segment, `**` crosses directories, `?` is a single character.
 * The globstar is swapped for a plain-ASCII token first so escaping cannot mangle it.
 */
const patternToRegex = (pattern: string): RegExp => {
  const GLOBSTAR = '__ANTIMATTER_GLOBSTAR__';
  const tokenized = pattern.replace(/\*\*\//g, GLOBSTAR);
  const escaped = tokenized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const expanded = escaped
    .split(GLOBSTAR)
    .join('(?:.*/)?')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${expanded}$`, 'i');
};

const entryExists = (target: string): boolean => {
  try {
    statSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const readText = (target: string): string => {
  const size = statSync(target).size;
  if (size > MAX_READ_BYTES) throw new Error(`File is ${size} bytes; too large to read (limit ${MAX_READ_BYTES}).`);
  const content = readFileSync(target, 'utf8');
  if (looksBinary(content)) throw new Error('File appears to be binary, not text.');
  return content;
};

export const fileTools: ToolDef[] = [
  {
    name: 'workspace_info',
    description: 'Describe the current workspace: its path and the entries at its top level.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, { workspace }) {
      const entries = readdirSync(workspace, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.'))
        .slice(0, 100)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();
      return `workspace: ${workspace}\n\ntop level:\n${entries.join('\n') || '(empty)'}`;
    },
  },

  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. Optionally read a line range.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Path relative to the workspace root.'),
        start_line: num('First line to return, 1-based. Omit to start at the beginning.'),
        end_line: num('Last line to return, inclusive. Omit to read to the end.'),
      },
      required: ['path'],
    },
    async run(args, { workspace }) {
      const target = insideWorkspace(workspace, args.path);
      const content = readText(target);
      if (!args.start_line && !args.end_line) return clip(content);

      const lines = content.split('\n');
      const start = Math.max(1, Number(args.start_line) || 1);
      const end = Math.min(lines.length, Number(args.end_line) || lines.length);
      const slice = lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`);
      return clip(slice.join('\n'));
    },
  },

  {
    name: 'write_file',
    description:
      'Create or overwrite a text file in the workspace. Parent directories are created. A reply has an output limit, so write a large file in parts: the first call creates it, and each later call adds the next part with append. Give path and append before content: if a new-file or append call is cut off partway through content, its complete lines can still be saved. A cut-off replacement never overwrites an existing file.',
    inputSchema: {
      type: 'object',
      // append comes before content: models write keys in this order, and a call cut off inside
      // its content has then already said whether it was adding to the file or replacing it.
      properties: {
        path: str('Path relative to the workspace root.'),
        append: bool('Add content to the end of the file instead of replacing it. The file is created if it does not exist.'),
        content: str('Full file contents to write, or the next part when appending.'),
      },
      required: ['path', 'content'],
    },
    async run(args, { workspace }) {
      return runWriting(() => {
        const target = insideWorkspace(workspace, args.path);
        const content = String(args.content ?? '');
        const createOnly = args[CREATE_ONLY_TOOL_ARGUMENT] === true;
        mkdirSync(dirname(target), { recursive: true });
        // Appending rewrites the whole file too, so a write cut short never leaves half a part.
        // A plain overwrite of a non-source file does not need its old (possibly very large)
        // contents. Source rewrites do, because the omission guard compares old and new text.
        const existing =
          entryExists(target) && (args.append === true || guardedSource(target)) ? readText(target) : null;
        const before = args.append === true ? existing : null;
        const updated = before === null ? content : `${before}${content}`;
        refuseOmittedRewrite(target, existing, updated);
        // A write that a reload could otherwise interrupt is flushed before it appears in place.
        durableWriteText(workspace, target, updated, createOnly);
        return before === null
          ? `Wrote ${content.length} characters to ${display(workspace, target)}.`
          : `Appended ${content.length} characters to ${display(workspace, target)}, which now holds ${before.length + content.length}.`;
      });
    },
  },

  {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. The old string must appear exactly once unless replace_all is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Path relative to the workspace root.'),
        old_string: str('Exact text to replace, including indentation.'),
        new_string: str('Replacement text.'),
        replace_all: bool('Replace every occurrence instead of requiring exactly one.'),
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async run(args, { workspace }) {
      return runWriting(() => {
        const target = insideWorkspace(workspace, args.path);
        const content = readText(target);
        const oldString = String(args.old_string);
        const newString = String(args.new_string);

        const occurrences = content.split(oldString).length - 1;
        if (occurrences === 0) throw new Error('The old_string was not found in the file.');
        if (occurrences > 1 && !args.replace_all) {
          throw new Error(`The old_string appears ${occurrences} times. Add more context, or set replace_all.`);
        }

        const updated = args.replace_all ? content.split(oldString).join(newString) : content.replace(oldString, newString);
        refuseOmittedRewrite(target, content, updated);
        durableWriteText(workspace, target, updated);
        return `Replaced ${args.replace_all ? occurrences : 1} occurrence(s) in ${display(workspace, target)}.`;
      });
    },
  },

  {
    name: 'list_directory',
    description: 'List the entries of one directory in the workspace.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Directory relative to the workspace root. Defaults to the root.') },
    },
    async run(args, { workspace }) {
      const target = insideWorkspace(workspace, args.path ?? '.');
      const entries = readdirSync(target, { withFileTypes: true }).map((entry) => {
        if (entry.isDirectory()) return `${entry.name}/`;
        try {
          return `${entry.name}\t${statSync(join(target, entry.name)).size} bytes`;
        } catch {
          return entry.name;
        }
      });
      return clip(`${display(workspace, target)}:\n${entries.sort().join('\n') || '(empty)'}`);
    },
  },

  {
    name: 'find_files',
    description: 'Find files by name pattern, for example "*.ts" or "src/**/*.tsx".',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: str('Glob-style pattern matched against workspace-relative paths.'),
        limit: num('Maximum number of paths to return. Default 200.'),
      },
      required: ['pattern'],
    },
    async run(args, { workspace }) {
      const regex = patternToRegex(String(args.pattern));
      const limit = Math.min(Number(args.limit) || 200, 1000);
      const found: string[] = [];

      for (const file of walkFiles(workspace)) {
        const relativePath = display(workspace, file);
        const baseName = relativePath.split('/').pop() ?? '';
        if (regex.test(relativePath) || regex.test(baseName)) {
          found.push(relativePath);
          if (found.length >= limit) break;
        }
      }
      return found.length ? clip(found.join('\n')) : `No files matched ${args.pattern}.`;
    },
  },

  {
    name: 'search_text',
    description: 'Search file contents for a regular expression and return matching lines with their paths.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Regular expression to search for.'),
        path: str('Limit the search to this subdirectory.'),
        ignore_case: bool('Match case-insensitively. Default true.'),
        limit: num('Maximum number of matching lines. Default 100.'),
      },
      required: ['query'],
    },
    async run(args, { workspace }) {
      const root = insideWorkspace(workspace, args.path ?? '.');
      const flags = args.ignore_case === false ? '' : 'i';
      const regex = new RegExp(String(args.query), flags);
      const limit = Math.min(Number(args.limit) || 100, 500);
      const hits: string[] = [];

      for (const file of walkFiles(root, { maxFileBytes: 1024 * 1024 })) {
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (looksBinary(content)) continue;

        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (!regex.test(lines[index])) continue;
          hits.push(`${display(workspace, file)}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
          if (hits.length >= limit) return clip(hits.join('\n'));
        }
      }
      return hits.length ? clip(hits.join('\n')) : `No matches for ${args.query}.`;
    },
  },

  {
    name: 'file_info',
    description: 'Report size, modification time, and line count for one file.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Path relative to the workspace root.') },
      required: ['path'],
    },
    async run(args, { workspace }) {
      const target = insideWorkspace(workspace, args.path);
      const stats = statSync(target);
      const details = [
        `path: ${display(workspace, target)}`,
        `type: ${stats.isDirectory() ? 'directory' : 'file'}`,
        `size: ${stats.size} bytes`,
        `modified: ${stats.mtime.toISOString()}`,
      ];
      if (stats.isFile() && stats.size <= MAX_READ_BYTES) {
        try {
          const content = readFileSync(target, 'utf8');
          details.push(looksBinary(content) ? 'content: binary' : `lines: ${content.split('\n').length}`);
        } catch {
          // Unreadable as text; the stat details above are still useful.
        }
      }
      return details.join('\n');
    },
  },
];
