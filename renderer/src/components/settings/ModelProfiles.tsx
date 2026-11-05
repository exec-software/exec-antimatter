import { ThinkingLevelField } from './ThinkingLevelField';
import type { ThinkingLevel } from '../../../../src/api/types';
import { useEffect, useState } from 'react';
import { Check, ChevronDown, RotateCcw } from 'lucide-react';
import type { ModelProfile, ProfileSource, ProviderConfig } from '../../types';

/**
 * What each model is allowed to hold, and the chance to disagree.
 *
 * Antimatter resolves a window from the best thing that knows — an override, then the server's
 * own answer, then the model's published figure, then a cautious default — and says which of
 * those it used. That last part is the point: a published window is what the model was trained
 * for, not a promise about the server in front of you, and on a slow local engine you may well
 * want a smaller one than either.
 */

const SOURCE_LABEL: Record<ProfileSource, string> = {
  override: 'yours',
  server: 'from the source',
  known: 'published',
  default: 'default',
};

const SOURCE_HINT: Record<ProfileSource, string> = {
  override: 'You set this.',
  server: 'The source reported this when it was last refreshed — the most reliable number here.',
  known: "The model's published window. This server has not confirmed it will accept that much.",
  default: 'Nothing reported a window and the model was not recognised, so this is a cautious guess.',
};

const thousands = (tokens: number) => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens));

const field =
  'w-24 rounded border border-line bg-surface-3 px-1.5 py-1 text-right font-mono text-[11px] text-ink focus:border-primary/60 focus:outline-none';

function ModelRow({ source, modelId }: { source: ProviderConfig; modelId: string }) {
  const [profile, setProfile] = useState<ModelProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState('');
  const [output, setOutput] = useState('');
  const [toolCalls, setToolCalls] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('default');

  const apply = (next: ModelProfile) => {
    setProfile(next);
    setThinkingLevel(next.thinkingLevel ?? 'default');
    setContext(String(next.contextTokens));
    setOutput(String(next.maxOutputTokens));
    setToolCalls(String(next.maxToolCallsPerMessage));
  };

  const load = () => window.electronAPI.modelWorkloads.resolve(source.id, modelId).then(apply).catch(console.error);

  useEffect(() => {
    void load();
  }, [source.id, modelId]);

  const save = async () =>
    apply(
      await window.electronAPI.modelWorkloads.setDefaultSettings(source.id, modelId, {
        thinkingLevel,
        contextTokens: Number(context) || undefined,
        maxOutputTokens: Number(output) || undefined,
        maxToolCallsPerMessage: Number(toolCalls) || undefined,
      })
    );

  const reset = async () => apply(await window.electronAPI.modelWorkloads.setDefaultSettings(source.id, modelId, null));

  if (!profile) return null;
  const dirty =
    thinkingLevel !== (profile.thinkingLevel ?? 'default') ||
    Number(context) !== profile.contextTokens ||
    Number(output) !== profile.maxOutputTokens ||
    Number(toolCalls) !== profile.maxToolCallsPerMessage;

  return (
    <div className="rounded-md border border-line bg-surface-3/50">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{modelId}</span>
        <span className="shrink-0 font-mono text-[11px] text-ink">{thousands(profile.contextTokens)}</span>
        <span
          title={SOURCE_HINT[profile.contextSource]}
          className={`shrink-0 rounded border px-1 py-0.5 text-[9px] uppercase tracking-wide ${
            profile.contextSource === 'override'
              ? 'border-primary/50 bg-primary/10 text-primary'
              : profile.contextSource === 'server'
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-line text-ink-3'
          }`}
        >
          {SOURCE_LABEL[profile.contextSource]}
        </span>
        <ChevronDown size={12} className={`shrink-0 text-ink-3 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-line px-2 py-2">
          <p className="mb-2 text-[10px] leading-relaxed text-ink-3">{SOURCE_HINT[profile.contextSource]}</p>
          <div className="mb-3"><ThinkingLevelField source={source} modelId={modelId} value={thinkingLevel} onChange={setThinkingLevel} /></div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[10px] uppercase tracking-wide text-ink-3">
              <span className="mb-1 block">Context</span>
              <input className={field} value={context} onChange={(event) => setContext(event.target.value)} inputMode="numeric" />
            </label>
            <label className="text-[10px] uppercase tracking-wide text-ink-3">
              <span className="mb-1 block">Max reply</span>
              <input className={field} value={output} onChange={(event) => setOutput(event.target.value)} inputMode="numeric" />
            </label>
            <label className="text-[10px] uppercase tracking-wide text-ink-3">
              <span className="mb-1 block">Calls per reply</span>
              <input className={field} value={toolCalls} onChange={(event) => setToolCalls(event.target.value)} inputMode="numeric" />
            </label>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink disabled:opacity-40"
            >
              <Check size={11} />
              Save
            </button>
            {profile.contextSource === 'override' && (
              <button
                type="button"
                onClick={() => void reset()}
                className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition hover:border-primary/60 hover:text-ink"
              >
                <RotateCcw size={11} />
                Reset
              </button>
            )}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-ink-3">
            A conversation that outgrows the window is rolled forward automatically: the task and the most recent
            exchanges are kept, and the middle is{' '}
            {profile.compaction === 'summarize' ? 'summarized by the model' : 'dropped with a marker'}. A reply asking
            for more than {profile.maxToolCallsPerMessage} tool calls at once is cut off at that many while it is still
            being written, because one reply and all of its results have to fit the window together.
          </p>
        </div>
      )}
    </div>
  );
}

export function ModelProfiles({ sources }: { sources: ProviderConfig[] }) {
  const withModels = sources.filter((source) => source.models.length > 0);
  if (withModels.length === 0) return null;

  return (
    <div className="grid gap-3">
      {withModels.map((source) => (
        <div key={source.id}>
          <p className="mb-1 text-[11px] text-ink-3">{source.name}</p>
          <div className="grid gap-1">
            {source.models.map((model) => (
              <ModelRow key={model.id} source={source} modelId={model.id} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
