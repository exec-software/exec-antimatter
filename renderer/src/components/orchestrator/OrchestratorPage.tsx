import { useCallback, useEffect, useState } from 'react';
import { Check, CircleStop, Clock, Play, RotateCw, TriangleAlert, Waypoints, X } from 'lucide-react';
import type { OrchestratorLog, OrchestratorSnapshot, ToolActivity, WorkflowReport } from '../../types';
import { formatElapsedSeconds } from '../../lib/duration';
import { formatSeconds } from '../../lib/telemetry';
import { AtomIndicator } from '../status/AtomIndicator';

interface Props {
  onClose: () => void;
}

const MAX_LOG = 40;
const card = 'rounded-xl border border-line bg-surface-2 p-3';
const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

const elapsed = (since: number) => formatSeconds(Math.max(0, (Date.now() - since) / 1000));

export function OrchestratorPage({ onClose }: Props) {
  const [snapshot, setSnapshot] = useState<OrchestratorSnapshot | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowReport | null>(null);
  const [logs, setLogs] = useState<OrchestratorLog[]>([]);
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    window.electronAPI.orchestrator.snapshot().then(setSnapshot).catch(console.error);
    window.electronAPI.orchestrator.workflow().then(setWorkflow).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const stopLog = window.electronAPI.onOrchestratorLog((entry) =>
      setLogs((prev) => [...prev.slice(-(MAX_LOG - 1)), entry])
    );
    const stopActivity = window.electronAPI.onOrchestratorActivity((next) =>
      setActivity((prev) => {
        const sameCall = (entry: ToolActivity) =>
          entry.requestId === next.requestId &&
          (entry.activityId ?? entry.callId) === (next.activityId ?? next.callId);
        const known = prev.some(sameCall);
        return known
          ? prev.map((entry) => (sameCall(entry) ? { ...entry, ...next } : entry))
          : [...prev.slice(-19), next];
      })
    );
    return () => {
      stopLog();
      stopActivity();
    };
  }, []);

  const run = async (action: 'start' | 'stop' | 'tick') => {
    setBusy(true);
    setError('');
    try {
      setSnapshot(await window.electronAPI.orchestrator[action]());
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const config = workflow?.config ?? null;
  const active = snapshot?.active ?? false;
  const running = snapshot?.running ?? [];
  const retrying = snapshot?.retrying ?? [];

  return (
    <div className="absolute inset-0 overflow-y-auto bg-surface">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
        <Waypoints size={16} className="text-primary" />
        <h1 className="text-sm font-semibold text-ink">Orchestrator</h1>
        <span className="text-[11px] text-ink-3">
          {active ? 'active' : 'stopped'} · {running.length} running · {retrying.length} queued · poll{' '}
          {((snapshot?.pollIntervalMs ?? 0) / 1000).toFixed(0)}s ·
          max {snapshot?.maxConcurrentAgents ?? 0}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {busy && <AtomIndicator phase="thinking" size={14} />}
          <button type="button" onClick={() => run('start')} disabled={busy || !workflow?.ok || active} className={button}>
            <Play size={12} />
            Start
          </button>
          <button type="button" onClick={() => run('tick')} disabled={busy || !workflow?.ok || !active} className={button}>
            <RotateCw size={12} />
            Poll now
          </button>
          <button type="button" onClick={() => run('stop')} disabled={busy || !active} className={button}>
            <CircleStop size={12} />
            Stop
          </button>
          <button type="button" onClick={onClose} className={button}>
            <X size={12} />
            Done
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 py-5">
        <p className="text-xs text-ink-2">
          Reads work from the tracker named in <code className="font-mono text-[11px]">WORKFLOW.md</code>, gives each issue
          its own workspace, and runs an agent session there through Antimatter's own provider and tools.
        </p>
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ink-3">
          <Waypoints size={12} className="mt-0.5 shrink-0 text-ink-3" />
          Every dispatch owns isolated tool-server processes for its workspace, so agent work cannot redirect an active
          chat or another agent.
        </p>

        {/* Workflow report — why dispatch would or would not proceed. */}
        <section className={`mt-3 ${card}`}>
          <div className="flex flex-wrap items-center gap-2">
            {workflow?.ok ? (
              <Check size={13} className="shrink-0 text-accent" />
            ) : (
              <TriangleAlert size={13} className="shrink-0 text-danger" />
            )}
            <h2 className="text-sm font-semibold text-ink">Workflow</h2>
            <code className="truncate font-mono text-[11px] text-ink-3">{workflow?.path ?? '…'}</code>
          </div>

          {workflow && !workflow.ok && (
            <ul className="mt-2 grid gap-1">
              {workflow.problems.map((problem) => (
                <li key={problem} className="text-[11px] text-danger">
                  {problem}
                </li>
              ))}
            </ul>
          )}

          {config && (
            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
              {[
                ['tracker', `${config.tracker.kind ?? 'none'} · ${config.tracker.endpoint || '—'}`],
                ['active states', config.tracker.activeStates.join(', ')],
                ['workspaces', config.workspaceRoot],
                ['agents', `${config.agent.maxConcurrentAgents} concurrent · ${config.agent.maxTurns} turns`],
                ['model', `${config.runner.providerId ?? 'first source'} · ${config.runner.model ?? 'first model'}`],
                ['approvals', config.runner.approvalPolicy ?? 'reads and writes only'],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="uppercase tracking-wide text-ink-3">{label}</dt>
                  <dd className="truncate font-mono text-ink-2">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        {error && (
          <p className="mt-3 flex items-start gap-1.5 text-[11px] text-danger">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        {/* Running sessions. */}
        <section className="mt-3">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Running</h2>
          {running.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[11px] text-ink-3">
              {active ? 'The loop is active; no issue is running right now.' : 'Nothing running. Start the loop to dispatch work.'}
            </p>
          ) : (
            <div className="grid gap-2">
              {running.map((session) => (
                <div key={session.issueId} className={card}>
                  <div className="flex flex-wrap items-center gap-2">
                    <AtomIndicator phase="streaming" size={14} />
                    <span className="font-mono text-[11px] text-primary">{session.identifier}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{session.title}</span>
                    <span className="text-[11px] text-ink-3">{session.phase}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-ink-3">
                    {session.state} · attempt {session.attempt ?? 0} · turn {session.turnCount} · {elapsed(session.startedAt)}
                    {session.sessionId ? ` · ${session.sessionId}` : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Retry queue. */}
        {retrying.length > 0 && (
          <section className="mt-3">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Queued</h2>
            <div className="grid gap-2">
              {retrying.map((entry) => (
                <div key={entry.issueId} className={`${card} flex flex-wrap items-center gap-2`}>
                  <Clock size={12} className="shrink-0 text-ink-3" />
                  <span className="font-mono text-[11px] text-ink">{entry.identifier}</span>
                  <span className="text-[11px] text-ink-3">
                    attempt {entry.attempt} · due in {formatElapsedSeconds((entry.dueAt - Date.now()) / 1000)}
                  </span>
                  {entry.error && <span className="min-w-0 flex-1 truncate text-[11px] text-danger">{entry.error}</span>}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Tool calls made by agent sessions. */}
        {activity.length > 0 && (
          <section className="mt-3">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Tool calls</h2>
            <div className="grid gap-1">
              {activity.map((entry) => (
                <div
                  key={`${entry.requestId}:${entry.activityId ?? entry.callId}`}
                  className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5"
                >
                  <span className="font-mono text-[11px] text-ink">{entry.toolName}</span>
                  <span className="text-[10px] uppercase tracking-wide text-ink-3">{entry.tier}</span>
                  <span
                    className={`ml-auto text-[11px] ${
                      entry.status === 'done' ? 'text-accent' : entry.status === 'failed' ? 'text-danger' : 'text-ink-3'
                    }`}
                  >
                    {entry.status}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Totals and log. */}
        <section className="mt-3">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Totals</h2>
          <p className="text-[11px] text-ink-2">
            {snapshot?.totals.totalTokens ?? 0} tokens ({snapshot?.totals.inputTokens ?? 0} in ·{' '}
            {snapshot?.totals.outputTokens ?? 0} out) · {formatSeconds(snapshot?.totals.secondsRunning ?? 0)} of agent time
          </p>
        </section>

        {logs.length > 0 && (
          <section className="mt-3">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-3">Log</h2>
            <pre className="max-h-64 overflow-auto rounded-lg border border-line-soft bg-surface-0 p-2 font-mono text-[10px] leading-relaxed">
              {logs
                .map(
                  (entry) =>
                    `${new Date(entry.at).toLocaleTimeString()} ${entry.level.padEnd(5)} ${
                      entry.issueIdentifier ? `${entry.issueIdentifier} ` : ''
                    }${entry.message}`
                )
                .join('\n')}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}
