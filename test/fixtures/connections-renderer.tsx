import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionsPage } from '../../renderer/src/components/connections/ConnectionsPage';
import { ConnectionPluginsPanel } from '../../renderer/src/components/connections/ConnectionPluginsPanel';
import { connectionDraftBlockers } from '../../renderer/src/components/connections/connectionDrafts';
import type { ConnectionsAPI, ConnectionState, ConnectionReceipt } from '../../src/api/connections';
import '../../renderer/src/theme';

let state: ConnectionState = { revision: 1, secureStorage: true, plugins: { comms: true, email: true }, error: null,
  registrations: [{ provider: 'outlook', clientId: 'configured-client', redirectUri: 'http://127.0.0.1:47833/callback', tenant: 'saved-tenant', hasSecret: false }],
  accounts: [
    { id: 'mail-a', provider: 'outlook', label: 'Personal mail', address: 'one@example.com', guild: '', connected: true, agentRead: false, agentSend: false, projectCount: 0 },
    { id: 'mail-b', provider: 'gmail', label: 'Office mail', address: 'two@example.com', guild: '', connected: true, agentRead: false, agentSend: false, projectCount: 0 },
    { id: 'slack-a', provider: 'slack', label: 'Engineering', address: '', guild: '', connected: true, agentRead: false, agentSend: false, projectCount: 0 },
  ] };
const listeners = new Set<() => void>();
const holds = new Map<string, { resolve?: (value: any) => void; reject?: (error: Error) => void }>();
const metrics = { sends: [] as unknown[], grants: [] as unknown[], registrations: [] as unknown[], cancels: [] as string[], receiptChecks: [] as string[], plugins: [] as unknown[] };
const receipts = new Map<string, ConnectionReceipt>();
const copy = <T,>(value: T): T => structuredClone(value);
function response<T>(name: string, value: T): Promise<T> {
  const hold = holds.get(name);
  if (hold) { return new Promise((resolve, reject) => { hold.resolve = resolve; hold.reject = reject; }); }
  return Promise.resolve(copy(value));
}
function changed() { state = { ...state, revision: state.revision + 1 }; for (const listener of listeners) { listener(); } return copy(state); }
const api: ConnectionsAPI = {
  get: () => response('get', state), onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  enable: async (plugin, enabled) => { metrics.plugins.push({ plugin, enabled }); state.plugins = { ...state.plugins, [plugin]: enabled }; return changed(); },
  registration: async (input) => { metrics.registrations.push(input); return changed(); },
  connect: async () => changed(), disconnect: async (account) => { state.accounts = state.accounts.filter((entry) => entry.id !== account); return changed(); },
  authorize: () => response('authorize', { id: 'auth-attempt', manual: false }), complete: async () => changed(), cancelAuthorization: async (id) => { metrics.cancels.push(id); },
  access: async (account, thread, read, send) => { metrics.grants.push({ account, thread, read, send }); return changed(); },
  projectAccess: (_account, thread) => response(`grant:${thread}`, { read: thread === 'project-two', send: false }),
  folders: (account) => response(`folders:${account}`, { items: [{ id: 'inbox', name: `${account} Inbox` }, { id: 'archive', name: `${account} Archive` }] }),
  messages: (account, folder) => response(`messages:${account}:${folder}`, { items: [{ id: `${folder}-message`, from: 'Peer <peer@example.com>', subject: `${account} ${folder} message`, text: 'Plain preview', date: '2026-11-13' }] }),
  message: (account, folder, id) => response(`message:${account}:${folder}`, { id, from: 'Peer <peer@example.com>', subject: `${folder} detail`, text: '<script>untrusted message stays text</script>\n' + 'A'.repeat(160), date: '2026-11-13' }),
  send: (draft) => { metrics.sends.push(copy(draft)); receipts.set(draft.requestId, { requestId: draft.requestId, state: 'uncertain' }); return response('send', { requestId: draft.requestId, state: 'sent' }); },
  receipt: async (id) => { metrics.receiptChecks.push(id); return receipts.get(id) ?? null; },
};
let navigate: (page: 'email' | 'comms' | 'plugins') => void;
let changeProject: (project: string) => void;
let remount: () => void;
Object.assign(window, { electronAPI: { connections: api }, connectionsSmoke: {
  metrics, state: () => copy(state), blockers: connectionDraftBlockers,
  defer(name: string) { holds.set(name, {}); }, waiting(name: string) { return !!holds.get(name)?.resolve; },
  resolve(name: string, value: unknown) { const hold = holds.get(name); if (!hold?.resolve) { throw new Error(`No pending ${name}`); } holds.delete(name); hold.resolve(copy(value)); },
  reject(name: string) { const hold = holds.get(name); if (!hold?.reject) { throw new Error(`No pending ${name}`); } holds.delete(name); hold.reject(new Error('fixture rejected')); },
  navigate: (page: 'email' | 'comms' | 'plugins') => navigate(page), project: (value: string) => changeProject(value), remount: () => remount(),
  receipt(id: string, status: 'sent' | 'uncertain' | null) { if (status) { receipts.set(id, { requestId: id, state: status }); } else { receipts.delete(id); } },
  emit() { for (const listener of listeners) { listener(); } },
  secureStorage(enabled: boolean) { state.secureStorage = enabled; changed(); },
} });
function Fixture() {
  const [page, setPage] = useState<'email' | 'comms' | 'plugins'>('email'); const [project, setProject] = useState('project-one'); const [key, setKey] = useState(0);
  navigate = setPage; changeProject = setProject; remount = () => setKey((value) => value + 1);
  return page === 'plugins' ? <main className="p-6"><ConnectionPluginsPanel /></main> : <ConnectionsPage key={key} api={api} plugin={page} threadId={project || null} workspace={project ? '/fixture/project' : null} onClose={() => setPage('plugins')} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
