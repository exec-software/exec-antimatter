import { ArrowRight, FileCode2, FolderOpen, Layers3 } from 'lucide-react';
import { openCodeFolder, showNewFrameworkProject, type ProjectStarter } from './workspaceUi';

const starters: { id: ProjectStarter; label: string; detail: string; suffix: string }[] = [
  { id: 'ny', label: 'Ny application', detail: 'A concise, typed entrypoint.', suffix: '.ny' },
  { id: 'matrix', label: 'Matrix application', detail: 'Structured prose, the same NIL runtime.', suffix: '.matrix' },
  { id: 'mixed', label: 'Ny + Matrix', detail: 'A Matrix entrypoint with a Ny module.', suffix: 'NIL' },
];

export function CodeWelcome({ projectName, entry, onOpenEntry }: { projectName?: string; entry?: string; onOpenEntry?(): void }) {
  return <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-surface px-6 py-8">
    <div className="my-auto w-full max-w-xl">
      <div className="mb-6 flex items-start gap-3">
        <span className="mt-1 rounded-lg border border-primary/30 bg-primary/10 p-2.5 text-primary"><FileCode2 size={24} strokeWidth={1.5} /></span>
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-3">Antimatter Code</p>
          <h1 className="text-xl font-medium tracking-tight text-ink">{projectName ? projectName : 'From a new idea to running code.'}</h1>
          <p className="mt-2 text-xs leading-relaxed text-ink-2">{projectName
            ? 'Your project is ready. Open its entrypoint, or choose a file from the explorer.'
            : 'Create a NIL Framework project with source, a build manifest and a runnable entrypoint. Ny and Matrix work together in the same project.'}</p>
        </div>
      </div>
      {projectName && entry && onOpenEntry && <button type="button" onClick={onOpenEntry} className="mb-5 flex w-full items-center gap-2 rounded-md border border-primary/35 bg-primary/10 px-3 py-2.5 text-left text-xs text-ink hover:bg-primary/15">
        <FileCode2 size={14} className="shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate">Open {entry}</span><ArrowRight size={13} className="text-primary" />
      </button>}
      <div className="overflow-hidden rounded-lg border border-line">
        <p className="border-b border-line bg-surface-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-ink-3">Start a project</p>
        {starters.map(starter => <button key={starter.id} type="button" aria-label={`Create ${starter.label}`} onClick={() => showNewFrameworkProject(starter.id)} className="group flex w-full items-center gap-3 border-b border-line-soft px-3 py-3 text-left last:border-b-0 hover:bg-surface-2">
          <span className="w-12 shrink-0 font-mono text-[10px] text-primary">{starter.suffix}</span>
          <span className="min-w-0 flex-1"><span className="block text-xs font-medium text-ink">{starter.label}</span><span className="mt-0.5 block text-[11px] text-ink-3">{starter.detail}</span></span>
          <ArrowRight size={13} className="shrink-0 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-primary" />
        </button>)}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => void openCodeFolder()} className="inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-ink-2 hover:text-primary"><FolderOpen size={14} />Open existing folder</button>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-ink-3"><Layers3 size={12} />One workspace. Multiple languages.</span>
      </div>
    </div>
  </div>;
}
