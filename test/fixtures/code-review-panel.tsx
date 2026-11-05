/** Actual review panel with an in-memory host. No model, network, repository, or user-data access. */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyDisplacerTokens } from '../../renderer/src/displacer';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import { CodeReviewPanel } from '../../renderer/src/plugins/codeReview/CodeReviewPanel';
import { openCodeReviewSelection } from '../../renderer/src/plugins/codeReview/selection';
import { ShellProvider } from '../../renderer/src/plugins/shell';
import type { CodeReview, CodeReviewAPI, CodeReviewSummary } from '../../src/api/codeReview';
import '../../renderer/src/index.css';

const clone = <T,>(value: T): T => structuredClone(value);
const now = Date.now();
const source = [
  'export async function reconnect(session: Session) {',
  '  const previous = session.transport;',
  '  const transport = await openTransport(session.url);',
  '',
  '  // Only the current attempt may publish a connection.',
  '  if (session.transport !== previous) {',
  '    transport.close();',
  '    return;',
  '  }',
  '',
  '  session.transport = transport;',
  '  session.status = "connected";',
  '  transport.on("message", session.receive);',
  '}',
  ...Array.from({ length: 420 }, (_, i) => `// Context line ${i + 15}`),
].join('\n');
const review: CodeReview = {
  id: 'review-one', workspace: '/fixture/antimatter', title: 'Reconnect without losing the conversation', scope: { kind: 'changes' },
  revision: 3, createdAt: now - 1800000, updatedAt: now, author: { kind: 'human', label: 'Nathan' }, decision: 'open',
  files: [{ path: 'src/connection.ts', status: 'modified', before: source.replace('  if (session.transport !== previous) {', '  if (!session.active) {'), after: source, beforeStartLine: 1, startLine: 1, fingerprint: 'fixture', freshness: 'unchanged' }],
  findings: [
    { id: 'race', title: 'A stale reconnect can replace the active transport', severity: 'high', status: 'open', anchor: { path: 'src/connection.ts', side: 'after', startLine: 3, endLine: 8 }, author: { kind: 'agent', label: 'Atlas' }, createdAt: now - 700000, updatedAt: now, comments: [
      { id: 'c1', body: 'Two reconnects can finish out of order. The earlier attempt should close its transport if a newer connection has already been installed. Add a test that resolves the attempts in reverse order.', author: { kind: 'agent', label: 'Atlas' }, createdAt: now - 700000 },
      { id: 'c2', body: 'Agreed. Let’s verify that the older socket is closed and that its buffered messages never reach the transcript.', author: { kind: 'human', label: 'Nathan' }, createdAt: now - 400000 },
    ] },
    { id: 'coverage', title: 'Cover a reconnect after a completed turn', severity: 'medium', status: 'addressed', anchor: { path: 'src/connection.ts', side: 'after', startLine: 231, endLine: 232 }, author: { kind: 'human', label: 'Nathan' }, createdAt: now, updatedAt: now, comments: [{ id: 'c3', body: 'The regression test now sends a second message through the replacement transport. Ready for your verification.', author: { kind: 'agent', label: 'Atlas' }, createdAt: now }] },
    { id: 'naming', title: 'Keep the transport lifecycle explicit', severity: 'info', status: 'resolved', author: { kind: 'human', label: 'Nathan' }, createdAt: now, updatedAt: now, comments: [{ id: 'c4', body: 'Verified the cleanup path. Keeping this as context for the next review.', author: { kind: 'human', label: 'Nathan' }, createdAt: now }] },
  ],
};
const data = new Map<string, CodeReview>([[review.id, review], ['review-two', { ...clone(review), id: 'review-two', title: 'Connection cleanup', findings: [] }]]);
const listeners = new Set<(event: { workspace: string; reviewId: string }) => void>();
const metrics = { creates: [] as unknown[], mutations: [] as unknown[], prompts: [] as unknown[], reads: [] as unknown[] };
let conflict = false;
let heldRead: { id: string; resolve(value: CodeReview): void } | null = null;
let holdNextRead = false;
let heldMutation: { run(): void } | null = null;
let holdNextMutation = false;
const emit = (item: CodeReview) => listeners.forEach((listener) => listener({ workspace: item.workspace, reviewId: item.id }));
const summary = (item: CodeReview): CodeReviewSummary => { const { files, findings, ...rest } = clone(item); return { ...rest, fileCount: files.length, findingCount: findings.length, openCount: findings.filter((finding) => finding.status === 'open').length, addressedCount: findings.filter((finding) => finding.status === 'addressed').length }; };
const api: CodeReviewAPI = {
  list: async (workspace) => [...data.values()].filter((item) => item.workspace === workspace).map(summary),
  create: async (workspace, input) => { metrics.creates.push({ workspace, input }); const id = `review-created-${metrics.creates.length}`; const next: CodeReview = { ...clone(review), workspace, id, title: input.title, scope: input.scope, revision: 1, findings: [], createdAt: Date.now(), conversationId: input.conversationId }; data.set(id, next); emit(next); return clone(next); },
  read: async (workspace, id) => { metrics.reads.push({ workspace, id }); if (holdNextRead) { holdNextRead = false; return new Promise((resolve) => { heldRead = { id, resolve }; }); } const found = data.get(id); if (!found || found.workspace !== workspace) throw new Error('Unknown review'); return clone(found); },
  mutate: async (workspace, id, revision, mutation) => {
    metrics.mutations.push({ workspace, id, revision, mutation });
    if (holdNextMutation) { holdNextMutation = false; await new Promise<void>((resolve) => { heldMutation = { run: resolve }; }); }
    const found = data.get(id)!;
    if (conflict || found.revision !== revision) { conflict = false; found.revision++; throw new Error('Review revision conflict. Refresh the review.'); }
    if (mutation.kind === 'rename') found.title = mutation.title;
    if (mutation.kind === 'decision') { found.decision = mutation.decision; found.decisionBy = { kind: 'human', label: 'Nathan' }; }
    if (mutation.kind === 'status') found.findings.find((finding) => finding.id === mutation.findingId)!.status = mutation.status;
    if (mutation.kind === 'reply') found.findings.find((finding) => finding.id === mutation.findingId)!.comments.push({ id: `reply-${found.revision}`, body: mutation.body, author: { kind: 'human', label: 'Nathan' }, createdAt: Date.now() });
    if (mutation.kind === 'finding') found.findings.push({ ...mutation.finding, id: `finding-${found.revision}`, author: { kind: 'human', label: 'Nathan' }, status: 'open', createdAt: Date.now(), updatedAt: Date.now(), comments: [{ id: 'first', body: mutation.finding.body, author: { kind: 'human', label: 'Nathan' }, createdAt: Date.now() }] });
    found.revision++; emit(found); return clone(found);
  },
  onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
window.electronAPI = { codeReview: api } as typeof window.electronAPI;
let setWorkspace: (workspace: string) => void;
let setConversation: (id: string) => void;
function Fixture() {
  const [workspace, changeWorkspace] = useState('/fixture/antimatter');
  const [conversation, changeConversation] = useState('chat-one');
  setWorkspace = changeWorkspace; setConversation = changeConversation;
  return <ShellProvider value={{ workspace, conversation: conversation ? { id: conversation, title: 'Review chat', transcript: () => '' } : null, sources: { providers: [], activeProviderId: '', activeModelId: '' }, selectProvider: () => {}, openPage: () => {}, openModelLibrary: () => {}, draftReview: (prompt, target) => { metrics.prompts.push({ prompt, workspace: target }); } }}><div style={{ height: '100vh', fontFamily: 'Inter, system-ui, sans-serif' }}><CodeReviewPanel /></div></ShellProvider>;
}
applyDisplacerTokens();
const strictSmoke = new URLSearchParams(location.search).has('strict');
if (strictSmoke) openCodeReviewSelection({ workspace: '/fixture/antimatter', path: 'src/initial-selection.ts', startLine: 8, endLine: 12 });
createRoot(document.getElementById('root')!).render(strictSmoke ? <StrictMode><Fixture /></StrictMode> : <Fixture />);
Object.assign(window, { reviewSmoke: {
  metrics, data: () => [...data.values()].map(clone),
  select: openCodeReviewSelection,
  workspace: (value: string) => setWorkspace(value), conversation: (value: string) => setConversation(value),
  update: () => { review.revision++; review.findings[0].comments.push({ id: `remote-${review.revision}`, body: 'I reproduced the reverse-order reconnect and added a regression case.', author: { kind: 'agent', label: 'Atlas' }, createdAt: Date.now() }); emit(review); },
  freshness: () => { review.files[0].freshness = 'changed'; },
  conflict: () => { conflict = true; },
  holdRead: () => { holdNextRead = true; }, releaseRead: () => { heldRead?.resolve(clone(data.get(heldRead.id)!)); heldRead = null; },
  holdMutation: () => { holdNextMutation = true; }, releaseMutation: () => { heldMutation?.run(); heldMutation = null; },
  theme: (light: boolean) => applyDisplacerTokens({ ...DEFAULT_APPEARANCE, theme: light ? 'light' : 'dark', secondaryAccent: light ? '#7954c9' : DEFAULT_APPEARANCE.secondaryAccent }),
} });
