import { useEffect, useMemo, useState } from 'react';
import { findToolWindow } from '../registry';
import { ToolWindowFrame } from '../chrome';
import { ShellProvider } from '../shell';
import type { ShellContextValue } from '../types';
import type { DetachedShellUpdate } from '../../../../src/api/detachedWindows';

export function DetachedToolWindow() {
  const [toolWindowId, setToolWindowId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<DetachedShellUpdate>({ revision: -1, shell: null });
  const [error, setError] = useState<string | null>(null);
  const api = window.electronAPI.detached;
  useEffect(() => {
    let mounted = true;
    const accept = (next: DetachedShellUpdate) => setSnapshot((previous) => next.revision >= previous.revision ? next : previous);
    const unsubscribe = api.onShell(accept);
    void api.ready().then((ready) => { if (mounted) { setToolWindowId(ready.toolWindowId); accept(ready); } }).catch((reason: unknown) => { if (mounted) setError(String(reason)); });
    return () => { mounted = false; unsubscribe(); };
  }, [api]);
  const shell = useMemo<ShellContextValue | null>(() => {
    const value = snapshot.shell;
    if (!value) return null;
    const report = (reason: unknown) => setError(String(reason));
    return {
      ...value, conversation: value.conversation && { ...value.conversation, transcript: () => value.conversation!.transcript },
      openPage: (page) => { if (page === 'hub' || page === 'orchestrator') void api.action({ type: 'openPage', page }).catch(report); },
      selectProvider: (providerId) => { void api.action({ type: 'selectProvider', providerId }).catch(report); },
      openModelLibrary: (request) => {
        const serializable = request && { providerId: request.providerId, modelId: request.modelId, title: request.title, description: request.description, actionLabel: request.actionLabel, selectedLabel: request.selectedLabel };
        void api.action({ type: 'openModelLibrary', request: serializable }).then((choice) => { if (choice) request?.onSelect(choice.providerId, choice.modelId); }).catch(report);
      },
    };
  }, [snapshot, api]);
  const definition = toolWindowId && findToolWindow(toolWindowId);
  if (!definition || !shell) return <div className="p-4 text-sm text-ink-2" role="status">{error ?? 'Opening panel…'}</div>;
  return (
    <ShellProvider value={shell}>
      <div className="flex h-screen w-screen flex-col overflow-hidden">
        {error && <div role="alert" className="p-2 text-xs text-danger">{error}</div>}
        <ToolWindowFrame definition={definition} floating onFloat={() => {}}
          onDock={() => { void api.dock(definition.id).catch((reason: unknown) => setError(String(reason))); }}
          onClose={() => { void api.close(definition.id).catch((reason: unknown) => setError(String(reason))); }}>
          {definition.render({ floating: true, visible: true })}
        </ToolWindowFrame>
      </div>
    </ShellProvider>
  );
}
