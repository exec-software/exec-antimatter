import { DetachedShellBridge } from './plugins/detached/DetachedShellBridge';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LeftRail } from './components/layout/LeftRail';
import { PanelLeftOpen } from 'lucide-react';
import { WindowChrome } from './components/layout/WindowChrome';
import { useDesktopHotkeys } from './desktopPreferences';
import { useIdleCompaction } from './lib/useIdleCompaction';
import { flushChatNoteDrafts } from './lib/chatNotes';
import { flushDoomSaves } from './lib/doomSaves';
import { flushFormDrafts } from './lib/formDrafts';
import { flushSecurityReviewDrafts } from './lib/securityReviewDrafts';
import { PensieveLibraryPanel } from './components/settings/PensieveLibraryPanel';
import { ClusterPage } from './components/cluster/ClusterPage';
import { FeaturesPage } from './components/features/FeaturesPage';
import { SecurityPage } from './components/security/SecurityPage';
import { ConnectionsPage, connectionDraftBlockers } from './components/connections/ConnectionsPage';
import { ChatHeader } from './components/layout/ChatHeader';
import { ChatHistory } from './components/chat/ChatHistory';
import { ConversationOverlay } from './components/chat/ConversationOverlay';
import { ConversationUiProvider } from './components/chat/conversationUi';
import { PreviewPanelProvider } from './plugins/preview/context';
import { CODE_REVIEW_SELECTION_EVENT } from './plugins/codeReview/selection';
import { ChatComposer, type ChatComposerHandle } from './components/chat/ChatComposer';
import { HagPreviewNotice } from './components/chat/HagPreviewNotice';
import { HAG_SOURCE_ID } from '../../src/api/hag';
import { hagPreviewHistoryProblem, hagPreviewSubmissionProblem } from './lib/hagPreview';
import { EmptyState } from './components/chat/EmptyState';
import { PendingSteer } from './components/chat/PendingSteer';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ChatCoordinationPanel } from './components/ChatCoordinationPanel';
import { BotChatPage, type PublicBotChatDraft } from './components/botChat/BotChatPage';
import { useBotChatState } from './lib/useBotChat';
import { SourceLoadingOverlay } from './components/status/SourceLoadingOverlay';
import { useSourceReadiness } from './components/status/useSourceReadiness';
import { sourceReadinessBlock } from './lib/sourceReadiness';
import { SettingsPage } from './components/settings/SettingsPage';
import { settingsForPage, type SettingsTarget } from './components/settings/navigation';
import { useSidebarWorkspace } from './lib/sidebarWorkspace';
import { ALL_CHATS_PROJECT, UNGROUPED_PROJECT, sidebarDescendants, sidebarProjectForThread } from '../../src/api/sidebar';
import { SetupWizard } from './components/setup/SetupWizard';
import { HagWelcomeDialog } from './components/setup/HagWelcomeDialog';
import { useHagExperimental } from './lib/useHagExperimental';
import { InferenceDebugOverlay } from './components/developer/InferenceDebugOverlay';
import { ToastHost } from './components/ToastHost';
import { dismissToast, onToastAction, showToast } from './toasts';
import { operationalError, isOperationalPlaceholder, separateOperationalError } from '../../src/api/operationalErrors';
import { ChatDiagnostics } from './components/chat/ChatDiagnostics';
import { announceFinishedTurn } from './notifications';
import {
  DECLINE_PROJECT_ACTION,
  declineProject,
  LEARN_PROJECT_ACTION,
  learnProjectPrompt,
  offerProjectLearning,
} from './projectLearning';
import { loadDebugOverlay, saveDebugOverlay, useInferenceMetrics } from './lib/inferenceMetrics';
import type { AssistantSettings } from '../../src/api/setup';
import type { RemoteDesktopTurnsSnapshot } from '../../src/api/remoteDesktopTurns';
import { DeveloperPage } from './components/developer/DeveloperPage';
import { ImportChatsPage } from './components/imports/ImportChatsPage';
import type { ChatImportSource } from '../../src/api/chatImports';
import { MemoryPage } from './components/memory/MemoryPage';
import { EnvironmentPage } from './environment/EnvironmentPage';
import { actions as environmentActions, dirtyFilePaths } from './environment/store';
import { HubPage } from './components/hub/HubPage';
import { Avatar } from './environment/avatar/Avatar';
import { AtlasView } from './components/views/AtlasView';
import { FlowView } from './components/views/FlowView';
import { CodeView } from './components/views/CodeView';
import { ResearchView } from './components/views/ResearchView';
import { Dock, DropConsole, FloatingLayer, PromptSurface, revealToolWindow, ShellProvider, ToolStripe, useToolWindowLayout } from './plugins';
import { getAppearance, subscribeAppearance } from './appearance';
import type { ModelSelectionRequest, ShellContextValue } from './plugins';
import { createBoundedCheckpoint, type BoundedCheckpoint } from './lib/boundedCheckpoint';
import { conversationPreviews, conversationSubagents, type ConversationPreview } from './lib/conversation';
import { conversationRequestMessages } from './lib/requestMessages';
import { adoptThreadRevisions, mergeHostThread } from './lib/conversationSync';
import {
  beginTurn,
  deliverSteer,
  dropSteer,
  endTurn,
  forget as forgetTurn,
  noteAlive,
  noteContext,
  noteError,
  queueSteer,
  runningThreads,
  runOf,
  turnFor,
  updateStats,
  type LiveTurns,
} from './lib/liveTurns';
import { currentTurns, subscribeTurns, updateTurns } from './lib/liveTurnsStore';
import { reconcileRemoteTurns, remoteTurnForRun, subscribeRemoteTurns } from './lib/remoteDesktopTurns';
import { select as selectTerminal, start as startTerminal } from './plugins/terminal/session';
import { pinThread, restorable, unpinThread } from './lib/pins';
import { restartSnapshotFingerprint, withLiveDraft } from './lib/restartSnapshot';
import { resolveConversationModel } from './lib/modelSelection';
import { followUpSuggestion } from './lib/followUpSuggestion';
import { createVoiceAdapter } from './lib/voiceAdapter';
import { mergeVoiceGuidance, settleRestoredVoiceGuidance } from './lib/conversationVoice';
import { nextVoiceNarration, type VoiceNarrationState } from './voiceNarration';
import { useVoiceSession, VoicePanel } from './voice';
import type { VoiceConfiguration, VoiceGuidance } from '../../src/api/voice';
import { TasksPanel } from './plugins/agents/TasksPanel';
import { PullRequestsPage } from './components/pullRequests/PullRequestsPage';
import { estimateReasoningTokens, useReasoningStream } from './lib/useReasoningStream';
import {
  mergeToolActivity as mergeTranscriptToolActivity,
  settleRestoredToolActivities,
} from './lib/transcript';
import type {
  AccessSettings,
  AppPage,
  Attachment,
  Draft,
  Message,
  ModelChoice,
  Person,
  PinnedConversation,
  Project,
  ProviderConfig,
  StoredConversations,
  Thread,
  ToolActivity,
  ViewMode,
} from './types';

const VIEW_MODES: ViewMode[] = ['transcript', 'atlas', 'research', 'code', 'flow'];
/** Opens the conversation holding a question the model is waiting on. */
const ASK_OPEN_ACTION = 'ask.open';
const VIEW_MODE_KEY = 'antimatter.viewMode';
const PANEL_KEY = 'antimatter.conversationPanel';
/**
 * Below this much room the transcript column beside the panel would be too narrow to read, so the
 * panel waits to be asked for. The window opens at 1200 wide, which leaves about 876.
 */
const PANEL_MIN_AREA = 840;
/** The gap either side of the panel, which the transcript keeps free as well. */
const PANEL_GUTTER = 32;
/** A run opened beside the transcript only pushes it aside while the column stays this wide. */
const MIN_COLUMN_BESIDE_RUN = 520;
/** Where the model choice lived before the main process kept it. Read once, to carry it over. */
const LEGACY_MODEL_KEY = 'antimatter.model';
const CONVERSATION_SAVE_QUIET_MS = 400;
const CONVERSATION_SAVE_MAX_WAIT_MS = 1_500;

/**
 * The model you last used, remembered.
 *
 * Without this the app opens on whatever source happens to be first in the list, which is an
 * arbitrary order — and a source that is merely listed is not a source that is running. Landing
 * on a dead one and having the first message fail is a bad way to start, and it says nothing
 * about the model you actually meant to use.
 *
 * The main process keeps it: localStorage is per origin, so each dev server port and the built app
 * remembered a model of their own. A choice still sitting there is moved over once and removed,
 * unless the main process already has one, which wins.
 */
const takeLegacyModelChoice = (): ModelChoice | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(LEGACY_MODEL_KEY) ?? 'null');
    localStorage.removeItem(LEGACY_MODEL_KEY);
    return stored && typeof stored.providerId === 'string' && typeof stored.modelId === 'string' ? stored : null;
  } catch {
    return null;
  }
};

const saveModelChoice = (providerId: string, modelId: string, workloadId?: string) => {
  window.electronAPI.model.set(providerId, modelId, workloadId).catch((error) => console.error('Could not remember the model:', error));
};

const loadModelChoice = async (): Promise<ModelChoice | null> => {
  try {
    const remembered = await window.electronAPI.model.get();
    const legacy = takeLegacyModelChoice();
    if (remembered || !legacy?.providerId) return remembered;
    saveModelChoice(legacy.providerId, legacy.modelId);
    return legacy;
  } catch (error) {
    // Opening on the first source is a worse start, but a far better one than listing no sources.
    console.error('Could not read the remembered model:', error);
    return null;
  }
};

// The chosen view is a per-machine preference; storage can be unavailable, so fall back quietly.
const loadViewMode = (): ViewMode => {
  try {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    return VIEW_MODES.find((mode) => mode === stored) ?? 'transcript';
  } catch {
    return 'transcript';
  }
};

const loadPanelOpen = (): boolean => {
  try {
    return localStorage.getItem(PANEL_KEY) !== 'closed';
  } catch {
    return true;
  }
};

const createNewThread = (projectId: string, providerId?: string, modelId?: string): Thread => ({
  id: crypto.randomUUID(),
  title: 'New Conversation',
  messages: [],
  projectId,
  createdAt: Date.now(),
  providerId,
  modelId,
  directory: null,
  accessMode: 'ask',
});

export default function App() {
  const [assistant, setAssistant] = useState<AssistantSettings>({ name: 'Antimatter', personality: '' });
  const [showSetup, setShowSetup] = useState(false);
  const [setupResolved, setSetupResolved] = useState(!window.electronAPI.setup);
  const hagExperimental = useHagExperimental();
  const [debugOverlay, setDebugOverlay] = useState(loadDebugOverlay);
  const inferenceHistory = useInferenceMetrics();
  const toggleDebugOverlay = () => setDebugOverlay((shown) => {
    saveDebugOverlay(!shown);
    return !shown;
  });
  useEffect(() => {
    if (!window.electronAPI.setup) return;
    let live = true;
    let changed = false;
    const unsubscribe = window.electronAPI.setup.onChanged?.((state) => {
      changed = true;
      if (live) setAssistant(state.assistant);
    });
    void window.electronAPI.setup.get().then((state) => {
      if (!live) return;
      if (!changed) setAssistant(state.assistant);
      if (!changed) setShowSetup(state.showOnStartup);
      setSetupResolved(true);
    }).catch((error) => console.error('Could not read setup:', error));
    return () => { live = false; unsubscribe?.(); };
  }, []);
  const sidebarWorkspace = useSidebarWorkspace(window.electronAPI.sidebar, window.electronAPI.onSidebarChanged);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [threads, setThreads] = useState<Thread[]>(() => [createNewThread(UNGROUPED_PROJECT)]);
  const [activeThreadId, setActiveThreadId] = useState<string>(threads[0].id);
  /** What has been typed into each conversation and not sent, by thread id. */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  /**
   * False until the stored conversations have been read. Saving before then would write the
   * empty starting state over everything from last time.
   */
  const [hydrated, setHydrated] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string>(ALL_CHATS_PROJECT);
  const newChatProjectId = sidebarWorkspace.state.projects.some((project) => project.id === activeProjectId) ? activeProjectId : UNGROUPED_PROJECT;
  const importProjects = useMemo<Project[]>(() => [{ id: UNGROUPED_PROJECT, name: 'Ungrouped', description: '' }, ...sidebarWorkspace.state.projects], [sidebarWorkspace.state.projects]);
  useEffect(() => {
    if (!sidebarWorkspace.ready) return;
    setActiveProjectId((current) => current === ALL_CHATS_PROJECT || current === UNGROUPED_PROJECT || sidebarWorkspace.state.projects.some((project) => project.id === current) ? current : UNGROUPED_PROJECT);
  }, [sidebarWorkspace.ready, sidebarWorkspace.state.projects]);
  const [pinned, setPinned] = useState<PinnedConversation[]>([]);
  const [threadSearch, setThreadSearch] = useState('');
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [activeModelId, setActiveModelId] = useState('');
  /**
   * What each conversation's turn is doing, keyed by conversation — see lib/liveTurns.
   *
   * One turn per conversation, any number of conversations at once. The main process has always
   * reserved turns this way; holding one `isStreaming` here is what used to disable the composer
   * in every other chat until the running one finished.
   */
  // Module-scoped, so a Fast Refresh of this component cannot drop a turn main is still running.
  const turns = useSyncExternalStore(subscribeTurns, currentTurns, currentTurns);
  const [sessionStartedAt] = useState(() => Date.now());
  const [access, setAccess] = useState<AccessSettings>({ directory: null, mode: 'ask' });
  const [accessErrors, setAccessErrors] = useState<Record<string, string>>({});
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [page, setPage] = useState<AppPage>('chat');
  const { state: publicBotChat } = useBotChatState(window.electronAPI.botChat, true);
  const publicBotChatDrafts = useState<Record<string, PublicBotChatDraft>>({});
  const [importSource, setImportSource] = useState<ChatImportSource>('claude');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget>({ section: 'general' });
  const [settingsReturnPage, setSettingsReturnPage] = useState<AppPage>('chat');
  const [voiceConfiguration, setVoiceConfiguration] = useState<VoiceConfiguration | null>(null);
  const [voiceLoadError, setVoiceLoadError] = useState('');
  const openSettings = useCallback((target?: SettingsTarget) => {
    if (target) setSettingsTarget(target);
    if (page !== 'settings') setSettingsReturnPage(page);
    setPage('settings');
  }, [page]);
  /** When a tool window opens Models, the card choice returns to that tool instead of the chat. */
  const [modelSelection, setModelSelection] = useState<ModelSelectionRequest | null>(null);
  const modelSettingsReturn = useRef<SettingsTarget | null>(null);
  const showModelLibrary = useCallback((request?: ModelSelectionRequest) => {
    modelSettingsReturn.current = page === 'settings' ? settingsTarget : null;
    setModelSelection(request ?? null);
    openSettings({ section: 'models' });
  }, [page, settingsTarget, openSettings]);
  const navigatePage = useCallback((target: AppPage) => {
    setModelSelection(null);
    modelSettingsReturn.current = null;
    const settings = settingsForPage(target);
    if (target === 'settings') openSettings();
    else if (settings) openSettings(settings);
    else setPage(target);
  }, [openSettings]);
  /** The conversation the delete dialog is asking about; null when it is closed. */
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null);
  /** Optimistic boundary for the main-process conversation repository. */
  const [conversationRevision, setConversationRevision] = useState(0);
  /** Who Antimatter is talking to, so the app can use a name it has been told. */
  const [person, setPerson] = useState<Person | null>(null);
  /** The host resolves each conversation independently of the mutable machine default. */
  const [workspaceState, setWorkspaceState] = useState<{
    threadId: string; path: string; confirmed: boolean; available?: boolean; reason?: string;
  } | null>(null);
  const workspaceRequestRef = useRef(0);
  const workspaceThreadRef = useRef(activeThreadId);
  workspaceThreadRef.current = activeThreadId;
  /** The panel beside the transcript: outputs, subagents and sources. A per-machine preference. */
  const [panelOpen, setPanelOpen] = useState(loadPanelOpen);
  const [coordinationOpen, setCoordinationOpen] = useState(false);
  const [coordinationPending, setCoordinationPending] = useState({ threadId: '', count: 0 });
  const updateCoordinationPending = useCallback((threadId: string, count: number) => {
    setCoordinationPending((current) => current.threadId === threadId && current.count === count ? current : { threadId, count });
  }, []);
  /** The subagent whose run is open in that panel's place, if any. */
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null);
  /** The selected resource in the dockable Preview tool panel. */
  const [previewSelection, setPreviewSelection] = useState<{ threadId: string; preview: ConversationPreview } | null>(null);
  // Scope before children render: clearing only in an effect briefly mounts the previous
  // conversation's native page in the new conversation's panel.
  const openPreview = previewSelection?.threadId === activeThreadId ? previewSelection.preview : null;
  const [conversationWidth, setConversationWidth] = useState(0);
  const [restartPreparing, setRestartPreparing] = useState<{ requestId: string; version: string } | null>(null);
  const conversationAreaRef = useRef<HTMLDivElement>(null);
  const appRootRef = useRef<HTMLDivElement>(null);

  const toolWindows = useToolWindowLayout();
  // Whether the prompt sits in the widget band or floats over the conversation.
  const promptDock = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance).promptDock;
  const toolWindowsRef = useRef(toolWindows);
  toolWindowsRef.current = toolWindows;
  const revealPreview = useCallback(() => revealToolWindow(toolWindowsRef.current, 'preview.viewer'), []);
  /**
   * A command shows the console; it does not move it.
   *
   * This floated it, which is how a docked console came out of its anchor on every command a turn
   * ran — see `revealToolWindow`. Whether it is docked, floating, or put away is the person's
   * arrangement, and it survives the turn now.
   */
  const revealTerminal = useCallback(() => revealToolWindow(toolWindowsRef.current, 'terminal.shell'), []);
  useEffect(() => {
    const show = () => revealToolWindow(toolWindowsRef.current, 'code-review.workspace');
    window.addEventListener(CODE_REVIEW_SELECTION_EVENT, show);
    return () => window.removeEventListener(CODE_REVIEW_SELECTION_EVENT, show);
  }, []);

  useEffect(() => window.electronAPI.onTerminalCommand((session) => {
    // Select it either way, so the console already has the session when it is opened; only a
    // command that will prompt for input is allowed to put the console in front of the person.
    if (session.needsInput) revealTerminal();
    void selectTerminal(session.id, { automatic: true }).catch((error) => console.error('Could not show command terminal:', error));
  }), [revealTerminal]);

  const reasoningStream = useReasoningStream();

  const composerRef = useRef<ChatComposerHandle>(null);
  const [hagComposerHeight, setHagComposerHeight] = useState(112);
  const restartPreparingRef = useRef<{ requestId: string; version: string } | null>(null);
  const turnsRef = useRef(turns);
  const pageRef = useRef(page);
  /**
   * Runs the person stopped themselves.
   *
   * A stopped turn settles through the same path as one that ran to the end, and from there the
   * two are indistinguishable. Someone who just pressed Stop was looking at the window, so
   * announcing it to them would be the app telling them what they had done.
   */
  const stoppedRunsRef = useRef(new Set<string>());
  const pendingDispatchRef = useRef(new Map<string, { cancelled: boolean }>());
  const accessUpdateSequenceRef = useRef(new Map<string, number>());
  const conversationSnapshotRef = useRef({ revision: conversationRevision, threads, activeThreadId, pinned, drafts });
  const hydratedRef = useRef(hydrated);
  const conversationCheckpointRef = useRef<BoundedCheckpoint | null>(null);
  const lastConversationSaveRef = useRef<Promise<StoredConversations> | null>(null);
  const latestHostConversationsRef = useRef<StoredConversations | null>(null);
  const remoteTurnsRevisionRef = useRef(-1);
  conversationSnapshotRef.current = { revision: conversationRevision, threads, activeThreadId, pinned, drafts };
  hydratedRef.current = hydrated;
  turnsRef.current = turns;
  pageRef.current = page;

  /**
   * Every change to the turn map goes through here, so the ref leads the state by exactly the
   * changes made since the last render.
   *
   * Without that lead, two submits in the same tick would both read a map with no run in it and
   * both dispatch — which is what the single synchronous response-id ref used to prevent back
   * when there was only one turn to prevent it for. Subscriptions registered once read the ref
   * for the same reason they always did: they must not be torn down and rebuilt per token.
   */
  const changeTurns = useCallback((change: (turns: LiveTurns) => LiveTurns) => {
    turnsRef.current = updateTurns(change);
  }, []);

  // A phone owns its turn in main, including when this renderer was opened after it started.
  // Subscribe before the initial read so a slow read cannot undo a newer lifecycle event.
  const applyRemoteTurns = useCallback((snapshot: RemoteDesktopTurnsSnapshot) => {
    if (snapshot.revision < remoteTurnsRevisionRef.current) return;
    remoteTurnsRevisionRef.current = snapshot.revision;
    const before = turnsRef.current;
    changeTurns((current) => reconcileRemoteTurns(current, snapshot, providers, Date.now()));
    for (const turn of Object.values(before)) {
      if (!turn.remote || !turn.runId || Object.values(turnsRef.current).some((current) => current.runId === turn.runId)) continue;
      reasoningStream.take(turn.remote.responseMessageId);
      stoppedRunsRef.current.delete(turn.runId);
    }
  }, [changeTurns, providers, reasoningStream]);
  useEffect(() => subscribeRemoteTurns({
    snapshot: () => window.electronAPI.chat.remoteTurns(),
    subscribe: (listener) => window.electronAPI.onRemoteTurnsChanged(listener),
  }, applyRemoteTurns, (error) => console.error('Could not read phone-started turns:', error)), [applyRemoteTurns]);

  if (!conversationCheckpointRef.current) {
    conversationCheckpointRef.current = createBoundedCheckpoint(
      () => {
        const base = conversationSnapshotRef.current;
        const snapshot = withLiveDraft(base, base.activeThreadId, composerRef.current?.currentDraft() ?? null);
        const sent = snapshot.threads;
        const saving = window.electronAPI.conversations
          .save(snapshot)
          .then((saved) => {
            const savedRevision = saved.revision ?? 0;
            // Several bounded checkpoints can be in flight at once. Never let an older response
            // move the renderer's optimistic-concurrency base backwards.
            setConversationRevision((current) => Math.max(current, savedRevision));
            // And the per-thread revisions the store assigned to what was just sent, without
            // which the next checkpoint conflicts with this one. See lib/conversationSync.
            setThreads((current) => adoptThreadRevisions(current, sent, saved.threads ?? []));
            // Explicit collaboration checkpoints can run before React renders these revisions.
            const latest = conversationSnapshotRef.current;
            conversationSnapshotRef.current = { ...latest, revision: Math.max(latest.revision, savedRevision),
              threads: adoptThreadRevisions(latest.threads, sent, saved.threads ?? []) };
            return saved;
          });
        lastConversationSaveRef.current = saving;
        void saving.catch((error) => console.error('Could not save conversations:', error));
      },
      { quietMs: CONVERSATION_SAVE_QUIET_MS, maxWaitMs: CONVERSATION_SAVE_MAX_WAIT_MS },
      {
        now: () => performance.now(),
        set: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clear: (timer) => window.clearTimeout(timer),
      }
    );
  }

  const checkpointForCoordination = useCallback(async (threadId: string) => {
    if (!hydratedRef.current) throw new Error('Conversations are still loading. Try again shortly.');
    if (restartPreparingRef.current) throw new Error('Antimatter is preparing to restart.');
    conversationCheckpointRef.current?.cancel();
    // Absorb a pending checkpoint before reading its revision for the explicit write.
    await lastConversationSaveRef.current?.catch(() => undefined);
    const expected = conversationSnapshotRef.current.threads.find((thread) => thread.id === threadId);
    if (!expected) throw new Error('This chat is no longer available.');
    conversationCheckpointRef.current?.flush(true);
    const saved = await lastConversationSaveRef.current;
    const persisted = saved?.threads.find((thread) => thread.id === threadId);
    const latest = conversationSnapshotRef.current.threads.find((thread) => thread.id === threadId);
    if (!persisted || !latest || (persisted.directory ?? null) !== (expected.directory ?? null) || (latest.directory ?? null) !== (expected.directory ?? null)) {
      throw new Error('The chat’s working folder changed while saving. Review it and try again.');
    }
  }, []);

  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const activeThreadProject = activeThread ? sidebarProjectForThread(sidebarWorkspace.state, activeThread) : null;
  useEffect(() => {
    if (!sidebarWorkspace.ready || !activeThreadProject) return;
    setActiveProjectId((current) => current === ALL_CHATS_PROJECT || sidebarDescendants(sidebarWorkspace.state, current).has(activeThreadProject) ? current : activeThreadProject);
  }, [activeThreadId, activeThreadProject, sidebarWorkspace.ready, sidebarWorkspace.state]);
  const currentWorkspaceState = workspaceState?.threadId === activeThreadId ? workspaceState : null;
  const workspace = activeThread?.workspaceBinding?.path ?? activeThread?.directory ?? currentWorkspaceState?.path ?? null;
  const workspaceConfirmed = activeThread?.workspaceBinding?.confirmed ??
    (activeThread?.directory ? true : currentWorkspaceState?.confirmed ?? false);
  const conversationModel = useMemo(
    () => resolveConversationModel(providers, activeProviderId, activeModelId, activeThread),
    [providers, activeProviderId, activeModelId, activeThread?.providerId, activeThread?.modelId]
  );
  const resolvedProvider = conversationModel.provider;
  const selectedModel = conversationModel.model;
  const modelUnavailableReason = conversationModel.unavailableReason;
  const hagHistoryBlockedReason = hagPreviewHistoryProblem(resolvedProvider?.id, activeThread?.messages ?? []);
  // Keep new requests out of a loading source without trapping Stop or model navigation.
  const { readiness, loadingSince } = useSourceReadiness(resolvedProvider?.id);
  const sourceLoading = readiness.state === 'loading' && loadingSince !== null;
  // An installed, app-manageable idle engine is startable: its first turn performs startup.
  // Unreachable remains reserved for sources whose startup cannot be verified or controlled.
  const sourceUnreachable = readiness.state === 'unreachable';
  const sourceBlockedReason = sourceReadinessBlock(readiness);
  const pinnedMessageIds = useMemo(
    () => new Set(pinned.filter((entry) => entry.threadId === activeThreadId).map((entry) => entry.messageId)),
    [pinned, activeThreadId]
  );
  /** The open conversation's turn — idle, running, or settled with its last result still on it. */
  const activeTurn = turnFor(turns, activeThreadId);
  const activeThreadIsStreaming = activeTurn.runId !== null;
  useIdleCompaction(hydrated ? activeThreadId : null, activeThreadIsStreaming);
  const activeInferenceEvents = inferenceHistory[activeTurn.runId ?? activeTurn.remote?.runId ?? [...(activeThread?.messages ?? [])].reverse().find((message) => message.role === 'assistant')?.id ?? ''] ?? [];
  const workingThreads = useMemo(() => new Set(runningThreads(turns)), [turns]);

  /**
   * Update access settings and persist them to the active thread.
   */
  const updateAccess = useCallback((newAccess: AccessSettings) => {
    const threadId = activeThread?.id ?? null;
    const sequence = (accessUpdateSequenceRef.current.get(threadId ?? '') ?? 0) + 1;
    accessUpdateSequenceRef.current.set(threadId ?? '', sequence);
    if (threadId) setAccessErrors((current) => ({ ...current, [threadId]: '' }));
    setAccess(newAccess);
    // A turn already running read its permissions when it was dispatched. Tell it about the
    // change too, or the control does nothing until the turn is abandoned and started again —
    // which is exactly when someone reaches for it.
    const runId = runOf(turnsRef.current, threadId);
    if (runId) void window.electronAPI.chat.setAccess(runId, newAccess.mode).catch((error) => {
      console.error('Could not change running-turn permissions:', error);
      if (!threadId || sequence !== accessUpdateSequenceRef.current.get(threadId)) return;
      // An IPC failure is not evidence that the host rolled back. Keep the saved choice,
      // explicitly mark the live state uncertain, and retain the warning across chat switches.
      setAccessErrors((current) => ({ ...current, [threadId]: 'Could not confirm live permissions. Retry the selection or stop the current turn. Your selection is saved for later turns.' }));
    });
    if (activeThread) {
      setThreads((prev) =>
        prev.map((thread) => {
          if (thread.id !== activeThread.id) return thread;
          return { ...thread, accessMode: newAccess.mode, directory: newAccess.directory,
            ...((thread.directory || null) !== (newAccess.directory || null) ? { workspaceBinding: null } : {}) };
        })
      );
    }
  }, [activeThread]);

  /**
   * Sync access settings with the active thread's saved settings.
   * This ensures that when a conversation is restored, its access settings are used
   * instead of resetting to defaults.
   */
  useEffect(() => {
    if (activeThread) {
      setAccess({
        directory: activeThread.directory ?? null,
        mode: activeThread.accessMode ?? 'ask',
      });
    }
  }, [activeThread?.id, activeThread?.accessMode, activeThread?.directory]);

  /**
   * The host API tool windows read. It is assembled here because this is where the shell's own
   * state lives; a plugin sees what the user is looking at and nothing else.
   */
  const shell = useMemo<ShellContextValue>(
    () => ({
      workspace,
      // Null while the conversation is empty: a panel offering to file "New Conversation" with
      // nothing in it is a trap, not a feature.
      conversation: activeThread?.messages.length
        ? {
            id: activeThread.id,
            title: activeThread.title,
            transcript: () =>
              activeThread.messages
                .filter((message) => message.content.trim())
                .map((message) => `${message.role}: ${message.content}`)
                .join('\n\n'),
          }
        : null,
      sources: { providers, activeProviderId, activeModelId: selectedModel?.id ?? '' },
      selectProvider: (id: string) => handleSelectProvider(id),
      openPage: navigatePage,
      openModelLibrary: showModelLibrary,
      draftReview: (prompt: string, reviewWorkspace?: string) => {
        if (reviewWorkspace && reviewWorkspace !== workspace) {
          const next = { ...createNewThread(newChatProjectId, activeProviderId, activeModelId),
            directory: reviewWorkspace, accessMode: 'read' as const };
          setThreads((current) => [next, ...current]);
          setDrafts((current) => ({ ...current, [next.id]: { text: prompt, attachments: [] } }));
          setActiveThreadId(next.id);
          setPage('chat');
          return;
        }
        const live = composerRef.current?.currentDraft();
        if (live) {
          // The mounted composer owns its current text; its persisted draft is debounced.
          const next = { ...live, text: [live.text, prompt].filter(Boolean).join('\n\n') };
          composerRef.current?.setText(next.text);
          setDrafts((current) => ({ ...current, [activeThreadId]: next }));
        } else {
          setDrafts((current) => {
            const draft = current[activeThreadId] ?? { text: '', attachments: [] };
            return { ...current, [activeThreadId]: { ...draft, text: [draft.text, prompt].filter(Boolean).join('\n\n') } };
          });
        }
        setPage('chat');
      },
    }),
    // selectProvider closes over a handler declared below; it is only ever called from a click,
    // long after this render, so the binding is resolved by then.
    [workspace, access.directory, newChatProjectId, activeModelId, activeThreadId, activeThread, providers, activeProviderId, selectedModel?.id, navigatePage, showModelLibrary]
  );

  const refreshProviders = useCallback(() => {
    Promise.all([window.electronAPI.providers.list(), loadModelChoice()])
      .then(([loaded, remembered]) => {
        setProviders(loaded);
        setActiveProviderId((current) => {
          if (loaded.some((provider) => provider.id === current)) return current;
          // Prefer what was last used over whatever happens to be first in the list.
          const preferred = remembered && loaded.find((provider) => provider.id === remembered.providerId);
          if (preferred) {
            setActiveModelId(preferred.models.some((model) => model.id === remembered.modelId) ? remembered.modelId : '');
            return preferred.id;
          }
          return loaded[0]?.id ?? '';
        });
      })
      .catch(console.error);
  }, []);

  // The main process also owns conversations changed by a paired device. Merge only the named
  // thread so an unrelated local draft or in-flight desktop turn cannot be replaced wholesale.
  useEffect(
    () =>
      window.electronAPI.onConversationsChanged(({ change, stored }) => {
        if ((stored.revision ?? 0) >= (latestHostConversationsRef.current?.revision ?? 0)) {
          latestHostConversationsRef.current = stored;
        }
        setConversationRevision((current) => Math.max(current, stored.revision ?? change.revision));
        if (change.kind === 'import') {
          // Imports are additive. Do not replace a streaming turn, draft, pins, or selection.
          setThreads((current) => {
            const known = new Set(current.map((thread) => thread.id));
            return [...current, ...stored.threads.filter((thread) => !known.has(thread.id))];
          });
          return;
        }
        if (change.kind === 'delete' && change.threadId) {
          setThreads((current) => current.filter((thread) => thread.id !== change.threadId));
          setPinned((current) => current.filter((pin) => pin.threadId !== change.threadId));
          setActiveThreadId((current) => {
            if (current !== change.threadId) return current;
            return stored.threads[0]?.id ?? current;
          });
          return;
        }
        if (change.kind === 'conflict' && !change.threadId) {
          // A whole-store conflict means something was created on another client after this
          // renderer's checkpoint base. Pull in missing/newer host copies without replacing local
          // drafts or unrelated in-flight desktop state.
          setThreads((current) => {
            const authoritative = new Map(stored.threads.map((thread) => [thread.id, thread]));
            const merged = current.map((thread) => {
              const host = authoritative.get(thread.id);
              return host && (host.revision ?? 0) > (thread.revision ?? 0) ? host : thread;
            });
            const known = new Set(current.map((thread) => thread.id));
            for (const thread of stored.threads) {
              if (!known.has(thread.id)) merged.push(thread);
            }
            return merged;
          });
          setPinned(stored.pinned ?? []);
          return;
        }
        if (!change.threadId) return;
        const authoritative = stored.threads.find((thread) => thread.id === change.threadId);
        if (!authoritative) return;
        setThreads((current) => {
          const index = current.findIndex((thread) => thread.id === authoritative.id);
          if (index < 0) return [authoritative, ...current];
          // The host's copy of a turn being streamed here is only ever as new as the last
          // checkpoint, so it may not replace it. Merging costs nothing on the common path,
          // where nothing is streaming and the host copy is taken whole.
          const live = turnFor(turnsRef.current, authoritative.id);
          const merged = mergeHostThread(current[index], authoritative, live.remote ? null : live.runId);
          return current.map((thread, candidate) => (candidate === index ? merged : thread));
        });
        setPinned(stored.pinned ?? []);
      }),
    []
  );

  /**
   * Automatic updates may only close this renderer after its state is durable. Editor buffers are
   * never guessed at or silently saved; they keep the update waiting. Conversation state uses a
   * revisioned host merge because a paired device may be writing at the same time, and is
   * explicitly awaited instead of relying on beforeunload.
  */
  useEffect(() => {
    const releaseRestartHold = (requestId: string) => {
      if (restartPreparingRef.current?.requestId !== requestId) return;
      restartPreparingRef.current = null;
      appRootRef.current?.removeAttribute('inert');
      setRestartPreparing(null);
    };
    const stopPreparing = window.electronAPI.onUpdateRestartReleased(({ requestId }) => {
      releaseRestartHold(requestId);
    });
    const stopRequested = window.electronAPI.onUpdateRestartRequested(({ requestId, version }) => {
      void (async () => {
        const acknowledge = async (blockers: string[]) => {
          const accepted = await window.electronAPI.updates.restartPrepared(requestId, blockers);
          // Main can time out or cancel while a local save is still finishing. Its request-scoped
          // release normally arrives first; this covers a rejected/stale acknowledgement too.
          if (!accepted) releaseRestartHold(requestId);
        };
        const dirty = dirtyFilePaths();
        if (dirty.length) {
          await acknowledge(dirty.map((path) => `Unsaved editor buffer: ${path}`));
          return;
        }
        if (!hydratedRef.current) {
          await acknowledge(['Conversation state is still loading.']);
          return;
        }
        if (restartPreparingRef.current && restartPreparingRef.current.requestId !== requestId) {
          await acknowledge(['The window is already preparing another restart request.']);
          return;
        }

        // Freeze synchronously before the first await. This closes the renderer-side half of the
        // final-check race: pointer and keyboard input cannot change drafts, threads, or settings
        // after the snapshot that main is about to trust.
        const preparing = { requestId, version };
        restartPreparingRef.current = preparing;
        appRootRef.current?.setAttribute('inert', '');
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setRestartPreparing(preparing);

        try {
          const capture = () => {
            const base = conversationSnapshotRef.current;
            const live = composerRef.current?.currentDraft();
            return withLiveDraft(base, base.activeThreadId, live ?? null);
          };

          // One extra pass absorbs a pending React draft update. With the window inert, a second
          // mismatch means non-input renderer state is still moving and main must wait/retry.
          const base = conversationSnapshotRef.current;
          const flushedDraft = (await composerRef.current?.flushDraft()) ?? null;
          let snapshot = withLiveDraft(base, base.activeThreadId, flushedDraft);
          let stable = false;
          for (let pass = 0; pass < 2; pass += 1) {
            await window.electronAPI.conversations.save(snapshot);
            const latest = capture();
            if (restartSnapshotFingerprint(latest) === restartSnapshotFingerprint(snapshot)) {
              stable = true;
              break;
            }
            snapshot = latest;
          }
          const [noteBlockers, gameBlockers] = await Promise.all([flushChatNoteDrafts(), flushDoomSaves()]);
          await acknowledge([...noteBlockers, ...gameBlockers, ...flushFormDrafts(), ...flushSecurityReviewDrafts(), ...connectionDraftBlockers(), ...(stable ? [] : ['Conversation state continued changing while the window prepared to restart.'])]);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await acknowledge([`Could not save conversations before restart: ${message}`]);
        }
      })().catch((error) => {
        // If even the blocker acknowledgement cannot reach main, there will be no guaranteed
        // release event. Never leave the app inert on a broken IPC path.
        releaseRestartHold(requestId);
        console.error('Could not answer the update restart request:', error);
      });
    });
    return () => {
      stopRequested();
      stopPreparing();
      appRootRef.current?.removeAttribute('inert');
    };
  }, []);

  useEffect(() => {
    refreshProviders();
  }, [refreshProviders]);

  // A finished download registered on a source changes its model list from the main process side.
  useEffect(() => window.electronAPI.onProvidersChanged(refreshProviders), [refreshProviders]);

  /** Tool calls report progress by call id; each update lands on the message that asked for it. */
  const mergeToolActivity = useCallback((activity: ToolActivity) => {
    if (remoteTurnForRun(turnsRef.current, activity.requestId)) return;
    setThreads((prev) =>
      prev.map((thread) => {
        if (!thread.messages.some((message) => message.id === activity.requestId)) return thread;

        return {
          ...thread,
          messages: thread.messages.map((message) => {
            if (message.id !== activity.requestId) return message;

            const tools = mergeTranscriptToolActivity(
              message.meta?.tools ?? [],
              activity,
              message.content.length
            );

            return { ...message, meta: { ...(message.meta ?? { createdAt: Date.now() }), tools } };
          }),
        };
      })
    );
  }, []);

  // Filed under the conversation whose run the report names, so reading another chat while a
  // turn finishes does not leave that turn's window report over the wrong transcript.
  useEffect(() => window.electronAPI.onChatContext((report) => changeTurns((current) => noteContext(current, report))), [changeTurns]);

  useEffect(() => window.electronAPI.onChatNotice?.((notice) => {
    showToast({ ...notice, key: `chat-notice:${notice.id}` });
  }), []);

  // Set in Settings, or filled in by a model that was told a name mid-conversation.
  const refreshPerson = useCallback(() => {
    window.electronAPI.user.get().then(setPerson).catch((error) => console.error('Could not read who you are:', error));
  }, []);
  useEffect(refreshPerson, [refreshPerson]);
  useEffect(() => window.electronAPI.onMemoryChanged(refreshPerson), [refreshPerson]);

  // The model took the note up. Say so, then let the bubble go.
  useEffect(
    () =>
      window.electronAPI.onChatSteered(({ id, note }) => {
        changeTurns((current) => deliverSteer(current, id, note));
        window.setTimeout(() => changeTurns((current) => dropSteer(current, id, { note, delivered: true })), 1800);
      }),
    [changeTurns]
  );

  // A delayed response for the previously selected chat cannot retarget the current composer.
  const refreshWorkspace = useCallback(() => {
    if (!hydrated) return;
    const sequence = ++workspaceRequestRef.current;
    const threadId = activeThreadId;
    // Empty/new chats and changed folder selections must exist durably before resolution.
    const ready = activeThread?.workspaceBinding ? Promise.resolve() : checkpointForCoordination(threadId);
    ready.then(() => window.electronAPI.mcp.workspaceState(threadId))
      .then((state) => {
        if (sequence !== workspaceRequestRef.current || workspaceThreadRef.current !== threadId) return;
        setWorkspaceState({ ...state, threadId });
      })
      .catch((error) => {
        if (sequence !== workspaceRequestRef.current || workspaceThreadRef.current !== threadId) return;
        setWorkspaceState({ threadId, path: activeThread?.workspaceBinding?.path ?? activeThread?.directory ?? '',
          confirmed: false, available: false, reason: error instanceof Error ? error.message : String(error) });
      });
  }, [hydrated, activeThreadId, activeThread?.directory, activeThread?.workspaceBinding?.path,
    activeThread?.workspaceBinding?.confirmed, checkpointForCoordination]);

  const chooseChatWorkspace = useCallback(async () => {
    const threadId = activeThreadId;
    await checkpointForCoordination(threadId);
    if (workspaceThreadRef.current !== threadId) return null;
    const selected = await window.electronAPI.workspace.chooseDirectory(threadId);
    if (!selected || workspaceThreadRef.current !== threadId) return null;
    const state = await window.electronAPI.mcp.workspaceState(threadId);
    if (workspaceThreadRef.current !== threadId) return null;
    setWorkspaceState({ ...state, threadId });
    return state.path;
  }, [activeThreadId, checkpointForCoordination]);

  const bindChatWorkspace = useCallback(async (path: string) => {
    const threadId = activeThreadId;
    await checkpointForCoordination(threadId);
    if (workspaceThreadRef.current !== threadId) return null;
    await window.electronAPI.workspace.setDirectory(threadId, path);
    const state = await window.electronAPI.mcp.workspaceState(threadId);
    if (workspaceThreadRef.current !== threadId) return null;
    setWorkspaceState({ ...state, threadId });
    return state.path;
  }, [activeThreadId, checkpointForCoordination]);

  /**
   * Read last session's conversations once, on the way in.
   *
   * An empty thread with nothing typed into it is the one the app makes at startup, and restoring
   * a pile of those is just clutter. An empty thread holding a draft is something else entirely —
   * it is a thought someone left mid-sentence — so that one comes back, as does one someone
   * pinned (see lib/pins.ts).
   */
  useEffect(() => {
    let cancelled = false;
    // Ownership and history are separate IPC reads. Do not mark a live phone tool interrupted
    // just because history arrived first, or let a delayed load erase a newer host event.
    Promise.all([
      window.electronAPI.conversations.load(),
      window.electronAPI.chat.remoteTurns().catch((error) => {
        console.error('Could not restore phone turn ownership:', error);
        return null;
      }),
    ])
      .then(([loaded, remote]) => {
        if (cancelled) return;
        if (remote) applyRemoteTurns(remote);
        const newest = latestHostConversationsRef.current;
        const stored = newest && (newest.revision ?? 0) >= (loaded.revision ?? 0) ? newest : loaded;
        const storedDrafts = stored.drafts ?? {};
        setConversationRevision((current) => Math.max(current, stored.revision ?? 0));
        const restored = (stored.threads ?? []).map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) => {
            const meta = message.meta;
            if (!meta) return message;
            const live = turnFor(turnsRef.current, thread.id);
            if (remoteTurnsRevisionRef.current < 0 || live.remote && live.runId) return message;
            return {
              ...message,
              meta: { ...meta, tools: settleRestoredToolActivities(meta.tools ?? []),
                voiceGuidance: settleRestoredVoiceGuidance(meta.voiceGuidance ?? []) },
            };
          }),
        }));
        const { threads: kept, pinned: keptPins } = restorable(restored, storedDrafts, stored.pinned ?? []);
        if (kept.length) {
          setThreads(kept);
          const chosen = kept.find((thread) => thread.id === stored.activeThreadId) ?? kept[0];
          setActiveThreadId(chosen.id);
        }
        setPinned(keptPins);
        setDrafts(storedDrafts);
      })
      .catch((error) => console.error('Could not read stored conversations:', error))
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Write them back after a quiet beat, but never let continuous token/tool updates defer the
   * checkpoint forever. The bounded debounce writes at most once per burst during quiet editing
   * and at least every max-wait interval while inference keeps changing the transcript.
   */
  useEffect(() => {
    if (!hydrated) return;
    conversationCheckpointRef.current?.schedule();
  }, [hydrated, threads, activeThreadId, pinned, drafts]);

  // A normal reload gets one final best-effort snapshot; a renderer crash still has the bounded
  // periodic checkpoints above, rather than an indefinitely postponed trailing debounce.
  useEffect(() => {
    let flushedForExit = false;
    const flushForExit = () => {
      if (flushedForExit || !hydratedRef.current) return;
      flushedForExit = true;
      conversationCheckpointRef.current?.flush(true);
      void flushChatNoteDrafts();
      void flushDoomSaves();
      flushFormDrafts();
      flushSecurityReviewDrafts();
    };
    window.addEventListener('beforeunload', flushForExit);
    return () => {
      window.removeEventListener('beforeunload', flushForExit);
      flushForExit();
      conversationCheckpointRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    refreshWorkspace();
  }, [refreshWorkspace]);

  // A keepalive from a source, naming the run it belongs to. Any number of runs can be quiet.
  useEffect(
    () =>
      window.electronAPI.onChatAlive((beat) =>
        changeTurns((current) => noteAlive(current, beat))
      ),
    [changeTurns]
  );

  // A turn is holding for its agents. Which turn is in the event; several can be holding at once.
  useEffect(
    () =>
      window.electronAPI.onChatWaiting(({ id, waiting, at }) =>
        changeTurns((current) => updateStats(current, id, (stats) => ({ ...stats, waitingSince: waiting ? at : 0 })))
      ),
    [changeTurns]
  );

  useEffect(() => {
    const stopActivity = window.electronAPI.onToolActivity(mergeToolActivity);
    const stopApproval = window.electronAPI.onToolApproval((request) =>
      mergeToolActivity({ ...request, status: 'pending', awaitingApproval: true })
    );
    return () => {
      stopActivity();
      stopApproval();
    };
  }, [mergeToolActivity]);

  /**
   * A question is waiting somewhere the person is not looking.
   *
   * The card in the transcript is where a question is answered, and this is only how someone
   * finds out there is one — so it is raised exactly when the card is not already in front of
   * them: another conversation, or this one with the window in the background. Raising it while
   * they are reading the very card it points at would be a notice about something visible.
   *
   * Dismissing it costs nothing, which is the rule `src/api/toasts.ts` sets for every toast: the
   * question is still in the transcript, still waiting, and the turn is still held. This is a
   * pointer to it, never the thing that has to be answered.
   */
  useEffect(() => {
    // askId -> the notice showing it, and the conversation to open for it.
    const raised = new Map<string, { toastId: string; threadId?: string }>();
    const retire = (askId: string) => {
      const entry = raised.get(askId);
      if (!entry) return;
      raised.delete(askId);
      dismissToast(entry.toastId);
    };
    const stopWaiting = window.electronAPI.onQuestionWaiting((question) => {
      const onScreen = question.threadId === conversationSnapshotRef.current.activeThreadId && document.hasFocus();
      if (onScreen || !question.questions.length) return;
      const [first] = question.questions;
      const toastId = showToast({
        tone: 'info',
        title: question.questions.length === 1 ? `Question: ${first.header}` : `${question.questions.length} questions waiting`,
        body: first.question,
        // Stays until it is answered or dismissed. A question does not stop waiting because six
        // seconds passed, and a notice that outlives its own subject is the usual way to miss one.
        timeoutMs: null,
        actions: [{ id: ASK_OPEN_ACTION, label: 'Go to it', primary: true }],
      });
      if (toastId) raised.set(question.askId, { toastId, threadId: question.threadId });
    });
    const stopSettled = window.electronAPI.onQuestionSettled(({ askId }) => retire(askId));
    const stopAction = onToastAction(ASK_OPEN_ACTION, (toast) => {
      for (const [askId, entry] of raised) {
        if (entry.toastId !== toast.id) continue;
        raised.delete(askId);
        if (entry.threadId) setActiveThreadId(entry.threadId);
        return;
      }
    });
    return () => {
      stopWaiting();
      stopSettled();
      stopAction();
    };
  }, [setActiveThreadId]);

  /** Explicit agent previews use the side panel without covering the conversation. */
  useEffect(
    () =>
      window.electronAPI.onPreview((item) => {
        // A turn is allowed to keep working while the user reads another conversation. Do not
        // switch the visible preview to a resource from that background turn.
        if (item.threadId && item.threadId !== conversationSnapshotRef.current.activeThreadId) return;
        setPreviewSelection({ threadId: conversationSnapshotRef.current.activeThreadId, preview: {
          id: item.id,
          kind: item.kind,
          target: item.target,
          title: item.title,
          at: item.at,
          ...(item.workspace ? { workspace: item.workspace } : {}),
        } });
        revealPreview();
      }),
    [revealPreview]
  );

  // The main process destroys a native page before hiding to the tray. Clear the React shell as
  // part of the same transition so showing the window again cannot reveal an empty stale pane.
  useEffect(() => window.electronAPI.onPreviewDismissed(() => setPreviewSelection(null)), []);

  // A preview belongs to the conversation that made it; switching away puts it away.
  useEffect(() => setPreviewSelection(null), [activeThreadId]);

  // Selecting a chat is read-only. Its host-owned binding controls tool startup; selecting it
  // must not reconnect the global MCP servers or retarget other chats, including phone turns.

  useEffect(() => {
    return window.electronAPI.onStreamData((data) => {
      const receivedAt = Date.now();
      changeTurns((current) =>
        updateStats(current, data.id, (stats) => ({
          ...stats,
          phase: 'streaming',
          firstTokenAt: stats.firstTokenAt || receivedAt,
          lastTokenAt: receivedAt,
          chunks: stats.chunks + 1,
          chars: stats.chars + data.content.length,
          // Text is arriving: whatever the source was waiting on has finished.
          aliveNote: undefined,
        }))
      );

      // Main persists remote text and publishes authoritative snapshots. Appending its raw
      // delta here too would duplicate text when request and response identities happen to match.
      if (remoteTurnForRun(turnsRef.current, data.id)) return;
      // Route by the response id, not by whichever conversation happens to be open. A turn keeps
      // running in the background when the user reads another chat, and its prose must stay with
      // the same message as its independently delivered tool anchors.
      setThreads((prev) =>
        prev.map((thread) => {
          const messages = thread.messages;
          const targetIndex = messages.findIndex(
            (message) => message.id === data.id && message.role === 'assistant'
          );
          if (targetIndex < 0) return thread;
          const target = messages[targetIndex];
          const updated = {
            ...target,
            content: `${target.content}${data.content}`,
            meta: target.meta && {
              ...target.meta,
              firstTokenAt: target.meta.firstTokenAt ?? receivedAt,
              chunks: (target.meta.chunks ?? 0) + 1,
            },
          };

          return {
            ...thread,
            messages: messages.map((message, index) => (index === targetIndex ? updated : message)),
          };
        })
      );
    });
  }, [changeTurns]);

  // Thinking, which is not the answer and so does not enter the thread. Liveness is already
  // covered: every frame of it is an SSE frame, and those drive onChatAlive above.
  useEffect(
    () => window.electronAPI.onReasoning((data) => {
      const turn = remoteTurnForRun(turnsRef.current, data.id);
      if (turn && !turn.runId) return;
      reasoningStream.append(turn?.remote?.responseMessageId ?? data.id, data.content);
    }),
    [reasoningStream]
  );

  useEffect(() => {
    if (!providers.length) {
      setActiveProviderId('');
      setActiveModelId('');
      return;
    }

    const threadProviderId = activeThread?.providerId;
    const threadModelId = activeThread?.modelId;
    const threadProvider = threadProviderId
      ? providers.find((provider) => provider.id === threadProviderId)
      : undefined;

    const hasActiveProvider = providers.some((provider) => provider.id === activeProviderId);
    const selectedProviderId = threadProvider?.id ?? (hasActiveProvider ? activeProviderId : providers[0].id);

    if (activeProviderId !== selectedProviderId) {
      setActiveProviderId(selectedProviderId);
      return;
    }

    const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
    // Likewise, do not turn a missing saved model into the provider's first model. The library is
    // the explicit place to repair that choice, and it updates the conversation pin atomically.
    if (threadProvider && threadModelId) {
      if (selectedProvider?.models.some((model) => model.id === threadModelId) && activeModelId !== threadModelId) {
        setActiveModelId(threadModelId);
      }
      return;
    }

    const selectedModelId = selectedProvider?.models.some((model) => model.id === activeModelId)
      ? activeModelId
      : selectedProvider?.models[0]?.id ?? '';
    if (activeModelId !== selectedModelId) {
      setActiveModelId(selectedModelId);
    }
  }, [activeThread?.providerId, activeThread?.modelId, providers, activeModelId, activeProviderId]);

  const handleSubmit = (text: string, attachments: Attachment[], inputSource?: 'voice'): boolean => {
    // One turn per conversation. Another conversation already working is not this one's problem
    // — the main process reserves turns the same way, and refuses a second one on this thread.
    if (!activeThreadId || runOf(turnsRef.current, activeThreadId) || restartPreparingRef.current) return false;
    if (sourceBlockedReason) {
      changeTurns((current) => noteError(current, activeThreadId, sourceBlockedReason));
      return false;
    }

    const selectedProvider = resolvedProvider;
    if (!selectedProvider || !selectedModel) {
      changeTurns((current) =>
        noteError(current, activeThreadId, modelUnavailableReason ?? 'Choose an available source and model to continue.')
      );
      return false;
    }

    const sentAt = Date.now();
    // A new turn starts with the saved selection. An old run's warning or late IPC failure
    // must not label this fresh run's permissions uncertain.
    accessUpdateSequenceRef.current.set(activeThreadId, (accessUpdateSequenceRef.current.get(activeThreadId) ?? 0) + 1);
    setAccessErrors((current) => ({ ...current, [activeThreadId]: '' }));
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      ...(attachments.length ? { attachments } : {}),
      meta: { createdAt: sentAt, ...(inputSource ? { inputSource } : {}) },
    };
    const previewProblem = hagPreviewSubmissionProblem(selectedProvider.id, selectedModel.id, activeThread?.messages ?? [], userMessage);
    if (previewProblem) {
      changeTurns((current) => noteError(current, activeThreadId, previewProblem));
      return false;
    }

    const assistantMessageId = crypto.randomUUID();
    const assistantPlaceholder: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      meta: { createdAt: sentAt, modelId: selectedModel.id, sourceName: selectedProvider.name, chunks: 0 },
    };
    const titleSource = text.trim() || attachments[0]?.name || '';

    setThreads((prev) =>
      prev.map((thread) => {
        if (thread.id !== activeThreadId) return thread;
        const nextMessages = [...thread.messages, userMessage, assistantPlaceholder];
        const nextTitle =
          thread.messages.length === 0 && titleSource
            ? `${titleSource.slice(0, 42)}${titleSource.length > 42 ? '…' : ''}`
            : thread.title;
        return {
          ...thread,
          title: nextTitle,
          providerId: selectedProvider.id,
          modelId: selectedModel.id,
          messages: nextMessages,
        };
      })
    );

    const requestMessages = conversationRequestMessages(activeThread?.messages ?? [], userMessage);
    const request = {
      messages: requestMessages,
      model: selectedModel.id,
      providerId: selectedProvider.id,
      requestId: assistantMessageId,
      responseMessageId: assistantMessageId,
      // Names the carbon, so a conversation is one file rather than one per turn.
      threadId: activeThreadId,
      // No maxTokens: the main process resolves it from the model's own profile, so a big
      // model is not capped to a small one's ceiling.
      accessMode: access.mode,
      useTools: selectedProvider.id !== HAG_SOURCE_ID,
    };

    // Reserved before the await below, and the ref leads the state, so a second submit into this
    // same conversation in the same tick is refused by the gate above rather than dispatched.
    changeTurns((current) =>
      beginTurn(current, activeThreadId, { runId: assistantMessageId, source: selectedProvider, startedAt: sentAt })
    );
    const dispatch = { cancelled: false };
    pendingDispatchRef.current.set(assistantMessageId, dispatch);
    void (async () => {
      let failed = false;
      try {
        // Host policy needs the explicit folder even for a brand new or newly moved chat.
        if (window.electronAPI.chatCoordination) await checkpointForCoordination(request.threadId);
        if (dispatch.cancelled) return;
        pendingDispatchRef.current.delete(assistantMessageId);
        await window.electronAPI.chat.startStream(request);
      } catch (err) {
        if (dispatch.cancelled || stoppedRunsRef.current.has(assistantMessageId)) return;
        failed = true;
        console.error('Stream failed:', err);
        const diagnostic = operationalError(err instanceof Error ? err.message : String(err), Date.now());
        showToast({ tone: 'danger', title: 'Could not finish response', body: diagnostic.message,
          key: `chat-notice:${assistantMessageId}` });
        setThreads((prev) => prev.map((thread) => {
          if (thread.id !== activeThreadId) return thread;
          const existing = thread.messages.find((message) => message.id === assistantMessageId);
          const errorMessage: Message = {
            ...assistantPlaceholder, ...existing,
            content: existing?.content ?? '',
            meta: { ...assistantPlaceholder.meta!, ...existing?.meta, operationalError: diagnostic, failed: true },
          };
          return { ...thread, messages: existing
            ? thread.messages.map((message) => message.id === assistantMessageId ? errorMessage : message)
            : [...thread.messages, errorMessage] };
        }));
      } finally {
        pendingDispatchRef.current.delete(assistantMessageId);
        const finishedAt = Date.now();
        // A response owns its conversation's controls until it settles. `endTurn` matches on the
        // run, so an older completion unwinding late cannot release the run that replaced it.
        changeTurns((current) => endTurn(current, assistantMessageId, { failed, finishedAt }));
        // The thinking itself stays out of the thread; how much of it there was does not, or a
        // turn that spent twelve minutes deliberating reads afterwards as twelve minutes of
        // nothing. See MessageMeta.reasoningTokens.
        const thought = estimateReasoningTokens(reasoningStream.take(assistantMessageId));
        setThreads((prev) =>
          prev.map((thread) =>
            thread.messages.some((message) => message.id === assistantMessageId)
              ? {
                  ...thread,
                  messages: thread.messages.map((message) =>
                    message.id === assistantMessageId && message.meta
                      ? {
                          ...message,
                          meta: {
                            ...message.meta,
                            finishedAt,
                            failed,
                            ...(thought > 0 ? { reasoningTokens: thought } : {}),
                          },
                        }
                      : message
                  ),
                }
              : thread
          )
        );
        // Said out loud, for the case where the window is not the thing being looked at. What is
        // announced, and whether anything is, is settled in the main process.
        const snapshot = conversationSnapshotRef.current;
        void announceFinishedTurn({
          threadId: activeThreadId,
          title: snapshot.threads.find((thread) => thread.id === activeThreadId)?.title ?? '',
          failed,
          stopped: stoppedRunsRef.current.delete(assistantMessageId),
          elapsedMs: finishedAt - sentAt,
          onScreen: pageRef.current === 'chat' && snapshot.activeThreadId === activeThreadId,
        });
      }
    })();

    return true;
  };

  const voiceKey = `${activeThreadId}:${page === 'chat' ? 'chat' : 'away'}`;
  const voiceContextRef = useRef(voiceKey);
  voiceContextRef.current = voiceKey;
  const voiceAdapter = useMemo(() => createVoiceAdapter(activeThreadId, window.electronAPI.voice), [voiceKey]);
  const mergeGuidance = useCallback((threadId: string, runId: string, guidance: VoiceGuidance[]) => {
    setThreads((current) => current.map((thread) => thread.id !== threadId ? thread : { ...thread,
      messages: thread.messages.map((message) => message.id !== (remoteTurnForRun(turnsRef.current, runId)?.remote?.responseMessageId ?? runId) ? message : { ...message,
        meta: { createdAt: message.meta?.createdAt ?? thread.createdAt, ...message.meta,
          voiceGuidance: guidance.reduce(mergeVoiceGuidance, message.meta?.voiceGuidance ?? []) } }),
    }));
  }, []);
  useEffect(() => window.electronAPI.voice.onGuidance(({ threadId, runId, guidance }) => {
    mergeGuidance(threadId, runId, guidance);
  }), [mergeGuidance]);
  const voice = useVoiceSession({
    sessionKey: voiceKey, adapter: voiceAdapter, agentWorking: activeThreadIsStreaming,
    onRetireTranscript: (text) => {
      // After the outgoing composer's cleanup flush, append to its draft rather than letting
      // that flush overwrite recovered speech during a simultaneous page/thread change.
      queueMicrotask(() => setDrafts((current) => {
        const existing = current[activeThreadId] ?? { text: '', attachments: [] };
        return { ...current, [activeThreadId]: { ...existing, text: [existing.text, text].filter(Boolean).join('\n\n') } };
      }));
    },
    onTranscript: async (text, utteranceId) => {
      // Thread-bound callbacks plus the main session token fence stale transcriptions.
      if (page !== 'chat' || voiceContextRef.current !== voiceKey || conversationSnapshotRef.current.activeThreadId !== activeThreadId || restartPreparingRef.current) return false;
      const sessionId = voiceAdapter.sessionId();
      if (!sessionId) return false;
      const acknowledged = conversationSnapshotRef.current.threads.find((thread) => thread.id === activeThreadId)?.messages
        .flatMap((message) => message.meta?.voiceGuidance ?? []).find((entry) => entry.id === utteranceId);
      if (acknowledged && acknowledged.status !== 'undelivered') return true;
      // This conversation's own run, if it has one. Another chat working is not a reason to
      // steer into it, nor a reason to refuse to send here.
      const runId = runOf(turnsRef.current, activeThreadId);
      if (runId) {
        const receipt = await window.electronAPI.voice.guide(sessionId, runId, utteranceId, text);
        if (receipt) { mergeGuidance(activeThreadId, runId, [receipt]); return true; }
        // A run may finish while IPC is in flight. Retain the transcript if its controls
        // have not settled yet; the user can retry without losing their words.
        if (runOf(turnsRef.current, activeThreadId)) return false;
      }
      if (voiceContextRef.current !== voiceKey || voiceAdapter.sessionId() !== sessionId) return false;
      return handleSubmit(text, [], 'voice');
    },
  });
  const voiceSessionId = voiceAdapter.sessionId();
  const loadVoice = useCallback(() => {
    setVoiceLoadError('');
    void window.electronAPI.voice.get().then((config) => {
      setVoiceConfiguration(config);
    }, (error) => setVoiceLoadError(String(error.message ?? error)));
  }, []);
  const openVoice = useCallback(() => { setVoiceOpen(true); setPage('chat'); loadVoice(); }, [loadVoice]);
  useEffect(() => window.electronAPI.voice.onCommand((command) => {
    if (command === 'open') openVoice();
    else if (command === 'stop') voice.stop();
    else if (command === 'toggleMute') voice.setMuted(!voice.state.muted);
    else if (command === 'interrupt') voice.interruptPlayback();
  }), [openVoice, voice.stop, voice.setMuted, voice.interruptPlayback, voice.state.muted]);
  useEffect(() => {
    const sessionId = voiceAdapter.sessionId();
    if (!sessionId || !voice.state.active) return;
    void window.electronAPI.voice.update(sessionId, {
      phase: voice.state.phase === 'off' ? 'idle' : voice.state.phase === 'working' ? 'listening' : voice.state.phase,
      muted: voice.state.muted, speaking: voice.state.speaking, error: voice.state.error,
    }).catch(() => voice.stop());
  }, [voiceAdapter, voice.state.active, voice.state.phase, voice.state.muted, voice.state.speaking, voice.state.error, voice.stop]);

  const narration = useRef<{ sessionId: string | null; states: Map<string, VoiceNarrationState> }>({ sessionId: null, states: new Map() });
  useEffect(() => {
    const sessionId = voiceAdapter.sessionId();
    if (!sessionId || !voice.state.active) { narration.current = { sessionId: null, states: new Map() }; return; }
    if (narration.current.sessionId !== sessionId) {
      // Opening voice never reads old chat aloud. For an in-flight turn, only future text is eligible.
      narration.current = { sessionId, states: new Map((activeThread?.messages ?? []).filter((message) => message.role === 'assistant').map((message) => [message.id, {
        messageId: message.id, source: message.content, consumedOffset: message.content.length,
        commentaryCount: 0, spoken: [], flushCount: 0, finalEmitted: message.id !== (activeTurn.remote?.responseMessageId ?? activeTurn.runId), suppressed: false,
      }])) };
    }
    if (!voiceConfiguration?.settings.speechEnabled) return;
    for (const message of activeThread?.messages ?? []) {
      if (message.role !== 'assistant') continue;
      const result = nextVoiceNarration(narration.current.states.get(message.id), {
        messageId: message.id, role: message.role, content: message.content,
        streaming: !!activeTurn.runId && message.id === (activeTurn.remote?.responseMessageId ?? activeTurn.runId), failed: message.meta?.failed, tools: message.meta?.tools,
      });
      narration.current.states.set(message.id, result.state);
      for (const utterance of result.utterances) voice.speak(utterance.text, utterance.id);
    }
  }, [activeThread?.messages, voice.state.active, voice.state.phase, voiceSessionId, voiceAdapter, voiceConfiguration?.settings.speechEnabled, voice.speak]);

  /**
   * Renames a conversation. The title is otherwise derived from the first message, which is a
   * reasonable guess and a poor name once the conversation has gone somewhere else.
   */
  const handleRenameThread = (threadId: string, title: string) => {
    setThreads((prev) => prev.map((thread) => (thread.id === threadId ? { ...thread, title } : thread)));
  };

  /** Queues a note for this conversation's turn, to land when its model is between things. */
  const handleSteer = (text: string) => {
    const runId = runOf(turnsRef.current, activeThreadId);
    // No run means the turn ended between the keystroke and the submit; send it as a message.
    if (!runId) {
      handleSubmit(text, []);
      return;
    }
    changeTurns((current) => queueSteer(current, runId, text));
    window.electronAPI.chat.steer(runId, text, false).catch(console.error);
  };

  const handleSteerNow = () => {
    const pending = activeTurn.steer;
    if (!pending) return;
    window.electronAPI.chat.steer(pending.runId, pending.note, true).catch(console.error);
  };

  const handleCancelSteer = () => {
    const pending = activeTurn.steer;
    if (!pending) return;
    window.electronAPI.chat.unsteer(pending.runId).catch(console.error);
    changeTurns((current) => dropSteer(current, pending.runId));
  };

  /** Stops this conversation's turn. What it wrote stays; the main process closes the stream. */
  const handleStopTurn = () => {
    const runId = runOf(turnsRef.current, activeThreadId);
    if (!runId) return;
    // Before either path below settles the turn, so its `finally` sees that this was deliberate.
    stoppedRunsRef.current.add(runId);
    const pending = pendingDispatchRef.current.get(runId);
    if (pending) {
      pending.cancelled = true;
      changeTurns((current) => endTurn(current, runId, { failed: false, finishedAt: Date.now() }));
      return;
    }
    window.electronAPI.chat.cancel(runId).catch(console.error);
  };

  const handleNewThread = () => {
    const next = createNewThread(newChatProjectId, activeProviderId, activeModelId);
    setThreads((prev) => [next, ...prev]);
    setActiveThreadId(next.id);
    setPage('chat');
    // Two empty conversations look identical, so opening one has to put the cursor where the
    // typing goes. Deferred a frame: the composer may have just been mounted by setPage.
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  useDesktopHotkeys({
    newChat: handleNewThread,
    searchChats: () => {
      setSidebarOpen(true);
      if (page === 'environment') setPage('chat');
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-chat-search]')?.focus());
    },
    settings: () => openSettings(),
    toggleSidebar: () => setSidebarOpen((visible) => !visible),
  });

  // A review or skill action drafts its own message; it never overwrites an existing draft or sends.
  const composeNewDraft = (text: string, readOnly = false) => {
    const next = { ...createNewThread(newChatProjectId, activeProviderId, activeModelId),
      directory: workspaceConfirmed ? workspace : null, accessMode: readOnly ? 'read' as const : access.mode };
    setThreads((previous) => [next, ...previous]);
    setDrafts((previous) => ({ ...previous, [next.id]: { text, attachments: [] } }));
    setActiveThreadId(next.id);
    setPage('chat');
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleSelectModel = (providerId: string, modelId: string, workloadId?: string) => {
    setActiveProviderId(providerId);
    setActiveModelId(modelId);
    // A bare model selection clears any launched workload, so the model's default applies
    // rather than a workload left over from a different launch.
    saveModelChoice(providerId, modelId, workloadId);
    changeTurns((current) => noteError(current, activeThreadId, ''));
    // The open conversation follows the picker, so its next message uses this model.
    setThreads((prev) =>
      prev.map((thread) => (thread.id === activeThreadId ? { ...thread, providerId, modelId } : thread))
    );
  };

  const handleSelectProvider = (providerId: string) => {
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) return;
    handleSelectModel(providerId, provider.models[0]?.id ?? '');
  };

  const handleChangeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
  };

  const handleSelectThread = (threadId: string) => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (thread) setActiveProjectId((current) => current === ALL_CHATS_PROJECT || sidebarDescendants(sidebarWorkspace.state, current).has(sidebarProjectForThread(sidebarWorkspace.state, thread)) ? current : sidebarProjectForThread(sidebarWorkspace.state, thread));
    setActiveThreadId(threadId);
    setOpenSubagentId(null);
    setPage('chat');
  };

  const handleTogglePanel = () => {
    setPanelOpen((open) => {
      try {
        localStorage.setItem(PANEL_KEY, open ? 'closed' : 'open');
      } catch {
        // Storage unavailable: the choice lasts for this session only.
      }
      return !open;
    });
    setOpenSubagentId(null);
  };

  // How much room the conversation has decides whether the panel fits beside it.
  useEffect(() => {
    const area = conversationAreaRef.current;
    if (!area || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setConversationWidth(entry.contentRect.width));
    observer.observe(area);
    return () => observer.disconnect();
  }, [page]);

  const handleSelectProject = (projectId: string) => {
    setActiveProjectId(projectId);
    setPage('chat');
    const scope = sidebarDescendants(sidebarWorkspace.state, projectId);
    const contains = (thread: Thread) => projectId === ALL_CHATS_PROJECT || scope.has(sidebarProjectForThread(sidebarWorkspace.state, thread));
    if (activeThread && contains(activeThread)) return;
    const latest = threads.filter(contains).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest) { setActiveThreadId(latest.id); setOpenSubagentId(null); return; }
    const destination = sidebarWorkspace.state.projects.some((project) => project.id === projectId) ? projectId : UNGROUPED_PROJECT;
    const next = createNewThread(destination, activeProviderId, activeModelId);
    setThreads((previous) => [next, ...previous]);
    setActiveThreadId(next.id);
    setOpenSubagentId(null);
  };

  /**
   * Deleting takes the conversation and anything pinned out of it. The active conversation is
   * replaced rather than left empty — with the most recent one in the same project, or a fresh
   * one, because the chat view always has a thread.
   */
  const handleConfirmDelete = async () => {
    const doomed = pendingDelete;
    setPendingDelete(null);
    if (!doomed) return;
    if (runOf(turnsRef.current, doomed.id)) {
      // Keep the row which owns the stream and its approval controls alive. Deleting it while
      // main is still executing would make later text and tool events invisible. Another
      // conversation's turn is no obstacle: this asks only about the one being deleted.
      setActiveThreadId(doomed.id);
      setActiveProjectId(sidebarProjectForThread(sidebarWorkspace.state, doomed));
      changeTurns((current) => noteError(current, doomed.id, 'Stop the active turn before deleting this conversation.'));
      setPage('chat');
      return;
    }

    // This cannot wait for the 400 ms conversation-save debounce: a just-created thread may not
    // exist in the previous disk snapshot, so diff-based cleanup alone cannot see its deletion.
    try {
      await window.electronAPI.conversations.removeTranscript(doomed.id);
    } catch (error) {
      // Main owns the authoritative live-turn check. This also covers a replacement renderer,
      // which cannot reconstruct the response id belonging to the page that just reloaded.
      setActiveThreadId(doomed.id);
      setActiveProjectId(sidebarProjectForThread(sidebarWorkspace.state, doomed));
      changeTurns((current) =>
        noteError(current, doomed.id, error instanceof Error ? error.message : 'Stop the active turn before deleting this conversation.')
      );
      setPage('chat');
      return;
    }

    changeTurns((current) => forgetTurn(current, doomed.id));
    setPinned((prev) => prev.filter((entry) => entry.threadId !== doomed.id));
    setThreads((prev) => {
      const remaining = prev.filter((thread) => thread.id !== doomed.id);
      if (doomed.id !== activeThreadId) return remaining;

      const successor = remaining
        .filter((thread) => sidebarProjectForThread(sidebarWorkspace.state, thread) === sidebarProjectForThread(sidebarWorkspace.state, doomed))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (successor) {
        setActiveThreadId(successor.id);
        return remaining;
      }

      const replacement = createNewThread(sidebarProjectForThread(sidebarWorkspace.state, doomed), activeProviderId, activeModelId);
      setActiveThreadId(replacement.id);
      return [replacement, ...remaining];
    });
  };

  const handleUnpin = (entryId: string) => {
    setPinned((prev) => prev.filter((entry) => entry.id !== entryId));
  };

  /**
   * Pins or unpins a whole conversation. It is a flag on the thread, so it is saved with the
   * thread, goes when the thread goes, and leaves the thread's pinned messages alone either way.
   */
  const handlePinThread = (threadId: string, pin: boolean) => {
    setThreads((prev) => (pin ? pinThread(prev, threadId, Date.now()) : unpinThread(prev, threadId)));
  };

  const handleTogglePin = (message: Message) => {
    if (!activeThread) return;

    const existing = pinned.find((entry) => entry.threadId === activeThread.id && entry.messageId === message.id);
    if (existing) {
      handleUnpin(existing.id);
      return;
    }

    const entry: PinnedConversation = {
      id: crypto.randomUUID(),
      threadId: activeThread.id,
      messageId: message.id,
      snippet: (message.content || (message.attachments ?? []).map((file) => file.name).join(', ')).slice(0, 120),
      sourceName: resolvedProvider?.name ?? 'Unknown source',
      createdAt: Date.now(),
    };
    setPinned((prev) => [entry, ...prev]);
  };

  const handleOpenPinned = (entry: PinnedConversation) => {
    const thread = threads.find((candidate) => candidate.id === entry.threadId);
    if (!thread) return;
    handleSelectThread(thread.id);
  };

  /**
   * Records a draft against the conversation it was typed into.
   *
   * Stable, and it returns the previous state untouched when nothing changed. Neither is a
   * nicety: an inline handler gets a new identity on every render, which restarted the
   * composer's debounce before it could ever fire, and a fresh drafts object every 250ms
   * restarted the save timer just as often — so nothing was written at all.
   *
   * The thread id comes from the composer rather than from state here, because at the moment a
   * draft is flushed on the way out, the active conversation is already the next one.
   */
  /**
   * The offer to learn the current project, and what its two answers do.
   *
   * Asked once the memory state is known rather than on mount, because "has this project any
   * notes" is the whole question and the answer arrives over IPC. Re-asked when memory changes,
   * so recording the first note retires the offer rather than leaving it on screen.
   *
   * `Learn this project` fills the composer and focuses it; it deliberately does not send. On
   * this box a dense 123B holds the only slot for minutes, and that is not something a
   * dismissible notice should start on its own.
   */
  useEffect(() => {
    const dispose = [
      onToastAction(LEARN_PROJECT_ACTION, () => {
        void window.electronAPI.memory.state().then((state) => {
          composerRef.current?.setText(learnProjectPrompt(state.current));
          composerRef.current?.focus();
        }).catch(() => undefined);
      }),
      onToastAction(DECLINE_PROJECT_ACTION, () => {
        void window.electronAPI.memory.state()
          .then((state) => declineProject(state.current))
          .catch(() => undefined);
      }),
    ];
    const check = () => {
      void window.electronAPI.memory.state().then((state) => offerProjectLearning({
        current: state.current,
        notes: state.project.notes.length,
        instructions: state.project.instructions.length,
        memoryEnabled: state.settings.enabled,
      // A project whose knowledge cannot be read is not a project to nag about.
      })).catch(() => undefined);
    };
    check();
    const unsubscribe = window.electronAPI.onMemoryChanged(check);
    return () => { for (const off of dispose) off(); unsubscribe(); };
  }, []);

  /**
   * A clicked desktop notification opens the conversation it was about.
   *
   * Main has already brought the window forward by the time this arrives; all that is left is to
   * point it at the right chat. A conversation that has since been deleted is ignored rather than
   * selected, which would leave the window on an id with nothing behind it.
   */
  useEffect(() => window.electronAPI.notifications.onActivate(({ threadId }) => {
    if (!conversationSnapshotRef.current.threads.some((thread) => thread.id === threadId)) return;
    setActiveThreadId(threadId);
    setPage('chat');
  }), []);

  const handleDraftChange = useCallback((threadId: string, draft: Draft) => {
    setDrafts((prev) => {
      const existing = prev[threadId];
      if (!draft.text && draft.attachments.length === 0) {
        if (!existing) return prev;
        const { [threadId]: _removed, ...rest } = prev;
        return rest;
      }
      if (existing && existing.text === draft.text && existing.attachments === draft.attachments) return prev;
      return { ...prev, [threadId]: draft };
    });
  }, []);

  const emptyState = !activeThread || activeThread.messages.length === 0;
  const panelFits = conversationWidth >= PANEL_MIN_AREA;
  const panelShown = viewMode === 'transcript' && !emptyState && panelOpen && panelFits;
  const panelWidth = conversationWidth >= 1000 ? 280 : 256;
  const sheetWidth = conversationWidth >= 1100 ? 420 : 360;
  const sheetBeside = conversationWidth - sheetWidth - PANEL_GUTTER >= MIN_COLUMN_BESIDE_RUN;
  // The transcript makes room for whatever floats beside it, unless that would crush it; then a
  // run someone opened lies over the transcript until it is closed.
  const insetRight = !panelShown
    ? 0
    : openSubagentId && sheetBeside
      ? sheetWidth + PANEL_GUTTER
      : panelWidth + PANEL_GUTTER;
  const openSubagent = openSubagentId && activeThread
    ? conversationSubagents(activeThread.messages).find((entry) => entry.taskId === openSubagentId) ?? null
    : null;
  const waitingOnAgents = activeThreadIsStreaming && activeTurn.stats.waitingSince > 0;
  const showSubagent = useCallback((taskId: string) => {
    setOpenSubagentId(taskId);
  }, []);
  const showPreview = useCallback((preview: { kind: 'image' | 'page'; target: string; title: string; workspace?: string }) => {
    // A screenshot commonly overwrites the same path. Give each explicit open a new identity so
    // clicking it again fetches the new pixels instead of preserving an older component state.
    setPreviewSelection({ threadId: activeThreadId, preview: { id: crypto.randomUUID(), at: Date.now(), ...preview } });
    revealPreview();
  }, [activeThreadId, revealPreview]);
  const previewItems = useMemo(() => conversationPreviews(activeThread?.messages ?? []), [activeThread?.messages]);
  const showHagWelcome = setupResolved && hydrated && !!hagExperimental.state?.showWelcome
    && !showSetup && !pendingDelete && !restartPreparing && !sourceLoading
    && !voiceConfiguration?.state.active && !Object.values(turns).some((turn) => turn.runId !== null);
  const previewPanel = useMemo(() => ({
    conversationId: activeThreadId,
    selected: openPreview,
    previews: previewItems,
    workspace,
    onSelect: (preview: ConversationPreview) => setPreviewSelection({ threadId: activeThreadId, preview }),
    onClear: () => setPreviewSelection(null),
    suspended: !!restartPreparing || !!pendingDelete || showSetup || showHagWelcome,
  }), [activeThreadId, openPreview, previewItems, activeThread?.directory, workspace, restartPreparing, pendingDelete, showSetup, showHagWelcome]);
  const conversationUi = useMemo(
    () => ({
      assistantName: assistant.name,
      openSubagent: showSubagent,
      openPreview: showPreview,
      waitingOnAgents,
      activeWorkspace: workspace,
      reasoning: reasoningStream.read,
      importedHistory: !!activeThread?.importedFrom,
    }),
    [assistant.name, showPreview, showSubagent, waitingOnAgents, activeThread?.directory, activeThread?.importedFrom, workspace, reasoningStream.read]
  );

  const renderConversation = (thread: Thread) => {
    const messages = thread.messages.map(separateOperationalError).filter((message) =>
      !isOperationalPlaceholder(message) || !!message.meta?.tools?.length || !!message.attachments?.length || !!message.meta?.voiceGuidance?.length);
    const shared = { messages, isStreaming: activeThreadIsStreaming, pinnedMessageIds };
    switch (viewMode) {
      case 'atlas':
        return <AtlasView key={thread.id} {...shared} onTogglePin={handleTogglePin} />;
      case 'research':
        return <ResearchView key={thread.id} {...shared} />;
      case 'code':
        return <CodeView key={thread.id} messages={messages} />;
      case 'flow':
        return <FlowView key={thread.id} {...shared} onTogglePin={handleTogglePin} />;
      default:
        return (
          <ChatHistory
            key={thread.id}
            {...shared}
            onTogglePin={handleTogglePin}
            onEditMessage={(message) => composerRef.current?.setText(message.content)}
            insetRight={insetRight}
          />
        );
    }
  };

  return (
    <ShellProvider value={shell}>
      <DetachedShellBridge />
      <ConversationUiProvider value={conversationUi}>
      <PreviewPanelProvider value={previewPanel}>
      <div
        ref={appRootRef}
        className="relative flex h-screen w-screen flex-col overflow-hidden bg-surface text-ink"
        aria-busy={restartPreparing ? true : undefined}
      >
        <WindowChrome />
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {!sidebarOpen && <aside className="shrink-0 border-r border-line bg-surface-2 p-1">
          <button type="button" className="rounded p-1.5 text-ink-2 hover:bg-surface-3" aria-label="Show sidebar" title="Show sidebar" onClick={() => setSidebarOpen(true)}><PanelLeftOpen size={16} /></button>
        </aside>}
        <div className={sidebarOpen ? 'flex shrink-0' : 'hidden'}>
        <LeftRail
          onCollapse={() => setSidebarOpen(false)}
          threads={threads}
          workspace={sidebarWorkspace}
          projects={sidebarWorkspace.state.projects}
          pinned={pinned}
          activeProjectId={activeProjectId}
          activeThreadId={activeThreadId}
          search={threadSearch}
          page={page}
          botChatEnabled={!!publicBotChat?.enabled}
          onSearchChange={setThreadSearch}
          onSelectThread={handleSelectThread}
          onSelectProject={handleSelectProject}
          onOpenPinned={handleOpenPinned}
          onUnpin={handleUnpin}
          onDeleteThread={(id) => setPendingDelete(threads.find((thread) => thread.id === id) ?? null)}
          onRenameThread={handleRenameThread}
          onPinThread={handlePinThread}
          onNewThread={handleNewThread}
          onChangePage={navigatePage}
          onOpenToolWindow={toolWindows.toggle}
          isToolWindowOpen={toolWindows.isOpen}
          drafts={drafts}
          working={workingThreads}
          onOpenUpdates={() => openSettings({ section: 'application' })}
          onImportChats={(source) => { setImportSource(source); setPage('imports'); }}
        />
        </div>

        {/* Tool windows dock around the main area: left and right beside it, bottom beneath both. */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1">
            <Dock anchor="left" layout={toolWindows} />

            <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
              {/* Drops over the conversation rather than shortening it. Ctrl+` toggles it. */}
              <DropConsole layout={toolWindows} />

              {page === 'settings' ? (
                <SettingsPage
                  sources={providers}
                  target={settingsTarget}
                  onNavigate={(target) => { setModelSelection(null); modelSettingsReturn.current = null; setSettingsTarget(target); }}
                  onSourcesChanged={refreshProviders}
                  onClose={() => {
                    setModelSelection(null);
                    if (modelSettingsReturn.current) { setSettingsTarget(modelSettingsReturn.current); modelSettingsReturn.current = null; }
                    else setPage(settingsReturnPage);
                  }}
                  onOpenMemory={() => openSettings({ section: 'memory' })}
                  onOpenModels={() => showModelLibrary()}
                  workspacePath={workspace}
                  botChatEnabled={!!publicBotChat?.enabled}
                  onUseSkill={(name) => composeNewDraft(`$${name} `)}
                  content={{
                    memory: <div className="space-y-6"><PensieveLibraryPanel workspace={workspace} /><MemoryPage embedded onClose={() => setPage('chat')} /></div>,
                    models: <HubPage embedded providers={providers}
                      providerId={modelSelection ? modelSelection.providerId ?? '' : resolvedProvider?.id ?? ''}
                      modelId={modelSelection ? modelSelection.modelId ?? '' : selectedModel?.id ?? ''}
                      selection={modelSelection ?? undefined} onClose={() => setPage('chat')}
                      onOpenSettings={(target) => openSettings(target ?? { section: 'models', detail: 'sources' })}
                      onOpenSetup={() => setShowSetup(true)}
                      onUseModel={(providerId, modelId, workloadId) => {
                        if (modelSelection) modelSelection.onSelect(providerId, modelId);
                        else handleSelectModel(providerId, modelId, workloadId);
                        setModelSelection(null);
                        if (modelSettingsReturn.current) setSettingsTarget(modelSettingsReturn.current);
                        else setPage('chat');
                        modelSettingsReturn.current = null;
                      }} />,
                  }}
                  onOpenSetup={() => setShowSetup(true)}
                  onOpenBotChat={() => setPage('bot-chat')}
                  onVoiceConfigurationChanged={setVoiceConfiguration}
                />
              ) : page === 'bot-chat' ? (
                <BotChatPage draftState={publicBotChatDrafts} onClose={() => setPage('chat')} onOpenSettings={() => openSettings({ section: 'experimental' })}
                  onOpenThread={(id) => { if (!threads.some((thread) => thread.id === id)) return false; handleSelectThread(id); return true; }} />
              ) : page === 'comms' || page === 'email' ? (
                <ConnectionsPage key={page} api={window.electronAPI.connections} plugin={page} threadId={activeThreadId} workspace={workspace} onClose={() => setPage('chat')} />
              ) : page === 'security' ? (
                <SecurityPage api={window.electronAPI.security} threadId={activeThreadId} workspace={workspace}
                  onClose={() => setPage('chat')} onOpenFile={(path, line) => {
                    void environmentActions.open(workspace, activeThreadId, activeThread?.title).then((opened) => {
                      if (opened) { setPage('environment'); void environmentActions.reveal(path, line); }
                    });
                  }} />
              ) : page === 'features' ? (
                <FeaturesPage api={window.electronAPI.features} onClose={() => setPage('chat')} />
              ) : page === 'cluster' ? (
                <ClusterPage api={window.electronAPI.cluster} onClose={() => setPage('chat')} onOpenPairing={() => openSettings({ section: 'models', detail: 'nodes' })} />
              ) : page === 'developer' ? (
                <DeveloperPage onClose={() => setPage('chat')} />
              ) : page === 'imports' ? (
                <ImportChatsPage key={importSource} source={importSource} projects={importProjects} projectId={newChatProjectId}
                  threadCount={threads.length} onClose={() => setPage('chat')} onOpenThread={handleSelectThread} />
              ) : page === 'scheduled' ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <header className="flex items-center justify-between border-b border-line bg-surface-2 px-4 py-3">
                    <h1 className="text-sm font-semibold">Scheduled</h1>
                    <button type="button" onClick={() => setPage('chat')} className="text-xs text-ink-2 hover:text-ink">Done</button>
                  </header>
                  <TasksPanel scheduledOnly />
                </div>
              ) : page === 'pull-requests' ? (
                <PullRequestsPage workspace={workspace}
                  onOpenTerminal={() => {
                    revealTerminal();
                    void startTerminal(workspace).catch((error) => console.error('Could not open terminal:', error));
                  }}
                  onClose={() => setPage('chat')} onReview={(prompt) => composeNewDraft(prompt, true)} />
              ) : page === 'environment' ? (
                <EnvironmentPage onLeave={() => setPage('chat')}
                  workspaceContext={{ threadId: activeThreadId, title: activeThread?.title || 'New chat',
                    path: currentWorkspaceState?.path || workspace, available: currentWorkspaceState?.available !== false,
                    reason: currentWorkspaceState?.reason, ready: hydrated && !!currentWorkspaceState &&
                      (currentWorkspaceState.available === false || currentWorkspaceState.path === workspace) }}
                  onChooseWorkspace={chooseChatWorkspace} onBindWorkspace={bindChatWorkspace} />
              ) : (
                <>
                  <ChatHeader
                    assistantName={assistant.name}
                    coordination={activeThread && window.electronAPI.chatCoordination ? {
                      open: coordinationOpen,
                      pending: coordinationPending.threadId === activeThread.id ? coordinationPending.count : 0,
                      onToggle: () => setCoordinationOpen((current) => !current),
                    } : undefined}
                    debug={{ open: debugOverlay, onToggle: toggleDebugOverlay }}
                    stats={activeTurn.stats}
                    inference={activeInferenceEvents[activeInferenceEvents.length - 1]?.metrics}
                    sessionStartedAt={sessionStartedAt}
                    error={activeTurn.error}
                    context={activeTurn.context}
                    thread={activeThread ? { id: activeThread.id, title: activeThread.title } : null}
                    source={activeTurn.runId ? activeTurn.source : resolvedProvider ?? null}
                    modelId={selectedModel?.id ?? ''}
                    viewMode={viewMode}
                    onChangeViewMode={handleChangeViewMode}
                    panel={
                      viewMode === 'transcript' && !emptyState
                        ? { open: panelOpen, available: panelFits, onToggle: handleTogglePanel }
                        : undefined
                    }
                  />

                  <div ref={conversationAreaRef}
                    // A floating prompt sits over this, so the transcript needs room to scroll
                    // clear of it; in the band it has its own row and needs none.
                    className={`relative flex-1 overflow-hidden ${promptDock ? '' : 'pb-28'}`}
                    style={!promptDock && resolvedProvider?.id === HAG_SOURCE_ID ? { paddingBottom: hagComposerHeight + 16 } : undefined}>
                      {emptyState ? (
                        <EmptyState
                          seed={activeThread?.createdAt ?? 0}
                          hasSources={providers.length > 0}
                          workspace={access.directory}
                          name={person?.name || null}
                        />
                      ) : (
                        renderConversation(activeThread)
                      )}

                      {activeThread && !coordinationOpen && !emptyState && (
                        <ConversationOverlay panelShown={panelShown} panelWidth={panelWidth} sheetWidth={sheetWidth}
                          messages={activeThread.messages} isActive={activeThreadIsStreaming}
                          taskId={openSubagentId} subagent={openSubagent} onOpenSubagent={showSubagent}
                          onCloseSubagent={() => setOpenSubagentId(null)} onAttach={() => composerRef.current?.openFiles()} />
                      )}
                      {activeThread && <ChatCoordinationPanel
                        api={window.electronAPI.chatCoordination}
                        threadId={activeThread.id} threadTitle={activeThread.title} workspaceKey={activeThread.directory ?? ''}
                        open={coordinationOpen} running={activeThreadIsStreaming}
                        canContinue={hydrated && !!resolvedProvider && !!selectedModel && !sourceLoading && !sourceUnreachable && !restartPreparing}
                        beforeLoad={checkpointForCoordination} onPendingChange={updateCoordinationPending}
                        onOpenThread={(id) => { if (threads.some((thread) => thread.id === id)) handleSelectThread(id); }}
                        onContinue={() => handleSubmit('Continue with the notes from connected chats.', [])}
                        onClose={() => setCoordinationOpen(false)}
                      />}
                  </div>

                  <ChatDiagnostics messages={activeThread?.messages ?? []} />

                  {activeTurn.steer && activeTurn.steer.runId === activeTurn.runId && (
                    <div className="px-4">
                      <div className="mx-auto w-full max-w-3xl">
                        <PendingSteer
                          note={activeTurn.steer.note}
                          delivered={activeTurn.steer.delivered}
                          onEdit={() => {
                            const note = activeTurn.steer?.note ?? '';
                            handleCancelSteer();
                            composerRef.current?.setText(note);
                          }}
                          onCancel={handleCancelSteer}
                          onSteerNow={handleSteerNow}
                        />
                      </div>
                    </div>
                  )}

                  {voiceOpen && <div className="mx-auto max-h-[48vh] w-full max-w-3xl shrink-0 overflow-y-auto px-4 pb-2">
                    {voiceLoadError && <p role="alert" className="mb-2 text-xs text-danger">{voiceLoadError} <button onClick={loadVoice} className="underline">Retry</button></p>}
                    {!voiceConfiguration ? <p className="text-xs text-ink-3">Loading voice sources…</p> : <>
                      <p className="mb-1 px-1 text-[10px] text-ink-3">Input: {voiceConfiguration.settings.inputModel || 'not configured'} · Replies: {voiceConfiguration.settings.speechEnabled ? voiceConfiguration.settings.speechModel : 'text only'} · Coding: {selectedModel?.name ?? selectedModel?.id ?? 'choose a chat model'}</p>
                      <VoicePanel voice={voice} onClose={() => setVoiceOpen(false)} onOpenSettings={() => {
                        voice.stop(); openSettings({ section: 'voice' });
                      }}
                        onInsertDraft={(text) => {
                          const draft = composerRef.current?.currentDraft().text ?? '';
                          composerRef.current?.setText([draft, text].filter(Boolean).join('\n\n'));
                        }} />
                    </>}
                  </div>}
                  <PromptSurface docked={promptDock} layout={toolWindows}>
                  <ChatComposer
                    variant={promptDock ? 'band' : 'float'}
                    onVoice={openVoice}
                    voiceActive={voice.state.active}
                    suggestion={followUpSuggestion(activeThread?.messages ?? [], activeThreadIsStreaming)}
                    // Keyed by conversation: a switch remounts it, so the draft it restores and
                    // the draft it reports can never belong to two different threads at once.
                    key={activeThreadId}
                    ref={composerRef}
                    threadId={activeThreadId}
                    draft={drafts[activeThreadId]}
                    onDraftChange={handleDraftChange}
                    onSubmit={handleSubmit}
                    // Loading blocks new requests while Stop and model selection stay available.
                    disabled={
                      !!restartPreparing ||
                      activeThreadIsStreaming ||
                      !!modelUnavailableReason ||
                      !!hagHistoryBlockedReason ||
                      sourceLoading ||
                      sourceUnreachable
                    }
                    disabledReason={
                      !restartPreparing && !activeThreadIsStreaming
                        ? (modelUnavailableReason ?? hagHistoryBlockedReason ?? sourceBlockedReason)
                        : undefined
                    }
                    sourceHint={!activeThreadIsStreaming && !modelUnavailableReason && readiness.state === 'startable' ? readiness.detail : undefined}
                    sourceNotice={<HagPreviewNotice sourceId={resolvedProvider?.id} onManage={() => openSettings({ section: 'experimental' })} />}
                    textOnly={resolvedProvider?.id === HAG_SOURCE_ID}
                    onHeightChange={resolvedProvider?.id === HAG_SOURCE_ID ? setHagComposerHeight : undefined}
                    streaming={activeThreadIsStreaming}
                    onStop={handleStopTurn}
                    placeholder={resolvedProvider?.id === HAG_SOURCE_ID ? 'Ask Qwen3-0.6B a short question' : `Write a message for ${assistant.name}`}
                    providers={providers}
                    providerId={resolvedProvider?.id ?? ''}
                    modelId={selectedModel?.id ?? ''}
                    onOpenModels={() => {
                      setModelSelection(null);
                      showModelLibrary();
                    }}
                    access={access}
                    onChangeAccess={updateAccess}
                    accessError={currentWorkspaceState?.available === false ? currentWorkspaceState.reason :
                      activeThreadIsStreaming ? accessErrors[activeThreadId ?? ''] : undefined}
                    workspace={workspace}
                    workspaceConfirmed={workspaceConfirmed}
                    onChooseWorkspace={async () => {
                      try { return await chooseChatWorkspace(); }
                      catch (error) {
                        showToast({ tone: 'danger', title: 'Could not change chat folder',
                          body: error instanceof Error ? error.message : String(error), key: 'chat-folder' });
                        return null;
                      }
                    }}
                    onConfirmWorkspace={() => {
                      if (!workspace) return;
                      const threadId = activeThreadId;
                      const expectedPath = workspace;
                      void checkpointForCoordination(threadId)
                        .then(() => window.electronAPI.mcp.confirmWorkspace(threadId, expectedPath))
                        .then(refreshWorkspace)
                        .catch((error) => {
                          console.error('Could not confirm conversation workspace:', error);
                          changeTurns((current) => noteError(current, threadId, error instanceof Error ? error.message : String(error)));
                        });
                    }}
                    onSteer={handleSteer}
                  />
                  </PromptSurface>
                </>
              )}
              {page === 'chat' && debugOverlay && <InferenceDebugOverlay
                events={activeInferenceEvents}
                active={activeThreadIsStreaming}
                sourceName={activeTurn.source?.name}
                onClose={toggleDebugOverlay}
              />}
            </main>

            <Dock anchor="right" layout={toolWindows} />
          </div>

          <Dock anchor="bottom" layout={toolWindows} />
        </div>

        <ToolStripe layout={toolWindows} />
        <FloatingLayer layout={toolWindows} />

        {/* The core floats over the editor, and only there — it is a coding companion, not a mascot. */}
        {page === 'environment' && (
          <Avatar
            source={{
              providerId: resolvedProvider?.id ?? '',
              model: selectedModel?.id ?? '',
              accessMode: access.mode,
            }}
          />
        )}

        {pendingDelete && (
          <ConfirmDialog
            title="Delete this conversation?"
            message={`"${pendingDelete.title}" and its ${pendingDelete.messages.length} ${
              pendingDelete.messages.length === 1 ? 'message' : 'messages'
            } will be gone. This cannot be undone.`}
            confirmLabel="Delete"
            tone="danger"
            onConfirm={handleConfirmDelete}
            onCancel={() => setPendingDelete(null)}
          />
        )}
        {!showSetup && page === 'chat' && sourceLoading && loadingSince !== null && (
          <SourceLoadingOverlay
            sourceName={resolvedProvider?.name ?? 'The selected source'}
            modelId={selectedModel?.id ?? activeModelId ?? 'the model'}
            detail={readiness.detail}
            since={loadingSince}
            onStop={activeThreadIsStreaming ? handleStopTurn : undefined}
            onChooseModel={() => { setModelSelection(null); showModelLibrary(); }}
          />
        )}
        {showSetup && <SetupWizard onClose={() => setShowSetup(false)} onOpenModels={() => { setShowSetup(false); showModelLibrary(); }} onOpenRemoteSettings={() => { setShowSetup(false); openSettings({ section: 'devices' }); }} />}
        {showHagWelcome && <HagWelcomeDialog controller={hagExperimental} onEnabled={refreshProviders} />}
        {restartPreparing && (
          <div
            className="pointer-events-none absolute inset-0 z-[100] cursor-wait bg-surface/5"
            aria-label={`Preparing Antimatter ${restartPreparing.version} restart`}
          />
        )}
        {/*
          Last in the shell and position: fixed, so a notice is not clipped by whichever panel
          raised it. Renders nothing at all while the list is empty.
        */}
        <ToastHost />
        </div>
      </div>
      </PreviewPanelProvider>
      </ConversationUiProvider>
    </ShellProvider>
  );
}
