import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder, Import, MessageSquare, MessageSquareQuote, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { PinnedConversation, Project, Thread, Draft } from '../../types';
import type { ChatImportSource } from '../../../../src/api/chatImports';
import { importedChatSource, importedSidebarGroupExpanded, isPinnedThread, loadImportedSidebarGroups, saveImportedSidebarGroups, sidebarLists } from '../../lib/pins';
import type { Point } from '../../lib/menu';
import { ContextMenu, type MenuEntry } from '../ContextMenu';
import { DEFAULT_SIDEBAR_VISIBILITY, type SidebarVisibility } from '../../lib/sidebarVisibility';

interface Props {
  threads: Thread[];
  projects: Project[];
  /** Pinned messages. Whole conversations are pinned on the thread itself (Thread.pinnedAt). */
  pinned: PinnedConversation[];
  activeProjectId: string;
  activeThreadId: string | null;
  search: string;
  onSelectThread: (id: string) => void;
  onSelectProject: (id: string) => void;
  onOpenPinned: (entry: PinnedConversation) => void;
  /** Removes one pinned message. */
  onUnpin: (id: string) => void;
  /** Asks to delete; the confirmation belongs to the shell, not to this row. */
  onDeleteThread: (id: string) => void;
  onRenameThread: (id: string, title: string) => void;
  /** Pins a whole conversation, or unpins it. */
  onPinThread: (id: string, pinned: boolean) => void;
  /** Unsent text, by thread. A conversation holding one is not an empty conversation. */
  drafts: Record<string, Draft>;
  /** Conversations with a turn in flight, marked so a background one is not invisible. */
  working: ReadonlySet<string>;
  /** Opens a review/import flow; selecting a group never reads source files automatically. */
  onImportChats?: (source: ChatImportSource) => void;
  /** Hidden chat sections temporarily reappear when they contain search matches. */
  visibility?: SidebarVisibility;
}

const formatTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The line under a conversation's title.
 *
 * An unsent draft wins over the last message, because it is the thing you left unfinished and
 * the reason you are coming back — and a conversation that is nothing *but* a draft used to read
 * as "Empty thread", which is how you lose one.
 */
const preview = (thread: Thread, draft?: Draft) => {
  if (draft?.text.trim()) return { text: draft.text.trim(), draft: true };

  const last = thread.messages[thread.messages.length - 1];
  if (!last) return { text: 'Empty thread', draft: false };
  const speaker = last.role === 'user' ? 'You' : importedChatSource(thread) ? 'Assistant' : 'Antimatter';
  return { text: `${speaker}: ${last.content || '…'}`, draft: false };
};

function PreviewLine({ thread, draft }: { thread: Thread; draft?: Draft }) {
  const line = preview(thread, draft);
  return (
    <span className="block truncate text-[11px] text-ink-3">
      {line.draft && <span className="text-primary">Draft · </span>}
      {line.text}
    </span>
  );
}

const rowClass = (isActive: boolean) =>
  `flex w-full items-start gap-2 rounded-md border-l-2 px-2.5 py-2 text-left transition ${
    isActive ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-surface-3/60'
  }`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <p className="mb-1.5 px-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">{title}</p>
      <div className="grid grid-cols-1 gap-0.5">{children}</div>
    </section>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-1.5 text-xs text-ink-3">{children}</p>;
}

/** The title, in place, selected so typing replaces it. Enter keeps, Escape and blur discard. */
function RenameRow({
  title,
  onCommit,
  onCancel,
}: {
  title: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  return (
    <input
      ref={input}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(value);
        if (event.key === 'Escape') onCancel();
      }}
      onBlur={() => onCancel()}
      aria-label="Conversation name"
      className="w-full rounded-md border border-primary/60 bg-surface-3 px-2.5 py-2 text-[13px] font-medium text-ink focus:outline-none"
    />
  );
}

const iconButton = 'rounded p-1 text-ink-3 transition hover:bg-surface-3 hover:text-ink';

export default function Sidebar({
  threads,
  projects,
  pinned,
  activeProjectId,
  activeThreadId,
  search,
  onSelectThread,
  onSelectProject,
  onOpenPinned,
  onUnpin,
  onDeleteThread,
  onRenameThread,
  onPinThread,
  drafts,
  working,
  onImportChats,
  visibility = DEFAULT_SIDEBAR_VISIBILITY,
}: Props) {
  /** The row being renamed in place, if any. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The conversation a context menu is open for, and where. */
  const [menu, setMenu] = useState<{ threadId: string; at: Point } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [importedGroups, setImportedGroups] = useState(() => loadImportedSidebarGroups());

  const lists = sidebarLists(threads, pinned, { projectId: activeProjectId, query: search });
  const query = search.trim();
  const hiddenSearchMatches = !!query && (
    (!visibility.pinned && lists.pinned.length > 0)
    || (!visibility.recent && lists.recent.length > 0)
    || (['claude', 'codex', 'opencode'] as const).some((source) => !visibility[`imported-${source}`] && lists.imported[source].length > 0)
  );

  /**
   * Right-click, or the keyboard's menu key, on any conversation row. From the keyboard there is
   * no pointer to open at, so the menu opens under the row instead of in the window's corner.
   */
  const openMenu = (threadId: string) => (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const row = event.currentTarget.getBoundingClientRect();
    setMenu({ threadId, at: fromKeyboard ? { x: row.left + 12, y: row.bottom } : { x: event.clientX, y: event.clientY } });
  };

  const menuThread = menu ? threads.find((thread) => thread.id === menu.threadId) : undefined;
  const menuEntries = (thread: Thread): MenuEntry[] => [
    isPinnedThread(thread)
      ? { id: 'unpin', label: 'Unpin conversation', icon: PinOff, onSelect: () => onPinThread(thread.id, false) }
      : { id: 'pin', label: 'Pin conversation', icon: Pin, onSelect: () => onPinThread(thread.id, true) },
    { kind: 'separator', id: 'manage' },
    { id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => setEditing(thread.id) },
    { id: 'delete', label: 'Delete', icon: Trash2, tone: 'danger', onSelect: () => onDeleteThread(thread.id) },
  ];

  const renameRow = (thread: Thread) => (
    <RenameRow
      title={thread.title}
      onCommit={(next) => {
        setEditing(null);
        if (next.trim() && next.trim() !== thread.title) onRenameThread(thread.id, next.trim());
      }}
      onCancel={() => setEditing(null)}
    />
  );

  // Imported and native unpinned rows share every action, draft preview, and keyboard/menu path.
  const conversationRow = (thread: Thread, source?: ChatImportSource) => {
    const isActive = thread.id === activeThreadId;
    const isWorking = working.has(thread.id);
    return (
      <div key={thread.id} className="group relative">
        {editing === thread.id ? renameRow(thread) : <>
          <button
            onClick={() => onSelectThread(thread.id)}
            onDoubleClick={() => setEditing(thread.id)}
            onContextMenu={openMenu(thread.id)}
            data-thread-row={thread.id}
            data-imported-source={source}
            className={`${rowClass(isActive)} pr-14`}
          >
            <MessageSquare size={14} className={`mt-0.5 shrink-0 ${isWorking || isActive ? 'text-primary' : 'text-ink-3'}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className={`min-w-0 truncate text-[13px] font-medium ${isActive ? 'text-ink' : 'text-ink-2'}`}>{thread.title}</span>
                {isWorking ? (
                  <span className="flex shrink-0 items-center gap-1 text-[10px] text-primary" title="Answering now">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                    Working
                  </span>
                ) : (
                  <span className="shrink-0 text-[10px] text-ink-3">{formatTime(thread.createdAt)}</span>
                )}
              </span>
              <PreviewLine thread={thread} draft={drafts[thread.id]} />
            </span>
          </button>
          <div className="absolute right-1.5 top-2 flex items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
            <button onClick={() => setEditing(thread.id)} aria-label={`Rename ${thread.title}`} title="Rename conversation" className={iconButton}>
              <Pencil size={12} />
            </button>
            <button onClick={() => onDeleteThread(thread.id)} aria-label={`Delete ${thread.title}`} title="Delete conversation"
              className="rounded p-1 text-ink-3 transition hover:bg-surface-3 hover:text-danger">
              <Trash2 size={12} />
            </button>
          </div>
        </>}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 p-3">
      {hiddenSearchMatches && <p className="px-2.5 text-[11px] leading-relaxed text-ink-3">Matching chats in hidden sections are shown while searching.</p>}
      {(visibility.pinned || (!!query && lists.pinned.length > 0)) && <Section title="Pinned">
        {lists.pinned.length === 0 ? (
          <EmptyRow>{query ? 'No matching pins.' : 'Nothing pinned. Right-click a conversation to pin it.'}</EmptyRow>
        ) : (
          lists.pinned.map((row) => {
            const { thread } = row;
            const isActive = thread.id === activeThreadId;

            if (row.kind === 'conversation') {
              // Pinned conversations leave Recent, so this is where one is renamed as well.
              return (
                <div key={`conversation:${thread.id}`} className="relative">
                  {editing === thread.id ? (
                    renameRow(thread)
                  ) : (
                    <>
                      <button
                        onClick={() => onSelectThread(thread.id)}
                        onDoubleClick={() => setEditing(thread.id)}
                        onContextMenu={openMenu(thread.id)}
                        data-thread-row={thread.id}
                        data-pinned="conversation"
                        className={`${rowClass(isActive)} pr-8`}
                      >
                        <Pin size={14} className="mt-0.5 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-[13px] font-medium ${isActive ? 'text-ink' : 'text-ink-2'}`}>
                            {thread.title}
                          </span>
                          <PreviewLine thread={thread} draft={drafts[thread.id]} />
                        </span>
                      </button>
                      <button
                        onClick={() => onPinThread(thread.id, false)}
                        aria-label={`Unpin ${thread.title}`}
                        title="Unpin conversation"
                        className={`absolute right-1.5 top-2 ${iconButton}`}
                      >
                        <PinOff size={12} />
                      </button>
                    </>
                  )}
                </div>
              );
            }

            const { entry } = row;
            return (
              <div key={entry.id} className="relative">
                <button
                  onClick={() => onOpenPinned(entry)}
                  onContextMenu={openMenu(thread.id)}
                  data-thread-row={thread.id}
                  data-pinned="message"
                  title="Pinned message"
                  className={`${rowClass(isActive)} pr-8`}
                >
                  <MessageSquareQuote size={14} className="mt-0.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{thread.title}</span>
                    <span className="block truncate text-[11px] text-ink-3">
                      {entry.sourceName} · {entry.snippet}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => onUnpin(entry.id)}
                  aria-label={`Unpin message in ${thread.title}`}
                  title="Unpin message"
                  className={`absolute right-1.5 top-2 ${iconButton}`}
                >
                  <PinOff size={12} />
                </button>
              </div>
            );
          })
        )}
      </Section>}

      {visibility.projects && <Section title="Projects">
        {projects.map((project) => {
          const isActive = project.id === activeProjectId;
          const count = threads.filter((thread) => thread.projectId === project.id).length;
          return (
            <button key={project.id} onClick={() => onSelectProject(project.id)} className={rowClass(isActive)}>
              <Folder size={14} className={`mt-0.5 shrink-0 ${isActive ? 'text-primary' : 'text-ink-3'}`} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className={`min-w-0 truncate text-[13px] font-medium ${isActive ? 'text-ink' : 'text-ink-2'}`}>
                    {project.name}
                  </span>
                  <span className="shrink-0 rounded-full border border-line bg-surface-3 px-1.5 text-[10px] leading-4 text-ink-3">
                    {count}
                  </span>
                </span>
                <span className="block truncate text-[11px] text-ink-3">{project.description}</span>
              </span>
            </button>
          );
        })}
      </Section>}

      {(['claude', 'codex', 'opencode'] as const).map((source) => {
        const title = source === 'claude' ? 'Claude chats' : source === 'codex' ? 'Codex chats' : 'OpenCode chats';
        const rows = lists.imported[source];
        if (!visibility[`imported-${source}`] && !(query && rows.length > 0)) return null;
        const searchExpanded = !!query && rows.length > 0;
        const expanded = importedSidebarGroupExpanded(importedGroups[source], query, rows.length);
        const contentId = `sidebar-imported-${source}`;
        const toggle = () => {
          if (searchExpanded) return;
          const next = { ...importedGroups, [source]: !importedGroups[source] };
          setImportedGroups(next);
          saveImportedSidebarGroups(next);
        };
        return <section key={source} aria-label={title} data-imported-group={source}>
          <div className="mb-1.5 flex items-center gap-1">
            <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls={contentId}
              aria-label={`Toggle ${title}`} disabled={searchExpanded}
              title={searchExpanded ? 'Matching chats are expanded while searching; your saved preference is unchanged.' : `${expanded ? 'Collapse' : 'Expand'} ${title}`}
              className="flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 py-0.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <span className="rounded-full border border-line bg-surface-3 px-1.5 text-[10px] leading-4" aria-label={`${rows.length} unpinned ${title}`}>{rows.length}</span>
            </button>
            <button type="button" onClick={() => onImportChats?.(source)} disabled={!onImportChats}
              aria-label={`Import ${title}`} title={onImportChats ? `Import ${title}` : 'Chat import is unavailable here'}
              className={`${iconButton} disabled:cursor-not-allowed disabled:opacity-40`}>
              <Import size={13} aria-hidden="true" />
            </button>
          </div>
          <div id={contentId} hidden={!expanded} className={`${expanded ? 'grid' : 'hidden'} grid-cols-1 gap-0.5`}>
            {rows.length > 0 ? rows.map((thread) => conversationRow(thread, source))
              : <EmptyRow>{query ? 'No matching imported conversations.' : `No unpinned ${title} in this project.`}</EmptyRow>}
          </div>
        </section>;
      })}

      {(visibility.recent || (!!query && lists.recent.length > 0)) && <Section title="Recent">
        {lists.recent.length === 0 ? (
          <EmptyRow>{query ? 'No matching conversations.' : 'No recent conversations yet.'}</EmptyRow>
        ) : (
          lists.recent.map((thread) => conversationRow(thread))
        )}
      </Section>}

      {menu && menuThread && (
        <ContextMenu at={menu.at} label={`${menuThread.title} actions`} entries={menuEntries(menuThread)} onClose={closeMenu} />
      )}
    </div>
  );
}
