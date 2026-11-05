import { useEffect, useState } from 'react';
import type { UpdateState } from '../types';
import { displayReleaseVersion } from '../../../src/api/releaseVersion';

/** The updater's state as the main process reports it, current as it changes. */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let heard = false;
    const stop = window.electronAPI.onUpdateState((next) => {
      heard = true;
      setState(next);
    });
    window.electronAPI.updates
      .state()
      .then((next) => {
        if (!heard) setState(next);
      })
      .catch(console.error);
    return stop;
  }, []);
  return state;
}

/**
 * What the sidebar should say about updates, if anything. It stays quiet unless there is something
 * to do or to watch: an update to restart into, one installing, one that failed, or one waiting for
 * a click because automatic installs are off. Running from source it says nothing at all — a
 * checkout is updated with git, and a nudge there would only ever be noise.
 */
export function sidebarNotice(state: UpdateState | null): { label: string; tone: 'primary' | 'muted' | 'danger' } | null {
  if (!state || state.install.kind === 'development') return null;
  switch (state.status) {
    case 'ready':
      return { label: `Restart for ${displayReleaseVersion(state.readyVersion)}`, tone: 'primary' };
    case 'downloading': {
      const progress = state.progress;
      const percent = progress?.bytesTotal ? Math.floor((progress.bytesDone / progress.bytesTotal) * 100) : 0;
      return { label: `Updating · ${percent}%`, tone: 'muted' };
    }
    case 'installing':
      return { label: 'Installing update…', tone: 'muted' };
    case 'available':
      return state.install.canApply ? { label: `Update ${displayReleaseVersion(state.available?.version)} available`, tone: 'primary' } : null;
    case 'failed':
      // A copy that cannot install updates has nothing to retry; Settings still shows what happened.
      return state.install.canApply ? { label: state.available ? 'Update failed' : 'Update check failed', tone: 'danger' } : null;
    default:
      return null;
  }
}
