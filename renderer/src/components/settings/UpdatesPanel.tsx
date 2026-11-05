import { useState } from 'react';
import { ArrowDownToLine, CircleCheck, FolderOpen, RefreshCw, RotateCw, TriangleAlert, Undo2, WifiOff } from 'lucide-react';
import type { UpdateState } from '../../types';
import { useUpdateState } from '../../lib/updates';
import { MarkdownContent } from '../chat/MarkdownContent';
import { AtomIndicator } from '../status/AtomIndicator';
import { bytes, errorText, relativeDate } from '../hub/presentation';
import { displayReleaseVersion } from '../../../../src/api/releaseVersion';

const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';
const primary =
  'flex items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-on-primary transition hover:bg-primary-strong disabled:opacity-40';

const KIND_LABEL: Record<UpdateState['install']['kind'], string> = {
  installer: 'installed with install.sh',
  appimage: 'AppImage',
  development: 'running from source',
  unmanaged: 'unpacked by hand',
};

/** Checks run every few hours, so a check from today is worth its time of day. */
function checkedAt(at: number | null): string | null {
  if (!at) return null;
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = new Date();
  if (when.toDateString() === day.toDateString()) return `at ${time}`;
  day.setDate(day.getDate() - 1);
  if (when.toDateString() === day.toDateString()) return `yesterday at ${time}`;
  return relativeDate(when.toISOString());
}

function StatusLine({ state }: { state: UpdateState }) {
  const checked = checkedAt(state.lastCheckedAt);
  switch (state.status) {
    case 'checking':
      return (
        <span className="flex items-center gap-1.5 text-ink-2">
          <AtomIndicator phase="thinking" size={13} /> Checking for updates…
        </span>
      );
    case 'current':
      return (
        <span className="flex items-center gap-1.5 text-accent">
          <CircleCheck size={13} /> Up to date{checked ? ` · checked ${checked}` : ''}
        </span>
      );
    case 'offline':
      return (
        <span className="flex items-center gap-1.5 text-ink-3">
          <WifiOff size={13} /> {state.error ?? 'The releases share is not reachable.'}
        </span>
      );
    case 'available':
      return (
        <span className="text-ink">
          <strong className="font-semibold">{displayReleaseVersion(state.available?.version)}</strong> is available
          {state.available?.publishedAt ? ` · published ${relativeDate(state.available.publishedAt)}` : ''}
          {state.available ? ` · ${bytes(state.available.bytes)}` : ''}
        </span>
      );
    case 'downloading': {
      const done = state.progress?.bytesDone ?? 0;
      const total = state.progress?.bytesTotal ?? 0;
      return (
        <span className="flex w-full flex-col gap-1.5 text-ink-2">
          <span>
            Copying {displayReleaseVersion(state.available?.version)} from the releases share · {bytes(done)} / {bytes(total)}
          </span>
          <span className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={total ? Math.round((done / total) * 100) : 0}>
            <span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </span>
        </span>
      );
    }
    case 'installing':
      return (
        <span className="flex items-center gap-1.5 text-ink-2">
          <AtomIndicator phase="streaming" size={13} /> Installing {displayReleaseVersion(state.available?.version)}…
        </span>
      );
    case 'ready':
      return (
        <span className="flex items-center gap-1.5 text-accent">
          <CircleCheck size={13} /> {displayReleaseVersion(state.readyVersion)} is installed.{' '}
          {state.restart.error
            ? 'Automatic restart needs attention.'
            : state.restart.pending
              ? 'Automatic restart is waiting until your work is safe.'
              : state.automatic
                ? 'Antimatter will restart automatically as soon as it is safe.'
                : 'Restart to use it, or it will open next time Antimatter starts.'}
        </span>
      );
    case 'failed':
      return (
        <span className="flex items-start gap-1.5 whitespace-pre-wrap text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {state.error}
        </span>
      );
    default:
      return <span className="text-ink-3">Not checked yet.</span>;
  }
}

/** Settings → Updates. Everything here reads from and writes to the main process's updater. */
export function UpdatesPanel() {
  const state = useUpdateState();
  const [actionError, setActionError] = useState('');

  const act = async (action: () => Promise<unknown>) => {
    setActionError('');
    try {
      await action();
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  if (!state) return <p className="text-xs text-ink-3">Reading update status…</p>;

  const busy = state.status === 'checking' || state.status === 'downloading' || state.status === 'installing';
  // RELEASE_NOTES.md opens with "# Antimatter <version>", which the summary line already says.
  const notes = state.available?.notes?.replace(/^#\s+Antimatter\s+\S+[ \t]*\n+/, '').trim() || null;
  const chooseFeed = async () => {
    const directory = await window.electronAPI.workspace.chooseDirectory();
    if (directory) await act(() => window.electronAPI.updates.setFeed(directory));
  };

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">Antimatter {displayReleaseVersion(state.version)}</span>
        <span className="text-[11px] text-ink-3">{KIND_LABEL[state.install.kind]}</span>
        <div className="ml-auto flex items-center gap-1">
          {state.status === 'ready' && (
            <button type="button" onClick={() => void act(() => window.electronAPI.updates.restart())} className={primary}>
              <RotateCw size={12} />
              Restart now
            </button>
          )}
          {(state.status === 'available' || state.status === 'failed') && state.install.canApply && state.available && (
            <button type="button" onClick={() => void act(() => window.electronAPI.updates.apply())} className={primary}>
              <ArrowDownToLine size={12} />
              {state.status === 'failed' ? 'Retry' : 'Install'}
            </button>
          )}
          <button type="button" onClick={() => void act(() => window.electronAPI.updates.check())} disabled={busy} className={button}>
            <RefreshCw size={12} />
            Check now
          </button>
        </div>
      </div>

      <div className="mt-2 text-xs">
        <StatusLine state={state} />
      </div>
      {state.status === 'ready' && state.restart.blockers.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[11px] text-ink-3">
          {state.restart.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
      {state.status === 'ready' && state.restart.error && (
        <p className="mt-1.5 text-[11px] text-danger">{state.restart.error}</p>
      )}
      {state.install.reason && state.status !== 'current' && (
        <p className="mt-1.5 text-[11px] text-ink-3">{state.install.reason}</p>
      )}
      {state.logPath && (state.status === 'failed' || state.status === 'ready') && (
        <p className="mt-1 truncate font-mono text-[11px] text-ink-3" title={state.logPath}>
          Installer log: {state.logPath}
        </p>
      )}
      {actionError && <p className="mt-1.5 text-[11px] text-danger">{actionError}</p>}

      {notes && (
        <details className="mt-3 rounded-lg border border-line-soft bg-surface px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-medium text-ink-2">What's in {displayReleaseVersion(state.available?.version)}</summary>
          <div className="mt-2 max-h-72 overflow-y-auto text-xs">
            <MarkdownContent content={notes} />
          </div>
        </details>
      )}

      <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={state.automatic}
          onChange={(event) => void act(() => window.electronAPI.updates.setAutomatic(event.target.checked))}
          className="mt-0.5 accent-[rgb(var(--color-primary))]"
        />
        <span>
          Install updates automatically
          <span className="block text-[11px] text-ink-3">
            Copied and installed in the background. Once chats, agents, terminals, runs, debugging, orchestration, edits, and
            unsaved buffers are clear, Antimatter saves the conversation and live draft, then restarts into the new version.
          </span>
        </span>
      </label>

      <div className="mt-3 border-t border-line-soft pt-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-ink-2">Builds from</span>
          <code className="min-w-0 truncate font-mono text-[11px] text-ink-2" title={state.feed.path ?? state.feed.defaultPath}>
            {state.feed.path ?? state.feed.defaultPath}
          </code>
          {!state.feed.path && <span className="text-[11px] text-ink-3">(not found)</span>}
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={() => void chooseFeed()} className={button} title="The antimatter folder under buildd's managed root">
              <FolderOpen size={12} />
              Change…
            </button>
            {state.feed.configured && (
              <button type="button" onClick={() => void act(() => window.electronAPI.updates.setFeed(null))} className={button}>
                <Undo2 size={12} />
                Default
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-3">
          A trusted local or mounted release feed. Without a choice here, Antimatter looks for it at{' '}
          {state.feed.defaultPath} and among shares opened in the file manager.
        </p>
      </div>
    </div>
  );
}
