import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  CircleX,
  FlaskConical,
  Hammer,
  RefreshCw,
  Save,
  Trash2,
  Zap,
} from 'lucide-react';
import type { ItemStatus, ItemValue, SnitchItem, SnitchProject } from '../../types';
import { actions } from './store';
import { relativeTime, STAGES, STATUS_LABELS, VALUE_LABELS } from './presentation';

/**
 * One issue or request, open for editing, with the pipeline attached to it.
 *
 * The fix button is the whole reason this panel exists inside a coding assistant rather than in
 * a separate tracker: the bug report is already the brief, so dispatching it is one click and no
 * retyping. What the run will actually touch — the repository — is on the button, not buried in
 * settings, because that is the part a person needs to agree with before pressing it.
 */

interface Props {
  project: SnitchProject;
  item: SnitchItem;
  busy: boolean;
  onBack(): void;
}

const field = 'w-full rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
const label = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-3';
const button = 'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

/** Only the fields this form owns, so a new `updated` stamp does not read as an unsaved edit. */
const signature = (item: SnitchItem) =>
  JSON.stringify([item.title, item.status, item.value, item.releaseId, item.description, item.steps, item.expected, item.actual]);

export function ItemDetail({ project, item, busy, onBack }: Props) {
  const [draft, setDraft] = useState(item);
  const dirty = signature(draft) !== signature(item);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // The agent fixing this item edits the same file. An untouched form follows those edits; a
  // form with unsaved changes in it does not, because losing typing to a background write is
  // the one failure here nobody would forgive.
  useEffect(() => {
    if (!dirtyRef.current) setDraft(item);
  }, [item]);

  // The pipeline is never edited here, so it is read from the item and stays live even while
  // the rest of the form is holding unsaved changes.
  const pipeline = item.pipeline;
  const stage = STAGES[pipeline.stage];
  const dispatched = pipeline.stage !== 'idle';
  const running = ['queued', 'fixing', 'qa'].includes(pipeline.stage);
  const valueLabel = draft.kind === 'issue' ? 'Severity' : 'Priority';

  const patch = (change: Partial<SnitchItem>) => setDraft((current) => ({ ...current, ...change }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <button type="button" onClick={onBack} className="rounded p-0.5 text-ink-3 transition hover:text-ink">
          <ChevronRight size={13} className="rotate-180" />
        </button>
        <span className="font-mono text-[11px] text-primary">{draft.id}</span>
        <span className="text-[10px] uppercase tracking-wide text-ink-3">{draft.kind}</span>
        <span className="ml-auto text-[10px] text-ink-3">{relativeTime(draft.updated)}</span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2.5">
        {/* The pipeline card comes first: when something is running, it is the answer to the
            question the panel was opened to ask. */}
        <section className={`rounded-lg border p-2.5 ${stage.chip}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            {running ? <Hammer size={13} className="animate-pulse" /> : <FlaskConical size={13} />}
            <span className="text-xs font-semibold">{stage.label}</span>
            {pipeline.attempt > 0 && <span className="text-[10px] opacity-80">cycle {pipeline.attempt + 1}</span>}
            {pipeline.failures > 0 && <span className="text-[10px] opacity-80">retry {pipeline.failures}/3</span>}
            <span className="ml-auto text-[10px] opacity-70">{relativeTime(pipeline.updatedAt)}</span>
          </div>
          <p className="mt-1 text-[11px] opacity-80">{stage.hint}</p>
          {pipeline.note && (
            <p className="mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-surface-0/50 p-1.5 text-[10px] leading-relaxed text-ink-2">
              {pipeline.note}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {!dispatched && (
              <button
                type="button"
                disabled={busy || !project.repo}
                onClick={() => void actions.fix(project.name, draft.id)}
                title={
                  project.repo
                    ? `Run an agent in ${project.repo}, then a QA pass over what it changed`
                    : 'Set this project’s repository in Settings first'
                }
                className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-on-primary transition hover:bg-primary-strong disabled:opacity-40"
              >
                <Zap size={12} />
                Fix it
              </button>
            )}
            {running && (
              <button type="button" disabled={busy} onClick={() => void actions.cancelFix(project.name, draft.id)} className={button}>
                <CircleX size={12} />
                Stop
              </button>
            )}
            {dispatched && !running && (
              <>
                <button type="button" disabled={busy} onClick={() => void actions.acknowledge(project.name, draft.id)} className={button}>
                  <CircleX size={12} />
                  Clear
                </button>
                <button
                  type="button"
                  disabled={busy || !project.repo}
                  onClick={async () => {
                    await actions.acknowledge(project.name, draft.id);
                    await actions.fix(project.name, draft.id);
                  }}
                  className={button}
                >
                  <RefreshCw size={12} />
                  Run again
                </button>
              </>
            )}
            {!project.repo && !dispatched && (
              <span className="text-[10px] text-ink-3">No repository set for {project.name}.</span>
            )}
            {project.repo && !dispatched && (
              <span className="truncate font-mono text-[10px] text-ink-3" title={project.repo}>
                in {project.repo}
              </span>
            )}
          </div>
        </section>

        <div>
          <label className={label}>Title</label>
          <input className={field} value={draft.title} onChange={(event) => patch({ title: event.target.value })} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label}>Status</label>
            <select
              className={field}
              value={draft.status}
              onChange={(event) => patch({ status: event.target.value as ItemStatus })}
            >
              {(Object.keys(STATUS_LABELS) as ItemStatus[]).map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>{valueLabel}</label>
            <select
              className={field}
              value={draft.value}
              onChange={(event) => patch({ value: event.target.value as ItemValue })}
            >
              {(Object.keys(VALUE_LABELS) as ItemValue[]).map((value) => (
                <option key={value} value={value}>
                  {VALUE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={label}>Release</label>
          <select
            className={field}
            value={draft.releaseId ?? ''}
            onChange={(event) => patch({ releaseId: event.target.value || null })}
          >
            <option value="">Unassigned</option>
            {project.releases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.version} · {release.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={label}>Description</label>
          <textarea
            rows={4}
            className={`${field} resize-y font-sans`}
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </div>

        <div>
          <label className={label}>Steps to reproduce (one per line)</label>
          <textarea
            rows={3}
            className={`${field} resize-y`}
            value={draft.steps.join('\n')}
            onChange={(event) => patch({ steps: event.target.value.split('\n').map((step) => step.trim()).filter(Boolean) })}
          />
        </div>

        <div className="grid gap-2">
          <div>
            <label className={label}>Expected</label>
            <textarea
              rows={2}
              className={`${field} resize-y`}
              value={draft.expected}
              onChange={(event) => patch({ expected: event.target.value })}
            />
          </div>
          <div>
            <label className={label}>Actual</label>
            <textarea
              rows={2}
              className={`${field} resize-y`}
              value={draft.actual}
              onChange={(event) => patch({ actual: event.target.value })}
            />
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-2.5 py-2">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void actions.updateItem(project.name, draft)}
          className={`${button} ${dirty ? 'border-primary/60 text-ink' : ''}`}
        >
          <Save size={12} />
          Save
        </button>
        {dirty && (
          <button type="button" onClick={() => setDraft(item)} className={button}>
            Revert
          </button>
        )}
        <span className="ml-auto" />
        <button
          type="button"
          disabled={busy}
          onClick={() => void actions.deleteItems(project.name, [draft.id])}
          className={`${button} hover:border-danger/60 hover:text-danger`}
        >
          <Trash2 size={12} />
          Delete
        </button>
      </div>
    </div>
  );
}
