import { useId, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleSlash, ShieldAlert, TriangleAlert, X } from 'lucide-react';
import { toolActivitySummary } from '../../lib/transcript';
import type { ToolActivity } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';
import { useConversationUi } from './conversationUi';
import { InlineImage } from './InlineImage';
import { useToolApproval } from './toolApproval';

interface Props {
  activity: ToolActivity;
  /** True only while the owning assistant turn still has a live main-process run. */
  isActive: boolean;
}

const TIER_LABEL: Record<ToolActivity['tier'], string> = {
  read: 'read-only access',
  write: 'permission to change files',
  danger: 'permission to run commands',
};

/** A note is not a file in the project, so asking to save one should not say it is. */
const needs = (activity: ToolActivity): string =>
  activity.serverId === 'antimatter.memory' && activity.tier === 'write'
    ? 'permission to change what later conversations are told'
    : TIER_LABEL[activity.tier];

const STATUS_LABEL: Record<ToolActivity['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  denied: 'Declined',
};

const compactPreview = (result?: string): string => {
  const singleLine = result?.replace(/\s+/g, ' ').trim() ?? '';
  return singleLine.length > 180 ? `${singleLine.slice(0, 179)}\u2026` : singleLine;
};

export function ToolActivityCard({ activity, isActive }: Props) {
  const { openPreview } = useConversationUi();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const approval = useToolApproval(activity, isActive, () =>
    requestAnimationFrame(() => toggleRef.current?.focus())
  );
  const disclosureId = useId();
  const detailsId = `${disclosureId}-details`;
  const labelId = `${disclosureId}-label`;
  const { answering, error: approvalError, expired: approvalExpired, interrupted, waiting, submitted } = approval;
  const approvalChoice = approval.choice;
  const summary = toolActivitySummary(activity);
  const status = (() => {
    if (approvalExpired) return 'Approval expired';
    if (interrupted) return 'Interrupted';
    if (submitted) return approvalChoice === 'approved' ? 'Allowed' : 'Declined';
    if (waiting) return answering ? 'Submitting…' : 'Approval needed';
    return STATUS_LABEL[activity.status];
  })();
  const failure = (() => {
    if (approvalError) return approvalError;
    if (approvalExpired) return 'This approval is no longer active.';
    if (interrupted) return compactPreview(activity.result) || 'Interrupted before this action finished.';
    return activity.status === 'failed' ? compactPreview(activity.result) : '';
  })();

  const statusIcon = () => {
    if (waiting) return <ShieldAlert size={14} className="shrink-0 text-primary" />;
    if (submitted) {
      return approvalChoice === 'approved' ? (
        <Check size={14} className="shrink-0 text-ink-2" />
      ) : (
        <CircleSlash size={14} className="shrink-0 text-ink-3" />
      );
    }
    if (approvalExpired || interrupted) return <TriangleAlert size={14} className="shrink-0 text-danger" />;
    if (activity.status === 'running' || activity.status === 'pending') {
      return <AtomIndicator phase="thinking" size={15} />;
    }
    if (activity.status === 'done') return <Check size={14} className="shrink-0 text-ink-3" />;
    if (activity.status === 'denied') return <CircleSlash size={14} className="shrink-0 text-ink-3" />;
    return <TriangleAlert size={14} className="shrink-0 text-danger" />;
  };

  const statusTone = waiting
    ? 'text-primary'
    : approvalExpired || interrupted || activity.status === 'failed'
      ? 'text-danger'
      : 'text-ink-3';
  const showStatus = status !== 'Done';

  return (
    <div className="min-w-0 py-1">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
          {statusIcon()}
        </span>
        <button
          ref={toggleRef}
          id={`${disclosureId}-toggle`}
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={`${open ? 'Hide' : 'Show'} details for ${summary}. Status: ${status}`}
          title={`${summary}\n${activity.serverName} · ${activity.toolName} · ${needs(activity)}`}
          className="-ml-1 flex min-h-7 min-w-0 flex-1 items-start gap-2 rounded px-1 py-1 text-left transition hover:bg-surface-3/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
        >
          <span id={labelId} className="min-w-0 flex-1 break-words text-[13px] leading-5 text-ink-2">
            {summary}
          </span>
          {open ? (
            <ChevronDown size={13} aria-hidden="true" className="shrink-0 text-ink-3" />
          ) : (
            <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-ink-3" />
          )}
        </button>
        {showStatus && (
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`shrink-0 pt-1.5 text-[11px] font-medium ${statusTone}`}
          >
            {status}
          </span>
        )}
      </div>

      {/*
        What the call showed, shown. An image is drawn here; a page has nothing to draw in a
        transcript, so it gets a line that opens it in the pane.
      */}
      {activity.status === 'done' && activity.preview?.kind === 'image' && (
        <InlineImage
          path={activity.preview.target}
          title={activity.preview.title}
          workspace={activity.preview.workspace}
        />
      )}
      {activity.status === 'done' && activity.preview?.kind === 'page' && (
        <button
          type="button"
          onClick={() => openPreview(activity.preview!)}
          className="ml-6 mt-1 block max-w-full truncate rounded px-1 py-0.5 text-left text-[12px] text-accent transition hover:bg-surface-3/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          {activity.preview.title}
        </button>
      )}

      {failure && (!open || approvalError) && (
        <p
          role={approvalError ? 'alert' : undefined}
          className="ml-6 line-clamp-2 pr-2 text-[11px] leading-4 text-danger/90"
          title={failure}
        >
          {failure}
        </p>
      )}

      {waiting && (
        <div
          role="group"
          aria-label={`Approval for ${summary}`}
          className="ml-6 mt-1.5 rounded-md border border-primary/50 bg-primary/5 p-2"
        >
          <p className="text-xs leading-relaxed text-ink-2">
            Allow <span className="font-medium text-ink">{summary}</span> on {activity.serverName}? This tool needs{' '}
            {needs(activity)}.
          </p>
          {activity.caution && (
            <p className="mt-1 text-xs leading-relaxed text-ink">
              It reaches past this project — {activity.caution} — so it is asked about whatever the permissions.
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void approval.answer(true)}
              disabled={answering}
              className="flex min-h-7 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary transition hover:bg-primary-strong disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-strong focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <Check size={12} aria-hidden="true" />
              {answering ? 'Submitting…' : 'Allow'}
            </button>
            <button
              type="button"
              onClick={() => void approval.answer(false)}
              disabled={answering}
              className="flex min-h-7 items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-ink-2 transition hover:border-danger/60 hover:text-ink disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <X size={12} aria-hidden="true" />
              Decline
            </button>
          </div>
        </div>
      )}

      {open && (
        <div
          id={detailsId}
          role="region"
          aria-labelledby={labelId}
          className="ml-6 mt-1.5 grid gap-2 border-l border-line pl-3"
        >
          <div className="min-w-0">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Arguments</p>
            <pre
              tabIndex={0}
              aria-label={`Arguments for ${summary}`}
              className="max-h-40 overflow-auto rounded-md bg-surface-0 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              {activity.args || '{}'}
            </pre>
          </div>
          {activity.result && (
            <div className="min-w-0">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Result</p>
              <pre
                tabIndex={0}
                aria-label={`Result from ${summary}`}
                className="max-h-56 overflow-auto rounded-md bg-surface-0 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
              >
                {activity.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
