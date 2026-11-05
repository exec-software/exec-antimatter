import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Bot, Check, ChevronDown, FileCheck2, FileCode2, GitBranch, MessageSquare, Pencil, Plus, RefreshCw, ShieldCheck, Sparkles, User, X } from 'lucide-react';
import type { CodeReview, CodeReviewSummary, FindingStatus, ReviewAnchor, ReviewDecision, ReviewFinding, ReviewMutation, ReviewScope, ReviewSeverity } from '../../../../src/api/codeReview';
import { useShell } from '../shell';
import { anchorLabel, reviewAgentPrompt, selectionRange, snapshotLines } from './presentation';
import { CODE_REVIEW_SELECTION_EVENT, consumeCodeReviewSelection, type CodeReviewSelection } from './selection';
import './codeReview.css';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const time = (value: number): string => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const severityNames: Record<ReviewSeverity, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Note' };
const statusNames: Record<FindingStatus, string> = { open: 'Open', addressed: 'Awaiting verification', resolved: 'Resolved', dismissed: 'Dismissed' };
const decisionNames: Record<ReviewDecision, string> = { open: 'In review', approved: 'Approved', 'changes-requested': 'Changes requested' };
interface FindingDraft { title: string; body: string; severity: ReviewSeverity; anchor?: ReviewAnchor }
interface ReviewDrafts { finding?: FindingDraft; replies: Record<string, string>; rename?: string }

export function CodeReviewPanel() {
  const shell = useShell();
  const [request, setRequest] = useState<{ selection: CodeReviewSelection | null; sequence: number }>({ selection: null, sequence: 0 });
  const [override, setOverride] = useState<string | null>(null);
  useEffect(() => {
    const consume = () => {
      const selection = consumeCodeReviewSelection();
      if (!selection) return;
      setOverride(selection.workspace ?? null);
      setRequest((current) => ({ selection, sequence: current.sequence + 1 }));
    };
    window.addEventListener(CODE_REVIEW_SELECTION_EVENT, consume);
    // Consume only after commit: StrictMode may discard and repeat render-time initializers.
    consume();
    return () => window.removeEventListener(CODE_REVIEW_SELECTION_EVENT, consume);
  }, []);
  const workspace = override ?? shell.workspace;
  if (!workspace) return <div className="cr-panel"><div className="cr-empty"><FileCheck2 size={30} /><h2>A place to review together</h2><p>Choose a workspace in your chat to capture code, discuss findings, and verify fixes with your agent.</p></div></div>;
  // Remounting fences every request and every draft when the workspace changes.
  return <WorkspaceReviews key={`${workspace}:${shell.conversation?.id ?? ''}`} workspace={workspace} initialSelection={request.selection} selectionSequence={request.sequence} onSelectionHandled={() => setRequest((current) => ({ ...current, selection: null }))} overridden={workspace !== shell.workspace} onUseChat={shell.workspace ? () => { setOverride(null); setRequest((current) => ({ selection: null, sequence: current.sequence + 1 })); } : undefined} />;
}

function WorkspaceReviews({ workspace, initialSelection, selectionSequence, onSelectionHandled, overridden, onUseChat }: { workspace: string; initialSelection: CodeReviewSelection | null; selectionSequence: number; onSelectionHandled(): void; overridden: boolean; onUseChat?: () => void }) {
  const shell = useShell();
  const [reviews, setReviews] = useState<CodeReviewSummary[]>([]);
  const [review, setReview] = useState<CodeReview | null>(null);
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);
  const [selection, setSelection] = useState<CodeReviewSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const selectedRef = useRef('');
  const reviewRef = useRef<CodeReview | null>(null);
  const readSequence = useRef(0);
  const listSequence = useRef(0);
  const mutationPending = useRef(false);
  const newestRevision = useRef(new Map<string, number>());
  const drafts = useRef(new Map<string, ReviewDrafts>());
  const reviewDraft = (id: string) => { let draft = drafts.current.get(id); if (!draft) { draft = { replies: {} }; drafts.current.set(id, draft); } return draft; };
  const conversationRef = useRef(shell.conversation?.id);
  conversationRef.current = shell.conversation?.id;
  const api = window.electronAPI.codeReview;

  const list = useCallback(async () => {
    const seq = ++listSequence.current;
    const next = await api.list(workspace);
    if (mounted.current && seq === listSequence.current) setReviews(next);
  }, [api, workspace]);

  const open = useCallback(async (id: string) => {
    selectedRef.current = id;
    setSelected(id);
    setCreating(false);
    setError('');
    setNotice('');
    setLoading(true);
    if (reviewRef.current?.id !== id) { reviewRef.current = null; setReview(null); }
    const seq = ++readSequence.current;
    try {
      const next = await api.read(workspace, id);
      if (!mounted.current || selectedRef.current !== id || readSequence.current !== seq) return;
      // A concurrent successful write is authoritative over an older read response.
      if (reviewRef.current?.id === id && reviewRef.current.revision > next.revision) return;
      reviewRef.current = next;
      setReview(next);
      setStale((newestRevision.current.get(id) ?? 0) > next.revision);
    } catch (caught) { if (mounted.current && readSequence.current === seq) setError(message(caught)); }
    finally { if (mounted.current && readSequence.current === seq) setLoading(false); }
  }, [api, workspace]);

  useEffect(() => {
    mounted.current = true;
    void list().catch((caught) => { if (mounted.current) setError(message(caught)); }).finally(() => { if (mounted.current) setLoading(false); });
    const unsubscribe = api.onChanged((event) => {
      if (event.workspace !== workspace) return;
      void list().catch(() => {});
      const id = selectedRef.current;
      if (event.reviewId !== id) return;
      // Check the revision, but never overwrite a human's reading position or text drafts.
      void api.read(workspace, id).then((next) => {
        if (!mounted.current) return;
        newestRevision.current.set(id, Math.max(next.revision, newestRevision.current.get(id) ?? 0));
        if (selectedRef.current === id && reviewRef.current && next.revision > reviewRef.current.revision) setStale(true);
      }).catch(() => { if (mounted.current && selectedRef.current === id) setStale(true); });
    });
    return () => { mounted.current = false; ++readSequence.current; ++listSequence.current; unsubscribe(); };
  }, [api, list, workspace]);

  useEffect(() => {
    if (!initialSelection) return;
    setSelection(initialSelection); setCreating(true); setError(''); setNotice('');
    onSelectionHandled();
  }, [initialSelection, selectionSequence, onSelectionHandled]);

  const mutate = async (mutation: ReviewMutation): Promise<boolean> => {
    const current = reviewRef.current;
    if (!current || mutationPending.current || stale || selectedRef.current !== current.id) return false;
    mutationPending.current = true; setBusy(true); setError(''); setNotice('');
    const id = current.id;
    try {
      const next = await api.mutate(workspace, id, current.revision, mutation);
      if (!mounted.current || selectedRef.current !== id) return false;
      reviewRef.current = next; setReview(next); setStale((newestRevision.current.get(id) ?? 0) > next.revision);
      void list().catch(() => {});
      return true;
    } catch (caught) {
      if (mounted.current && selectedRef.current === id) {
        setError(message(caught));
        if (/revision|conflict|changed|stale/i.test(message(caught))) setStale(true);
      }
      return false;
    } finally { mutationPending.current = false; if (mounted.current) setBusy(false); }
  };

  const create = async (title: string, scope: ReviewScope): Promise<void> => {
    if (mutationPending.current) return;
    mutationPending.current = true; setBusy(true); setError('');
    const conversationId = workspace === shell.workspace ? conversationRef.current : undefined;
    try {
      const next = await api.create(workspace, { title, scope, conversationId });
      if (!mounted.current) return;
      await list();
      if (!mounted.current) return;
      selectedRef.current = next.id; reviewRef.current = next; ++readSequence.current;
      setSelected(next.id); setReview(next); setCreating(false); setStale(false); setLoading(false); setSelection(null);
    } catch (caught) { if (mounted.current) setError(message(caught)); }
    finally { mutationPending.current = false; if (mounted.current) setBusy(false); }
  };

  const askAgent = () => {
    if (!review || !shell.draftReview) return;
    shell.draftReview(reviewAgentPrompt(review), review.workspace);
    setNotice('Review request added to your chat draft. Send it when you’re ready.');
  };

  return <section className="cr-panel" aria-label="Code Review workspace">
    <div className="cr-toolbar">
      <div className="cr-workspace" title={workspace}><FileCheck2 size={15} /><span>{workspace.split(/[\\/]/).filter(Boolean).pop()}</span></div>
      <button className="cr-icon" aria-label="Refresh reviews and freshness" title="Refresh saved discussion and check current files" disabled={busy || loading} onClick={() => { void list().catch((caught) => setError(message(caught))); if (selected) void open(selected); }}><RefreshCw size={14} className={loading ? 'cr-spinning' : ''} /></button>
      <button className="cr-button cr-primary" disabled={busy} onClick={() => { setCreating(true); setSelection(null); setError(''); }}><Plus size={13} />New review</button>
    </div>
    {overridden && <div className="cr-workspace-notice"><span>Reviewing the editor’s workspace</span>{onUseChat && <button className="cr-link" disabled={busy} onClick={onUseChat}>Use chat workspace</button>}</div>}
    {reviews.length > 0 && <div className="cr-review-picker"><select aria-label="Saved reviews" value={selected} disabled={busy} onChange={(event) => { if (event.target.value) void open(event.target.value); }}><option value="" disabled>Choose a saved review · {reviews.length}</option>{reviews.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.openCount} open</option>)}</select><ChevronDown size={12} /></div>}
    {error && <div className="cr-notice cr-error" role="alert"><AlertCircle size={14} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={13} /></button></div>}
    {notice && <div className="cr-notice" role="status"><Check size={14} /><span>{notice}</span></div>}
    {creating ? <NewReview key={selection ? `${selection.path}:${selection.startLine}:${selection.endLine}` : 'manual'} selection={selection} busy={busy} onCreate={create} onCancel={() => setCreating(false)} />
      : review ? <ReviewDetail key={review.id} review={review} draft={reviewDraft(review.id)} busy={busy || loading} stale={stale} onMutate={mutate} onRefresh={() => void open(review.id)} onRecapture={() => void create(`${review.title} · updated`, review.scope)} onAsk={askAgent} canAsk={Boolean(shell.draftReview)} />
        : loading ? <div className="cr-empty cr-muted" role="status"><RefreshCw size={22} className="cr-spinning" /><p>Loading reviews…</p></div>
          : <div className="cr-empty"><div className="cr-emblem"><FileCheck2 size={28} /></div><span className="cr-eyebrow">Human + agent</span><h2>Give code a second look.</h2><p>Capture working changes or selected code. Keep findings, questions, and decisions together as the code evolves.</p><button className="cr-button cr-primary" onClick={() => setCreating(true)}><Plus size={14} />Start a review</button><div className="cr-empty-note"><ShieldCheck size={13} />Saved snapshots. Final decisions stay with you.</div></div>}
  </section>;
}

function NewReview({ selection, busy, onCreate, onCancel }: { selection: CodeReviewSelection | null; busy: boolean; onCreate(title: string, scope: ReviewScope): Promise<void>; onCancel(): void }) {
  const [kind, setKind] = useState<'changes' | 'file'>(selection ? 'file' : 'changes');
  const [title, setTitle] = useState('');
  const [path, setPath] = useState(selection?.path ?? '');
  const [start, setStart] = useState(selection?.startLine?.toString() ?? '');
  const [end, setEnd] = useState(selection?.endLine?.toString() ?? '');
  const [error, setError] = useState('');
  const submit = () => {
    if (busy) return;
    const range = [start, end].map((value) => value.trim() ? Number(value) : undefined);
    if (kind === 'file' && ((!path.trim()) || range.some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1)) || (range[1] !== undefined && range[0] === undefined) || (range[0] !== undefined && range[1] !== undefined && range[0] > range[1]))) {
      setError('Enter a file path and a valid line range, or leave both line fields empty.'); return;
    }
    setError('');
    const scope: ReviewScope = kind === 'changes' ? { kind } : { kind, path: path.trim(), startLine: range[0], endLine: range[1] ?? range[0] };
    void onCreate(title.trim() || (kind === 'changes' ? 'Working changes' : `Review ${path.trim().split(/[\\/]/).pop()}`), scope);
  };
  return <form className="cr-new cr-scroll" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <button type="button" className="cr-link" disabled={busy} onClick={onCancel}><ArrowLeft size={13} />Back to reviews</button>
    <span className="cr-eyebrow">Start a conversation about code</span><h2>What are we reviewing?</h2>
    <div className="cr-scope-options">
      <button type="button" className={`cr-scope ${kind === 'changes' ? 'is-active' : ''}`} disabled={busy} onClick={() => setKind('changes')}><GitBranch size={19} /><strong>Working changes</strong><span>Current changes against HEAD, including new files.</span></button>
      <button type="button" className={`cr-scope ${kind === 'file' ? 'is-active' : ''}`} disabled={busy} onClick={() => setKind('file')}><FileCode2 size={19} /><strong>Selected code</strong><span>A file or a specific range. No Git repository needed.</span></button>
    </div>
    <label className="cr-label">Review title<input value={title} maxLength={160} placeholder={kind === 'changes' ? 'Working changes' : 'e.g. Reconnect flow'} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label>
    {kind === 'file' && <><label className="cr-label">File path<input value={path} placeholder="src/connection.ts" onChange={(event) => setPath(event.target.value)} disabled={busy} required /></label><div className="cr-range-fields"><label className="cr-label">First line<input value={start} inputMode="numeric" placeholder="Whole file" onChange={(event) => setStart(event.target.value)} disabled={busy} /></label><label className="cr-label">Last line<input value={end} inputMode="numeric" placeholder={start || 'Whole file'} onChange={(event) => setEnd(event.target.value)} disabled={busy} /></label></div></>}
    {error && <p className="cr-form-error" role="alert">{error}</p>}
    <div className="cr-capture-note"><ShieldCheck size={17} /><p>A saved snapshot keeps every comment tied to the code you reviewed. Creating a review does not change your files.</p></div>
    <button type="submit" className="cr-button cr-primary" disabled={busy}>{busy ? <RefreshCw size={14} className="cr-spinning" /> : <FileCheck2 size={14} />}{busy ? 'Capturing…' : 'Capture review'}</button>
  </form>;
}

function ReviewDetail({ review, draft, busy, stale, onMutate, onRefresh, onRecapture, onAsk, canAsk }: { review: CodeReview; draft: ReviewDrafts; busy: boolean; stale: boolean; onMutate(mutation: ReviewMutation): Promise<boolean>; onRefresh(): void; onRecapture(): void; onAsk(): void; canAsk: boolean }) {
  const [renaming, setRenaming] = useState(draft.rename !== undefined);
  const [title, setTitle] = useState(draft.rename ?? review.title);
  const [filePath, setFilePath] = useState(review.files[0]?.path ?? '');
  const [side, setSide] = useState<'before' | 'after'>(review.files[0]?.after === null ? 'before' : 'after');
  const [anchor, setAnchor] = useState<ReviewAnchor | undefined>();
  const [tab, setTab] = useState<'discussion' | 'snapshot'>('discussion');
  const [filter, setFilter] = useState<'all' | 'active' | 'closed'>('active');
  const [adding, setAdding] = useState(Boolean(draft.finding));
  const [page, setPage] = useState(0);
  const [decision, setDecision] = useState<ReviewDecision>(review.decision);
  const selectedLine = useRef<HTMLButtonElement | null>(null);
  const file = review.files.find((item) => item.path === filePath) ?? review.files[0];
  const locked = busy || stale;
  const active = review.findings.filter((finding) => finding.status === 'open' || finding.status === 'addressed');
  const visible = review.findings.filter((finding) => filter === 'all' || (filter === 'active' ? ['open', 'addressed'].includes(finding.status) : ['resolved', 'dismissed'].includes(finding.status)));
  const changed = review.files.filter((item) => item.freshness && item.freshness !== 'unchanged');
  const lines = file ? snapshotLines(file, side) : [];
  const pageSize = 200;
  const shownLines = lines.slice(page, page + pageSize);

  useEffect(() => { selectedLine.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [anchor, tab]);

  const focusAnchor = (value: ReviewAnchor) => { const target = review.files.find((item) => item.path === value.path); const offset = target ? value.side === 'before' ? target.beforeStartLine : target.startLine : 1; setPage(Math.floor(Math.max(0, value.startLine - offset) / pageSize) * pageSize); setFilePath(value.path); setSide(value.side); setAnchor(value); setTab('snapshot'); };
  const rename = async () => { if (title.trim() && await onMutate({ kind: 'rename', title: title.trim() })) { delete draft.rename; setRenaming(false); } };
  const addFinding = (value?: ReviewAnchor) => { if (!draft.finding) draft.finding = { title: '', body: '', severity: 'medium', anchor: value }; setAdding(true); setTab('discussion'); };

  return <div className="cr-detail">
    <header className="cr-review-header">
      <div className="cr-heading-line"><span className="cr-eyebrow">{review.scope.kind === 'changes' ? 'Working changes' : 'Selected code'} · {review.files.length} {review.files.length === 1 ? 'file' : 'files'}</span><span className={`cr-decision cr-decision-${review.decision}`}><span />{decisionNames[review.decision]}</span></div>
      {renaming ? <form className="cr-rename" onSubmit={(event) => { event.preventDefault(); void rename(); }}><input aria-label="Review title" maxLength={160} autoFocus value={title} onChange={(event) => { draft.rename = event.target.value; setTitle(event.target.value); }} /><button className="cr-icon" aria-label="Save review title" disabled={locked || !title.trim()}><Check size={15} /></button><button type="button" className="cr-icon" aria-label="Cancel rename" onClick={() => { delete draft.rename; setRenaming(false); }}><X size={14} /></button></form>
        : <div className="cr-title-row"><h2>{review.title}</h2><button className="cr-icon" aria-label="Rename review" disabled={locked} onClick={() => { draft.rename = review.title; setTitle(review.title); setRenaming(true); }}><Pencil size={13} /></button></div>}
      <div className="cr-review-meta"><span>Captured {time(review.createdAt)}</span><span>rev {review.revision}</span></div>
      <div className="cr-header-actions"><button className="cr-button cr-primary" disabled={!canAsk} title={canAsk ? 'Add a review request to your current chat draft' : 'Open a chat to collaborate with an agent'} onClick={onAsk}><Sparkles size={13} />Ask agent to review</button><span>{active.length} active · {review.findings.length - active.length} closed</span></div>
    </header>
    {stale && <div className="cr-notice cr-warning" role="status"><RefreshCw size={14} /><span>This review has new activity. Refresh before saving; your draft stays here.</span><button className="cr-link" disabled={busy} onClick={onRefresh}>Refresh</button></div>}
    {changed.length > 0 && <div className="cr-notice cr-warning"><AlertCircle size={14} /><span>{changed.length} {changed.length === 1 ? 'file has' : 'files have'} changed or cannot be checked. Comments still refer to this snapshot. <button className="cr-link" disabled={busy} title="Capture a new review; keep this review and its discussion" onClick={onRecapture}>Review updated code</button></span></div>}
    <div className="cr-mobile-tabs" role="tablist" aria-label="Review view"><button role="tab" aria-selected={tab === 'discussion'} onClick={() => setTab('discussion')}><MessageSquare size={13} />Discussion <span>{review.findings.length}</span></button><button role="tab" aria-selected={tab === 'snapshot'} onClick={() => setTab('snapshot')}><FileCode2 size={13} />Snapshot</button></div>
    <div className={`cr-workbench cr-tab-${tab}`}>
      <section className="cr-source-pane" aria-label="Captured source">
        <div className="cr-pane-title"><FileCode2 size={13} /><h3>Snapshot</h3><span>Read only</span></div>
        <div className="cr-source-controls"><select aria-label="Snapshot file" value={file?.path ?? ''} onChange={(event) => { const next = review.files.find((item) => item.path === event.target.value); setFilePath(event.target.value); setSide(next?.after === null ? 'before' : 'after'); setPage(0); setAnchor(undefined); }}>{review.files.map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}</select><div className="cr-segment" aria-label="Snapshot side"><button aria-pressed={side === 'before'} disabled={file?.before == null} onClick={() => { setSide('before'); setPage(0); setAnchor(undefined); }}>Before</button><button aria-pressed={side === 'after'} disabled={file?.after == null} onClick={() => { setSide('after'); setPage(0); setAnchor(undefined); }}>After</button></div></div>
        <p className="cr-source-help">Click a line to anchor a finding. Shift-click for a range.</p>
        {file && file.beforeMode !== file.afterMode && (file.beforeMode || file.afterMode) && <p className="cr-source-help">File mode {file.beforeMode ?? 'new'} → {file.afterMode ?? 'deleted'}</p>}
        {lines.length > pageSize && <div className="cr-code-pages"><button className="cr-link" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - pageSize))}>Previous</button><span>Lines {shownLines[0]?.number}–{shownLines[shownLines.length - 1]?.number} of {lines[lines.length - 1]?.number}</span><button className="cr-link" disabled={page + pageSize >= lines.length} onClick={() => setPage((current) => current + pageSize)}>Next</button></div>}
        <div className="cr-code-scroll">{lines.length ? <div className="cr-code" role="group" aria-label={`${file.path} ${side} snapshot`}>{shownLines.map((line) => {
          const selected = anchor?.path === file.path && anchor.side === side && line.number >= anchor.startLine && line.number <= anchor.endLine;
          return <button key={line.number} type="button" ref={selected && line.number === anchor?.startLine ? selectedLine : undefined} className={`cr-code-line ${selected ? 'is-selected' : ''}`} aria-label={`Select line ${line.number}`} aria-pressed={selected} onClick={(event) => { const from = event.shiftKey && anchor?.path === file.path && anchor.side === side ? anchor.startLine : line.number; setAnchor({ path: file.path, side, ...selectionRange(from, line.number) }); }}><span className="cr-line-number">{line.number}</span><code>{line.text || ' '}</code></button>;
        })}</div> : <div className="cr-source-empty">{file ? 'This side of the snapshot is empty.' : 'No source files in this review.'}</div>}</div>
        <div className="cr-anchor-action"><span title={anchor ? anchorLabel(anchor) : undefined}>{anchor ? `Lines ${anchor.startLine}${anchor.endLine !== anchor.startLine ? `–${anchor.endLine}` : ''} · ${anchor.side}` : 'Choose lines or add a general finding'}</span><button className="cr-button" disabled={!anchor || locked} onClick={() => addFinding(anchor)}><Plus size={12} />Finding</button></div>
      </section>
      <section className="cr-discussion-pane" aria-label="Review discussion">
        <div className="cr-pane-title"><MessageSquare size={13} /><h3>Discussion</h3><button className="cr-link" disabled={locked} onClick={() => addFinding()}><Plus size={12} />Add finding</button></div>
        <div className="cr-filter" role="group" aria-label="Filter findings">{(['active', 'closed', 'all'] as const).map((value) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'active' ? 'Active' : value === 'closed' ? 'Closed' : 'All'}<span>{value === 'all' ? review.findings.length : value === 'active' ? active.length : review.findings.length - active.length}</span></button>)}</div>
        <div className="cr-discussion-scroll">
          {adding && draft.finding && <FindingComposer draft={draft.finding} locked={locked} onCancel={() => { delete draft.finding; setAdding(false); }} onAdd={async (finding) => { if (await onMutate({ kind: 'finding', finding })) { if (draft.finding?.title.trim() === finding.title && draft.finding.body.trim() === finding.body && draft.finding.severity === finding.severity) { delete draft.finding; setAdding(false); setAnchor(undefined); } setFilter('active'); return true; } return false; }} />}
          {visible.map((finding) => <FindingCard key={finding.id} finding={finding} draft={draft} locked={locked} onAnchor={focusAnchor} onMutate={onMutate} />)}
          {!visible.length && !adding && <div className="cr-discussion-empty"><MessageSquare size={24} /><strong>{review.findings.length ? 'Nothing in this view.' : 'Start with an observation.'}</strong><p>{review.findings.length ? 'Try another filter to see the rest of the review.' : 'Add a finding, ask a question about a line, or invite your agent to take a look.'}</p></div>}
        </div>
      </section>
    </div>
    <footer className="cr-decision-footer"><div><ShieldCheck size={14} /><span>{review.decisionBy ? `${review.decisionBy.label} · ${decisionNames[review.decision]}` : 'Your review decision'}</span></div><div className="cr-decision-controls"><select aria-label="Review decision" value={decision} onChange={(event) => setDecision(event.target.value as ReviewDecision)} disabled={locked}><option value="open">Keep in review</option><option value="changes-requested">Request changes</option><option value="approved">Approve snapshot</option></select><button className="cr-button" disabled={locked} onClick={() => void onMutate({ kind: 'decision', decision })}>Record decision</button></div><p>Approval applies to this snapshot. Addressed findings still need your verification.</p></footer>
  </div>;
}

function FindingComposer({ draft, locked, onCancel, onAdd }: { draft: FindingDraft; locked: boolean; onCancel(): void; onAdd(finding: FindingDraft): Promise<boolean> }) {
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [severity, setSeverity] = useState<ReviewSeverity>(draft.severity);
  // Freeze the anchor when the draft opens: subsequent navigation must not move a written finding.
  const draftAnchor = draft.anchor;
  return <form className="cr-finding-composer" onSubmit={(event) => { event.preventDefault(); if (!locked && title.trim() && body.trim()) void onAdd({ title: title.trim(), body: body.trim(), severity, anchor: draftAnchor }); }}>
    <div className="cr-composer-heading"><strong>New finding</strong><button type="button" className="cr-icon" aria-label="Cancel finding" onClick={onCancel}><X size={14} /></button></div>
    <span className="cr-draft-anchor" title={draftAnchor ? anchorLabel(draftAnchor) : undefined}>{draftAnchor ? anchorLabel(draftAnchor) : 'General finding · entire review'}</span>
    <input aria-label="Finding title" value={title} maxLength={240} placeholder="What needs attention?" onChange={(event) => { draft.title = event.target.value; setTitle(event.target.value); }} />
    <textarea aria-label="Finding details" rows={3} value={body} maxLength={20000} placeholder="Describe the behavior, why it matters, and how to verify it." onChange={(event) => { draft.body = event.target.value; setBody(event.target.value); }} />
    <div className="cr-composer-actions"><select aria-label="Finding severity" value={severity} onChange={(event) => { draft.severity = event.target.value as ReviewSeverity; setSeverity(draft.severity); }}>{Object.entries(severityNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select><button className="cr-button cr-primary" disabled={locked || !title.trim() || !body.trim()}>Add finding</button></div>
  </form>;
}

function FindingCard({ finding, draft, locked, onAnchor, onMutate }: { finding: ReviewFinding; draft: ReviewDrafts; locked: boolean; onAnchor(anchor: ReviewAnchor): void; onMutate(mutation: ReviewMutation): Promise<boolean> }) {
  const [reply, setReply] = useState(draft.replies[finding.id] ?? '');
  const [expanded, setExpanded] = useState(finding.status === 'open' || finding.status === 'addressed');
  const send = async () => {
    const sent = reply;
    if (sent.trim() && !locked && await onMutate({ kind: 'reply', findingId: finding.id, body: sent.trim() })) { if (draft.replies[finding.id] === sent) delete draft.replies[finding.id]; setReply((current) => current === sent ? '' : current); }
  };
  return <article className={`cr-finding cr-finding-${finding.status}`}>
    <div className="cr-finding-top"><span className={`cr-severity cr-severity-${finding.severity}`}>{severityNames[finding.severity]}</span><span className="cr-status">{statusNames[finding.status]}</span><button className="cr-icon" aria-label={`${expanded ? 'Collapse' : 'Expand'} finding: ${finding.title}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><ChevronDown size={14} style={{ transform: expanded ? 'rotate(180deg)' : undefined }} /></button></div>
    <h4>{finding.title}</h4>
    {finding.anchor ? <button className="cr-anchor-link" title={anchorLabel(finding.anchor)} onClick={() => onAnchor(finding.anchor!)}><FileCode2 size={11} /><span>{anchorLabel(finding.anchor)}</span></button> : <span className="cr-general">General observation</span>}
    {expanded && <><div className="cr-comments">{finding.comments.map((comment) => <div className="cr-comment" key={comment.id}><div className="cr-author"><span className={`cr-author-icon cr-author-${comment.author.kind}`}>{comment.author.kind === 'agent' ? <Bot size={11} /> : <User size={11} />}</span><strong>{comment.author.label}</strong><span className="cr-author-kind">{comment.author.kind}</span><time>{time(comment.createdAt)}</time></div><p>{comment.body}</p></div>)}</div><form className="cr-reply" onSubmit={(event) => { event.preventDefault(); void send(); }}><textarea aria-label={`Reply to ${finding.title}`} rows={2} placeholder="Add context, question a finding, or describe a fix…" maxLength={20000} value={reply} onChange={(event) => { draft.replies[finding.id] = event.target.value; setReply(event.target.value); }} /><div className="cr-reply-actions"><select aria-label={`Status of ${finding.title}`} value={finding.status} disabled={locked} onChange={(event) => void onMutate({ kind: 'status', findingId: finding.id, status: event.target.value as FindingStatus })}><option value="open">Open</option><option value="addressed">Awaiting verification</option><option value="resolved">Resolve · verified</option><option value="dismissed">Dismiss</option></select><button className="cr-button" disabled={locked || !reply.trim()}>Reply</button></div></form></>}
  </article>;
}
