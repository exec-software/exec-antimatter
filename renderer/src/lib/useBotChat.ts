import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotChatAPI, BotChatState } from '../../../src/api/botChat';

export const botChatError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

/** The global opt-in has one host authority; reading it never starts or messages a chat. */
export function useBotChatState(api: BotChatAPI | undefined = window.electronAPI.botChat, settingsOnly = false) {
  const [snapshot, setSnapshot] = useState<{ api: BotChatAPI; state: BotChatState } | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const mounted = useRef(true); const request = useRef(0); const currentAPI = useRef(api); currentAPI.current = api;
  const state = snapshot?.api === api ? snapshot?.state ?? null : null;
  const adopt = useCallback((next: BotChatState) => {
    if (!api || !mounted.current || currentAPI.current !== api) return;
    request.current++; setSnapshot({ api, state: next }); setError(''); setLoading(false);
  }, [api]);
  const reload = useCallback(async () => {
    if (!api) return;
    const sequence = ++request.current;
    const current = () => mounted.current && currentAPI.current === api && sequence === request.current;
    setLoading(true);
    try { const next = await api.state(); if (current()) { setSnapshot({ api, state: next }); setError(''); } }
    catch (cause) { if (current()) setError(botChatError(cause)); }
    finally { if (current()) setLoading(false); }
  }, [api]);
  useEffect(() => {
    mounted.current = true; setSnapshot(null); setError(''); void reload();
    const unsubscribe = api?.onChanged((event) => { if (!settingsOnly || event.settingsChanged) void reload(); });
    return () => { mounted.current = false; request.current++; unsubscribe?.(); };
  }, [api, settingsOnly, reload]);
  return { state, error, loading, reload, adopt };
}
