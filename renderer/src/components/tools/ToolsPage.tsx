import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plug, PlugZap, RefreshCw, TriangleAlert, Wrench, X } from 'lucide-react';
import type { McpServerStatus } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';

interface Props {
  embedded?: boolean;
  onClose: () => void;
}

const statusDot = (server: McpServerStatus) => {
  if (server.connecting) return 'bg-ink-3';
  if (server.connected) return 'bg-accent';
  if (server.error) return 'bg-danger';
  return 'bg-ink-3/50';
};

const statusLabel = (server: McpServerStatus) => {
  if (server.connecting) return 'connecting…';
  if (server.connected) return `connected · ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`;
  if (!server.enabled) return 'disabled';
  return server.error ? 'failed' : 'not connected';
};

export function ToolsPage({ onClose, embedded = false }: Props) {
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [storePath, setStorePath] = useState('');
  const [error, setError] = useState('');

  const refreshAll = useCallback(() => {
    window.electronAPI.mcp.list().then(setServers).catch(console.error);
  }, []);

  useEffect(() => {
    refreshAll();
    window.electronAPI.mcp.storeInfo().then((info) => setStorePath(info.path)).catch(console.error);
  }, [refreshAll]);

  // Servers connect in the background at startup; poll briefly so the page settles on its own.
  useEffect(() => {
    const timer = window.setInterval(refreshAll, 2000);
    return () => window.clearInterval(timer);
  }, [refreshAll]);

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The tool server could not be updated.');
    } finally {
      setBusyId(null);
      refreshAll();
    }
  };

  const connectedCount = servers.filter((server) => server.connected).length;
  const toolCount = servers.reduce((total, server) => total + server.tools.filter((tool) => tool.enabled).length, 0);

  return (
    <div className={embedded ? 'relative bg-surface' : 'absolute inset-0 overflow-y-auto bg-surface'}>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
        <Wrench size={16} className="text-primary" />
        <h1 className="text-sm font-semibold text-ink">Tools</h1>
        <span className="text-[11px] text-ink-3">
          {toolCount} tool{toolCount === 1 ? '' : 's'} enabled · {connectedCount}/{servers.length} servers connected
        </span>
        <button
          type="button"
          onClick={() => window.electronAPI.mcp.connectEnabled().then(setServers).catch(console.error)}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
        >
          <PlugZap size={12} />
          Connect all
        </button>
        {!embedded && <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
        >
          <X size={12} />
          Done
        </button>}
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
        <p className="text-xs text-ink-2">
          Enabled tools are available to your agents. The chat’s permission mode controls which calls may run.
        </p>

        {servers.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs text-ink-3">
            No MCP servers found. Antimatter adopts servers installed under ~/.beholder/mcp on first run.
          </p>
        ) : (
          <div className="mt-3 grid gap-2">
            {servers.map((server) => {
              const open = expanded === server.id;
              const busy = busyId === server.id;
              const managed = server.id.startsWith('plugin.');
              return (
                <div key={server.id} className="rounded-xl border border-line bg-surface-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${statusDot(server)}`} />
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : server.id)}
                      aria-expanded={open}
                      className="flex items-center gap-1.5 text-sm font-semibold text-ink transition hover:text-primary"
                    >
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      {server.name}
                    </button>
                    {server.serverInfo?.version && (
                      <span className="font-mono text-[11px] text-ink-3">v{server.serverInfo.version}</span>
                    )}
                    <span className="text-[11px] text-ink-3">{statusLabel(server)}</span>

                    <div className="ml-auto flex items-center gap-1">
                      {busy && <AtomIndicator phase="thinking" size={14} />}
                      <button
                        type="button"
                        onClick={() =>
                          run(server.id, () =>
                            server.connected
                              ? window.electronAPI.mcp.disconnect(server.id)
                              : window.electronAPI.mcp.connect(server.id)
                          )
                        }
                        className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
                      >
                        <Plug size={12} />
                        {server.connected ? 'Disconnect' : 'Connect'}
                      </button>
                      <button
                        type="button"
                        onClick={() => run(server.id, () => window.electronAPI.mcp.refresh(server.id))}
                        title="Re-read this server's tool list"
                        className="rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
                      >
                        <RefreshCw size={12} />
                      </button>
                      <label className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2">
                        <input
                          type="checkbox"
                          checked={server.enabled}
                          disabled={managed || busy}
                          title={managed ? 'Manage this server’s reviewed configuration in Plugins' : undefined}
                          onChange={(event) =>
                            run(server.id, () => window.electronAPI.mcp.setEnabled(server.id, event.target.checked))
                          }
                        />
                        {managed ? 'Managed in Plugins' : 'Enabled'}
                      </label>
                    </div>
                  </div>

                  {server.error && (
                    <p className="mt-2 flex items-start gap-1.5 text-[11px] text-danger">
                      <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                      {server.error}
                    </p>
                  )}

                  {open && (
                    <div className="mt-2 grid gap-1">
                      {server.tools.length === 0 ? (
                        <p className="text-[11px] text-ink-3">
                          {server.connected ? 'This server exposes no tools.' : 'Connect to see this server’s tools.'}
                        </p>
                      ) : (
                        server.tools.map((tool) => (
                          <label
                            key={tool.name}
                            className="flex items-start gap-2 rounded-md px-2 py-1.5 transition hover:bg-surface-3/60"
                          >
                            <input
                              type="checkbox"
                              checked={tool.enabled}
                              disabled={managed || busy}
                              title={managed ? 'Use the conversation access mode, or disable this plugin in Plugins' : undefined}
                              onChange={(event) =>
                                run(server.id, () =>
                                  window.electronAPI.mcp.setToolEnabled(server.id, tool.name, event.target.checked)
                                )
                              }
                              className="mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block font-mono text-[11px] text-ink">{tool.name}</span>
                              {tool.description && (
                                <span className="block text-[11px] text-ink-3">{tool.description}</span>
                              )}
                            </span>
                          </label>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {storePath && (
          <p className="mt-4 text-[11px] text-ink-3">
            Server list: <code className="font-mono">{storePath}</code>
          </p>
        )}
      </div>
    </div>
  );
}
