import { useCallback, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Folder, FolderPlus, Import, MessageSquare, MessageSquareQuote, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react';
import type { PinnedConversation, Project, Thread, Draft } from '../../types';
import type { ChatImportSource } from '../../../../src/api/chatImports';
import { ALL_CHATS_PROJECT, UNGROUPED_PROJECT, reorderVisibleSidebarRows, sidebarDescendants, sidebarProjectForThread, type ChatSection, type SidebarProject } from '../../../../src/api/sidebar';
import { importedChatSource, isPinnedThread, loadImportedSidebarGroups, sidebarLists, type PinnedRow, type SidebarLists } from '../../lib/pins';
import type { SidebarWorkspace } from '../../lib/sidebarWorkspace';
import type { Point } from '../../lib/menu';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { ConfirmDialog } from '../ConfirmDialog';
import { ProjectDialog, MoveChatDialog } from './ProjectDialog';
import { DEFAULT_SIDEBAR_VISIBILITY, type SidebarVisibility } from '../../lib/sidebarVisibility';

interface Props {
  threads: Thread[];
  projects: Project[];
  pinned: PinnedConversation[];
  activeProjectId: string;
  activeThreadId: string | null;
  search: string;
  onSelectThread(id: string): void;
  onSelectProject(id: string): void;
  onOpenPinned(entry: PinnedConversation): void;
  onUnpin(id: string): void;
  onDeleteThread(id: string): void;
  onRenameThread(id: string, title: string): void;
  onPinThread(id: string, pinned: boolean): void;
  drafts: Record<string, Draft>;
  working: ReadonlySet<string>;
  onImportChats?(source: ChatImportSource): void;
  visibility?: SidebarVisibility;
  workspace?: SidebarWorkspace;
}

const rowClass = (active: boolean) => `flex w-full items-start gap-2 rounded-md border-l-2 px-2.5 py-2 text-left transition ${active ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-surface-3/60'}`;
const iconButton = 'rounded p-1 text-ink-3 transition hover:bg-surface-3 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
const sources = ['claude', 'codex', 'opencode'] as const;
const sourceTitle = (source: ChatImportSource) => `${source === 'claude' ? 'Claude' : source === 'codex' ? 'Codex' : 'OpenCode'} chats`;
const pinKey = (row: PinnedRow) => row.kind === 'conversation' ? `thread:${row.thread.id}` : `message:${row.entry.id}`;
const sectionKeys = (lists: SidebarLists, section: ChatSection): string[] => section === 'pinned' ? lists.pinned.map(pinKey)
  : (section === 'recent' ? lists.recent : lists.imported[section.slice(9) as ChatImportSource]).map((thread) => `thread:${thread.id}`);
const dragType = 'application/x-antimatter-chat';

function PreviewLine({ thread, draft }: { thread: Thread; draft?: Draft }) {
  const last = thread.messages[thread.messages.length - 1];
  return <span className="block truncate text-[11px] text-ink-3">
    {draft?.text.trim() ? <><span className="text-primary">Draft · </span>{draft.text.trim()}</>
      : last ? `${last.role === 'user' ? 'You' : importedChatSource(thread) ? 'Assistant' : 'Antimatter'}: ${last.content || '…'}` : 'Empty chat'}
  </span>;
}

function Section({ title, expanded, onToggle, actions, children, onDragOver, onDrop, source }: {
  title: string; expanded: boolean; onToggle(): void; actions?: ReactNode; children: ReactNode;
  onDragOver?(event: DragEvent): void; onDrop?(event: DragEvent): void; source?: ChatImportSource;
}) {
  const contentId = source ? `sidebar-imported-${source}` : `sidebar-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return <section aria-label={title} data-imported-group={source} onDragOver={onDragOver} onDrop={onDrop}>
    <div className="mb-1 flex items-center gap-1">
      <button type="button" aria-label={`Toggle ${title}`} aria-expanded={expanded} aria-controls={contentId} onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 rounded py-1 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span className="truncate">{title}</span>
      </button>{actions}
    </div>
    <div id={contentId} hidden={!expanded} className={expanded ? 'grid gap-0.5' : 'hidden'}>{children}</div>
  </section>;
}

export default function Sidebar({ threads, projects, pinned, activeProjectId, activeThreadId, search, onSelectThread, onSelectProject,
  onOpenPinned, onUnpin, onDeleteThread, onRenameThread, onPinThread, drafts, working, onImportChats,
  visibility = DEFAULT_SIDEBAR_VISIBILITY, workspace }: Props) {
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [menu, setMenu] = useState<{ threadId: string; section: ChatSection; key: string; at: Point } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: SidebarProject; at: Point } | null>(null);
  const [editor, setEditor] = useState<{ project?: SidebarProject; parentId?: string } | null>(null);
  const [deleting, setDeleting] = useState<SidebarProject | null>(null);
  const [moving, setMoving] = useState<Thread | null>(null);
  const [localCollapsed, setLocalCollapsed] = useState<Record<string, boolean>>({});
  const [legacyImports] = useState(() => loadImportedSidebarGroups());
  const dragging = useRef<{ threadId: string; section: ChatSection; key: string } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const canEdit = !!workspace?.ready;
  const lists = sidebarLists(threads, pinned, { projectId: activeProjectId, query: search, sidebar: workspace?.state });
  const allLists = sidebarLists(threads, pinned, { projectId: workspace ? ALL_CHATS_PROJECT : activeProjectId, query: '', sidebar: workspace?.state });
  const query = search.trim();
  const hiddenSearchMatches = !!query && ((!visibility.pinned && lists.pinned.length > 0) || (!visibility.recent && lists.recent.length > 0)
    || sources.some((source) => !visibility[`imported-${source}`] && lists.imported[source].length > 0));
  const collapsed = (id: string) => workspace?.state.collapsed[id] ?? localCollapsed[id]
    ?? (id.startsWith('imported-') ? !legacyImports[id.slice(9) as ChatImportSource] : false);
  const toggle = (id: string) => {
    if (workspace) { if (canEdit) void workspace.update({ kind: 'collapse', section: id, collapsed: !collapsed(id) }); }
    else setLocalCollapsed((current) => ({ ...current, [id]: !collapsed(id) }));
  };
  const expanded = (id: string, count = 0) => !collapsed(id) || (!!query && count > 0);
  const point = (event: MouseEvent<HTMLElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: bounds.left + 12, y: bounds.bottom };
  };
  const openMenu = (threadId: string, section: ChatSection, key: string) => (event: MouseEvent<HTMLElement>) => {
    event.preventDefault(); setMenu({ threadId, section, key, at: point(event) });
  };
  const reorder = (section: ChatSection, key: string, before: string | null) => {
    if (!canEdit || !workspace) return;
    const all = sectionKeys(allLists, section); const visible = sectionKeys(lists, section);
    if (!all.includes(key)) all.push(key);
    if (!visible.includes(key)) visible.push(key);
    void workspace.update({ kind: 'reorder', section, ids: reorderVisibleSidebarRows(all, visible, key, before) });
  };
  const accepts = (section: ChatSection) => {
    const data = dragging.current;
    if (!data || !canEdit) return false;
    if (data.key.startsWith('message:')) return section === 'pinned';
    const thread = threads.find((entry) => entry.id === data.threadId);
    return !!thread && (section === 'pinned' || section === 'recent' || section === `imported-${importedChatSource(thread)}`);
  };
  const dragOver = (section: ChatSection) => (event: DragEvent) => {
    if (accepts(section)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
  };
  const drop = (section: ChatSection, before: string | null = null) => (event: DragEvent) => {
    if (!accepts(section) || !workspace) return;
    event.preventDefault(); event.stopPropagation();
    const data = dragging.current!; dragging.current = null;
    if (data.key === before) return;
    const thread = threads.find((entry) => entry.id === data.threadId)!;
    if (data.key.startsWith('thread:') && section !== data.section) {
      if (section === 'pinned') onPinThread(thread.id, true);
      else {
        if (isPinnedThread(thread)) onPinThread(thread.id, false);
        if (importedChatSource(thread)) void workspace.update({ kind: 'import-location', threadId: thread.id, recent: section === 'recent' });
      }
    }
    reorder(section, data.key, before);
  };
  const dragProps = (threadId: string, section: ChatSection, key: string) => ({
    draggable: canEdit,
    onDragStart: (event: DragEvent) => { dragging.current = { threadId, section, key }; event.dataTransfer.setData(dragType, key); event.dataTransfer.effectAllowed = 'move'; },
    onDragEnd: () => { dragging.current = null; }, onDragOver: dragOver(section), onDrop: drop(section, key),
  });
  const menuThread = menu && threads.find((thread) => thread.id === menu.threadId);
  const menuEntries = (thread: Thread): MenuEntry[] => {
    const entries: MenuEntry[] = [isPinnedThread(thread)
      ? { id: 'unpin', label: 'Unpin chat', icon: PinOff, onSelect: () => onPinThread(thread.id, false) }
      : { id: 'pin', label: 'Pin chat', icon: Pin, onSelect: () => onPinThread(thread.id, true) }];
    if (canEdit && workspace && menu) {
      const keys = sectionKeys(lists, menu.section); const position = keys.indexOf(menu.key);
      if (position > 0) entries.push({ id: 'up', label: 'Move up', icon: ArrowUp, onSelect: () => reorder(menu.section, menu.key, keys[position - 1]) });
      if (position >= 0 && position < keys.length - 1) entries.push({ id: 'down', label: 'Move down', icon: ArrowDown, onSelect: () => reorder(menu.section, menu.key, keys[position + 2] ?? null) });
      entries.push({ id: 'move', label: 'Move to project…', icon: Folder, onSelect: () => setMoving(thread) });
      if (importedChatSource(thread)) {
        const recent = workspace.state.importedInRecent.includes(thread.id);
        entries.push({ id: 'import-location', label: recent ? 'Move to imported chats' : 'Move to Recent', icon: Import,
          onSelect: () => { if (isPinnedThread(thread)) onPinThread(thread.id, false); void workspace.update({ kind: 'import-location', threadId: thread.id, recent: !recent }); } });
      }
    }
    entries.push({ kind: 'separator', id: 'manage' }, { id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => setEditing({ id: thread.id, title: thread.title }) },
      { id: 'delete', label: 'Delete', icon: Trash2, tone: 'danger', onSelect: () => onDeleteThread(thread.id) });
    return entries;
  };
  const chatRow = (thread: Thread, section: ChatSection, entry?: PinnedConversation) => {
    const key = entry ? `message:${entry.id}` : `thread:${thread.id}`;
    const source = section.startsWith('imported-') ? section.slice(9) as ChatImportSource : undefined;
    const Icon = entry ? MessageSquareQuote : section === 'pinned' ? Pin : MessageSquare;
    const active = thread.id === activeThreadId;
    return <div key={key} className="group relative" {...dragProps(thread.id, section, key)}>
      {editing?.id === thread.id && !entry ? <input autoFocus aria-label="Conversation name" value={editing.title}
        onFocus={(event) => event.currentTarget.select()} onChange={(event) => setEditing({ ...editing, title: event.target.value })}
        onBlur={() => setEditing(null)} onKeyDown={(event) => {
          if (event.key === 'Escape') setEditing(null);
          if (event.key === 'Enter' && editing.title.trim()) { onRenameThread(thread.id, editing.title.trim()); setEditing(null); }
        }} className="w-full rounded-md border border-primary/60 bg-surface-3 px-2.5 py-2 text-[13px] text-ink focus:outline-none" /> : <>
        <button type="button" onClick={() => entry ? onOpenPinned(entry) : onSelectThread(thread.id)} onDoubleClick={() => !entry && setEditing({ id: thread.id, title: thread.title })}
          onContextMenu={openMenu(thread.id, section, key)} data-thread-row={thread.id} data-imported-source={source}
          data-pinned={section === 'pinned' ? entry ? 'message' : 'conversation' : undefined} className={`${rowClass(active)} pr-14`}>
          <Icon size={14} className={`mt-0.5 shrink-0 ${active || working.has(thread.id) || section === 'pinned' ? 'text-primary' : 'text-ink-3'}`} />
          <span className="min-w-0 flex-1"><span className="flex items-center gap-1"><span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-2">{thread.title}</span>
            {working.has(thread.id) && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" role="status" aria-label="Working" title="Answering now" />}</span>
            {entry ? <span className="block truncate text-[11px] text-ink-3">{entry.sourceName} · {entry.snippet}</span> : <PreviewLine thread={thread} draft={drafts[thread.id]} />}
          </span>
        </button>
        <div className="absolute right-1 top-2 flex opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <button type="button" onClick={openMenu(thread.id, section, key)} aria-label={`Actions for ${thread.title}`} className={iconButton}><MoreHorizontal size={13} /></button>
          {section === 'pinned' && <button type="button" onClick={() => entry ? onUnpin(entry.id) : onPinThread(thread.id, false)}
            aria-label={entry ? `Unpin message in ${thread.title}` : `Unpin ${thread.title}`} className={iconButton}><PinOff size={12} /></button>}
        </div>
      </>}
    </div>;
  };
  const groupRows = (parent: string | null, depth = 0): ReactNode => (workspace?.state.projects ?? projects.map((project) => ({ ...project, parentId: null })))
    .filter((project) => project.parentId === parent).map((project) => {
      const children = workspace?.state.projects.some((entry) => entry.parentId === project.id);
      const scope = workspace ? sidebarDescendants(workspace.state, project.id) : new Set([project.id]);
      const count = threads.filter((thread) => scope.has(workspace ? sidebarProjectForThread(workspace.state, thread) : thread.projectId)).length;
      return <div key={project.id}>
        <div className="group relative flex items-center" style={{ paddingLeft: depth * 12 }}
          onDragOver={(event) => { if (canEdit && dragging.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
          onDrop={(event) => { if (!workspace || !dragging.current) return; event.preventDefault(); event.stopPropagation(); void workspace.update({ kind: 'move-thread', threadId: dragging.current.threadId, projectId: project.id }); dragging.current = null; }}>
          {children && <button type="button" aria-label={`${collapsed(`project:${project.id}`) ? 'Expand' : 'Collapse'} ${project.name}`} aria-expanded={!collapsed(`project:${project.id}`)} onClick={() => toggle(`project:${project.id}`)} className={iconButton}>{collapsed(`project:${project.id}`) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>}
          <button type="button" data-project-row={project.id} onClick={() => onSelectProject(project.id)} title={project.description || undefined}
            onContextMenu={(event) => { if (!canEdit) return; event.preventDefault(); setProjectMenu({ project, at: point(event) }); }} className={`${rowClass(project.id === activeProjectId)} min-w-0 pr-7`}>
            <Folder size={14} className="mt-0.5 shrink-0 text-ink-3" /><span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{project.name}</span><span className="text-[10px] text-ink-3">{count}</span>
          </button>
          {canEdit && <button type="button" aria-label={`Actions for ${project.name}`} className={`${iconButton} absolute right-0 opacity-0 focus:opacity-100 group-hover:opacity-100`}
            onClick={(event) => setProjectMenu({ project, at: point(event) })}><MoreHorizontal size={13} /></button>}
        </div>{children && !collapsed(`project:${project.id}`) && groupRows(project.id, depth + 1)}
      </div>;
    });
  const empty = (message: string) => <p className="px-2.5 py-1.5 text-xs text-ink-3">{message}</p>;
  return <div className="flex flex-col gap-4 p-3">
    {workspace?.error && <div role="alert" className="text-xs text-danger">{workspace.error}<button type="button" onClick={() => void workspace.refresh()} className="ml-2 underline">Retry</button></div>}
    {hiddenSearchMatches && <p className="px-2.5 text-[11px] text-ink-3">Matching chats in hidden sections are shown while searching.</p>}
    {workspace && <div className="grid gap-0.5"><button type="button" onClick={() => onSelectProject(ALL_CHATS_PROJECT)} className={rowClass(activeProjectId === ALL_CHATS_PROJECT)}><MessageSquare size={14} /><span className="text-xs">All chats</span></button>
      <button type="button" onClick={() => onSelectProject(UNGROUPED_PROJECT)} className={rowClass(activeProjectId === UNGROUPED_PROJECT)}
        onDragOver={(event) => { if (canEdit && dragging.current) event.preventDefault(); }}
        onDrop={(event) => { if (!dragging.current) return; event.preventDefault(); void workspace.update({ kind: 'move-thread', threadId: dragging.current.threadId, projectId: null }); dragging.current = null; }}><Folder size={14} /><span className="text-xs">Ungrouped</span></button></div>}
    {(visibility.pinned || (!!query && lists.pinned.length > 0)) && <Section title="Pinned" expanded={expanded('pinned', lists.pinned.length)} onToggle={() => toggle('pinned')} onDragOver={dragOver('pinned')} onDrop={drop('pinned')}>
      {lists.pinned.length ? lists.pinned.map((row) => chatRow(row.thread, 'pinned', row.kind === 'message' ? row.entry : undefined)) : empty(query ? 'No matching pins.' : 'No pinned chats.')}
    </Section>}
    {visibility.projects && <Section title="Projects" expanded={expanded('projects')} onToggle={() => toggle('projects')}
      actions={workspace && <button type="button" disabled={!canEdit} onClick={() => setEditor({})} className={iconButton} aria-label="New project group"><Plus size={13} /></button>}>
      {groupRows(null)}{workspace && workspace.state.projects.length === 0 && empty('Create a group to organize your chats.')}
    </Section>}
    {sources.map((source) => {
      const section: ChatSection = `imported-${source}`; const rows = lists.imported[source];
      if (!visibility[section] && !(query && rows.length > 0)) return null;
      return <Section key={source} title={sourceTitle(source)} source={source} expanded={expanded(section, rows.length)} onToggle={() => { if (!query) toggle(section); }}
        onDragOver={dragOver(section)} onDrop={drop(section)} actions={<><span aria-label={`${rows.length} unpinned ${sourceTitle(source)}`} className="text-[10px] text-ink-3">{rows.length}</span><button type="button" onClick={() => onImportChats?.(source)} disabled={!onImportChats}
          aria-label={`Import ${sourceTitle(source)}`} title={`Import ${sourceTitle(source)}`} className={`${iconButton} disabled:opacity-40`}><Import size={13} /></button></>}>
        {rows.length ? rows.map((thread) => chatRow(thread, section)) : empty(query ? 'No matching imported conversations.' : `No unpinned ${sourceTitle(source)} in this project.`)}
      </Section>;
    })}
    {(visibility.recent || (!!query && lists.recent.length > 0)) && <Section title="Recent" expanded={expanded('recent', lists.recent.length)} onToggle={() => toggle('recent')} onDragOver={dragOver('recent')} onDrop={drop('recent')}>
      {lists.recent.length ? lists.recent.map((thread) => chatRow(thread, 'recent')) : empty(query ? 'No matching chats.' : 'No recent chats.')}
    </Section>}
    {menu && menuThread && <ContextMenu at={menu.at} label={`${menuThread.title} actions`} entries={menuEntries(menuThread)} onClose={closeMenu} />}
    {projectMenu && workspace && <ContextMenu at={projectMenu.at} label={`${projectMenu.project.name} actions`} onClose={() => setProjectMenu(null)} entries={[
      { id: 'edit', label: 'Edit group', icon: Pencil, onSelect: () => setEditor({ project: projectMenu.project }) },
      { id: 'child', label: 'New subgroup', icon: FolderPlus, onSelect: () => setEditor({ parentId: projectMenu.project.id }) },
      { id: 'delete', label: 'Remove group', icon: Trash2, tone: 'danger', onSelect: () => setDeleting(projectMenu.project) },
    ]} />}
    {editor && workspace && <ProjectDialog workspace={workspace} {...editor} onClose={() => setEditor(null)} />}
    {moving && workspace && <MoveChatDialog workspace={workspace} threadId={moving.id} initialProject={sidebarProjectForThread(workspace.state, moving)} onClose={() => setMoving(null)} />}
    {deleting && workspace && <ConfirmDialog title={`Remove ${deleting.name}?`} message={`Chats and subgroups move ${deleting.parentId ? 'to the parent group' : 'out of this group'}. No chats or files are deleted.`}
      confirmLabel="Remove group" onCancel={() => setDeleting(null)} onConfirm={() => { void workspace.update({ kind: 'delete-project', id: deleting.id }).then((next) => { if (next) { if (activeProjectId === deleting.id) onSelectProject(deleting.parentId ?? UNGROUPED_PROJECT); setDeleting(null); } }); }} />}
  </div>;
}
