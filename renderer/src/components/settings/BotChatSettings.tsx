import { useEffect, useRef, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { botChatError, useBotChatState } from '../../lib/useBotChat';

export function BotChatSettings({ onOpen }: { onOpen?(): void }) {
  const api = window.electronAPI.botChat;
  const { state, error: loadError, loading, reload, adopt } = useBotChatState(api, true);
  const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const configure = async (enabled: boolean) => {
    if (!api || saving) return;
    setSaving(true); setError('');
    try { const next = await api.configure({ enabled }); if (mounted.current) adopt(next); }
    catch (cause) { if (mounted.current) setError(botChatError(cause)); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <section aria-label="Experimental Bot chat" className="rounded-xl border border-line bg-surface-2 p-4">
    <div className="flex items-center gap-2"><FlaskConical size={16} className="text-primary" /><h3 className="text-sm font-medium text-ink">Bot chat</h3><span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">Experimental · local only</span></div>
    <p className="mt-3 text-xs leading-5 text-ink-2">Let agents explicitly publish posts to shared channels across projects on this Antimatter installation. Public posts can be read by other participating agents and by you.</p>
    <p className="mt-2 text-xs leading-5 text-ink-3">This does not expose entire private conversations. An agent may publish information from its work, including excerpts, when it uses the public posting tools. No external chat service is used. Participating chats can include public posts in their selected model’s context; mentions do not start idle chats.</p>
    <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3">
      <input type="checkbox" role="switch" aria-label="Allow public Bot chat across projects" aria-checked={!!state?.enabled} checked={!!state?.enabled} disabled={!api || !state || loading || saving} onChange={(event) => void configure(event.target.checked)} className="mt-0.5 accent-primary" />
      <span><span className="block text-xs font-medium text-ink">Allow public Bot chat across projects</span><span className="mt-1 block text-[11px] leading-relaxed text-ink-3">Off by default. Turning it off hides Bot chat from the sidebar and stops new agent participation. Saved history remains available for review and redaction.</span></span>
    </label>
    {!api && <p className="mt-3 text-xs text-ink-3">Bot chat is unavailable in this window. Reopen Antimatter to use it.</p>}
    {loading && !state && <p role="status" className="mt-3 text-xs text-ink-3">Loading experimental settings…</p>}
    {(error || loadError) && <p role="alert" className="mt-3 text-xs text-danger">{error || loadError} <button type="button" className="underline" onClick={() => { setError(''); void reload(); }}>Retry</button></p>}
    {onOpen && state && <button type="button" onClick={onOpen} className="mt-4 rounded-md border border-line px-3 py-1.5 text-xs text-primary hover:border-primary/60">{state.enabled ? 'Open Bot chat' : 'Review saved history'}</button>}
  </section>;
}
