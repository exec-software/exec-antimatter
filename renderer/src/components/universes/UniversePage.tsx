import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Atom,
  ChevronDown,
  Clapperboard,
  Code2,
  KeyRound,
  Layers,
  Lock,
  Plus,
  Settings2,
  Sliders,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  ATOMA_DEFAULT_HEIGHT,
  ATOMA_DEFAULT_WIDTH,
  DEFAULT_REGION_SIZES,
  panelsInRegion,
  resolvePanels,
  type UniverseGeneratorView,
  type UniverseLayout,
  type UniversePanel,
  type UniverseRegion,
  type UniverseView,
} from '../../../../src/api/universes';
import { isOpen } from '../../../../src/api/universeLicences';
import { MoviePanel, Pane } from './MoviePanels';
import { useProduction, useProductions, useUniverses } from './useUniverses';
import { beginDrag } from '../../plugins/drag';

/**
 * The Universe workbench.
 *
 * One page that wears whichever universe is selected. The switcher along the top is the whole
 * concept made visible: the application does not change, the workbench does.
 *
 * Two things are deliberately *not* here. There is no per-universe routing — a universe is not a
 * page, it is an arrangement of panels, and giving each one a route would make the back button
 * the thing that decides what your workbench looks like. And there is no second chat: the
 * floating assistant is the conversation you already had open, drawn over this surface, because
 * an assistant that cannot see the chat you were having is a worse assistant than the one in the
 * sidebar you just left.
 */

/**
 * What the floating assistant needs from the page it floats over: where it was left, how to
 * remember where it is left next, and how to shut it.
 */
export interface AtomaControl {
  placement: UniverseLayout['atoma'];
  onPlacement: (next: NonNullable<UniverseLayout['atoma']>) => void;
  onClose: () => void;
  /** One line about what the workbench is showing, so the chat has its footing. */
  context: string;
}

interface Props {
  onLeave: () => void;
  /**
   * The floating assistant, supplied as a render callback rather than an element.
   *
   * App.tsx owns the conversation and this page owns where the panel sits, and neither can own
   * both: the thread is application state and the placement is part of a universe's layout. A
   * callback is the seam — App.tsx says what to draw, the page says where.
   */
  atoma?: (control: AtomaControl) => React.ReactNode;
}

/** Manifest icon names resolved against the few we actually draw. */
const ICONS: Record<string, LucideIcon> = { Code2, Clapperboard, Layers, Atom };

const icon = (name: string): LucideIcon => ICONS[name] ?? Atom;

/** The divider a region is resized by. Mirrors the sidebar's handle, keyboard included. */
function RegionHandle({
  orientation,
  onDrag,
  onNudge,
}: {
  orientation: 'vertical' | 'horizontal';
  onDrag: (event: React.PointerEvent) => void;
  onNudge: (delta: number) => void;
}) {
  const vertical = orientation === 'vertical';
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label="Resize panel"
      tabIndex={0}
      onPointerDown={onDrag}
      onKeyDown={(event) => {
        const back = vertical ? 'ArrowLeft' : 'ArrowUp';
        const forward = vertical ? 'ArrowRight' : 'ArrowDown';
        if (event.key === back) {
          event.preventDefault();
          onNudge(-16);
        } else if (event.key === forward) {
          event.preventDefault();
          onNudge(16);
        }
      }}
      className={`${
        vertical ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      } shrink-0 bg-line transition hover:bg-primary/40 focus-visible:bg-primary focus-visible:outline-none`}
    />
  );
}

/**
 * The licence manager.
 *
 * Shown for every universe, including the free ones, because the useful thing it answers is
 * "what am I entitled to and until when" — and a page that only appears once something has
 * lapsed is a page people meet for the first time at the worst moment.
 */
function LicencePanel({
  universes,
  onChanged,
}: {
  universes: UniverseView[];
  onChanged: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const install = async () => {
    setError('');
    setNote('');
    try {
      const entitlement = await window.electronAPI.universes.installLicence(text);
      setNote(`${entitlement.universeId}: ${entitlement.reason}`);
      setText('');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That licence could not be installed.');
    }
  };

  return (
    <Pane title="Licences">
      <div className="space-y-3 p-3">
        <ul className="space-y-2">
          {universes.map(({ manifest, entitlement }) => (
            <li key={manifest.id} className="rounded border border-line p-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink">{manifest.name}</span>
                <span className="text-[10px] text-ink-3">{manifest.publisher} · {manifest.release}</span>
                <span
                  className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
                    entitlement.state === 'granted'
                      ? 'bg-primary/10 text-primary'
                      : entitlement.state === 'expired'
                        ? 'bg-warning-bg/40 text-warning'
                        : 'bg-surface-3 text-ink-3'
                  }`}
                >
                  {entitlement.state === 'granted' ? 'open' : entitlement.state}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-ink-3">{entitlement.reason}</p>
              {entitlement.daysRemaining !== null && (
                <p className="mt-0.5 text-[10px] text-ink-3">{entitlement.daysRemaining} days remaining.</p>
              )}
              {entitlement.grant && (
                <button
                  type="button"
                  onClick={async () => {
                    await window.electronAPI.universes.removeLicence(manifest.id).catch(() => undefined);
                    onChanged();
                  }}
                  className="mt-1 text-[10px] text-ink-3 underline hover:text-danger"
                >
                  Remove this licence
                </button>
              )}
            </li>
          ))}
        </ul>
        <div>
          <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-3" htmlFor="licence-text">
            Install a licence
          </label>
          <textarea
            id="licence-text"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Paste the licence file you were sent."
            className="w-full resize-y rounded-md border border-line bg-surface-3 px-2.5 py-2 font-mono text-[10px] text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none"
          />
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() => void install()}
            className="mt-2 flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[11px] text-on-primary transition disabled:opacity-40"
          >
            <KeyRound size={12} />
            Install
          </button>
          {/* Nothing here reaches the network, and that is worth saying where someone is about
              to paste a licence: it is the difference between a check and a phone-home. */}
          <p className="mt-1.5 text-[10px] text-ink-3">
            Checked on this machine. Antimatter never contacts a licence server.
          </p>
          {error && <p className="mt-1.5 text-[10px] text-danger">{error}</p>}
          {note && <p className="mt-1.5 text-[10px] text-primary">{note}</p>}
        </div>
      </div>
    </Pane>
  );
}

/** Generator setup: where an endpoint, a unit or a model id is entered. */
function GeneratorPanel({
  generators,
  onChanged,
}: {
  generators: UniverseGeneratorView[];
  onChanged: (next: UniverseGeneratorView[]) => void;
}) {
  const [error, setError] = useState('');
  const bind = async (id: string, patch: Record<string, unknown>) => {
    try {
      onChanged(await window.electronAPI.universes.bindGenerator(id, patch));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That generator could not be saved.');
    }
  };

  const field =
    'w-full rounded border border-line bg-surface-3 px-2 py-1 text-[11px] text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';

  return (
    <Pane title="Generators">
      <div className="space-y-3 p-3">
        {generators.map(({ spec, binding, problem }) => (
          <div key={spec.id} className="rounded border border-line p-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={binding.enabled}
                onChange={(event) => void bind(spec.id, { enabled: event.target.checked })}
              />
              <span className="text-xs text-ink">{spec.name}</span>
              {!problem && <span className="ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">ready</span>}
            </label>
            <p className="mt-1 text-[10px] leading-relaxed text-ink-3">{spec.note}</p>
            {binding.enabled && (
              <div className="mt-2 space-y-1.5">
                {spec.adapter === 'unit' ? (
                  <input
                    className={field}
                    placeholder="systemd --user unit, e.g. wan-video.service"
                    value={binding.unit}
                    onChange={(event) => void bind(spec.id, { unit: event.target.value })}
                  />
                ) : (
                  <input
                    className={field}
                    placeholder={spec.adapter === 'comfy' ? 'http://127.0.0.1:8188' : 'https://…/v1'}
                    value={binding.endpoint}
                    onChange={(event) => void bind(spec.id, { endpoint: event.target.value })}
                  />
                )}
                <input
                  className={field}
                  placeholder="model id (blank uses the endpoint's own default)"
                  value={binding.model}
                  onChange={(event) => void bind(spec.id, { model: event.target.value })}
                />
                {spec.adapter === 'openai-video' && (
                  <input
                    className={field}
                    placeholder="credential name — never the key itself"
                    value={binding.credentialRef}
                    onChange={(event) => void bind(spec.id, { credentialRef: event.target.value })}
                  />
                )}
                {problem && <p className="text-[10px] text-warning">{problem}</p>}
              </div>
            )}
            {spec.weights && (
              <p className="mt-1.5 rounded bg-surface-3/60 p-1.5 text-[10px] leading-relaxed text-ink-3">
                {spec.weights.repoId} · {spec.weights.licence} — {spec.weights.licenceNote}
              </p>
            )}
          </div>
        ))}
        {error && <p className="text-[10px] text-danger">{error}</p>}
      </div>
    </Pane>
  );
}

export function UniversePage({ onLeave, atoma }: Props) {
  const { universes, ready, error, patchLayout, refresh } = useUniverses();
  const [activeId, setActiveId] = useState<string>('movie');
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [generators, setGenerators] = useState<UniverseGeneratorView[]>([]);

  const active = useMemo(() => universes?.find((entry) => entry.manifest.id === activeId) ?? null, [universes, activeId]);

  /**
   * Which document is open, kept in the universe's layout rather than here.
   *
   * So that re-entering the universe resumes the production you were in, and so that the
   * model's tools can act on "the open production" without it being a tool argument — see the
   * reasoning on `documentId` in src/api/universes.ts.
   */
  const productionId = active?.layout.documentId ?? null;
  const setProductionId = useCallback(
    (id: string | null) => {
      if (!active) return;
      void patchLayout(active.manifest.id, { documentId: id });
    },
    [active, patchLayout]
  );

  // The universe actually opens only if it is entitled. Checked here, once, rather than in every
  // panel: see the single enforcement point in src/main/universes.ts.
  const opened = active && isOpen(active.entitlement);

  const { productions, refresh: refreshProductions } = useProductions(activeId === 'movie' && !!opened);
  const { production, edit, error: productionError } = useProduction(activeId === 'movie' ? productionId : null);

  useEffect(() => {
    window.electronAPI?.universes
      ?.generators()
      .then(setGenerators)
      .catch(() => {
        /* A main process without the namespace simply has no generators to report. */
      });
  }, []);

  // Open the most recent production rather than an empty workbench: the list is sorted by when
  // it was last worked on, so the first entry is almost always what someone came back for.
  useEffect(() => {
    if (activeId === 'movie' && !productionId && productions.length) setProductionId(productions[0].id);
  }, [activeId, productionId, productions]);

  // A shot selected in one production must not stay selected into the next.
  useEffect(() => {
    setSelectedShotId(null);
  }, [productionId]);

  /**
   * The line of orientation the floating chat carries.
   *
   * Not the production document: a model that needs the shot list has tools for reading it, and
   * pushing the whole thing into every turn would cost context on turns that are about something
   * else. This is what a person would say in passing — which film, how long the cut is, which
   * shot is up — so the conversation knows where it is standing.
   */
  const atomaContext = useMemo(() => {
    if (activeId !== 'movie' || !production) return `Universe: ${active?.manifest.name ?? 'none'}`;
    const shot = production.shots.find((entry) => entry.id === selectedShotId);
    const parts = [production.title, `${production.cut.length} shot${production.cut.length === 1 ? '' : 's'} in the cut`];
    if (shot) parts.push(`selected: ${shot.slug}`);
    return parts.join(' · ');
  }, [activeId, production, selectedShotId, active?.manifest.name]);

  const atomaPlacement = active?.layout.atoma ?? null;
  const atomaOpen = atomaPlacement?.open === true;
  const setAtoma = useCallback(
    (next: NonNullable<UniverseLayout['atoma']>) => {
      if (!active) return;
      void patchLayout(active.manifest.id, { atoma: next });
    },
    [active, patchLayout]
  );
  const toggleAtoma = useCallback(
    (open: boolean) => {
      setAtoma({
        open,
        // Null, not zero: the dock reads that as "never placed" and opens where a floating
        // assistant is looked for instead of in the top-left corner.
        x: atomaPlacement?.x ?? null,
        y: atomaPlacement?.y ?? null,
        width: atomaPlacement?.width ?? ATOMA_DEFAULT_WIDTH,
        height: atomaPlacement?.height ?? ATOMA_DEFAULT_HEIGHT,
      });
    },
    [atomaPlacement, setAtoma]
  );

  const panels = useMemo(() => (active ? resolvePanels(active.manifest, active.layout) : []), [active]);
  /**
   * The size a region is being dragged to, before it is stored.
   *
   * Kept locally for the duration of the drag rather than written through on every pointer move:
   * a resize is a hundred events a second and each one would be a disk write. The stored layout
   * catches up when the pointer is released.
   */
  const [liveSizes, setLiveSizes] = useState<Partial<Record<UniverseRegion, number>>>({});
  const sizeOf = (region: UniverseRegion) =>
    liveSizes[region] ?? active?.layout.sizes[region] ?? DEFAULT_REGION_SIZES[region];

  const resize = useCallback(
    (region: UniverseRegion, event: React.PointerEvent, sign: 1 | -1) => {
      if (!active) return;
      const start = sizeOf(region);
      let live = start;
      beginDrag(
        event,
        ({ dx, dy }) => {
          live = Math.max(140, Math.min(900, start + sign * (region === 'bottom' ? dy : dx)));
          setLiveSizes((current) => ({ ...current, [region]: live }));
        },
        () => {
          void patchLayout(active.manifest.id, { sizes: { [region]: live } });
          // Cleared so the stored layout is authoritative again; keeping it would make a later
          // change from elsewhere invisible behind a stale drag value.
          setLiveSizes((current) => {
            const next = { ...current };
            delete next[region];
            return next;
          });
        }
      );
    },
    [active, patchLayout]
  );

  const nudge = useCallback(
    (region: UniverseRegion, delta: number) => {
      if (!active) return;
      void patchLayout(active.manifest.id, { sizes: { [region]: Math.max(140, Math.min(900, sizeOf(region) + delta)) } });
    },
    [active, patchLayout]
  );

  const togglePanel = useCallback(
    (panel: UniversePanel) => {
      if (!active) return;
      void patchLayout(active.manifest.id, { open: { [panel.id]: !panel.open } });
    },
    [active, patchLayout]
  );

  const movePanel = useCallback(
    (panel: UniversePanel, region: UniverseRegion) => {
      if (!active) return;
      void patchLayout(active.manifest.id, { regions: { [panel.id]: region }, open: { [panel.id]: true } });
    },
    [active, patchLayout]
  );

  /** One panel, with the production state it needs. */
  const renderPanel = (panel: UniversePanel) => {
    if (activeId !== 'movie' || !production) {
      return (
        <Pane key={panel.id} title={panel.title}>
          <p className="p-3 text-xs text-ink-3">
            {activeId === 'movie' ? 'Open or create a production to work in.' : 'This universe has no workbench of its own yet.'}
          </p>
        </Pane>
      );
    }
    return (
      <MoviePanel
        key={panel.id}
        kind={panel.kind}
        production={production}
        edit={(edits) => void edit(edits)}
        selectedShotId={selectedShotId}
        onSelectShot={setSelectedShotId}
        generators={generators}
        onConfigureGenerators={() => setSettingsOpen(true)}
      />
    );
  };

  /** A column of panels, stacked. Several in one region share it rather than fighting for it. */
  const column = (region: UniverseRegion) => {
    const shown = panelsInRegion(panels, region);
    if (!shown.length) return null;
    return (
      <div className="flex min-h-0 min-w-0 flex-col divide-y divide-line">
        {shown.map((panel) => (
          <div key={panel.id} className="flex min-h-0 flex-1 flex-col">
            {renderPanel(panel)}
          </div>
        ))}
      </div>
    );
  };

  if (!ready) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-ink-3">Loading universes…</div>
    );
  }

  if (!universes?.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Layers size={22} className="text-ink-3" />
        <p className="text-sm text-ink">No universes are installed.</p>
        <p className="max-w-sm text-xs text-ink-3">
          {error || 'This build of Antimatter did not register any universes, which should not be possible — it ships with Code.'}
        </p>
        <button type="button" onClick={onLeave} className="mt-2 text-xs text-primary hover:underline">
          Back to chat
        </button>
      </div>
    );
  }

  const ActiveIcon = icon(active?.manifest.icon ?? 'Atom');
  const stages = active?.manifest.stages ?? [];
  const stageId = active?.layout.stageId ?? stages[0]?.id ?? null;
  const stage = stages.find((entry) => entry.id === stageId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col border-b border-line bg-surface-2">
        <div className="flex items-center gap-2 px-3 py-2">
          {/* The switcher. The concept's whole visible surface: one control that changes what
              kind of tool this is. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setSwitcherOpen((open) => !open)}
              aria-expanded={switcherOpen}
              className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink transition hover:border-primary/60"
            >
              <ActiveIcon size={14} className="text-primary" />
              {active?.manifest.name ?? 'Universe'}
              <ChevronDown size={12} className="text-ink-3" />
            </button>
            {switcherOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-md border border-line bg-surface-2 shadow-lg">
                {universes.map((entry) => {
                  const EntryIcon = icon(entry.manifest.icon);
                  const entryOpen = isOpen(entry.entitlement);
                  return (
                    <button
                      key={entry.manifest.id}
                      type="button"
                      onClick={() => {
                        setActiveId(entry.manifest.id);
                        setSwitcherOpen(false);
                      }}
                      className={`flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-surface-3 ${
                        entry.manifest.id === activeId ? 'bg-surface-3' : ''
                      }`}
                    >
                      <EntryIcon size={14} className="mt-0.5 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-xs text-ink">{entry.manifest.name}</span>
                          {!entryOpen && <Lock size={10} className="text-ink-3" />}
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-3">{entry.manifest.tagline}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* The production switcher. A universe's documents are its own, so this is beside the
              universe rather than in the application's sidebar. */}
          {activeId === 'movie' && opened && (
            <div className="flex items-center gap-1">
              <select
                value={productionId ?? ''}
                onChange={(event) => setProductionId(event.target.value || null)}
                className="rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink focus:border-primary/60 focus:outline-none"
              >
                <option value="">No production open</option>
                {productions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title} · {entry.shots} shot{entry.shots === 1 ? '' : 's'}
                    {entry.unrendered ? ` · ${entry.unrendered} to render` : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                title="New production"
                onClick={async () => {
                  const created = await window.electronAPI.movie.create('Untitled production').catch(() => null);
                  if (created) {
                    setProductionId(created.id);
                    await refreshProductions();
                  }
                }}
                className="rounded p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
              >
                <Plus size={14} />
              </button>
              {productionId && (
                <button
                  type="button"
                  title="Delete this production and every take in it"
                  onClick={async () => {
                    // Deleting takes tens of gigabytes of renders with it, so it asks.
                    const name = productions.find((entry) => entry.id === productionId)?.title ?? 'this production';
                    if (!window.confirm(`Delete ${name} and every take in it? This cannot be undone.`)) return;
                    await window.electronAPI.movie.remove(productionId).catch(() => undefined);
                    setProductionId(null);
                    await refreshProductions();
                  }}
                  className="rounded p-1.5 text-ink-3 hover:bg-surface-3 hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-1">
            {atoma && (
              <button
                type="button"
                onClick={() => toggleAtoma(!atomaOpen)}
                title="The conversation you had open, over this workbench"
                className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] transition ${
                  atomaOpen ? 'bg-primary/10 text-primary' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
                }`}
              >
                <Atom size={13} />
                Atoma
              </button>
            )}
            <button
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              title="Panels, generators and licences"
              className={`rounded p-1.5 transition ${settingsOpen ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:bg-surface-3 hover:text-ink'}`}
            >
              <Settings2 size={14} />
            </button>
            <button type="button" onClick={onLeave} className="px-2 text-xs text-ink-2 hover:text-ink">
              Done
            </button>
          </div>
        </div>

        {/* Stages. Not a wizard: they bring panels forward and never close anything, so the loop
            of cut-then-generate-then-cut is not something the workbench argues with. */}
        {stages.length > 0 && opened && (
          <div className="flex items-center gap-1 border-t border-line px-3 py-1.5">
            {stages.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  if (!active) return;
                  void patchLayout(active.manifest.id, {
                    stageId: entry.id,
                    open: Object.fromEntries(entry.panels.map((id) => [id, true])),
                  });
                }}
                className={`rounded px-2 py-1 text-[11px] transition ${
                  entry.id === stageId ? 'bg-primary/10 text-primary' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
                }`}
              >
                {entry.name}
              </button>
            ))}
            {stage?.intent && <span className="ml-2 truncate text-[10px] text-ink-3">{stage.intent}</span>}
          </div>
        )}
      </header>

      {!opened ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Lock size={20} className="text-ink-3" />
          <p className="text-sm text-ink">{active?.manifest.name} is not open on this machine.</p>
          <p className="max-w-sm text-xs text-ink-3">{active?.entitlement.reason}</p>
          {/* The work is never the thing withheld. Saying so here is the point: a lapsed licence
              closes the workbench and touches nothing the person made. */}
          <p className="max-w-sm text-[10px] text-ink-3">
            Nothing you made has been touched. Installing a licence opens it again.
          </p>
          <button type="button" onClick={() => setSettingsOpen(true)} className="mt-2 text-xs text-primary hover:underline">
            Open the licence manager
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {panelsInRegion(panels, 'left').length > 0 && (
              <>
                <div style={{ width: sizeOf('left') }} className="min-h-0 shrink-0 border-r border-line bg-surface-2">
                  {column('left')}
                </div>
                <RegionHandle orientation="vertical" onDrag={(event) => resize('left', event, 1)} onNudge={(delta) => nudge('left', delta)} />
              </>
            )}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{column('main') ?? <div className="flex-1 bg-surface" />}</div>

            {(panelsInRegion(panels, 'right').length > 0 || settingsOpen) && (
              <>
                <RegionHandle orientation="vertical" onDrag={(event) => resize('right', event, -1)} onNudge={(delta) => nudge('right', -delta)} />
                <div style={{ width: sizeOf('right') }} className="min-h-0 shrink-0 overflow-y-auto border-l border-line bg-surface-2">
                  {settingsOpen ? (
                    <div className="divide-y divide-line">
                      <WorkbenchPanel panels={panels} onToggle={togglePanel} onMove={movePanel} />
                      <GeneratorPanel generators={generators} onChanged={setGenerators} />
                      <LicencePanel universes={universes} onChanged={refresh} />
                    </div>
                  ) : (
                    column('right')
                  )}
                </div>
              </>
            )}
          </div>

          {panelsInRegion(panels, 'bottom').length > 0 && (
            <>
              <RegionHandle orientation="horizontal" onDrag={(event) => resize('bottom', event, -1)} onNudge={(delta) => nudge('bottom', -delta)} />
              <div style={{ height: sizeOf('bottom') }} className="min-h-0 shrink-0 border-t border-line bg-surface-2">
                {column('bottom')}
              </div>
            </>
          )}
        </div>
      )}

      {productionError && (
        <p className="shrink-0 border-t border-line bg-danger/10 px-3 py-1.5 text-[11px] text-danger">{productionError}</p>
      )}

      {/* Over the workbench rather than inside a region: the conversation is not a panel, and
          docking it would make it something you arrange instead of something you have open. */}
      {atomaOpen &&
        atoma?.({
          placement: atomaPlacement,
          onPlacement: setAtoma,
          onClose: () => toggleAtoma(false),
          context: atomaContext,
        })}
    </div>
  );
}

/** Where the workbench is rearranged: every panel, where it is, and whether it is up. */
function WorkbenchPanel({
  panels,
  onToggle,
  onMove,
}: {
  panels: UniversePanel[];
  onToggle: (panel: UniversePanel) => void;
  onMove: (panel: UniversePanel, region: UniverseRegion) => void;
}) {
  return (
    <Pane title="Workbench">
      <ul className="divide-y divide-line">
        {panels.map((panel) => (
          <li key={panel.id} className="flex items-center gap-2 px-3 py-2">
            <input
              id={`panel-${panel.id}`}
              type="checkbox"
              checked={panel.open}
              onChange={() => onToggle(panel)}
            />
            <label htmlFor={`panel-${panel.id}`} className="min-w-0 flex-1 truncate text-xs text-ink-2">
              {panel.title}
            </label>
            <select
              aria-label={`Where ${panel.title} sits`}
              value={panel.region}
              onChange={(event) => onMove(panel, event.target.value as UniverseRegion)}
              className="rounded border border-line bg-surface-3 px-1 py-0.5 text-[10px] text-ink focus:outline-none"
            >
              <option value="left">left</option>
              <option value="main">centre</option>
              <option value="right">right</option>
              <option value="bottom">bottom</option>
            </select>
          </li>
        ))}
      </ul>
      <p className="px-3 pb-3 pt-1 text-[10px] leading-relaxed text-ink-3">
        <Sliders size={10} className="mr-1 inline" />
        Your arrangement is kept per universe and survives an expansion update.
      </p>
    </Pane>
  );
}
