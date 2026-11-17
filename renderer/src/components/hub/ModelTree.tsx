import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Boxes, GripVertical, Network, Pencil, Star, X } from 'lucide-react';
import type { ModelWorkloadsView } from '../../../../src/api/modelWorkloads';
import type { Model, ProviderConfig } from '../../types';

/**
 * The Model Library as a tree, because the hierarchy already existed and only the view hid it.
 *
 * ADR 0001 settled the levels: a model is what inference exists, a workload is one named
 * launchable configuration of it, and an orchestration profile composes workloads across models.
 * The page rendered that as a flat paginated grid of model cards with an unrelated profiles
 * section beneath, and the ADR records the result in its own words — the section "was read as
 * belonging to the model above ... by the project's own author", which is why the middle level
 * had nowhere to appear.
 *
 * So: model at the root, its workloads as children, and nothing else competing for the same
 * space. Settings do not live in the tree at all. Selecting a node tells the page what to show
 * beside it, which is what keeps a row readable for someone with one local model and still has
 * somewhere to put a node list for someone striping across boxes.
 */

export interface TreeEntry {
  source: ProviderConfig;
  model: Model;
}

/** What the page is showing beside the tree. A model row and a workload row are both selectable. */
export interface TreeSelection {
  sourceId: string;
  modelId: string;
  /** Absent selects the model itself rather than one of its workloads. */
  workloadId?: string;
}

interface Props {
  entries: TreeEntry[];
  selection: TreeSelection | null;
  onSelect: (selection: TreeSelection) => void;
  /** The model answering this conversation, marked so it is findable without reading every row. */
  current: { providerId: string; modelId: string };
  /** `sourceId:modelId` of everything actually in memory. */
  resident: Set<string>;
  /**
   * Rename a model's display name. Absent makes the tree read-only, which is what a caller that
   * cannot persist a name should pass rather than offering a control that silently does nothing.
   */
  onRename?: (sourceId: string, modelId: string, name: string) => void;
  /** Move `key` to sit before `before`, or to the end when `before` is null. */
  onReorder?: (key: string, before: string | null) => void;
}

const key = (sourceId: string, modelId: string) => `${sourceId}:${modelId}`;

const same = (a: TreeSelection | null, b: TreeSelection): boolean =>
  !!a && a.sourceId === b.sourceId && a.modelId === b.modelId && (a.workloadId ?? null) === (b.workloadId ?? null);

/**
 * Workloads are fetched per model and only once expanded.
 *
 * A library can hold more models than anyone has opened, and every one of them would otherwise
 * cost an IPC round trip to render a row that is collapsed. The cache is keyed by model so
 * collapsing and expanding again is free, and a failed read is remembered as an error rather
 * than retried forever on each render.
 */
function useWorkloads() {
  const [cache, setCache] = useState<Record<string, ModelWorkloadsView | 'loading' | 'error'>>({});
  const pending = useRef(new Set<string>());

  const load = useCallback((sourceId: string, modelId: string) => {
    const id = key(sourceId, modelId);
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setCache((previous) => ({ ...previous, [id]: 'loading' }));
    window.electronAPI.modelWorkloads
      .list(sourceId, modelId)
      .then((view: ModelWorkloadsView) => setCache((previous) => ({ ...previous, [id]: view })))
      .catch((cause: unknown) => {
        console.error('Could not read workloads for', id, cause);
        setCache((previous) => ({ ...previous, [id]: 'error' }));
      })
      .finally(() => pending.current.delete(id));
  }, []);

  return { cache, load };
}

export function ModelTree({ entries, selection, onSelect, current, resident, onRename, onReorder }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** The row being renamed, and the text so far. Null when nothing is being renamed. */
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null);
  /** The row being dragged, and the row it would land before, so the gap is visible while held. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const { cache, load } = useWorkloads();

  const commitRename = (sourceId: string, modelId: string) => {
    if (!renaming) return;
    const name = renaming.value.trim();
    setRenaming(null);
    // An empty name is a cancel, not a request to have no name: a nameless row cannot be found
    // again to fix. Unchanged text is also a cancel, so a stray click writes nothing.
    if (name) onRename?.(sourceId, modelId, name);
  };

  // Open the branch holding whatever is selected, so a selection made elsewhere — the chat's own
  // model, or a workload chosen from another page — is visible rather than hidden in a closed row.
  useEffect(() => {
    if (!selection) return;
    const id = key(selection.sourceId, selection.modelId);
    setExpanded((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));
  }, [selection]);

  useEffect(() => {
    for (const id of expanded) {
      if (cache[id] === undefined) {
        const [sourceId, ...rest] = id.split(':');
        load(sourceId, rest.join(':'));
      }
    }
  }, [expanded, cache, load]);

  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!entries.length) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-ink-3">
        No models match. Clear the search, or connect a source under Manage connections.
      </p>
    );
  }

  return (
    <ul role="tree" aria-label="Model Library" className="space-y-0.5">
      {entries.map(({ source, model }) => {
        const id = key(source.id, model.id);
        const open = expanded.has(id);
        const view = cache[id];
        const loaded = typeof view === 'object' ? view : null;
        const inChat = source.id === current.providerId && model.id === current.modelId;
        const modelSelected = same(selection, { sourceId: source.id, modelId: model.id });
        return (
          <li
            key={id}
            role="treeitem"
            aria-expanded={open}
            aria-selected={modelSelected}
            draggable={!!onReorder && renaming?.key !== id}
            onDragStart={(event) => {
              setDragging(id);
              event.dataTransfer.effectAllowed = 'move';
              // Some environments refuse a drag with no payload at all.
              event.dataTransfer.setData('text/plain', id);
            }}
            onDragEnd={() => {
              setDragging(null);
              setDropBefore(null);
            }}
            onDragOver={(event) => {
              if (!onReorder || !dragging || dragging === id) return;
              // Without this the drop never fires: the default handling rejects it.
              event.preventDefault();
              setDropBefore(id);
            }}
            onDrop={(event) => {
              if (!onReorder || !dragging) return;
              event.preventDefault();
              if (dragging !== id) onReorder(dragging, id);
              setDragging(null);
              setDropBefore(null);
            }}
            className={dropBefore === id && dragging !== id ? 'border-t-2 border-accent' : undefined}
          >
            <div
              className={`group flex items-center gap-1 rounded-md px-1.5 py-1.5 transition ${
                modelSelected ? 'bg-accent/15' : 'hover:bg-surface-2'
              } ${dragging === id ? 'opacity-40' : ''}`}
            >
              {onReorder && (
                <GripVertical
                  size={12}
                  className="shrink-0 cursor-grab text-ink-3 opacity-0 transition group-hover:opacity-100"
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                onClick={() => toggle(id)}
                aria-label={open ? `Collapse ${model.name ?? model.id}` : `Expand ${model.name ?? model.id}`}
                className="rounded p-0.5 text-ink-3 hover:text-ink"
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              {renaming?.key === id ? (
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Boxes size={14} className="shrink-0 text-accent" aria-hidden="true" />
                  <input
                    autoFocus
                    value={renaming.value}
                    aria-label={`Rename ${model.name || model.id}`}
                    onChange={(event) => setRenaming({ key: id, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename(source.id, model.id);
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                    // Committing on blur as well as on Enter: clicking away from a half-typed
                    // name reads as accepting it, and losing the edit there is its own annoyance.
                    onBlur={() => commitRename(source.id, model.id)}
                    className="min-w-0 flex-1 rounded border border-primary/60 bg-surface px-1.5 py-0.5 text-sm text-ink focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="Save name"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => commitRename(source.id, model.id)}
                    className="shrink-0 rounded p-0.5 text-ink-3 hover:text-ink"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel rename"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setRenaming(null)}
                    className="shrink-0 rounded p-0.5 text-ink-3 hover:text-ink"
                  >
                    <X size={13} />
                  </button>
                </span>
              ) : (
              <button
                type="button"
                onClick={() => onSelect({ sourceId: source.id, modelId: model.id })}
                onDoubleClick={() => onRename && setRenaming({ key: id, value: model.name || model.id })}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Boxes size={14} className={modelSelected ? 'text-accent' : 'text-ink-3'} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink" title={model.id}>
                    {model.name || model.id}
                  </span>
                  <span className="block truncate text-[11px] text-ink-3">{source.name}</span>
                </span>
                {resident.has(id) && (
                  <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] text-success">loaded</span>
                )}
                {inChat && (
                  <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">in this chat</span>
                )}
              </button>
              )}
              {onRename && renaming?.key !== id && (
                <button
                  type="button"
                  aria-label={`Rename ${model.name || model.id}`}
                  onClick={() => setRenaming({ key: id, value: model.name || model.id })}
                  className="shrink-0 rounded p-0.5 text-ink-3 opacity-0 transition hover:text-ink group-hover:opacity-100"
                >
                  <Pencil size={11} />
                </button>
              )}
            </div>

            {open && (
              <ul role="group" className="ml-[22px] border-l border-line pl-2">
                {view === 'loading' && <li className="px-2 py-1.5 text-[11px] text-ink-3">Reading workloads…</li>}
                {view === 'error' && (
                  <li className="px-2 py-1.5 text-[11px] text-danger">Could not read this model&rsquo;s workloads.</li>
                )}
                {loaded?.workloads.map((workload) => {
                  const picked = same(selection, { sourceId: source.id, modelId: model.id, workloadId: workload.id });
                  const distributed = (workload.settings.nodes?.length ?? 0) > 0;
                  return (
                    <li key={workload.id} role="treeitem" aria-selected={picked}>
                      <button
                        type="button"
                        onClick={() => onSelect({ sourceId: source.id, modelId: model.id, workloadId: workload.id })}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition ${
                          picked ? 'bg-accent/15' : 'hover:bg-surface-2'
                        }`}
                      >
                        {distributed ? (
                          <Network size={12} className={picked ? 'text-accent' : 'text-ink-3'} aria-hidden="true" />
                        ) : (
                          <span className="inline-block h-3 w-3" aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{workload.name}</span>
                        {workload.id === loaded.defaultId && (
                          <Star size={11} className="text-ink-3" aria-label="Default workload" />
                        )}
                        {distributed && (
                          <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-3">
                            {workload.settings.nodes!.length} nodes
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
                {loaded && !loaded.workloads.length && (
                  <li className="px-2 py-1.5 text-[11px] text-ink-3">No workloads yet.</li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
