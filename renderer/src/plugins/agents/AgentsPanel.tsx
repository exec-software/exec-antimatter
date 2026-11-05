import { useEffect, useState } from 'react';
import { ArrowLeft, Bot, ChevronRight, Cpu, FolderOpen, Plus, Save, Send, Trash2, Wrench, X } from 'lucide-react';
import type { AccessMode, AgentDefinition } from '../../types';
import { useShell } from '../shell';
import { actions, useAgents } from './store';
import { relativeTime } from './presentation';

/**
 * The roster.
 *
 * An agent is a file: a name, a brief, the model that suits it, and the tools it is allowed to
 * touch. That is deliberate — "hundreds of specialised agents" only works if adding one is
 * writing a paragraph rather than writing code, and this panel is that paragraph with a form
 * around it.
 */

const field = 'w-full rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
const label = 'mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-3';
const button = 'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

/** Short enough for a card corner; the tooltip carries the meaning. */
const ACCESS_LABELS: Record<AccessMode, string> = { read: 'read-only', ask: 'needs approval', full: 'read/write' };

const BLANK: AgentDefinition = {
  id: '',
  name: '',
  description: '',
  tags: [],
  provider: null,
  model: null,
  tools: [],
  maxRounds: 8,
  access: 'read',
  prompt: '',
  path: '',
  builtin: false,
};

/** Turns a name into an id on first type, and then leaves it alone so edits do not fight. */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

function Editor({ agent, onBack }: { agent: AgentDefinition; onBack(): void }) {
  const state = useAgents();
  const { sources, openModelLibrary } = useShell();
  const [draft, setDraft] = useState(agent);
  const creating = !agent.id;
  const set = (patch: Partial<AgentDefinition>) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    const id = draft.id || slug(draft.name);
    if (!id || !draft.name.trim()) return;
    await actions.saveAgent({ ...draft, id });
    onBack();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <button type="button" onClick={onBack} className="rounded p-0.5 text-ink-3 transition hover:text-ink">
          <ArrowLeft size={13} />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          {creating ? 'New agent' : draft.name}
        </span>
        {!creating && <span className="shrink-0 font-mono text-[10px] text-ink-3">{draft.id}</span>}
      </div>

      <div className="min-h-0 min-w-0 flex-1 space-y-2.5 overflow-y-auto p-2.5">
        <div>
          <label className={label}>Name</label>
          <input value={draft.name} onChange={(event) => set({ name: event.target.value })} className={field} />
        </div>
        <div>
          <label className={label}>What it is for</label>
          <input
            value={draft.description}
            onChange={(event) => set({ description: event.target.value })
            }
            placeholder="Reviews a diff and reports what will break."
            className={field}
          />
          <p className="mt-1 text-[10px] text-ink-3">
            The router reads this to decide what belongs here, so say what makes it different.
          </p>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <div className="min-w-0">
            <label className={label}>Tags</label>
            <input
              value={draft.tags.join(', ')}
              onChange={(event) => set({ tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })}
              placeholder="code, review"
              className={field}
            />
          </div>
          <div className="min-w-0">
            <label className={label}>Round limit</label>
            <input
              value={String(draft.maxRounds)}
              onChange={(event) => set({ maxRounds: Math.max(1, Number(event.target.value.replace(/[^0-9]/g, '')) || 1) })}
              className={field}
            />
          </div>
        </div>
        <div>
          <label className={label}>Model</label>
          <div className="flex min-w-0 gap-1.5">
            <button
              type="button"
              onClick={() => {
                openModelLibrary({
                  providerId: draft.provider,
                  modelId: draft.model,
                  title: `Choose a model for ${draft.name.trim() || 'this agent'}`,
                  description:
                    'Pick an exact source and model for this agent. Model prompts, limits, architecture, and routing stay editable on the same card.',
                  actionLabel: 'Use for this agent',
                  selectedLabel: 'Assigned to this agent',
                  onSelect: (providerId, modelId) => set({ provider: providerId, model: modelId }),
                });
              }}
              className={`${field} flex min-w-0 flex-1 items-center gap-2 text-left`}
              aria-label="Choose this agent's model from the Model Library"
            >
              <Cpu size={12} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">
                {draft.model
                  ? `${sources.providers.find((source) => source.id === draft.provider)?.name ?? draft.provider ?? 'Missing source'} · ${draft.model}`
                  : 'Whatever chat is using'}
              </span>
              <ChevronRight size={12} className="shrink-0 text-ink-3" />
            </button>
            {draft.model && (
              <button
                type="button"
                onClick={() => set({ provider: null, model: null })}
                className={`${button} shrink-0 px-1.5`}
                title="Use the current chat model"
                aria-label="Use the current chat model"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <p className="mt-1 text-[10px] text-ink-3">
            {draft.model
              ? 'Pinned to this exact source and model. Clear it to follow the current chat instead.'
              : 'A narrow agent can inherit the chat model, or pin a smaller model and leave the big one free.'}
          </p>
        </div>
        <div>
          <label className={label}>Unattended access</label>
          <select
            value={draft.access}
            onChange={(event) => set({ access: event.target.value as AccessMode })}
            className={field}
          >
            <option value="read">Read only — cannot change anything</option>
            <option value="full">Read and write — edits files, runs what it is allowed</option>
            <option value="ask">Ask first — every change is refused when unattended</option>
          </select>
          <p className="mt-1 text-[10px] text-ink-3">
            {draft.access === 'ask'
              ? 'There is nobody to ask during a run, so this agent will be refused every write.'
              : draft.access === 'full'
                ? 'Bounded by the tool list below and by the workspace the task names.'
                : 'It can read and report, and nothing else.'}
          </p>
        </div>
        <div>
          <label className={label}>Tools it may call</label>
          <input
            value={draft.tools.join(', ')}
            onChange={(event) => set({ tools: event.target.value.split(',').map((tool) => tool.trim()).filter(Boolean) })}
            placeholder="read_file, list_directory"
            className={`${field} font-mono`}
          />
          <p className="mt-1 text-[10px] text-ink-3">
            Empty means everything the permission mode already allows. Listing tools here only ever
            narrows that — an agent cannot grant itself anything. Include read_skill to allow this
            agent to load local skills; existing explicit tool lists are not expanded automatically.
          </p>
        </div>
        <div>
          <label className={label}>Standing brief</label>
          <textarea
            rows={8}
            value={draft.prompt}
            onChange={(event) => set({ prompt: event.target.value })}
            placeholder="You are a careful reviewer. Read the change, then report only what is actually wrong."
            className={`${field} resize-y font-sans leading-relaxed`}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-2.5 py-1.5">
        <button
          type="button"
          disabled={!draft.name.trim() || state.working}
          onClick={() => void save()}
          className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-on-primary transition hover:bg-primary-strong disabled:opacity-40"
        >
          <Save size={12} />
          Save
        </button>
        {!creating && (
          <button
            type="button"
            onClick={async () => {
              await actions.removeAgent(draft.id);
              onBack();
            }}
            className={`${button} hover:border-danger/60 hover:text-danger`}
          >
            <Trash2 size={12} />
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function Card({ agent, running }: { agent: AgentDefinition; running: number }) {
  const { workspace, sources } = useShell();
  const [editing, setEditing] = useState(false);

  if (editing) return <Editor agent={agent} onBack={() => setEditing(false)} />;

  return (
    <div className="group min-w-0 border-b border-line-soft px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <Bot size={13} className={`shrink-0 ${running ? 'animate-pulse text-primary' : 'text-ink-3'}`} />
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-ink hover:text-primary"
          title={`Edit ${agent.name}`}
        >
          {agent.name}
        </button>
        {running > 0 && (
          <span className="shrink-0 rounded border border-primary/50 bg-primary/10 px-1 py-0.5 text-[9px] text-primary">
            {running} running
          </span>
        )}
        <button
          type="button"
          title={`Dispatch ${agent.name} in the current workspace`}
          onClick={async () => {
            await window.electronAPI.agents.useSource(sources.activeProviderId, sources.activeModelId);
            void actions.dispatch({
              agentId: agent.id,
              title: `${agent.name} run`,
              prompt: `Do what you are for, here. Start by looking at what is in front of you.`,
              workspace,
            });
          }}
          className="shrink-0 rounded p-0.5 text-ink-3 opacity-0 transition group-hover:opacity-100 hover:text-primary"
        >
          <Send size={12} />
        </button>
      </div>
      <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-2">{agent.description}</p>
      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-ink-3">
        {agent.tags.length > 0 && <span className="truncate">{agent.tags.join(' · ')}</span>}
        <span
          className="ml-auto shrink-0"
          title={
            agent.access === 'full'
              ? 'May change files and run what its tool list allows'
              : agent.access === 'ask'
                ? 'Every change is refused: there is nobody to approve one during a run'
                : 'Reads and reports only'
          }
        >
          {ACCESS_LABELS[agent.access]}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Wrench size={9} />
          {agent.tools.length || 'all'}
        </span>
      </p>
    </div>
  );
}

export function AgentsPanel() {
  const state = useAgents();
  const [creating, setCreating] = useState(false);
  const [root, setRoot] = useState('');

  useEffect(() => {
    window.electronAPI.agents.location().then(setRoot).catch(console.error);
  }, []);

  if (creating) return <Editor agent={BLANK} onBack={() => setCreating(false)} />;

  const runningFor = (id: string) => state.active.filter((entry) => entry.agentId === id && entry.state === 'running').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <Bot size={12} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2">
          {state.agents.length} agent{state.agents.length === 1 ? '' : 's'} ·{' '}
          {state.active.filter((entry) => entry.state === 'running').length} active
        </span>
        <button type="button" onClick={() => setCreating(true)} className={`${button} shrink-0`}>
          <Plus size={12} />
          New
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.active.length > 0 && (
          <div className="min-w-0 border-b border-line bg-surface-3/40 px-2.5 py-2">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-3">In session</p>
            {state.active.map((entry) => (
              <button
                key={entry.taskId}
                type="button"
                onClick={() => void actions.openSession(entry.taskId)}
                className="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-left text-[11px] text-ink-2 hover:text-ink"
                title="Open this session"
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${entry.state === 'running' ? 'animate-pulse bg-primary' : 'bg-line'}`}
                />
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                <span className="shrink-0 text-[10px] text-ink-3">
                  {entry.state === 'running' ? relativeTime(entry.startedAt) : 'queued'}
                </span>
              </button>
            ))}
          </div>
        )}

        {state.agents.map((agent) => (
          <Card key={agent.id} agent={agent} running={runningFor(agent.id)} />
        ))}
      </div>

      {root && (
        <p
          className="flex shrink-0 items-center gap-1.5 border-t border-line px-2.5 py-1.5 text-[10px] text-ink-3"
          title={root}
        >
          <FolderOpen size={10} className="shrink-0" />
          <span className="min-w-0 truncate font-mono">{root}</span>
        </p>
      )}
    </div>
  );
}
