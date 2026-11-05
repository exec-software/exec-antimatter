/** Review snapshots and annotations are local to a canonical workspace; they never edit source. */
export type ReviewScope = { kind: 'changes' } | { kind: 'file'; path: string; startLine?: number; endLine?: number };
export type ReviewSeverity = 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'addressed' | 'resolved' | 'dismissed';
export type ReviewDecision = 'open' | 'approved' | 'changes-requested';
export interface ReviewAuthor { kind: 'human' | 'agent'; label: string; threadId?: string; runId?: string }
export interface ReviewAnchor { path: string; side: 'before' | 'after'; startLine: number; endLine: number }
export interface ReviewComment { id: string; body: string; author: ReviewAuthor; createdAt: number }
export interface ReviewFinding {
  id: string; title: string; severity: ReviewSeverity; status: FindingStatus;
  anchor?: ReviewAnchor; author: ReviewAuthor; createdAt: number; updatedAt: number; comments: ReviewComment[];
}
export interface ReviewFile {
  path: string; status: 'added' | 'modified' | 'deleted' | 'selected';
  before: string | null; after: string | null; beforeStartLine: number; startLine: number;
  /** Git-style regular-file modes make executable-bit changes visible alongside source. */
  beforeMode?: '100644' | '100755'; afterMode?: '100644' | '100755';
  /** Digest of the whole working file at capture, even when only a range is reviewed. */
  fingerprint: string | null;
  freshness?: 'unchanged' | 'changed' | 'missing' | 'unavailable';
}

/** Physical source lines: a terminal newline ends a line, and empty text has no line anchor. */
export function reviewSnapshotLines(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface CodeReview {
  id: string; workspace: string; title: string; scope: ReviewScope; conversationId?: string;
  revision: number; createdAt: number; updatedAt: number; author: ReviewAuthor;
  decision: ReviewDecision; decisionBy?: ReviewAuthor; files: ReviewFile[]; findings: ReviewFinding[];
}
export interface CodeReviewSummary extends Omit<CodeReview, 'files' | 'findings'> {
  fileCount: number; findingCount: number; openCount: number; addressedCount: number;
}
export interface CreateReviewInput { title: string; scope: ReviewScope; conversationId?: string }
export interface ReviewFindingInput { title: string; body: string; severity: ReviewSeverity; anchor?: ReviewAnchor }
export type ReviewMutation =
  | { kind: 'finding'; finding: ReviewFindingInput }
  | { kind: 'reply'; findingId: string; body: string }
  | { kind: 'status'; findingId: string; status: FindingStatus }
  | { kind: 'decision'; decision: ReviewDecision }
  | { kind: 'rename'; title: string };
export interface CodeReviewAPI {
  list(workspace: string): Promise<CodeReviewSummary[]>;
  create(workspace: string, input: CreateReviewInput): Promise<CodeReview>;
  read(workspace: string, id: string): Promise<CodeReview>;
  mutate(workspace: string, id: string, revision: number, mutation: ReviewMutation): Promise<CodeReview>;
  onChanged(callback: (event: { workspace: string; reviewId: string }) => void): () => void;
}
