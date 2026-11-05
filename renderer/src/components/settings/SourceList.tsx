import { useRef, useState } from 'react';
import { Check, ChevronRight, KeyRound, RefreshCw, Server, Trash2, TriangleAlert, X } from 'lucide-react';
import type { ProbeResult, ProviderConfig } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';

interface Props {
  sources: ProviderConfig[];
  onChanged: () => void;
  onManageEngine?: () => void;
}

const KIND_LABEL: Record<string, string> = {
  beholdd: 'beholdd',
  'llama-cpp': 'llama.cpp',
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'opencode-zen': 'OpenCode Zen',
  'openai-compatible': 'Compatible endpoint',
};

const PROTOCOL_LABEL = {
  'openai-chat': 'Chat Completions',
  'openai-responses': 'Responses',
  'anthropic-messages': 'Messages',
} as const;

/** This is a navigation hint, not a claim that Antimatter owns this server. */
export function isLocalBeholddSource(source: ProviderConfig): boolean {
  if (source.kind !== 'beholdd') return false;
  try {
    return new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(new URL(source.baseUrl).hostname);
  } catch {
    return false;
  }
}

/** A stalled IPC response must not leave every source action disabled indefinitely. */
export async function boundedSourceOperation<T>(operation: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          'The source did not respond in time. The operation may still complete; reopen Settings to check before retrying.'
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function sourceActionError(error: unknown, credential = ''): string {
  const message = (error instanceof Error ? error.message : 'The source operation failed.')
    .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  return (credential ? message.split(credential).join('[redacted]') : message).slice(0, 500);
}

const buttonClass =
  'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-ink-2 transition hover:bg-surface-3 hover:text-ink disabled:opacity-40';

type SourceAction = 'test' | 'refresh' | 'credential' | 'remove';

function SourceRow({ source, onChanged, onManageEngine }: {
  source: ProviderConfig;
  onChanged: () => void;
  onManageEngine?: () => void;
}) {
  const [busy, setBusy] = useState<SourceAction | null>(null);
  const pending = useRef(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingCredential, setEditingCredential] = useState(false);
  const [credential, setCredential] = useState('');

  const run = async (action: SourceAction, operation: () => Promise<void>, secret = '') => {
    if (pending.current) return;
    pending.current = true;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (err) {
      setError(sourceActionError(err, secret));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  const probe = (save: boolean) => run(save ? 'refresh' : 'test', async () => {
    setResult(null);
    const next = await boundedSourceOperation(save
      ? window.electronAPI.providers.refresh(source.id)
      : window.electronAPI.providers.test(source.id));
    setResult(next);
    if (save && next.ok) onChanged();
  });

  const remove = () => {
    if (pending.current || !window.confirm(`Remove ${source.name}?`)) return;
    void run('remove', async () => {
      await boundedSourceOperation(window.electronAPI.providers.remove(source.id));
      setCredential('');
      setEditingCredential(false);
      onChanged();
    });
  };

  const replaceCredential = () => {
    const nextCredential = credential.trim();
    if (!nextCredential) return;
    void run('credential', async () => {
      await boundedSourceOperation(window.electronAPI.providers.replaceCredential(source.id, nextCredential));
      setCredential('');
      setEditingCredential(false);
      setResult(null);
      setNotice('Credential replaced; source and model bindings were preserved.');
      onChanged();
    }, nextCredential);
  };

  return (
    <article className="py-3 first:pt-0 last:pb-0" aria-label={`${source.name} source`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Server size={15} className="mt-0.5 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium text-ink">{source.name}</h3>
            <span className="text-[11px] text-ink-3">
              {source.models.length} model{source.models.length === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {KIND_LABEL[source.kind ?? ''] ?? 'OpenAI-compatible'} · {PROTOCOL_LABEL[source.protocol ?? 'openai-chat']}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-3" title={source.baseUrl}>
            {source.baseUrl}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => void probe(false)} disabled={!!busy}
            title="Check the source without changing its saved model list" className={buttonClass}>
            {busy === 'test' ? <AtomIndicator phase="thinking" size={13} /> : <Check size={12} />}
            Test
          </button>
          <button type="button" onClick={() => void probe(true)} disabled={!!busy}
            title="Discover models and update this source's saved model list" className={buttonClass}>
            {busy === 'refresh' ? <AtomIndicator phase="thinking" size={13} /> : <RefreshCw size={12} />}
            Refresh models
          </button>
        </div>
      </div>

      {/* Native details keeps its children mounted, including an unfinished credential draft. */}
      <details className="group mt-2 pl-[27px]">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-[11px] text-ink-3 hover:text-ink [&::-webkit-details-marker]:hidden">
          <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
          Source details
        </summary>
        <div className="mt-3 space-y-3">
          <div>
            <p className="mb-1.5 text-[11px] text-ink-3">Saved models</p>
            {source.models.length ? (
              <ul className="flex max-h-40 flex-wrap gap-1.5 overflow-auto" aria-label={`${source.name} saved models`}>
                {source.models.map((model) => (
                  <li key={model.id} title={model.id.startsWith('/') ? model.id : undefined}
                    className="max-w-full break-all rounded bg-surface-3 px-2 py-1 font-mono text-[11px] text-ink-2">
                    {model.id.startsWith('/') ? model.name : model.id}
                  </li>
                ))}
              </ul>
            ) : <p className="text-[11px] text-ink-3">No models listed. Refresh models once the source is available.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-ink-3">{source.credentialConfigured ? 'API key stored' : 'No API key stored'}</span>
            <button type="button" onClick={() => setEditingCredential(true)} disabled={!!busy || editingCredential}
              title={source.credentialConfigured ? 'Replace the stored API key' : 'Add an API key'} className={buttonClass}>
              <KeyRound size={12} /> {source.credentialConfigured ? 'Rotate key' : 'Add key'}
            </button>
            {onManageEngine && isLocalBeholddSource(source) && (
              <button type="button" onClick={onManageEngine} className={buttonClass}
                title="Open local engine settings; only an app-managed engine can be started or stopped there">
                <Server size={12} /> Local engine settings
              </button>
            )}
            <button type="button" onClick={remove} disabled={!!busy}
              title={`Remove ${source.name}`} aria-label={`Remove ${source.name}`}
              className={`${buttonClass} text-danger hover:bg-danger/10 hover:text-danger`}>
              {busy === 'remove' ? <AtomIndicator phase="thinking" size={13} /> : <Trash2 size={12} />}
              Remove source
            </button>
          </div>
          {editingCredential && (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
              event.preventDefault();
              replaceCredential();
            }}>
              <label className="min-w-48 flex-1 text-[11px] text-ink-3">
                New API key
                <input type="password" value={credential} onChange={(event) => setCredential(event.target.value)}
                  autoComplete="new-password" autoFocus disabled={!!busy} spellCheck={false}
                  className="mt-1 w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-xs text-ink focus:border-primary/60 focus:outline-none" />
              </label>
              <button type="submit" disabled={!!busy || !credential.trim()} className={buttonClass}>
                {busy === 'credential' ? <AtomIndicator phase="thinking" size={13} /> : <KeyRound size={12} />} Save key
              </button>
              <button type="button" disabled={!!busy} onClick={() => {
                setCredential('');
                setEditingCredential(false);
              }} className={`${buttonClass} px-1.5`} aria-label="Cancel credential change">
                <X size={12} />
              </button>
              <p className="basis-full text-[10px] text-ink-3">
                The new key is sent once to the main process and is never returned to this view.
              </p>
            </form>
          )}
        </div>
      </details>

      {error && <p role="alert" className="mt-2 flex items-start gap-1.5 pl-[27px] text-[11px] text-danger">
        <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {error}
      </p>}
      {notice && <p role="status" className="mt-2 pl-[27px] text-[11px] text-accent">{notice}</p>}
      {result && <p role="status" className={`mt-2 flex items-start gap-1.5 pl-[27px] text-[11px] ${result.ok ? 'text-accent' : 'text-danger'}`}>
        {result.ok ? <Check size={12} className="mt-0.5 shrink-0" /> : <TriangleAlert size={12} className="mt-0.5 shrink-0" />}
        {result.ok
          ? `Last check: answered in ${result.latencyMs} ms · ${result.models.length} model${result.models.length === 1 ? '' : 's'}`
          : `Last check failed: ${result.error || 'Source unavailable.'}`}
      </p>}
    </article>
  );
}

export function SourceList({ sources, onChanged, onManageEngine }: Props) {
  if (!sources.length) return <p className="py-4 text-xs text-ink-3">
    No sources yet. Add OpenAI, Anthropic, OpenCode Zen, beholdd, or another compatible endpoint.
  </p>;
  return <div className="divide-y divide-line">
    {sources.map((source) => <SourceRow key={source.id} source={source} onChanged={onChanged} onManageEngine={onManageEngine} />)}
  </div>;
}
