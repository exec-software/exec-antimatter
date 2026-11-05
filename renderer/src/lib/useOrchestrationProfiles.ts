import { useCallback, useEffect, useState } from 'react';
import type { OrchestrationProfileInfo } from '../types';

/**
 * The orchestration profiles, and which one is chosen.
 *
 * Read once per mount rather than subscribed: profiles are files somebody edits occasionally, not
 * live state, and the selection is written by this hook so nothing else can change it behind us.
 * The main process owns the choice because dispatch can come from a schedule with no window open.
 */
export function useOrchestrationProfiles(): {
  profiles: OrchestrationProfileInfo[];
  profileId: string | null;
  error: string;
  selectProfile(id: string | null): Promise<void>;
  /** Re-read the list after an edit that rewrote a file. */
  refreshProfiles(): Promise<void>;
  renameProfile(id: string, name: string): Promise<boolean>;
  setProfileMode(id: string, mode: 'local' | 'distributed' | 'provider' | null): Promise<void>;
} {
  const [profiles, setProfiles] = useState<OrchestrationProfileInfo[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refreshProfiles = useCallback(async () => {
    try {
      const result = await window.electronAPI.listProfiles();
      setProfiles(result.profiles);
      setProfileId(result.selectedId);
      setError('');
    } catch (cause) {
      setError(`Could not read orchestration profiles: ${(cause as Error).message}`);
    }
  }, []);

  useEffect(() => {
    let live = true;
    void window.electronAPI
      .listProfiles()
      .then((result) => {
        if (!live) return;
        setProfiles(result.profiles);
        setProfileId(result.selectedId);
      })
      .catch((error) => { if (live) setError(`Could not read orchestration profiles: ${(error as Error).message}`); });
    return () => {
      live = false;
    };
  }, []);

  const selectProfile = useCallback(async (id: string | null) => {
    setError('');
    try {
      setProfileId(await window.electronAPI.selectProfile(id));
    } catch (error) {
      setError(`Could not select routing profile: ${(error as Error).message}`);
    }
  }, []);

  // Both writes edit one field of one file, so the updated profile comes back and replaces
  // its own row rather than forcing a reload of the whole list.
  const replace = useCallback((updated: OrchestrationProfileInfo | null) => {
    if (!updated) return;
    setProfiles((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
  }, []);

  const renameProfile = useCallback(async (id: string, name: string) => {
    setError('');
    try {
      const updated = await window.electronAPI.renameProfile(id, name);
      if (!updated) throw new Error('The profile is no longer available.');
      replace(updated);
      return true;
    } catch (error) {
      setError(`Could not rename routing profile: ${(error as Error).message}`);
      return false;
    }
  }, [replace]);

  const setProfileMode = useCallback(async (id: string, mode: 'local' | 'distributed' | 'provider' | null) => {
    setError('');
    try {
      const updated = await window.electronAPI.setProfileMode(id, mode);
      if (!updated) throw new Error('The profile is no longer available.');
      replace(updated);
    } catch (error) {
      setError(`Could not change routing category: ${(error as Error).message}`);
    }
  }, [replace]);

  return { profiles, profileId, error, selectProfile, refreshProfiles, renameProfile, setProfileMode };
}
