import { useState } from 'react';
import { Activity, ArrowRight, Check, CircleDot, ShieldCheck, TriangleAlert, Waypoints } from 'lucide-react';
import { AGENT_REPORT, conversationOutputs, startsAgent } from '../../lib/conversation';
import { flowGroups, flowTurns, type FlowLane } from '../../lib/flow';
import { formatClock, isActiveReply } from '../../lib/telemetry';
import type { Message } from '../../types';
import { useConversationUi } from '../chat/conversationUi';
import { MessageBody } from '../chat/MessageBody';
import { PinToggle } from '../chat/PinToggle';
import { SubagentReportRow, SubagentRow } from '../chat/SubagentRow';
import { ToolActivityCard } from '../chat/ToolActivityCard';
import { isVaultActivity, VaultActivityCard } from '../chat/VaultActivityCard';
import { isAskActivity, AskActivityCard } from '../chat/AskActivityCard';

interface Props {
  messages: Message[];
  isStreaming: boolean;
  pinnedMessageIds: Set<string>;
  onTogglePin(message: Message): void;
}

const LANES = [
  { id: 'approval', label: 'Needs you', icon: ShieldCheck, tone: 'text-primary', empty: 'No decisions waiting.' },
  { id: 'working', label: 'In progress', icon: CircleDot, tone: 'text-accent', empty: 'No actions running.' },
  { id: 'review', label: 'Needs review', icon: TriangleAlert, tone: 'text-danger', empty: 'No failed or interrupted actions.' },
  { id: 'done', label: 'Completed', icon: Check, tone: 'text-ink-2', empty: 'Finished actions appear here.' },
] as const;

/** The recorded work of a turn, grouped by its real state. No inferred tasks or progress bars. */
export function FlowView({ messages, isStreaming, pinnedMessageIds, onTogglePin }: Props) {
  const { assistantName = 'Antimatter' } = useConversationUi();
  const turns = flowTurns(messages);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lane, setLane] = useState<FlowLane | 'all'>('all');
  // Null follows the latest reply. A reader who selects history stays there during streaming.
  const selected = turns.find((turn) => turn.message.id === selectedId) ?? turns[turns.length - 1];
  const message = selected?.message;
  const active = !!selected && isActiveReply(selected.message, selected.index === messages.length - 1, isStreaming);
  const tools = message?.meta?.tools ?? [];
  const groups = flowGroups(tools, active);
  const outputs = message ? conversationOutputs([message]) : [];
  const live = turns.find((turn) => isActiveReply(turn.message, turn.index === messages.length - 1, isStreaming));
  const showLive = !!live && live.message.id !== message?.id;
  const choose = (id: string) => { setSelectedId(id || null); setLane('all'); };
  const lanes = LANES.filter((item) => lane === 'all' || lane === item.id);

  return <div className="absolute inset-0 flex min-w-0 flex-col bg-surface">
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3">
      <Waypoints size={17} className="text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-ink">Flow</h2>
        <p className="text-xs text-ink-3">The work behind a reply, as it happens.</p>
      </div>
      {turns.length > 0 && <label className="flex min-w-0 max-w-full items-center gap-2 text-xs text-ink-2">
        <span className="shrink-0">Reply</span>
        <select aria-label="Flow reply" value={selectedId && turns.some((turn) => turn.message.id === selectedId) ? selectedId : ''}
          onChange={(event) => choose(event.target.value)}
          className="min-w-0 max-w-[280px] rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-primary/50">
          <option value="">Follow latest reply</option>
          {turns.map((turn) => <option key={turn.message.id} value={turn.message.id}>#{turn.index + 1} · {turn.prompt.replace(/\s+/g, ' ').slice(0, 72)}</option>)}
        </select>
      </label>}
    </div>

    {showLive && <button type="button" onClick={() => choose('')}
      className="flex shrink-0 items-center justify-center gap-2 border-b border-primary/20 bg-primary/10 px-4 py-2 text-xs font-medium text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <Activity size={13} /> {live.message.meta?.tools?.some((tool) => tool.awaitingApproval) ? 'A live reply needs your attention' : 'A newer reply is running'} <ArrowRight size={13} />
    </button>}

    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
      {!selected || !message ? <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
        <Waypoints size={28} className="text-primary/70" />
        <h3 className="text-sm font-medium text-ink">A place to follow the work</h3>
        <p className="text-sm leading-relaxed text-ink-3">Tool calls, agent work, and approval requests collect here once a reply begins.</p>
      </div> : <div className="mx-auto max-w-[1600px] space-y-5">
        <section aria-label="Flow request" className="rounded-xl border border-line bg-surface-2/60 px-4 py-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
            <span className="font-medium uppercase tracking-wide">Your request</span>
            <span>Reply #{selected.index + 1}</span>
            {message.meta?.createdAt && <span>{formatClock(message.meta.createdAt)}</span>}
            {active && <span className="ml-auto inline-flex items-center gap-1.5 text-accent"><span className="size-1.5 rounded-full bg-accent" />Live reply</span>}
          </div>
          <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink" title={selected.prompt}>{selected.prompt}</p>
        </section>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter flow actions">
          <button type="button" aria-pressed={lane === 'all'} onClick={() => setLane('all')}
            className={`rounded-full border px-3 py-1.5 text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${lane === 'all' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-line text-ink-3 hover:text-ink'}`}>
            All actions <span className="ml-1 font-mono tabular-nums">{tools.length}</span>
          </button>
          {LANES.map(({ id, label, icon: Icon, tone }) => <button key={id} type="button" aria-pressed={lane === id}
            onClick={() => setLane((previous) => previous === id ? 'all' : id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${lane === id ? 'border-primary/50 bg-primary/10 text-ink' : 'border-line text-ink-3 hover:text-ink'}`}>
            <Icon size={12} className={groups[id].length ? tone : undefined} />{label}<span className="font-mono tabular-nums">{groups[id].length}</span>
          </button>)}
        </div>

        {tools.length ? <div className="grid items-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))' }}>
          {lanes.map(({ id, label, icon: Icon, tone, empty }) => <section key={id} aria-label={`Flow ${label}`} className="min-w-0 rounded-xl border border-line bg-surface-2/40">
            <h3 className="flex items-center gap-2 border-b border-line-soft px-3 py-3 text-xs font-semibold text-ink">
              <Icon size={14} className={tone} />{label}<span className="ml-auto font-mono text-[11px] font-normal tabular-nums text-ink-3">{groups[id].length}</span>
            </h3>
            <div className="space-y-2 p-2">
              {groups[id].length ? groups[id].map((activity, index) => <article key={`${message.id}:${activity.activityId ?? activity.callId}:${index}`}
                className="min-w-0 rounded-lg border border-line-soft bg-surface p-2">
                {startsAgent(activity) ? <SubagentRow activity={activity} isActive={active} />
                  : activity.toolName === AGENT_REPORT ? <SubagentReportRow activity={activity} />
                    : isAskActivity(activity) ? <AskActivityCard activity={activity} isActive={active} />
                    : isVaultActivity(activity) ? <VaultActivityCard activity={activity} isActive={active} />
                      : <ToolActivityCard activity={activity} isActive={active} />}
                <p className="mt-1 truncate px-1 text-[10px] text-ink-3" title={activity.serverName}>{activity.serverName}</p>
              </article>) : <p className="px-1 py-5 text-xs leading-relaxed text-ink-3">{empty}</p>}
            </div>
          </section>)}
        </div> : <div className="rounded-xl border border-dashed border-line px-4 py-5 text-sm text-ink-3">
          {active ? 'No tool actions yet. Model output appears below as it arrives.' : 'This reply used no tools. Its answer is below.'}
        </div>}

        {outputs.length > 0 && <section aria-label="Files changed in this reply" className="flex flex-wrap items-baseline gap-x-3 gap-y-2 text-xs">
          <h3 className="font-medium text-ink-2">Files changed</h3>
          {outputs.map((output) => <span key={output.path} title={output.path} className="max-w-full truncate rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-ink-3">{output.path}</span>)}
        </section>}

        <section aria-label="Flow reply content" className="rounded-xl border border-line bg-surface-2/30">
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
            <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{assistantName} <span className="font-normal text-ink-3">· {active ? 'Reply in progress' : message.meta?.failed ? 'Reply ended with an error' : 'Reply'}</span></h3>
            {(message.content || message.attachments?.length) && <PinToggle isPinned={pinnedMessageIds.has(message.id)} onToggle={() => onTogglePin(message)} />}
          </div>
          <div className="min-w-0 overflow-hidden px-4 py-4"><MessageBody message={message} isActive={active} showActions={false} /></div>
        </section>
      </div>}
    </div>
  </div>;
}
