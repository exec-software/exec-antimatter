import { useEffect, useRef, useState } from 'react';
import { FileInput, FolderOpen, X } from 'lucide-react';
import type { ChatImportPreview, ChatImportResult, ChatImportSource } from '../../../../src/api/chatImports';
import type { Project } from '../../types';

interface Props { source: ChatImportSource; projects: Project[]; projectId: string; threadCount: number; onClose(): void; onOpenThread(id: string): void }
const formatLabel = { 'claude-export': 'Claude export', 'claude-code': 'Claude Code', 'codex-rollout': 'Codex session', 'opencode-export': 'OpenCode export' };
const button = 'rounded-md border border-line px-3 py-2 text-xs text-ink-2 hover:bg-surface-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:opacity-40';

export function ImportChatsPage({ source, projects, projectId, threadCount, onClose, onOpenThread }: Props) {
  const [preview, setPreview] = useState<ChatImportPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [destination, setDestination] = useState(projectId);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ChatImportResult | null>(null);
  const alive = useRef(true);
  const batch = useRef<string | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (batch.current) void window.electronAPI.chatImports.discard(batch.current).catch(() => undefined);
    };
  }, []);
  const capacity = Math.max(0, 200 - threadCount);
  const available = preview?.candidates.filter((item) => !item.alreadyImported) ?? [];
  async function choose(mode: 'files' | 'folder') {
    if (pending.current) return;
    pending.current = true; setBusy('Reading selected chats…'); setError(''); setResult(null);
    try {
      const next = await window.electronAPI.chatImports.choose({ source, mode });
      if (!alive.current) { if (next) await window.electronAPI.chatImports.discard(next.batchId); return; }
      if (next) {
        batch.current = next.batchId;
        setPreview(next);
        setSelected([]);
      }
    } catch (cause) {
      if (alive.current) {
        if (batch.current) void window.electronAPI.chatImports.discard(batch.current).catch(() => undefined);
        batch.current = null; setPreview(null); setSelected([]);
        setError(cause instanceof Error ? cause.message : 'Could not read those chats.');
      }
    }
    finally { pending.current = false; if (alive.current) setBusy(''); }
  }
  async function commit() {
    if (!preview || !selected.length || selected.length > capacity || pending.current) return;
    pending.current = true; setBusy('Importing selected chats…'); setError('');
    try {
      const imported = await window.electronAPI.chatImports.commit({ batchId: preview.batchId, ids: selected, projectId: destination });
      batch.current = null;
      if (alive.current) { setResult(imported); setPreview(null); setSelected([]); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Import failed. No chats were replaced.'); }
    finally { pending.current = false; if (alive.current) setBusy(''); }
  }
  const label = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }[source];
  return <div className="absolute inset-0 overflow-y-auto bg-surface">
    <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
      <FileInput size={16} className="text-primary" /><h1 className="text-sm font-semibold text-ink">Import {label} chats</h1>
      <button type="button" onClick={onClose} disabled={!!busy} className={`${button} ml-auto flex items-center gap-1.5 !py-1`}><X size={12} />Done</button>
    </header>
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-5">
      <section aria-labelledby="import-instructions">
        <h2 id="import-instructions" className="text-sm font-medium text-ink">Bring your conversations into Antimatter</h2>
        <p className="mt-2 text-xs leading-5 text-ink-2">Select files, review the list, then choose what to import. Originals stay untouched. Re-importing the same conversation skips it instead of overwriting your Antimatter copy.</p>
        {source === 'claude' ? <p className="mt-2 text-xs leading-5 text-ink-2">For Claude chats, export data from Settings → Privacy, extract the download, and choose conversations.json. For Claude Code, choose JSONL sessions or a project folder under ~/.claude/projects.</p>
          : source === 'codex' ? <p className="mt-2 text-xs leading-5 text-ink-2">Choose Codex rollout JSONL files, or a date folder under ~/.codex/sessions. Archived sessions can be selected from ~/.codex/archived_sessions. Prompt-only history.jsonl and cloud-only chats are not full session transcripts.</p>
          : <div className="mt-2 space-y-2 text-xs leading-5 text-ink-2">
            <p>Export a session from OpenCode, then choose the JSON file. You can select several exports or a folder containing exported sessions.</p>
            <pre className="overflow-x-auto rounded-md border border-line bg-surface-2 p-3 text-ink"><code>opencode export SESSION_ID &gt; session.json</code></pre>
            <p>Use the JSON session export, not the Markdown transcript. Check your installed CLI's help if its command layout differs. Raw databases, storage folders, and share URLs are not supported. Export first; do not select your OpenCode data directory.</p>
          </div>}
        <p className="mt-2 text-xs leading-5 text-ink-3">Text and supported tool history are copied; commands never replay. Original system prompts, permissions, working directories, provider settings, and live agent links are not adopted. Unsupported media is noted, not fetched. Chat text may contain private data: review it before continuing, which sends the chat to your selected provider.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={`${button} flex items-center gap-2`} disabled={!!busy} onClick={() => void choose('files')}><FileInput size={14} />Choose files</button>
          <button type="button" className={`${button} flex items-center gap-2`} disabled={!!busy} onClick={() => void choose('folder')}><FolderOpen size={14} />{source === 'opencode' ? 'Choose export folder' : 'Choose session folder'}</button>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">{source === 'opencode' ? 'Exported JSON only.' : 'JSON / JSONL only.'} Up to 32 MiB per file, 64 MiB per batch, and 200 session files. {source === 'opencode' ? 'Large export collections: choose a smaller folder.' : 'Large session trees: choose a smaller date or project folder.'}</p>
      </section>
      {busy && <p role="status" className="text-xs text-accent">{busy}</p>}
      {error && <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-xs text-danger">{error}</p>}
      {result && <section aria-label="Import result" className="rounded-md border border-accent/40 bg-accent/5 p-4">
        <p role="status" className="text-sm text-ink">Imported {result.importedThreadIds.length} chat{result.importedThreadIds.length === 1 ? '' : 's'}. {result.skipped ? `${result.skipped} already imported; skipped.` : ''}</p>
        <p className="mt-1 text-xs text-ink-2">Find them in the collapsible {label} chats section for the selected project.</p>
        {!!result.importedThreadIds.length && <button type="button" className={`${button} mt-3`} onClick={() => onOpenThread(result.importedThreadIds[0])}>Open first imported chat</button>}
      </section>}
      {preview && <section aria-labelledby="import-review">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="import-review" className="text-sm font-medium text-ink">Review {preview.candidates.length} conversation{preview.candidates.length === 1 ? '' : 's'}</h2><span className="text-xs text-ink-3">{preview.fileCount} file{preview.fileCount === 1 ? '' : 's'} inspected</span></div>
        {!!preview.warnings.length && <details open className="my-3 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-ink-2">
          <summary className="cursor-pointer font-medium text-warning">Import notes ({preview.warnings.length})</summary>
          <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto break-words pl-4">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </details>}
        <fieldset disabled={!!busy} className="mt-3">
          <label className="flex flex-wrap items-center gap-2 text-xs text-ink-2">Import into project
            <select aria-label="Import into project" value={destination} onChange={(event) => setDestination(event.target.value)} className="rounded-md border border-line bg-surface-2 p-2 text-ink">{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          </label>
          <div className="my-3 flex flex-wrap items-center gap-3 text-xs">
            <button type="button" className="text-primary underline disabled:opacity-40" disabled={!available.length || !capacity} onClick={() => setSelected(available.slice(0, capacity).map((item) => item.id))}>Select available ({Math.min(available.length, capacity)})</button>
            <button type="button" className="text-ink-2 underline" onClick={() => setSelected([])}>Clear selection</button>
            <span className="text-ink-3">{selected.length} selected · {capacity} free conversation slots</span>
          </div>
          <div className="max-h-[28rem] overflow-y-auto rounded-md border border-line">
            {preview.candidates.length === 0 && <p className="p-4 text-xs text-ink-2">No supported conversations found. Check the notes above.</p>}
            {preview.candidates.map((item) => <label key={item.id} className="flex items-start gap-3 border-b border-line-soft p-3 last:border-0 hover:bg-surface-2">
              <input type="checkbox" aria-label={`Import ${item.title}`} className="mt-0.5 accent-primary" disabled={item.alreadyImported} checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
              <span className="min-w-0"><span className="block break-words text-xs font-medium text-ink">{item.title}</span>
                <span className="mt-1 block text-[11px] text-ink-3">{formatLabel[item.format]} · {item.messageCount} messages · {item.toolCount} tool calls · {item.createdAt > 0 ? new Date(item.createdAt).toLocaleDateString() : 'Date unavailable'}{item.alreadyImported ? ' · Already imported' : ''}</span></span>
            </label>)}
          </div>
          <p className="my-3 text-[11px] text-ink-3">Preview expires after 15 minutes. Existing chats, drafts, and pins are never replaced. The current store holds up to 200 conversations.</p>
          {selected.length > capacity && <p role="alert" className="mb-3 text-xs text-danger">Choose fewer conversations. There are {capacity} free slots.</p>}
          <button type="button" disabled={!selected.length || selected.length > capacity} onClick={() => void commit()} className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-on-primary hover:bg-primary-strong disabled:opacity-40">Import {selected.length} selected</button>
        </fieldset>
      </section>}
    </div>
  </div>;
}
