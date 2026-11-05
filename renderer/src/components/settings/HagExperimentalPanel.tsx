import { FlaskConical, RefreshCw } from 'lucide-react';
import { HAG_PREVIEW_MAX_EVALUATED_TOKENS, HAG_PREVIEW_MAX_OUTPUT_TOKENS, type HagExperimentalState } from '../../../../src/api/hag';
import { useHagExperimental, type HagExperimentalController } from '../../lib/useHagExperimental';

const button = 'rounded-md border border-line px-3 py-2 text-xs text-ink-2 transition hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50';
const primary = `${button} border-primary/40 bg-primary/10 text-primary hover:bg-primary/20`;

export function hagEnableLabel(state: HagExperimentalState): string {
  return state.modelDownloadBytes && state.modelDownloadBytes > 0 ? 'Download & enable HAG' : 'Enable experimental HAG';
}

export function hagStatusLabel(state: HagExperimentalState): string {
  switch (state.status) {
    case 'disabled': return 'Off';
    case 'downloading': return 'Downloading Qwen3-0.6B…';
    case 'stopped': return 'Enabled · starts with your first message';
    case 'starting': return 'Starting HAG…';
    case 'ready': return 'Ready';
    case 'error': return 'Needs attention';
  }
}

/** Shared disclosure keeps the first-update offer and the later opt-in identical. */
export function HagExperimentalDetails({ state }: { state: HagExperimentalState }) {
  const cap = Math.min(state.model.maxEvaluatedTokens, HAG_PREVIEW_MAX_EVALUATED_TOKENS);
  return <div className="space-y-2 text-xs leading-5 text-ink-2">
    <p>Try HAG, the native GPU runtime in Beholdd, with a separate <strong className="font-medium text-ink">{state.model.name}</strong> source. Your current model and existing conversations keep their selections.</p>
    <p>This experiment supports Qwen3-0.6B only. OpenMythos and your other models continue using their existing engines.</p>
    <p>Prompt, history and reply together are limited to {cap.toLocaleString('en-US')} evaluated tokens in this text preview; replies are limited to {HAG_PREVIEW_MAX_OUTPUT_TOKENS} tokens. Tools, file attachments, workspace context and saved memories are excluded.</p>
    <p>Full editor conversations and tool use are still being qualified. History that is too long or contains tool calls is refused instead of being discarded. Start a new chat for a short text exchange.</p>
    {!!state.modelDownloadBytes && state.modelDownloadBytes > 0 && <p>Enabling downloads a verified Qwen3-0.6B checkpoint ({(state.modelDownloadBytes / 1_000_000).toFixed(0)} MB). Inference runs on this computer.</p>}
    <p className="text-ink-3">Turning HAG off stops its server and restores your previous default model when it is still available. Choose another model to continue an existing HAG chat. The verified checkpoint stays on disk for later use.</p>
  </div>;
}

export function HagExperimentalControls({ controller, welcome = false, onEnabled }: {
  controller: HagExperimentalController;
  welcome?: boolean;
  onEnabled?(): void;
}) {
  const { state, action, error, loading, available, perform, reload } = controller;
  if (!state) return <div>
    <p role="status" className="text-xs leading-5 text-ink-3">{!available ? 'HAG controls are unavailable in this window. Reopen Antimatter to use this preview.' : loading ? 'Reading HAG availability…' : 'HAG status is unavailable.'}</p>
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    {available && !loading && <button type="button" className={`${button} mt-3`} onClick={() => void reload()}>Retry</button>}
  </div>;
  const busy = action !== null || state.status === 'downloading' || state.status === 'starting';
  const issue = error || state.error;
  const progress = state.downloadProgress;
  const received = progress ? Math.min(Math.max(0, progress.receivedBytes), progress.totalBytes) : 0;
  return <>
    <HagExperimentalDetails state={state} />
    <p role="status" aria-live="polite" className="mt-3 text-xs font-medium text-ink">{action === 'disable' ? 'Turning HAG off…' : action === 'dismissWelcome' ? 'Saving your choice…' : hagStatusLabel(state)}</p>
    {state.status === 'downloading' && progress && progress.totalBytes > 0 && <div className="mt-2">
      <progress aria-label="Qwen3-0.6B download" value={received} max={progress.totalBytes} className="h-1.5 w-full accent-primary" />
      <p className="mt-1 text-[11px] text-ink-3">{Math.floor(received / 1_000_000)} of {Math.ceil(progress.totalBytes / 1_000_000)} MB</p>
    </div>}
    {!state.available && state.unavailableReason && <p className="mt-2 text-xs leading-5 text-ink-3">{state.unavailableReason}</p>}
    {issue && <p role="alert" className="mt-3 text-xs leading-5 text-danger">{issue}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      {!state.enabled && <button type="button" className={primary} disabled={!available || !state.available || busy || loading}
        onClick={() => { void perform('enable').then((enabled) => { if (enabled) onEnabled?.(); }); }}>{action === 'enable' ? 'Enabling HAG…' : hagEnableLabel(state)}</button>}
      {state.enabled && <button type="button" className={button} disabled={busy || loading} onClick={() => void perform('disable')}>Turn off HAG</button>}
      {welcome && <button type="button" className={button} disabled={busy} onClick={() => void perform('dismissWelcome')}>Keep current setup</button>}
      {!welcome && <button type="button" className={`${button} inline-flex items-center gap-1.5`} disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={12} />Refresh status</button>}
    </div>
    {state.enabled && !issue && <p className="mt-3 text-xs leading-5 text-ink-3">Select the HAG source in the model picker when you want to try it. Its model loads when you send your first message. Turning it off stops the experimental server.</p>}
  </>;
}

export function HagExperimentalPanel({ active = true, onChanged }: { active?: boolean; onChanged?(): void }) {
  const controller = useHagExperimental(window.electronAPI.hag, active);
  return <section aria-label="Experimental HAG runtime" className="rounded-xl border border-line bg-surface-2 p-4">
    <div className="mb-3 flex flex-wrap items-center gap-2"><FlaskConical size={16} className="text-primary" /><h3 className="text-sm font-medium text-ink">HAG runtime</h3><span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">Experimental · off by default</span></div>
    <HagExperimentalControls controller={controller} onEnabled={onChanged} />
  </section>;
}
