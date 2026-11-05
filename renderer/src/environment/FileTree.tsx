import { useEffect, useState } from 'react';
import {
  ChevronRight,
  File,
  FileCode2,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { FileEntry } from '../types';
import { actions, isDirty, useEnvironment } from './store';

/**
 * The file tree, which takes over the sidebar in the environment.
 *
 * Loaded one directory at a time. A repository with a node_modules in it has a hundred thousand
 * files, and the difference between walking them up front and walking them when asked is the
 * difference between a sidebar and a hang.
 */

const row = 'group flex w-full items-center gap-1 rounded px-1.5 py-[3px] text-left text-xs transition';
const iconButton = 'rounded p-0.5 text-ink-3 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink';

/** A small inline prompt: naming a file should not open a modal over the whole window. */
function NameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit(value: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => (value.trim() && value !== initial ? onCommit(value.trim()) : onCancel())}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && value.trim()) onCommit(value.trim());
        if (event.key === 'Escape') onCancel();
      }}
      className="w-full rounded border border-primary/60 bg-surface-3 px-1 py-[2px] text-xs text-ink focus:outline-none"
    />
  );
}

interface NodeProps {
  entry: FileEntry;
  depth: number;
  renaming: string | null;
  onRename(path: string | null): void;
  onDelete(entry: FileEntry): void;
}

function Node({ entry, depth, renaming, onRename, onDelete }: NodeProps) {
  const state = useEnvironment();
  const open = state.expanded.includes(entry.path);
  const children = state.tree[entry.path];
  const file = state.files.find((candidate) => candidate.path === entry.path);
  const isActive = state.activePath === entry.path;
  const dirty = file ? isDirty(file) : false;

  if (renaming === entry.path) {
    return (
      <div style={{ paddingLeft: depth * 10 + 6 }} className="px-1.5 py-[3px]">
        <NameInput
          initial={entry.name}
          onCancel={() => onRename(null)}
          onCommit={(name) => {
            const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1) : '';
            void actions.rename(entry.path, `${parent}${name}`);
            onRename(null);
          }}
        />
      </div>
    );
  }

  return (
    <>
      <div
        className={`${row} ${
          isActive ? 'bg-primary/12 text-ink' : 'text-ink-2 hover:bg-surface-3/70 hover:text-ink'
        }`}
        style={{ paddingLeft: depth * 10 + 6 }}
      >
        <button
          type="button"
          onClick={() =>
            entry.kind === 'directory' ? void actions.toggleDirectory(entry.path) : void actions.openFile(entry.path)
          }
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          title={entry.path}
        >
          {entry.kind === 'directory' ? (
            <ChevronRight
              size={11}
              className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`}
            />
          ) : (
            <span className="w-[11px] shrink-0" />
          )}
          {entry.kind === 'directory' ? (
            <FolderOpen size={12} className={`shrink-0 ${open ? 'text-primary' : 'text-ink-3'}`} />
          ) : (
            /^nil\.project\.(nildata|json|ya?ml)$/i.test(entry.name) || /\.(ny|matrix|mat|nil)$/i.test(entry.name) ? <FileCode2 size={12} className={`shrink-0 ${isActive ? 'text-primary' : 'text-ink-3'}`} /> : <File size={12} className={`shrink-0 ${isActive ? 'text-primary' : 'text-ink-3'}`} />
          )}
          <span className={`min-w-0 flex-1 truncate ${entry.name.startsWith('.') ? 'opacity-70' : ''}`}>
            {entry.name}
          </span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-primary" title="Unsaved changes" />}
        </button>

        <button type="button" title="Rename" onClick={() => onRename(entry.path)} className={iconButton}>
          <Pencil size={10} />
        </button>
        <button type="button" title="Delete" onClick={() => onDelete(entry)} className={`${iconButton} hover:text-danger`}>
          <Trash2 size={10} />
        </button>
      </div>

      {open &&
        (children ? (
          children.map((child) => (
            <Node
              key={child.path}
              entry={child}
              depth={depth + 1}
              renaming={renaming}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))
        ) : (
          <p style={{ paddingLeft: (depth + 1) * 10 + 18 }} className="py-[3px] text-[11px] text-ink-3">
            Reading…
          </p>
        ))}
    </>
  );
}

export function FileTree() {
  const state = useEnvironment();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<'file' | 'directory' | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null);

  useEffect(() => { setRenaming(null); setCreating(null); setPendingDelete(null); }, [state.root, state.busy]);

  const entries = state.tree[''] ?? [];
  const folder = state.root.split('/').filter(Boolean).pop() ?? state.root;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <FolderOpen size={12} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink" title={state.root}>
          {folder || 'Explorer'}
        </span>
        <button type="button" title="New file" disabled={!state.root || state.busy} onClick={() => setCreating('file')} className="rounded p-0.5 text-ink-3 hover:text-ink">
          <FilePlus2 size={12} />
        </button>
        <button
          type="button"
          title="New folder"
          disabled={!state.root || state.busy}
          onClick={() => setCreating('directory')}
          className="rounded p-0.5 text-ink-3 hover:text-ink"
        >
          <FolderPlus size={12} />
        </button>
        <button
          type="button"
          title="Reread this directory"
          disabled={!state.root || state.busy}
          onClick={() => void actions.reload('')}
          className="rounded p-0.5 text-ink-3 hover:text-ink"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <button
        type="button"
        disabled={state.busy || state.workspaceSwitching || !!state.pendingWorkspace}
        onClick={() => void actions.chooseFolder()}
        className="truncate border-b border-line-soft px-2 py-1 text-left font-mono text-[10px] text-ink-3 transition hover:text-ink-2"
        title={`${state.root}\nClick to choose this chat’s folder`}
      >
        {state.root || 'No directory open'}
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {creating && (
          <div className="px-1.5 py-[3px]">
            <NameInput
              initial=""
              onCancel={() => setCreating(null)}
              onCommit={(name) => {
                void actions.create(name, creating);
                setCreating(null);
              }}
            />
          </div>
        )}

        {entries.length === 0 && !state.busy ? (
          <p className="px-3 py-4 text-[11px] text-ink-3">{state.root ? 'This folder is empty. Create a project to add source and a build manifest.' : 'Open a folder or create a project to begin.'}</p>
        ) : (
          entries.map((entry) => (
            <Node
              key={entry.path}
              entry={entry}
              depth={0}
              renaming={renaming}
              onRename={setRenaming}
              onDelete={setPendingDelete}
            />
          ))
        )}
      </div>

      {pendingDelete && (
        <div className="border-t border-danger/40 bg-danger/10 p-2 text-[11px]">
          <p className="text-ink">
            Delete <span className="font-mono">{pendingDelete.name}</span>
            {pendingDelete.kind === 'directory' ? ' and everything in it' : ''}?
          </p>
          <p className="mt-0.5 text-ink-3">This cannot be undone.</p>
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              onClick={() => {
                void actions.remove(pendingDelete.path);
                setPendingDelete(null);
              }}
              className="rounded bg-danger px-2 py-0.5 font-semibold text-on-danger"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="rounded border border-line px-2 py-0.5 text-ink-2 hover:text-ink"
            >
              Keep
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
