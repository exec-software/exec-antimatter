import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../privateState';
import { scanWorkspace, securityWorkspace } from './scanner';
import { SECURITY_LIMITS, securityModes, type SecurityExportFormat, type SecurityFinding, type SecurityMode, type SecurityReport, type SecurityState, type SecurityTriageUpdate } from '../../api/security';

interface ProjectReports { version: 1; fingerprintKey: string; reports: SecurityReport[] }
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid security report data.'); return value as Record<string, unknown>; };
const text = (value: unknown, limit: number): string => { if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Invalid security report text.'); return value; };
const count = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid security report count.'); return Number(value); };
const reportId = (value: unknown): string => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid security report identifier.'); return value; };
const bool = (value: unknown) => { if (typeof value !== 'boolean') throw new Error('Invalid security report state.'); return value; };
function finding(raw: unknown): SecurityFinding {
  const value = object(raw); const id = text(value.id, 64); const file = text(value.file, 4096);
  if (!/^[a-f0-9]{64}$/.test(id) || !file || file.startsWith('/') || file.includes('\\') || file.split('/').some((part) => part === '..' || part === '' || part === '.')) throw new Error('Invalid security finding path.');
  if (!['secrets', 'code'].includes(String(value.mode)) || !['high', 'medium', 'low'].includes(String(value.severity)) || !['open', 'dismissed', 'resolved'].includes(String(value.status))) throw new Error('Invalid security finding state.');
  const line = count(value.line); if (line < 1) throw new Error('Invalid security finding line.');
  return { id, file, line, mode: value.mode as SecurityFinding['mode'], severity: value.severity as SecurityFinding['severity'], status: value.status as SecurityFinding['status'],
    rule: text(value.rule, 100), description: text(value.description, 300), note: text(value.note, 1000) };
}
function report(raw: unknown): SecurityReport {
  const value = object(raw);
  if (!Array.isArray(value.findings) || value.findings.length > SECURITY_LIMITS.findings || !Array.isArray(value.limitations) || value.limitations.length > 20) throw new Error('Security report exceeds its limits.');
  return { id: reportId(value.id), project: text(value.project, 200), startedAt: count(value.startedAt), completedAt: count(value.completedAt), modes: securityModes(value.modes),
    scannedFiles: count(value.scannedFiles), scannedBytes: count(value.scannedBytes), skippedFiles: count(value.skippedFiles), skippedLines: count(value.skippedLines), excludedDirectories: count(value.excludedDirectories),
    cancelled: bool(value.cancelled), truncated: bool(value.truncated), findings: value.findings.map(finding), limitations: value.limitations.map((item) => text(item, 500)) };
}

/** Caller supplies an authorized, chat-bound workspace. Reports never contain matched secret text. */
export class SecurityService {
  private disposed = false;
  private readonly running = new Map<string, { controller: AbortController; startedAt: number; modes: SecurityMode[] }>();
  constructor(private readonly directory: string) { ensurePrivateDirectory(directory); }
  busy(): boolean { return this.running.size > 0; }
  dispose(): void { this.disposed = true; for (const run of this.running.values()) run.controller.abort(); }
  async list(workspace: string): Promise<SecurityState> {
    const root = await securityWorkspace(workspace); const active = this.running.get(root);
    return { reports: this.read(root).reports, running: active ? { startedAt: active.startedAt, modes: active.modes } : null };
  }
  async scan(workspace: string, options: { modes: SecurityMode[] }): Promise<SecurityReport> {
    const modes = securityModes(object(options).modes); const root = await securityWorkspace(workspace);
    if (this.disposed) throw new Error('Security scans are shutting down.');
    if (this.running.has(root)) throw new Error('A scan is already running for this project.');
    if (this.running.size >= 2) throw new Error('Two projects are already being scanned. Wait for one to finish.');
    const stored = this.read(root); const controller = new AbortController();
    this.running.set(root, { controller, startedAt: Date.now(), modes });
    try {
      const scanned = await scanWorkspace(root, modes, stored.fingerprintKey, controller.signal, stored.reports[0]?.findings);
      const current = this.read(root);
      const triage = new Map(current.reports.flatMap((report) => report.findings).reverse().map((finding) => [finding.id, finding]));
      scanned.findings = scanned.findings.map((finding) => { const latest = triage.get(finding.id); return latest ? { ...finding, status: latest.status === 'dismissed' ? 'dismissed' as const : 'open' as const, note: latest.note } : finding; });
      this.write(root, { ...current, reports: [scanned, ...current.reports].slice(0, SECURITY_LIMITS.retainedReports) });
      return scanned;
    } finally { this.running.delete(root); }
  }
  async cancel(workspace: string): Promise<boolean> { const root = await securityWorkspace(workspace); const run = this.running.get(root); run?.controller.abort(); return !!run; }
  async triage(workspace: string, input: SecurityTriageUpdate): Promise<SecurityReport> {
    const root = await securityWorkspace(workspace); const update = object(input);
    const id = reportId(update.reportId); const findingId = text(update.findingId, 64); const note = text(update.note, 1000);
    if (!['open', 'dismissed', 'resolved'].includes(String(update.status))) throw new Error('Choose a valid finding status.');
    const expected = object(update.expected); const expectedNote = text(expected.note, 1000);
    if (!['open', 'dismissed', 'resolved'].includes(String(expected.status))) throw new Error('Choose a valid expected finding status.');
    const state = this.read(root); const selected = state.reports.find((report) => report.id === id);
    if (!selected) throw new Error('That report is no longer available.');
    const target = selected.findings.find((finding) => finding.id === findingId);
    if (!target) throw new Error('That finding is not in this report.');
    // Read, compare and write run synchronously after workspace resolution, so another
    // request cannot change a review between its comparison and the atomic file write.
    if (target.status !== expected.status || target.note !== expectedNote) throw new Error('This review changed since your draft began. Review the saved changes before saving again.');
    target.status = update.status as SecurityFinding['status']; target.note = note;
    this.write(root, state); return selected;
  }
  async remove(workspace: string, rawId: string): Promise<void> {
    const root = await securityWorkspace(workspace); const id = reportId(rawId); const state = this.read(root);
    state.reports = state.reports.filter((report) => report.id !== id); this.write(root, state);
  }
  async serializeExport(workspace: string, rawId: string, format: SecurityExportFormat): Promise<{ filename: string; contents: string }> {
    const root = await securityWorkspace(workspace); const id = reportId(rawId); const selected = this.read(root).reports.find((report) => report.id === id);
    if (!selected) throw new Error('That report is no longer available.');
    return securityExport(selected, format);
  }
  private path(root: string) { return join(this.directory, `${createHash('sha256').update(root).digest('hex')}.json`); }
  private read(root: string): ProjectReports {
    const path = this.path(root);
    if (!existsSync(path)) {
      const state: ProjectReports = { version: 1, fingerprintKey: randomBytes(32).toString('base64url'), reports: [] };
      this.write(root, state); return state;
    }
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) throw new Error('Security history cannot be read.');
    const value = object(JSON.parse(readFileSync(path, 'utf8')));
    if (value.version !== 1 || typeof value.fingerprintKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.fingerprintKey) || !Array.isArray(value.reports) || value.reports.length > SECURITY_LIMITS.retainedReports) throw new Error('Security history is damaged; it has not been replaced.');
    return { version: 1, fingerprintKey: value.fingerprintKey, reports: value.reports.map(report) };
  }
  private write(root: string, state: ProjectReports): void {
    const contents = `${JSON.stringify(state, null, 2)}\n`; if (Buffer.byteLength(contents) > MAX_STORE_BYTES) throw new Error('Security history is full. Remove an older report.');
    writePrivateFileAtomic(this.path(root), contents);
  }
}

export function securityExport(report: SecurityReport, format: SecurityExportFormat): { filename: string; contents: string } {
  const filename = `security-${report.id}`;
  if (format === 'json') return { filename: `${filename}.json`, contents: `${JSON.stringify(report, null, 2)}\n` };
  if (format === 'sarif') {
    const rules = [...new Map(report.findings.map((finding) => [finding.rule, { id: finding.rule, shortDescription: { text: finding.description } }])).values()];
    const sarif = { version: '2.1.0', $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json', runs: [{
      tool: { driver: { name: 'Antimatter Security', rules } },
      invocations: [{ executionSuccessful: !report.cancelled && !report.truncated, startTimeUtc: new Date(report.startedAt).toISOString(), endTimeUtc: new Date(report.completedAt).toISOString() }],
      results: report.findings.map((finding) => ({ ruleId: finding.rule, level: finding.severity === 'high' ? 'error' : finding.severity === 'medium' ? 'warning' : 'note',
        message: { text: finding.description }, locations: [{ physicalLocation: { artifactLocation: { uri: finding.file.split('/').map(encodeURIComponent).join('/') }, region: { startLine: finding.line } } }],
        partialFingerprints: { antimatterFinding: finding.id },
        ...(finding.status === 'dismissed' ? { suppressions: [{ kind: 'external', justification: finding.note || 'Dismissed during review.' }] } : {}),
        properties: { triage: finding.status, note: finding.note } })),
      properties: { project: report.project, limitations: report.limitations, scannedFiles: report.scannedFiles, skippedFiles: report.skippedFiles, skippedLines: report.skippedLines },
    }] };
    return { filename: `${filename}.sarif`, contents: `${JSON.stringify(sarif, null, 2)}\n` };
  }
  if (format !== 'markdown') throw new Error('Choose JSON, SARIF, or Markdown.');
  const escape = (value: string) => value.replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  const lines = [`# Security scan: ${escape(report.project)}`, '', `Completed: ${new Date(report.completedAt).toISOString()}`, '',
    `${report.scannedFiles} files scanned. ${report.findings.length} findings. ${report.skippedFiles} files skipped.`, '', ...report.limitations.map((line) => `- ${escape(line)}`), '',
    '| Severity | Finding | Location | Status | Notes |', '| --- | --- | --- | --- | --- |',
    ...report.findings.map((finding) => `| ${finding.severity} | ${escape(finding.description)} | ${escape(finding.file)}:${finding.line} | ${finding.status} | ${escape(finding.note)} |`), ''];
  return { filename: `${filename}.md`, contents: lines.join('\n') };
}
