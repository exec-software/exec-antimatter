import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, FolderPlus, LoaderCircle, Plug, RefreshCw, ShieldAlert, X } from 'lucide-react';
import type { ExtensionCatalog, PluginInfo, SkillDocument, SkillInfo } from '../../../../src/main/extensions/types';

interface Props {
  workspace: string | null;
  onClose(): void;
  onUseSkill(name: string): void;
  initialTab?: 'skills' | 'plugins';
}

const button = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-2 transition hover:bg-surface-3 hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70';
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

export function PluginPermissionSummary({ plugin }: { plugin: PluginInfo }) {
  return <div className="space-y-3 text-xs leading-5">
    <p className="text-ink-2">Enabling this local plugin makes its skills available to models{plugin.servers.length ? ' and starts the commands below as MCP servers' : ''}. Only enable plugins whose code and instructions you trust.</p>
    {plugin.servers.length > 0 && <>
      <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-ink-2">These processes run with your operating-system account’s permissions and can access files and the network. Tool approval controls model calls, not what a server can do when it starts. Plugin processes are not sandboxed.</p>
      <ul className="space-y-2">{plugin.servers.map((server) => <li key={server.id} className="rounded-md border border-line bg-surface-0 p-3">
        <p className="font-medium text-ink">{server.name}</p>
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-ink-2">{[server.command, ...server.args].map((arg) => JSON.stringify(arg)).join(' ')}</pre>
        <p className="mt-1 text-ink-3">Environment variables: {server.envNames.join(', ') || 'none declared'} (values hidden)</p>
      </li>)}</ul>
    </>}
    <p className="text-ink-3">Skills are read progressively. Scripts and hooks are never automatically executed when a plugin is imported or a skill is read. Changes to the plugin manifest or MCP configuration require a new review.</p>
    {plugin.warnings.map((warning) => <p key={warning} className="text-ink-3">{warning}</p>)}
  </div>;
}

export function ExtensionsPage({ workspace, onClose, onUseSkill, initialTab = 'skills' }: Props) {
  const [tab, setTab] = useState(initialTab);
  const [catalog, setCatalog] = useState<ExtensionCatalog | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<PluginInfo | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [document, setDocument] = useState<SkillDocument | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const generation = useRef(0);
  const readGeneration = useRef(0);

  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => {
    const current = ++generation.current;
    readGeneration.current += 1;
    setCatalog(null);
    setDocument(null); setReading(null); setReview(null); setAcknowledged(false);
    setLoading(true); setError('');
    window.electronAPI.extensions.catalog(workspace).then((next) => {
      if (current === generation.current) setCatalog(next);
    }).catch((cause) => {
      if (current === generation.current) setError(reason(cause));
    }).finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current += 1; readGeneration.current += 1; };
  }, [workspace, revision]);

  const action = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await work(); setReview(null); setAcknowledged(false); setRevision((value) => value + 1); }
    catch (cause) { setError(reason(cause)); }
    finally { setBusy(false); }
  };

  const read = (skill: SkillInfo, resource = 'SKILL.md') => {
    const current = ++readGeneration.current;
    setReading(skill.id); setError('');
    window.electronAPI.extensions.readSkill(workspace, skill.id, resource).then((next) => {
      if (current === readGeneration.current) setDocument(next);
    }).catch((cause) => {
      if (current === readGeneration.current) setError(reason(cause));
    }).finally(() => { if (current === readGeneration.current) setReading(null); });
  };

  return <div className="absolute inset-0 flex flex-col overflow-hidden bg-surface">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
      {tab === 'skills' ? <BookOpen size={16} className="text-primary" /> : <Plug size={16} className="text-primary" />}
      <h1 className="text-sm font-semibold text-ink">{tab === 'skills' ? 'Skills' : 'Plugins'}</h1>
      <div className="ml-2 flex gap-1" role="tablist" aria-label="Extensions">
        {(['skills', 'plugins'] as const).map((name) => <button type="button" role="tab" aria-selected={tab === name} key={name} onClick={() => setTab(name)} className={`${button} ${tab === name ? 'bg-surface-3 text-ink' : ''}`}>{name === 'skills' ? 'Skills' : 'Plugins'}</button>)}
      </div>
      <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading || busy} className={`${button} ml-auto`}><RefreshCw size={12} className={loading ? 'animate-spin' : ''} />Refresh</button>
      <button type="button" onClick={onClose} className={button}><X size={12} />Done</button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-5">
        {error && <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger/5 p-3 text-xs leading-5 text-danger">{error}</p>}
        {catalog?.errors.map((message) => <p role="alert" key={message} className="mb-3 rounded-md border border-line p-3 text-xs leading-5 text-ink-2">{message}</p>)}
        {loading && <p role="status" className="mb-4 flex items-center gap-2 text-xs text-ink-3"><LoaderCircle size={14} className="animate-spin" />Reading local extensions…</p>}
        {tab === 'skills' ? <>
          <p className="text-xs leading-5 text-ink-3">Skills are reusable local instructions. The model sees their names and descriptions, then reads SKILL.md and linked resources only when needed. “Use in chat” creates an unsent draft.</p>
          <div className="my-4 rounded-md border border-line bg-surface-2 p-3 text-xs leading-5 text-ink-3">
            <p>Personal skills: <code className="break-all text-ink-2">{catalog?.personalSkillsRoot || '~/.antimatter/skills'}</code></p>
            <p>Project skills: <code className="break-all text-ink-2">{catalog?.projectSkillsRoot || 'Choose a project, then add .agents/skills/<name>/SKILL.md'}</code></p>
          </div>
          {!loading && catalog?.skills.length === 0 && <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-ink-3">No local skills found. Put a SKILL.md in a named subfolder of either skills directory, or import a plugin.</p>}
          <ul className="space-y-2">{catalog?.skills.map((skill) => <li key={skill.id} className="rounded-lg border border-line bg-surface-2 p-3">
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium text-ink">${skill.name}</h2><span className="text-[10px] uppercase tracking-wide text-ink-3">{skill.source}{!skill.enabled ? ' · disabled' : ''}</span>
              <button type="button" onClick={() => read(skill)} disabled={!skill.enabled || !!skill.error || !!reading} className={`${button} ml-auto`}>{reading === skill.id ? 'Reading…' : 'Read skill'}</button>
              <button type="button" onClick={() => onUseSkill(skill.name)} disabled={!skill.enabled || !!skill.error} className={button}>Use in chat</button>
            </div>
            <p className="mt-2 text-xs leading-5 text-ink-2">{skill.description}</p><p className="mt-1 break-all text-[11px] text-ink-3">{skill.root}</p>
            {skill.error && <p role="alert" className="mt-2 text-xs text-danger">{skill.error}</p>}
          </li>)}</ul>
          {document && <section className="mt-5 rounded-lg border border-line bg-surface-2 p-4">
            <div className="mb-3 flex items-center gap-2"><h2 className="min-w-0 flex-1 break-all text-sm font-medium text-ink">${document.skill.name} · {document.resource}</h2><button type="button" onClick={() => { readGeneration.current += 1; setDocument(null); setReading(null); }} aria-label="Close skill document" className={button}><X size={13} /></button></div>
            <label className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">Read a resource<select aria-label="Skill resource" value={document.resource} disabled={!!reading} onChange={(event) => read(document.skill, event.target.value)} className="min-w-0 max-w-full rounded-md border border-line bg-surface-0 p-1.5 text-ink-2">{[...new Set(['SKILL.md', document.resource, ...document.resources])].map((resource) => <option key={resource} value={resource}>{resource}</option>)}</select></label>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-ink-2">{document.content}</pre>
            {document.resourcesTruncated && <p className="mt-2 text-xs text-ink-3">Resource listing is bounded. Additional files are omitted.</p>}
          </section>}
        </> : <>
          <div className="mb-4 flex flex-wrap items-start gap-3"><p className="min-w-0 flex-1 text-xs leading-5 text-ink-3">Import a local plugin folder containing .codex-plugin/plugin.json or plugin.json. Imports are disabled until you review and enable them. This version supports skill folders and stdio MCP servers, not remote marketplaces or hooks.</p><button type="button" onClick={() => void action(() => window.electronAPI.extensions.importPlugin())} disabled={busy} className={button}><FolderPlus size={13} />Import folder</button></div>
          {!loading && catalog?.plugins.length === 0 && <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-ink-3">No local plugins imported.</p>}
          <ul className="space-y-3">{catalog?.plugins.map((plugin) => <li key={plugin.id} className="rounded-lg border border-line bg-surface-2 p-4">
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium text-ink">{plugin.name}</h2>{plugin.version && <span className="text-[11px] text-ink-3">{plugin.version}</span>}<span className={`text-[11px] ${plugin.enabled ? 'text-accent' : 'text-ink-3'}`}>{plugin.enabled ? 'Enabled' : 'Disabled'}</span>
              <button type="button" disabled={busy || (!plugin.enabled && !!plugin.error)} onClick={() => plugin.enabled ? void action(() => window.electronAPI.extensions.setPluginEnabled(plugin.id, false)) : (setReview(plugin), setAcknowledged(false))} className={`${button} ml-auto`}>{plugin.enabled ? 'Disable' : 'Review & enable'}</button>
            </div>
            <p className="mt-2 text-xs leading-5 text-ink-2">{plugin.description || 'Local plugin'}</p><p className="mt-1 break-all text-[11px] text-ink-3">{plugin.root}</p><p className="mt-2 text-xs text-ink-3">{plugin.skills} skill{plugin.skills === 1 ? '' : 's'} · {plugin.servers.length} MCP server{plugin.servers.length === 1 ? '' : 's'}</p>
            {(plugin.error || plugin.activationError) && <p role="alert" className="mt-2 text-xs leading-5 text-danger">{plugin.error || plugin.activationError}</p>}
            {plugin.warnings.map((warning) => <p key={warning} className="mt-1 text-xs text-ink-3">{warning}</p>)}
          </li>)}</ul>
        </>}
      </div>
    </div>
    {review && <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="enable-plugin-title">
      <section className="max-h-full w-full max-w-xl overflow-y-auto rounded-xl border border-line bg-surface-2 p-5 shadow-xl">
        <h2 id="enable-plugin-title" className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink"><ShieldAlert size={17} />Enable {review.name}?</h2>
        <PluginPermissionSummary plugin={review} />
        <label className="mt-4 flex items-start gap-2 text-xs leading-5 text-ink-2"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1" />I trust this local plugin and understand its permissions.</label>
        <div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setReview(null)} disabled={busy} className={button}>Cancel</button><button type="button" onClick={() => void action(() => window.electronAPI.extensions.setPluginEnabled(review.id, true, review.fingerprint))} disabled={busy || !acknowledged} className={button}><Check size={13} />{busy ? 'Enabling…' : 'Enable plugin'}</button></div>
      </section>
    </div>}
  </div>;
}
