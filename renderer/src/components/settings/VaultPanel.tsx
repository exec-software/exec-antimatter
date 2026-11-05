import { useEffect, useRef, useState } from 'react';
import { Check, EyeOff, KeyRound, Lock, Pencil, Plus, ShieldAlert, Terminal, Trash, Vault, X } from 'lucide-react';
import type { VaultEntryInput, VaultEntrySummary, VaultSecretKind, VaultStatus } from '../../types';

const KINDS: { id: VaultSecretKind; label: string }[] = [
  { id: 'password', label: 'Password' },
  { id: 'token', label: 'API token' },
  { id: 'passphrase', label: 'Passphrase' },
  { id: 'key', label: 'Key' },
];

const field =
  'w-full rounded-md border border-line bg-surface-0 px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
const label = 'mb-1 block text-[11px] font-medium text-ink-2';
const ghost =
  'inline-flex min-h-7 items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-ink-2 transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
const solid =
  'inline-flex min-h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-strong focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

/** Mirrors the main process's rule, so the environment variable shown while typing is the real one. */
const normalizeTag = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const envNameFor = (tag: string): string => `ANTIMATTER_VAULT_${tag.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

const when = (at?: number): string => (at ? new Date(at).toLocaleDateString() : 'never');

interface Draft extends VaultEntryInput {
  /** Set when replacing an existing credential: its tag is the identity and cannot be retyped. */
  editing?: string;
}

const BLANK: Draft = { tag: '', label: '', kind: 'password', username: '', notes: '', secret: '' };

/**
 * The Vault.
 *
 * What this page is for is the sentence it opens with, and the sentence is the feature: a
 * conversation can *use* a credential without being *told* it. Everything on the page follows from
 * that, including the two things it conspicuously cannot do — show you a stored secret, and store
 * one at all without a real system keyring.
 *
 * There is no reveal button, and its absence is deliberate rather than unfinished. A value this
 * page could display is a value it has read across IPC, and a value a renderer can read is one a
 * model's tool result can carry. The only way to change a secret here is to type a new one over
 * it, which costs the user a trip to their password manager and buys the guarantee the whole
 * feature rests on.
 */
export function VaultPanel() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    window.electronAPI.vault
      .status()
      .then((next) => { if (alive.current) setStatus(next); })
      .catch((cause) => {
        console.error('Could not read the Vault:', cause);
        if (alive.current) setError('Could not read the Vault. Nothing has changed.');
      });
    return () => { alive.current = false; };
  }, []);

  const run = (action: () => Promise<VaultStatus>, failure: string) => {
    setBusy(true);
    setError('');
    void action()
      .then((next) => {
        if (!alive.current) return;
        setStatus(next);
        setDraft(null);
        setConfirming(null);
      })
      .catch((cause) => {
        console.error(failure, cause);
        // Main's messages here are written for the person — no keyring, a tag that is not a tag,
        // a secret that is too long — so they are shown rather than replaced with a generic line.
        if (alive.current) setError(cause instanceof Error ? cause.message : failure);
      })
      .finally(() => { if (alive.current) setBusy(false); });
  };

  const submit = () => {
    if (!draft) return;
    const tag = normalizeTag(draft.editing ?? draft.tag);
    run(
      () => window.electronAPI.vault.save({
        tag,
        label: draft.label?.trim() || tag,
        kind: draft.kind ?? 'password',
        username: draft.username?.trim() || undefined,
        notes: draft.notes?.trim() || undefined,
        // Blank while editing means "keep the secret you already hold".
        ...(draft.secret ? { secret: draft.secret } : {}),
      }),
      'Could not save that credential.'
    );
  };

  if (!status) {
    return <p className="text-xs text-ink-3">{error || 'Reading the Vault…'}</p>;
  }

  const entries = status.entries;
  const tag = normalizeTag(draft?.editing ?? draft?.tag ?? '');

  return <div className="space-y-6">
    <section>
      <p className="text-xs leading-5 text-ink-2">
        Keep the credentials you would otherwise type by hand — your <code className="text-[11px]">sudo</code> password,
        a service login — and a conversation can use one when it needs to, with your approval each time.
        Antimatter hands the value straight to the command. It is never written into the chat, the transcript,
        or anything the model can read back.
      </p>
    </section>

    {!status.sealingAvailable && (
      <section role="alert" className="rounded-md border border-danger/50 bg-danger/5 p-3">
        <p className="flex items-start gap-2 text-xs leading-5 text-ink">
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-danger" />
          <span>
            <span className="font-medium">No system keyring on this session.</span> The Vault needs GNOME Keyring or
            KWallet so a secret is sealed by the operating system and never written in plain text. Unlike an API key,
            a machine password is not worth storing any other way, so the Vault stays off until one is available.
          </span>
        </p>
      </section>
    )}

    <section>
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-0.5 shrink-0 accent-[rgb(var(--color-primary))]"
          checked={status.enabled}
          disabled={busy || !status.sealingAvailable}
          onChange={(event) => run(() => window.electronAPI.vault.setEnabled(event.target.checked), 'Could not change that.')}
        />
        <span className="text-xs leading-5 text-ink-2">
          <span className="font-medium text-ink">Let conversations use the Vault</span>
          <span className="mt-0.5 block text-ink-3">
            Adds two tools. One lists what the Vault holds — tags and descriptions, never values. The other asks to
            use one, and always stops for your approval first, in every permission mode. Turning this off revokes
            anything a running turn has already been granted.
          </span>
        </span>
      </label>
    </section>

    <section className="border-t border-line pt-5">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium text-ink">
          Credentials <span className="ml-1 text-xs font-normal text-ink-3">{entries.length}</span>
        </h3>
        <button
          type="button"
          className={ghost}
          disabled={busy || !status.sealingAvailable}
          onClick={() => { setError(''); setDraft(draft && !draft.editing ? null : { ...BLANK }); }}
        >
          {draft && !draft.editing ? <><X size={13} />Cancel</> : <><Plus size={13} />Add credential</>}
        </button>
      </div>

      {entries.length === 0 && !draft && (
        <p className="text-xs leading-5 text-ink-3">
          Nothing stored yet. A good first one is your <code className="text-[11px]">sudo</code> password: it is the
          credential an agent most often stalls on, because a password prompt in a terminal nobody is watching just
          hangs there.
        </p>
      )}

      <ul className="divide-y divide-line">
        {entries.map((entry) => <li key={entry.id} className="py-3">
          {draft?.editing === entry.tag
            ? <VaultForm draft={draft} onChange={setDraft} onSubmit={submit} onCancel={() => setDraft(null)} busy={busy} tag={tag} />
            : <Row
                entry={entry}
                busy={busy}
                confirming={confirming === entry.tag}
                onEdit={() => { setError(''); setDraft({ editing: entry.tag, tag: entry.tag, label: entry.label, kind: entry.kind, username: entry.username ?? '', notes: entry.notes ?? '', secret: '' }); }}
                onAskDelete={() => { setError(''); setConfirming(entry.tag); }}
                onCancelDelete={() => setConfirming(null)}
                onDelete={() => run(() => window.electronAPI.vault.remove(entry.tag), 'Could not delete that credential.')}
              />}
        </li>)}
      </ul>

      {draft && !draft.editing && <div className="mt-4 rounded-md border border-line p-3">
        <VaultForm draft={draft} onChange={setDraft} onSubmit={submit} onCancel={() => setDraft(null)} busy={busy} tag={tag} />
      </div>}
    </section>

    {error && <p role="alert" className="text-xs leading-5 text-danger">{error}</p>}

    <section className="border-t border-line pt-5">
      <h3 className="mb-2 text-sm font-medium text-ink">How a credential reaches a command</h3>
      <ol className="space-y-2 text-xs leading-5 text-ink-3">
        <li className="flex gap-2"><Lock size={13} className="mt-0.5 shrink-0" /><span>The secret is sealed by the system keyring and kept only in Antimatter's main process. It is never sent to the window, to the bundled tool server, or to the model.</span></li>
        <li className="flex gap-2"><Check size={13} className="mt-0.5 shrink-0" /><span>When a conversation asks for one, you see which credential and what it is for, and decide. Nothing is unsealed before you do.</span></li>
        <li className="flex gap-2"><Terminal size={13} className="mt-0.5 shrink-0" /><span>Antimatter sets it as an environment variable on the command's own shell — not on the command line, which any process on this machine could read. The model gets the variable's name.</span></li>
        <li className="flex gap-2"><EyeOff size={13} className="mt-0.5 shrink-0" /><span>Command output is scanned and the value masked out before the model or the transcript sees it, so a command that prints its configuration cannot leak it by accident.</span></li>
      </ol>
      <p className="mt-3 text-[11px] leading-5 text-ink-3">
        One limit worth knowing: a model you have granted a secret runs commands that can read it, so it could
        deliberately encode and print it. Masking stops accidents, not intent — which is why each use is a decision
        you make, with the reason in front of you.
      </p>
      <p className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-ink-3">
        <KeyRound size={13} className="mt-0.5 shrink-0" />
        <span>
          {status.sealingAvailable ? 'Sealed with the OS keyring.' : 'Not storable on this session.'}
          <code className="mt-1 block break-all">{status.path}</code>
        </span>
      </p>
    </section>
  </div>;
}

interface RowProps {
  entry: VaultEntrySummary;
  busy: boolean;
  confirming: boolean;
  onEdit(): void;
  onAskDelete(): void;
  onCancelDelete(): void;
  onDelete(): void;
}

function Row({ entry, busy, confirming, onEdit, onAskDelete, onCancelDelete, onDelete }: RowProps) {
  return <div className="flex min-w-0 flex-wrap items-start gap-3">
    <Vault size={15} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p className="flex flex-wrap items-baseline gap-2 text-[13px] text-ink">
        <code className="font-mono text-xs font-medium">{entry.tag}</code>
        <span className="text-ink-2">{entry.label}</span>
        <span className="text-[11px] text-ink-3">{KINDS.find((kind) => kind.id === entry.kind)?.label ?? entry.kind}</span>
      </p>
      {entry.username && <p className="mt-0.5 text-[11px] text-ink-3">Account {entry.username}</p>}
      {entry.notes && <p className="mt-0.5 text-[11px] leading-4 text-ink-3">{entry.notes}</p>}
      <p className="mt-1 text-[11px] text-ink-3">
        Arrives as <code className="text-[11px]">${entry.envName}</code> · used {entry.useCount}{' '}
        {entry.useCount === 1 ? 'time' : 'times'}, last {when(entry.usedAt)}
      </p>
      {confirming && <p role="alert" className="mt-1.5 text-[11px] leading-4 text-danger">
        Delete {entry.tag}? The sealed secret is removed from this computer and cannot be recovered from Antimatter.
      </p>}
    </div>
    <div className="flex shrink-0 gap-2">
      {confirming ? <>
        <button type="button" className={`${ghost} border-danger/60 text-danger`} disabled={busy} onClick={onDelete}>
          <Trash size={12} />Delete
        </button>
        <button type="button" className={ghost} disabled={busy} onClick={onCancelDelete}><X size={12} />Keep</button>
      </> : <>
        <button type="button" className={ghost} disabled={busy} onClick={onEdit} aria-label={`Edit ${entry.tag}`}>
          <Pencil size={12} />Edit
        </button>
        <button type="button" className={ghost} disabled={busy} onClick={onAskDelete} aria-label={`Delete ${entry.tag}`}>
          <Trash size={12} />Delete
        </button>
      </>}
    </div>
  </div>;
}

interface FormProps {
  draft: Draft;
  tag: string;
  busy: boolean;
  onChange(next: Draft): void;
  onSubmit(): void;
  onCancel(): void;
}

function VaultForm({ draft, tag, busy, onChange, onSubmit, onCancel }: FormProps) {
  const editing = !!draft.editing;
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const ready = !!tag && (editing || !!draft.secret);

  return <form
    className="grid gap-3"
    onSubmit={(event) => { event.preventDefault(); if (ready) onSubmit(); }}
  >
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className={label} htmlFor="vault-tag">Tag</label>
        <input
          id="vault-tag"
          className={field}
          value={draft.editing ?? draft.tag}
          disabled={editing || busy}
          placeholder="sudo"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set({ tag: event.target.value })}
        />
        <p className="mt-1 text-[11px] leading-4 text-ink-3">
          {editing
            ? 'The tag names the credential in a conversation, so it stays fixed. Delete and re-add to rename it.'
            : tag
              ? <>How a conversation names it. Arrives as <code className="text-[11px]">${envNameFor(tag)}</code>.</>
              : 'One word a conversation can name it by — lowercase letters, digits, dash or underscore.'}
        </p>
      </div>
      <div>
        <label className={label} htmlFor="vault-label">What it is for</label>
        <input
          id="vault-label"
          className={field}
          value={draft.label ?? ''}
          disabled={busy}
          placeholder="This computer's sudo password"
          onChange={(event) => set({ label: event.target.value })}
        />
      </div>
      <div>
        <label className={label} htmlFor="vault-kind">Kind</label>
        <select id="vault-kind" className={field} value={draft.kind ?? 'password'} disabled={busy}
          onChange={(event) => set({ kind: event.target.value as VaultSecretKind })}>
          {KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
        </select>
      </div>
      <div>
        <label className={label} htmlFor="vault-username">Account name <span className="font-normal text-ink-3">optional</span></label>
        <input
          id="vault-username"
          className={field}
          value={draft.username ?? ''}
          disabled={busy}
          placeholder="nathan"
          autoComplete="off"
          onChange={(event) => set({ username: event.target.value })}
        />
        <p className="mt-1 text-[11px] leading-4 text-ink-3">Shown to the model: an account name is not a secret, and the commands that need it print it anyway.</p>
      </div>
    </div>
    <div>
      <label className={label} htmlFor="vault-secret">{editing ? 'Replace the secret' : 'Secret'}</label>
      <input
        id="vault-secret"
        className={field}
        type="password"
        value={draft.secret ?? ''}
        disabled={busy}
        placeholder={editing ? 'Leave blank to keep the stored secret' : ''}
        autoComplete="new-password"
        spellCheck={false}
        onChange={(event) => set({ secret: event.target.value })}
      />
      <p className="mt-1 text-[11px] leading-4 text-ink-3">
        Sealed as soon as you save, and never readable again from this page — not even by Antimatter's own window.
        {editing && ' Leave it blank to change only the labels above.'}
      </p>
    </div>
    <div>
      <label className={label} htmlFor="vault-notes">Note for the model <span className="font-normal text-ink-3">optional</span></label>
      <input
        id="vault-notes"
        className={field}
        value={draft.notes ?? ''}
        disabled={busy}
        placeholder="Use for apt and systemctl on this box."
        onChange={(event) => set({ notes: event.target.value })}
      />
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="submit" className={solid} disabled={busy || !ready}>
        <Check size={12} />{editing ? 'Save changes' : 'Add to Vault'}
      </button>
      <button type="button" className={ghost} disabled={busy} onClick={onCancel}><X size={12} />Cancel</button>
    </div>
  </form>;
}
