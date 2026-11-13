import { useState } from 'react';
import { MessageSquare, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { registerPlugin } from '../registry';
import { useShell } from '../shell';
import { saveDesktopPreferences, useDesktopPreferences } from '../../desktopPreferences';
import type { ReplyMacro } from '../../../../src/api/desktopPreferences';
import { requestReplyPad } from '../../lib/replyPad';

export function ReplyPadPanel() {
  const settings = useDesktopPreferences();
  const shell = useShell();
  const [edit, setEdit] = useState<ReplyMacro | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const save = async (replies: ReplyMacro[]) => {
    setPending(true); setError('');
    try { await saveDesktopPreferences({ replyMacros: replies }); setEdit(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save replies.'); }
    finally { setPending(false); }
  };
  if (!settings.macroPadEnabled) return <p className="p-4 text-xs text-ink-2">Enable Reply pad in Settings → Appearance.</p>;
  return <section className="flex h-full flex-col gap-3 overflow-auto p-3 text-ink" aria-label="Saved replies">
    <div className="flex items-center justify-between"><p className="min-w-0 truncate text-xs text-ink-2">{shell.conversation?.title ?? 'Open a chat to send replies'}</p>
      <button type="button" aria-label="Add saved reply" disabled={pending || settings.replyMacros.length >= 32} className="rounded p-1 hover:bg-surface-3" onClick={() => setEdit({ id: crypto.randomUUID(), title: '', text: '' })}><Plus size={16} /></button></div>
    {!settings.replyMacros.length && !edit && <p className="text-xs text-ink-2">Add a reply to reuse it in your chats.</p>}
    {settings.replyMacros.map((reply) => <div key={reply.id} className="rounded border border-line p-2">
      <p className="truncate text-xs font-medium" title={reply.text}>{reply.title}</p><p className="my-1 line-clamp-2 whitespace-pre-wrap text-xs text-ink-2">{reply.text}</p>
      <div className="flex items-center gap-2">
        {(['insert', 'send'] as const).map((action) => <button key={action} type="button" disabled={pending || !shell.conversation}
          className="flex items-center gap-1 rounded border border-line px-2 py-1 text-xs hover:bg-surface-3 disabled:opacity-40"
          title={action === 'send' && settings.sendClickModifier !== 'none' ? `Hold ${settings.sendClickModifier} and click` : undefined}
          onClick={async (event) => {
            if (!shell.conversation) return; setError(''); setNotice('');
            const result = await requestReplyPad({ conversationId: shell.conversation.id, text: reply.text, action,
              modifiers: { ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey } });
            if (result.accepted) setNotice(action === 'insert' ? 'Added to draft.' : 'Reply sent.'); else setError(result.error ?? 'Reply was not accepted.');
          }}>{action === 'send' ? <Send size={12} /> : <Plus size={12} />}{action === 'send' ? 'Send' : 'Insert'}</button>)}
        <button type="button" aria-label={`Edit ${reply.title}`} disabled={pending} onClick={() => setEdit({ ...reply })} className="ml-auto p-1"><Pencil size={12} /></button>
        <button type="button" aria-label={`Delete ${reply.title}`} disabled={pending} onClick={() => void save(settings.replyMacros.filter((item) => item.id !== reply.id))} className="p-1 text-ink-3 hover:text-danger"><Trash2 size={12} /></button>
      </div>
    </div>)}
    {edit && <form className="space-y-2 rounded border border-line p-2" onSubmit={(event) => { event.preventDefault(); void save([...settings.replyMacros.filter((item) => item.id !== edit.id), edit]); }}>
      <label className="block text-xs">Title<input aria-label="Reply title" required maxLength={80} value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.target.value })} className="mt-1 w-full rounded border border-line bg-surface-0 p-2" /></label>
      <label className="block text-xs">Reply<textarea aria-label="Saved reply text" required maxLength={4000} value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} className="mt-1 h-32 w-full rounded border border-line bg-surface-0 p-2" /></label>
      <button disabled={pending || !edit.title.trim() || !edit.text.trim()} className="rounded bg-primary px-2 py-1 text-xs text-on-primary">Save reply</button>
      <button type="button" disabled={pending} onClick={() => setEdit(null)} className="ml-2 text-xs text-ink-2">Cancel</button>
    </form>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}{notice && <p role="status" className="text-xs text-ink-2">{notice}</p>}
  </section>;
}
export const replyPadPlugin = registerPlugin({ id: 'reply-pad', name: 'Reply pad', version: '1.0.0', description: 'Reusable replies', toolWindows: [{ id: 'reply-pad', title: 'Replies', description: 'Saved replies', icon: MessageSquare, anchor: 'right', defaultSize: 300, floatSize: { width: 360, height: 480 }, render: () => <ReplyPadPanel /> }] });
