import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, ChevronDown, ChevronRight, Circle, CircleDot, CircleSlash, MessageCircleQuestion,
  MessagesSquare, Square, SquareCheck, TriangleAlert, X,
} from 'lucide-react';
import { askIdFor, parseAskRequest, type AskQuestion } from '../../../../src/api/ask';
import type { AskOutcomeMessage, ToolActivity } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';

/** The one app-owned server that asks the person things. */
export const ASK_SERVER_ID = 'antimatter.ask';

/** Which calls get this card. Shared so the transcript and the Flow view cannot disagree. */
export const isAskActivity = (activity: ToolActivity): boolean => activity.serverId === ASK_SERVER_ID;

interface Props {
  activity: ToolActivity;
  /** True only while the owning assistant turn still has a live main-process run. */
  isActive: boolean;
}

/** Per question: the labels ticked, and whatever was typed. */
interface Draft {
  chosen: string[];
  text: string;
}

const emptyDraft = (): Draft => ({ chosen: [], text: '' });

/**
 * The model's question in the transcript.
 *
 * Not a tool row, for the same reason the Vault's is not: every other card in a transcript
 * reports something that already happened, and this one is the only one that is waiting on the
 * person reading it. So it gets a frame, the question in full at the top, and answers big enough
 * to hit — and it says in its own words that the turn is held up, because the cost of missing
 * this card is a model sitting idle rather than a line of history gone unread.
 *
 * Three things are deliberate, and each is a thing a worse version of this card would get wrong.
 *
 * **Free text is always offered.** The options are the model's guess at the answers; the box is
 * there for when the guess is wrong, which is exactly when a multiple-choice question does the
 * most damage. A person forced to pick the nearest wrong option has been actively misled, and
 * the model then builds on an answer nobody meant to give.
 *
 * **"Discuss instead" is a real answer, not an escape hatch.** Sometimes the question is the
 * problem — premature, or resting on something the model has misunderstood — and the useful reply
 * is a conversation, not a selection. It resolves the call with that fact, so the turn ends and
 * the model talks instead of asking again.
 *
 * **Nothing here can be left ambiguous.** An answered card shows what was answered, a stale one
 * says so rather than offering buttons that quietly do nothing, and a card whose turn died says
 * the decision never reached the model. A question you cannot tell the state of is worse than no
 * question, because you will assume it was taken as read.
 */
export function AskActivityCard({ activity, isActive }: Props) {
  // Parsed from the call's own arguments rather than from a live event, so the card is identical
  // whether it was just asked or rebuilt from the transcript after a reload.
  const questions = useMemo<readonly AskQuestion[]>(() => {
    try {
      return parseAskRequest(JSON.parse(activity.args || '{}')).questions;
    } catch {
      return [];
    }
  }, [activity.args]);

  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(emptyDraft));
  const [sent, setSent] = useState<'answered' | 'discuss' | 'dismissed' | null>(null);
  const [sending, setSending] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [showResult, setShowResult] = useState(false);
  const firstOption = useRef<HTMLButtonElement | null>(null);

  // A question that arrives while the person is reading should take the focus for its first
  // answer, so it can be answered from the keyboard without hunting for where it landed.
  const live = isActive && (activity.status === 'running' || activity.status === 'pending');
  const waiting = live && !sent && !stale;
  useEffect(() => {
    if (waiting) firstOption.current?.focus({ preventScroll: true });
  }, [waiting]);

  const askId = askIdFor(activity.requestId, activity.activityId ?? activity.callId);

  const complete = questions.length > 0 && drafts.length === questions.length
    && drafts.every((draft) => draft.chosen.length > 0 || draft.text.trim().length > 0);

  const toggle = (index: number, label: string, multiSelect: boolean): void => {
    setDrafts((previous) => previous.map((draft, at) => {
      if (at !== index) return draft;
      if (!multiSelect) return { ...draft, chosen: draft.chosen[0] === label ? [] : [label] };
      return draft.chosen.includes(label)
        ? { ...draft, chosen: draft.chosen.filter((kept) => kept !== label) }
        : { ...draft, chosen: [...draft.chosen, label] };
    }));
  };

  const send = async (outcome: AskOutcomeMessage): Promise<void> => {
    setSending(true);
    setError('');
    try {
      const accepted = await window.electronAPI.tools.answer(askId, outcome);
      // Not an error and not a success: there is simply nothing waiting for this any more. Say
      // that, rather than letting the card look as though the answer landed.
      if (!accepted) setStale(true);
      else setSent(outcome.kind);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That answer could not be sent.');
      console.error(cause);
    } finally {
      setSending(false);
    }
  };

  const answer = (): Promise<void> => send({
    kind: 'answered',
    answers: drafts.map((draft) => ({ chosen: draft.chosen, text: draft.text.trim() || null })),
  });

  // Whatever was typed goes with it: a person who writes "not sure, the second one worries me"
  // and then clicks Discuss has already said the useful part.
  const discuss = (): Promise<void> => send({
    kind: 'discuss',
    note: drafts.map((draft) => draft.text.trim()).filter(Boolean).join(' ') || null,
  });

  const state = (() => {
    if (error) return { label: 'Not sent', tone: 'text-danger' as const };
    if (stale) return { label: 'No longer waiting', tone: 'text-ink-3' as const };
    if (sent === 'answered') return { label: 'Answered', tone: 'text-ink-2' as const };
    if (sent === 'discuss') return { label: 'Moved to the chat', tone: 'text-ink-2' as const };
    if (sent === 'dismissed') return { label: 'Left unanswered', tone: 'text-ink-3' as const };
    if (waiting) return { label: sending ? 'Sending…' : 'Waiting on you', tone: 'text-primary' as const };
    if (!isActive && (activity.status === 'running' || activity.status === 'pending')) {
      return { label: 'Interrupted', tone: 'text-danger' as const };
    }
    if (activity.status === 'failed') return { label: 'Not asked', tone: 'text-danger' as const };
    if (activity.status === 'done') return { label: 'Answered', tone: 'text-ink-3' as const };
    return { label: 'Asking…', tone: 'text-ink-3' as const };
  })();

  const icon = () => {
    if (waiting) return <MessageCircleQuestion size={15} className="shrink-0 text-primary" />;
    if (error || stale || (!isActive && live === false && (activity.status === 'running' || activity.status === 'pending'))) {
      return <TriangleAlert size={14} className="shrink-0 text-danger" />;
    }
    if (sent === 'dismissed') return <CircleSlash size={14} className="shrink-0 text-ink-3" />;
    if (sent === 'discuss') return <MessagesSquare size={14} className="shrink-0 text-ink-3" />;
    if (sending) return <AtomIndicator phase="thinking" size={15} />;
    if (sent === 'answered' || activity.status === 'done') return <Check size={14} className="shrink-0 text-ink-3" />;
    if (activity.status === 'failed') return <TriangleAlert size={14} className="shrink-0 text-danger" />;
    return <MessageCircleQuestion size={15} className="shrink-0 text-ink-3" />;
  };

  // A question with no readable arguments is a bug, not a thing to ask someone. Say so plainly
  // rather than drawing an empty frame with a send button.
  if (!questions.length) {
    return (
      <div className="my-1.5 min-w-0 rounded-md border border-line bg-surface-2/40 px-3 py-2.5">
        <p className="flex items-center gap-2 text-[13px] leading-5 text-ink-2">
          <TriangleAlert size={14} className="shrink-0 text-danger" aria-hidden="true" />
          The model tried to ask a question, but it could not be read.
        </p>
      </div>
    );
  }

  const failure = error
    || (stale ? 'The turn had already moved on, so this answer was not used. Nothing was decided by it.' : '')
    || (!isActive && (activity.status === 'running' || activity.status === 'pending')
      ? 'The turn ended while this question was open. The model was never given an answer.' : '')
    || (activity.status === 'failed' && !sent ? activity.result?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? '' : '');

  return (
    <div
      className={`my-1.5 min-w-0 rounded-md border px-3 py-2.5 ${waiting ? 'border-primary/50 bg-primary/5' : 'border-line bg-surface-2/40'}`}
      // Polite, not assertive: the toast and the window badge are what chase someone who is
      // elsewhere. A person already reading the transcript should not be interrupted mid-sentence.
      aria-live={waiting ? 'polite' : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">{icon()}</span>
        <p className="min-w-0 flex-1 text-[13px] leading-5 text-ink">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Question</span>{' '}
          <span className="text-ink-2">
            {questions.length === 1 ? 'The model needs a decision from you' : `${questions.length} decisions needed from you`}
          </span>
        </p>
        <span role="status" aria-live="polite" className={`shrink-0 text-[11px] font-medium ${state.tone}`}>{state.label}</span>
      </div>

      {waiting && (
        <p className="mt-1 text-[11px] leading-4 text-ink-3">
          The turn is paused here. Answering carries it on from this point, with everything it has
          already worked out still in hand.
        </p>
      )}

      <div className="mt-2.5 space-y-3">
        {questions.map((question, index) => {
          const draft = drafts[index] ?? emptyDraft();
          const Marker = question.multiSelect
            ? { on: SquareCheck, off: Square }
            : { on: CircleDot, off: Circle };
          return (
            <fieldset key={`${question.header}:${index}`} className="min-w-0 border-0 p-0">
              <legend className="mb-1.5 min-w-0 text-[13px] leading-5 text-ink">
                <span className="mr-1.5 rounded bg-surface-0 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                  {question.header}
                </span>
                {question.question}
              </legend>

              {question.options.length > 0 && (
                <div className="space-y-1">
                  {question.options.map((option, optionIndex) => {
                    const picked = draft.chosen.includes(option.label);
                    const Icon = picked ? Marker.on : Marker.off;
                    // Once the card has settled it reports the decision rather than offering it:
                    // the options not taken are noise, and a button that no longer does anything
                    // is worse than noise. A card rebuilt from history has no draft to show, so
                    // the recorded result below is what carries the answer there.
                    if (!waiting) {
                      if (!picked) return null;
                      return (
                        <p key={option.label} className="flex items-start gap-1.5 text-xs leading-5 text-ink-2">
                          <Check size={12} className="mt-1 shrink-0 text-ink-3" aria-hidden="true" />
                          <span>{option.label}</span>
                        </p>
                      );
                    }
                    return (
                      <button
                        key={option.label}
                        ref={index === 0 && optionIndex === 0 ? firstOption : undefined}
                        type="button"
                        role={question.multiSelect ? 'checkbox' : 'radio'}
                        aria-checked={picked}
                        disabled={!waiting || sending}
                        onClick={() => toggle(index, option.label, question.multiSelect)}
                        className={`flex w-full min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-strong focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
                          picked ? 'border-primary/60 bg-primary/10' : 'border-line hover:border-primary/40 hover:bg-surface-0/60'
                        }`}
                      >
                        <Icon size={13} className={`mt-0.5 shrink-0 ${picked ? 'text-primary' : 'text-ink-3'}`} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-medium leading-5 text-ink">{option.label}</span>
                          {option.description && (
                            <span className="mt-0.5 block text-[11px] leading-4 text-ink-3">{option.description}</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/*
                Always present while the question is open, never labelled "other". The options are
                a shortcut, and the box is the actual answer field: a person whose answer is
                "neither, use the one in config/" must not have to pick a wrong option first.
              */}
              {waiting && (
                <div className="mt-1.5">
                  <label className="sr-only" htmlFor={`${askId}:${index}:text`}>
                    Answer {question.header} in your own words
                  </label>
                  <textarea
                    id={`${askId}:${index}:text`}
                    rows={question.options.length ? 1 : 3}
                    value={draft.text}
                    disabled={sending}
                    placeholder={question.options.length ? 'Or say it in your own words…' : 'Your answer…'}
                    onChange={(event) => {
                      const { value } = event.target;
                      setDrafts((previous) => previous.map((entry, at) => (at === index ? { ...entry, text: value } : entry)));
                    }}
                    onKeyDown={(event) => {
                      // Enter sends when the answer is usable; Shift+Enter keeps a newline, since
                      // an answer in prose is sometimes two sentences.
                      if (event.key === 'Enter' && !event.shiftKey && complete && !sending) {
                        event.preventDefault();
                        void answer();
                      }
                    }}
                    className="w-full resize-y rounded-md border border-line bg-surface-0 px-2.5 py-1.5 text-xs leading-5 text-ink placeholder:text-ink-3 focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  />
                </div>
              )}

              {/* What was typed, kept visible once the card has settled. */}
              {!waiting && draft.text.trim() && (
                <p className="mt-1 text-xs leading-5 text-ink-2">{draft.text.trim()}</p>
              )}
            </fieldset>
          );
        })}
      </div>

      {failure && (
        <p role={error ? 'alert' : undefined} className="mt-2 text-[11px] leading-4 text-danger/90">{failure}</p>
      )}

      {sent === 'discuss' && !failure && (
        <p className="mt-2 text-[11px] leading-4 text-ink-3">
          The model will come back to this in the conversation instead of deciding it here.
        </p>
      )}

      {/*
        What the model was actually told. The authority on a settled question, and the only
        record a card rebuilt from history has: local state is gone after a reload, but this was
        written into the transcript. Collapsed, because the answer above is the readable form.
      */}
      {activity.result && !waiting && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setShowResult((previous) => !previous)}
            aria-expanded={showResult}
            className="-ml-1 flex min-h-6 items-center gap-1 rounded px-1 text-[11px] text-ink-3 transition hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            {showResult ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            What the model was told
          </button>
          {showResult && (
            <pre
              tabIndex={0}
              className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface-0 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              {activity.result}
            </pre>
          )}
        </div>
      )}

      {waiting && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void answer()}
            disabled={!complete || sending}
            className="flex min-h-7 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-strong focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <Check size={12} aria-hidden="true" />
            {sending ? 'Sending…' : questions.length === 1 ? 'Send answer' : 'Send answers'}
          </button>
          <button
            type="button"
            onClick={() => void discuss()}
            disabled={sending}
            title="End the turn and talk it over in the conversation instead"
            className="flex min-h-7 items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-ink-2 transition hover:border-primary/50 hover:text-ink disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <MessagesSquare size={12} aria-hidden="true" />
            Discuss this
          </button>
          <button
            type="button"
            onClick={() => void send({ kind: 'dismissed' })}
            disabled={sending}
            className="ml-auto flex min-h-7 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink-3 transition hover:text-ink-2 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            <X size={12} aria-hidden="true" />
            Not now
          </button>
        </div>
      )}
    </div>
  );
}
