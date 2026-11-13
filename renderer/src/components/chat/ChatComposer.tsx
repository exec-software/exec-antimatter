import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ArrowUp, Mic, Plus, Sparkles, Square, X } from 'lucide-react';
import { canAcceptSuggestion, type FollowUpSuggestion } from '../../lib/followUpSuggestion';
import type { AccessSettings, Attachment, Draft, ProviderConfig } from '../../types';
import { desktopPlatform, useDesktopPreferences } from '../../desktopPreferences';
import { displayShortcut, matchesShortcut, mayClickSend } from '../../../../src/api/desktopPreferences';
import { REPLY_PAD_EVENT, type ReplyPadRequest } from '../../lib/replyPad';
import { submitComposerDraft } from '../../lib/composerSubmission';
import { AccessMenu } from './AccessMenu';
import { AttachmentChip } from './AttachmentChip';
import { ModelPicker } from './ModelPicker';

interface Props {
  /** Returns true only after the turn has been accepted into the conversation. */
  onSubmit: (text: string, attachments: Attachment[]) => boolean;
  disabled?: boolean;
  /** Explains a disabled source/model without making the user infer it from an inert button. */
  disabledReason?: string;
  /** Nonblocking lifecycle information, such as an engine waiting for its first request. */
  sourceHint?: string;
  /** A source-specific mode explanation that stays visible beside the draft. */
  sourceNotice?: ReactNode;
  /** Hide tool permissions and refuse attachments for a bounded text-only source. */
  textOnly?: boolean;
  /** Lets a floating composer reserve room for a longer source notice. */
  onHeightChange?(height: number): void;
  /** A turn is in flight; the send control becomes a stop control. */
  streaming?: boolean;
  onStop?: () => void;
  placeholder?: string;
  providers: ProviderConfig[];
  providerId: string;
  modelId: string;
  /** Opens the central Model Library, where selection and configuration live together. */
  onOpenModels: () => void;
  access: AccessSettings;
  accessError?: string;
  onChangeAccess: (settings: AccessSettings) => void;
  /** The directory the tool servers are actually pointed at, chosen here or inherited. */
  workspace: string | null;
  /** False while that directory was inherited rather than chosen; writes are refused. */
  workspaceConfirmed: boolean;
  onConfirmWorkspace: () => void;
  onChooseWorkspace?: () => Promise<string | null>;
  /**
   * Called instead of onSubmit while a turn is running. Typing during a turn is steering, not a
   * new message — the composer stays open so the thought does not have to wait for the model.
   */
  onSteer?: (text: string) => void;
  /** The conversation this composer belongs to. Reported back with the draft, never inferred. */
  threadId: string;
  /** What this conversation was left holding, unsent. */
  draft?: Draft;
  /** Reports it back as it changes, so switching away does not throw it out. */
  onDraftChange?: (threadId: string, draft: Draft) => void;
  suggestion?: FollowUpSuggestion | null;
  onVoice?: () => void;
  voiceActive?: boolean;
  /**
   * Where this is being drawn. `bar` is the full-width strip across the bottom; `band` drops the
   * strip's own border and background because the widget band around it supplies both and centres
   * it; `float` is a free-standing card over the conversation, which is what you get when the
   * band is off and the flanking space would otherwise sit empty.
   */
  variant?: 'bar' | 'band' | 'float';
}

const MAX_ATTACHMENT_BYTES = 256 * 1024;
const MAX_TEXTAREA_HEIGHT = 200;

/** What the shell can do to the composer from outside: put the cursor in it. */
export interface ChatComposerHandle {
  focus(): void;
  /** Puts text back in the box — used when a queued steer is taken back for editing. */
  setText(text: string): void;
  /** Opens the file picker, as the + beside the box does. */
  openFiles(): void;
  /** The actual controlled input, which can be newer than App's debounced draft map. */
  currentDraft(): Draft;
  /** Waits for an attachment read, reports the live draft immediately, and returns that value. */
  flushDraft(): Promise<Draft>;
}

const iconButtonClass =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-3 transition hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-3';

export const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer(
  {
    onSubmit,
    disabled = false,
    disabledReason,
    sourceHint,
    sourceNotice,
    textOnly = false,
    onHeightChange,
    streaming = false,
    onStop,
    placeholder = 'Send a message...',
    providers,
    providerId,
    modelId,
    onOpenModels,
    access,
    accessError,
    onChangeAccess,
    workspace,
    workspaceConfirmed,
    onConfirmWorkspace,
    onChooseWorkspace,
    onSteer,
    threadId,
    draft,
    onDraftChange,
    suggestion = null,
    onVoice,
    voiceActive = false,
    variant = 'bar',
  },
  ref
) {
  // Seeded from the draft this conversation was left with. The composer is keyed by thread, so
  // this runs again on every switch and there is no window where the two can be confused.
  const preferences = useDesktopPreferences();
  const [sendGuard, setSendGuard] = useState('');
  const sendShortcut = displayShortcut(preferences.hotkeys.sendMessage, desktopPlatform());
  const sendClickHint = preferences.sendClickModifier === 'none' ? '' : `Hold ${preferences.sendClickModifier === 'meta' ? (desktopPlatform() === 'darwin' ? 'Command' : 'Windows') : preferences.sendClickModifier === 'ctrl' ? 'Ctrl' : preferences.sendClickModifier === 'alt' ? 'Alt' : 'Shift'} and click to send.`;
  const [message, setMessage] = useState(() => draft?.text ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(() => draft?.attachments ?? []);
  const [skippedNote, setSkippedNote] = useState('');
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFileReads = useRef(0);
  const draftSettledWaiters = useRef(new Set<() => void>());

  /**
   * Hands the unsent text back up so it survives a switch away, a reload, and a restart.
   *
   * Debounced, and flushed on the way out: leaving the conversation is exactly the moment the
   * draft matters, and it is also the moment the debounce would otherwise still be waiting.
   */
  const latest = useRef({ text: message, attachments });
  latest.current = { text: message, attachments };

  // Both paths below close over the thread this instance was rendered for, which is what makes
  // the flush safe: the outgoing composer is never re-rendered with the incoming thread's id.
  const report = useRef(onDraftChange);
  report.current = onDraftChange;

  useEffect(() => {
    if (!onDraftChange) return;
    const timer = window.setTimeout(() => onDraftChange(threadId, latest.current), 250);
    return () => window.clearTimeout(timer);
  }, [message, attachments, onDraftChange, threadId]);

  useEffect(
    () => () => {
      report.current?.(threadId, latest.current);
    },
    [threadId]
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      setText: (text: string) => {
        latest.current = { ...latest.current, text };
        setMessage(text);
        textareaRef.current?.focus();
      },
      openFiles: () => { if (!textOnly) fileInputRef.current?.click(); },
      currentDraft: () => ({ ...latest.current }),
      flushDraft: async () => {
        if (pendingFileReads.current) {
          await new Promise<void>((resolve) => draftSettledWaiters.current.add(resolve));
        }
        const current = { ...latest.current };
        report.current?.(threadId, current);
        return current;
      },
    }),
    [threadId, textOnly]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [message]);

  useEffect(() => {
    const form = formRef.current;
    if (!form || !onHeightChange) return;
    const measure = () => onHeightChange(Math.ceil(form.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(form);
    return () => observer.disconnect();
  }, [onHeightChange]);

  // While a turn is running the composer stays usable, and what you type becomes a steer.
  const steering = streaming && !!onSteer;
  const attachmentProblem = textOnly && attachments.length > 0
    ? 'Remove the attached files to use this text-only preview, or choose another model.' : null;
  const canSend = steering ? message.trim().length > 0 : !disabled && !attachmentProblem && (message.trim().length > 0 || attachments.length > 0);

  const submit = () => {
    setSendGuard('');
    if (!canSend) return;

    if (steering) {
      onSteer(message.trim());
      latest.current = { ...latest.current, text: '' };
      setMessage('');
      return;
    }

    const result = submitComposerDraft({ text: message, attachments }, onSubmit);
    if (!result.accepted) return;

    latest.current = result.nextDraft;
    setMessage(result.nextDraft.text);
    setAttachments(result.nextDraft.attachments);
    setSkippedNote('');
    // Sent is not unsent: the conversation should not still be offering it back.
    onDraftChange?.(threadId, { text: '', attachments: [] });
  };

  const offerSuggestion = !disabled && dismissedSuggestion !== suggestion?.messageId &&
    canAcceptSuggestion({ text: message, attachments }, suggestion, streaming);
  const acceptSuggestion = () => {
    if (!offerSuggestion || !suggestion || !canAcceptSuggestion(latest.current, suggestion, streaming)) return;
    latest.current = { ...latest.current, text: suggestion.text };
    setMessage(suggestion.text);
    onDraftChange?.(threadId, latest.current);
    textareaRef.current?.focus();
  };

  useEffect(() => {
    const receive = (event: Event) => {
      const request = (event as CustomEvent<ReplyPadRequest>).detail;
      if (!request || request.conversationId !== threadId || typeof request.respond !== 'function') return;
      const refuse = (error: string) => request.respond({ accepted: false, error });
      if (!preferences.macroPadEnabled) { refuse('Reply pad is disabled.'); return; }
      if (typeof request.text !== 'string' || !request.text.trim() || request.text.length > 4000) { refuse('Choose a valid saved reply.'); return; }
      if (request.action === 'insert') {
        const text = latest.current.text ? `${latest.current.text}\n\n${request.text}` : request.text;
        latest.current = { ...latest.current, text }; setMessage(text); onDraftChange?.(threadId, latest.current);
        textareaRef.current?.focus(); request.respond({ accepted: true }); return;
      }
      if (request.action !== 'send') { refuse('Unknown reply action.'); return; }
      if (!request.modifiers) { refuse('Missing send gesture.'); return; }
      if (!mayClickSend(request.modifiers, preferences.sendClickModifier)) { refuse(sendClickHint); return; }
      if (latest.current.text.trim() || latest.current.attachments.length) { refuse('Send or clear your current draft first, or use Insert.'); return; }
      if (streaming) {
        if (!onSteer) { refuse('Wait for the current turn to finish.'); return; }
        onSteer(request.text.trim()); request.respond({ accepted: true }); return;
      }
      if (disabled) { refuse(disabledReason ?? 'Choose an available model before sending.'); return; }
      try { request.respond({ accepted: onSubmit(request.text, []) }); }
      catch { refuse('The chat could not accept this reply.'); }
    };
    window.addEventListener(REPLY_PAD_EVENT, receive);
    return () => window.removeEventListener(REPLY_PAD_EVENT, receive);
  }, [threadId, preferences.macroPadEnabled, preferences.sendClickModifier, sendClickHint, streaming, onSteer, disabled, disabledReason, onSubmit, onDraftChange]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Tab' && !event.shiftKey && offerSuggestion) {
      event.preventDefault();
      acceptSuggestion();
    } else if (matchesShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, isComposing: event.nativeEvent.isComposing }, preferences.hotkeys.sendMessage, desktopPlatform())) {
      event.preventDefault();
      submit();
    }
  };

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    if (textOnly) { setSkippedNote('Files are unavailable for this text-only preview.'); return; }
    pendingFileReads.current += 1;

    const added: Attachment[] = [];
    const skipped: string[] = [];
    try {
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          skipped.push(`${file.name} (over 256 KB)`);
          continue;
        }
        const content = await file.text();
        // Text files never contain NUL characters; binary files almost always do.
        if (content.includes(String.fromCharCode(0))) {
          skipped.push(`${file.name} (not a text file)`);
          continue;
        }
        added.push({ id: crypto.randomUUID(), name: file.name, size: file.size, content });
      }
      const nextAttachments = [...latest.current.attachments, ...added];
      latest.current = { ...latest.current, attachments: nextAttachments };
      setAttachments(nextAttachments);
      setSkippedNote(skipped.length ? `Skipped ${skipped.join(', ')}` : '');
    } finally {
      pendingFileReads.current -= 1;
      if (!pendingFileReads.current) {
        for (const settle of draftSettledWaiters.current) settle();
        draftSettledWaiters.current.clear();
      }
    }
  };

  const shell = variant === 'band'
    // The band owns the row's edge and fill, and centres this itself.
    ? 'px-3 pb-3 pt-3'
    : variant === 'float'
      // Floating: its own rounded, shadowed edge, and it must not swallow clicks beside itself.
      ? 'pointer-events-auto rounded-2xl border border-line bg-surface-2/95 px-4 pb-3 pt-3 shadow-xl backdrop-blur'
      : 'border-t border-line bg-surface-2 px-4 pb-3 pt-3';

  return (
    <form ref={formRef} className={shell} onSubmit={(event) => event.preventDefault()}>
      <div className={variant === 'bar' ? 'mx-auto w-full max-w-3xl' : 'w-full'}>
        {sourceNotice}
        {accessError && <p role="alert" className="mb-2 text-xs text-danger">{accessError}</p>}
        <div className="rounded-xl border border-line bg-surface-3 transition focus-within:border-primary/60">
          {offerSuggestion && suggestion && (
            <div className="flex items-center gap-2 px-3.5 pt-3 text-xs text-ink-3">
              <button type="button" onClick={acceptSuggestion} title="Use suggestion in draft (Tab)"
                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-ink focus-visible:outline-primary">
                <Sparkles size={13} className="shrink-0 text-primary" />
                <span className="truncate">{suggestion.text}</span>
                <kbd className="ml-auto shrink-0 rounded border border-line px-1 text-[10px]">Tab</kbd>
              </button>
              <button type="button" aria-label="Dismiss suggestion" onClick={() => setDismissedSuggestion(suggestion.messageId)}
                className="rounded p-1 hover:bg-surface-2"><X size={12} /></button>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() => {
                    const next = latest.current.attachments.filter((item) => item.id !== attachment.id);
                    latest.current = { ...latest.current, attachments: next };
                    setAttachments(next);
                  }}
                />
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            aria-label="Message"
            spellCheck={true}
            value={message}
            onChange={(event) => {
              const text = event.target.value;
              latest.current = { ...latest.current, text };
              setMessage(text);
            }}
            onKeyDown={handleKeyDown}
            placeholder={steering ? 'Steer the model — sent when it next comes up for air' : placeholder}
            rows={1}
            disabled={disabled && !steering}
            className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-60"
          />

          <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
            <input ref={fileInputRef} type="file" multiple hidden onChange={handleFiles} />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || textOnly}
              aria-label="Add files"
              title={textOnly ? 'Files are unavailable for this text-only preview' : 'Add files'}
              className={iconButtonClass}
            >
              <Plus size={17} />
            </button>
            {!textOnly && <AccessMenu
                settings={access}
                onChange={onChangeAccess}
                workspace={workspace}
                confirmed={workspaceConfirmed}
                onConfirm={onConfirmWorkspace}
                onChooseDirectory={onChooseWorkspace}
              />}

            <div className="ml-auto flex min-w-0 items-center gap-1">
              <ModelPicker
                providers={providers}
                providerId={providerId}
                modelId={modelId}
                disabled={streaming}
                onOpen={onOpenModels}
              />
              {onVoice && <button type="button" onClick={onVoice} aria-label={voiceActive ? 'Open active voice controls' : 'Open live voice'}
                aria-pressed={voiceActive} title={voiceActive ? 'Voice active' : 'Live voice'}
                className={`${iconButtonClass} ${voiceActive ? 'bg-primary/15 text-primary' : ''}`}><Mic size={17} /></button>}
              <button
                type="button"
                onClick={(event) => {
                  if (streaming && !(steering && canSend)) { onStop?.(); return; }
                  if (!mayClickSend(event, preferences.sendClickModifier)) { setSendGuard(sendClickHint); return; }
                  submit();
                }}
                disabled={steering && canSend ? false : streaming ? !onStop : !canSend}
                aria-label={steering && canSend ? 'Queue steer' : streaming ? 'Stop generating' : 'Send message'}
                title={
                  steering && canSend
                    ? `Queue steer. ${sendClickHint}`
                    : streaming
                      ? 'Stop this turn'
                      : `Send. ${sendClickHint}`
                }
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-3 ${
                  steering && canSend
                    ? 'bg-primary text-on-primary hover:bg-primary-strong'
                    : streaming
                      ? 'bg-danger text-on-danger hover:brightness-110'
                      : 'bg-primary text-on-primary hover:bg-primary-strong'
                }`}
              >
                {streaming && !(steering && canSend) ? (
                  <Square size={13} strokeWidth={3} fill="currentColor" />
                ) : (
                  <ArrowUp size={16} strokeWidth={2.5} />
                )}
              </button>
            </div>
          </div>
        </div>

        {sendGuard && <p role="status" className="mt-2 px-1 text-[11px] text-ink-2">{sendGuard}</p>}
        {attachmentProblem ? (
          <p role="alert" className="mt-2 px-1 text-[11px] text-danger">{attachmentProblem}</p>
        ) : skippedNote ? (
          <p className="mt-2 px-1 text-[11px] text-danger">{skippedNote}</p>
        ) : disabledReason ? (
          <p className="mt-2 px-1 text-[11px] text-danger">{disabledReason}</p>
        ) : sourceHint ? (
          <p className="mt-2 px-1 text-[11px] text-ink-3" role="status">{sourceHint}</p>
        ) : (
          <p className="mt-2 px-1 text-[11px] text-ink-3">{sendShortcut} to send · {preferences.hotkeys.sendMessage === 'Enter' ? 'Shift+Enter' : 'Enter'} for a new line{sendClickHint ? ` · ${sendClickHint}` : ''}</p>
        )}
      </div>
    </form>
  );
});
