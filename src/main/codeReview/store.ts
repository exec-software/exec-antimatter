import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { reviewSnapshotLines, type CodeReview, type CodeReviewSummary, type CreateReviewInput, type ReviewAnchor, type ReviewAuthor, type ReviewFinding, type ReviewMutation } from '../../api/codeReview';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../privateState';
import { canonicalReviewWorkspace, captureReviewSnapshot, reviewFileFreshness, reviewPath, SNAPSHOT_LIMITS, validateScope } from './snapshot';

const LIMITS = { records: 256, recordBytes: 8 * 1024 * 1024, title: 240, body: 16 * 1024, findings: 200, comments: 100 };
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error('The review or finding identity is invalid.');
  return value;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The review input is invalid.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, limit: number, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must contain text within the ${limit} byte limit.`);
  }
  return value;
};
const identifier = (value: unknown): string => text(value, 256, 'Conversation identity');
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const clone = <T>(value: T): T => structuredClone(value);

function author(value: unknown): ReviewAuthor {
  const source = object(value);
  if (source.kind !== 'human' && source.kind !== 'agent') throw new Error('The host must supply a review author.');
  return { kind: source.kind, label: text(source.label, 120, 'Author name'),
    ...(source.threadId === undefined ? {} : { threadId: identifier(source.threadId) }),
    ...(source.runId === undefined ? {} : { runId: identifier(source.runId) }) };
}

function anchor(value: unknown, review: CodeReview): ReviewAnchor | undefined {
  if (value === undefined) return undefined;
  const source = object(value);
  const path = reviewPath(source.path);
  if (source.side !== 'before' && source.side !== 'after') throw new Error('Choose the before or after snapshot for this finding.');
  if (!positive(source.startLine) || !positive(source.endLine) || source.endLine < source.startLine) throw new Error('The finding line range is invalid.');
  const file = review.files.find((item) => item.path === path);
  if (!file) throw new Error('The finding must refer to a file in this review snapshot.');
  const content = file[source.side];
  const first = source.side === 'before' ? file.beforeStartLine : file.startLine;
  if (content === null || source.startLine < first || source.endLine > first + reviewSnapshotLines(content).length - 1) {
    throw new Error('The finding range is outside the captured snapshot.');
  }
  return { path, side: source.side, startLine: source.startLine, endLine: source.endLine };
}

/** One atomic file per review avoids an async capture replacing a newer workspace-wide index. */
export class CodeReviewStore {
  constructor(private readonly root: string, private readonly onChanged?: (event: { workspace: string; reviewId: string }) => void) {
    ensurePrivateDirectory(root);
    this.root = realpathSync(root);
  }

  private directory(workspace: string): string {
    ensurePrivateDirectory(this.root);
    const directory = join(this.root, createHash('sha256').update(workspace).digest('hex'));
    ensurePrivateDirectory(directory);
    return directory;
  }

  private entries(workspace: string): string[] {
    const names = readdirSync(this.directory(workspace)).filter((name) => name.endsWith('.json'));
    if (names.length > LIMITS.records) throw new Error('This workspace has too many stored reviews.');
    return names.map((name) => uuid(name.slice(0, -5)));
  }

  private load(workspace: string, id: string): CodeReview {
    const path = join(this.directory(workspace), `${uuid(id)}.json`);
    let stats;
    try { stats = lstatSync(path); } catch { throw new Error('This review was not found in the selected workspace.'); }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > LIMITS.recordBytes) throw new Error('The stored review is invalid or too large.');
    let review: CodeReview;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > LIMITS.recordBytes || opened.ino !== stats.ino || opened.dev !== stats.dev) throw new Error('invalid record');
      const buffer = Buffer.allocUnsafe(Math.min(opened.size + 1, LIMITS.recordBytes + 1));
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > opened.size) throw new Error('record changed during read');
      review = JSON.parse(buffer.subarray(0, length).toString('utf8')) as CodeReview;
    } catch { throw new Error('The stored review could not be read.'); }
    finally { closeSync(fd); }
    this.validateStored(review, workspace, id);
    return review;
  }

  private validateStored(review: CodeReview, workspace: string, id: string): void {
    object(review);
    if (review.id !== id || review.workspace !== workspace || !positive(review.revision) || !positive(review.createdAt) ||
        !positive(review.updatedAt) || !['open', 'approved', 'changes-requested'].includes(review.decision)) throw new Error('The stored review metadata is invalid.');
    text(review.title, LIMITS.title, 'Review title'); author(review.author); validateScope(review.scope);
    if (review.conversationId !== undefined) identifier(review.conversationId);
    if (review.decisionBy !== undefined && author(review.decisionBy).kind !== 'human') throw new Error('The stored review decision is invalid.');
    if (review.decision !== 'open' && !review.decisionBy) throw new Error('The stored review decision needs a human author.');
    if (!Array.isArray(review.files) || !review.files.length || review.files.length > SNAPSHOT_LIMITS.files ||
        !Array.isArray(review.findings) || review.findings.length > LIMITS.findings) throw new Error('The stored review exceeds its limits.');
    const paths = new Set<string>(); let bytes = 0;
    for (const file of review.files) {
      object(file); reviewPath(file.path);
      if (paths.has(file.path) || !['added', 'modified', 'deleted', 'selected'].includes(file.status) || !positive(file.startLine) ||
          !positive(file.beforeStartLine) || !(file.fingerprint === null || typeof file.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(file.fingerprint))) throw new Error('The stored review file is invalid.');
      paths.add(file.path);
      for (const content of [file.before, file.after]) {
        if (content !== null && (typeof content !== 'string' || Buffer.byteLength(content) > SNAPSHOT_LIMITS.fileBytes)) throw new Error('The stored snapshot is invalid.');
        bytes += content === null ? 0 : Buffer.byteLength(content);
      }
      if (file.before === null && file.after === null || file.after === null && file.fingerprint !== null || file.after !== null && file.fingerprint === null) throw new Error('The stored snapshot fingerprint is invalid.');
      for (const [side, mode] of [[file.before, file.beforeMode], [file.after, file.afterMode]] as const) {
        if (mode !== undefined && (side === null || !['100644', '100755'].includes(mode))) throw new Error('The stored snapshot file mode is invalid.');
      }
    }
    if (bytes > SNAPSHOT_LIMITS.totalBytes) throw new Error('The stored snapshot is too large.');
    const findingIds = new Set<string>(); const commentIds = new Set<string>();
    for (const finding of review.findings) {
      object(finding); uuid(finding.id);
      if (findingIds.has(finding.id) || !['high', 'medium', 'low', 'info'].includes(finding.severity) ||
          !['open', 'addressed', 'resolved', 'dismissed'].includes(finding.status) || !positive(finding.createdAt) || !positive(finding.updatedAt) ||
          !Array.isArray(finding.comments) || finding.comments.length > LIMITS.comments) throw new Error('The stored finding is invalid.');
      findingIds.add(finding.id); text(finding.title, LIMITS.title, 'Finding title'); author(finding.author); anchor(finding.anchor, review);
      for (const comment of finding.comments) {
        object(comment); uuid(comment.id);
        if (commentIds.has(comment.id) || !positive(comment.createdAt)) throw new Error('The stored review comment is invalid.');
        commentIds.add(comment.id); text(comment.body, LIMITS.body, 'Comment'); author(comment.author);
      }
    }
    if (review.decision === 'approved' && review.findings.some((finding) => finding.status === 'open' || finding.status === 'addressed')) {
      throw new Error('The stored approval has unresolved findings.');
    }
  }

  private commit(review: CodeReview, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    const serialized = JSON.stringify(review);
    if (Buffer.byteLength(serialized) > LIMITS.recordBytes) throw new Error('This review is full. Start another review to continue.');
    writePrivateFileAtomic(join(this.directory(review.workspace), `${uuid(review.id)}.json`), serialized);
    try { this.onChanged?.({ workspace: review.workspace, reviewId: review.id }); }
    catch (error) { console.error('[code-review] change notification failed:', error); }
  }

  list(workspace: string): CodeReviewSummary[] {
    const canonical = canonicalReviewWorkspace(workspace);
    return this.entries(canonical).map((id): CodeReviewSummary => {
      const { files, findings, ...review } = this.load(canonical, id);
      return { ...review, fileCount: files.length, findingCount: findings.length,
        openCount: findings.filter((item) => item.status === 'open').length,
        addressedCount: findings.filter((item) => item.status === 'addressed').length };
    }).sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  read(workspace: string, id: string): CodeReview {
    const canonical = canonicalReviewWorkspace(workspace);
    const review = this.load(canonical, id);
    for (const file of review.files) file.freshness = reviewFileFreshness(canonical, file);
    return review;
  }

  async create(workspace: string, input: CreateReviewInput, by: ReviewAuthor, signal?: AbortSignal): Promise<CodeReview> {
    signal?.throwIfAborted();
    const canonical = canonicalReviewWorkspace(workspace);
    const source = object(input);
    const title = text(source.title, LIMITS.title, 'Review title');
    const scope = validateScope(source.scope);
    const conversationId = source.conversationId === undefined ? undefined : identifier(source.conversationId);
    const owner = author(by);
    const files = await captureReviewSnapshot(canonical, scope);
    if (canonicalReviewWorkspace(workspace) !== canonical) throw new Error('The workspace changed during capture. Start the review again.');
    if (this.entries(canonical).length >= LIMITS.records) throw new Error('This workspace has reached its 256 review limit.');
    const now = Date.now();
    const review: CodeReview = { id: randomUUID(), workspace: canonical, title, scope,
      ...(conversationId === undefined ? {} : { conversationId }), revision: 1, createdAt: now, updatedAt: now,
      author: owner, decision: 'open', files, findings: [] };
    this.commit(review, signal);
    return this.read(canonical, review.id);
  }

  async mutate(workspace: string, id: string, revision: number, mutation: ReviewMutation, by: ReviewAuthor, signal?: AbortSignal): Promise<CodeReview> {
    signal?.throwIfAborted();
    const canonical = canonicalReviewWorkspace(workspace);
    if (!positive(revision)) throw new Error('A current review revision is required.');
    const review = this.load(canonical, id);
    if (review.revision !== revision) throw new Error('This review changed. Refresh it before saving your edit.');
    const source = object(mutation);
    const owner = author(by);
    const now = Date.now();
    switch (source.kind) {
      case 'finding': {
        if (review.findings.length >= LIMITS.findings) throw new Error('This review has reached its 200 finding limit.');
        const input = object(source.finding);
        const title = text(input.title, LIMITS.title, 'Finding title');
        const body = text(input.body, LIMITS.body, 'Finding description');
        if (!['high', 'medium', 'low', 'info'].includes(String(input.severity))) throw new Error('Choose a valid finding severity.');
        const location = anchor(input.anchor, review);
        review.findings.push({ id: randomUUID(), title, severity: input.severity as ReviewFinding['severity'], status: 'open',
          ...(location ? { anchor: location } : {}), author: owner, createdAt: now, updatedAt: now,
          comments: [{ id: randomUUID(), body, author: clone(owner), createdAt: now }] });
        if (review.decision === 'approved') { review.decision = 'open'; delete review.decisionBy; }
        break;
      }
      case 'reply': case 'status': {
        const finding = review.findings.find((item) => item.id === uuid(source.findingId));
        if (!finding) throw new Error('The finding no longer exists in this review.');
        if (source.kind === 'reply') {
          if (finding.comments.length >= LIMITS.comments) throw new Error('This finding has reached its 100 comment limit.');
          finding.comments.push({ id: randomUUID(), body: text(source.body, LIMITS.body, 'Comment'), author: owner, createdAt: now });
        } else {
          if (!['open', 'addressed', 'resolved', 'dismissed'].includes(String(source.status))) throw new Error('Choose a valid finding status.');
          if (owner.kind !== 'human' && (source.status === 'resolved' || source.status === 'dismissed')) throw new Error('Only a person can resolve or dismiss a finding.');
          if (finding.status !== source.status) {
            if (finding.comments.length >= LIMITS.comments) throw new Error('This finding has reached its 100 comment limit. Start another review to continue its history.');
            finding.comments.push({ id: randomUUID(), body: `Changed status from ${finding.status} to ${source.status}.`, author: clone(owner), createdAt: now });
          }
          finding.status = source.status as ReviewFinding['status'];
          if (review.decision === 'approved' && (finding.status === 'open' || finding.status === 'addressed')) { review.decision = 'open'; delete review.decisionBy; }
        }
        finding.updatedAt = now;
        break;
      }
      case 'decision': {
        if (owner.kind !== 'human') throw new Error('Only a person can set the final review decision.');
        if (!['open', 'approved', 'changes-requested'].includes(String(source.decision))) throw new Error('Choose a valid review decision.');
        if (source.decision === 'approved') {
          if (review.findings.some((item) => item.status === 'open' || item.status === 'addressed')) throw new Error('Resolve or dismiss every finding before approving the review.');
          if (review.files.some((file) => reviewFileFreshness(canonical, file) !== 'unchanged')) throw new Error('Source files changed after this snapshot. Start a new review before approving.');
          if (review.scope.kind === 'changes') {
            const current = await captureReviewSnapshot(canonical, review.scope);
            if (JSON.stringify(current) !== JSON.stringify(review.files)) throw new Error('Working changes differ from this snapshot. Start a new review before approving.');
          }
        }
        review.decision = source.decision as CodeReview['decision'];
        if (review.decision === 'open') delete review.decisionBy;
        else review.decisionBy = owner;
        break;
      }
      case 'rename': review.title = text(source.title, LIMITS.title, 'Review title'); break;
      default: throw new Error('Unsupported review operation.');
    }
    // Approval capture yields to other edits. Re-read immediately before the atomic write.
    if (canonicalReviewWorkspace(workspace) !== canonical) throw new Error('The workspace changed. Reopen this review.');
    if (this.load(canonical, id).revision !== revision) throw new Error('This review changed. Refresh it before saving your edit.');
    if (source.kind === 'decision' && source.decision === 'approved' && review.files.some((file) => reviewFileFreshness(canonical, file) !== 'unchanged')) {
      throw new Error('Source files changed during approval. Start a new review before approving.');
    }
    review.revision += 1; review.updatedAt = Math.max(now, Date.now());
    this.commit(review, signal);
    return this.read(canonical, id);
  }
}
