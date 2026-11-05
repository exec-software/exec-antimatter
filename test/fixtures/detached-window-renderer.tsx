import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShellProvider, useToolWindowLayout, FloatingLayer } from '../../renderer/src/plugins';
import { DetachedShellBridge } from '../../renderer/src/plugins/detached/DetachedShellBridge';
import type { ShellContextValue } from '../../renderer/src/plugins/types';

function Fixture() {
  const layout = useToolWindowLayout();
  const [tick, setTick] = useState(0);
  const [page, setPage] = useState('chat');
  useEffect(() => { const timer = setInterval(() => setTick((value) => value + 1), 10); return () => clearInterval(timer); }, []);
  const shell = useMemo<ShellContextValue>(() => ({
    workspace: '/synthetic-project', conversation: { id: 'synthetic-chat', title: 'Fixture conversation', transcript: () => `token ${tick}` },
    sources: { providers: [{ id: 'fixture', name: 'Fixture source', baseUrl: 'http://fixture.invalid/v1', models: [], credentialConfigured: false, supportsStreaming: true }], activeProviderId: 'fixture', activeModelId: `model-${tick}` },
    selectProvider: () => {}, openPage: setPage,
    openModelLibrary: (request) => { setPage('hub'); request?.onSelect('fixture', 'chosen-model'); },
  }), [tick]);
  Object.assign(window, { detachedSmoke: { layout: layout.layout, tick } });
  return <ShellProvider value={shell}><DetachedShellBridge />
    <button id="float" onClick={() => layout.float('core.sources')}>Float source</button>
    <div id="page">{page}</div>
    <div id="docked">{layout.dockedAt('right').map((panel) => panel.id).join(',')}</div>
    <FloatingLayer layout={layout} />
  </ShellProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
