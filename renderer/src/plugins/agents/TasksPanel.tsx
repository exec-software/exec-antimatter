import { useEffect, useState } from 'react';
import { CircleStop, Clock, ListTodo, Pause, Play, Send, Sparkles, Trash2, Wand2 } from 'lucide-react';
import type { AgentTask } from '../../types';
import { useShell } from '../shell';
import { actions, useAgents } from './store';
import { relativeTime, STATES } from './presentation';
import { SubagentSheet } from '../../components/chat/SubagentSheet';

/**
 * The queue.
 *
 * Everything an agent has been asked to do, whoever asked: a dispatch by hand, a route decided
 * by the main model, a scheduled run coming round again. One list, because the question people
 * actually have is "what is being worked on", and a schedule kept in its own tab makes that
 * question unanswerable without checking two places.
 */

const field = 'w-full rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
const label = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-3';
const button = 'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

/** Lets a running task show a ticking duration without the whole panel re-rendering on a timer. */
function useTicker(active: boolean): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => bump((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
}

function Composer({ onDone, scheduledOnly = false }: { onDone(): void; scheduledOnly?: boolean }) {
  const state = useAgents();
  const { workspace, sources } = useShell();
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState('');
  const [everyMinutes, setEvery] = useState(scheduledOnly ? '60' : '');
  const selected = state.agents.find((agent) => agent.id === agentId);

  const submit = async () => {
    const prompt = text.trim();
    if (!prompt || state.working) return;
    const minutes = everyMinutes.trim() ? Number(everyMinutes) : null;
    if ((scheduledOnly && minutes === null) || (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 1 || !agentId))) {
      actions.reportError('Choose an agent and a repeat interval of at least one minute for scheduled work.');
      return;
    }
    if (minutes && !workspace) {
      actions.reportError('Open a project workspace before scheduling unattended work.');
      return;
    }
    // An agent that pins no model should answer on whatever you are talking to.
    try {
      await window.electronAPI.agents.useSource(sources.activeProviderId, sources.activeModelId);
    } catch (error) {
      actions.reportError(error);
      return;
    }

    if (agentId) {
      const task = await actions.dispatch({
        agentId,
        // The first clause is a better label than a truncation of the whole brief.
        title: prompt.split(/[.\n]/)[0]?.slice(0, 58) || 'Untitled task',
        prompt,
        source: minutes ? 'schedule' : 'manual',
        workspace,
        everyMinutes: minutes,
      });
      if (!task) return;
    } else {
      // No agent chosen: let the main model decide who this belongs to.
      if (!await actions.route(prompt, workspace)) return;
    }
    setText('');
    setEvery('');
    onDone();
  };

  return (
    <div className="min-w-0 space-y-2 border-b border-line p-2.5">
      <div>
        <label className={label}>What needs doing</label>
        <textarea
          rows={3}
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
          }}
          placeholder="Review the changes in src/main and flag anything that can throw."
          className={`${field} resize-y font-sans`}
        />
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <div className="min-w-0">
          <label className={label}>Agent</label>
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)} className={field}>
            <option value="">{scheduledOnly ? 'Choose an agent' : 'Let the router choose'}</option>
            {state.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label className={label}>Repeat (minutes)</label>
          <input
            value={everyMinutes}
            onChange={(event) => setEvery(event.target.value.replace(/[^0-9]/g, ''))}
            placeholder="once"
            className={field}
          />
        </div>
      </div>
      <p className="truncate text-[10px] text-ink-3" title={workspace ?? undefined}>
        {workspace ? `Runs in ${workspace}` : 'Runs in the current workspace'}
      </p>
      {selected && <p className="text-[11px] text-ink-3">
        Model: {selected.model ? `${selected.provider || 'Matching source'} / ${selected.model}` : 'Agent profile or app default at run time'}.
        {' '}Access: {selected.access === 'full' ? 'Full access — may write files and run its allowed commands without approval.' : 'Read-only unattended — approval-required actions are declined.'}
      </p>}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={!text.trim() || state.working}
          onClick={() => void submit()}
          className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-on-primary transition hover:bg-primary-strong disabled:opacity-40"
        >
          {agentId ? <Send size={12} /> : <Wand2 size={12} />}
          {minutesLabel(everyMinutes, agentId)}
        </button>
        <button type="button" onClick={onDone} className={button}>
          Cancel
        </button>
        <span className="ml-auto text-[10px] text-ink-3">⌘↵</span>
      </div>
    </div>
  );
}

const minutesLabel = (minutes: string, agentId: string): string => minutes.trim() ? 'Create schedule' : agentId ? 'Dispatch' : 'Route it';

function Session({ task, onBack }: { task: AgentTask; onBack(): void }) {
  return <SubagentSheet width="100%" taskId={task.id} subagent={null} turnIsActive={task.state === 'running'} onClose={onBack} />;
}

function Row({ task }: { task: AgentTask }) {
  const state = useAgents();
  const [confirmDelete, setConfirmDelete] = useState(false);
  useTicker(task.state === 'running');

  const look = STATES[task.state];
  const agent = state.agents.find((agent) => agent.id === task.agentId);
  const agentName = agent?.name ?? task.agentId;
  const when = task.state === 'queued' && task.dueAt ? relativeTime(task.dueAt) : relativeTime(task.finishedAt ?? task.startedAt ?? task.createdAt);

  return (
    <div className="group flex min-w-0 items-start gap-1.5 border-b border-line-soft px-2.5 py-2">
      <button
        type="button"
        onClick={() => void actions.openSession(task.id)}
        className="min-w-0 flex-1 text-left"
        title={task.prompt}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide ${look.chip}`}>
            {task.paused && task.state !== 'running' ? 'Paused' : task.schedule && task.state === 'queued' ? 'Scheduled' : look.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{task.title}</span>
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-ink-3">
          {agentName} · {when}
          {task.summary ? ` · ${task.summary}` : ''}
          {task.error ? ` · ${task.error}` : ''}
        </span>
        {task.schedule && <span className="mt-1 block space-y-1 text-[11px] text-ink-3">
          <span className="block">{task.schedule} · {task.paused ? 'Future runs paused' : task.dueAt ? `Next: ${new Date(task.dueAt).toLocaleString()}` : 'Ready'}</span>
          <span className="block truncate" title={task.workspace ?? undefined}>Workspace: {task.workspace ?? 'App workspace at run time'}</span>
          <span className="block">Model: {agent?.model ? `${agent.provider || 'Matching source'} / ${agent.model}` : 'Agent profile or app default at run time'} · {agent?.access === 'full' ? 'Full access' : 'Read-only unattended'}</span>
          <span className="block">Last result: {task.finishedAt ? `${new Date(task.finishedAt).toLocaleString()} — ${task.error || task.summary || 'Finished'}` : 'Not run yet'}</span>
        </span>}
      </button>
      {task.schedule ? <div className="flex shrink-0 flex-col gap-1">
        <button type="button" disabled={state.working} onClick={() => void actions.setSchedulePaused(task.id, !task.paused)}
          className={button} title="A running task can finish; pausing prevents its next run.">
          {task.paused ? <Play size={12} /> : <Pause size={12} />}{task.paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" disabled={task.state === 'running' || state.working}
          onClick={() => { if (confirmDelete) void actions.removeTask(task.id); else setConfirmDelete(true); }}
          className={button} title={task.state === 'running' ? 'Pause this schedule and let the current run finish before deleting.' : 'Remove this schedule; existing carbon files are kept.'}>
          <Trash2 size={12} />{confirmDelete ? 'Confirm delete' : 'Delete'}
        </button>
        {confirmDelete && <button type="button" onClick={() => setConfirmDelete(false)} className={button}>Keep</button>}
      </div> : <button
        type="button"
        onClick={() => void (task.state === 'running' || task.state === 'queued' ? actions.cancelTask(task.id) : actions.removeTask(task.id))}
        title={task.state === 'running' || task.state === 'queued' ? 'Stop this task' : 'Remove from the list'}
        className="mt-0.5 shrink-0 rounded p-0.5 text-ink-3 opacity-0 transition group-hover:opacity-100 hover:text-danger"
      >
        {task.state === 'running' || task.state === 'queued' ? <CircleStop size={12} /> : <Trash2 size={12} />}
      </button>}
    </div>
  );
}

export function TasksPanel({ scheduledOnly = false }: { scheduledOnly?: boolean }) {
  const state = useAgents();
  const [composing, setComposing] = useState(false);

  const tasks = scheduledOnly ? state.tasks.filter((task) => !!task.schedule) : state.tasks;
  const open = state.openTaskId ? tasks.find((task) => task.id === state.openTaskId) : null;
  if (state.openTaskId && open) return <Session task={open} onBack={() => void actions.openSession(null)} />;

  const live = state.counts.running + state.counts.queued;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <ListTodo size={12} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2">
          {scheduledOnly ? `${tasks.filter((task) => !task.paused).length} active schedules · ${tasks.filter((task) => task.paused).length} paused` : `${live} queued/running · ${state.counts.done} done${state.counts.failed ? ` · ${state.counts.failed} failed` : ''}`}
        </span>
        {!composing && (
          <button type="button" onClick={() => setComposing(true)} className={`${button} shrink-0`}>
            <Sparkles size={12} />
            New
          </button>
        )}
      </div>
      {scheduledOnly && <p className="border-b border-line-soft px-3 py-2 text-xs leading-relaxed text-ink-3">
        Schedules run on this computer while Antimatter is open, including in the tray. Keep it awake and its inference source available.
        The first run starts when created; subsequent runs wait the chosen interval after completion. Pausing lets a current run finish.
      </p>}

      {state.error && (
        <button
          type="button"
          onClick={() => actions.clearError()}
          className="shrink-0 border-b border-danger/40 bg-danger/10 px-2.5 py-1.5 text-left text-[11px] text-danger"
        >
          {state.error}
        </button>
      )}

      {composing && <Composer scheduledOnly={scheduledOnly} onDone={() => setComposing(false)} />}

      {!scheduledOnly && state.lastRoute && (
        <p className="min-w-0 shrink-0 border-b border-line-soft bg-surface-3/50 px-2.5 py-1.5 text-[10px] text-ink-3">
          Routed to <span className="text-ink-2">{state.lastRoute.agentName}</span> — {state.lastRoute.why}
          {state.lastRoute.guessed ? ' (by wording; the model was unreachable)' : ''}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="px-2.5 py-4 text-[11px] text-ink-3">
            <p className="flex items-center gap-1.5">
              <Clock size={12} />
              {scheduledOnly ? 'No scheduled work yet.' : 'Nothing queued.'}
            </p>
            <p className="mt-1.5">
              Dispatch an agent, or describe the work and let the main model pick one. Give it a repeat
              interval and it becomes a scheduled task.
            </p>
          </div>
        ) : (
          tasks.map((task) => <Row key={task.id} task={task} />)
        )}
      </div>
    </div>
  );
}
