import { Atom, ChevronDown, ChevronRight, CircleArrowUp, Clock, Flag, GitPullRequest, Mail, MessagesSquare, PanelLeftClose, Plus, Search, Server, Settings, Shield, SlidersHorizontal, Code2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AppPage, Draft, PinnedConversation, Project, Thread } from '../../types';
import Sidebar from '../Sidebar/Sidebar';
import { FileTree } from '../../environment/FileTree';
import { useHubDownloads } from '../hub/presentation';
import { sidebarNotice, useUpdateState } from '../../lib/updates';
import { beginDrag } from '../../plugins/drag';
import { loadSidebarVisibility, SIDEBAR_VISIBILITY_KEY, SIDEBAR_VISIBILITY_EVENT } from '../../lib/sidebarVisibility';
import type { SidebarWorkspace } from '../../lib/sidebarWorkspace';

interface Props {
  onCollapse?: () => void;
  workspace?: SidebarWorkspace;
  onImportChats?: (source: import('../../../../src/api/chatImports').ChatImportSource) => void;
  threads: Thread[];
  projects: Project[];
  pinned: PinnedConversation[];
  activeProjectId: string;
  activeThreadId: string | null;
  search: string;
  page: AppPage;
  botChatEnabled?: boolean;
  onSearchChange: (value: string) => void;
  onSelectThread: (id: string) => void;
  onSelectProject: (id: string) => void;
  onOpenPinned: (entry: PinnedConversation) => void;
  onUnpin: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onRenameThread: (id: string, title: string) => void;
  onPinThread: (id: string, pinned: boolean) => void;
  onNewThread: () => void;
  onChangePage: (page: AppPage) => void;
  /** Opens the update details without restarting or installing from the sidebar. */
  onOpenUpdates?: () => void;
  /** Opens a tool window by id, so a nav row can reveal a panel rather than change the page. */
  onOpenToolWindow: (id: string) => void;
  isToolWindowOpen: (id: string) => boolean;
  /** Unsent text by conversation, so the list can show what was left mid-sentence. */
  drafts: Record<string, Draft>;
  /**
   * The conversations answering right now. Several can be, and a turn keeps running while you
   * read something else, so without this the only chat that looks alive is the one you opened.
   */
  working: ReadonlySet<string>;
}

const rowClass = 'flex items-center gap-2 rounded-md px-2.5 py-2 text-left transition';

/** The sidebar's resting width; users can drag it wider or narrower from its edge. */
const DEFAULT_SIDEBAR_WIDTH = 288; // w-72
/** How far the sidebar may be dragged, so the conversation is never crushed out of view. */
const MIN_SIDEBAR_WIDTH = 208; // w-52
const MAX_SIDEBAR_WIDTH = 480;
/** Storage key for the per-machine sidebar width, so it survives restarts like the view mode does. */
const SIDEBAR_WIDTH_KEY = 'antimatter.sidebarWidth';

const clampSidebarWidth = (width: number) => Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH);

const loadSidebarWidth = (): number => {
  try {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (saved === null) return DEFAULT_SIDEBAR_WIDTH;
    const stored = Number(saved);
    return Number.isFinite(stored) ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
};

const saveSidebarWidth = (width: number) => {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Storage can be unavailable; the width is only a preference, so a missed save is fine.
  }
};

/**
 * The sidebar width, dragged from a handle on its right edge. The width is a per-machine
 * preference: it is restored from storage when the app starts and saved as the drag settles.
 */
function useSidebarWidth() {
  const [width, setWidth] = useState<number>(loadSidebarWidth);
  const startWidth = useRef(0);
  const liveWidth = useRef(0);
  const onResize = useCallback((event: ReactPointerEvent) => {
    startWidth.current = width;
    liveWidth.current = width;
    beginDrag(
      event,
      ({ dx }) => {
        liveWidth.current = clampSidebarWidth(startWidth.current + dx);
        setWidth(liveWidth.current);
      },
      () => saveSidebarWidth(liveWidth.current)
    );
  }, [width]);
  const onResizeBy = useCallback((delta: number) => {
    const next = clampSidebarWidth((liveWidth.current = liveWidth.current || width) + delta);
    liveWidth.current = next;
    setWidth(next);
    saveSidebarWidth(next);
  }, [width]);
  /** Jumps to an absolute width (Home/End on the keyboard). */
  const onResizeTo = useCallback((target: number) => {
    const next = clampSidebarWidth(target);
    liveWidth.current = next;
    setWidth(next);
    saveSidebarWidth(next);
  }, []);
  return { width, onResize, onResizeBy, onResizeTo };
}

/** The divider the sidebar is dragged by; visible on hover, wide enough to grab. */
function ResizeHandle({
  onPointerDown,
  onResizeBy,
  onResizeTo,
}: {
  onPointerDown: (event: ReactPointerEvent) => void;
  /** Keyboard resize: the caller applies the delta to its live width. */
  onResizeBy: (delta: number) => void;
  /** Keyboard jump to an absolute width. */
  onResizeTo: (target: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onResizeBy(-16);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          onResizeBy(16);
        } else if (event.key === 'Home') {
          event.preventDefault();
          onResizeTo(MIN_SIDEBAR_WIDTH);
        } else if (event.key === 'End') {
          event.preventDefault();
          onResizeTo(MAX_SIDEBAR_WIDTH);
        }
      }}
      className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize transition hover:bg-primary/40 focus-visible:bg-primary focus-visible:outline-none"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

export function LeftRail({
  onCollapse,
  search,
  page,
  onSearchChange,
  onNewThread,
  onChangePage,
  onOpenUpdates,
  onOpenToolWindow: _onOpenToolWindow,
  isToolWindowOpen: _isToolWindowOpen,
  botChatEnabled = false,
  ...sidebarProps
}: Props) {
  const pageRow = (target: AppPage) =>
    `${rowClass} ${page === target ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink'}`;
  const pageIcon = (target: AppPage) => (page === target ? 'text-primary' : 'text-ink-3');

  // A download of tens of gigabytes outlives the page that started it, so its progress rides here.
  const downloads = useHubDownloads();
  const update = sidebarNotice(useUpdateState());
  const { width: sidebarWidth, onResize: onSidebarResize, onResizeBy: onSidebarResizeBy, onResizeTo: onSidebarResizeTo } = useSidebarWidth();
  const [visibility, setVisibility] = useState(() => loadSidebarVisibility());
  useEffect(() => {
    const syncVisibility = (event: StorageEvent) => {
      if (event.key === SIDEBAR_VISIBILITY_KEY || event.key === null) setVisibility(loadSidebarVisibility());
    };
    const syncLocal = () => setVisibility(loadSidebarVisibility());
    window.addEventListener('storage', syncVisibility);
    window.addEventListener(SIDEBAR_VISIBILITY_EVENT, syncLocal);
    return () => { window.removeEventListener('storage', syncVisibility); window.removeEventListener(SIDEBAR_VISIBILITY_EVENT, syncLocal); };
  }, []);
  const [localWorkspaceCollapsed, setLocalWorkspaceCollapsed] = useState(false);
  const workspaceCollapsed = sidebarProps.workspace?.state.collapsed.workspace ?? localWorkspaceCollapsed;
  const toggleWorkspace = () => {
    if (sidebarProps.workspace?.ready) void sidebarProps.workspace.update({ kind: 'collapse', section: 'workspace', collapsed: !workspaceCollapsed });
    else if (!sidebarProps.workspace) setLocalWorkspaceCollapsed(!workspaceCollapsed);
  };
  const transferring = downloads.find((record) => record.state === 'downloading');
  const waiting = downloads.filter((record) => record.state === 'queued').length;
  const hubBadge = transferring
    ? `${Math.floor((transferring.bytesDone / Math.max(1, transferring.bytesTotal)) * 100)}%`
    : waiting
      ? `${waiting} queued`
      : null;

  const header = (
    <div className="flex items-center gap-2 border-b border-line p-3">
      <button
        type="button"
        onClick={() => {
          if (page === 'environment') onChangePage('chat');
          else void window.electronAPI.about.open().catch(console.error);
        }}
        title={page === 'environment' ? 'Back to the agent view' : 'About Antimatter'}
        className="group flex w-full cursor-pointer items-center gap-2 rounded-md bg-primary px-3 py-2 text-on-primary ring-1 ring-primary ring-offset-2 ring-offset-surface-2 transition-all duration-300 hover:bg-surface-0 hover:text-primary-strong hover:ring-primary-strong"
      >
        <Atom size={16} strokeWidth={2.5} className="transition-all duration-300" />
        <span className="wordmark text-base transition-all duration-300">Antimatter</span>
      </button>
      {onCollapse && <button type="button" aria-label="Hide sidebar" title="Hide sidebar" onClick={onCollapse} className="shrink-0 rounded p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"><PanelLeftClose size={15} /></button>}
    </div>
  );

  /**
   * In the environment the sidebar is the file tree. It is the same rail — same width, same
   * wordmark, same way back — so switching does not feel like landing in a different application.
   */
  if (page === 'environment') {
    return (
      <aside className="relative flex flex-col border-r border-line bg-surface-2" style={{ width: sidebarWidth }}>
        {header}
        <ResizeHandle
          onPointerDown={onSidebarResize}
          onResizeBy={onSidebarResizeBy}
          onResizeTo={onSidebarResizeTo}
        />
        <button
          type="button"
          onClick={() => onChangePage('chat')}
          className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-left text-xs text-ink-2 transition hover:bg-surface-3/60 hover:text-ink"
        >
          <MessagesSquare size={13} className="text-ink-3" />
          Back to chat
        </button>
        <FileTree />
        <div className="shrink-0 border-t border-line p-3"><button type="button" onClick={() => onChangePage('settings')} className={`${rowClass} w-full text-xs text-ink-2`}><Settings size={14} />Settings</button></div>
      </aside>
    );
  }

  return (
    <aside className="relative flex flex-col border-r border-line bg-surface-2" style={{ width: sidebarWidth }}>
      {header}
      <ResizeHandle
        onPointerDown={onSidebarResize}
        onResizeBy={onSidebarResizeBy}
        onResizeTo={onSidebarResizeTo}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <nav className="border-b border-line p-3">
          <button type="button" aria-expanded={!workspaceCollapsed} aria-controls="sidebar-workspace-navigation" onClick={toggleWorkspace} className="mb-2 flex w-full items-center gap-1 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3">{workspaceCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}Workspace</button>
          <div id="sidebar-workspace-navigation" hidden={workspaceCollapsed} className={workspaceCollapsed ? 'hidden' : 'grid gap-0.5 text-xs'}>
            <button onClick={onNewThread} className={`${rowClass} text-ink hover:bg-surface-3/60`}>
              <Plus size={14} strokeWidth={2.5} className="text-primary" />
              New chat
            </button>
            <button onClick={() => onChangePage('chat')} className={pageRow('chat')}>
              <MessagesSquare size={14} className={pageIcon('chat')} />
              Chats
            </button>
            {botChatEnabled && visibility['bot-chat'] && <button onClick={() => onChangePage('bot-chat')} aria-label="Bot chat" className={pageRow('bot-chat')} title="Public channels across projects on this computer">
              <MessagesSquare size={14} className={pageIcon('bot-chat')} />Bot chat<span className="ml-auto text-[9px] text-primary">Experimental</span>
            </button>}
            {visibility['environment'] && <button
              onClick={() => onChangePage('environment')}
              title="Projects, code, language tools and debugging"
              className={pageRow('environment')}
            >
              <Code2 size={14} className={pageIcon('environment')} />
              Code
            </button>}
            {visibility['scheduled'] && <button onClick={() => onChangePage('scheduled')} className={pageRow('scheduled')}>
              <Clock size={14} className={pageIcon('scheduled')} />Scheduled
            </button>}
            {visibility.cluster && <button type="button" onClick={() => onChangePage('cluster')} className={pageRow('cluster')}><Server size={14} className={pageIcon('cluster')} />Cluster</button>}
            {visibility.features && <button type="button" onClick={() => onChangePage('features')} className={pageRow('features')}><Flag size={14} className={pageIcon('features')} />Features</button>}
            {visibility.security && <button type="button" onClick={() => onChangePage('security')} className={pageRow('security')}><Shield size={14} className={pageIcon('security')} />Security</button>}
            {visibility.comms && <button type="button" onClick={() => onChangePage('comms')} className={pageRow('comms')}><MessagesSquare size={14} className={pageIcon('comms')} />Comms</button>}
            {visibility.email && <button type="button" onClick={() => onChangePage('email')} className={pageRow('email')}><Mail size={14} className={pageIcon('email')} />Email</button>}
            {visibility['pull-requests'] && <button onClick={() => onChangePage('pull-requests')} className={pageRow('pull-requests')}>
              <GitPullRequest size={14} className={pageIcon('pull-requests')} />Pull requests
            </button>}
          </div>

          <div className="relative mt-3">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              type="text"
              value={search}
              data-chat-search
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search conversations"
              className="w-full rounded-md border border-line bg-surface-3 py-2 pl-8 pr-2 text-xs text-ink placeholder:text-ink-3 focus:border-primary/60 focus:outline-none"
            />
          </div>
        </nav>

        <Sidebar search={search} visibility={visibility} {...sidebarProps} />
      </div>

      <div className="shrink-0 border-t border-line p-3">
        {update && (
          // Opens Settings rather than acting: restarting from a sidebar row is too easy to do by accident.
          <button
            onClick={() => onOpenUpdates ? onOpenUpdates() : onChangePage('settings')}
            data-update-notice
            className={`${rowClass} mb-1 w-full text-xs ${
              update.tone === 'primary'
                ? 'bg-primary/10 text-primary hover:bg-primary/15'
                : update.tone === 'danger'
                  ? 'text-danger hover:bg-danger/10'
                  : 'text-ink-2 hover:bg-surface-3/60'
            }`}
          >
            <CircleArrowUp size={14} />
            {update.label}
          </button>
        )}
        <button onClick={() => onChangePage('settings')} className={`${pageRow('settings')} w-full text-xs`}>
          <Settings size={14} className={pageIcon('settings')} />
          Settings
          {hubBadge && <span title="Model downloads" className="ml-auto font-mono text-[10px] text-primary">{hubBadge}</span>}
        </button>
        {visibility['developer'] && <button
          onClick={() => onChangePage('developer')}
          title="Turn behavior and copyable model-testing project prompts"
          className={`${pageRow('developer')} w-full text-xs`}
        >
          <SlidersHorizontal size={14} className={pageIcon('developer')} />
          Developer
        </button>}

      </div>
    </aside>
  );
}
