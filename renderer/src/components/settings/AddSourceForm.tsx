import { useRef, useState } from 'react';
import { Check, Plus, ServerCog, TriangleAlert } from 'lucide-react';
import type { ProbeResult, ProviderInput, SourceKind, WireProtocol } from '../../types';
import { AtomIndicator } from '../status/AtomIndicator';

interface Props {
  onAdded: () => void;
  prefill?: { kind: SourceKind; baseUrl: string } | null;
}

interface KindPreset {
  id: SourceKind;
  label: string;
  blurb: string;
  baseUrl: string;
  needsKey: boolean;
  protocol: WireProtocol;
  keyPlaceholder: string;
}

const KINDS: KindPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'Native Responses API · default cloud connector',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    protocol: 'openai-responses',
    keyPlaceholder: 'sk-…',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    blurb: 'Native Claude Messages API',
    baseUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    protocol: 'anthropic-messages',
    keyPlaceholder: 'sk-ant-…',
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen (Responses)',
    blurb: 'OpenAI-family Responses models through Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    needsKey: true,
    protocol: 'openai-responses',
    keyPlaceholder: 'OpenCode Zen key',
  },
  {
    id: 'beholdd',
    label: 'beholdd',
    blurb: 'Antimatter’s local engine',
    baseUrl: 'http://127.0.0.1:6768/v1',
    needsKey: false,
    protocol: 'openai-chat',
    keyPlaceholder: 'usually blank',
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp',
    blurb: 'llama-server, usually port 8080',
    baseUrl: 'http://127.0.0.1:8080/v1',
    needsKey: false,
    protocol: 'openai-chat',
    keyPlaceholder: 'usually blank',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    blurb: "Ollama's OpenAI layer, port 11434",
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    protocol: 'openai-chat',
    keyPlaceholder: 'usually blank',
  },
  {
    id: 'openai-compatible',
    label: 'Compatible endpoint',
    blurb: 'OpenAI Chat Completions gateway',
    baseUrl: 'https://api.example.com/v1',
    needsKey: true,
    protocol: 'openai-chat',
    keyPlaceholder: 'API key',
  },
];

const inputClass =
  'w-full rounded-md border border-line bg-surface-3 px-2.5 py-2 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none';

const errorMessage = (cause: unknown) =>
  (cause as Error).message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

export function AddSourceForm({ onAdded, prefill }: Props) {
  const initial = KINDS.find((candidate) => candidate.id === prefill?.kind) ?? KINDS[0];
  const [kind, setKind] = useState<KindPreset>(initial);
  const [name, setName] = useState(initial.label);
  const [baseUrl, setBaseUrl] = useState(prefill?.baseUrl ?? initial.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const probeSequence = useRef(0);

  const invalidateProbe = () => {
    probeSequence.current += 1;
    setProbing(false);
    setResult(null);
  };

  const selectKind = (preset: KindPreset) => {
    setKind(preset);
    setName(preset.label);
    setBaseUrl(preset.baseUrl);
    invalidateProbe();
  };

  const test = async () => {
    const sequence = ++probeSequence.current;
    const preset = kind;
    const target = baseUrl.trim();
    const credential = apiKey.trim() || undefined;
    setProbing(true);
    setResult(null);
    try {
      const probed = await window.electronAPI.providers.probe({
        baseUrl: target,
        apiKey: credential,
        protocol: preset.protocol,
      });
      if (sequence !== probeSequence.current) return;
      // Zen's catalog spans several native wire protocols. A source-scoped Responses connection
      // must not make Claude/other non-Responses entries selectable. Verify the credential here,
      // then let the person declare the exact compatible model in the central Library.
      setResult(preset.id === 'opencode-zen' && probed.ok ? { ...probed, models: [] } : probed);
    } catch (cause) {
      if (sequence === probeSequence.current) {
        setResult({ ok: false, latencyMs: 0, models: [], error: errorMessage(cause) });
      }
    } finally {
      if (sequence === probeSequence.current) setProbing(false);
    }
  };

  const add = async () => {
    if (!result?.ok) return;
    setSaving(true);
    try {
      const config: ProviderInput = {
        id: crypto.randomUUID(),
        name: name.trim() || kind.label,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        models: result.models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
          ...(model.maxEvaluatedTokens !== undefined ? { maxEvaluatedTokens: model.maxEvaluatedTokens } : {}),
          ...(model.vision !== undefined ? { vision: model.vision } : {}),
        })),
        supportsStreaming: true,
        kind: kind.id,
        protocol: kind.protocol,
        createdAt: Date.now(),
      };
      await window.electronAPI.providers.add(config);
      setApiKey('');
      setResult(null);
      onAdded();
    } catch (cause) {
      setResult({ ok: false, latencyMs: 0, models: [], error: errorMessage(cause) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Plus size={15} className="text-primary" />
        Add a source
      </h3>
      <p className="mt-1 text-xs text-ink-3">
        Connect a native cloud API or a compatible local server. Keys are handed to the main process once and never returned to the UI.
      </p>

      <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {KINDS.map((preset) => {
          const active = preset.id === kind.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => selectKind(preset)}
              aria-pressed={active}
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition ${
                active ? 'border-primary/60 bg-primary/10' : 'border-line hover:border-line hover:bg-surface-3'
              }`}
            >
              <ServerCog size={14} className={`mt-0.5 shrink-0 ${active ? 'text-primary' : 'text-ink-3'}`} />
              <span className="min-w-0">
                <span className={`block text-xs font-medium ${active ? 'text-ink' : 'text-ink-2'}`}>{preset.label}</span>
                <span className="block truncate text-[11px] text-ink-3">{preset.blurb}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] uppercase tracking-wide text-ink-3">
          Name
          <input className={`mt-1 ${inputClass}`} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="text-[11px] uppercase tracking-wide text-ink-3">
          Base URL
          <input
            className={`mt-1 ${inputClass}`}
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              invalidateProbe();
            }}
            placeholder="http://127.0.0.1:6768/v1"
          />
        </label>
      </div>

      <label className="mt-2 block text-[11px] uppercase tracking-wide text-ink-3">
        API key {kind.needsKey ? '' : '(optional for local servers)'}
        <input
          type="password"
          className={`mt-1 ${inputClass}`}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            invalidateProbe();
          }}
          placeholder={kind.keyPlaceholder}
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={test}
          disabled={probing || !baseUrl.trim()}
          className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40"
        >
          {probing ? <AtomIndicator phase="thinking" size={14} /> : <ServerCog size={13} />}
          {probing ? 'Connecting…' : 'Test connection'}
        </button>

        <button
          type="button"
          onClick={add}
          disabled={!result?.ok || saving}
          className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-3"
        >
          <Plus size={13} strokeWidth={2.5} />
          Add source
        </button>

        {result && (
          <span className={`flex items-center gap-1.5 text-[11px] ${result.ok ? 'text-accent' : 'text-danger'}`}>
            {result.ok ? <Check size={13} /> : <TriangleAlert size={13} />}
            {result.ok
              ? kind.id === 'opencode-zen'
                ? `Connection verified · ${result.latencyMs} ms`
                : `${result.models.length} model${result.models.length === 1 ? '' : 's'} · ${result.latencyMs} ms`
              : result.error}
          </span>
        )}
      </div>

      {result?.ok && result.models.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {result.models.map((model) => (
            <span
              key={model.id}
              className="rounded-md border border-line bg-surface-3 px-2 py-1 font-mono text-[11px] text-ink-2"
              title={model.loaded === undefined ? undefined : model.loaded ? 'resident' : 'not loaded yet'}
            >
              {model.id}
              {model.loaded && <span className="ml-1.5 text-accent">●</span>}
            </span>
          ))}
        </div>
      )}

      {result?.ok && result.models.length === 0 && (
        <p className="mt-2 text-[11px] text-ink-3">
          {kind.id === 'opencode-zen'
            ? 'Zen lists models that use different wire protocols. Add this Responses connection, then declare the exact OpenAI-family model in Models → Library.'
            : 'The source answered but lists no models. Add it anyway, then declare the exact model in Models → Library.'}
        </p>
      )}
    </div>
  );
}
