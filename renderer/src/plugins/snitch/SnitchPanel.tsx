import { useMemo, useState } from 'react';
import {
  Bug,
  ChevronRight,
  CirclePlus,
  FolderGit2,
  Hammer,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import type { ItemKind, ItemStatus, ItemValue, SnitchItem } from '../../types';
import { useShell } from '../shell';
import { ItemDetail } from './ItemDetail';
import { actions, useSnitch, type SnitchTab } from './store';
import { relativeTime, STAGES, STATUS_LABELS, VALUE_DOTS, VALUE_LABELS } from './presentation';

/**
 * Snitch, as a tool window: every project's bugs and requests in one list, and a button that
 * hands one of them to the orchestrator.
 *
 * The panel is built for a docked column three hundred pixels wide, so it is a list that becomes
 * a detail view rather than a split — the same reason JetBrains' tool windows drill down instead
 * of tiling. Floating it just makes the same column bigger.
 */

const field =
  'w-full rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';
const chip = 'rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide';
const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

type Filter = 'all' | 'open' | 'issue' | 'request' | 'running';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'all', label: 'All' },
  { id: 'issue', label: 'Issues' },
  { id: 'request', label: 'Requests' },
  { id: 'running', label: 'In flight' },
];

const matches = (item: SnitchItem, filter: Filter): boolean => {
  switch (filter) {
    case 'open':
      return item.status === 'open' || item.status === 'in_progress';
    case 'issue':
    case 'request':
      return item.kind === filter;
    case 'running':
      return item.pipeline.stage !== 'idle';
    default:
      return true;
  }
};

function NewItemForm({ project, onDone }: { project: string; onDone(): void }) {
  const { conversation } = useShell();
  const [kind, setKind] = useState<ItemKind>('issue');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [value, setValue] = useState<ItemValue>('medium');

  const submit = async () => {
    if (!title.trim()) return;
    await actions.addItem(project, kind, { title, description, value });
    onDone();
  };

  return (
    <div className="space-y-2 border-b border-line bg-surface-3/40 p-2.5">
      <div className="flex gap-1">
        {(['issue', 'request'] as ItemKind[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setKind(option)}
            className={`flex-1 rounded-md border px-2 py-1 text-[11px] capitalize transition ${
              kind === option ? 'border-primary/60 bg-primary/10 text-ink' : 'border-line text-ink-3 hover:text-ink-2'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <input
        autoFocus
        className={field}
        placeholder={kind === 'issue' ? 'What went wrong?' : 'What should it do?'}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
        }}
      />
      <textarea
        rows={3}
        className={`${field} resize-y`}
        placeholder="What happened, and anything an agent would need to reproduce it."
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />

      <div className="flex items-center gap-1.5">
        <select className={`${field} w-auto`} value={value} onChange={(event) => setValue(event.target.value as ItemValue)}>
          {(Object.keys(VALUE_LABELS) as ItemValue[]).map((option) => (
            <option key={option} value={option}>
              {VALUE_LABELS[option]}
            </option>
          ))}
        </select>

        {/* Filing what you are already looking at is the reason this lives inside the chat app. */}
        {conversation && (
          <button
            type="button"
            title="Paste the open conversation into the description"
            onClick={() => {
              setTitle((current) => current || conversation.title);
              setDescription((current) => `${current ? `${current}\n\n` : ''}${conversation.transcript()}`.trim());
            }}
            className={button}
          >
            <Sparkles size={12} />
            From chat
          </button>
        )}

        <button type="button" onClick={() => void submit()} disabled={!title.trim()} className={`${button} ml-auto`}>
          <Plus size={12} />
          Add
        </button>
        <button type="button" onClick={onDone} className={button}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Releases({ project }: { project: NonNullable<ReturnType<typeof useSnitch>['project']> }) {
  const [name, setName] = useState('');

  return (
    <div className="space-y-2 p-2.5">
      <div className="flex gap-1.5">
        <input className={field} placeholder="New release name" value={name} onChange={(event) => setName(event.target.value)} />
        <button
          type="button"
          disabled={!name.trim()}
          onClick={async () => {
            await actions.addRelease(project.name, name);
            setName('');
          }}
          className={button}
        >
          <Plus size={12} />
        </button>
      </div>

      {project.releases.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11px] text-ink-3">
          No releases yet.
        </p>
      ) : (
        project.releases.map((release) => (
          <div key={release.id} className="rounded-lg border border-line bg-surface-3/40 p-2">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-primary">{release.version}</span>
              <input
                className="min-w-0 flex-1 bg-transparent text-xs text-ink focus:outline-none"
                value={release.name}
                onChange={(event) => void actions.updateRelease(project.name, { ...release, name: event.target.value })}
              />
              <button
                type="button"
                onClick={() => void actions.deleteRelease(project.name, release.id)}
                className="rounded p-0.5 text-ink-3 transition hover:text-danger"
                title="Delete release"
              >
                <Trash2 size={11} />
              </button>
            </div>
            <p className="mt-0.5 text-[10px] text-ink-3">
              {release.status} · {release.date} · {release.issueCount} issues · {release.requestCount} requests
            </p>
          </div>
        ))
      )}
    </div>
  );
}

function ProjectSettings({ project }: { project: NonNullable<ReturnType<typeof useSnitch>['project']> }) {
  const state = useSnitch();
  const [name, setName] = useState('');

  const chooseRepo = async () => {
    const directory = await window.electronAPI.workspace.chooseDirectory();
    if (directory) await actions.updateProject(project.name, { repo: directory });
  };

  return (
    <div className="space-y-3 p-2.5 text-xs">
      <section>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-3">Repository</p>
        <p className="mb-1.5 text-[11px] text-ink-3">
          Where a dispatched fix runs. The agent edits this directory directly, so it wants to be a checkout you can
          read a diff from.
        </p>
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded bg-surface-3 px-2 py-1.5 font-mono text-[11px] text-ink-2">
            {project.repo ?? 'not set'}
          </code>
          <button type="button" onClick={() => void chooseRepo()} className={button}>
            <FolderGit2 size={12} />
            Choose
          </button>
          {project.repo && (
            <button type="button" onClick={() => void actions.updateProject(project.name, { repo: null })} className={button}>
              Clear
            </button>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2">
        {(
          [
            ['issuePrefix', 'Issue prefix', project.issuePrefix],
            ['requestPrefix', 'Request prefix', project.requestPrefix],
          ] as const
        ).map(([key, caption, current]) => (
          <div key={key}>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-3">{caption}</p>
            <input
              className={field}
              defaultValue={current}
              onBlur={(event) =>
                event.target.value.trim() &&
                event.target.value.trim().toUpperCase() !== current &&
                void actions.updateProject(project.name, { [key]: event.target.value })
              }
            />
          </div>
        ))}
      </section>

      <section>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-3">Files</p>
        <code className="block truncate rounded bg-surface-3 px-2 py-1.5 font-mono text-[10px] text-ink-3" title={project.path}>
          {project.path}
        </code>
        <p className="mt-1 text-[10px] text-ink-3">
          YAML and Markdown, readable by the agents that work on them — and by exec-snitch, which is where this format
          comes from.
        </p>
      </section>

      <section className="border-t border-line pt-2.5">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-3">Projects root</p>
        <code className="block truncate rounded bg-surface-3 px-2 py-1.5 font-mono text-[10px] text-ink-3">
          {state.config?.root ?? '…'}
        </code>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={async () => {
              const directory = await window.electronAPI.workspace.chooseDirectory();
              if (directory) await actions.setRoot(directory);
            }}
            className={button}
          >
            <FolderGit2 size={12} />
            Change
          </button>
          {state.config?.custom && (
            <button type="button" onClick={() => void actions.setRoot(null)} className={button}>
              Use default
            </button>
          )}
        </div>
      </section>

      <section className="border-t border-line pt-2.5">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-3">New project</p>
        <div className="flex gap-1.5">
          <input className={field} placeholder="Project name" value={name} onChange={(event) => setName(event.target.value)} />
          <button
            type="button"
            disabled={!name.trim()}
            onClick={async () => {
              await actions.createProject(name.trim(), null);
              setName('');
            }}
            className={button}
          >
            <CirclePlus size={12} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => void actions.deleteProject(project.name)}
          className={`${button} mt-2 hover:border-danger/60 hover:text-danger`}
        >
          <Trash2 size={12} />
          Delete {project.name}
        </button>
      </section>
    </div>
  );
}

export function SnitchPanel() {
  const state = useSnitch();
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);

  const project = state.project;
  const selected = project?.items.find((item) => item.id === state.selectedId) ?? null;

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (project?.items ?? [])
      .filter((item) => matches(item, filter))
      .filter((item) => !needle || `${item.id} ${item.title}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }, [project, filter, search]);

  if (!project) {
    return (
      <div className="p-4 text-center text-xs text-ink-3">
        <Bug size={22} className="mx-auto mb-2 text-ink-3" />
        <p className="text-ink-2">No projects yet.</p>
        <p className="mt-1">
          Snitch keeps each project as a YAML file and two folders of Markdown, in{' '}
          <code className="font-mono text-[10px]">{state.config?.root ?? '…'}</code>.
        </p>
        <button
          type="button"
          onClick={() => void actions.createProject('Antimatter', null)}
          className={`${button} mx-auto mt-3`}
        >
          <CirclePlus size={12} />
          Create one
        </button>
        {state.error && <p className="mt-2 text-[11px] text-danger">{state.error}</p>}
      </div>
    );
  }

  if (selected) {
    return <ItemDetail project={project} item={selected} busy={state.busy} onBack={() => actions.select(null)} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <select
          value={project.name}
          onChange={(event) => void actions.selectProject(event.target.value)}
          className="min-w-0 flex-1 truncate rounded bg-transparent px-1 py-0.5 text-xs font-semibold text-ink focus:outline-none"
        >
          {state.projects.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.name} ({entry.openItems})
            </option>
          ))}
        </select>

        {(['items', 'releases', 'settings'] as SnitchTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => actions.setTab(tab)}
            title={tab}
            className={`rounded p-1 transition ${
              state.tab === tab ? 'bg-surface-3 text-primary' : 'text-ink-3 hover:text-ink'
            }`}
          >
            {tab === 'items' ? <Bug size={12} /> : tab === 'releases' ? <Hammer size={12} /> : <Settings2 size={12} />}
          </button>
        ))}
      </div>

      {state.error && (
        <p className="flex items-start gap-1.5 border-b border-line bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{state.error}</span>
          <button type="button" onClick={() => actions.clearError()} className="shrink-0 text-[10px] underline">
            dismiss
          </button>
        </p>
      )}

      {state.tab === 'releases' && <Releases project={project} />}
      {state.tab === 'settings' && <ProjectSettings project={project} />}

      {state.tab === 'items' && (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
            {FILTERS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setFilter(entry.id)}
                className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                  filter === entry.id ? 'bg-primary/15 text-primary' : 'text-ink-3 hover:text-ink-2'
                }`}
              >
                {entry.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setAdding((current) => !current)}
              className="ml-auto rounded p-1 text-ink-3 transition hover:text-primary"
              title="New issue or request"
            >
              <Plus size={13} />
            </button>
          </div>

          {adding && <NewItemForm project={project.name} onDone={() => setAdding(false)} />}

          <div className="shrink-0 px-2 py-1.5">
            <input
              className={field}
              placeholder="Filter by id or title"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {items.length === 0 ? (
              <p className="px-2 py-6 text-center text-[11px] text-ink-3">Nothing here.</p>
            ) : (
              items.map((item) => {
                const stage = STAGES[item.pipeline.stage];
                const running = ['queued', 'fixing', 'qa'].includes(item.pipeline.stage);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => actions.select(item.id)}
                    className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-surface-3/60"
                  >
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${VALUE_DOTS[item.value]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-ink-3">{item.id}</span>
                        {item.pipeline.stage !== 'idle' && (
                          <span className={`${chip} ${stage.chip} ${running ? 'animate-pulse' : ''}`}>{stage.label}</span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-ink">{item.title}</span>
                      <span className="mt-0.5 block text-[10px] text-ink-3">
                        {STATUS_LABELS[item.status as ItemStatus]} · {relativeTime(item.updated)}
                      </span>
                    </span>
                    {item.pipeline.stage === 'idle' && project.repo && (
                      <span
                        role="button"
                        tabIndex={0}
                        title="Fix it"
                        onClick={(event) => {
                          event.stopPropagation();
                          void actions.fix(project.name, item.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.stopPropagation();
                            void actions.fix(project.name, item.id);
                          }
                        }}
                        className="mt-0.5 shrink-0 rounded p-1 text-ink-3 opacity-0 transition hover:bg-primary/15 hover:text-primary group-hover:opacity-100"
                      >
                        <Zap size={12} />
                      </span>
                    )}
                    <ChevronRight size={12} className="mt-1 shrink-0 text-ink-3" />
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
