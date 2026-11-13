import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { CODE_PATTERNS, SECRET_PATTERNS, scanContent } from '../../../mcp/tools/security';
import { IGNORED, looksBinary } from '../../../mcp/workspace';
import { SECURITY_LIMITS, securityModes, type SecurityFinding, type SecurityMode, type SecurityReport } from '../../api/security';

const inside = (root: string, path: string) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
export async function securityWorkspace(value: string): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || /[\u0000-\u001f]/.test(value)) throw new Error('Choose a workspace folder before scanning.');
  const root = await realpath(value); if (!(await lstat(root)).isDirectory()) throw new Error('The workspace is not a folder.');
  return root;
}

async function readSource(root: string, path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > SECURITY_LIMITS.fileBytes) throw new Error('File is not scannable.');
  const canonical = await realpath(path); if (!inside(root, canonical)) throw new Error('File escapes the workspace.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || await realpath(path) !== canonical) throw new Error('File changed before scanning.');
    if (process.platform === 'linux' && !inside(root, await realpath(`/proc/self/fd/${file.fd}`))) throw new Error('Opened file escapes the workspace.');
    const buffer = Buffer.allocUnsafe(SECURITY_LIMITS.fileBytes + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    const after = await file.stat();
    if (length > SECURITY_LIMITS.fileBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || await realpath(path) !== canonical) throw new Error('File changed while scanning.');
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

/** Read-only pattern analysis; no project configuration, scripts, hooks, or tools are executed. */
export async function scanWorkspace(rootValue: string, requested: SecurityMode[], key: string, signal: AbortSignal,
  previous: readonly SecurityFinding[] = []): Promise<SecurityReport> {
  const root = await securityWorkspace(rootValue); const modes = securityModes(requested); const startedAt = Date.now();
  const report: SecurityReport = { id: randomUUID(), project: basename(root) || root, startedAt, completedAt: startedAt, modes,
    scannedFiles: 0, scannedBytes: 0, skippedFiles: 0, skippedLines: 0, excludedDirectories: 0, cancelled: false, truncated: false, limitations: [], findings: [] };
  const prior = new Map(previous.map((finding) => [finding.id, finding]));
  let entries = 0;
  const stack = [root];
  const stop = () => {
    if (report.truncated) return true;
    if (signal.aborted) { report.cancelled = true; return true; }
    if (Date.now() - startedAt >= SECURITY_LIMITS.milliseconds || report.scannedFiles >= SECURITY_LIMITS.files || entries >= SECURITY_LIMITS.entries
      || report.scannedBytes >= SECURITY_LIMITS.totalBytes || report.findings.length >= SECURITY_LIMITS.findings) { report.truncated = true; return true; }
    return false;
  };
  while (stack.length && !stop()) {
    const directory = stack.pop()!;
    let handle;
    try { const resolved = await realpath(directory); if (!inside(root, resolved) || (await lstat(directory)).isSymbolicLink()) { report.excludedDirectories++; continue; } handle = await opendir(resolved); }
    catch { report.excludedDirectories++; continue; }
    try {
      for await (const entry of handle) {
        entries++; if (stop()) break;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (IGNORED.has(entry.name)) report.excludedDirectories++; else stack.push(path); continue; }
        if (!entry.isFile() || entry.isSymbolicLink()) { report.skippedFiles++; continue; }
        try {
          const bytes = await readSource(root, path);
          if (report.scannedBytes + bytes.length > SECURITY_LIMITS.totalBytes) { report.truncated = true; break; }
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (looksBinary(content)) { report.skippedFiles++; continue; }
          report.scannedFiles++; report.scannedBytes += bytes.length;
          report.skippedLines += content.split('\n').filter((line) => line.length > 2000).length;
          const file = relative(root, path).split(sep).join('/');
          // Keyed file fingerprints preserve triage only for unchanged source. No match text or
          // unkeyed hash of a low-entropy secret enters reports or exports.
          const fingerprint = createHmac('sha256', key).update(bytes).digest('hex');
          for (const mode of modes) {
            const remaining = SECURITY_LIMITS.findings - report.findings.length;
            if (remaining <= 0) { report.truncated = true; break; }
            for (const found of scanContent(mode === 'secrets' ? SECRET_PATTERNS : CODE_PATTERNS, content, file, true, remaining)) {
              const id = createHash('sha256').update(`${file}\0${found.line}\0${found.pattern.id}\0${fingerprint}`).digest('hex');
              const old = prior.get(id);
              report.findings.push({ id, mode, rule: found.pattern.id, severity: found.pattern.severity, description: found.pattern.description,
                file, line: found.line, status: old?.status === 'dismissed' ? 'dismissed' : 'open', note: old?.note ?? '' });
            }
          }
          if (report.findings.length >= SECURITY_LIMITS.findings) report.truncated = true;
        } catch { report.skippedFiles++; }
      }
    } catch { report.excludedDirectories++; }
  }
  if (signal.aborted) report.cancelled = true;
  report.completedAt = Date.now();
  report.limitations.push('Pattern checks identify review candidates; they do not prove a project is secure.');
  if (report.cancelled) report.limitations.push('Cancelled before the workspace was fully scanned.');
  if (report.truncated) report.limitations.push('A file, byte, finding, entry, or time limit was reached. Results are incomplete.');
  if (report.skippedFiles) report.limitations.push(`${report.skippedFiles} unreadable, changed, binary, oversized, or linked files were skipped.`);
  if (report.skippedLines) report.limitations.push(`${report.skippedLines} lines longer than 2,000 characters were skipped.`);
  if (report.excludedDirectories) report.limitations.push(`${report.excludedDirectories} generated, unreadable, or linked directories were excluded.`);
  return report;
}
