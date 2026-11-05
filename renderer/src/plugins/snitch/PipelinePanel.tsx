import { useCallback, useEffect, useState } from 'react';
import { CircleStop, Hammer, Play, RotateCw, TriangleAlert, Zap } from 'lucide-react';
import type { OrchestratorLog, OrchestratorSnapshot, WorkflowReport } from '../../types';
import { AtomIndicator } from '../../components/status/AtomIndicator';
import { useShell } from '../shell';
import { actions, useSnitch } from './store';
import { relativeTime, STAGES } from './presentation';

/**
 * What the fix pipeline is doing, across every project.
 *
 * Snitch dispatches through the orchestrator rather than running anything itself, so this panel
 * shows both halves: the items and their stages, and whether the loop that moves them is even
 * running. A queued item and a stopped orchestrator look identical from the item's side, which
 * is exactly the confusion this is here to prevent.
 */

const MAX_LOG = 24;
const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

export function PipelinePanel() {
  const state = useSnitch();
  const { openPage } = useShell();
  const [snapshot, setSnapshot] = useState<OrchestratorSnapshot | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowReport | null>(null);
  const [logs, setLogs] = useState<OrchestratorLog[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    window.electronAPI.orchestrator.snapshot().then(setSnapshot).catch(console.error);
    window.electronAPI.orchestrator.workflow().then(setWorkflow).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 2500);
    const stop = window.electronAPI.onOrchestratorLog((entry) =>
      setLogs((prev) => [...prev.slice(-(MAX_LOG - 1)), entry])
    );
    return () => {
      window.clearInterval(timer);
      stop();
    };
  }, [refresh]);

  const control = async (action: 'start' | 'stop' | 'tick') => {
    setBusy(true);
    try {
      setSnapshot(await window.electronAPI.orchestrator[action]());
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
      refresh();
      void actions.refreshLists();
    }
  };

  const running = snapshot?.running ?? [];
  const entries = state.pipeline;
  // Without this, the Fix button queues work that nothing will ever pick up.
  const wrongTracker = workflow?.config != null && workflow.config.tracker.kind !== 'snitch';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <Zap size={12} className="text-primary" />
        <span className="text-[11px] text-ink-2">
          {entries.filter((entry) => entry.stage !== 'verified' && entry.stage !== 'failed').length} in flight ·{' '}
          {running.length} running
        </span>
        {busy && <AtomIndicator phase="thinking" size={12} />}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => void control('start')} disabled={busy || !workflow?.ok} className={button}>
            <Play size={11} />
            Start
          </button>
          <button type="button" onClick={() => void control('tick')} disabled={busy || !workflow?.ok} className={button}>
            <RotateCw size={11} />
            Poll
          </button>
          <button type="button" onClick={() => void control('stop')} disabled={busy} className={button}>
            <CircleStop size={11} />
            Stop
          </button>
        </div>
      </div>

      {(wrongTracker || workflow?.ok === false) && (
        <div className="flex items-start gap-1.5 border-b border-line bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {wrongTracker
              ? `WORKFLOW.md is reading its work from the "${workflow?.config?.tracker.kind}" tracker, so nothing dispatched here will run. Set tracker.kind to snitch.`
              : workflow?.problems.join('; ')}
          </span>
          <button type="button" onClick={() => openPage('orchestrator')} className="shrink-0 underline">
            open
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {entries.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-ink-3">
            Nothing dispatched. Press <Zap size={10} className="inline" /> on an issue to have it fixed, checked and
            handed back.
          </p>
        ) : (
          <div className="grid gap-1.5">
            {entries.map((entry) => {
              const stage = STAGES[entry.stage];
              const live = running.find((session) => session.identifier === entry.itemId);
              return (
                <div key={`${entry.project}/${entry.itemId}`} className="rounded-lg border border-line bg-surface-2 p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {live ? <AtomIndicator phase="streaming" size={12} /> : <Hammer size={11} className="text-ink-3" />}
                    <span className="font-mono text-[10px] text-ink-3">{entry.project}</span>
                    <span className="font-mono text-[10px] text-primary">{entry.itemId}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-ink">{entry.title}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${stage.chip}`}>
                      {stage.label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-ink-3">
                    {entry.attempt > 0 ? `cycle ${entry.attempt + 1} · ` : ''}
                    {entry.failures > 0 ? `retry ${entry.failures}/${3} · ` : ''}
                    {live ? `${live.phase} · turn ${live.turnCount} · ` : ''}
                    {relativeTime(entry.updatedAt)}
                    {entry.repo ? ` · ${entry.repo}` : ' · no repository set'}
                  </p>
                  {entry.note && (
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[10px] leading-relaxed text-ink-2">
                      {entry.note}
                    </p>
                  )}
                  {(entry.stage === 'verified' || entry.stage === 'failed') && (
                    <button
                      type="button"
                      onClick={() => void actions.acknowledge(entry.project, entry.itemId)}
                      className={`${button} mt-1.5`}
                    >
                      Clear
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {logs.length > 0 && (
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-line-soft bg-surface-0 p-2 font-mono text-[10px] leading-relaxed text-ink-2">
            {logs
              .map(
                (entry) =>
                  `${new Date(entry.at).toLocaleTimeString()} ${entry.level.padEnd(5)} ${
                    entry.issueIdentifier ? `${entry.issueIdentifier} ` : ''
                  }${entry.message}`
              )
              .join('\n')}
          </pre>
        )}
      </div>
    </div>
  );
}
