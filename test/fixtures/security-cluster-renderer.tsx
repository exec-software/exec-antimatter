import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SecurityPage } from '../../renderer/src/components/security/SecurityPage';
import { ClusterPage } from '../../renderer/src/components/cluster/ClusterPage';
import type { SecurityAPI, SecurityReport } from '../../src/api/security';
import type { ClusterAPI, ClusterSnapshot } from '../../src/api/cluster';
import '../../renderer/src/theme';

const report: SecurityReport = { id: '00000000-0000-0000-0000-000000000000', project: 'fixture', startedAt: 1000, completedAt: 2000, modes: ['secrets', 'code'], scannedFiles: 2, scannedBytes: 50, skippedFiles: 1, skippedLines: 0, excludedDirectories: 1, cancelled: false, truncated: false, limitations: ['One binary file was skipped.'], findings: [
  { id: 'a'.repeat(64), mode: 'secrets', rule: 'github-token', severity: 'high', description: 'GitHub token', file: '.env', line: 2, status: 'open', note: '' },
  { id: 'b'.repeat(64), mode: 'code', rule: 'eval', severity: 'high', description: 'Dynamic code execution', file: 'src/app.ts', line: 3, status: 'open', note: '' },
] };
// The fixture's host-side report store survives renderer reload, independently of the UI draft store.
let saved: SecurityReport[] = JSON.parse(sessionStorage.getItem('dashboard-fixture-reports') ?? '[]'); let pending: ((report: SecurityReport) => void) | null = null;
const persist = () => sessionStorage.setItem('dashboard-fixture-reports', JSON.stringify(saved));
let failSave = false;
const metrics = { scans: saved.length ? 1 : 0, reviews: 0, exports: [] as string[], openFiles: [] as unknown[], actions: [] as unknown[], paired: 0 };
const security: SecurityAPI = {
  list: async id => ({ reports: id === 'one' ? structuredClone(saved) : [], running: pending ? { startedAt: 1000, modes: ['code'] } : null }),
  scan: async () => { metrics.scans++; if (metrics.scans === 1) { saved = [structuredClone(report)]; persist(); return structuredClone(report); } return new Promise(resolve => { pending = resolve; }); },
  cancel: async () => { saved = [{ ...structuredClone(report), cancelled: true }]; persist(); pending?.(structuredClone(saved[0])); pending = null; return true; },
  triage: async (_id, update) => { if (failSave) { failSave = false; throw Error('Fixture save failed'); } const selected = saved.find(report => report.id === update.reportId)!; const found = selected.findings.find(f => f.id === update.findingId)!; if (found.status !== update.expected.status || found.note !== update.expected.note) throw Error('This review changed since your draft began.'); metrics.reviews++; found.status = update.status; found.note = update.note; persist(); return structuredClone(selected); },
  remove: async () => { saved = []; persist(); },
  exportReport: async (_id, _report, format) => { metrics.exports.push(format); return { path: `/fixture/report.${format}` }; },
};
const snapshot: ClusterSnapshot = { observedAt: 1000, actions: [], nodes: [
  { key: 'local', name: 'Development machine', local: true, scopes: ['inventory', 'vitals', 'manage-engines'], updatedAt: 1000, report: null, errors: {}, vitals: { observedAt: 1000, uptimeSeconds: 600, cpuUsage: .25, cpuCores: 8, memoryUsed: 1024 ** 3, memoryTotal: 4 * 1024 ** 3, gpus: [], disks: [], networkRx: 1000, networkTx: 200 }, engines: [{ id: 'bundled-beholdd', name: 'Native Beholdd', running: true, ready: true, busy: true, ownership: 'app', startable: true }] },
  { key: 'fixture:1', name: 'Inventory node', local: false, scopes: ['inventory'], updatedAt: 1000, report: null, vitals: null, engines: null, errors: {} },
] };
const cluster: ClusterAPI = { snapshot: async () => structuredClone(snapshot), action: async (node, input) => { metrics.actions.push({ node, ...input }); return snapshot.nodes[0].engines!; } };
function Fixture() {
  const [view, setView] = useState('security'); const [id, setId] = useState('one');
  Object.assign(window, { dashboardSmoke: { metrics, cluster: () => setView('cluster'), security: () => setView('security'), switchWorkspace: (id = 'two') => setId(id),
    addReport: () => { saved.push({ ...structuredClone(report), id: '11111111-1111-1111-1111-111111111111', completedAt: 3000 }); persist(); },
    serverReview: (status: 'open' | 'dismissed' | 'resolved', note: string) => { Object.assign(saved[0].findings[0], { status, note }); persist(); },
    savedReview: () => structuredClone(saved[0].findings[0]), failNextSave: () => { failSave = true; },
  } });
  return <div style={{ position: 'fixed', inset: 0 }}>{view === 'security' ? <SecurityPage api={security} threadId={id} workspace={`/fixture/${id}`} onClose={() => {}} onOpenFile={(file, line) => metrics.openFiles.push({ file, line })} /> : <ClusterPage api={cluster} onClose={() => {}} onOpenPairing={() => { metrics.paired++; }} />}</div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
