import { useEffect, useState } from 'react';
import { Activity, CircleCheck, CircleDot, CircleAlert, Gauge, Layers, Link2, LoaderCircle, NotebookPen, PanelRight, Timer, Waves } from 'lucide-react';
import { formatElapsedMilliseconds, formatElapsedSeconds } from '../../lib/duration';
import { isBundledNativeSource } from '../../lib/inferenceUx';
import { estimateTokens } from '../../lib/telemetry';
import type { ContextReport, ProviderConfig, StreamStats, ViewMode } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';
import { CarbonBadge } from '../chat/CarbonBadge';
import { ChatNotesPanel } from '../chat/ChatNotesPanel';
import { ViewModeSwitch } from './ViewModeSwitch';
import { ThinkingControl } from './ThinkingControl';
import type { InferenceMetrics } from '../../../../src/api/types';
import { InferencePromptStatus } from '../status/InferencePromptStatus';

interface Props {
  stats: StreamStats;
  inference?: InferenceMetrics;
  sessionStartedAt: number;
  error: string;
  /** The window as it stood for the last turn; null before anything has been sent. */
  context: ContextReport | null;
  /** The open conversation, for the carbon badge. */
  thread: { id: string; title: string } | null;
  /** The source handling the current turn, used only for honest performance guidance. */
  source: ProviderConfig | null;
  /** The model the next request will use, for the thinking control. */
  modelId?: string;
  viewMode: ViewMode;
  onChangeViewMode: (mode: ViewMode) => void;
  assistantName?: string;
  debug?: { open: boolean; onToggle(): void };
  coordination?: { open: boolean; pending: number; onToggle(): void };
  /** The panel beside the transcript: whether it is showing, and whether there is room for it. */
  panel?: { open: boolean; available: boolean; onToggle: () => void };
}

const PHASE_LABEL = {
  idle: 'Ready',
  thinking: 'Thinking',
  streaming: 'Working',
  done: 'Done',
  error: 'Failed',
} as const;

const PHASE_CLASS = {
  idle: 'text-ink-3',
  thinking: 'shimmer-text',
  streaming: 'shimmer-text-accent',
  done: 'text-ink-2',
  error: 'text-danger',
} as const;

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Thousands, because a context window in full digits is unreadable at this size. */
const thousands = (tokens: number) => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens));

const SOURCE_NOTE: Record<ContextReport['contextSource'], string> = {
  override: 'set by you',
  server: 'reported by the source',
  known: "the model's published window — not confirmed by this server",
  default: 'a conservative default; no window was reported or recognised',
};

/** What the conversation was told before it started, in a sentence; empty when it was told nothing. */
const toldBefore = (memory: ContextReport['memory']): string => {
  if (!memory) return '';
  const parts = [
    ...(memory.instructions.length ? [memory.instructions.map((file) => file.label).join(' and ')] : []),
    ...(memory.notes.user ? [`${memory.notes.user} ${memory.notes.user === 1 ? 'note' : 'notes'} about you`] : []),
    ...(memory.notes.project ? [`${memory.notes.project} ${memory.notes.project === 1 ? 'note' : 'notes'} about this project`] : []),
  ];
  return parts.length ? `Given before it started: ${parts.join(', ')}. ` : '';
};

export function ChatHeader({ stats, inference, sessionStartedAt, error, context, thread, source, modelId, viewMode, onChangeViewMode, panel, assistantName = 'Antimatter', debug, coordination }: Props) {
  const [notesThread, setNotesThread] = useState<{ id: string; title: string } | null>(null);
  const active = stats.phase === 'thinking' || stats.phase === 'streaming';
  const now = useNow(active ? 100 : 1000);

  const tokens = estimateTokens(stats.chunks, stats.chars);
  // Holding for agents is not generating: the rate is the one it had when it stopped writing.
  const waiting = active && stats.waitingSince > 0;
  const generationEnd = stats.phase === 'streaming' && !waiting ? now : stats.lastTokenAt;
  const generationSeconds = stats.firstTokenAt ? (generationEnd - stats.firstTokenAt) / 1000 : 0;
  const rate = generationSeconds >= 0.25 ? tokens / generationSeconds : null;
  const turnSeconds = stats.startedAt ? ((active ? now : stats.finishedAt) - stats.startedAt) / 1000 : 0;

  const rateText = rate === null ? '—' : rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);

  /**
   * Seconds since the source last sent a frame or status update. A keepalive confirms a
   * responding connection; it does not establish prompt-processing or generation progress.
   */
  const silentFor = active && stats.lastAliveAt ? (now - stats.lastAliveAt) / 1000 : null;
  const recentlyAlive = silentFor !== null && silentFor < 20;
  /**
   * A cold local model reads its weights for minutes before it can answer a single token. The
   * source says so, and saying it back is the difference between a turn that is starting and one
   * that has hung — the two looked identical here, and only one is worth waiting out.
   */
  const loading = active && recentlyAlive ? stats.aliveNote : undefined;
  const phaseLabel = waiting
    ? 'Waiting on agents'
    : loading
      ? loading.label
      : active && inference?.phase === 'prefill'
        ? 'Processing prompt'
        : stats.phase === 'thinking'
        ? recentlyAlive
          ? 'Waiting for reply'
          : stats.lastAliveAt
            ? 'Waiting'
            : 'Connecting'
        : PHASE_LABEL[stats.phase];
  /** The runtime's own count where it gives one, so it includes a load already under way. */
  const loadingSeconds = loading ? (loading.seconds ?? Math.round(turnSeconds)) : 0;
  const loadingTitle = loading
    ? `${loading.model ?? 'The model'} is loading — ${formatElapsedSeconds(loadingSeconds)} so far. The request will be sent again as soon as it answers.`
    : undefined;
  const slowBundledTurn =
    stats.phase === 'thinking' && turnSeconds >= 60 && !!source && isBundledNativeSource(source);
  const rateTitle = stats.firstTokenAt
    ? `≈${tokens} tokens · first token after ${formatElapsedSeconds((stats.firstTokenAt - stats.startedAt) / 1000)}`
    : 'Tokens per second for the latest reply';

  return (
    <header className="border-b border-line bg-surface-2 px-4 py-2.5">
      <div className="flex w-full min-w-0 items-center gap-3">
        {/* One line, always: when room runs out the title gives way first, then the readings are clipped. */}
        <div className="flex min-w-0 flex-1 items-center gap-x-3 overflow-hidden whitespace-nowrap">
          <AtomIndicator phase={stats.phase} size={24} />
          <h1 className="min-w-[72px] max-w-[260px] shrink truncate text-sm font-medium text-ink" title={thread?.title}>
            {thread?.title ?? assistantName}
          </h1>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line" />
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-surface-3 px-1.5 py-1 text-xs font-medium tabular-nums"
            title={loadingTitle ?? phaseLabel}
          >
            <span
              role="status"
              aria-label={phaseLabel}
              className={waiting || loading ? PHASE_CLASS.thinking : PHASE_CLASS[stats.phase]}
            >
              {active ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> :
                stats.phase === 'error' ? <CircleAlert size={14} aria-hidden="true" /> :
                stats.phase === 'done' ? <CircleCheck size={14} aria-hidden="true" /> : <CircleDot size={14} aria-hidden="true" />}
            </span>
            {stats.phase !== 'idle' && stats.phase !== 'error' && (
              <span className="text-ink-3">{formatElapsedSeconds(loading ? loadingSeconds : turnSeconds)}</span>
            )}
          </span>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line" />
          <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-ink" title={rateTitle}>
            <Gauge size={13} className={stats.phase === 'streaming' ? 'text-accent' : 'text-ink-3'} />
            {rateText}
            <span className="text-ink-3">tok/s</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-ink" title="Session time">
            <Timer size={13} className="text-ink-3" />
            {formatElapsedMilliseconds(now - sessionStartedAt)}
          </span>
          {silentFor !== null && !stats.firstTokenAt && (
            <span
              className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-ink"
              title={
                silentFor < 20
                  ? 'The source sent a stream frame or status update recently. This confirms the connection is responding, not how far prompt processing or generation has progressed. No answer text has arrived yet.'
                  : 'Nothing from the source recently. It may still be working, or it may be gone.'
              }
            >
              <Waves size={13} className={silentFor < 20 ? 'text-accent' : 'text-danger'} />
              {silentFor < 20 ? 'connected' : `quiet ${formatElapsedSeconds(silentFor)}`}
            </span>
          )}
          {context && (
            <span
              className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-ink"
              title={
                `${context.estimatedTokens.toLocaleString()} of ~${context.budgetTokens.toLocaleString()} prompt tokens used, ` +
                `in a ${context.contextTokens.toLocaleString()}-token window (${SOURCE_NOTE[context.contextSource]}). ` +
                `Replies are capped at ${context.maxOutputTokens.toLocaleString()} tokens. ` +
                `${context.compacted ? `${context.compacted} earlier message(s) were compacted. ` : ''}` +
                `${context.minimumRecentMet ? '' : 'The safe fit kept a shorter recent tail. '}` +
                `${context.overflowTokens ? `The required opening is about ${context.overflowTokens.toLocaleString()} tokens over budget. ` : ''}` +
                toldBefore(context.memory) +
                `Counts are estimated from text length.`
              }
            >
              <Layers size={13} className={context.compacted > 0 ? 'text-primary' : 'text-ink-3'} />
              {thousands(context.estimatedTokens)}
              <span className="text-ink-3">/ {thousands(context.contextTokens)}</span>
              {/* Share of the prompt budget, which is the number compaction actually acts on:
                  the window less the reserved reply and tool definitions. */}
              {context.budgetTokens > 0 && (() => {
                const used = Math.min(999, Math.round((context.estimatedTokens / context.budgetTokens) * 100));
                return <span className={used >= 90 ? 'text-danger' : used >= 75 ? 'text-primary' : 'text-ink-3'}>
                  · {used}%
                </span>;
              })()}
              {context.compacted > 0 && (
                <span className="text-primary">· {context.compacted} compacted</span>
              )}
              {context.overflowTokens > 0 && (
                <span className="text-danger">· {thousands(context.overflowTokens)} over</span>
              )}
            </span>
          )}
          <ThinkingControl source={source} modelId={modelId ?? context?.modelId ?? ''} />
          {thread && <CarbonBadge threadId={thread.id} title={thread.title} />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {thread && <button type="button" onClick={() => setNotesThread({ ...thread })} aria-label="Chat notes" title="Notes for this chat"
            className="rounded-md p-1.5 text-ink-3 transition hover:bg-surface-3 hover:text-ink"><NotebookPen size={15} /></button>}
          {coordination && <button type="button" onClick={coordination.onToggle} aria-pressed={coordination.open} aria-label={`Connected chats${coordination.pending ? `, ${coordination.pending} queued notes` : ''}`} title="Connect chats in the same working folder and review agent notes" className={`inline-flex items-center gap-1 rounded-md p-1.5 transition ${coordination.open ? 'bg-primary/15 text-primary' : 'text-ink-3 hover:bg-surface-3 hover:text-ink'}`}><Link2 size={15} />{coordination.pending > 0 && <span className="rounded bg-primary px-1 text-[10px] font-medium text-on-primary">{coordination.pending > 99 ? '99+' : coordination.pending}</span>}</button>}
          {debug && <button type="button" onClick={debug.onToggle} aria-pressed={debug.open} aria-label="Toggle inference debug overlay" title="Inference timings" className={`rounded-md p-1.5 transition ${debug.open ? 'bg-accent/15 text-accent' : 'text-ink-3 hover:bg-surface-3 hover:text-ink'}`}><Activity size={15} /></button>}
          <ViewModeSwitch value={viewMode} onChange={onChangeViewMode} />
          {panel && (
            <button
              type="button"
              onClick={panel.onToggle}
              disabled={!panel.available}
              aria-pressed={panel.open}
              aria-label={panel.open ? 'Hide outputs, subagents and sources' : 'Show outputs, subagents and sources'}
              title={
                panel.available
                  ? panel.open
                    ? 'Hide outputs, subagents and sources'
                    : 'Show outputs, subagents and sources'
                  : 'Widen the window to show outputs, subagents and sources'
              }
              className={`flex size-7 shrink-0 items-center justify-center rounded-md transition disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${
                panel.open && panel.available ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:bg-surface-3 hover:text-ink'
              }`}
            >
              <PanelRight size={15} />
            </button>
          )}
        </div>
      </div>

      {active && !waiting && !loading && <InferencePromptStatus metrics={inference} active={active} />}

      {slowBundledTurn && (
        <p className="mt-2 text-[11px] text-ink-3">
          Beholdd may still be processing the prompt or reasoning. It validates a complete tool call before
          revealing it; {recentlyAlive ? 'the source is still sending heartbeats.' : 'watch the heartbeat indicator above.'}
        </p>
      )}

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {notesThread && <ChatNotesPanel threadId={notesThread.id} title={notesThread.title} onClose={() => setNotesThread(null)} />}
    </header>
  );
}
