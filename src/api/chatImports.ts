export type ChatImportSource = 'claude' | 'codex' | 'opencode';
export type ChatImportFormat = 'claude-export' | 'claude-code' | 'codex-rollout' | 'opencode-export';
export interface ImportedChatOrigin {
  source: ChatImportSource;
  format: ChatImportFormat;
  externalId: string;
  importedAt: number;
}
export interface ChatImportCandidate {
  id: string;
  source: ChatImportSource;
  format: ChatImportFormat;
  title: string;
  createdAt: number;
  messageCount: number;
  toolCount: number;
  alreadyImported: boolean;
}
export interface ChatImportPreview {
  batchId: string;
  expiresAt: number;
  candidates: ChatImportCandidate[];
  warnings: string[];
  fileCount: number;
}
export interface ChatImportResult { importedThreadIds: string[]; skipped: number }
export interface ChatImportsAPI {
  choose(options: { source: ChatImportSource; mode: 'files' | 'folder' }): Promise<ChatImportPreview | null>;
  commit(options: { batchId: string; ids: string[]; projectId: string }): Promise<ChatImportResult>;
  discard(batchId: string): Promise<void>;
}
