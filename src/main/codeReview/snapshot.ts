import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { reviewSnapshotLines, type ReviewFile, type ReviewScope } from '../../api/codeReview';

export const SNAPSHOT_LIMITS = { files: 80, fileBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024 };
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string): boolean => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

export function canonicalReviewWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || value.includes('\0')) {
    throw new Error('Choose an absolute workspace folder before starting a review.');
  }
  const path = realpathSync(value);
  if (!lstatSync(path).isDirectory()) throw new Error('The review workspace is not a folder.');
  return path;
}

export function reviewPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || isAbsolute(value) ||
      /[\x00-\x1f\x7f\\]/.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) {
    throw new Error('Review paths must be relative files inside the workspace.');
  }
  return value;
}

export function validateScope(value: unknown): ReviewScope {
  if (!value || typeof value !== 'object') throw new Error('Choose working changes or a file to review.');
  const scope = value as ReviewScope;
  if (scope.kind === 'changes') return { kind: 'changes' };
  if (scope.kind !== 'file') throw new Error('Unsupported review scope.');
  const path = reviewPath(scope.path);
  for (const line of [scope.startLine, scope.endLine]) {
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new Error('Review line numbers must be positive integers.');
  }
  if (scope.endLine !== undefined && scope.endLine < (scope.startLine ?? 1)) throw new Error('The review range ends before it starts.');
  return { kind: 'file', path, ...(scope.startLine === undefined ? {} : { startLine: scope.startLine }),
    ...(scope.endLine === undefined ? {} : { endLine: scope.endLine }) };
}

function sourceFile(workspace: string, path: string): { bytes: Buffer; mode: '100644' | '100755' } | null {
  const full = resolve(workspace, reviewPath(path));
  // A missing file reached through an escaped ancestor must not count as a safe deletion.
  let parent = dirname(full);
  while (parent !== workspace) {
    try {
      if (!inside(workspace, realpathSync(parent))) throw new Error(`${path}: the parent folder escapes the review workspace.`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      parent = dirname(parent);
    }
  }
  let stats;
  try { stats = lstatSync(full); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${path}: review snapshots support regular files, not symlinks or submodules.`);
  const canonical = realpathSync(full);
  if (!inside(workspace, canonical)) throw new Error(`${path}: the file escapes the review workspace.`);
  if (stats.size > SNAPSHOT_LIMITS.fileBytes) throw new Error(`${path}: exceeds the 512 KiB review file limit. Select a smaller file.`);
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino || realpathSync(full) !== canonical) {
      throw new Error(`${path}: changed while being captured; try again.`);
    }
    // On Linux, validate the opened descriptor too, not only the pathname before open.
    if (process.platform === 'linux' && !inside(workspace, realpathSync(`/proc/self/fd/${fd}`))) {
      throw new Error(`${path}: the opened file escapes the review workspace.`);
    }
    const buffer = Buffer.allocUnsafe(SNAPSHOT_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd);
    if (bytes.length > SNAPSHOT_LIMITS.fileBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs || realpathSync(full) !== canonical) throw new Error(`${path}: changed while being captured; try again.`);
    return { bytes, mode: opened.mode & 0o100 ? '100755' : '100644' };
  } finally { closeSync(fd); }
}

function decode(bytes: Buffer, path: string): string {
  if (bytes.includes(0)) throw new Error(`${path}: binary files cannot be reviewed yet. Select supported text files instead.`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${path}: the file is not UTF-8 text. Select supported text files instead.`); }
}

function git(workspace: string, args: string[], maxBuffer = SNAPSHOT_LIMITS.totalBytes + 4096): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' });
  return new Promise((resolveResult, reject) => {
    execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=',
      '-c', 'core.untrackedCache=false', ...args], { cwd: workspace, env, encoding: 'buffer', maxBuffer, timeout: 15_000 },
    (error, stdout) => error ? reject(error) : resolveResult(stdout));
  });
}

/** Captures immutable text; it never stages, checks out, or writes workspace content. */
export async function captureReviewSnapshot(workspace: string, input: ReviewScope): Promise<ReviewFile[]> {
  const scope = validateScope(input);
  if (canonicalReviewWorkspace(workspace) !== workspace) throw new Error('The review workspace changed location. Reopen the workspace.');
  if (scope.kind === 'file') {
    const captured = sourceFile(workspace, scope.path);
    if (!captured) throw new Error(`${scope.path}: the selected file is missing.`);
    const full = decode(captured.bytes, scope.path);
    const lines = reviewSnapshotLines(full);
    const hasRange = scope.startLine !== undefined || scope.endLine !== undefined;
    const startLine = scope.startLine ?? 1;
    const endLine = scope.endLine ?? lines.length;
    if (hasRange && (startLine > lines.length || endLine > lines.length)) throw new Error('The selected review range is outside the file.');
    // Include the original terminator so a selected blank final line remains visible and anchorable.
    const after = !hasRange || startLine === 1 && endLine === lines.length ? full
      : lines.slice(startLine - 1, endLine).join('\n') + (endLine < lines.length || full.endsWith('\n') ? '\n' : '');
    return [{ path: scope.path, status: 'selected', before: null,
      after,
      beforeStartLine: 1, startLine, afterMode: captured.mode, fingerprint: hash(captured.bytes) }];
  }
  let root: string;
  try { root = realpathSync((await git(workspace, ['rev-parse', '--show-toplevel'])).toString('utf8').trim()); }
  catch { throw new Error('Working changes require a Git repository. Select a file or initialize Git first.'); }
  if (!inside(root, workspace)) throw new Error('The Git repository does not contain this workspace.');
  const prefix = relative(root, workspace).split(sep).join('/');
  let head: string | null = null;
  try { head = (await git(workspace, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toString('utf8').trim(); }
  catch (error) {
    if ((error as { code?: number }).code !== 1) throw new Error('Cannot read the Git baseline for this review.');
  }
  if (head && !/^[0-9a-f]{40,64}$/.test(head)) throw new Error('The Git baseline is invalid.');
  const changed = head ? await git(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--relative', head, '--', '.'])
    : await git(workspace, ['ls-files', '--cached', '-z', '--', '.']);
  const untracked = await git(workspace, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
  let listed: string[];
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    listed = [...decoder.decode(changed).split('\0'), ...decoder.decode(untracked).split('\0')];
  } catch { throw new Error('Some changed filenames are not UTF-8. Review supported files individually.'); }
  const paths = [...new Set(listed.filter(Boolean))].sort();
  if (!paths.length) throw new Error('There are no working changes to review. Select a file to review existing code.');
  if (paths.length > SNAPSHOT_LIMITS.files) throw new Error(`This review has ${paths.length} files; the limit is ${SNAPSHOT_LIMITS.files}. Review smaller groups by selecting files.`);
  const files: ReviewFile[] = [];
  let total = 0;
  for (const path of paths) {
    reviewPath(path);
    let beforeBytes: Buffer | null = null;
    let beforeMode: '100644' | '100755' | undefined;
    if (head) {
      const treePath = prefix ? `${prefix}/${path}` : path;
      const entry = await git(root, ['ls-tree', '-z', head, '--', `:(literal)${treePath}`]);
      if (entry.length) {
        const metadata = entry.toString('utf8').split('\t', 1)[0].split(' ');
        if (!['100644', '100755'].includes(metadata[0]) || metadata[1] !== 'blob' || !/^[a-f0-9]{40,64}$/.test(metadata[2])) {
          throw new Error(`${path}: symlinks and submodules cannot be included in a code review.`);
        }
        beforeMode = metadata[0] as '100644' | '100755';
        beforeBytes = await git(root, ['cat-file', 'blob', metadata[2]], SNAPSHOT_LIMITS.fileBytes + 1);
        if (beforeBytes.length > SNAPSHOT_LIMITS.fileBytes) throw new Error(`${path}: the baseline exceeds the 512 KiB review file limit.`);
      }
    }
    const captured = sourceFile(workspace, path);
    const afterBytes = captured?.bytes ?? null;
    total += (beforeBytes?.length ?? 0) + (afterBytes?.length ?? 0);
    if (total > SNAPSHOT_LIMITS.totalBytes) throw new Error('This review exceeds the 2 MiB snapshot limit. Review smaller groups by selecting files.');
    if (beforeBytes === null && afterBytes === null) continue; // An unborn index entry removed again has no source to review.
    files.push({ path, status: afterBytes === null ? 'deleted' : beforeBytes === null ? 'added' : 'modified',
      before: beforeBytes === null ? null : decode(beforeBytes, path), after: afterBytes === null ? null : decode(afterBytes, path),
      beforeStartLine: 1, startLine: 1, ...(beforeMode ? { beforeMode } : {}), ...(captured ? { afterMode: captured.mode } : {}),
      fingerprint: afterBytes === null ? null : hash(afterBytes) });
  }
  if (!files.length) throw new Error('There are no working changes to review.');
  return files;
}

export function reviewFileFreshness(workspace: string, file: ReviewFile): NonNullable<ReviewFile['freshness']> {
  try {
    const captured = sourceFile(workspace, file.path);
    if (captured === null) return file.fingerprint === null ? 'unchanged' : 'missing';
    return hash(captured.bytes) === file.fingerprint && (file.afterMode === undefined || file.afterMode === captured.mode) ? 'unchanged' : 'changed';
  } catch { return 'unavailable'; }
}
