import { useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, FileDiff, FilePlus2, Paperclip, Plus } from 'lucide-react';
import {
  conversationOutputs,
  conversationSources,
  conversationSubagents,
  PHASE_LABEL,
  splitPath,
  subagentPhase,
  type ConversationSubagent,
  type SubagentPhase,
} from '../../lib/conversation';
import { formatElapsedMilliseconds } from '../../lib/duration';
import { useNow } from '../../lib/useNow';
import { useAgentDefinitions, useAgents } from '../../plugins/agents/store';
import type { AgentTask, Message } from '../../types';
import { AgentGlyph } from './AgentGlyph';

interface Props {
  width: number;
  messages: Message[];
  /** True while this conversation's turn is still running. */
  isActive: boolean;
  onOpenSubagent(taskId: string): void;
  onAttach(): void;
}

/** Keep the floating panel useful before any one section takes over its scroll area. */
const OUTPUT_LIMIT = 5;
const AGENT_LIMIT = 5;

const kilobytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: { label: string; onClick(): void };
  children: ReactNode;
}) {
  return (
    <section className="border-t border-line-soft px-4 py-3 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-2">
          {title}
          {count !== undefined ? <span className="ml-1.5 tabular-nums text-ink-3">{count}</span> : null}
        </h2>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            aria-label={action.label}
            title={action.label}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            <Plus size={15} />
          </button>
        )}
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-[13px] leading-5 text-ink-3">{children}</p>
);

function More({
  total,
  limit,
  expanded,
  onChange,
}: {
  total: number;
  limit: number;
  expanded: boolean;
  onChange(expanded: boolean): void;
}) {
  if (total <= limit) return null;
  return (
    <button
      type="button"
      onClick={() => onChange(!expanded)}
      aria-expanded={expanded}
      className="mt-1 rounded px-1 py-0.5 text-[12px] text-ink-3 transition hover:bg-surface-3/70 hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
    >
      {expanded ? 'Show fewer' : `${total - limit} more`}
    </button>
  );
}

interface Standing {
  subagent: ConversationSubagent;
  task: AgentTask | null;
  phase: SubagentPhase;
}

function SubagentLine({ standing, tags, now, onOpen }: { standing: Standing; tags?: string[]; now: number; onOpen(): void }) {
  const { subagent, task, phase } = standing;
  const running = phase === 'running' || phase === 'starting';
  const took = task?.startedAt ? formatElapsedMilliseconds((running ? now : task.finishedAt ?? now) - task.startedAt) : '';
  return (
    <button
      type="button"
      onClick={onOpen}
      title={subagent.title}
      className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-surface-3/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
    >
      <AgentGlyph agentId={subagent.agentId} tags={tags} size={18} active={running} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{subagent.agentName}</span>
        <span className="block truncate text-[11px] text-ink-3">{subagent.title}</span>
      </span>
      <span
        className={`shrink-0 text-[11px] tabular-nums ${
          phase === 'failed' || phase === 'interrupted' || phase === 'unstarted'
            ? 'text-danger'
            : running
              ? 'text-accent'
              : 'text-ink-3'
        }`}
      >
        {running && took ? took : PHASE_LABEL[phase]}
      </span>
    </button>
  );
}

/**
 * What the conversation has made, who it has working, and what it was given.
 *
 * It floats beside the transcript rather than inside it: the chat is the model's, and the agents
 * it sends off are background to that — visible at a glance, open on a click, and never between
 * the person and the answer.
 */
export function ConversationCard({
  width,
  messages,
  isActive,
  onOpenSubagent,
  onAttach,
}: Props) {
  const { tasks } = useAgents();
  const definitions = useAgentDefinitions();
  const outputs = useMemo(() => conversationOutputs(messages), [messages]);
  const sources = useMemo(() => conversationSources(messages), [messages]);
  const subagents = useMemo(() => conversationSubagents(messages), [messages]);
  const [showAll, setShowAll] = useState({ outputs: false, subagents: false });
  const [listOpen, setListOpen] = useState(false);
  const [openError, setOpenError] = useState('');

  const standings: Standing[] = subagents.map((subagent) => {
    const task = tasks.find((candidate) => candidate.id === subagent.taskId) ?? null;
    // The turn that owns a call is only live if it is the latest assistant message.
    const live = isActive && messages[messages.length - 1]?.id === subagent.messageId;
    const phase = subagentPhase({ status: subagent.status, started: true, finished: subagent.finished }, task, live);
    return { subagent, task, phase };
  });
  const running = standings.filter((standing) => standing.phase === 'running' || standing.phase === 'starting');
  const done = standings.filter((standing) => standing.phase === 'done');
  const stopped = standings.length - running.length - done.length;
  const now = useNow(running.length > 0);
  // Running first, then the most recent, which is what someone opening this is looking for.
  const ordered = [...running, ...standings.filter((standing) => !running.includes(standing)).reverse()];
  const tagsOf = (agentId: string) => definitions.find((agent) => agent.id === agentId)?.tags;

  const summary = [
    running.length ? `${running.length} running` : '',
    done.length ? `${done.length} done` : '',
    stopped ? `${stopped} stopped` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const open = async (path: string) => {
    setOpenError('');
    try {
      await window.electronAPI.outputs.open(path);
    } catch (error) {
      setOpenError((error as Error).message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''));
    }
  };

  const visibleOutputs = showAll.outputs ? outputs : outputs.slice(0, OUTPUT_LIMIT);
  const visibleAgents = showAll.subagents ? ordered : ordered.slice(0, AGENT_LIMIT);

  return (
    <aside
      aria-label="This conversation"
      style={{ width }}
      className="pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-2xl border border-line bg-surface-2/95 shadow-xl shadow-black/40 backdrop-blur"
    >
      <div className="min-h-0 overflow-y-auto">
        <Section title="Outputs" count={outputs.length}>
          {outputs.length === 0 ? (
            <Empty>Files this conversation writes are listed here.</Empty>
          ) : (
            <>
              <ul className="space-y-0.5">
                {visibleOutputs.map((output) => {
                  const { name, directory } = splitPath(output.path);
                  const Icon = output.edited ? FileDiff : FilePlus2;
                  return (
                    <li key={output.path}>
                      <button
                        type="button"
                        onClick={() => void open(output.path)}
                        title={`${output.edited ? 'Edited' : 'Wrote'} ${output.path}`}
                        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-surface-3/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                      >
                        <Icon size={15} className="shrink-0 text-ink-3" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</span>
                        {directory && <span className="max-w-[45%] shrink truncate text-[11px] text-ink-3">{directory}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <More
                total={outputs.length}
                limit={OUTPUT_LIMIT}
                expanded={showAll.outputs}
                onChange={(expanded) => setShowAll((current) => ({ ...current, outputs: expanded }))}
              />
              {openError && <p className="mt-1 text-[11px] text-danger">{openError}</p>}
            </>
          )}
        </Section>

        <Section title="Subagents">
          {standings.length === 0 ? (
            <Empty>Work the conversation hands to an agent shows up here while it runs.</Empty>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setListOpen((current) => !current)}
                aria-expanded={listOpen || running.length > 0}
                className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-surface-3/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
              >
                <span className="flex shrink-0 items-center gap-1">
                  {ordered.slice(0, 4).map((standing) => (
                    <AgentGlyph
                      key={standing.subagent.taskId}
                      agentId={standing.subagent.agentId}
                      tags={tagsOf(standing.subagent.agentId)}
                      size={18}
                      active={standing.phase === 'running' || standing.phase === 'starting'}
                    />
                  ))}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{summary}</span>
                <ChevronRight
                  size={14}
                  aria-hidden="true"
                  className={`shrink-0 text-ink-3 transition-transform ${listOpen || running.length > 0 ? 'rotate-90' : ''}`}
                />
              </button>
              {(listOpen || running.length > 0) && (
                <div className="mt-1 space-y-0.5">
                  {visibleAgents.map((standing) => (
                    <SubagentLine
                      key={standing.subagent.taskId}
                      standing={standing}
                      tags={tagsOf(standing.subagent.agentId)}
                      now={now}
                      onOpen={() => onOpenSubagent(standing.subagent.taskId)}
                    />
                  ))}
                  <More
                    total={ordered.length}
                    limit={AGENT_LIMIT}
                    expanded={showAll.subagents}
                    onChange={(expanded) => setShowAll((current) => ({ ...current, subagents: expanded }))}
                  />
                </div>
              )}
            </>
          )}
        </Section>

        <Section title="Sources" count={sources.length} action={{ label: 'Attach files', onClick: onAttach }}>
          {sources.length === 0 ? (
            <Empty>Attach files for the conversation to read.</Empty>
          ) : (
            <ul className="space-y-0.5">
              {sources.map((source) => (
                <li key={source.id} className="flex min-w-0 items-center gap-2 py-1" title={source.name}>
                  <Paperclip size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{source.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-3">{kilobytes(source.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </aside>
  );
}
