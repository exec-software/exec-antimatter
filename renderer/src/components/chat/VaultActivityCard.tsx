import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleSlash, EyeOff, TriangleAlert, Vault, X } from 'lucide-react';
import type { ToolActivity } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';
import { useToolApproval } from './toolApproval';

/** The one app-owned server that serves credentials; a familiar name elsewhere is not the Vault. */
export const VAULT_SERVER_ID = 'antimatter.vault';

/** Which calls get this card. Shared so the transcript and the Flow view cannot disagree. */
export const isVaultActivity = (activity: ToolActivity): boolean =>
  activity.serverId === VAULT_SERVER_ID;

interface Props {
  activity: ToolActivity;
  /** True only while the owning assistant turn still has a live main-process run. */
  isActive: boolean;
}

const parse = (args: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(args || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Mirrors src/main/vault/store.ts. Derived from the tag rather than read out of the result text,
 * so rewording the model's instructions cannot change what the person is shown.
 */
const envNameFor = (tag: string): string => `ANTIMATTER_VAULT_${tag.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * The Vault's own card in the transcript.
 *
 * Deliberately not a tool row. Every other call in a transcript is a thing the conversation did
 * to the project; this one is a thing it asked to do *as the user*, with a credential of theirs,
 * and the one question that matters — which credential, and what for — must be answerable without
 * expanding anything. So it gets a frame, the vault mark, the stated purpose in full, and a
 * standing reminder of the guarantee: the value is not in this card, was not sent to the model,
 * and is not in the transcript on disk.
 *
 * The absence of a "show value" control is the feature. There is nothing to reveal here, because
 * the renderer was never given it.
 */
export function VaultActivityCard({ activity, isActive }: Props) {
  const [open, setOpen] = useState(false);
  const approval = useToolApproval(activity, isActive);
  const args = parse(activity.args);
  const listing = activity.toolName === 'vault_list';
  const tag = str(args.tag);
  const purpose = str(args.purpose);

  const state = (() => {
    if (approval.expired) return { label: 'Approval expired', tone: 'text-danger' as const };
    if (approval.interrupted) return { label: 'Interrupted', tone: 'text-danger' as const };
    if (approval.submitted) return approval.choice === 'approved'
      ? { label: 'You allowed it', tone: 'text-ink-2' as const }
      : { label: 'You declined', tone: 'text-ink-3' as const };
    if (approval.waiting) return { label: approval.answering ? 'Submitting…' : 'Your approval needed', tone: 'text-primary' as const };
    if (activity.status === 'denied') return { label: 'Declined', tone: 'text-ink-3' as const };
    if (activity.status === 'failed') return { label: 'Failed', tone: 'text-danger' as const };
    if (activity.status === 'done') return { label: listing ? 'Listed' : 'Credential used', tone: 'text-ink-3' as const };
    return { label: 'Working…', tone: 'text-ink-3' as const };
  })();

  const icon = () => {
    if (approval.waiting) return <Vault size={15} className="shrink-0 text-primary" />;
    if (approval.expired || approval.interrupted || activity.status === 'failed') return <TriangleAlert size={14} className="shrink-0 text-danger" />;
    if (approval.choice === 'declined' || activity.status === 'denied') return <CircleSlash size={14} className="shrink-0 text-ink-3" />;
    if (activity.status === 'pending' || activity.status === 'running') return <AtomIndicator phase="thinking" size={15} />;
    if (activity.status === 'done') return <Check size={14} className="shrink-0 text-ink-3" />;
    return <Vault size={15} className="shrink-0 text-ink-3" />;
  };

  const failure = approval.error
    || (approval.expired ? 'This approval is no longer active. Nothing was unsealed.' : '')
    || (approval.interrupted ? 'The turn ended before this finished. Nothing was unsealed.' : '')
    || (activity.status === 'failed' ? activity.result?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? '' : '');

  return (
    <div className={`my-1.5 min-w-0 rounded-md border px-3 py-2.5 ${approval.waiting ? 'border-primary/50 bg-primary/5' : 'border-line bg-surface-2/40'}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">{icon()}</span>
        <p className="min-w-0 flex-1 text-[13px] leading-5 text-ink">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Vault</span>{' '}
          {listing ? <span className="text-ink-2">Looked at which credentials you keep</span>
            : <>Asked to use <code className="font-mono text-xs font-medium">{tag || 'a credential'}</code></>}
        </p>
        <span role="status" aria-live="polite" className={`shrink-0 text-[11px] font-medium ${state.tone}`}>{state.label}</span>
      </div>

      {!listing && purpose && (
        <p className="mt-1.5 text-xs leading-5 text-ink-2">
          <span className="text-ink-3">For: </span>{purpose}
        </p>
      )}

      {/*
        Said on every vault card, answered or not. It is the promise the feature makes, and the
        moment someone wants it restated is exactly the moment they are deciding.
      */}
      <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-4 text-ink-3">
        <EyeOff size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          {listing
            ? 'Tags and descriptions only. No secret was read or sent.'
            : 'The value goes straight to the command as an environment variable. It is not shown here, not sent to the model, and not written to the transcript.'}
        </span>
      </p>

      {/* What was actually handed over, in the person's terms: the variable, not the value. */}
      {!listing && tag && activity.status === 'done' && !failure && (
        <p className="mt-1 text-[11px] leading-4 text-ink-3">
          Handed to the command as <code className="text-[11px]">${envNameFor(tag)}</code>
        </p>
      )}

      {failure && <p role={approval.error ? 'alert' : undefined} className="mt-1.5 text-[11px] leading-4 text-danger/90">{failure}</p>}

      {approval.waiting && (
        <div role="group" aria-label={`Approval to use the ${tag || 'Vault'} credential`} className="mt-2.5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void approval.answer(true)}
            disabled={approval.answering}
            className="flex min-h-7 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary transition hover:bg-primary-strong disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-strong focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <Check size={12} aria-hidden="true" />
            {approval.answering ? 'Submitting…' : `Use ${tag || 'it'} once`}
          </button>
          <button
            type="button"
            onClick={() => void approval.answer(false)}
            disabled={approval.answering}
            className="flex min-h-7 items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-ink-2 transition hover:border-danger/60 hover:text-ink disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <X size={12} aria-hidden="true" />
            Decline
          </button>
        </div>
      )}

      {activity.result && !approval.waiting && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setOpen((previous) => !previous)}
            aria-expanded={open}
            className="-ml-1 flex min-h-6 items-center gap-1 rounded px-1 text-[11px] text-ink-3 transition hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            What the model was told
          </button>
          {open && (
            <pre
              tabIndex={0}
              className="mt-1 max-h-40 overflow-auto rounded-md bg-surface-0 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            >
              {activity.result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
