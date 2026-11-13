import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { sidebarDescendants, type SidebarProject } from '../../../../src/api/sidebar';
import type { SidebarWorkspace } from '../../lib/sidebarWorkspace';

const field = 'mt-1 w-full rounded-md border border-line bg-surface-3 px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none';
const button = 'rounded-md border border-line px-3 py-2 text-xs text-ink hover:bg-surface-3 disabled:opacity-40';

/** A native modal keeps focus inside the editor and returns it to the originating control. */
function SidebarDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const target = dialog.current;
    const previous = document.activeElement;
    target?.showModal();
    return () => {
      target?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}
    className="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface-2 p-5 text-ink shadow-2xl backdrop:bg-black/60">
    <h2 id={titleId} className="mb-4 text-sm font-semibold">{title}</h2>{children}
  </dialog>;
}

export function ProjectDialog({ workspace, project, parentId = null, onClose }: {
  workspace: SidebarWorkspace; project?: SidebarProject; parentId?: string | null; onClose(): void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [parent, setParent] = useState(project?.parentId ?? parentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const excluded = project ? sidebarDescendants(workspace.state, project.id) : new Set<string>();
  return <SidebarDialog title={project ? 'Edit project group' : 'New project group'} onClose={onClose}>
    <form onSubmit={(event) => {
      event.preventDefault(); setPending(true); setError('');
      void workspace.update(project ? { kind: 'update-project', id: project.id, name, description, parentId: parent }
        : { kind: 'create-project', name, description, parentId: parent }).then((next) => {
        setPending(false); if (next) onClose(); else setError('Could not save this group. Your changes are still here.');
      });
    }} className="space-y-4">
      <label className="block text-xs text-ink-2">Name<input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} className={field} /></label>
      <label className="block text-xs text-ink-2">Description<textarea maxLength={500} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} className={field} /></label>
      <label className="block text-xs text-ink-2">Inside<select value={parent ?? ''} onChange={(event) => setParent(event.target.value || null)} className={field}>
        <option value="">Top level</option>{workspace.state.projects.filter((entry) => !excluded.has(entry.id)).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>
      <p className="text-xs text-ink-3">Groups organize your chats. They do not change workspace folders or permissions.</p>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className={button}>Cancel</button><button disabled={pending || !name.trim()} className={`${button} bg-primary text-on-primary`}>{pending ? 'Saving…' : 'Save'}</button></div>
    </form>
  </SidebarDialog>;
}

export function MoveChatDialog({ workspace, threadId, initialProject, onClose }: {
  workspace: SidebarWorkspace; threadId: string; initialProject: string; onClose(): void;
}) {
  const [projectId, setProjectId] = useState(workspace.state.projects.some((project) => project.id === initialProject) ? initialProject : '');
  const [pending, setPending] = useState(false);
  return <SidebarDialog title="Move chat" onClose={onClose}><form onSubmit={(event) => {
    event.preventDefault(); setPending(true);
    void workspace.update({ kind: 'move-thread', threadId, projectId: projectId || null }).then((next) => { setPending(false); if (next) onClose(); });
  }} className="space-y-4">
    <label className="block text-xs text-ink-2">Project group<select autoFocus value={projectId} onChange={(event) => setProjectId(event.target.value)} className={field}>
      <option value="">Ungrouped</option>{workspace.state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select></label>
    {workspace.error && <p role="alert" className="text-xs text-danger">{workspace.error}</p>}
    <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className={button}>Cancel</button><button disabled={pending} className={`${button} bg-primary text-on-primary`}>{pending ? 'Moving…' : 'Move'}</button></div>
  </form></SidebarDialog>;
}
