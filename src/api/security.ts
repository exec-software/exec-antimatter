export type SecurityMode = 'secrets' | 'code';
export type SecurityTriage = 'open' | 'dismissed' | 'resolved';
export interface SecurityFinding {
  id: string;
  mode: SecurityMode;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
  file: string;
  line: number;
  status: SecurityTriage;
  note: string;
}
export interface SecurityReport {
  id: string;
  project: string;
  startedAt: number;
  completedAt: number;
  modes: SecurityMode[];
  scannedFiles: number;
  scannedBytes: number;
  skippedFiles: number;
  skippedLines: number;
  excludedDirectories: number;
  cancelled: boolean;
  truncated: boolean;
  limitations: string[];
  findings: SecurityFinding[];
}
export interface SecurityState { reports: SecurityReport[]; running: { startedAt: number; modes: SecurityMode[] } | null }
export interface SecurityReview { status: SecurityTriage; note: string }
export interface SecurityTriageUpdate extends SecurityReview { reportId: string; findingId: string; expected: SecurityReview }
export type SecurityExportFormat = 'json' | 'sarif' | 'markdown';
export interface SecurityAPI {
  list(threadId: string): Promise<SecurityState>;
  scan(threadId: string, options: { modes: SecurityMode[] }): Promise<SecurityReport>;
  cancel(threadId: string): Promise<boolean>;
  triage(threadId: string, update: SecurityTriageUpdate): Promise<SecurityReport>;
  remove(threadId: string, reportId: string): Promise<void>;
  exportReport(threadId: string, reportId: string, format: SecurityExportFormat): Promise<{ path: string | null }>;
}
export const SECURITY_IPC = { list: 'security:list', scan: 'security:scan', cancel: 'security:cancel', triage: 'security:triage', remove: 'security:remove', exportReport: 'security:export' } as const;
export const SECURITY_LIMITS = { files: 20_000, entries: 100_000, fileBytes: 512 * 1024, totalBytes: 64 * 1024 * 1024, findings: 2000, milliseconds: 60_000, retainedReports: 10 } as const;
export function securityModes(value: unknown): SecurityMode[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some((entry) => entry !== 'secrets' && entry !== 'code')) throw new Error('Choose a secrets scan, a code scan, or both.');
  return [...new Set(value)] as SecurityMode[];
}
