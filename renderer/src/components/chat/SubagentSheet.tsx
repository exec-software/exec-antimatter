import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, CircleStop, Send } from 'lucide-react';
import { formatElapsedMilliseconds } from '../../lib/duration';
import { useFollowScroll } from '../../lib/useFollowScroll';
import { useNow } from '../../lib/useNow';
import { actions, useAgentDefinitions, useAgentRun, useAgentTask } from '../../plugins/agents/store';
import { carbonActions, PHASE_LABEL, subagentPhase, type ConversationSubagent } from '../../lib/conversation';
import type { Message } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';
import { AgentGlyph } from './AgentGlyph';
import { MarkdownContent } from './MarkdownContent';
import { MessageBody } from './MessageBody';

interface Props {
  width: number | string;
  taskId: string;
  /** What the conversation knows about the run: who, what, and the report it returned. */
  subagent: ConversationSubagent | null;
  /** True while the turn that started it is still running. */
  turnIsActive: boolean;
  onClose(): void;
}

/**
 * One subagent's run, opened from the conversation.
 *
 * While this window has been watching, the run is drawn the way a turn is — its notes and its
 * tool calls in the order they happened. A run from before the window opened is read back from
 * its carbon instead, which says the same things less prettily.
 */
export function SubagentSheet({ width, taskId, subagent, turnIsActive, onClose }: Props) {
  const task = useAgentTask(taskId);
  const run = useAgentRun(taskId);
  const definitions = useAgentDefinitions();
  const [briefOpen, setBriefOpen] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');

  const agentId = task?.agentId ?? subagent?.agentId ?? 'agent';
  const definition = definitions.find((agent) => agent.id === agentId);
  const phase = subagentPhase(
    { status: subagent?.status ?? 'running', started: true, finished: subagent?.finished ?? false },
    task,
    turnIsActive
  );
  const queued = task?.state === 'queued';
  const running = !queued && (phase === 'running' || phase === 'starting');
  const now = useNow(running);
  const live = run.content.length > 0 || run.tools.length > 0;

  useEffect(() => {
    setBriefOpen(false);
    setGuidance('');
    setNotice('');
  }, [taskId]);

  const sendGuidance = async () => {
    if (!guidance.trim() || sending) return;
    setSending(true);
    try {
      await window.electronAPI.agents.sendMessage(taskId, guidance.trim());
      setGuidance('');
      setNotice('Guidance sent. The agent will apply it at its next step.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const pseudo = useMemo<Message>(
    () => ({
      id: `subagent:${taskId}`,
      role: 'assistant',
      content: run.content,
      meta: {
        createdAt: task?.startedAt ?? Date.now(),
        finishedAt: task?.finishedAt ?? undefined,
        failed: task?.state === 'failed' || task?.state === 'cancelled',
        tools: run.tools,
      },
    }),
    [taskId, run.content, run.tools, task?.startedAt, task?.finishedAt, task?.state]
  );

  const { scrollRef, contentRef, onScroll } = useFollowScroll(run.content.length + run.tools.length, pseudo);

  const name = subagent?.agentName ?? definition?.name ?? agentId;
  const title = task?.title ?? subagent?.title ?? '';
  const took = task?.startedAt ? formatElapsedMilliseconds((running ? now : task.finishedAt ?? now) - task.startedAt) : '';
  const trouble = phase === 'failed' || phase === 'interrupted' || phase === 'cancelled';

  return (
    <aside
      aria-label={`${name}: ${title}`}
      style={{ width }}
      className="pointer-events-auto flex h-full max-w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface-2/95 shadow-xl shadow-black/40 backdrop-blur"
    >
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-line-soft px-3 py-2.5">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to the conversation panel"
          title="Back"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          <ArrowLeft size={15} />
        </button>
        <AgentGlyph agentId={agentId} tags={definition?.tags} size={22} active={running} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">{name}</p>
          <p className="truncate text-[11px] text-ink-3" title={title}>
            {title}
          </p>
        </div>
        <span
          className={`shrink-0 text-[11px] tabular-nums ${trouble ? 'text-danger' : running ? 'shimmer-text font-medium' : 'text-ink-3'}`}
        >
          {queued ? task?.paused ? 'Paused' : task?.schedule ? 'Scheduled' : 'Queued' : PHASE_LABEL[phase]}
          {took ? ` · ${took}` : ''}
        </span>
        {(running || queued) && (
          <button
            type="button"
            onClick={() => void actions.cancelTask(taskId)}
            aria-label={`Stop ${name}`}
            title="Stop this agent. The conversation hears that it was stopped."
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-3 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            <CircleStop size={15} />
          </button>
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div ref={contentRef} className="min-w-0">
          {task?.prompt && (
            <div className="mb-3">
              <button
                type="button"
                onClick={() => setBriefOpen((current) => !current)}
                aria-expanded={briefOpen}
                className="flex items-center gap-1 text-[12px] text-ink-3 transition hover:text-ink-2"
              >
                <ChevronRight size={13} className={`transition-transform ${briefOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
                The brief it was given
              </button>
              {briefOpen && (
                <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-surface-3 px-3 py-2 text-[13px] leading-5 text-ink-2">
                  {task.prompt}
                </p>
              )}
            </div>
          )}

          {live ? (
            <MessageBody message={pseudo} isActive={running} />
          ) : queued ? (
            <p className="text-[13px] text-ink-3">{task?.paused ? 'This schedule is paused. Resume it from Scheduled to run again.' : task?.dueAt ? `Scheduled for ${new Date(task.dueAt).toLocaleString()}.` : 'Waiting to start.'}</p>
          ) : running ? (
            <div role="status" className="flex items-center gap-2 py-0.5">
              <AtomIndicator phase="thinking" size={16} />
              <span className="shimmer-text text-xs font-medium">Working…</span>
            </div>
          ) : run.record ? (
            <MarkdownContent content={carbonActions(run.record)} tone="muted" />
          ) : subagent?.report ? (
            <MarkdownContent content={subagent.report} />
          ) : (
            <p className="text-[13px] text-ink-3">Nothing was recorded for this run.</p>
          )}

          {task?.error && !running && <p className="mt-3 text-[12px] text-danger">{task.error}</p>}
        </div>
      </div>
      {running && (
        <form className="shrink-0 border-t border-line p-3" onSubmit={(event) => { event.preventDefault(); void sendGuidance(); }}>
          <label htmlFor={`agent-guidance-${taskId}`} className="mb-1 block text-[11px] text-ink-3">Guide this agent</label>
          <div className="flex gap-2">
            <input id={`agent-guidance-${taskId}`} value={guidance} onChange={(event) => setGuidance(event.target.value)}
              maxLength={12000} placeholder="Add context or correct its direction…"
              className="min-w-0 flex-1 rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-primary" />
            <button type="submit" disabled={!guidance.trim() || sending} aria-label="Send guidance to agent"
              className="rounded-md p-2 text-ink-2 hover:bg-surface-3 disabled:opacity-40"><Send size={14} /></button>
          </div>
          {notice && <p role="status" className="mt-1.5 text-[11px] text-ink-3">{notice}</p>}
        </form>
      )}
    </aside>
  );
}
