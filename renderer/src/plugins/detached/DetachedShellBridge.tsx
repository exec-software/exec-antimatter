import { useEffect, useRef, useState } from 'react';
import { useShell } from '../shell';
import type { DetachedModelChoice, DetachedShellSnapshot } from '../../../../src/api/detachedWindows';

/** Main renderer owns navigation and model selection. Functions never cross IPC. */
export function DetachedShellBridge() {
  const shell = useShell();
  const current = useRef(shell);
  current.current = shell;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const published = useRef(false);
  const [windows, setWindows] = useState<Set<string>>(new Set());
  useEffect(() => {
    let mounted = true;
    let changed = false;
    const api = window.electronAPI.detached;
    const stopChanges = api.onChanged(({ toolWindowId, kind }) => {
      changed = true;
      setWindows((previous) => { const next = new Set(previous); if (kind === 'opened') next.add(toolWindowId); else next.delete(toolWindowId); return next; });
    });
    void api.list().then((entries) => { if (mounted && !changed) setWindows(new Set(entries.map((entry) => entry.toolWindowId))); }).catch(console.error);
    const stopActions = api.onAction(({ requestId, action }) => {
      const reply = (choice: DetachedModelChoice | null) => { void api.resolveAction(requestId, choice).catch(console.error); };
      if (action.type === 'openModelLibrary' && action.request) {
        current.current.openModelLibrary({ ...action.request, onSelect: (providerId, modelId) => reply({ providerId, modelId }) });
      } else {
        if (action.type === 'openPage') current.current.openPage(action.page);
        if (action.type === 'selectProvider') current.current.selectProvider(action.providerId);
        if (action.type === 'openModelLibrary') current.current.openModelLibrary();
        reply(null);
      }
    });
    return () => { mounted = false; stopChanges(); stopActions(); };
  }, []);
  // First publish is immediate. Later renders coalesce without postponing the existing deadline:
  // a continuous token stream must not strand a freshly opened panel on its loading screen.
  useEffect(() => {
    if (!windows.size) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      published.current = false;
      return;
    }
    const publish = () => {
      timer.current = null;
      const value = current.current;
      const snapshot: DetachedShellSnapshot = {
        workspace: value.workspace,
        conversation: value.conversation && { id: value.conversation.id, title: value.conversation.title, transcript: value.conversation.transcript() },
        sources: value.sources,
      };
      void window.electronAPI.detached.publishShell(snapshot).catch(console.error);
    };
    if (!published.current) { published.current = true; publish(); }
    else if (timer.current === null) timer.current = setTimeout(publish, 100);
  }, [shell, windows]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return null;
}
