import { Library, Server, Waypoints } from 'lucide-react';
import { registerPlugin } from '../registry';
import { useShell } from '../shell';

/**
 * The inference panel that used to be the hard-coded right rail, now a tool window like any
 * other. Keeping the shell's own panels on the plugin contract is the cheapest way to be sure
 * the contract is enough to build something real with.
 */
function SourcesPanel() {
  const { sources, openPage } = useShell();

  return (
    <div className="p-3">
      <p className="mb-2 text-xs text-ink-3">Active source</p>
      {sources.providers.length === 0 ? (
        <p className="text-xs text-ink-3">No sources configured</p>
      ) : (
        <div className="space-y-1.5">
          {sources.providers.map((provider) => {
            const isActive = sources.activeProviderId === provider.id;
            return (
              <div
                key={provider.id}
                className={`flex w-full items-start gap-2 rounded-md border-l-2 px-2.5 py-2 text-left text-xs transition ${
                  isActive
                    ? 'border-primary bg-primary/10 text-ink'
                    : 'border-transparent bg-surface-3/40 text-ink-2'
                }`}
              >
                <Server size={13} className={`mt-0.5 shrink-0 ${isActive ? 'text-primary' : 'text-ink-3'}`} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{provider.name}</span>
                  <span className="block truncate text-[11px] text-ink-3">{provider.baseUrl}</span>
                  {isActive && (
                    <span className="mt-0.5 block text-[11px] text-ink-2">
                      Active model: {sources.activeModelId || '—'}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={() => openPage('hub')}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded border border-line px-2 py-1.5 text-xs text-ink-2 transition hover:border-primary/60 hover:text-ink"
      >
        <Library size={12} />
        Open Model Library
      </button>
    </div>
  );
}

export const corePlugin = registerPlugin({
  id: 'antimatter.core',
  name: 'Antimatter',
  version: '1.0.0',
  description: "The shell's own panels.",
  toolWindows: [
    {
      id: 'core.sources',
      title: 'Inference',
      icon: Waypoints,
      anchor: 'right',
      description: 'Inference sources and routing',
      defaultSize: 300,
      floatSize: { width: 380, height: 460 },
      render: () => <SourcesPanel />,
    },
  ],
});
