import { useEffect, useRef, useState } from 'react';
import { Check, Copy, CornerDownLeft, Eraser, ShieldAlert, X, Zap } from 'lucide-react';
import { parseSegments } from '../../lib/markdown';
import { beginDrag } from '../../plugins/drag';
import { Reactor } from './Reactor';
import { actions, useAvatar, type CoreTurn } from './store';
import { NAME, statusLine, TAGLINE, GREETING } from './persona';

/**
 * The floating core.
 *
 * The point of it is that you do not leave the file. A question about the function under the
 * caret, a retry loop you want written — asked and answered without a window change, and the
 * answer goes in at the caret rather than through the clipboard.
 *
 * It is dragged rather than docked because there is no right place for it: it has to be near the
 * code you are looking at, and that moves.
 */

const ORB = 54;
const MARGIN = 16;
const PANEL_WIDTH = 340;

interface Props {
  /** Which source answers, and under what permissions — the same ones chat is using. */
  source: { providerId: string; model: string; accessMode: string };
}

/** A code block from an answer, with the button that is the whole point: put it in the file. */
function Block({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const [inserted, setInserted] = useState(false);

  return (
    <div className="my-1.5 overflow-hidden rounded border border-line">
      <div className="flex items-center gap-1 border-b border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3">
        <span className="min-w-0 flex-1 truncate">{language || 'code'}</span>
        <button
          type="button"
          title="Copy"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="rounded px-1 text-ink-3 transition hover:text-ink"
        >
          {copied ? <Check size={10} className="text-accent" /> : <Copy size={10} />}
        </button>
        <button
          type="button"
          title="Insert at the caret"
          onClick={() => {
            actions.insert(code);
            setInserted(true);
            window.setTimeout(() => setInserted(false), 1200);
          }}
          className="flex items-center gap-0.5 rounded px-1 text-primary transition hover:text-primary-strong"
        >
          {inserted ? <Check size={10} /> : <CornerDownLeft size={10} />}
          {inserted ? 'In' : 'Insert'}
        </button>
      </div>
      <pre className="max-h-48 overflow-auto bg-surface-0 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-2">
        {code}
      </pre>
    </div>
  );
}

function Turn({ turn }: { turn: CoreTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="mb-2 ml-6 rounded-md rounded-br-sm bg-primary/12 px-2 py-1 text-[11px] text-ink">
        {turn.content}
      </div>
    );
  }

  const segments = parseSegments(turn.content);
  return (
    <div className="mb-2 text-[11px] leading-relaxed text-ink-2">
      {turn.content.trim() === '' && turn.streaming ? (
        <span className="shimmer-text">…</span>
      ) : (
        segments.map((segment, index) =>
          segment.kind === 'code' ? (
            <Block key={index} code={segment.code} language={segment.language} />
          ) : (
            <p key={index} className="whitespace-pre-wrap break-words">
              {segment.text}
            </p>
          )
        )
      )}
    </div>
  );
}

export function Avatar({ source }: Props) {
  const state = useAvatar();
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  // Default corner, resolved once the window size is known.
  const position =
    state.position.x < 0
      ? // Clear of the tool stripe on the right edge, and of the console at the bottom.
        { x: window.innerWidth - ORB - MARGIN * 4, y: window.innerHeight - ORB - MARGIN * 6 }
      : state.position;

  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [state.turns]);

  /**
   * Ctrl+I brings it up with the caret already in the box. The whole premise is not leaving the
   * file, and reaching for a floating orb with the mouse is still leaving the file.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'i') return;
      event.preventDefault();
      actions.toggle();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const running = !!state.runId;
  const status = statusLine(
    state.state,
    state.approval?.toolName ?? state.tool?.toolName ?? state.error,
    state.seed
  );

  const send = () => {
    const prompt = text.trim();
    if (!prompt || running) return;
    setText('');
    void actions.ask(prompt, source);
  };

  // The panel opens toward whichever side has room, so it is never half off screen.
  const openLeft = position.x + ORB / 2 > window.innerWidth / 2;
  const openUp = position.y + ORB / 2 > window.innerHeight / 2;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-40"
      // The layer covers the window so the panel can extend past the orb; only the pieces take clicks.
      aria-live="polite"
    >
      <div className="pointer-events-auto absolute" style={{ left: position.x, top: position.y }}>
        {state.open && (
          <div
            className="absolute flex w-[340px] flex-col overflow-hidden rounded-lg border border-line bg-surface-2 shadow-2xl shadow-black/60"
            style={{
              // Beside the orb on whichever side has room, and aligned to the nearer edge.
              [openLeft ? 'right' : 'left']: ORB + 10,
              [openUp ? 'bottom' : 'top']: 0,
              maxHeight: 'min(460px, 70vh)',
              width: PANEL_WIDTH,
            }}
          >
            <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
              <span className="wordmark text-[11px] tracking-wider text-ink">{NAME}</span>
              <span className="text-[10px] text-ink-3">{TAGLINE}</span>
              <span
                className={`ml-auto truncate text-[10px] ${
                  state.state === 'error'
                    ? 'text-danger'
                    : state.state === 'waiting'
                      ? 'text-warning'
                      : running
                        ? 'text-accent'
                        : 'text-ink-3'
                }`}
                title={status}
              >
                {status}
              </span>
              <button
                type="button"
                title={running ? 'Stop it first — the turn is still going' : 'Clear this exchange'}
                disabled={running}
                onClick={() => actions.clear()}
                className="rounded p-0.5 text-ink-3 transition hover:text-ink disabled:opacity-30"
              >
                <Eraser size={11} />
              </button>
              <button
                type="button"
                title="Close"
                onClick={() => actions.close()}
                className="rounded p-0.5 text-ink-3 transition hover:text-ink"
              >
                <X size={12} />
              </button>
            </div>

            <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {state.turns.length === 0 ? (
                <p className="text-[11px] leading-relaxed text-ink-3">{GREETING}</p>
              ) : (
                state.turns.map((turn) => <Turn key={turn.id} turn={turn} />)
              )}
            </div>

            {state.approval && (
              <div className="shrink-0 border-t border-warning/40 bg-warning/10 px-2 py-1.5">
                <p className="flex items-center gap-1 text-[11px] text-ink">
                  <ShieldAlert size={11} className="shrink-0 text-warning" />
                  <span className="min-w-0 flex-1 truncate font-mono">{state.approval.toolName}</span>
                </p>
                <p className="mt-0.5 max-h-16 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] text-ink-3">
                  {state.approval.args}
                </p>
                <div className="mt-1 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void actions.approve(true)}
                    className="rounded bg-primary px-2 py-0.5 text-[11px] font-semibold text-on-primary"
                  >
                    Allow
                  </button>
                  <button
                    type="button"
                    onClick={() => void actions.approve(false)}
                    className="rounded border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:text-ink"
                  >
                    Refuse
                  </button>
                </div>
              </div>
            )}

            {state.error && !state.approval && (
              <button
                type="button"
                onClick={() => actions.clearError()}
                className="shrink-0 border-t border-danger/40 bg-danger/10 px-2 py-1 text-left text-[10px] text-danger"
              >
                {state.error}
              </button>
            )}

            <div className="shrink-0 border-t border-line p-1.5">
              <textarea
                rows={2}
                autoFocus
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder="Ask about this file, or say what to write"
                className="w-full resize-none rounded border border-line bg-surface-3 px-2 py-1 text-[11px] text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none"
              />
              <div className="mt-1 flex items-center gap-1.5">
                {running ? (
                  <button
                    type="button"
                    onClick={() => void actions.scram()}
                    title="Drop the rods — stop this turn, keep what it wrote"
                    className="flex items-center gap-1 rounded bg-danger px-2 py-0.5 text-[11px] font-semibold text-on-danger"
                  >
                    <Zap size={11} />
                    SCRAM
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={send}
                    disabled={!text.trim()}
                    className="rounded bg-primary px-2 py-0.5 text-[11px] font-semibold text-on-primary disabled:opacity-40"
                  >
                    Send
                  </button>
                )}
                <span className="ml-auto truncate text-[10px] text-ink-3" title={`${source.model} · Ctrl+I toggles this`}>
                  {source.model || 'no model'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* The orb: drag it anywhere, click it to talk. */}
        <button
          type="button"
          title={`${NAME} — ${status}`}
          onPointerDown={(event) => {
            moved.current = false;
            const origin = { ...position };
            setDragging(true);
            beginDrag(
              event,
              ({ dx, dy }) => {
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true;
                actions.move({
                  x: Math.min(Math.max(0, origin.x + dx), window.innerWidth - ORB),
                  y: Math.min(Math.max(0, origin.y + dy), window.innerHeight - ORB),
                });
              },
              () => setDragging(false)
            );
          }}
          onClick={() => {
            // A drag that ends over the orb must not also count as a click.
            if (!moved.current) actions.toggle();
          }}
          className={`relative block rounded-full transition-transform ${dragging ? 'scale-105 cursor-grabbing' : 'cursor-grab hover:scale-105'}`}
          style={{ width: ORB, height: ORB }}
        >
          <Reactor state={state.state} size={ORB} />
        </button>
      </div>
    </div>
  );
}
