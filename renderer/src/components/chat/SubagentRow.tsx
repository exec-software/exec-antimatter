import { ChevronRight } from 'lucide-react';
import { agentFinished, PHASE_LABEL, subagentPhase } from '../../lib/conversation';
import { formatElapsedMilliseconds } from '../../lib/duration';
import { useNow } from '../../lib/useNow';
import { useAgentDefinitions, useAgentTask } from '../../plugins/agents/store';
import type { SubagentRef, ToolActivity } from '../../types';
import { AgentGlyph } from './AgentGlyph';
import { useConversationUi } from './conversationUi';

interface Props {
  activity: ToolActivity;
  /** True only while the turn that made this call is still running. */
  isActive: boolean;
}

const argsOf = (activity: ToolActivity): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(activity.args || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const rowClass =
  '-ml-1 flex min-h-8 w-[calc(100%+0.25rem)] min-w-0 items-center gap-2 rounded px-1 py-1 text-left transition enabled:hover:bg-surface-3/50 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70';

/** A call that started an agent, drawn as the agent rather than as a tool with arguments. */
export function SubagentRow({ activity, isActive }: Props) {
  const ref = activity.subagent;
  const args = argsOf(activity);
  const agentId = ref?.agentId ?? (typeof args.agent === 'string' ? args.agent : 'agent');
  const task = useAgentTask(ref?.taskId ?? null);
  const definitions = useAgentDefinitions();
  const definition = definitions.find((agent) => agent.id === agentId);
  const phase = subagentPhase(
    { status: activity.status, started: !!ref, finished: agentFinished(activity) },
    task,
    isActive
  );
  const running = phase === 'running' || phase === 'starting';
  const now = useNow(running);
  const { openSubagent } = useConversationUi();

  const name = ref?.agentName ?? definition?.name ?? agentId;
  const title = ref?.title ?? (typeof args.title === 'string' ? args.title : '');
  const brief = typeof args.task === 'string' ? args.task : '';
  const startedAt = task?.startedAt ?? null;
  const elapsed = startedAt ? formatElapsedMilliseconds((running ? now : task?.finishedAt ?? now) - startedAt) : '';
  const trouble = phase === 'failed' || phase === 'interrupted' || phase === 'unstarted';

  return (
    <button
      type="button"
      disabled={!ref}
      onClick={() => ref && openSubagent(ref.taskId)}
      // A start that never happened says why, where a brief would otherwise be.
      title={!ref && activity.result ? activity.result : brief || title || name}
      className={rowClass}
    >
      <AgentGlyph agentId={agentId} tags={definition?.tags} size={18} active={running} />
      <span className="shrink-0 text-[13px] font-medium text-ink">{name}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{title || brief}</span>
      <span
        className={`shrink-0 text-[11px] tabular-nums ${trouble ? 'text-danger' : running ? 'shimmer-text font-medium' : 'text-ink-3'}`}
      >
        {running && elapsed ? elapsed : PHASE_LABEL[phase]}
      </span>
      {ref && <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-ink-3" />}
    </button>
  );
}

/**
 * Where an agent's report reached the model. What the turn wrote after this was written with the
 * report in front of it, so the mark sits between the two.
 */
export function SubagentReportRow({ activity }: { activity: ToolActivity }) {
  const ref = activity.subagent;
  const args = argsOf(activity);
  const agentId = ref?.agentId ?? (typeof args.agent === 'string' ? args.agent : 'agent');
  const definitions = useAgentDefinitions();
  const definition = definitions.find((agent) => agent.id === agentId);
  const { openSubagent } = useConversationUi();
  const name = ref?.agentName ?? definition?.name ?? agentId;
  const ok = activity.status === 'done';

  return (
    <button
      type="button"
      disabled={!ref}
      onClick={() => ref && openSubagent(ref.taskId)}
      title={activity.result ?? ''}
      className={rowClass}
    >
      <AgentGlyph agentId={agentId} tags={definition?.tags} size={18} />
      <span className="shrink-0 text-[13px] text-ink-2">
        <span className="font-medium text-ink">{name}</span> {ok ? 'reported back' : 'stopped early'}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-3">{ref?.title ?? ''}</span>
      {ref && <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-ink-3" />}
    </button>
  );
}

/** "Explorer", "Explorer and Test writer", "Explorer, Test writer and 2 more". */
function names(refs: readonly SubagentRef[]): string {
  const shown = refs.slice(0, 2).map((ref) => ref.agentName);
  const rest = refs.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.join(' and ');
}

/** The turn has nothing to do until one of these reports. Said instead of "Thinking…". */
export function WaitingForAgents({ agents }: { agents: readonly SubagentRef[] }) {
  const definitions = useAgentDefinitions();
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 items-center gap-2 py-0.5">
      <span className="flex shrink-0 items-center gap-1">
        {agents.slice(0, 3).map((ref) => (
          <AgentGlyph
            key={ref.taskId}
            agentId={ref.agentId}
            tags={definitions.find((agent) => agent.id === ref.agentId)?.tags}
            size={16}
            active
          />
        ))}
      </span>
      <span className="shimmer-text truncate text-xs font-medium">Waiting for {names(agents)}</span>
    </div>
  );
}
