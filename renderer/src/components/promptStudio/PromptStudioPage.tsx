import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle, BookMarked, Braces, CircleAlert, Copy, FileText, Info, Paperclip, PenLine, Play,
  Plus, Save, Search, Send, SpellCheck, Trash2, Wand2,
} from 'lucide-react';
import type { Attachment, Draft } from '../../types';
import type { PromptEntry, PromptLibrary, PromptLibraryAPI } from '../../../../src/api/promptLibrary';
import { EMPTY_PROMPT_LIBRARY, MAX_PROMPT_TITLE_LENGTH, promptTitleFrom } from '../../../../src/api/promptLibrary';
import { AttachmentChip } from '../chat/AttachmentChip';
import { ConfirmDialog } from '../ConfirmDialog';
import { readAttachmentFiles, skippedAttachmentNote } from '../../lib/attachments';
import {
  PROMPT_BLOCKS, composePrompt, insertBlock, inspectPrompt, promptFindingCounts, promptStats,
  promptVariables, type PromptFindingSeverity,
} from './promptStudio';

/**
 * Prompt Studio: somewhere to write a prompt before it is a message.
 *
 * The editor *is* the open chat's draft, not a copy of it. That is the whole trick: a draft is
 * already durable and already per-conversation, so there is no second place for a prompt to live
 * and no way to lose one by navigating away. Switch to the chat and the composer holds exactly
 * what is in the editor; type in the composer and the editor has it when you come back.
 *
 * The library beside it is the other half. A draft dies with its conversation, and a prompt you
 * keep re-running does not belong to any one of them, so a saved prompt is kept per install.
 *
 * Spelling is Chromium's, through Electron's own spellchecker: the textarea is underlined and
 * right-click offers real corrections and "Add to dictionary". The panel on the right is about
 * what a prompt says rather than how it is spelled, and it never rewrites a word of it.
 */

interface Props {
  /** The conversation this prompt is for. Null before the first chat exists. */
  threadId: string | null;
  threadTitle: string;
  /** That conversation's draft, which this editor reads and writes directly. */
  draft: Draft | undefined;
  onDraftChange(threadId: string, draft: Draft): void;
  /** Sends the composed prompt on that conversation. False when the turn was refused. */
  onRun(text: string, attachments: Attachment[]): boolean;
  /** Starts a new conversation holding this prompt, without sending it. */
  onNewChat(text: string, attachments: Attachment[]): void;
  /** Leaves for the conversation itself. */
  onOpenChat(): void;
  /** Why this chat cannot take a turn right now, when it cannot. */
  runBlockedReason?: string;
  /** The chosen model's context window, when the catalog knows it. */
  tokenBudget?: number;
  modelName?: string;
  /** Injectable for tests and for a window with no preload bridge. */
  api?: PromptLibraryAPI;
}

const button = 'inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35';
const primary = 'inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-on-primary transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-40';
const field = 'rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';

const severityIcon: Record<PromptFindingSeverity, typeof CircleAlert> = {
  problem: CircleAlert,
  caution: AlertTriangle,
  note: Info,
};
const severityTone: Record<PromptFindingSeverity, string> = {
  problem: 'text-danger',
  caution: 'text-warning',
  note: 'text-ink-3',
};

/**
 * Field values, per conversation, for as long as the window is open.
 *
 * The prompt itself is the chat's draft and survives anything; these do not belong there, because
 * what goes to the model is the filled-in text and a draft holding half-substituted values would
 * be a second source of truth. Saving the prompt writes them to the library, which is where they
 * last. This is only so that stepping out to the chat and back does not blank the fields.
 */
const fieldCache = new Map<string, Record<string, string>>();

const relativeTime = (at: number): string => {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString();
};

const readableError = (cause: unknown, fallback: string): string =>
  (cause instanceof Error ? cause.message : fallback).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

export function PromptStudioPage({
  threadId, threadTitle, draft, onDraftChange, onRun, onNewChat, onOpenChat,
  runBlockedReason, tokenBudget, modelName, api,
}: Props) {
  const library = api ?? (typeof window === 'undefined' ? undefined : window.electronAPI?.promptLibrary);
  const [text, setText] = useState(draft?.text ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(draft?.attachments ?? []);
  const [values, setValues] = useState<Record<string, string>>(() => fieldCache.get(threadId ?? '') ?? {});
  const [saved, setSaved] = useState<PromptLibrary>(EMPTY_PROMPT_LIBRARY);
  const [openId, setOpenId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: 'delete'; entry: PromptEntry } | { kind: 'open'; entry: PromptEntry } | null>(null);
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const editor = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // The draft is the storage, so every keystroke goes back to the conversation that owns it.
  useEffect(() => {
    if (threadId) onDraftChange(threadId, { text, attachments });
  }, [threadId, text, attachments, onDraftChange]);
  useEffect(() => {
    const key = threadId ?? '';
    if (Object.keys(values).length) fieldCache.set(key, values); else fieldCache.delete(key);
  }, [threadId, values]);

  const refresh = useCallback(async () => {
    if (!library) return;
    try {
      const next = await library.get();
      if (mounted.current) setSaved(next);
    } catch (cause) {
      if (mounted.current) setError(readableError(cause, 'Could not read the prompt library.'));
    }
  }, [library]);
  useEffect(() => { void refresh(); }, [refresh]);

  const variables = useMemo(() => promptVariables(text, values), [text, values]);
  const composed = useMemo(() => composePrompt(text, values), [text, values]);
  const findings = useMemo(() => inspectPrompt(text, { values, tokenBudget }), [text, values, tokenBudget]);
  const counts = useMemo(() => promptFindingCounts(findings), [findings]);
  const stats = useMemo(() => promptStats(text), [text]);
  const openEntry = saved.entries.find((entry) => entry.id === openId) ?? null;
  const dirty = !openEntry || openEntry.body !== text || promptTitleFrom(title, text) !== openEntry.title;
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return saved.entries;
    return saved.entries.filter((entry) => `${entry.title}\n${entry.body}`.toLowerCase().includes(needle));
  }, [saved.entries, query]);

  const say = (message: string) => { setNotice(message); setError(''); };
  const run = async (operation: () => Promise<PromptLibrary>, message: string) => {
    if (!library || busy) return false;
    setBusy(true);
    setError('');
    try {
      const next = await operation();
      if (mounted.current) { setSaved(next); setNotice(message); }
      return next;
    } catch (cause) {
      if (mounted.current) { setError(readableError(cause, 'That prompt action failed.')); setNotice(''); }
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const trackCaret = () => {
    const target = editor.current;
    if (!target) return;
    const before = target.value.slice(0, target.selectionStart);
    const lines = before.split('\n');
    setCaret({ line: lines.length, column: lines[lines.length - 1].length + 1 });
  };

  /** Puts the caret on a finding's line and selects it, which is what a jump-to-line is for. */
  const selectLine = (line: number) => {
    const target = editor.current;
    if (!target || line < 1) return;
    const lines = text.split('\n');
    const start = lines.slice(0, line - 1).reduce((total, entry) => total + entry.length + 1, 0);
    target.focus();
    target.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    trackCaret();
  };

  const addBlock = (body: string) => {
    const target = editor.current;
    const at = target ? target.selectionStart : text.length;
    const next = insertBlock(text, at, body);
    setText(next.text);
    requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(next.caret, next.caret);
      trackCaret();
    });
  };

  const attach = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!chosen.length) return;
    const { added, skipped } = await readAttachmentFiles(chosen);
    if (!mounted.current) return;
    if (added.length) setAttachments((current) => [...current, ...added]);
    setNotice(skippedAttachmentNote(skipped) || (added.length ? `Attached ${added.length === 1 ? added[0].name : `${added.length} files`}` : ''));
  };

  const openSaved = (entry: PromptEntry) => {
    setOpenId(entry.id);
    setTitle(entry.title);
    setText(entry.body);
    setValues(entry.variables);
    say(`Opened ${entry.title}`);
    requestAnimationFrame(() => editor.current?.focus());
  };

  const startNew = () => {
    setOpenId(null);
    setTitle('');
    setText('');
    setValues({});
    setAttachments([]);
    say('');
    requestAnimationFrame(() => editor.current?.focus());
  };

  const saveToLibrary = async (asCopy = false) => {
    const result = await run(
      () => library!.save({ ...(asCopy || !openEntry ? {} : { id: openEntry.id }), title: promptTitleFrom(title, text), body: text, variables: values }),
      asCopy ? 'Saved as a copy' : 'Saved to the library'
    );
    if (!result) return;
    const label = promptTitleFrom(title, text);
    const landed = result.entries.find((entry) => (asCopy || !openEntry ? entry.title === label && entry.body === text : entry.id === openEntry.id));
    if (landed) { setOpenId(landed.id); setTitle(landed.title); }
  };

  const applyVariables = () => {
    if (!composed.text || composed.missing.length) return;
    setText(composed.text);
    setValues({});
    say('Variables written into the prompt');
  };

  const sendable = !!composed.text && composed.missing.length === 0;
  const runReason = !threadId ? 'Open a chat first.' : composed.missing.length ? `Fill in ${composed.missing.join(', ')} first.`
    : !composed.text ? 'Write a prompt first.' : runBlockedReason ?? '';

  const handleRun = () => {
    if (!threadId || !sendable || runBlockedReason) return;
    if (!onRun(composed.text, attachments)) { setError('The chat would not take this turn. Check the source and model, then try again.'); return; }
    // Clear the draft here rather than leaving it to the effect: leaving for the chat unmounts
    // this page in the same commit, so an effect scheduled now never runs, and the composer
    // would open holding the prompt that was just sent — one Enter away from sending it twice.
    onDraftChange(threadId, { text: '', attachments: [] });
    fieldCache.delete(threadId);
    setText('');
    setAttachments([]);
    setValues({});
    onOpenChat();
  };

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Prompt Studio">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-3">
      <PenLine size={15} className="shrink-0 text-primary" />
      <h1 className="text-sm font-semibold text-ink">Prompt Studio</h1>
      <span className="min-w-0 truncate text-[11px] text-ink-3" title={threadTitle}>
        {threadId ? <>drafting for <strong className="font-medium text-ink-2">{threadTitle}</strong></> : 'no chat open'}
      </span>
      <span className="min-w-0 flex-1" />
      {modelName && <span className="shrink-0 truncate font-mono text-[10px] text-ink-3" title={tokenBudget ? `${tokenBudget.toLocaleString()}-token window` : undefined}>{modelName}</span>}
      <button type="button" onClick={onOpenChat} className="shrink-0 text-xs text-ink-2 transition hover:text-ink">Done</button>
    </header>

    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* Saved prompts. A draft belongs to a chat; these outlive every chat they were sent to. */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface-2" aria-label="Prompt library">
        <div className="shrink-0 border-b border-line p-2">
          <button type="button" onClick={startNew} className={`${button} w-full justify-center`}><Plus size={12} />New prompt</button>
          <div className="relative mt-2">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
            <input type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search prompts"
              aria-label="Search saved prompts" className={`${field} w-full py-1.5 pl-7 text-[11px]`} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {!library ? <p className="p-2 text-[11px] text-ink-3">The prompt library is unavailable in this window.</p>
            : matches.length === 0 ? <p className="p-2 text-[11px] leading-relaxed text-ink-3">
              {saved.entries.length ? 'No saved prompt matches that.' : 'Nothing saved yet. Write a prompt and press Save to keep it for later.'}
            </p>
            : <ul className="grid gap-0.5">{matches.map((entry) => <li key={entry.id}>
              <button type="button"
                onClick={() => entry.id === openId ? undefined : dirty && text.trim() ? setConfirm({ kind: 'open', entry }) : openSaved(entry)}
                aria-current={entry.id === openId}
                className={`group flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition ${entry.id === openId ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink'}`}>
                <span className="flex w-full min-w-0 items-center gap-1.5">
                  <BookMarked size={11} className={`shrink-0 ${entry.id === openId ? 'text-primary' : 'text-ink-3'}`} />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{entry.title}</span>
                </span>
                <span className="flex w-full items-center gap-1.5 pl-[18px] text-[9px] text-ink-3">
                  <span>{relativeTime(entry.updatedAt)}</span>
                  <span>·</span>
                  <span>{promptStats(entry.body).words} words</span>
                </span>
              </button>
            </li>)}</ul>}
        </div>
      </aside>

      {/* The editor. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <input type="text" value={title} maxLength={MAX_PROMPT_TITLE_LENGTH} onChange={(event) => setTitle(event.target.value)}
            placeholder={promptTitleFrom('', text) === 'Untitled prompt' ? 'Prompt name' : promptTitleFrom('', text)}
            aria-label="Prompt name" className={`${field} min-w-[160px] flex-1`} />
          <button type="button" disabled={!library || busy || !text.trim() || (!!openEntry && !dirty)} onClick={() => void saveToLibrary()}
            title={openEntry ? 'Save over this library prompt' : 'Keep this prompt in the library'} className={button}>
            <Save size={12} />{openEntry ? (dirty ? 'Save' : 'Saved') : 'Save'}
          </button>
          {openEntry && <button type="button" disabled={!library || busy || !text.trim()} onClick={() => void saveToLibrary(true)}
            title="Keep this as a separate library prompt" className={button}><Copy size={12} />Duplicate</button>}
          {openEntry && <button type="button" disabled={busy} onClick={() => setConfirm({ kind: 'delete', entry: openEntry })}
            title={`Delete ${openEntry.title} from the library`} className={button}><Trash2 size={12} className="text-danger" />Delete</button>}
        </div>

        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-line-soft px-3 py-1.5">
          <span className="mr-1 shrink-0 text-[10px] uppercase tracking-wide text-ink-3">Insert</span>
          {PROMPT_BLOCKS.map((block) => <button key={block.id} type="button" onClick={() => addBlock(block.body)} title={block.description}
            className="rounded border border-line px-1.5 py-1 text-[10px] text-ink-2 transition hover:border-primary/60 hover:text-ink">
            {block.id === 'variable' ? <Braces size={10} className="mr-1 inline align-[-1px]" /> : null}{block.label}
          </button>)}
        </div>

        <textarea
          ref={editor}
          value={text}
          onChange={(event) => { setText(event.target.value); trackCaret(); }}
          onKeyUp={trackCaret}
          onClick={trackCaret}
          onSelect={trackCaret}
          // Chromium's spellchecker, with Antimatter's own spelling context menu over it.
          spellCheck
          aria-label="Prompt"
          placeholder={`Write the prompt for ${threadTitle || 'this chat'}. Use {{a field}} for anything you fill in per run.`}
          className="min-h-0 flex-1 resize-none bg-surface px-4 py-3 font-mono text-[13px] leading-relaxed text-ink placeholder:text-ink-3 focus:outline-none"
        />

        {attachments.length > 0 && <div className="flex shrink-0 flex-wrap gap-1.5 border-t border-line-soft px-3 py-2">
          {attachments.map((attachment) => <AttachmentChip key={attachment.id} attachment={attachment}
            onRemove={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} />)}
        </div>}

        {(error || notice) && <div className={`shrink-0 border-t px-3 py-1.5 text-[11px] ${error ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line-soft text-ink-3'}`} role={error ? 'alert' : 'status'}>
          {error || notice}
        </div>}

        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-t border-line bg-surface-2 px-3 py-2">
          <input ref={files} type="file" multiple accept="text/*,.md,.txt,.json,.yaml,.yml,.csv,.ts,.tsx,.js,.py,.ny,.matrix,.nil" className="hidden" onChange={(event) => void attach(event)} />
          <button type="button" onClick={() => files.current?.click()} title="Attach text files to send with this prompt" className={button}><Paperclip size={12} />Attach</button>
          <button type="button" onClick={applyVariables} disabled={!variables.length || !sendable} className={button}
            title={variables.length ? 'Replace every {{field}} in the editor with its value' : 'This prompt has no fields'}><Wand2 size={12} />Apply fields</button>
          <span className="min-w-0 flex-1" />
          <span className="shrink-0 font-mono text-[10px] text-ink-3" role="status">
            Ln {caret.line}, Col {caret.column} · {stats.words.toLocaleString()} words · ~{stats.estimatedTokens.toLocaleString()} tokens
            {tokenBudget ? ` / ${tokenBudget.toLocaleString()}` : ''}
          </span>
          <button type="button" onClick={() => { onNewChat(composed.text, attachments); }} disabled={!sendable} className={button}
            title={sendable ? 'Start a new chat holding this prompt, without sending it' : runReason}><Send size={12} />New chat</button>
          <button type="button" onClick={handleRun} disabled={!threadId || !sendable || !!runBlockedReason} className={primary}
            title={runReason || `Send this prompt on ${threadTitle}`}><Play size={12} />Run in chat</button>
        </div>
      </div>

      {/* What the prompt says, and what it still needs. */}
      <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-surface-2" aria-label="Prompt inspection">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <SpellCheck size={12} className="shrink-0 text-ink-3" />
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Inspection</h2>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">
            {counts.problem ? <span className="text-danger">{counts.problem}</span> : null}
            {counts.problem && (counts.caution || counts.note) ? ' · ' : ''}
            {counts.caution ? <span className="text-warning">{counts.caution}</span> : null}
            {counts.caution && counts.note ? ' · ' : ''}
            {counts.note ? <span>{counts.note}</span> : null}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {variables.length > 0 && <section className="border-b border-line p-3" aria-label="Fields">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Fields</h3>
            <div className="grid gap-2">{variables.map((variable) => <label key={variable.name} className="grid gap-1">
              <span className="flex items-center gap-1.5 font-mono text-[10px] text-ink-2">
                {variable.name}
                {variable.occurrences > 1 && <span className="text-ink-3">×{variable.occurrences}</span>}
                {!variable.value.trim() && <span className="ml-auto text-danger">needed</span>}
              </span>
              <textarea rows={variable.value.includes('\n') ? 3 : 1} value={variable.value} aria-label={`Value for ${variable.name}`}
                onChange={(event) => setValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                className={`${field} resize-y font-mono text-[11px]`} />
            </label>)}</div>
          </section>}

          <section className="p-3" aria-label="Findings">
            {!text.trim() ? <p className="text-[11px] leading-relaxed text-ink-3">
              Nothing to read yet. Spelling is underlined in the editor as you type — right-click a word for corrections.
            </p>
              : findings.length === 0 ? <p className="text-[11px] leading-relaxed text-ink-3">
                Nothing to flag. The prompt names a task, has no placeholders left, and fits the window.
              </p>
                : <ul className="grid gap-1.5">{findings.map((finding, index) => {
                  const Icon = severityIcon[finding.severity];
                  return <li key={`${finding.kind}:${finding.line}:${index}`}>
                    <button type="button" disabled={!finding.line} onClick={() => selectLine(finding.line)}
                      title={finding.line ? `Go to line ${finding.line}` : undefined}
                      className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition ${finding.line ? 'hover:bg-surface-3/60' : 'cursor-default'}`}>
                      <Icon size={12} className={`mt-0.5 shrink-0 ${severityTone[finding.severity]}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] leading-relaxed text-ink-2">{finding.message}</span>
                        {(finding.line > 0 || finding.excerpt) && <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-ink-3">
                          {finding.line > 0 && <span className="shrink-0">Ln {finding.line}</span>}
                          {finding.excerpt && <span className="min-w-0 truncate">{finding.excerpt}</span>}
                        </span>}
                      </span>
                    </button>
                  </li>;
                })}</ul>}
          </section>

          {composed.text && variables.some((variable) => variable.value.trim()) && <section className="border-t border-line p-3" aria-label="As it will be sent">
            <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3"><FileText size={11} />As it will be sent</h3>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-2">{composed.text}</pre>
          </section>}
        </div>
      </aside>
    </div>

    {confirm?.kind === 'delete' && <ConfirmDialog title="Delete this prompt?" tone="danger" confirmLabel="Delete"
      message={`“${confirm.entry.title}” is removed from the library. The text stays in this editor, and any chat you already sent it to is untouched.`}
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        setConfirm(null);
        void run(() => library!.remove(confirm.entry.id), `Deleted ${confirm.entry.title}`).then((result) => {
          if (result && mounted.current) setOpenId(null);
        });
      }} />}

    {confirm?.kind === 'open' && <ConfirmDialog title="Replace the prompt in the editor?" confirmLabel="Open prompt"
      message={`The editor holds text that is not in the library. Opening “${confirm.entry.title}” replaces it. Cancel and press Save first to keep it.`}
      onCancel={() => setConfirm(null)}
      onConfirm={() => { const entry = confirm.entry; setConfirm(null); openSaved(entry); }} />}
  </div>;
}
