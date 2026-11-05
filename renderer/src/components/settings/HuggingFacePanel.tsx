import { useCallback, useEffect, useState } from 'react';
import { Check, FolderOpen, KeyRound, RotateCw, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import type { HubAccount, HubState } from '../../types';
import { bytes, errorText } from '../hub/presentation';

const button =
  'flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40';

/**
 * The Hugging Face token and the download directory. The token goes to the main process and is
 * never read back: this panel only ever learns whether one is set, and whose account it opens.
 */
export function HuggingFacePanel() {
  const [state, setState] = useState<HubState | null>(null);
  const [account, setAccount] = useState<HubAccount | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const next = await window.electronAPI.hub.state();
    setState(next);
    return next;
  }, []);

  const check = useCallback(async () => {
    setAccount(null);
    try {
      const who = await window.electronAPI.hub.whoami();
      setAccount(who);
      setMessage(null);
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error) });
    }
  }, []);

  useEffect(() => {
    refresh()
      .then((next) => (next.token.configured ? check() : undefined))
      .catch(console.error);
  }, [refresh, check]);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      const next = await refresh();
      if (next.token.configured) await check();
      else setAccount(null);
      if (success) setMessage((current) => current ?? { tone: 'ok', text: success });
    } catch (error) {
      setMessage({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await window.electronAPI.hub.setToken(draft);
      setDraft('');
    }, 'Token saved.');

  const importToken = () =>
    run(async () => {
      const result = await window.electronAPI.hub.importToken();
      if (!result.imported) throw new Error('No Hugging Face token was found to import.');
    }, 'Token imported.');

  const chooseRoot = async () => {
    const directory = await window.electronAPI.workspace.chooseDirectory();
    if (directory) await run(() => window.electronAPI.hub.setRoot(directory));
  };

  const token = state?.token;
  const root = state?.root;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound size={14} className={token?.configured ? 'text-accent' : 'text-ink-3'} />
        <span className="text-sm font-semibold text-ink">Access token</span>
        <span className="text-[11px] text-ink-3">
          {!token
            ? '…'
            : token.configured
              ? account
                ? `${account.name}${account.tokenRole ? ` · ${account.tokenRole}` : ''}${account.tokenName ? ` · "${account.tokenName}"` : ''}`
                : 'saved'
              : 'not set — public models only'}
        </span>
        {token?.configured && (
          <span className="text-[11px] text-ink-3">
            · {token.encrypted ? 'encrypted with the OS keyring' : 'stored in plain text (no OS keyring)'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {token?.configured && (
            <>
              <button type="button" onClick={() => void run(check)} disabled={busy} className={button}>
                <RotateCw size={12} />
                Check
              </button>
              <button
                type="button"
                onClick={() => void run(() => window.electronAPI.hub.setToken(null), 'Token removed.')}
                disabled={busy}
                aria-label="Remove the Hugging Face token"
                className="rounded-md border border-danger/30 px-2 py-1 text-[11px] text-danger transition hover:border-danger/60 hover:bg-danger/10 disabled:opacity-40"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      </div>

      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) void save();
        }}
      >
        <input
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={token?.configured ? 'Paste a new token to replace it' : 'hf_…'}
          aria-label="Hugging Face token"
          autoComplete="off"
          spellCheck={false}
          className="min-w-[220px] flex-1 rounded-md border border-line bg-surface-3 px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none"
        />
        <button type="submit" disabled={busy || !draft.trim()} className={button}>
          <Check size={12} />
          Save
        </button>
        {token?.importable && (
          <button
            type="button"
            onClick={() => void importToken()}
            disabled={busy}
            title={token.importable === 'env' ? 'Copy the token in HF_TOKEN' : `Copy the token from ${token.importPath}`}
            className={button}
          >
            <KeyRound size={12} />
            {token.importable === 'env' ? 'Import HF_TOKEN' : 'Import from hf login'}
          </button>
        )}
      </form>
      <p className="mt-1.5 text-[11px] text-ink-3">
        A read token from huggingface.co/settings/tokens. Gated models also need their terms accepted on the model card with
        the same account.
      </p>

      {message && (
        <p className={`mt-2 flex items-start gap-1.5 text-[11px] ${message.tone === 'ok' ? 'text-accent' : 'text-danger'}`}>
          {message.tone === 'ok' ? <Check size={12} className="mt-0.5 shrink-0" /> : <TriangleAlert size={12} className="mt-0.5 shrink-0" />}
          {message.text}
        </p>
      )}

      <div className="mt-3 border-t border-line-soft pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <FolderOpen size={14} className="text-ink-3" />
          <span className="text-sm font-semibold text-ink">Downloads</span>
          <code className="min-w-0 truncate font-mono text-[11px] text-ink-2" title={root?.path}>
            {root?.path ?? '…'}
          </code>
          {root?.freeBytes != null && <span className="text-[11px] text-ink-3">{bytes(root.freeBytes)} free</span>}
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={() => void chooseRoot()} disabled={busy} className={button}>
              <FolderOpen size={12} />
              Change…
            </button>
            {root && !root.isDefault && (
              <button
                type="button"
                onClick={() => void run(() => window.electronAPI.hub.setRoot(null))}
                disabled={busy}
                title={`Back to ${root.defaultPath}`}
                className={button}
              >
                <Undo2 size={12} />
                Default
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-3">
          {root?.isDefault
            ? 'The Hugging Face cache, shared with the hf command line: a model either one downloads, the other can use. '
            : 'Laid out like the Hugging Face cache. '}
          The bundled beholdd refuses network and spinning-disk storage, so keep models on a local SSD.
        </p>
      </div>
    </div>
  );
}
