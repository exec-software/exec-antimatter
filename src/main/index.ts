import { LocalInferenceCoordinator } from './localInferenceCoordinator';
import { DetachedWindowManager } from './detachedWindows';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, safeStorage, shell, Tray, type OpenDialogOptions } from 'electron';
import { AppearanceSettingsStore, appearanceBackground, isAppearancePage, mayReadAppearance, mayUpdateAppearance } from './appearance';
import { DesktopPreferencesStore, registerDesktopPreferencesIpc } from './desktopPreferences';
import { DoomSaveStore, registerDoomIpc } from './doom';
import { FeatureStore } from './features/store';
import { FeatureService } from './features/service';
import { SecurityService } from './security/service';
import { ConnectionsStore } from './connections/store';
import { ConnectionProviders } from './connections/providers';
import { ConnectionsService } from './connections/service';
import { withConnections } from './connections/tools';
import { registerNativeProjectIpc } from './environment/nativeProjectIpc';
import { NativeLanguageServices } from './environment/nativeLanguageServer';
import { SECURITY_IPC } from '../api/security';
import { SidebarStore } from './sidebar';
import { ChatNotesStore } from './chatNotes';
import { registerChatNotesIpc } from './chatNotesIpc';
import { CHAT_NOTES_IPC } from '../api/chatNotes';
import { IdleCompaction } from './idleCompaction';
import { summarizeIdleConversation } from './idleCompactionSummary';
import { adoptSoundFile, NotificationSettingsStore, readSoundDataUrl } from './notifications';
import { parseFinishedTurn, planTurnNotification, SOUND_FILE_EXTENSIONS, type NotificationSettings } from '../api/notifications';
import { SetupStore } from './setup';
import { renderAssistantIdentity } from '../api/setup';
import { nextThemeBoundary, resolveTheme, type AppearanceSettings } from '../api/appearance';
import { ChatImportService } from './chatImports/service';
import { installSpellingMenu } from './spellingMenu';
import { VoiceSession } from './voice/session';
import { defaultVoiceSettings, VoiceSettingsStore, voiceSources } from './voice/settings';
import { VoiceGuidanceQueue } from './voice/guidance';
import { restoreDeliveredVoiceHistory } from './voice/history';
import { isVoiceAppUrl, mayCaptureVoice } from './voice/permissions';
import { discoverLocalSpeechSource, transcribeVoice, synthesizeVoice, synthesizeVoiceStream, probeVoiceBackend } from './voice/backend';
import { VoiceSpeechDelivery } from './voice/speechDelivery';
import { RealtimeTranscription, discoverLocalTranscriptionSource } from './voice/realtime';
import type { VoiceCommand, VoicePhase } from '../api/voice';
import { openExternalTerminal } from './externalTerminal';
import { DesktopAvatar } from './avatar/desktop';
import { listPullRequests, readPullRequest } from './pullRequests';
import { withPullRequests } from './pullRequestTools';
import { withAsk } from './ask/tools';
import { askIdFor, parseAskOutcome, type AskOutcome, type AskRequest } from '../api/ask';
import { withVault } from './vault/tools';
import * as vaultStore from './vault/store';
import * as vaultGrants from './vault/grants';
import { CodeReviewStore } from './codeReview/store';
import { registerCodeReviewIpc } from './codeReview/ipc';
import { CODE_REVIEW_INSTRUCTIONS, withCodeReview } from './codeReview/tools';
import { withTerminal } from './terminalTools';
import { ExtensionRegistry } from './extensions/registry';
import { withSkills } from './extensions/tools';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'path';
import { insideWorkspace } from '../../mcp/workspace';
import { ProviderManager } from '../api/providers';
import type {
  AccessMode,
  ChatRequest,
  Message,
  ModelDeclaration,
  ModelMetadataPatch,
  ToolDefinition,
} from '../api/types';
import * as delegation from './agents/delegation';
import { resolveAgentModel } from './agents/modelResolution';
import * as agentRunner from './agents/runner';
import * as agentTranscripts from './agents/transcripts';
import * as profiles from './agents/profiles';
import * as routing from './agents/routing';
import * as agents from './agents/registry';
import * as router from './agents/router';
import * as taskQueue from './agents/tasks';
import type { NewTask } from './agents/tasks';
import type { Task } from './agents/types';
import { ActiveTurns, type ActiveTurnRecord, type TurnOwner } from './activeTurns';
import { ChatCoordinationStore } from './chatCoordination';
import { combineBackgroundWork } from './chatCoordinationRuntime';
import { withInteractiveCollaboration } from './interactiveCollaboration';
import { BotChatStore } from './botChat';
import { BotChatInbox } from './botChatInbox';
import { registerBotChatIpc } from './botChatIpc';
import { LiveAccess } from './liveAccess';
import { AppEventBus } from './appEvents';
import { RemoteLiveTranscript, flushSnapshotDeltas } from './remote/liveTranscript';
import { relayDesktopStreamEvent, type DesktopStreamEventDependencies } from './remote/desktopStreamEvents';
import * as beholdd from './beholdd';
import * as llamaVulkan from './llamaVulkan';
import { HagExperimental, HAG_SOURCE_ID, isOwnedHagSource } from './hagExperimental';
import { PensieveExperimental, discoverPensievePaths } from './pensieveExperimental';
import { withPensieve, PENSIEVE_INSTRUCTIONS } from './pensieveRuntime';
import { PensieveLibrary } from './pensieveLibrary';
import { withPensieveLibrary } from './pensieveLibraryTools';
import { HAG_PREVIEW_MAX_EVALUATED_TOKENS, HAG_PREVIEW_MAX_OUTPUT_TOKENS, HAG_PREVIEW_SYSTEM, prepareHagPreview, assertHagVisibleHistory } from '../api/hag';
import { fitHagPreview } from './hagPreviewContext';
import { selectModel } from './modelSelection';
import { WorkloadDeployments, isWorkloadSource } from './workloadDeployment';
import { InferenceServers } from './inferenceServers';
import { hostname } from 'node:os';
import { listNodes } from './nodes';
import { assertInferenceServerAction } from '../api/inferenceServers';
import { downloadWorkload, workloadById } from './workloads';
import * as envDebug from './environment/debug';
import * as envExec from './environment/exec';
import * as envFiles from './environment/files';
import { resolveNyToolchain } from './environment/ny';
import { NyLanguageServer } from './environment/nyLanguageServer';
import { NilAnalysisService } from './environment/nilAnalysis';
import { inspectNyModule, nyModulePath } from './environment/nyInspector';
import { buildNyFile, createNyProject, nySourcePath } from './environment/nyProjects';
import { buildNilProject, createNilProject, describeNilProject, findNilProject, nilProjectInvocation } from './environment/nilProjects';
import type { NilProjectLanguage, NilProjectTarget } from '../api/nilProject';
import type { NyDocument, NyLocation, NyStatus } from '../api/ny';
import * as editLock from './editLock';
import { isAllowedExternalUrl } from './externalLinks';
import * as carbon from './carbon';
import * as conversations from './conversations';
import type { RecoveryTrigger } from './recovery/shell';
import { wireRecovery } from './recovery/wire';
import * as mcp from './mcp';
import { withMcpControl, withMcpWorkspace } from './mcpLease';
import * as mcpStore from './mcpStore';
import { ensurePrivateDirectory, writePrivateFileAtomic } from './privateState';
import { conversationTokens, fitToBudget, fitWithCompactionNotice, isCompactionNotice, promptBudget } from './context';
import { standingContext, type ContextSnapshot, type MemoryAccess } from './memory/context';
import { instructionAllowance } from './memory/instructions';
import { openableInstruction, pageState, parseScope, resolveTarget } from './memory/page';
import * as person from './memory/person';
import * as memoryStore from './memory/store';
import { withMemory } from './memory/tools';
import { mergeInstructions, withSituation, type Situation } from './prompt';
import { prepareInteractiveRequest } from './interactiveRequest';
import { compactionRequest } from './compactionRequest';
import { sanitizeConversationRequest } from '../api/requestMessages';
import { HubService } from './hub/service';
import { detectInstallation } from './updates/installation';
import {
  AutomaticRestartCoordinator,
  automaticRestartBlockers,
  type RendererRestartPreparation,
} from './updates/coordinator';
import { relaunchAfterExit } from './updates/restart';
import { UpdateService } from './updates/service';
import type { HubSearchQuery } from './hub/types';
import * as modelCatalog from './modelCatalog';
import * as developerSettings from './developerSettings';
import * as modelUse from './modelUse';
import { readResidency, reportsResidency, unloadModel, type SourceResidency } from './residency';
import * as modelChoice from './modelChoice';
import { createLastUsedModel } from './lastUsedModel';
import * as modelProfiles from './modelProfiles';
import { ModelRuntimeProfileStore } from './modelRuntimeProfiles';
import { LocalRuntimeServiceManager } from './localRuntimeService';
import { engineEndpoint, LocalEngineLifecycle } from './localEngineLifecycle';
import { readDeviceMemory } from './deviceMemory';
import { listSystemFonts } from './systemFonts';
import * as recipes from './recipes';
import { modelsAgree, substitutionWarning } from './servedModel';
import * as capture from './preview/capture';
import * as eyes from './preview/eyes';
import { hideWindowWithPreviewCleanup } from './preview/lifecycle';
import * as pane from './preview/pane';
import { withPreview } from './preview/tools';
import { previewableUrl } from './preview/targets';
import { boundPreviewImage, type ImagePreviewRequest } from './preview/workspace';
import { RemoteWorkspaceHost, type RemoteBootstrapContext } from './remote/host';
import { registerRemoteIpcHandlers } from './remote/ipc';
import { NodeAgent } from './nodeAgent/server';
import { NodePeerStore } from './nodeAgent/peers';
import { ClusterService, clusterVitals } from './cluster/service';
import { CLUSTER_IPC, type ClusterEngineAction } from '../api/cluster';
import { pairWithNode, requestReport } from './nodeAgent/client';
import { NODE_AGENT_IPC, parseNodePairingCode } from '../api/nodeAgent';
import { inferRemoteProjectName } from './remote/projects';
import { RemoteProtocolError, type JsonValue, type RemoteCommand, type RemoteCommandReceipt } from './remote/protocol';
import type { PublicDeviceRecord } from './remote/pairingStore';
import type { RemoteDispatchContext, RemoteDispatchResult } from './remote/router';
import { createRemoteSafeStorageProtector, secureRemoteStorageAvailable } from './remote/safeStorageProtector';
import { describeRemoteTool } from './remote/toolDescription';
import { RemoteDesktopTurns } from './remote/desktopTurns';
import { RemoteInferenceState, projectInferenceProgress } from './remote/inferenceProgress';
import { resolveConversationWorkspace, conversationWorkspaceProjectRoot, assertStreamConversation } from './conversationWorkspace';
import { inspectRemoteTurnControl } from './remote/turnControl';
import { runRemoteTurn as executeRemoteTurn, type RemoteTurnSink, type RemoteTurnDependencies } from './remote/runTurn';
import {
  expectedRemoteThreadRevision,
  inspectRemoteTurnStart,
  reserveRemoteTurnStart,
  type RemoteTurnStartDependencies,
  type RemoteTurnStartReservation,
} from './remote/turnStart';
import { runToolLoop, type ToolActivity, type ToolRuntime } from './toolLoop';
import { explicitlyRequiredTool } from './toolIntent';
import { buildToolset, needsLocalInput } from './toolPolicy';
import { rememberInteractiveTurn, resolveRunnerModel, resolveRunnerSource } from './runnerSource';
import { readConfig, validateForDispatch } from './orchestrator/config';
import { Orchestrator, type WorkflowSnapshot } from './orchestrator/orchestrator';
import {
  createRunner,
  type RunnerTranscriptSnapshot,
  type RunnerTurnContext,
  type RunnerTurnResult,
} from './orchestrator/runner';
import { createTracker, registerTracker } from './orchestrator/tracker';
import { loadWorkflow } from './orchestrator/workflow';
import { ensureWorkspace, workspaceKey } from './orchestrator/workspace';
import { persistedModel, probeSource } from './probe';
import { devParentPid, watchDevParent } from './devParentWatch';
import { readSourceReadiness, readSourceWithStartup, type SourceReadiness } from './sourceReadiness';
import { beholddStartupReadiness } from './beholddReadiness';
import { inspectManagedSource, managedSourceReadiness } from './managedSourceInspection';
import { refreshSource } from './sourceRefresh';
import { isActiveStage, type ItemDraft, type ItemKind, type ItemStatus, type SnitchItem, type SnitchRelease } from './snitch/model';
import { decodeIssueId, ownsSnitchTarget, Pipeline } from './snitch/pipeline';
import * as snitch from './snitch/store';
import * as sourceStore from './sourceStore';
import { validateCredentialUpdate, validateNewSource, validateProbeInput } from './sourceInput';
import * as terminal from './terminal';
import * as transcriptCache from './transcripts';
import type { InferenceSource } from './sourceStore';
import { Sampler } from './vitals/sampler';
import * as vitalsSources from './vitals/sources';

// Disable GPU acceleration for performance
app.disableHardwareAcceleration();

// All scheduler claims and MCP workspace leases are process-local. A second Antimatter process
// would therefore be a second authority over the same durable queues and repositories, so keep
// one desktop instance and focus it when another launch is attempted.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

/**
 * In development, end with the Vite process that launched this one.
 *
 * Holding the lock above is precisely what makes a survivor harmful: a new `npm run dev` loses
 * the lock to it, quits, and Vite then serves a freshly built renderer to a main process from
 * before the rebuild — so an IPC handler that exists in the source is "not registered" at
 * runtime. The owner cannot be relied on to prevent that, because a Vite that was SIGKILLed or
 * crashed runs no cleanup of its own. Packaged builds set no such variable and skip all of this.
 */
const devOwnerPid = devParentPid();
if (devOwnerPid !== null) {
  watchDevParent({
    parentPid: devOwnerPid,
    onParentGone: () => {
      console.info('[electron-dev] the Vite process that started this is gone; quitting.');
      app.quit();
      // A window mid-teardown can refuse to close, and the whole point is to stop holding the
      // single-instance lock. Do not linger over it.
      setTimeout(() => app.exit(0), 2_000).unref?.();
    },
  });
}

let mainWindow: BrowserWindow | null = null;
let desktopAvatar: DesktopAvatar | null = null;
const appearanceStore = new AppearanceSettingsStore(join(app.getPath('userData'), 'appearance.json'));
const desktopPreferencesStore = new DesktopPreferencesStore(join(app.getPath('userData'), 'desktop.json'));
const sidebarStore = new SidebarStore(join(app.getPath('userData'), 'sidebar.json'));
const chatNotes = new ChatNotesStore({ directory: () => join(app.getPath('userData'), 'chat-notes'),
  conversationExists: (id) => conversations.snapshot().threads.some((thread) => thread.id === id) });
const notificationStore = new NotificationSettingsStore(join(app.getPath('userData'), 'notifications.json'));
// Capture this before automatic source seeding or the renderer's first empty checkpoint.
const existingConfiguration = existsSync(conversations.location()) ||
  existsSync(join(app.getPath('userData'), 'sources.json')) || existsSync(join(homedir(), '.antimatter', 'user.json'));
const setupStore = new SetupStore(join(app.getPath('userData'), 'setup.json'), () => existingConfiguration);
const extensions = new ExtensionRegistry({
  storePath: join(app.getPath('userData'), 'extensions.json'),
  personalSkillsRoot: join(homedir(), '.antimatter', 'skills'),
});
const skillRuntime = (runtime: ToolRuntime, workspace: string): ToolRuntime => withConnections(withSkills(runtime, extensions, workspace), connections, workspace);
const skillInstructions = (workspace: string): string => extensions.promptMetadata(workspace) ?? '';
mcp.configureManagedServers(() => extensions.mcpServers());
let tray: Tray | null = null;
let quitting = false;
let desktopReady = false;
let remoteHost: RemoteWorkspaceHost | null = null;
let nodeAgent: NodeAgent | null = null;
let nodePeers: NodePeerStore | null = null;
let clusterService: ClusterService | null = null;
let remotePowerBlocker: number | null = null;
// safeStorage is unavailable while Electron is still importing the main module. Populate this
// registry inside app.whenReady(), before the renderer can ask for its source list.
const providerManager = new ProviderManager();

/**
 * The configured loopback llama.cpp servers — the user systemd units behind sources like
 * `http://127.0.0.1:8086/v1` — are Antimatter's to run while Antimatter is the thing using them.
 * They are started on first use rather than at login, supervised while the window is open, and
 * released when it closes. See localEngineLifecycle.ts for why each of those is the rule.
 */
const localEngines = new LocalEngineLifecycle({
  busy: (sourceId) => providerManager.busy(sourceId),
  // An engine profile switch restarts a unit on purpose; supervision must not race it.
  applying: () => runtimeProfiles?.isApplying() ?? false,
  log: (line) => console.log(line),
});

const hagDirectory = join(app.getPath('userData'), 'hag');
const pensievePaths = discoverPensievePaths({ resourcesPath: app.isPackaged ? process.resourcesPath : undefined, appPath: app.getAppPath() });
const pensieveLibrary = new PensieveLibrary({ file: join(app.getPath('userData'), 'pensieve', 'library.json'), curriculumPath: pensievePaths.curriculumPath });
const pensieve = new PensieveExperimental({ directory: join(app.getPath('userData'), 'pensieve'),
  ...pensievePaths, changed: state => send('pensieve:changed', state),
  filterRecall: (value, request, workspace) => pensieveLibrary.filterRuntimeRecall(value, { workspace, cue: request.cue, language: request.language }) });
const hagPreviousChoice = join(hagDirectory, 'previous-model.json');
const hag: HagExperimental = new HagExperimental({
  directory: hagDirectory,
  vendorRoot: app.isPackaged ? join(process.resourcesPath, 'vendor', 'beholdd-hag') : join(app.getAppPath(), 'vendor', 'beholdd-hag'),
  home: homedir(),
  busy: () => providerManager.busy(HAG_SOURCE_ID),
  register: (source) => {
    const existing = sourceStore.find(HAG_SOURCE_ID);
    if (existing && !isOwnedHagSource(existing)) throw new Error('The HAG source identifier is already used by a different configuration. Rename that source before enabling HAG.');
    if (!existing) {
      const current = modelChoice.read();
      if (current?.providerId !== HAG_SOURCE_ID) writePrivateFileAtomic(hagPreviousChoice, JSON.stringify(current) + '\n');
    }
    providerManager.addConfig(sourceStore.save(source));
    send('providers:changed', { at: Date.now() });
  },
  remove: () => {
    const existing = sourceStore.find(HAG_SOURCE_ID);
    if (!existing || !isOwnedHagSource(existing)) return;
    providerManager.removeProvider(HAG_SOURCE_ID);
    sourceStore.remove(HAG_SOURCE_ID);
    if (modelChoice.read()?.providerId === HAG_SOURCE_ID) {
      let previous: modelChoice.ModelChoice | null = null;
      try { previous = JSON.parse(readFileSync(hagPreviousChoice, 'utf8')); } catch { /* No prior selection. */ }
      if (previous && previous.providerId !== HAG_SOURCE_ID && sourceStore.find(previous.providerId)?.models.some((model) => model.id === previous?.modelId)) {
        modelChoice.save(previous);
        lastUsed.select(previous.providerId, previous.modelId);
      } else { modelChoice.clear(); lastUsed.clear(); }
    }
    send('providers:changed', { at: Date.now() });
  },
  beforeStart: (signal) => localInference.retireFor({ kind: 'preview' }, signal),
  changed: (state) => send('hag:changed', state),
});

/** One transition queue covers first prompts, Hub restarts and manual engine controls. */
const localInference: LocalInferenceCoordinator = new LocalInferenceCoordinator({
  nativeSourceId: llamaVulkan.BUNDLED_BEHOLDD_SOURCE_ID,
  previewSourceId: HAG_SOURCE_ID,
  busy: (id) => providerManager.busy(id),
  native: { inspect: () => beholdd.inspectStatus(), stop: () => beholdd.stop() },
  router: { status: () => llamaVulkan.status(), sourceId: () => llamaVulkan.managedSourceId(), stop: () => llamaVulkan.stop() },
  direct: { states: () => localEngines.states(), inspect: () => localEngines.inspectStates(), stop: (id) => localEngines.stopSource(id) },
  preview: { enabled: () => hag.state().enabled, stop: () => hag.stop() },
});
const startNative = (options: { configPath?: string; host?: string; port?: number }, restart = false) =>
  localInference.run(async () => {
    await localInference.retireFor({ kind: 'native' });
    return restart ? beholdd.restart(options) : beholdd.start(options);
  });
const startRouter = (selection?: Parameters<typeof llamaVulkan.start>[0]) => localInference.run(async () => {
  await localInference.retireFor({ kind: 'router', sourceId: selection?.sourceId ?? llamaVulkan.SOURCE_ID });
  return llamaVulkan.start(selection);
});

providerManager.usePrepareProvider((providerId, modelId, signal) => localInference.run(async () => {
  assertRuntimeProfileReady(providerId);
  if (providerId === HAG_SOURCE_ID) {
    const source = sourceStore.find(providerId);
    if (!source || !isOwnedHagSource(source)) throw new Error('The experimental HAG source no longer matches its owned configuration.');
    await hag.start(signal);
    return;
  }
  const managed = providerId === llamaVulkan.SOURCE_ID || isWorkloadSource(providerId);
  if (managed) {
    await localInference.retireFor({ kind: 'router', sourceId: providerId }, signal);
    return llamaVulkan.start(isWorkloadSource(providerId) ? workloadDeployments.runtime(providerId) : undefined, signal);
  }
  if (providerId === llamaVulkan.BUNDLED_BEHOLDD_SOURCE_ID) {
    await localInference.retireFor({ kind: 'native' }, signal);
    const state = await beholdd.start({}, signal);
    if (!state.ready) throw new Error('Beholdd (native) did not become ready');
    if (modelId !== undefined) await beholdd.prepareModel(modelId, signal);
    return;
  }
  const configured = providerManager.getConfig(providerId);
  if (configured && engineEndpoint(configured.baseUrl)) {
    await localInference.retireFor({ kind: 'direct', sourceId: providerId, endpoint: engineEndpoint(configured.baseUrl) ?? undefined }, signal);
    await localEngines.ensureRunning({ sourceId: providerId, baseUrl: configured.baseUrl,
      model: configured.models.length === 1 ? configured.models[0].id : null }, signal);
    return;
  }
  // Preserve the existing remote-provider release behavior without starting a local engine.
  if (hag.state().enabled) await hag.stop();
  signal?.throwIfAborted();
  const activeSource = llamaVulkan.managedSourceId();
  if (activeSource && providerManager.busy(activeSource)) throw new Error('The current local workload is serving a request. Wait for it to finish before switching sources.');
  if (llamaVulkan.status().ownership === 'app') await llamaVulkan.stop();
}, signal));

// Where the projects root is remembered. The projects themselves live wherever it points,
// which is usually ~/.antimatter/snitch but is just as happily an existing Snitch checkout.
snitch.useConfigPath(join(app.getPath('userData'), 'snitch.json'));
modelProfiles.useConfigPath(join(app.getPath('userData'), 'model-profiles.json'));
modelChoice.useConfigPath(join(app.getPath('userData'), 'model.json'));
developerSettings.useConfigPath(join(app.getPath('userData'), 'developer.json'));
vaultStore.useStorePath(join(app.getPath('userData'), 'vault.json'));
// Notes sit with the carbons and transcripts, which are keyed on HOME; their switches are settings.
memoryStore.useRoot(join(homedir(), '.antimatter'));
memoryStore.useConfigPath(join(app.getPath('userData'), 'memory.json'));
carbon.useRoot(join(homedir(), '.antimatter', 'carbons'));
carbon.migratePermissions();
transcriptCache.useRoot(join(homedir(), '.antimatter', 'transcripts'));
transcriptCache.migratePermissions();

const appEvents = new AppEventBus();
const detachedWindows = new DetachedWindowManager({
  mainWindow: () => mainWindow, showMain: () => showMainWindow(), events: appEvents,
  background: () => appearanceBackground(appearanceStore.get()),
  devServerUrl: process.env.VITE_DEV_SERVER_URL,
});

const send = (channel: string, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  appEvents.publish(channel, payload);
};
const codeReviews = new CodeReviewStore(join(homedir(), '.antimatter', 'code-reviews'), (event) => send('code-review:changed', event));
const features = new FeatureService(new FeatureStore(join(app.getPath('userData'), 'features.json')), () => send('features:changed', {}));
const security = new SecurityService(join(app.getPath('userData'), 'security'));
const connections = new ConnectionsService(new ConnectionsStore(join(app.getPath('userData'), 'connections.json'), createRemoteSafeStorageProtector(safeStorage)),
  new ConnectionProviders(), (url) => shell.openExternal(url), () => send('connections:changed', {}));
let nativeProject: ReturnType<typeof registerNativeProjectIpc> | null = null;

let localSpeechSource: import('../api/types').ProviderConfig | null = null;
let localTranscriptionSource: import('../api/types').ProviderConfig | null = null;
let lastSpeechDiscovery = 0;
const availableVoiceSources = () => [...providerManager.listProviders(), ...(localSpeechSource ? [localSpeechSource] : []), ...(localTranscriptionSource ? [localTranscriptionSource] : [])];
const voiceSettings = new VoiceSettingsStore(join(app.getPath('userData'), 'voice.json'), availableVoiceSources);
const speechDeliveries = new Map<string, VoiceSpeechDelivery>();
const liveTranscriptions = new Map<string, { sessionId: string; senderId: number; transport: RealtimeTranscription }>();
const voiceSession = new VoiceSession((state) => {
  send('voice:state', state);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.setBackgroundThrottling(!state.active);
});
const isVoiceRenderer = (contents: Electron.WebContents | null) => !!contents && contents === mainWindow?.webContents &&
  isVoiceAppUrl(contents.getURL(), join(__dirname, '../renderer/index.html'), process.env.VITE_DEV_SERVER_URL);
const voiceHasVisibleControls = () => !!((mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) || desktopAvatar?.visible());
const selectedVoiceSource = (id: string) => {
  const source = availableVoiceSources().find((entry) => entry.id === id);
  if (!source) throw new Error('This voice source is unavailable. Open Voice setup and choose a configured source.');
  return source;
};
const stopVoice = () => { voiceSession.end(); send('voice:command', 'stop' satisfies VoiceCommand); };

/**
 * The recovery shell: the fallback surface the window becomes when the normal UI is down. It is
 * a real agent running on the same MCP tools as chat — a renderer crash, a page that failed to
 * load, or the tray can hand the window over to it, type a line, and repair the app from inside
 * the window that broke. The shell and its state live in this process (see recovery/), so they
 * survive the renderer dying and even an in-process reload.
 *
 * Wired here rather than in recovery/wire.ts because it is the one place that owns the app's
 * windows, updater and providers.
 */
const { shell: recoveryShell } = wireRecovery(
  {
    send,
    window: () => mainWindow,
    backToApp: (window) => loadAppInto(window),
    relaunchApplication: () => {
      const target = updates.restartTarget(process.argv.slice(1));
      if (target) {
        void relaunchAfterExit(target, process.env)
          .then(quitApplication)
          .catch((error) => console.error('[updates] recovery relaunch helper failed:', error));
      }
    },
  },
  providerManager
);
recoveryShell.onChange((state) => send('recovery:state', state));

/**
 * The Model Hub: Hugging Face search, resumable verified downloads into the Hub cache, and
 * registration of each finished model with the engines that can run it (see hub/engines.ts).
 */
const hub = new HubService({
  userData: app.getPath('userData'),
  appVersion: app.getVersion(),
  secrets: {
    // Keep open() independent of availability so existing safeStorage blobs remain readable after
    // an upgrade. New Linux writes use plaintext + an explicit UI warning under basic_text/unknown.
    available: () => secureRemoteStorageAvailable(safeStorage),
    seal: (value) => safeStorage.encryptString(value).toString('base64'),
    open: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
  },
  send,
  sources: () => sourceStore.list(),
  saveSource: (source) => {
    providerManager.addConfig(sourceStore.save(source));
  },
  sourceBusy: (id) => providerManager.busy(id),
  probe: (baseUrl, apiKey) => probeSource(baseUrl, apiKey),
  beholdd: {
    basePath: () => beholdd.resolveDefaultConfig(),
    port: () => beholdd.status().port ?? beholdd.DEFAULT_PORT,
    status: () => beholdd.inspectStatus(),
    restart: (target) => startNative(target, true),
  },
});
beholdd.usePreparedConfig(() => hub.registrar.prepareStart());
const workloadDeployments = new WorkloadDeployments(app.getPath('userData'), hub.downloads, (sourceId) =>
  !!sourceStore.find(sourceId)?.models.some((model) => model.id === sourceId.slice('workload-'.length)));

/**
 * One list of the inference servers this app owns, so a wedged engine can be stopped and
 * restarted without hunting for the model that happens to be selected. The router keeps whatever
 * workload it is bound to; the next turn asks it to prepare again and re-reads its credentials.
 */
const inferenceServers = new InferenceServers({
  beholdd: {
    inspectStatus: () => beholdd.inspectStatus(),
    start: (options) => startNative(options),
    stop: () => beholdd.stop(),
    restart: (options) => startNative(options, true),
  },
  router: {
    status: () => llamaVulkan.status(),
    start: (selection) => startRouter(selection),
    stop: () => llamaVulkan.stop(),
    managedSourceId: () => llamaVulkan.managedSourceId(),
    compatibilitySourceId: llamaVulkan.SOURCE_ID,
    selectionFor: (sourceId) => (isWorkloadSource(sourceId) ? workloadDeployments.runtime(sourceId) : undefined),
    // A missing or malformed compatibility checkpoint means "nothing to start", never a
    // thrown status: this panel has to render while the engine it describes is broken.
    hasPackagedModel: () => {
      try { return llamaVulkan.configuredModelPath(process.env, true) !== null; }
      catch { return false; }
    },
  },
  beholddSourceId: llamaVulkan.BUNDLED_BEHOLDD_SOURCE_ID,
  localEngines: {
    states: () => localEngines.states(),
    stopSource: (sourceId) => localEngines.stopSource(sourceId),
  },
  busy: (sourceId) => providerManager.busy(sourceId),
  sourceName: (sourceId) => sourceStore.find(sourceId)?.name ?? null,
});

/**
 * Updates from the configured release feed: buildd's latest.json, installed through the release's own
 * install.sh (or by replacing the AppImage), then relaunched once all inference and self-edits are
 * idle. The update service owns verification; this process owns the safe-to-exit decision.
 */
let automaticRestartCoordinator: AutomaticRestartCoordinator | null = null;
const updates = new UpdateService({
  userData: app.getPath('userData'),
  cacheRoot: join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'antimatter', 'updates'),
  detect: () =>
    detectInstallation({
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      version: app.getVersion(),
      env: process.env,
      uid: process.getuid?.() ?? -1,
      home: homedir(),
    }),
  env: process.env,
  uid: process.getuid?.() ?? -1,
  send: (state) => send('updates:state', state),
  onAutomaticReady: () => automaticRestartCoordinator?.offer(),
});

let automaticRestartCommitting = false;

/** Refuse new work during the tiny spawn-acknowledgement window before a committed restart. */
function assertNotCommittingAutomaticRestart(): void {
  if (automaticRestartCommitting) {
    throw new Error('Antimatter is restarting into an installed update; wait for the new window.');
  }
}

/** Work whose process-local result would be lost if an automatic update exited right now. */
function updateRestartBlockers(): string[] {
  const orchestration = orchestrator.snapshot();
  return [...automaticRestartBlockers({
    chatTurns: runningTurns.size,
    providerBusy: providerManager.anyBusy(),
    agentRunnerBusy: agentRunner.busy(),
    runningAgentTasks: taskQueue.counts().running,
    orchestratorActive: orchestration.active,
    orchestratorRuns: orchestration.running.length,
    orchestratorRetries: orchestration.retrying.length,
    recoveryBusy: recoveryShell.state().busy,
    liveTerminals: terminal.list().filter((session) => session.exit === null).length,
    environmentRun: envExec.current()?.exit === null || !!nyBuildController || !!nativeProject?.busy(),
    debuggerActive: envDebug.state().phase !== 'stopped',
    editBusy: editLock.busy(),
  }), ...(voiceSession.snapshot().active ? ['A live voice session is active.'] : []),
  ...(security.busy() ? ['A security scan is running.'] : []), ...(connections.busy() ? ['A connection request is active.'] : [])];
}

interface PendingRestartPreparation {
  requestId: string;
  sender: Electron.WebContents;
  finish(blockers: string[]): void;
}

let pendingRestartPreparation: PendingRestartPreparation | null = null;
const RENDERER_RESTART_PREPARE_TIMEOUT_MS = 5_000;

/** Ask the exact renderer we intend to close to save conversations and disclose dirty buffers. */
function prepareRendererForUpdate(version: string): Promise<RendererRestartPreparation> {
  const unavailable = (blocker: string): RendererRestartPreparation => ({ blockers: [blocker], release: () => {} });
  const window = mainWindow;
  if (!window || window.isDestroyed() || isRecoveryPage(window)) {
    return Promise.resolve(unavailable('The main window is not ready to preserve its state.'));
  }
  const sender = window.webContents;
  if (sender.isDestroyed()) return Promise.resolve(unavailable('The main window renderer is not available.'));

  // The coordinator serializes requests. Resolve defensively if a renderer navigation somehow
  // replaced an older request before its timeout fired.
  pendingRestartPreparation?.finish(['The main window changed while preparing to restart.']);
  return new Promise((resolvePreparation) => {
    const requestId = randomUUID();
    let settled = false;
    let released = false;
    const timer = setTimeout(() => finish(['The main window did not confirm saved state in time.']), RENDERER_RESTART_PREPARE_TIMEOUT_MS);
    timer.unref?.();
    const release = () => {
      if (released) return;
      released = true;
      try {
        if (!sender.isDestroyed()) sender.send('updates:restart-released', { requestId });
      } catch (error) {
        console.error('[updates] could not release the renderer restart hold:', error);
      }
    };
    const finish = (blockers: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingRestartPreparation?.requestId === requestId) pendingRestartPreparation = null;
      resolvePreparation({ blockers, release });
    };
    pendingRestartPreparation = { requestId, sender, finish };
    try {
      sender.send('updates:prepare-restart', { requestId, version });
    } catch (error) {
      finish([`The main window could not prepare for restart: ${(error as Error).message}`]);
    }
  });
}

/** Resolve a preparation immediately; the coordinator will release its renderer hold in finally. */
function cancelPendingRendererPreparation(reason: string): void {
  pendingRestartPreparation?.finish([reason]);
}

automaticRestartCoordinator = new AutomaticRestartCoordinator({
  state: () => updates.state(),
  blockers: updateRestartBlockers,
  prepareRenderer: prepareRendererForUpdate,
  target: () => updates.restartTarget(process.argv.slice(1)),
  claim: (version) => updates.claimAutomaticRestart(version),
  beginCommit: () => {
    automaticRestartCommitting = true;
  },
  endCommit: () => {
    automaticRestartCommitting = false;
  },
  relaunch: (target) => relaunchAfterExit(target, process.env),
  quit: () => {
    console.log(`[updates] ${updates.state().readyVersion} is installed; restarting the idle application`);
    quitApplication();
  },
  report: (state) => {
    updates.setAutomaticRestartState(state);
  },
  log: (message, error) => console.error(message, error),
});

const recoveryPageName = 'recovery.html';

/** Where the recovery page lives: a separate, dependency-light entry that loads even when the
 * main renderer bundle is the thing that broke (dev: served beside index.html by Vite). */
function recoveryPageUrl(): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    const base = process.env.VITE_DEV_SERVER_URL.endsWith('/')
      ? process.env.VITE_DEV_SERVER_URL
      : `${process.env.VITE_DEV_SERVER_URL}/`;
    return new URL(recoveryPageName, base).toString();
  }
  return join(__dirname, '../renderer', recoveryPageName);
}

/** True when the window is already showing the recovery page, so a crash cannot re-engage it. */
function isRecoveryPage(window: BrowserWindow): boolean {
  return window.webContents.getURL().endsWith(recoveryPageName);
}

/** Loads the app's own page back into a window: a repair is done, or the shell was left. */
async function loadAppInto(window: BrowserWindow): Promise<void> {
  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Hands the window over to the recovery shell. Called from a crash, a page that failed to load,
 * or the tray. The window is shown first (created if the renderer died with it), and the page is
 * only loaded once per engagement — later crashes just push the latest state into the page.
 */
async function engageRecovery(trigger: RecoveryTrigger): Promise<void> {
  recoveryShell.show(trigger);
  if (!mainWindow || mainWindow.isDestroyed()) {
    try {
      await createWindow();
    } catch (error) {
      console.error('[recovery] could not create a window to hold the shell:', error);
      return;
    }
  }
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (!isRecoveryPage(window)) {
    if (process.env.VITE_DEV_SERVER_URL) await window.loadURL(recoveryPageUrl());
    else await window.loadFile(recoveryPageUrl());
  }
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function createWindow() {
  const desktop = desktopPreferencesStore.get();
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: 'Antimatter',
    frame: desktop.windowStyle === 'native',
    alwaysOnTop: desktop.alwaysOnTop,
    backgroundColor: appearanceBackground(appearanceStore.get()),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      spellcheck: true,
    },
  });
  mainWindow = window;
  desktopPreferencesIpc.attach(window, desktop.windowStyle === 'custom');
  installSpellingMenu(window, () => isAppearancePage(
    window.webContents.getURL(), 'index.html', join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL,
  ));
  // Only an explicitly started voice session in our top-level app can request a microphone.
  // Preview sessions have their own deny-all handlers and never receive the voice bridge.
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (!isVoiceRenderer(contents)) return false;
    if (permission === 'media') return mayCaptureVoice({ trustedMain: true,
      active: voiceSession.snapshot().active && voiceHasVisibleControls(),
      mainFrame: details.isMainFrame, mediaTypes: [details.mediaType ?? 'unknown'] });
    return permission === 'clipboard-sanitized-write';
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, answer, details) => {
    answer(permission === 'media' && mayCaptureVoice({ trustedMain: isVoiceRenderer(contents), active: voiceSession.snapshot().active && voiceHasVisibleControls(),
      mainFrame: details.isMainFrame, mediaTypes: ('mediaTypes' in details ? details.mediaTypes : []) ?? [] }));
  });

  // A live interactive turn belongs to this renderer: it owns the visible response row and any
  // approval prompt. If that renderer reloads or crashes, continuing would strand approvals and
  // let a replacement UI mistake the run for restorable history. Ordinary window close only
  // hides the window, so it deliberately does not take this path.
  let rendererLoaded = false;
  window.webContents.on('did-finish-load', () => {
    rendererLoaded = true;
  });
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (rendererLoaded && isMainFrame && !isInPlace) {
      stopVoice();
      // A native child view outlives the DOM that positioned it. Tear it down before a reload,
      // recovery navigation or renderer replacement can leave a remote page covering the new UI.
      pane.close();
      abortInteractiveTurns();
      remoteHost?.cancelPairingOffers();
    }
    if (isMainFrame && !isInPlace) rendererLoaded = false;
  });
  // A dead or failing renderer is precisely what the recovery shell exists for: abort any turn
  // that belonged to the old page (the replacement cannot inherit its approvals), then hand the
  // window over to the shell so it can repair whatever broke and bring the app back.
  window.webContents.on('render-process-gone', (_event, details) => {
    stopVoice();
    pane.close();
    abortInteractiveTurns();
    remoteHost?.cancelPairingOffers();
    void engageRecovery({
      kind: 'render-process-gone',
      detail: `${details.reason} (exit ${details.exitCode})`,
      at: Date.now(),
    });
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    // ERR_ABORTED (-3) is a normal stop — a reload cancelled, a navigation replaced — not a
    // failure, and engaging the shell for it would bounce the very page trying to load once.
    if (!isMainFrame || errorCode === -3) return;
    // The recovery page itself failing is its own problem; do not engage on top of it.
    if (isRecoveryPage(window)) return;
    void engageRecovery({
      kind: 'did-fail-load',
      detail: `${errorDescription} (${errorCode})`,
      at: Date.now(),
    });
  });
  window.webContents.on('destroyed', () => {
    stopVoice();
    pane.close();
    abortInteractiveTurns();
    remoteHost?.cancelPairingOffers();
  });

  // Developer tools keyboard shortcuts
  window.webContents.on('before-input-event', (event, input) => {
    // F12 or Ctrl+Shift+I to open developer tools
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      event.preventDefault();
      window.webContents.toggleDevTools();
    }
    // Alt+Shift+D or Ctrl+Shift+J to open console
    if ((input.alt && input.shift && input.key === 'D') || (input.control && input.shift && input.key === 'J')) {
      event.preventDefault();
      window.webContents.openDevTools({ mode: 'bottom' });
    }
  });

  window.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url).catch((error) =>
        console.error(`[window] could not open external URL ${details.url}:`, error)
      );
    }
    return { action: 'deny' };
  });

  // Closing a desktop chat window backgrounds the application. The tray's Quit action is the
  // explicit boundary that tears down agents, terminals, MCP servers and our Beholdd child.
  //
  // Inference does not survive the background, though: the loopback model servers hold the whole
  // Vulkan carveout, and a closed window means the user wants it back. Agents and MCP keep
  // running, so an engine still serving a turn is released when that turn ends rather than
  // killed under it, and the next request starts it again.
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hideWindowWithPreviewCleanup({
      closePage: () => pane.close(),
      clearRenderer: () => send('preview:dismissed', null),
      hideWindow: () => window.hide(),
    });
    void localEngines.background();
  });

  window.on('hide', () => {
    remoteHost?.cancelPairingOffers();
    // Background listening needs a visible, controllable desktop indicator.
    if (voiceSession.snapshot().active && !desktopAvatar?.visible()) stopVoice();
  });

  window.on('minimize', () => {
    remoteHost?.cancelPairingOffers();
    if (voiceSession.snapshot().active && !desktopAvatar?.visible()) stopVoice();
  });

  const importOwner = window.webContents.id;
  window.on('closed', () => {
    chatImports.discard(importOwner);
    // The preview page is a child of this window; leaving it alive would strand a renderer
    // process behind a window that no longer exists.
    pane.close();
    if (mainWindow === window) mainWindow = null;
  });

  await loadAppInto(window);
  // A window exists again — including the replacement built when showMainWindow found the old
  // one destroyed, which returns before it can say so itself. Engines stay resident while it is
  // open rather than being released the moment they fall idle.
  localEngines.foreground();
}

let aboutWindow: BrowserWindow | null = null;

function createAboutWindow() {
  console.log('[about] creating window...');
  
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    console.log('[about] window already exists, focusing...');
    aboutWindow.focus();
    return;
  }
  
  const window = new BrowserWindow({
    width: 600,
    height: 500,
    parent: mainWindow ?? undefined,
    modal: true,
    show: false,
    frame: false,
    title: 'About Antimatter',
    backgroundColor: appearanceBackground(appearanceStore.get()),
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });
  
  aboutWindow = window;
  window.once('ready-to-show', () => { window.center(); window.show(); });
  
  // Developer tools keyboard shortcuts
  window.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      event.preventDefault();
      window.webContents.toggleDevTools();
    }
  });
  
  window.on('closed', () => {
    console.log('[about] window closed');
    if (aboutWindow === window) aboutWindow = null;
  });
  
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[about] failed to load:', errorCode, errorDescription);
  });
  
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = `${process.env.VITE_DEV_SERVER_URL}about.html`;
    console.log('[about] loading URL:', url);
    void window.loadURL(url);
  } else {
    // Vite emits every renderer entry beneath dist-electron/renderer, beside the bundled main
    // process. Source paths do not exist in an installed AppImage.
    const path = join(__dirname, '../renderer/about.html');
    console.log('[about] loading file:', path);
    void window.loadFile(path).catch((err) => console.error('[about] loadFile error:', err));
  }
}

function showMainWindow(): void {
  if (!desktopReady) return;
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    void createWindow().catch((error) => console.error('[window] could not create the main window:', error));
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  // Back in the foreground: engines stay resident again instead of being released on idle.
  localEngines.foreground();
}

/** The explicit exit: tears down agents, terminals, MCP servers and the Beholdd child (see will-quit). */
function quitApplication(): void {
  quitting = true;
  app.quit();
}

function createTray(): void {
  if (tray) return;

  // nativeImage does not decode SVG data URLs on Linux, so keep the tiny 36px atom as PNG data.
  const iconData =
    'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAABYElEQVR4nO2Xwa3CMAyGMwJHWAGJjWAGNuDKHg8JBJO8Oz3CoSd2gBQ/VXKfLGMcG6Ulh/5SJBR+x5+cNnVCGDVqQAFADQARAC4G7xW9dR8gE5D1FLzPN95JTqCUfgBglzLlgql4VZQqcF/D5s45gGjySOanCsyM+CKFzA20ZP/x6rWqmGfZJ9CKzC+UCi2GAqpx8GdDUkP8WYGiktSraEj5FsRShU/VeEAs506nexuzuW3n7cD4hyPeBCRJPHcQ5Hdz2wKO9vfcs0YKhgftcX4trHViMP9QAHAU/Gtc68BBTdVJVQ6rw2G68VIlT66igfiWHZQtOypbdhL83Zbt2bx+NgkLwdce6uB/7R/h9bW/O+KTPBSsjINRACvj00GAivu4iv2Qo/1YDQIUCmnQaAs7Uyo0Jb7sLeyZJWscTT73VYaUJqiUdngVUpUFJpR4USTJuqv01eC99HaVHjVK0R+wph+HkItSkQAAAABJRU5ErkJggg==';
  const icon = nativeImage
    .createFromDataURL(`data:image/png;base64,${iconData}`)
    .resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Antimatter');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Antimatter', click: showMainWindow },
      { label: 'Show desktop avatar', click: () => { void desktopAvatar?.update({ enabled: true }).catch(console.error); } },
      {
        label: 'Recovery shell',
        click: () =>
          void engageRecovery({
            kind: 'requested',
            detail: 'opened from the tray',
            at: Date.now(),
          }),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: quitApplication,
      },
    ])
  );
  tray.on('click', showMainWindow);
}

// Inference source IPC handlers
ipcMain.handle('providers:list', () => {
  const allowed = beholdd.qualifiedModelScope();
  return sourceStore.listPublic().map((source) => !allowed || source.id !== llamaVulkan.BUNDLED_BEHOLDD_SOURCE_ID ? source : {
    ...source, name: `${source.name} — OpenMythos HAG only`,
    models: source.models.map((model) => model.id === allowed ? model : {
      ...model, name: `${model.name || model.id} — unavailable in this HAG service`,
    }),
  });
});

ipcMain.handle('providers:add', (_event, input: unknown) => {
  const source = validateNewSource(input, new Set(sourceStore.listPublic().map((entry) => entry.id)));
  // A refresh replaces the model list with what the server reports, which never includes the
  // downloaded models registered on it by path; those are carried over rather than silently lost.
  const saved = sourceStore.save(hub.withRegisteredModels(source));
  providerManager.addConfig(saved);
  // A source that was just added may be the one that can see, and a source that was just
  // re-probed may have had a projector loaded since. Either way what was learned is now stale.
  eyes.forget();
  return sourceStore.publicSource(saved);
});

ipcMain.handle('providers:delete', async (_event, id: string) => {
  if (id === HAG_SOURCE_ID) { await hag.disable(); return true; }
  providerManager.removeProvider(id);
  sourceStore.remove(id);
  eyes.forget();
  return true;
});

ipcMain.handle('providers:credential-replace', (_event, input: unknown) => {
  assertNotCommittingAutomaticRestart();
  const { id, apiKey } = validateCredentialUpdate(input);
  const saved = sourceStore.replaceCredential(id, apiKey);
  if (!saved) throw new Error(`Inference source "${id}" is not configured.`);
  providerManager.addConfig(saved);
  send('providers:changed', { at: Date.now() });
  return sourceStore.publicSource(saved);
});

/**
 * Source-scoped catalog edits resolve the source here, where its credential lives. The renderer
 * supplies only an id and model metadata; returning the public allowlisted DTO keeps keys from
 * crossing IPC in either direction.
 */
const mutateModelCatalog = (
  sourceId: string,
  mutate: (source: InferenceSource) => InferenceSource
) => {
  assertNotCommittingAutomaticRestart();
  const source = sourceStore.find(sourceId);
  if (!source) throw new Error(`Inference source "${sourceId}" is not configured.`);
  const saved = sourceStore.save(mutate(source));
  providerManager.addConfig(saved);
  eyes.forget();
  return sourceStore.publicSource(saved);
};

ipcMain.handle('providers:model-declare', (_event, sourceId: string, model: ModelDeclaration) => {
  const updated = mutateModelCatalog(sourceId, (source) => modelCatalog.declareModel(source, model));
  send('providers:changed', { at: Date.now() });
  return updated;
});

ipcMain.handle(
  'providers:model-update',
  (_event, sourceId: string, modelId: string, patch: ModelMetadataPatch) => {
    const updated = mutateModelCatalog(sourceId, (source) =>
      modelCatalog.updateModelMetadata(source, modelId, patch)
    );
    send('providers:changed', { at: Date.now() });
    return updated;
  }
);

ipcMain.handle('providers:model-remove', (_event, sourceId: string, modelId: string) => {
  const updated = mutateModelCatalog(sourceId, (source) => modelCatalog.removeDeclaredModel(source, modelId));
  modelProfiles.setOverride(sourceId, modelId, null);
  const choice = modelChoice.read();
  if (choice?.providerId === sourceId && choice.modelId === modelId) {
    const replacement = updated.models[0]?.id;
    if (replacement) modelChoice.save({ providerId: sourceId, modelId: replacement });
    else modelChoice.clear();
  }
  send('providers:changed', { at: Date.now() });
  return updated;
});

ipcMain.handle(
  'providers:probe',
  (_event, input: unknown) => {
    const options = validateProbeInput(input);
    return probeSource(options.baseUrl, options.apiKey, options.protocol);
  }
);

/** Uses the stored endpoint and credential, neither of which the renderer can substitute. */
const inspectStoredSource = async (id: string, persist: boolean) => {
  const source = sourceStore.find(id);
  if (!source) throw new Error(`Inference source "${id}" is not configured.`);
  const deps = {
    probe: probeSource,
    current: sourceStore.find,
    save: (next: InferenceSource) => sourceStore.save(hub.withRegisteredModels(next)),
  };
  const result = id === llamaVulkan.SOURCE_ID || isWorkloadSource(id)
    ? await inspectManagedSource(source, persist, { ...deps, connectionFor: llamaVulkan.connectionFor })
    : await refreshSource(source, persist, deps);
  if (result.saved) {
    providerManager.addConfig(result.saved);
    eyes.forget();
  }
  return result.probe;
};

ipcMain.handle('providers:test', (_event, id: string) => inspectStoredSource(id, false));
ipcMain.handle('providers:refresh', (_event, id: string) => inspectStoredSource(id, true));

ipcMain.handle('providers:storeInfo', () => ({
  path: sourceStore.storeLocation(),
  encrypted: sourceStore.keysAreEncrypted(),
}));

/**
 * Whether the selected source can be sent a turn yet.
 *
 * Polled from the renderer the way the monitor polls vitals, so a window that is not asking costs
 * nothing and there is nothing to unregister. A stopped source opens the first-request path only
 * when its real lifecycle can verify the installed runtime and model/configuration. Polling never
 * starts, adopts, resets, or stops an engine.
 */
ipcMain.handle('providers:readiness', async (_event, id: string): Promise<SourceReadiness> => {
  const source = typeof id === 'string' ? sourceStore.find(id) : undefined;
  if (!source) return { state: 'unreachable', detail: 'This inference source is no longer configured. Choose a model in Models.' };
  let result: SourceReadiness;
  if (id === HAG_SOURCE_ID) {
    result = hag.readiness();
  } else if (id === llamaVulkan.SOURCE_ID || isWorkloadSource(id)) {
    result = await managedSourceReadiness(id, {
      connectionFor: llamaVulkan.connectionFor, read: readSourceReadiness,
      startup: () => llamaVulkan.startupReadiness(isWorkloadSource(id) ? workloadDeployments.runtime(id) : undefined),
    });
  } else if (id === llamaVulkan.BUNDLED_BEHOLDD_SOURCE_ID) {
    result = await readSourceWithStartup(source, () => beholddStartupReadiness({
      ...beholdd.info(), canPrepareConfig: () => hub.registrar.canPrepareStart(),
    }));
  } else if (engineEndpoint(source.baseUrl)) {
    result = await readSourceWithStartup(source, () => localEngines.startability({
      sourceId: id, baseUrl: source.baseUrl, model: source.models.length === 1 ? source.models[0].id : null,
    }));
  } else result = await readSourceReadiness(source);
  const current = sourceStore.find(id);
  // A source edited while a poll was in flight needs a fresh observation of the new endpoint.
  return current && current.baseUrl === source.baseUrl && current.apiKey === source.apiKey &&
    JSON.stringify(current.models) === JSON.stringify(source.models) ? result : { state: 'unknown' };
});

/**
 * The source/model inherited by an unpinned agent. Seed it from the durable picker choice so a
 * scheduled run before the first chat turn still uses what the window opened on.
 */
const lastUsed = createLastUsedModel(modelChoice.read());

// The model chat opens on, remembered once per install rather than once per renderer origin.
ipcMain.handle('model:get', () => modelChoice.read());
ipcMain.handle('model:set', (_event, providerId: string, modelId: string, workloadId?: unknown) => {
  assertNotCommittingAutomaticRestart();
  // Selection is metadata-only. Every provider prepares its engine at the first actual request.
  return selectModel(providerId, modelId, workloadId, { source: (id) => providerManager.getConfig(id),
    hasWorkload: modelProfiles.hasWorkload, save: modelChoice.save,
    selected: (saved) => { lastUsed.select(saved.providerId, saved.modelId); } });
});

/**
 * What local engines are holding, and putting it down again.
 *
 * A model stays resident after the turn that loaded it, which is what makes the next turn fast
 * and what eventually fills the card. Freeing one used to mean stopping the server, and that
 * takes every conversation and agent pointed at it too.
 */
const residencySource = (id: string) => {
  const source = sourceStore.find(id);
  if (!source) throw new Error(`Inference source "${id}" is not configured.`);
  return { id: source.id, baseUrl: source.baseUrl, apiKey: source.apiKey, kind: source.kind };
};

ipcMain.handle('residency:list', async (): Promise<SourceResidency[]> => {
  const sources = sourceStore.list().filter((source) => reportsResidency(source.kind));
  const reports = await Promise.all(
    sources.map((source) =>
      readResidency({ id: source.id, baseUrl: source.baseUrl, apiKey: source.apiKey, kind: source.kind })
    )
  );
  // A model answering a turn is the one thing someone must know before freeing it, and the
  // renderer cannot see it: agents and remote turns run with no window involved.
  const busy = modelUse.inUse();
  return reports.map((report) => ({
    ...report,
    models: report.models.map((model) => {
      const turns = busy.find((entry) => entry.providerId === report.sourceId && entry.modelId === model.id)?.turns ?? 0;
      return turns ? { ...model, turns } : model;
    }),
  }));
});

ipcMain.handle('residency:unload', async (_event, sourceId: string, modelId: string) => {
  assertNotCommittingAutomaticRestart();
  await unloadModel(residencySource(sourceId), modelId);
});

// Developer settings: how a turn is run, rather than which model runs it. One per install, and
// read on every turn so a change takes effect on the next one without a restart.
ipcMain.handle('developer:get', () => developerSettings.read());
ipcMain.handle('developer:set', (_event, next: unknown) => {
  assertNotCommittingAutomaticRestart();
  return developerSettings.save(next);
});

/**
 * The Vault: credentials the user holds and a turn may spend with their approval.
 *
 * Secrets travel one way across this boundary. `vault:save` carries a value the person just typed
 * inward, where it is sealed by the OS keyring and forgotten; nothing here ever sends one back
 * out, so the renderer can show what the Vault holds but never what any of it is. Every handler
 * is pinned to the main window: a detached window, an about panel or a preview frame has no
 * business managing credentials.
 */
ipcMain.handle('vault:status', (event) => {
  requireMainFrame(event);
  return vaultStore.status();
});
ipcMain.handle('vault:set-enabled', (event, enabled: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  const status = vaultStore.setEnabled(enabled === true);
  // Turning the Vault off revokes what is already armed, rather than letting a running turn
  // finish spending a credential the person has just withdrawn.
  if (!status.enabled) vaultGrants.releaseAll();
  return status;
});
ipcMain.handle('vault:save', (event, input: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  const entry = (input && typeof input === 'object' ? input : {}) as vaultStore.VaultEntryInput;
  const status = vaultStore.save(entry);
  // A replaced secret must not leave the superseded value armed in a turn that is still running.
  vaultGrants.releaseAll();
  return status;
});
ipcMain.handle('vault:remove', (event, tag: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  const status = vaultStore.remove(String(tag ?? ''));
  vaultGrants.releaseAll();
  return status;
});

/**
 * Memory: the notes conversations keep, and a project's own instructions (see memory/). The page
 * reads the workspace the tools point at, because that is where the next turn will run.
 *
 * A change made here is a person's, so it bumps the revision: conversations already open read
 * their notes again on their next turn instead of going on with the ones they started with.
 */
const memoryChanged = () => send('memory:changed', { at: Date.now() });

ipcMain.handle('setup:get', (event) => { requireMainFrame(event); return setupStore.get(); });
ipcMain.handle('setup:assistant', (event, patch: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  const state = setupStore.updateAssistant(patch);
  memoryStore.bumpRevision();
  memoryChanged();
  send('setup:changed', state);
  return state;
});
ipcMain.handle('setup:complete', (event) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  const state = setupStore.complete();
  send('setup:changed', state);
  return state;
});

ipcMain.handle('memory:state', (_event, target: unknown) => pageState(target, mcpStore.workspace()));
ipcMain.handle('memory:settings', (_event, patch: unknown) => {
  assertNotCommittingAutomaticRestart();
  const saved = memoryStore.saveSettings(patch);
  memoryChanged();
  return saved;
});
ipcMain.handle('memory:save', (_event, target: unknown, scope: unknown, input: unknown) => {
  assertNotCommittingAutomaticRestart();
  const where = parseScope(scope);
  const project = where === 'project' ? resolveTarget(target, mcpStore.workspace()).root : null;
  const note = (input && typeof input === 'object' ? input : {}) as { id?: unknown; name?: unknown; description?: unknown; content?: unknown };
  const saved = memoryStore.saveNote(where, project, {
    id: typeof note.id === 'string' ? note.id : undefined,
    name: typeof note.name === 'string' ? note.name : '',
    description: typeof note.description === 'string' ? note.description : '',
    content: typeof note.content === 'string' ? note.content : '',
  });
  memoryStore.bumpRevision();
  memoryChanged();
  return saved.note;
});
ipcMain.handle('memory:remove', (_event, target: unknown, scope: unknown, id: unknown) => {
  assertNotCommittingAutomaticRestart();
  const where = parseScope(scope);
  const project = where === 'project' ? resolveTarget(target, mcpStore.workspace()).root : null;
  const removed = memoryStore.removeNote(where, project, String(id ?? ''));
  if (removed) {
    memoryStore.bumpRevision();
    memoryChanged();
  }
  return removed;
});
ipcMain.handle('memory:open-folder', async (_event, target: unknown, scope: unknown) => {
  const where = parseScope(scope);
  const project = where === 'project' ? resolveTarget(target, mcpStore.workspace()).root : null;
  const directory = memoryStore.directoryFor(where, project, true);
  ensurePrivateDirectory(directory);
  const failure = await shell.openPath(directory);
  if (failure) throw new Error(failure);
});
/**
 * Who Antimatter is talking to: the card on the Settings page. A person editing it bumps the
 * same revision the notes use, so a conversation already open is told on its next turn.
 */
ipcMain.handle('user:get', () => person.read());
ipcMain.handle('user:set', (_event, patch: unknown) => {
  assertNotCommittingAutomaticRestart();
  const saved = person.save(patch);
  memoryStore.bumpRevision();
  memoryChanged();
  return saved;
});

ipcMain.handle('memory:open-instructions', async (_event, target: unknown, path: unknown) => {
  const file = openableInstruction(target, mcpStore.workspace(), path);
  if (!file) throw new Error('That file is not one of this project\'s instructions.');
  const failure = await shell.openPath(file);
  if (failure) throw new Error(failure);
});

/**
 * The window and output ceiling for one model. The server's own reported context — captured by
 * the probe when the source was added — is the authority; everything else is a fallback the UI
 * labels as such.
 */
function savedProfileFor(providerId: string, modelId: string, workloadId?: string) {
  const source = providerManager.listProviders().find((entry) => entry.id === providerId);
  const model = source?.models.find((entry) => entry.id === modelId);
  return modelProfiles.resolve({
    providerId, modelId, workloadId,
    serverContextTokens: model?.contextWindow,
  });
}

/**
 * The profile a turn runs under. Without an explicit workload it uses the one the current chat
 * selection named, so launching `coding 32k` governs the next turn without being a stored
 * property of the model — see ADR 0001.
 */
function profileFor(providerId: string, modelId: string, workloadId?: string) {
  assertRuntimeProfileReady(providerId);
  const chosen = workloadId ?? selectedWorkloadFor(providerId, modelId);
  const source = providerManager.listProviders().find((entry) => entry.id === providerId);
  const effective = modelProfiles.resolveSourceProfile(source?.models ?? [], providerId, modelId, chosen);
  return modelProfiles.withEngineContext(effective, runtimeProfiles?.contextLimit(providerId, modelId) ?? null);
}

/** The workload the live selection names for this exact model, when it still exists. */
function selectedWorkloadFor(providerId: string, modelId: string): string | undefined {
  const choice = modelChoice.read();
  if (!choice?.workloadId || choice.providerId !== providerId || choice.modelId !== modelId) return undefined;
  return modelProfiles.hasWorkload(providerId, modelId, choice.workloadId) ? choice.workloadId : undefined;
}

// Editors round-trip saved preferences. Exposing a server's temporary cap here would make an
// unrelated instruction edit persist the smaller context/reply budget over Straight shot.
/**
 * ADR 0001 split the `profiles:` prefix, which named two unrelated stores. These channels are
 * the per-model half: the resolved profile, and the named workloads it resolves from.
 */
ipcMain.handle('model-workloads:resolve', (_event, providerId: string, modelId: string) => savedProfileFor(providerId, modelId));
ipcMain.handle('model-workloads:setDefaultSettings', (_event, providerId: string, modelId: string, patch: modelProfiles.ProfileOverride | null) => {
  modelProfiles.setOverride(providerId, modelId, patch);
  return savedProfileFor(providerId, modelId);
});
ipcMain.handle('model-workloads:storeInfo', () => ({ path: modelProfiles.storeLocation() }));

/**
 * The declared boxes, from the recipes that already name them — ADR 0001 stage 4. Probing is one
 * connection per node in parallel, so an unreachable roster costs one timeout rather than several.
 */
ipcMain.handle('nodes:list', (event) => {
  requireMainFrame(event);
  return listNodes({
    recipes: () => recipes.list(),
    probe: (host, port) => recipes.peerAnswers(host, port),
    // Paired boxes, and what they say about themselves. A report that never arrives leaves the
    // row saying so; it never becomes a capacity figure.
    paired: () => nodePeers?.list().map((peer) => ({ key: peer.key, name: peer.name, endpoint: peer.endpoint })) ?? [],
    report: async (key) => {
      const target = requireNodePeers().target(key);
      if (!target) throw new Error('That box is no longer paired.');
      try {
        const report = await requestReport(target, target.credential);
        requireNodePeers().touch(key);
        return report;
      } catch (cause) {
        requireNodePeers().fail(key, cause);
        throw cause;
      }
    },
    // Local capacity comes from the driver, via the same sysfs/nvidia-smi readings the Vitals
    // panel uses. Several accelerators sum, and a device that publishes nothing stays unknown
    // rather than counting as zero free.
    localMemory: async () => {
      const readings = await vitalsSources.gpus();
      const known = readings.filter((gpu) => gpu.memoryTotal !== null);
      if (!known.length) return { free: null, total: null };
      const total = known.reduce((sum, gpu) => sum + (gpu.memoryTotal ?? 0), 0);
      const used = known.reduce((sum, gpu) => sum + (gpu.memoryUsed ?? 0), 0);
      return { free: Math.max(0, total - used), total };
    },
    localName: () => hostname(),
  });
});
ipcMain.handle('nodes:storeInfo', (event) => { requireMainFrame(event); return { path: recipes.location() }; });
ipcMain.handle('model-workloads:list', (event, providerId: string, modelId: string) => {
  requireMainFrame(event);
  return modelProfiles.listWorkloads(providerId, modelId);
});
ipcMain.handle('model-workloads:create', (event, providerId: string, modelId: string, input: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  return modelProfiles.createWorkload(providerId, modelId, (input ?? {}) as { name: unknown });
});
ipcMain.handle('model-workloads:update', (event, providerId: string, modelId: string, id: unknown, patch: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  return modelProfiles.updateWorkload(providerId, modelId, id, (patch ?? {}) as Record<string, unknown>);
});
ipcMain.handle('model-workloads:remove', (event, providerId: string, modelId: string, id: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  return modelProfiles.removeWorkload(providerId, modelId, id);
});
ipcMain.handle('model-workloads:setDefault', (event, providerId: string, modelId: string, id: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  return modelProfiles.setDefaultWorkload(providerId, modelId, id);
});

// Chat IPC handlers
ipcMain.handle('chat:complete', async (_event, request: ChatRequest) => {
  assertNotCommittingAutomaticRestart();
  request = { ...request, messages: sanitizeConversationRequest(request.messages) };
  rememberInteractiveTurn(request);
  const provider = providerManager.getProvider(request.providerId);
  if (!provider) throw new Error(`Provider ${request.providerId} not found`);
  const profile = profileFor(request.providerId, request.model);
  const brief = renderAssistantIdentity(setupStore.get().assistant);
  const messages = brief ? [{ id: 'assistant-identity', role: 'system' as const,
    content: mergeInstructions(brief, ...request.messages.filter((message) => message.role === 'system').map((message) => message.content)) ?? '' },
    ...request.messages.filter((message) => message.role !== 'system')] : request.messages;
  return provider.chat({ ...request, messages, thinkingLevel: profile.thinkingLevel });
});

/**
 * Folds the messages falling out of the window into a paragraph the model can still use.
 *
 * A summary costs a whole completion, which on a slow local model is not free — so it is a
 * per-model setting, and a failure is never fatal: the turn continues with the plain marker,
 * because losing the tail of a conversation is worse than losing its middle.
 */
async function summarizeDropped(
  provider: { chat(request: ChatRequest, signal?: AbortSignal): Promise<string> },
  profile: ReturnType<typeof profileFor>,
  dropped: ChatRequest['messages'],
  signal?: AbortSignal
): Promise<string | undefined> {
  const request = compactionRequest(profile, dropped);
  if (!request) return undefined;
  try {
    const summary = await provider.chat(request, signal);
    return summary.trim() || undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error('[context] could not summarize the dropped messages:', error);
    return undefined;
  }
}

interface PendingApproval {
  runId: string;
  settle(approved: boolean): void;
}

/** Approvals in flight, keyed by a run-scoped id rather than a provider-owned call id. */
const pendingApprovals = new Map<string, PendingApproval>();

function askPermission(
  payload: Record<string, unknown> & { callId: string; approvalId?: string; runId?: string },
  signal?: AbortSignal
): Promise<boolean> {
  const runId = payload.runId ?? String(payload.requestId ?? 'unknown-run');
  const approvalId = payload.approvalId ?? `${runId}:${payload.callId}`;

  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => finish(false);
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (pendingApprovals.get(approvalId)?.settle === finish) pendingApprovals.delete(approvalId);
      resolve(approved);
    };

    // A broken provider should not be able to strand an older prompt by reusing its call id.
    pendingApprovals.get(approvalId)?.settle(false);
    pendingApprovals.set(approvalId, { runId, settle: finish });
    if (signal?.aborted) finish(false);
    else {
      signal?.addEventListener('abort', onAbort, { once: true });
      send('tools:approval-request', { ...payload, approvalId });
    }
  });
}

function settleApprovalsForRun(runId: string): void {
  for (const pending of [...pendingApprovals.values()]) {
    if (pending.runId === runId) pending.settle(false);
  }
}

interface PendingQuestion {
  runId: string;
  /** What was asked, kept so an answer can be checked against the options really offered. */
  request: AskRequest;
  settle(outcome: AskOutcome): void;
}

/**
 * Questions waiting on a person, keyed the way the card derives the key — see `askIdFor`.
 *
 * Deliberately a sibling of `pendingApprovals` rather than a reuse of it. The two look alike and
 * are not: an approval is a yes or no about something the model is about to do, and defaults to
 * no, because the safe answer when nobody replies is to not do the thing. A question has no safe
 * default at all — there is no answer that is the cautious one — so an unanswered question
 * resolves as `interrupted` and the model is told plainly that nothing was decided.
 */
const pendingQuestions = new Map<string, PendingQuestion>();

/**
 * Put a question to the person and wait.
 *
 * The question reaches the window twice over, and both matter. It is already in the activity
 * stream, which is what draws the card in the transcript and what rebuilds it after a reload —
 * that is the surface the answer comes from. The `ask:waiting` event is the nudge: it is what
 * lets a toast appear when the answer is wanted and the conversation is not what the person is
 * looking at. Losing the nudge costs a notification; losing the activity would cost the answer.
 */
function askQuestion(
  context: { runId: string; threadId?: string; askId: string; request: AskRequest },
  signal?: AbortSignal
): Promise<AskOutcome> {
  const { askId, runId, request } = context;
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => finish({ kind: 'interrupted', answers: [], note: null });
    const finish = (outcome: AskOutcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (pendingQuestions.get(askId)?.settle === finish) pendingQuestions.delete(askId);
      // Retires the nudge wherever it is showing. The card stops offering buttons because the
      // activity it is drawn from settles; this is only for the toast, which has no activity.
      send('ask:settled', { askId, runId, threadId: context.threadId, outcome: outcome.kind });
      resolve(outcome);
    };

    pendingQuestions.get(askId)?.settle({ kind: 'interrupted', answers: [], note: null });
    pendingQuestions.set(askId, { runId, request, settle: finish });
    if (signal?.aborted) finish({ kind: 'interrupted', answers: [], note: null });
    else {
      signal?.addEventListener('abort', onAbort, { once: true });
      send('ask:waiting', {
        askId,
        runId,
        threadId: context.threadId,
        // Sent as the parsed, capped questions rather than the model's raw arguments: the toast
        // shows this text, and it should be the same text the card shows, bounded the same way.
        questions: request.questions,
      });
    }
  });
}

function settleQuestionsForRun(runId: string): void {
  for (const pending of [...pendingQuestions.values()]) {
    if (pending.runId === runId) pending.settle({ kind: 'interrupted', answers: [], note: null });
  }
}

/**
 * The person's answer, arriving from the window.
 *
 * Returns false when there is nothing waiting under that id, which is the card's cue that it is
 * stale — the turn ended, or it was answered in another window — so it can say so instead of
 * appearing to have worked.
 */
function resolveQuestion(askId: string, outcome: unknown): boolean {
  const pending = pendingQuestions.get(askId);
  if (!pending) return false;
  try {
    pending.settle(parseAskOutcome(outcome, pending.request));
  } catch (error) {
    // A malformed answer must not strand the turn behind a question that can never settle. The
    // model is told nothing was decided, which is true, rather than a guess at what was meant.
    console.error('[ask] could not read the answer:', error);
    pending.settle({ kind: 'interrupted', answers: [], note: null });
  }
  return true;
}

ipcMain.handle('ask:answer', (event, askId: unknown, outcome: unknown) => {
  requireMainFrame(event);
  return typeof askId === 'string' && resolveQuestion(askId, outcome);
});

function resolveToolApproval(approvalId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(approvalId);
  pending?.settle(approved);
  return !!pending;
}

ipcMain.handle('tools:approve', (_event, approvalId: string, approved: boolean) =>
  resolveToolApproval(approvalId, approved)
);

/**
 * Turns in flight, so one can be stopped.
 *
 * A local model can spend a long time on a turn you have already changed your mind about, and
 * until now the only way out was reloading the window. Aborting is carried all the way into the
 * fetch, so stopping also closes the connection rather than leaving the server generating tokens
 * nobody will read.
 */
const runningTurns = new Map<string, AbortController>();
const remoteInference = new RemoteInferenceState();
const activeThreads = new ActiveTurns();
const remoteDesktopTurns = new RemoteDesktopTurns((snapshot) => send('chat:remote-turns-changed', snapshot));
ipcMain.handle('chat:remote-turns-get', () => remoteDesktopTurns.snapshot());
const remoteLiveTranscript = new RemoteLiveTranscript();
const runtimeProfileBusy = (): boolean | string => {
  if (runningTurns.size || activeThreads.list().length || modelUse.inUse().length || providerManager.anyBusy() ||
      taskQueue.counts().running || orchestrator.snapshot().running.length) {
    return 'Wait for active chats, agents, and inference requests to finish before switching runtime profiles.';
  }
  return false;
};
const idleCompaction = new IdleCompaction<{
  transcriptFingerprint: string; messages: import('../api/types').Message[];
  providerId: string; modelId: string;
}, import('../api/types').Message[]>({
  file: join(app.getPath('userData'), 'idle-compaction.json'),
  busy: () => !desktopReady || quitting || !!runtimeProfileBusy() || !!runtimeProfiles?.isApplying() || !!nativeProject?.busy(),
  candidate: (threadId) => {
    const thread = conversations.snapshot().threads.find((entry) => entry.id === threadId);
    // Imported archives have no active host transcript or inferred provider selection.
    if (!thread?.providerId || !thread.modelId || thread.providerId === HAG_SOURCE_ID || activeThreads.runFor(threadId)) return null;
    const transcript = transcriptCache.snapshotForCompaction(threadId);
    if (!transcript) return null;
    return { threadId, fingerprint: `${thread.revision}:${thread.providerId}:${thread.modelId}:${transcript.fingerprint}`,
      estimatedTokens: conversationTokens(transcript.messages), payload: {
        transcriptFingerprint: transcript.fingerprint, messages: transcript.messages,
        providerId: thread.providerId, modelId: thread.modelId,
      } };
  },
  compact: async ({ payload }, signal) => {
    const provider = providerManager.getProvider(payload.providerId);
    if (!provider) return null;
    const profile = profileFor(payload.providerId, payload.modelId);
    return summarizeIdleConversation(payload.messages, profile,
      (request, cancellation) => provider.chat({ ...request, providerId: payload.providerId }, cancellation), signal);
  },
  commit: (candidate, result) => transcriptCache.commitCompaction(candidate.threadId, candidate.payload.transcriptFingerprint, result.payload),
  changed: (state) => send('idle-compaction:changed', state),
});
const runtimeProfiles = (() => {
  try {
    return new ModelRuntimeProfileStore(join(app.getPath('userData'), 'model-runtime-profiles.json'), {
      service: new LocalRuntimeServiceManager({ busy: runtimeProfileBusy }),
      source: (sourceId, modelId) => {
        const source = providerManager.listProviders().find((entry) => entry.id === sourceId);
        if (!source?.models.some((model) => model.id === modelId)) return null;
        return { baseUrl: source.baseUrl, model: modelId };
      },
      busy: runtimeProfileBusy,
      onChanged: (event) => send('model-runtime-profiles:changed', event),
    });
  } catch (error) {
    console.error('[runtime-profiles] saved profiles unavailable:', error);
    return null;
  }
})();
function assertRuntimeProfileReady(sourceId: string): void {
  // Two configured sources may address the same engine. Hold all new model work during the
  // short lifecycle transition, just as the switch requires all existing work to be idle.
  if (runtimeProfiles?.isApplying()) throw new Error(`A local engine is switching runtime profiles. Wait for the reload to finish before starting work on ${sourceId}.`);
}
function requireRuntimeProfiles(): ModelRuntimeProfileStore {
  if (!runtimeProfiles) throw new Error('Runtime profiles could not be opened. Their saved file was preserved; check the application log and restart after resolving the error.');
  return runtimeProfiles;
}
const chatCoordination = (() => {
  try {
    return new ChatCoordinationStore(join(app.getPath('userData'), 'chat-coordination.json'), {
      threads: () => conversations.snapshot().threads,
      activeRun: (threadId) => activeThreads.runFor(threadId),
      onChanged: (threadIds) => send('chat-coordination:changed', { threadIds }),
    });
  } catch (error) {
    // Preserve damaged state for recovery without making ordinary chats depend on this feature.
    console.error('[chat-coordination] connections unavailable:', error);
    return null;
  }
})();
const requireChatCoordination = (): ChatCoordinationStore => {
  if (!chatCoordination) throw new Error('Chat connections are unavailable because their saved state could not be opened. The file was preserved; check the application log before retrying after a restart.');
  return chatCoordination;
};
const botChat = (() => {
  try {
    return new BotChatStore(join(app.getPath('userData'), 'bot-chat.json'), {
      threads: () => conversations.chatMetadata(),
      activeRun: (threadId) => activeThreads.runFor(threadId),
      onChanged: (event) => send('bot-chat:changed', event),
    });
  } catch (error) {
    console.error('[bot-chat] saved channels unavailable:', error);
    return null;
  }
})();
/**
 * The way in for agents that do not run inside Antimatter.
 *
 * Swept on a timer rather than watched, because a watch fires while a file is
 * still being written and this would then read half of it. A few seconds of
 * latency on a chat message costs nothing; a truncated message costs a
 * misunderstanding.
 */
const botChatInbox = botChat
  ? new BotChatInbox(join(app.getPath('userData'), 'bot-chat-inbox'), {
      channelId: (name) => botChat.listChannels().find((channel) => channel.name === name)?.id ?? null,
      post: (channelId, body, name, clientMessageId, replyTo) => {
        botChat.postExternal(channelId, body, name, { clientMessageId, replyTo, mentionThreadIds: [] });
      },
      now: () => Date.now(),
      warn: (message) => console.warn(`[bot-chat] ${message}`),
    })
  : null;
if (botChatInbox) {
  try {
    botChatInbox.prepare();
    const sweep = () => {
      try {
        if (botChat?.enabled()) botChatInbox.sweep();
      } catch (error) {
        console.warn('[bot-chat] inbox sweep failed:', error);
      }
    };
    sweep();
    // Unref'd so a pending sweep never holds the process open at exit.
    setInterval(sweep, 5_000).unref();
  } catch (error) {
    console.error('[bot-chat] inbox unavailable:', error);
  }
}

function requireBotChat(): BotChatStore {
  if (!botChat) throw new Error('Bot chat could not open its saved channels. The file was preserved; check the application log and restart after resolving the error.');
  return botChat;
}
const coordinationTurnChanged = (threadId: string): void => {
  send('chat-coordination:changed', { threadIds: [threadId] });
  send('bot-chat:changed', { channelIds: [], threadIds: [threadId], settingsChanged: false });
};
const RENDERER_LOST_ABORT = 'antimatter:renderer-lost';

/** A replacement renderer cannot safely inherit another renderer's prompts or stream sinks. */
function abortInteractiveTurns(): void {
  for (const [runId, controller] of runningTurns) {
    if (activeThreads.recordForRun(runId)?.owner.kind === 'renderer') {
      controller.abort(RENDERER_LOST_ABORT);
    }
  }
}
interface RunningTurnCarbon {
  carbonKey: string;
  model: string;
  /** Visible assistant text accumulated so far. */
  partial: string;
  /** Prefix already written before tool entries, so shutdown never duplicates it. */
  flushedContentLength: number;
}

/** Carbon state for each live turn, so an orderly app exit can preserve interrupted work. */
const runningTurnCarbons = new Map<string, RunningTurnCarbon>();

/**
 * Messages typed while a turn is running.
 *
 * One per run: a second steer replaces the first rather than queueing behind it, because the
 * thing you type while watching a model work is a correction, and the older correction is the
 * one you have already changed your mind about.
 */
interface Steer {
  queued: string | null;
  voice: VoiceGuidanceQueue;
  /** Cuts the current stream short so the note lands now rather than at the next boundary. */
  interrupt: AbortController;
  wantsNow: boolean;
}
const steering = new Map<string, Steer>();

/**
 * The permissions each running turn is operating under, as they stand now.
 *
 * Separate from the mode the turn was dispatched with because the two can differ: a turn can run
 * for minutes, and the control that changes permissions has to reach the turn already in flight,
 * not merely the next one. Keyed by run id and removed when the turn ends.
 */
const runAccess = new LiveAccess();

/** Applies a permission change to a turn that is already running. False when it has ended. */
function setRunAccess(runId: string, mode: AccessMode): boolean {
  const previous = runAccess.get(runId);
  if (!runAccess.update(runId, mode)) return false;
  const progress = runningTurnCarbons.get(runId);
  if (previous !== mode && progress) {
    try {
      carbon.add(progress.carbonKey, {
        kind: 'note', label: 'Permissions changed', runId, model: progress.model,
        body: `The user changed this running turn's permissions from ${previous} to ${mode}. Pending and future tool calls are re-evaluated; already-running tools are not undone.`,
      });
    } catch (error) { console.error('Could not record applied permission change:', error); }
  }
  return true;
}

ipcMain.handle('chat:access', (_event, runId: string, mode: AccessMode) =>
  setRunAccess(runId, mode === 'read' || mode === 'ask' || mode === 'full' ? mode : 'ask')
);

function cancelTurn(runId: string): boolean {
  const controller = runningTurns.get(runId);
  const remote = remoteTurnSinks.get(runId);
  if (controller && remote) remote.cancellationRequested = true;
  controller?.abort();
  return !!controller;
}

ipcMain.handle('chat:cancel', (_event, runId: string) => cancelTurn(runId));

/** Queue a note for the next boundary, or cut in immediately when `now` is set. */
function steerTurn(runId: string, text: string, now: boolean): boolean {
  const steer = steering.get(runId);
  if (!steer || !text.trim()) return false;

  steer.queued = text.trim();
  steer.wantsNow = !!now;
  if (now) steer.interrupt.abort();
  return true;
}

ipcMain.handle('chat:steer', (_event, runId: string, text: string, now: boolean) =>
  steerTurn(runId, text, now)
);

function cancelSteer(runId: string): boolean {
  const steer = steering.get(runId);
  if (!steer) return false;
  steer.queued = null;
  steer.wantsNow = false;
  return true;
}

ipcMain.handle('chat:steer-cancel', (_event, runId: string) => cancelSteer(runId));

/** The facts a turn needs about its own surroundings, read fresh rather than trusted from the renderer. */
const situation = (
  mode: AccessMode,
  tools: string[],
  workspace: string,
  workspaceConfirmed: boolean,
  maxOutputTokens: number
): Situation => ({
  workspace,
  workspaceConfirmed,
  mode,
  tools,
  maxOutputTokens,
});

interface StreamChatOptions {
  owner?: TurnOwner;
  projectId?: string;
  workspace?: string;
  workspaceConfirmed?: boolean;
  /** Only the dedicated main-window avatar IPC can opt into a non-durable conversation. */
  transientAvatar?: boolean;
  /** Ownership acquired by a remote command before it commits either transcript message. */
  reservedTurn?: RemoteTurnStartReservation['active'];
}

async function streamChat(request: ChatRequest, options: StreamChatOptions = {}): Promise<void> {
  assertNotCommittingAutomaticRestart();
  await idleCompaction.cancelAndWait();
  assertNotCommittingAutomaticRestart();
  const provider = providerManager.getProvider(request.providerId);
  if (!provider) throw new Error(`Provider ${request.providerId} not found`);
  lastUsed.select(request.providerId, request.model);

  const runId = request.requestId ?? randomUUID();
  const mode: AccessMode = request.accessMode ?? 'ask';

  // The window is the model's, not the app's. Fit the conversation to it on every turn, which
  // is what makes it a rolling window rather than a truncation that happened once.
  const hagPreview = request.providerId === HAG_SOURCE_ID;
  const baseProfile = profileFor(request.providerId, request.model);
  const profile = hagPreview ? { ...baseProfile, maxOutputTokens: HAG_PREVIEW_MAX_OUTPUT_TOKENS,
    contextTokens: HAG_PREVIEW_MAX_EVALUATED_TOKENS, instructions: '', thinkingLevel: 'off' as const } : baseProfile;
  const useTools = !hagPreview && request.useTools !== false;
  const boundWorkspace = request.threadId ? workspaceForConversation(request.threadId) : null;
  assertStreamConversation(request.threadId, boundWorkspace, { transientAvatar: options.transientAvatar, remote: options.owner?.kind === 'remote' });
  if (boundWorkspace && !boundWorkspace.available) throw new Error(boundWorkspace.reason);
  if (boundWorkspace && options.workspace && boundWorkspace.path !== options.workspace) {
    throw new Error('This conversation’s workspace changed. Refresh the conversation before sending again.');
  }
  const workspace = boundWorkspace?.path ?? options.workspace ?? mcpStore.workspace();
  const workspaceConfirmed = boundWorkspace?.confirmed ?? options.workspaceConfirmed ?? mcpStore.workspaceConfirmed();
  // Public identity is this chat's selected project, never the fallback folder of another chat.
  const publicChatWorkspace = request.threadId && conversations.chatMetadata().find((thread) => thread.id === request.threadId)?.directory
    ? workspace : '';

  // Pick up where the last turn left off, tool results and all, when this is the same thread
  // carrying on. Otherwise the conversation is what the renderer sent.
  const savedMessages = request.threadId
    ? conversations.snapshot().threads.find((thread) => thread.id === request.threadId)?.messages ?? [] : [];
  request = { ...request, messages: sanitizeConversationRequest(request.messages, savedMessages, { preserveVoiceGuidance: true }) };
  const resumed = transcriptCache.resume(request.threadId, request.messages);
  // Host-owned diagnostic provenance is applied both before and after transcript recovery.
  const conversation = provider.prepareMessages({ ...request, messages: sanitizeConversationRequest(
    resumed ?? restoreDeliveredVoiceHistory(request.messages,
      new Map(savedMessages.map((message) => [message.id, message.meta?.voiceGuidance ?? []]))),
    savedMessages, { trustedReasoningHistory: true }) });
  if (hagPreview) {
    assertHagVisibleHistory(request.threadId ? conversations.snapshot().threads.find((thread) => thread.id === request.threadId)?.messages ?? [] : []);
    request = prepareHagPreview(request, conversation);
  }
  const carbonKey = request.threadId ?? runId;
  const source = providerManager.listProviders().find((entry) => entry.id === request.providerId);
  const sourceName = source?.name ?? request.providerId;
  const asked = request.messages[request.messages.length - 1];
  const responseAlias = request.responseMessageId ?? request.requestId ?? runId;
  const visibleAliases = [
    ...request.messages.map((message) => message.id),
    responseAlias,
  ];

  if (runningTurns.has(runId)) throw new Error('This turn is already running.');
  if (options.reservedTurn) {
    const active = activeThreads.recordForRun(runId);
    const expected = options.reservedTurn;
    const sameRemoteOwner =
      active?.owner.kind === 'remote' &&
      expected.owner.kind === 'remote' &&
      active.owner.deviceId === expected.owner.deviceId;
    if (
      !active ||
      expected.threadId !== carbonKey ||
      expected.runId !== runId ||
      active.threadId !== carbonKey ||
      active.projectId !== expected.projectId ||
      active.responseMessageId !== responseAlias ||
      !sameRemoteOwner
    ) {
      throw new Error('The remote turn reservation is no longer owned by this request.');
    }
  } else {
    activeThreads.begin(carbonKey, runId, {
      owner: options.owner ?? { kind: 'renderer' },
      projectId: options.projectId,
      responseMessageId: responseAlias,
    });
  }
  // Floating helper chats are private, transient streams and never become remote conversations.
  if (!options.reservedTurn && conversations.snapshot().threads.some((thread) => thread.id === carbonKey)) remoteLiveTranscript.begin(runId, carbonKey, {
    id: responseAlias, createdAt: Date.now(), modelId: request.model, sourceName,
  });
  let turnFailed = false;
  const controller = new AbortController();
  runningTurns.set(runId, controller);
  const steer: Steer = { queued: null, voice: new VoiceGuidanceQueue(), interrupt: new AbortController(), wantsNow: false };
  let takenTypedSteer: string | null = null;
  steering.set(runId, steer);
  runAccess.begin(runId, mode);
  let runtime: mcp.WorkspaceRuntime | null = null;
  let delegated: delegation.Delegation | null = null;
  let partialTranscript: Message[] | null = [...conversation];
  let streamedContent = '';
  /** The instructions and notes this conversation's model was given; kept with its transcript. */
  let standingSnapshot: ContextSnapshot | undefined;
  const rememberInteractiveTranscript = (messages: Message[]): void =>
    transcriptCache.remember(carbonKey, messages, visibleAliases, [[responseAlias, streamedContent]], standingSnapshot);
  // Text and tool progress travel over separate IPC channels. Anchor each tool occurrence to
  // the amount of assistant text already emitted the first time we see it, then reuse that
  // anchor for pending/running/completed updates so the renderer can rebuild true chronology.
  const toolContentOffsets = new Map<string, number>();
  const positionToolActivity = (activity: ToolActivity) => {
    const key = activity.activityId ?? activity.callId;
    let contentOffset = toolContentOffsets.get(key);
    if (contentOffset === undefined) {
      contentOffset = streamedContent.length;
      toolContentOffsets.set(key, contentOffset);
    }
    return { ...activity, contentOffset };
  };
  runningTurnCarbons.set(runId, { carbonKey, model: request.model, partial: '', flushedContentLength: 0 });
  const addCarbon = (entry: carbon.CarbonEntry): void =>
    carbon.add(carbonKey, { ...entry, runId, model: request.model });
  const noteCarbon = (body: string): void => addCarbon({ kind: 'note', label: 'note', body });
  let carbonAssistantEntries = 0;
  const flushCarbonText = (label = 'assistant'): boolean => {
    const progress = runningTurnCarbons.get(runId);
    if (!progress) return false;
    const body = progress.partial.slice(progress.flushedContentLength);
    progress.flushedContentLength = progress.partial.length;
    if (!body.trim()) return false;
    addCarbon({ kind: 'assistant', label, body });
    carbonAssistantEntries += 1;
    return true;
  };
  let carbonTurnStarted = false;
  let dispatchedAt = 0;
  const beginCarbonTurn = (compacted: number, systemPrompt?: string): void => {
    if (carbonTurnStarted) return;
    const record = carbon.ensure({
      threadId: carbonKey,
      model: request.model,
      sourceName,
      sourceUrl: carbon.publicEndpoint(source?.baseUrl ?? ''),
      workspace,
      accessMode: mode,
      contextTokens: profile.contextTokens,
      compacted,
    });
    send('chat:carbon', { threadId: carbonKey, id: record.id, path: record.path });
    if (request.messages.length === 1 && systemPrompt) {
      addCarbon({ kind: 'system', label: 'system', body: systemPrompt });
    }
    if (asked) addCarbon({ kind: 'user', label: 'user', body: asked.content ?? '' });
    if (compacted > 0) {
      noteCarbon(`Context compaction folded ${compacted} earlier message(s) before this run.`);
    }
    carbonTurnStarted = true;
  };

  try {
    coordinationTurnChanged(carbonKey);
    runtime = useTools ? await mcp.createWorkspaceRuntime(workspace, controller.signal) : null;
    // Showing and seeing. `runtime` stays the workspace runtime, because it is what the turn
    // shuts down; this is the toolset layered on top of it. Wrapped inside the agent tools
    // rather than outside, so an agent this turn starts inherits a runtime that can already
    // take a screenshot and look at it.
    const seeing: ToolRuntime | null = runtime
      ? withPreview(withTerminal(runtime, { workspace, threadId: carbonKey }), {
          workspace,
          workspaceConfirmed,
          show: (item) => send('preview:show', { ...item, threadId: carbonKey }),
          eyes: () => eyes.resolve(providerManager.listProviders()),
        })
      : null;
    // The conversation's model can start agents and carry on while they work; the turn waits for
    // them before it ends. Their approval prompts come here, because this is where someone is
    // watching, and the turn's own permissions bound theirs.
    delegated =
      seeing && routing.enabled()
        ? delegation.withAgents(seeing, {
            parentModel: { providerId: request.providerId, model: request.model },
            currentMode: () => runAccess.get(runId) ?? mode,
            onAccessChange: (listener) => runAccess.subscribe(runId, listener),
            screenCaptureWithoutAsking: () => developerSettings.read().screenCapture.withoutAsking,
            machineWideWithoutAsking: () => developerSettings.read().machineWide.withoutAsking,
            messageId: runId,
            threadId: carbonKey,
            workspace,
            workspaceConfirmed,
            mode,
            requestApproval: (activity, signal) =>
              askPermission({ ...positionToolActivity({ ...activity, runId }), requestId: runId, runId }, signal),
            report: (activity) =>
              send('tools:activity', { ...positionToolActivity({ ...activity, runId }), requestId: runId }),
          })
        : null;
    const working: ToolRuntime | null = delegated?.runtime ?? seeing;
    // The conversation's own notes, outermost so that no agent it starts is handed them: what is
    // worth remembering is for the conversation to decide. Read-only permissions can still recall.
    const memoryAccessForMode = (effectiveMode: AccessMode): MemoryAccess => !working ? 'list' : effectiveMode === 'read' ? 'read' : 'write';
    const memoryAccess = memoryAccessForMode(runAccess.get(runId) ?? mode);
    const remembering: ToolRuntime | null =
      working && memoryAccess !== 'list' && memoryStore.settings().enabled
        ? withMemory(working, { workspace, access: memoryAccess,
            currentAccess: () => (runAccess.get(runId) ?? mode) === 'read' ? 'read' : 'write', changed: memoryChanged })
        : working;
    const libraryMemory = remembering && workspaceConfirmed ? withPensieveLibrary(remembering, pensieveLibrary, workspace) : remembering;
    const projectTools = libraryMemory ? withCodeReview(withPullRequests(skillRuntime(libraryMemory, workspace), workspace), {
      store: codeReviews, workspace, signal: controller.signal,
      author: { kind: 'agent', label: request.model, threadId: request.threadId, runId },
    }) : null;
    // Outside delegated runtimes: stable schemas do not confer collaboration permissions.
    const collaboration = withInteractiveCollaboration(projectTools, {
      owner: options.owner ?? { kind: 'renderer' }, threadId: options.transientAvatar ? undefined : request.threadId,
      runId, workspace, publicWorkspace: publicChatWorkspace,
      currentMode: () => runAccess.get(runId) ?? mode, signal: controller.signal,
      connected: chatCoordination, publicChat: botChat,
    });
    // `available` as well as `enabled`: an experiment whose bundle is missing stands down and
    // reports itself on the Experimental page, rather than failing the turn it was attached to.
    const rememberingExperience = collaboration.runtime && workspaceConfirmed && pensieve.enabled && pensieve.available && !hagPreview
      ? withPensieve(collaboration.runtime, provider, { memory: pensieve, workspace, session: carbonKey, runId,
          signal: controller.signal, sdkOptions: nyOptions, curriculumPath: pensievePaths.curriculumPath }) : null;
    const withinExperience = rememberingExperience?.runtime ?? collaboration.runtime;
    /**
     * Asking the person something.
     *
     * Here, rather than further in, for the same reason the collaboration tools are here: it is
     * this conversation someone is watching. Wrapped outside the delegated agents so an agent
     * this turn starts does not inherit it — an agent runs unattended by construction, and one
     * that could stop and ask would block a run nobody is looking at behind a question nobody
     * will see. Inside the Vault, which stays outermost so its redaction sees every result.
     */
    const asking = withinExperience && (options.owner ?? { kind: 'renderer' }).kind === 'renderer'
      ? withAsk(withinExperience, {
          runId,
          // Re-read per call rather than captured: the window can go while a turn is still
          // running, and a question is worth asking only while there is someone to answer it.
          canAsk: () => mainWindow !== null && !mainWindow.isDestroyed(),
          ask: (question, signal) =>
            askQuestion({ ...question, threadId: request.threadId }, signal),
        })
      : withinExperience;
    /**
     * The Vault, outermost.
     *
     * Two reasons it sits here rather than anywhere further in. Its redaction has to see every
     * result the turn produces — a granted secret that reached a file comes back through
     * `read_file`, and one that reached a delegated agent comes back in that agent's report — and
     * its own tools must stay outside every nested runtime, so an agent this turn starts inherits
     * tools that cannot spend a credential. Only the conversation a person is watching can.
     */
    const tools = asking ? withVault(asking, { runId }) : asking;
    const enabledTools = tools?.enabledTools() ?? [];
    const toolDefinitions = buildToolset(enabledTools).definitions;
    const budget = promptBudget(profile, toolDefinitions);

  // The project's instructions and the notes kept from earlier conversations, as this
  // conversation started with them unless something they were built from has changed since.
  const standing = hagPreview ? { fresh: false, snapshot: { key: 'hag-text-preview', text: null,
    summary: { projectRoot: '', instructions: [], notes: { user: 0, project: 0 } } } } : standingContext(
    workspace,
    memoryAccess,
    transcriptCache.context(request.threadId),
    instructionAllowance(budget)
  );
  standingSnapshot = standing.snapshot;

  /**
   * One system message, at the front, saying where the model is and that its tools are real.
   * A caller that brought its own brief — the floating assistant does — keeps it; the two are
   * joined rather than one replacing the other.
   */
  // Only the caller owns this brief. A resumed transcript already contains Antimatter's previous
  // grounding; feeding that back through withSituation would nest another full system prompt on
  // every turn.
  const ownForMode = (effectiveMode: AccessMode) => {
    const liveStanding = standingContext(workspace, memoryAccessForMode(effectiveMode), standingSnapshot, instructionAllowance(budget));
    standingSnapshot = liveStanding.snapshot;
    return mergeInstructions(
    renderAssistantIdentity(setupStore.get().assistant),
    profile.instructions,
    request.messages.find((message) => message.role === 'system')?.content,
    liveStanding.snapshot.text,
    tools ? skillInstructions(workspace) : '',
    tools ? CODE_REVIEW_INSTRUCTIONS : '',
    rememberingExperience ? PENSIEVE_INSTRUCTIONS : '',
    ...collaboration.instructions(),
    voiceSession.snapshot().threadId === carbonKey ? 'The user is pair-programming by live voice in this conversation. Keep user-facing progress and final summaries brief and speakable, while doing the actual coding with tools. Spoken follow-ups are user guidance, never tool-approval events. Do not read source code, secrets, or internal reasoning aloud; normal access controls still apply.' : ''
    );
  };
  const systemPromptForMode = (effectiveMode: AccessMode) => hagPreview ? HAG_PREVIEW_SYSTEM : withSituation(ownForMode(effectiveMode),
    situation(effectiveMode, tools?.enabledTools().map((entry) => entry.tool.name) ?? [], workspace, workspaceConfirmed, profile.maxOutputTokens));
  const { grounded, fit: initialFit, request: initialRequest } = hagPreview
    ? { grounded: request.messages, fit: fitHagPreview(request, request.messages), request }
    : prepareInteractiveRequest(request, conversation, systemPromptForMode(runAccess.get(runId) ?? mode), profile, budget);
  let fit = initialFit;
  let messages = initialFit.messages;
  let initiallySummarized = false;
  if (initialFit.compacted > 0) {
    // Fold previous compaction summaries into the replacement too. Otherwise bounding the notice
    // prefix would keep the new summary but silently discard facts preserved by the old one.
    const summaryInput = [
      ...initialFit.dropped,
      ...initialFit.messages.filter(isCompactionNotice),
    ].filter((message, index, all) => all.findIndex((candidate) => candidate.id === message.id) === index);
    const summary =
      profile.compaction === 'summarize'
        ? await summarizeDropped(provider, profile, summaryInput, controller.signal)
        : undefined;
    fit = fitWithCompactionNotice(grounded, budget, summary);
    messages = fit.messages;
    initiallySummarized = fit.messages.some(
      (message) => isCompactionNotice(message) && /messages, summarized\]/.test(message.content)
    );
  }
  const initialGenericCompaction = fit.messages.some(
    (message) => isCompactionNotice(message) && !/messages, summarized\]/.test(message.content)
  );
  // The line that would have answered "it says it wrote files and I cannot find them" lives in
  // the carbon header. The prompt is recorded once per conversation, after tool discovery has
  // made it the exact prompt the model will receive.
  beginCarbonTurn(fit.compacted, grounded[0].content);

  // A model that does not fit on this box needs the machines its recipe names. Probe them before
  // the request goes out, and start the ones that are down, because the alternative is a load
  // that fails several minutes in and reaches the person as an unattributed 500 from the local
  // server. A peer that will not come up does not stop the turn: some models still answer from
  // one box, and refusing outright would be the worse of the two outcomes.
  const recipe = recipes.forModel(request.model);
  if (recipe) {
    const outcomes = await recipes.ensurePeers(recipe, {
      onProgress: (message) => {
        send('chat:alive', { id: runId, at: Date.now(), note: { label: message } });
        noteCarbon(message);
      },
    });
    const summary = recipes.summarize(recipe, outcomes);
    if (summary) {
      noteCarbon(summary);
      if (outcomes.some((outcome) => !outcome.ready)) {
        send('chat:notice', { id: runId, threadId: carbonKey, tone: 'warning', title: 'Model peer unavailable', body: summary });
      }
    }
  }
  if (standing.fresh && request.messages.length > 1) {
    // The opening of the prompt changed under a conversation already going, which is why a local
    // server may take a while over this turn: it has to read the conversation again.
    noteCarbon(
      'Project instructions and memory were read again for this turn, because what they were built from changed ' +
        '(the workspace, a Memory setting, a note edited on the Memory page, or read-only permissions).\n\n' +
        grounded[0].content
    );
  }
  dispatchedAt = Date.now();
  noteCarbon(
    `Dispatched at ${new Date(dispatchedAt).toISOString()} to ${sourceName}; waiting for the source stream.`
  );
  let sawSourceHeartbeat = false;
  let sawLoadingNote = false;
  const inferenceMilestones = new Set<string>();

  send('chat:context', {
    runId,
    modelId: request.model,
    contextTokens: profile.contextTokens,
    contextSource: profile.contextSource,
    maxOutputTokens: profile.maxOutputTokens,
    budgetTokens: fit.budgetTokens,
    estimatedTokens: fit.estimatedTokens,
    compacted: fit.compacted,
    summarized: initiallySummarized,
    overflowTokens: fit.overflowTokens,
    minimumRecentMet: fit.minimumRecentMet,
    memory: standing.snapshot.summary,
  });

    const result = await runToolLoop({
      provider: rememberingExperience?.provider ?? provider,
      request: { ...initialRequest, messages },
      runId,
      mode,
      currentMode: () => runAccess.get(runId) ?? mode,
      onAccessChange: (listener) => runAccess.subscribe(runId, listener),
      // Read per call, so turning it off stops the next capture rather than the next turn.
      screenCaptureWithoutAsking: () => developerSettings.read().screenCapture.withoutAsking,
      machineWideWithoutAsking: () => developerSettings.read().machineWide.withoutAsking,
      systemPromptForMode,
      signal: controller.signal,
      // Interactive turns only: an unattended run's workspace comes from configuration.
      workspaceConfirmed,
      workspace,
      toolRuntime: tools ?? undefined,
      prepareMessages: rememberingExperience?.prepareMessages,
      background: combineBackgroundWork(delegated?.background, collaboration.background),
      // A long turn accumulates its own context; keep it inside the window between rounds.
      fit: (conversation, liveTools) => hagPreview ? fitHagPreview(request, conversation) : fitToBudget(conversation, promptBudget(profile, liveTools)),
      // Read per turn, so turning it off stops the next turn rather than the next launch.
      autoContinue: hagPreview ? { ...developerSettings.read().autoContinue, enabled: false } : developerSettings.read().autoContinue,
      onAutoContinue: ({ attempt, of, reason }) => {
        noteCarbon(
          `Auto-continue ${attempt} of ${of}: the turn ${
            reason === 'round-limit'
              ? 'reached its tool-call ceiling and was given another allowance of rounds'
              : reason === 'ran-out-thinking'
                ? 'spent a whole reply budget thinking and was cut off before writing anything, and was asked for the step rather than ended on it'
                : reason === 'thought-without-answering'
                  ? 'ended a reply with everything still inside its thinking — no answer and no tool call — and was asked to put the next step outside it'
                  : 'stopped on the next step it had announced and was told to carry on'
          }. This nudge is Antimatter's, not the user's.`
        );
      },
      steer: {
        take: () => {
          takenTypedSteer = steer.queued;
          const spoken = steer.voice.take();
          const note = [steer.queued, spoken].filter(Boolean).join('\n\n') || null;
          steer.queued = null;
          steer.wantsNow = false;
          return note;
        },
        pending: () => steer.queued !== null || steer.voice.pending(),
        get interrupt() {
          return steer.interrupt.signal;
        },
        // An AbortSignal fires once, so each round gets a fresh one to be cut short with.
        rearm: () => {
          if (steer.interrupt.signal.aborted) steer.interrupt = new AbortController();
        },
      },
      onSteer: (note) => {
        const guidance = steer.voice.delivered();
        if (guidance.length) send('voice:guidance', { threadId: carbonKey, runId, guidance });
        // A voice receipt must not mark a separately queued typed note as delivered.
        if (takenTypedSteer !== null) send('chat:steered', { id: runId, note: takenTypedSteer, at: Date.now() });
        takenTypedSteer = null;
        addCarbon({ kind: 'note', label: 'steered', body: note });
      },
      onContent: (content) => {
        streamedContent += content;
        const progress = runningTurnCarbons.get(runId);
        if (progress) progress.partial = streamedContent;
        send('chat:stream-data', { id: runId, content });
      },
      // Its own channel rather than a field on stream-data: the renderer rebuilds the thread tree
      // for every content frame, and a reasoning model sends forty times as many of these.
      onReasoning: (content) => send('chat:reasoning', { id: runId, content }),
      onMetrics: (event) => {
        remoteInference.update(runId, event);
        send('chat:metrics', { ...event, id: runId });
        if (event.metrics.phase === 'started' && event.metrics.request) {
          addCarbon({ kind: 'note', label: 'Inference request', body: JSON.stringify({
            origin: options.owner?.kind === 'remote' ? 'phone' : 'desktop',
            round: event.round, ...event.metrics.request,
          }) });
        }
        const milestone = `${event.round}:${event.metrics.requestStartedAt}:${event.metrics.phase}`;
        if (event.metrics.phase !== 'started' && !inferenceMilestones.has(milestone)) {
          inferenceMilestones.add(milestone);
          const { request: _privateRequest, ...measured } = event.metrics;
          addCarbon({ kind: 'note', label: 'Inference progress', body: JSON.stringify({ round: event.round, ...measured }) });
        }
      },
      onTranscript: (messages) => {
        partialTranscript = messages;
        // Tool checkpoints are the recovery boundary. Persist them synchronously so an orderly
        // app exit cannot restore an older transcript and repeat already completed side effects.
        rememberInteractiveTranscript(messages);
      },
      // Every round, so the header's context meter tracks the climb instead of only the cliff.
      // No carbon note: this is a reading, not an event, and one per round would bury the log.
      onContext: (event) => {
        send('chat:context', {
          runId,
          modelId: request.model,
          contextTokens: profile.contextTokens,
          contextSource: profile.contextSource,
          maxOutputTokens: profile.maxOutputTokens,
          budgetTokens: event.budgetTokens ?? promptBudget(profile, event.tools),
          estimatedTokens: event.estimatedTokens,
          compacted: (initialGenericCompaction ? 0 : fit.compacted) + event.totalCompacted,
          summarized: initiallySummarized,
          overflowTokens: event.overflowTokens ?? 0,
          minimumRecentMet: event.minimumRecentMet ?? true,
          memory: standing.snapshot.summary,
        });
      },
      onCompaction: (event) => {
        noteCarbon(
          `Rolling context compaction folded ${event.compacted} message(s) at round ${event.round + 1}; ` +
            (event.noticePersisted
              ? `${event.totalCompacted} message(s) are represented by the durable context marker.`
              : `the optional marker was omitted to preserve the current request.`)
        );
        send('chat:context', {
          runId,
          modelId: request.model,
          contextTokens: profile.contextTokens,
          contextSource: profile.contextSource,
          maxOutputTokens: profile.maxOutputTokens,
          budgetTokens: event.budgetTokens ?? promptBudget(profile, event.tools),
          estimatedTokens: event.estimatedTokens ?? 0,
          compacted: (initialGenericCompaction ? 0 : fit.compacted) + event.totalCompacted,
          summarized: initiallySummarized,
          overflowTokens: event.overflowTokens ?? 0,
          minimumRecentMet: event.minimumRecentMet ?? true,
          memory: standing.snapshot.summary,
        });
      },
      // Preserve the first source activity in the carbon, without claiming inference progress.
      // This can also be a loading status before HTTP streaming begins.
      onAlive: (note) => {
        const at = Date.now();
        if (!sawSourceHeartbeat) {
          sawSourceHeartbeat = true;
          noteCarbon(
            `Source activity received after ${Math.max(0, at - dispatchedAt)} ms; waiting for visible output.`
          );
        }
        // A cold load is worth recording once: a seven-minute first turn is otherwise unexplained
        // in the carbon, and the reader cannot tell it from a stall.
        if (note && !sawLoadingNote) {
          sawLoadingNote = true;
          noteCarbon(
            `The source is loading ${note.model ?? 'its model'}; the request is being retried until it answers.`
          );
        }
        send('chat:alive', { id: runId, at, note });
      },
      // Holding for agents the turn started. The window says so rather than "streaming".
      onWaiting: (waiting) => {
        send('chat:waiting', { id: runId, waiting, at: Date.now() });
        if (waiting) noteCarbon('Waiting for the agents this turn started.');
      },
      // The renderer keys activity by the message it belongs to.
      onActivity: (activity: ToolActivity) => {
        const positioned = positionToolActivity(activity);
        send('tools:activity', { ...positioned, requestId: activity.runId });
        // Only the settled states: a carbon wants what a tool did, not every transition.
        if (activity.status === 'done' || activity.status === 'failed' || activity.status === 'denied') {
          // Preserve the same prose → action → prose order shown in the transcript. A tool-loop
          // round cannot emit more assistant text while its tools are executing, so settling the
          // first call at this boundary is a stable place to flush the preceding span.
          flushCarbonText();
          addCarbon(carbon.toolActivityEntry(activity));
        }
      },
      requestApproval: (activity, signal) =>
        askPermission({ ...positionToolActivity(activity), requestId: activity.runId }, signal),
      requiredTool: explicitlyRequiredTool(asked?.content ?? ''),
    });

    flushCarbonText();
    if (carbonAssistantEntries === 0) {
      addCarbon({ kind: 'assistant', label: 'assistant', body: '(no text)' });
    }
    noteCarbon(
      `${result.rounds} round(s), ${result.toolCalls} tool call(s); ended because it ${
        result.reason === 'finished'
          ? 'finished'
          : result.reason === 'stalled'
            ? 'was repeating itself'
            : result.reason === 'no-progress'
              ? 'repeated completion claims without productive tool work'
            : result.reason === 'flooding'
              ? 'kept asking for more tool calls than one reply may carry'
              : result.reason === 'truncated'
                ? result.truncation === 'thinking-only'
                  ? 'ended a reply with everything still inside its thinking, leaving no answer'
                  : 'ran out of output before answering'
                : 'hit the round ceiling'
      }.`
    );

    // A source that does not recognise the requested id may answer on its own default instead of
    // refusing, and that reply is well-formed: the picker, the header and this carbon all still
    // say the model that was chosen. Said here because there is nowhere else it would surface.
    if (!modelsAgree(request.model, result.servedModel)) {
      const warning = substitutionWarning(request.model, result.servedModel as string);
      noteCarbon(warning);
      send('chat:notice', { id: runId, threadId: carbonKey, tone: 'warning', title: 'A different model answered', body: warning });
    }

    // Keep the expanded conversation so "carry on" is a real continuation and not a fresh start
    // working from the model's own account of what it did.
    rememberInteractiveTranscript(result.transcript);

    // Runtime status belongs to diagnostics, never assistant prose or a later model prompt.
    const notices: Record<string, string> = {
      limit: `Paused after ${result.rounds} rounds of tool calls. Say “continue” to resume with this turn’s tool results.`,
      truncated: 'The model reached its output limit before answering. Narrow the request or adjust its maximum output in Settings.',
      stalled: 'The same tool call was repeating without progress. Clarify the next step to continue.',
      flooding: 'The model repeatedly exceeded its tool-call limit. Narrow the request or adjust the limit in the Model Library.',
    };
    if (notices[result.reason]) send('chat:notice', { id: runId, threadId: carbonKey,
      tone: 'warning', title: 'Response paused', body: notices[result.reason] });
  } catch (error) {
    if (!carbonTurnStarted) {
      // Workspace/tool startup can fail before an inference request exists. That is still a real
      // user turn worth diagnosing, so open its carbon rather than letting every note no-op.
      beginCarbonTurn(0);
      noteCarbon(`Preflight failed before dispatch to ${sourceName}.`);
    }
    if (partialTranscript) rememberInteractiveTranscript(partialTranscript);
    flushCarbonText('assistant — partial');
    // A turn the user stopped is not a failure to report as one; whatever it had already
    // written stays on screen, with a line saying why it ends there.
    if (controller.signal.aborted) {
      const rendererLost = controller.signal.reason === RENDERER_LOST_ABORT;
      noteCarbon(
        rendererLost
          ? 'Stopped because the conversation renderer reloaded or exited.'
          : 'Stopped by the user.'
      );
      send('chat:notice', { id: runId, threadId: carbonKey, tone: 'info', title: 'Response stopped',
        body: rendererLost ? 'The conversation view reloaded. Your partial response is saved.' : 'You can choose another model and continue this chat.' });
      return;
    }
    noteCarbon(`Failed: ${(error as Error).message}`);
    send('chat:notice', { id: runId, threadId: carbonKey, tone: 'danger', title: 'Could not finish response',
      body: error instanceof Error ? error.message : String(error) });
    turnFailed = true;
    throw error;
  } finally {
    // A turn waits for its agents, so any still out here were left by a turn that was stopped or
    // failed. Nobody is waiting for them any more.
    const undelivered = steer.voice.finish();
    if (undelivered.length) send('voice:guidance', { threadId: carbonKey, runId, guidance: undelivered });
    delegated?.stop();
    try { chatCoordination?.release(runId); }
    catch (error) { console.error('[chat-coordination] could not release turn inbox:', error); }
    try { botChat?.release(runId); }
    catch (error) { console.error('[bot-chat] could not release turn mentions:', error); }
    settleApprovalsForRun(runId);
    // Same reason, and the more important of the two: a turn that ended while a question was on
    // screen would otherwise leave a card inviting an answer that nothing is waiting for.
    settleQuestionsForRun(runId);
    // An approved credential lives for the piece of work it was approved for. The grant has its
    // own expiry so a crashed turn cannot leave one armed, but a turn that ended normally should
    // not leave the secret in memory for the rest of that window either.
    vaultGrants.release(runId);
    runningTurns.delete(runId);
    remoteInference.finish(runId);
    // A remote adapter keeps its pre-transcript lease through the final durable assistant update.
    // Its outer run releases the lease after finish/failure persistence; renderer turns own their
    // lease directly and end it here.
    if (!options.reservedTurn) {
      remoteLiveTranscript.finish(runId, turnFailed, Date.now());
      activeThreads.finish(carbonKey, runId);
    }
    coordinationTurnChanged(carbonKey);
    runningTurnCarbons.delete(runId);
    steering.delete(runId);
    runAccess.end(runId);
    await runtime?.shutdown();
  }
}

ipcMain.handle('chat:stream', (_event, request: ChatRequest) => {
  // The orchestrator inherits this when WORKFLOW.md does not pin a source.
  rememberInteractiveTurn(request);
  return streamChat(request, { owner: { kind: 'renderer' } });
});

ipcMain.handle('chat:stream-avatar', (event, request: ChatRequest) => {
  requireMainFrame(event);
  rememberInteractiveTurn(request);
  return streamChat(request, { owner: { kind: 'renderer' }, transientAvatar: true });
});

/**
 * The Symphony orchestrator (exec/directives/symphony), wired to Antimatter's own pieces:
 * WORKFLOW.md at the project root is the policy, the tracker comes from that file, and a turn
 * runs through our provider and tool loop rather than a separate agent subprocess.
 */
const workflowPath = () => {
  const explicit = process.env.ANTIMATTER_WORKFLOW_PATH?.trim();
  if (explicit) return explicit;
  const local = join(process.cwd(), 'WORKFLOW.md');
  return existsSync(local)
    ? local
    : join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'WORKFLOW.md');
};

/** Re-read on every tick, so a workflow fixed on disk recovers without a restart (§6.2). */
const loadWorkflowSnapshot = (): WorkflowSnapshot => {
  const definition = loadWorkflow(workflowPath());
  // Relative paths in the workflow resolve beside the workflow file, not beside the process.
  const config = readConfig(definition, dirname(definition.path));
  const problems = validateForDispatch(config);
  const sources = providerManager.listProviders();
  const source = resolveRunnerSource(sources, config.runner.providerId);
  if (!source) {
    problems.push(
      config.runner.providerId
        ? `codex.provider "${config.runner.providerId}" is not a configured inference source`
        : 'no inference source is configured for the orchestrator'
    );
  } else if (!resolveRunnerModel(source, config.runner.model)) {
    problems.push(`inference source "${source.name}" has no model for the orchestrator`);
  }
  return { config, promptTemplate: definition.promptTemplate, problems };
};

/**
 * Snitch: the issue tracker, and the pipeline that turns one of its bugs into a dispatched run.
 *
 * The pipeline is registered as a tracker kind, which is the whole integration — the scheduler
 * already knows how to claim work, give it a workspace and retry it, so "fix this bug" is not a
 * second execution path, just another source of issues. Set `tracker.kind: snitch` in
 * WORKFLOW.md and the Fix button in the Snitch tool window feeds this loop.
 */
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let orchestratorAutoWakeEnabled = true;

/** A dispatch or a stage change means there is new work; poll soon rather than at the cadence. */
const wakeOrchestrator = () => {
  if (!orchestratorAutoWakeEnabled || wakeTimer) return;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    if (!orchestratorAutoWakeEnabled || automaticRestartCommitting) return;
    // start() is idempotent and ticks on the way in; the extra tick covers the running case.
    void orchestrator
      .start()
      .then(() => orchestrator.tick())
      .catch((error: Error) => console.error('[snitch] could not wake the orchestrator:', error));
  }, 1500);
};

const pipeline = new Pipeline({
  wake: wakeOrchestrator,
  log: (event) => {
    const where = event.itemId ? ` ${event.itemId}` : '';
    console[event.level === 'error' ? 'error' : 'log'](`[snitch]${where} ${event.message}`);
    send('orchestrator:log', { ...event, issueIdentifier: event.itemId, at: Date.now() });
  },
});

registerTracker('snitch', () => pipeline);
snitch.onChange((reason) => send('snitch:changed', { reason, at: Date.now() }));

interface OrchestratorCarbonRun {
  carbonKey: string;
  model: string;
  content: string;
  flushedContentLength: number;
  seeded: boolean;
  compactionIds: Set<string>;
}

const orchestratorCarbonRuns = new Map<string, OrchestratorCarbonRun>();

const ensureOrchestratorCarbon = (issue: { id: string; identifier: string }, context: RunnerTurnContext) => {
  let state = orchestratorCarbonRuns.get(context.runId);
  if (!state) {
    const record = carbon.ensure({
      threadId: issue.id,
      model: context.model,
      sourceName: context.providerId,
      workspace: context.workspace,
      accessMode: context.accessMode,
    });
    state = {
      carbonKey: issue.id,
      model: context.model,
      content: '',
      flushedContentLength: 0,
      seeded: false,
      compactionIds: new Set(),
    };
    orchestratorCarbonRuns.set(context.runId, state);
    carbon.add(issue.id, {
      kind: 'note',
      label: 'orchestrator turn',
      body:
        `${issue.identifier}; session ${context.sessionId}; turn ${context.turn}` +
        `${context.attempt === null ? '' : `; attempt ${context.attempt}`}; access ${context.accessMode}`,
      runId: context.runId,
      model: context.model,
    });
    send('orchestrator:carbon', { issueId: issue.id, runId: context.runId, id: record.id, path: record.path });
  }
  return state;
};

const flushOrchestratorContent = (runId: string, label = 'assistant'): void => {
  const state = orchestratorCarbonRuns.get(runId);
  if (!state) return;
  const body = state.content.slice(state.flushedContentLength);
  state.flushedContentLength = state.content.length;
  if (!body.trim()) return;
  carbon.add(state.carbonKey, { kind: 'assistant', label, body, runId, model: state.model });
};

const recordOrchestratorTranscript = (
  issue: { id: string; identifier: string },
  snapshot: RunnerTranscriptSnapshot
): void => {
  const state = ensureOrchestratorCarbon(issue, snapshot);
  if (!state.seeded) {
    const seed = [
      ...(snapshot.turn === 1 ? snapshot.messages.filter((message) => message.role === 'system').slice(0, 1) : []),
      ...snapshot.messages.filter((message) => message.role === 'user').slice(-1),
    ];
    for (const message of seed) {
      carbon.add(state.carbonKey, {
        kind: message.role,
        label: message.role,
        body: message.content,
        runId: snapshot.runId,
        model: snapshot.model,
      });
    }
    state.seeded = true;
  }
  for (const message of snapshot.messages) {
    if (!isCompactionNotice(message) || state.compactionIds.has(message.id)) continue;
    state.compactionIds.add(message.id);
    carbon.add(state.carbonKey, {
      kind: 'note',
      label: 'context compaction',
      body: message.content,
      runId: snapshot.runId,
      model: snapshot.model,
    });
  }
  transcriptCache.remember(issue.id, snapshot.messages, snapshot.messages.map((message) => message.id));
};

const orchestratorRunner = createRunner({
  augmentRuntime: (runtime, workspace) => withCodeReview(skillRuntime(runtime, workspace), {
    store: codeReviews, workspace, author: { kind: 'agent', label: 'Orchestrator' },
  }),
  additionalInstructions: (workspace) => [skillInstructions(workspace), CODE_REVIEW_INSTRUCTIONS].filter(Boolean).join('\n\n'),
  resolveProvider: (config) => {
    // A workflow may pin the source and model; otherwise follow the chat, via the same
    // resolver the orchestrator page validates with.
    const configs = providerManager.listProviders();
    const chosen = resolveRunnerSource(configs, config.runner.providerId);
    if (!chosen) throw new Error('No inference source is configured for the orchestrator to use.');

    const provider = providerManager.getProvider(chosen.id);
    if (!provider) throw new Error(`Provider ${chosen.id} is not available.`);

    const model = resolveRunnerModel(chosen, config.runner.model);
    if (!model) throw new Error(`Source ${chosen.name} lists no models; refresh it in Settings.`);

    const profile = profileFor(chosen.id, model);
    return {
      provider,
      providerId: chosen.id,
      model,
      instructions: profile.instructions,
      maxOutputTokens: profile.maxOutputTokens,
      maxToolCalls: profile.maxToolCallsPerMessage,
      thinkingLevel: profile.thinkingLevel,
      budgetTokens: promptBudget(profile, []),
      budgetForTools: (tools: readonly ToolDefinition[]) => promptBudget(profile, tools),
    };
  },
  onActivity: (activity) => {
    send('orchestrator:activity', { ...activity, requestId: activity.runId });
    if (activity.status === 'done' || activity.status === 'failed' || activity.status === 'denied') {
      flushOrchestratorContent(activity.runId);
      const state = orchestratorCarbonRuns.get(activity.runId);
      if (state) {
        carbon.add(state.carbonKey, {
          ...carbon.toolActivityEntry(activity),
          runId: activity.runId,
          model: state.model,
        });
      }
    }
  },
  onContent: (runId, content) => {
    const state = orchestratorCarbonRuns.get(runId);
    if (state) state.content += content;
    send('orchestrator:content', { runId, content });
  },
  // Snitch items move through their stages on the back of these; anything else ignores them.
  onTurnStart: (issue, attempt, context) => {
    ensureOrchestratorCarbon(issue, context);
    pipeline.onTurnStart(issue.id);
  },
  onTranscript: (issue, snapshot) => recordOrchestratorTranscript(issue, snapshot),
  onTurnEnd: (issue, result: RunnerTurnResult) => {
    recordOrchestratorTranscript(issue, result);
    const state = orchestratorCarbonRuns.get(result.runId);
    if (state) state.content = result.content;
    flushOrchestratorContent(result.runId, result.ok ? 'assistant' : 'assistant — partial');
    carbon.add(issue.id, {
      kind: 'note',
      label: result.cancelled ? 'orchestrator cancelled' : 'orchestrator result',
      body:
        `${result.rounds} round(s), ${result.toolCalls} tool call(s); ${result.reason}` +
        `${result.error ? `: ${result.error}` : '.'}`,
      runId: result.runId,
      model: result.model,
    });
    orchestratorCarbonRuns.delete(result.runId);
    pipeline.onTurnEnd(issue.id, result);
  },
  log: (event) => {
    const where = event.issueIdentifier ? ` ${event.issueIdentifier}` : '';
    console[event.level === 'error' ? 'error' : 'log'](`[symphony]${where} ${event.message}`);
    send('orchestrator:log', { ...event, at: Date.now() });
  },
});

const orchestrator = new Orchestrator({
  loadWorkflow: loadWorkflowSnapshot,
  createTracker,
  runAgent: orchestratorRunner,
  /**
   * A Snitch item is a bug in a repository that already exists, so its run happens there rather
   * than in an empty directory. Workspace cleanup only ever looks under workspace.root, so a
   * borrowed repository is never a candidate for removal.
   */
  resolveWorkspace: (issue, config) => {
    const ref = decodeIssueId(issue.id);
    if (ref) {
      try {
        const repo = snitch.readProject(ref.project).repo;
        if (repo) return { path: repo, workspaceKey: workspaceKey(issue.identifier), createdNow: false };
      } catch (error) {
        console.error(`[snitch] no repository for ${issue.identifier}:`, error);
      }
    }
    return ensureWorkspace(config.workspaceRoot, issue.identifier);
  },
  log: (event) => {
    const where = event.issueIdentifier ? ` ${event.issueIdentifier}` : '';
    console[event.level === 'error' ? 'error' : 'log'](`[symphony]${where} ${event.message}`);
    send('orchestrator:log', { ...event, at: Date.now() });
  },
});

let watchedWorkflow: string | null = null;

function watchWorkflow(): void {
  const path = workflowPath();
  if (watchedWorkflow === path) return;
  if (watchedWorkflow) unwatchFile(watchedWorkflow);
  watchedWorkflow = path;
  watchFile(path, { interval: 750 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    void orchestrator.workflowChanged().catch((error: Error) =>
      console.error('[symphony] workflow reload failed:', error)
    );
  });
}

ipcMain.handle('orchestrator:start', async () => {
  assertNotCommittingAutomaticRestart();
  orchestratorAutoWakeEnabled = true;
  await orchestrator.start();
  return orchestrator.snapshot();
});
ipcMain.handle('orchestrator:stop', async () => {
  orchestratorAutoWakeEnabled = false;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  await orchestrator.stop();
  return orchestrator.snapshot();
});
ipcMain.handle('orchestrator:tick', async () => {
  assertNotCommittingAutomaticRestart();
  await orchestrator.tick();
  return orchestrator.snapshot();
});
ipcMain.handle('orchestrator:snapshot', () => orchestrator.snapshot());

/** Lets the UI show why dispatch is blocked before anything is started. */
ipcMain.handle('orchestrator:workflow', () => {
  try {
    const snapshot = loadWorkflowSnapshot();
    return {
      path: workflowPath(),
      ok: snapshot.problems.length === 0,
      problems: snapshot.problems,
      config: snapshot.config,
      promptChars: snapshot.promptTemplate.length,
    };
  } catch (error) {
    return { path: workflowPath(), ok: false, problems: [(error as Error).message], config: null, promptChars: 0 };
  }
});

/**
 * Agents and the task queue.
 *
 * The runner shares the chat window's provider and tool loop; what it does not share is a
 * workspace, so it works one task at a time (see agents/runner.ts). Everything the UI needs to
 * answer "who is busy, and what happened" comes out of the queue and the carbons.
 */
/**
 * `workload` comes from an orchestration profile's role binding — ADR 0001 stage 3 — so a slot
 * can name not just which model answers but which of its workloads it answers under.
 */
const agentProvider = (providerName: string | null, model: string | null, workload?: string | null) => {
  const configs = providerManager.listProviders();
  let resolved;
  try {
    resolved = resolveAgentModel(configs, providerName, model, lastUsed.read());
  } catch (error) {
    console.error(`[agents] ${(error as Error).message}`);
    // A router with no preference can still make its deterministic offline guess. An agent or
    // profile that named a source/model supplied a hard constraint, so surface its exact failure.
    if (providerName === null && model === null) return null;
    throw error;
  }

  const provider = providerManager.getProvider(resolved.source.id);
  if (!provider) throw new Error(`Inference source "${resolved.source.name}" is configured but unavailable.`);

  const profile = profileFor(resolved.source.id, resolved.model, workload ?? undefined);
  return {
    provider,
    providerId: resolved.source.id,
    model: resolved.model,
    instructions: profile.instructions,
    sourceName: resolved.source.name,
    maxOutputTokens: profile.maxOutputTokens,
    maxToolCalls: profile.maxToolCallsPerMessage,
    thinkingLevel: profile.thinkingLevel,
    budgetTokens: promptBudget(profile, []),
    budgetForTools: (tools: readonly ToolDefinition[]) => promptBudget(profile, tools),
  };
};

/**
 * A routed run's answer, delivered into the turn that gave the work away.
 *
 * It joins the same assistant row as the handoff note, so the conversation reads as one thing —
 * asked, handed over, answered — instead of stopping at the handoff with the answer visible only
 * to whoever thinks to open the carbon. The renderer routes stream text by message id and ignores
 * an id it cannot find, so a thread deleted while the agent worked costs nothing.
 */
const deliverTaskResult = (task: Task, result: agentRunner.TaskResult): void => {
  if (!task.reply) return;
  const headline = result.ending
    ? `**${result.agentName}** stopped — ${result.ending}`
    : `**${result.agentName}** finished${result.summary ? ` — ${result.summary}` : ''}`;
  const body = result.content.trim();
  send('chat:stream-data', {
    id: task.reply.messageId,
    content: `\n\n---\n\n_${headline}._\n\n${body || '_It wrote nothing._'}`,
  });
  carbon.note(task.reply.threadId, `${headline}${body ? '' : ' (no answer)'}`);
};

/**
 * Whether a model can be shown a picture or made to hear, as its source reports it.
 *
 * The catalog's `vision` flag is what a source said about this model, not a guess from its name
 * (see preview/eyes.ts: the same checkpoint is text-only served without its projector). A model
 * carried by more than one source counts as a perceiver if any of them said so. Used only to
 * decide whether a chat child keeps a perception role's binding rather than inheriting the
 * conversation's text-only model.
 */
const modelPerceives = (model: string): boolean =>
  providerManager.listProviders().some((source) =>
    source.models.some((candidate) => candidate.id === model && candidate.vision === true));

agentRunner.configure({
  augmentRuntime: (runtime, workspace, context) => withCodeReview(skillRuntime(
    context?.interactive ? withTerminal(runtime, { workspace, threadId: context.threadId }) : runtime,
    workspace
  ), { store: codeReviews, workspace, author: { kind: 'agent', label: context?.agentName ?? 'Agent',
    threadId: context?.threadId, runId: context?.taskId } }),
  additionalInstructions: (workspace) => [skillInstructions(workspace), CODE_REVIEW_INSTRUCTIONS].filter(Boolean).join('\n\n'),
  resolveProvider: agentProvider,
  perceives: modelPerceives,
  defaultWorkspace: () => mcpStore.workspace(),
  defaultWorkspaceConfirmed: () => mcpStore.workspaceConfirmed(),
  onActivity: (activity) => send('agents:activity', activity),
  onContent: (taskId, content, sessionId, revision, contentOffset) =>
    send('agents:content', { taskId, content, sessionId, revision, contentOffset }),
  onChange: () => send('agents:changed', { at: Date.now() }),
  onResult: deliverTaskResult,
});

/** Scheduled work needs someone to notice it is due; a minute is fine for a minute-granular spec. */
const DUE_CHECK_MS = 20_000;
setInterval(() => {
  if (!automaticRestartCommitting) agentRunner.tick();
}, DUE_CHECK_MS).unref();

/**
 * The renderer says what chat is pointed at as it dispatches. Without this, an agent dispatched
 * before anyone has sent a message falls back to the first configured source, which is often one
 * that is not running.
 */
ipcMain.handle('agents:useSource', (_event, providerId: string, model: string) => {
  if (providerId && model) lastUsed.select(providerId, model);
});

ipcMain.handle('agents:list', () => agents.ensureSeeded());
ipcMain.handle('agents:save', (_event, definition: Parameters<typeof agents.save>[0]) => agents.save(definition));
ipcMain.handle('agents:remove', (_event, id: string) => agents.remove(id));
ipcMain.handle('agents:location', () => agents.location());

// Orchestration profiles: which model takes which role inside one run. Seeded on read, like
// agents, so the first window to ask is what creates them.
ipcMain.handle('orchestration:list', () => {
  const all = profiles.ensureSeeded();
  return { profiles: all, selectedId: profiles.selected()?.id ?? null };
});
ipcMain.handle('orchestration:select', (_event, id: string | null) => profiles.select(id)?.id ?? null);
ipcMain.handle('orchestration:location', () => profiles.location());
// Renaming and tagging are the only writes the renderer gets. Creating or rewriting a whole
// profile stays a file you edit: these two edit exactly one field and keep your comments.
ipcMain.handle('orchestration:rename', (_event, id: string, name: string) => {
  if (typeof id !== 'string' || typeof name !== 'string') throw new Error('Invalid profile rename.');
  return profiles.rename(id, name);
});
ipcMain.handle('orchestration:setMode', (_event, id: string, mode: unknown) => {
  if (typeof id !== 'string') throw new Error('Invalid profile.');
  if (mode !== null && mode !== 'local' && mode !== 'distributed' && mode !== 'provider') throw new Error('Unknown profile mode.');
  return profiles.setMode(id, mode as 'local' | 'distributed' | 'provider' | null);
});

/**
 * Create or replace a profile from the editor — ADR 0001 stage 3.
 *
 * `save()` re-serialises from parsed fields, which is right for a profile this app wrote and
 * destructive for one a person hand-wrote: it would drop their comments. So a built-in-shaped
 * rewrite is refused here unless the profile is one we generated or is new. Rename and category
 * keep their surgical single-field edits for exactly that reason.
 */
ipcMain.handle('orchestration:save', (event, input: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid profile.');
  const draft = input as { id?: unknown; name?: unknown; description?: unknown; mode?: unknown; roles?: unknown };
  const id = profiles.assertId(typeof draft.id === 'string' ? draft.id : '');
  if (typeof draft.name !== 'string' || !draft.name.trim()) throw new Error('Choose a profile name.');
  if (draft.name.length > 80) throw new Error('Keep the profile name under 80 characters.');
  const description = typeof draft.description === 'string' ? draft.description.trim() : '';
  if (description.length > 500) throw new Error('Keep the profile description under 500 characters.');
  if (draft.mode !== undefined && draft.mode !== 'local' && draft.mode !== 'distributed' && draft.mode !== 'provider') {
    throw new Error('Unknown profile mode.');
  }
  if (!draft.roles || typeof draft.roles !== 'object' || Array.isArray(draft.roles)) throw new Error('A profile needs its roles.');

  const roles: Record<string, { provider: string | null; model: string; workload?: string | null }> = {};
  for (const [role, value] of Object.entries(draft.roles as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(role)) throw new Error(`"${role}" is not a usable role name.`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Role "${role}" needs a model.`);
    const entry = value as { provider?: unknown; model?: unknown; workload?: unknown };
    if (typeof entry.model !== 'string' || !entry.model.trim()) throw new Error(`Role "${role}" needs a model.`);
    const provider = typeof entry.provider === 'string' && entry.provider ? entry.provider : null;
    // An unknown source or model would resolve to nothing at dispatch, which the runner reports
    // on the agent that happened to be first. Refuse it here, where the person can see it.
    const source = provider ? providerManager.listProviders().find((candidate) => candidate.id === provider) : null;
    if (provider && !source) throw new Error(`Role "${role}" names a source that is not configured.`);
    if (source && !source.models.some((candidate) => candidate.id === entry.model)) {
      throw new Error(`Role "${role}": ${source.name} does not serve "${entry.model}".`);
    }
    const workload = typeof entry.workload === 'string' && entry.workload ? entry.workload : null;
    if (workload && source && !modelProfiles.hasWorkload(source.id, entry.model, workload)) {
      throw new Error(`Role "${role}": "${entry.model}" has no workload "${workload}".`);
    }
    roles[role] = { provider, model: entry.model.trim(), ...(workload ? { workload } : {}) };
  }
  if (!roles.default) throw new Error('A profile needs a default role, or some agent would have no model.');

  const existing = profiles.find(id);
  if (existing?.builtin) throw new Error('That profile is built in; copy it under a new name instead.');
  return profiles.save({ id, name: draft.name.trim(), description,
    ...(draft.mode ? { mode: draft.mode as 'local' | 'distributed' | 'provider' } : {}), roles });
});

ipcMain.handle('orchestration:remove', (event, id: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  if (typeof id !== 'string') throw new Error('Invalid profile.');
  profiles.remove(id);
  return profiles.list();
});

ipcMain.handle('routing:enabled', () => routing.enabled());
ipcMain.handle('routing:set', (_event, value: boolean) => routing.setEnabled(value));

ipcMain.handle('agents:tasks', () => taskQueue.list());
ipcMain.handle('agents:counts', () => taskQueue.counts());
ipcMain.handle('agents:activity', () => {
  const names = new Map(agents.list().map((agent) => [agent.id, agent.name] as const));
  return { active: taskQueue.activity(names), busy: agentRunner.busy(), counts: taskQueue.counts() };
});

ipcMain.handle('agents:dispatch', (_event, input: NewTask) => {
  assertNotCommittingAutomaticRestart();
  const task = taskQueue.add(input);
  agentRunner.tick();
  return task;
});

/** Asks the main model who a request belongs to, then queues it for them. */
ipcMain.handle('agents:route', async (_event, text: string, workspace?: string | null) => {
  assertNotCommittingAutomaticRestart();
  agents.ensureSeeded();
  const choice = agentProvider(null, null);
  const routed = choice
    ? await router.route(text, { provider: choice.provider, providerId: choice.providerId, model: choice.model })
    : router.guess(text);
  if (!routed) return { routed: null, task: null };

  const task = taskQueue.add({
    agentId: routed.agentId,
    title: routed.title,
    prompt: text,
    source: 'router',
    workspace: workspace ?? null,
  });
  agentRunner.tick();
  return { routed, task };
});

ipcMain.handle('agents:cancelTask', (_event, taskId: string) => {
  agentRunner.stop(taskId);
  return taskQueue.list();
});
ipcMain.handle('agents:sendMessage', (_event, taskId: string, message: string, interrupt?: boolean) => {
  if (typeof taskId !== 'string' || typeof message !== 'string') throw new Error('Choose a running task and enter a message.');
  agentRunner.sendMessage(taskId, message, interrupt === true);
});
ipcMain.handle('agents:setSchedulePaused', (_event, taskId: string, paused: boolean) => {
  if (typeof taskId !== 'string' || typeof paused !== 'boolean') throw new Error('Choose a schedule and whether to pause it.');
  return taskQueue.setSchedulePaused(taskId, paused);
});
ipcMain.handle('agents:removeTask', (_event, taskId: string) => {
  taskQueue.remove(taskId);
  return taskQueue.list();
});

/** The session behind a task: its carbon, read straight off disk. */
/** A regular, non-executable file whose first block holds no NUL byte. */
function isPlainText(path: string): boolean {
  const stats = statSync(path);
  if (!stats.isFile() || (stats.mode & 0o111) !== 0) return false;
  const descriptor = openSync(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(stats.size, 8192));
    readSync(descriptor, head, 0, head.length, 0);
    return !head.includes(0);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Opens a file a conversation wrote, from the list beside the transcript.
 *
 * The path came from a model's tool call, so it is held to the working directory, and only text
 * is handed to the desktop's default application: anything else, an executable especially, is
 * shown in its folder instead of being opened.
 */
ipcMain.handle('outputs:open', async (_event, path: string) => {
  const root = resolve(mcpStore.workspace());
  const target = insideWorkspace(root, String(path ?? ''));
  if (!existsSync(target)) throw new Error(`${path} is not there any more.`);
  if (!isPlainText(target)) {
    shell.showItemInFolder(target);
    return 'revealed';
  }
  const failure = await shell.openPath(target);
  if (failure) throw new Error(failure);
  return 'opened';
});

/**
 * The pixels behind a preview, for the transcript and the Preview section to draw.
 *
 * Images are fetched rather than carried: a tool result is text that goes into the conversation,
 * the carbon and the model's next prompt, and a base64 screenshot in any of those would be a
 * megabyte of noise in all three. The path in the transcript is the handle, and this turns it
 * back into an image only when something is about to display one.
 *
 * `inline` is the transcript's copy and is deliberately small — it is drawn at thumbnail size and
 * a full screenshot per row would cost more memory than the conversation it illustrates.
 */
function previewHost(sender: Electron.WebContents): BrowserWindow {
  const window = mainWindow;
  if (!window || window.isDestroyed() || sender !== window.webContents) {
    throw new Error('Preview is only available from the main Antimatter window.');
  }
  return window;
}

ipcMain.handle('preview:image', (event, input: ImagePreviewRequest & { inline?: boolean }) => {
  previewHost(event.sender);
  const { workspace, target } = boundPreviewImage(mcpStore.workspace(), input);
  if (!existsSync(target)) throw new Error(`${input?.path} is not there any more.`);

  const image = capture.loadImage(target, workspace);
  const drawn = capture.fit(image, input?.inline ? capture.INLINE_LONG_EDGE : capture.LOOK_LONG_EDGE);
  return {
    dataUrl: capture.dataUrl(drawn.bytes, drawn.mediaType),
    width: image.width,
    height: image.height,
    bytes: image.bytes.length,
  };
});

/**
 * The live page in the Preview pane.
 *
 * The renderer drives this rather than the tool, because the page has to be laid over whatever
 * area the pane ended up occupying and only the renderer knows where that is. `preview_url` just
 * files a preview; opening it is the window's job, on the frame the pane is actually on screen.
 */
pane.onChange((state) => send('preview:page', state));

ipcMain.handle('preview:page:open', (event, url: string) => {
  const window = previewHost(event.sender);
  pane.open(window, previewableUrl(String(url ?? '')));
});

ipcMain.on('preview:page:bounds', (event, bounds: { x: number; y: number; width: number; height: number } | null) => {
  try {
    previewHost(event.sender);
  } catch {
    return;
  }
  pane.setBounds(bounds);
});
ipcMain.handle('preview:page:back', (event) => {
  previewHost(event.sender);
  pane.goBack();
});
ipcMain.handle('preview:page:forward', (event) => {
  previewHost(event.sender);
  pane.goForward();
});
ipcMain.handle('preview:page:reload', (event) => {
  previewHost(event.sender);
  pane.reload();
});
ipcMain.handle('preview:page:close', (event) => {
  previewHost(event.sender);
  pane.close();
});

ipcMain.handle('agents:session', (_event, taskId: string) => {
  const task = taskQueue.find(taskId);
  if (!task?.carbonId) return null;
  const path = carbon.pathFor(task.carbonId);
  return { task, path, markdown: carbon.contents(task.carbonId) ?? (path ? carbon.read(path) : null),
    transcript: agentTranscripts.read(taskId, task.carbonId) };
});

/**
 * The coding environment: a file tree, an editor, a run console and a debugger.
 *
 * Opening a directory here is a person choosing a working directory, so it is treated as one —
 * the tool servers are pointed at it and it counts as confirmed. That is what makes the floating
 * assistant useful: it is reading and writing the same tree you have open, not a different one.
 */
envExec.connect({
  onData: (id, data) => send('env:output', { id, data, source: 'run' }),
  onExit: (id, exit) => send('env:exit', { id, ...exit, source: 'run' }),
});

envDebug.connect({
  onState: (state) => send('env:debug-state', state),
  onData: (data) => send('env:output', { data, source: 'debug' }),
  onExit: (exit) => send('env:exit', { ...exit, source: 'debug' }),
});

let environmentOpenTail: Promise<unknown> = Promise.resolve();
function openEnvironment(directory: string | null, threadId?: string): Promise<{ root: string; entries: envFiles.Entry[] }> {
  const opening = environmentOpenTail.then(async () => {
    const bound = threadId === undefined ? null : workspaceForConversation(threadId);
    if (threadId !== undefined && !bound) throw new Error('Conversation not found.');
    if (bound && !bound.available) throw new Error(bound.reason);
    if (bound && directory && resolve(directory) !== bound.path) {
      throw new Error('This chat’s folder changed. Reopen Code to use its current folder.');
    }
    const target = bound?.path ?? (directory || mcpStore.workspace());
    if (envFiles.location() && resolve(target) !== envFiles.location()) {
      nyBuildController?.abort(); nyLanguageService?.dispose(); nyLanguageService = null; disposeNilAnalysis(); nativeProject?.dispose();
      envExec.stop(); await envDebug.stop();
    }
    const root = envFiles.useRoot(target);
    if (!bound && (mcpStore.workspace() !== root || !mcpStore.workspaceConfirmed())) {
      await withMcpControl(async () => {
        mcpStore.setWorkspace(root, true);
        await mcp.shutdown();
        await mcp.connectEnabled();
      });
      send('mcp:workspace-changed', { workspace: root, confirmed: true });
    }
    return { root, entries: envFiles.list('') };
  });
  environmentOpenTail = opening.catch(() => undefined);
  return opening;
}

const handleEnvironment = (channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) => {
  ipcMain.handle(channel, (event, ...args) => { requireTrustedMain(event); return listener(event, ...args); });
};
nativeProject = registerNativeProjectIpc({ ipc: ipcMain, assertTrusted: (event) => { requireTrustedMain(event as Electron.IpcMainInvokeEvent); assertNotCommittingAutomaticRestart(); },
  root: envFiles.location, cacheDirectory: () => join(app.getPath('userData'), 'native-builds'), send,
  run: envExec.start, debug: envDebug.startNative, createLanguageService: (root, cache) => new NativeLanguageServices(root, cache) });
handleEnvironment('env:open', (_event, directory: string | null, threadId?: string) => {
  if (threadId !== undefined && (typeof threadId !== 'string' || !threadId)) throw new Error('Invalid conversation ID.');
  if (directory !== null && typeof directory !== 'string') throw new Error('Invalid Code folder.');
  return openEnvironment(directory, threadId);
});
handleEnvironment('env:list', (_event, directory: string) => envFiles.list(directory));
handleEnvironment('env:read', (_event, path: string) => envFiles.read(path));
handleEnvironment('env:write', (_event, path: string, text: string, expected?: { root: string; revision: string }) => envFiles.write(path, text, expected));
handleEnvironment('env:create', (_event, path: string, kind: 'file' | 'directory') => envFiles.create(path, kind));
handleEnvironment('env:rename', (_event, from: string, to: string) => envFiles.rename(from, to));
handleEnvironment('env:delete', (_event, path: string) => envFiles.remove(path));
handleEnvironment('env:unchanged', (_event, path: string, modified: number) => envFiles.unchangedSince(path, modified));

handleEnvironment('env:suggestCommand', (_event, path: string) => envExec.suggestCommand(path, envFiles.location()));

handleEnvironment('env:run', async (_event, commandLine: string, label: string) => {
  assertNotCommittingAutomaticRestart();
  const { command, args } = envExec.splitCommand(commandLine);
  if (!command) throw new Error('There is no command to run.');
  return envExec.start({ command, args, cwd: envFiles.location(), label });
});
handleEnvironment('env:runState', () => envExec.current());
handleEnvironment('env:input', (_event, data: string) => envExec.write(data));
handleEnvironment('env:resize', (_event, cols: number, rows: number) => envExec.resize(cols, rows));
handleEnvironment('env:stop', () => { nativeProject?.cancel(); envExec.stop(); });

handleEnvironment('env:debuggable', (_event, path: string) => envDebug.debuggable(path));
handleEnvironment('env:debugStart', (_event, path: string, breakpoints: envDebug.Breakpoint[]) => {
  assertNotCommittingAutomaticRestart();
  const file = envFiles.within(path);
  const nySdkPath = /\.(ny|matrix|mat|nil)$/i.test(file) ? resolveNyToolchain(envFiles.location(), nyOptions()).sdkPath ?? nyOptions().sdkPath : undefined;
  return envDebug.start({ file, root: envFiles.location(), breakpoints, nySdkPath });
});
handleEnvironment('env:debugState', () => envDebug.state());
handleEnvironment('env:debugBreakpoints', (_event, breakpoints: envDebug.Breakpoint[]) =>
  envDebug.applyBreakpoints(breakpoints)
);
handleEnvironment('env:debugResume', () => envDebug.resume());
handleEnvironment('env:debugPause', () => envDebug.pause());
handleEnvironment('env:debugSelectFrame', (_event, frameId: string) => envDebug.selectFrame(frameId));
handleEnvironment('env:debugStepOver', () => envDebug.stepOver());
handleEnvironment('env:debugStepInto', () => envDebug.stepInto());
handleEnvironment('env:debugStepOut', () => envDebug.stepOut());
handleEnvironment('env:debugEval', (_event, expression: string, frameId?: string) =>
  envDebug.evaluate(expression, frameId)
);
handleEnvironment('env:debugStop', () => envDebug.stop());

// Ny tool paths are application preferences, never executable commands read from a project file.
const nySettingsPath = join(app.getPath('userData'), 'ny-tools.json');
const nyOptions = () => {
  let sdkPath: string | undefined;
  if (existsSync(nySettingsPath)) {
    const saved: unknown = JSON.parse(readFileSync(nySettingsPath, 'utf8'));
    if (!saved || typeof saved !== 'object' || typeof (saved as { sdkPath?: unknown }).sdkPath !== 'string') throw new Error('Ny SDK settings could not be read. Select the SDK again.');
    sdkPath = (saved as { sdkPath: string }).sdkPath || undefined;
  }
  return { sdkPath, appDirectory: app.getAppPath() };
};
let nyLanguageService: NyLanguageServer | null = null;
let nyLanguageKey = '';
let nilAnalysisService: NilAnalysisService | null = null;
let nilAnalysisKey = '';
let nilAnalysisGeneration = 0;
let nilDescriptionController = new AbortController();
let nilDescriptionQueue: Promise<unknown> = Promise.resolve();
const nilDescriptions = new Map<string, ReturnType<typeof describeNilProject>>();
const disposeNilAnalysis = () => {
  nilAnalysisGeneration++; nilAnalysisService?.dispose(); nilAnalysisService = null;
  nilDescriptionController.abort(); nilDescriptionController = new AbortController(); nilDescriptions.clear();
};
// Coalesce editor requests for one manifest version and serialize uncached descriptions.
// Saving the manifest changes the key; workspace/SDK changes cancel queued work.
const analysisProject = (root: string, path: string, options: ReturnType<typeof nyOptions>) => {
  const manifest = findNilProject(root, path);
  if (!manifest) return Promise.resolve(null);
  const stat = statSync(manifest);
  const key = JSON.stringify([root, options, manifest, stat.mtimeMs, stat.ctimeMs, stat.size]);
  const cached = nilDescriptions.get(key); if (cached) return cached;
  const signal = nilDescriptionController.signal;
  const description = nilDescriptionQueue.catch(() => undefined).then(() => {
    signal.throwIfAborted(); return describeNilProject(root, manifest, options, signal);
  });
  nilDescriptionQueue = description;
  nilDescriptions.set(key, description);
  if (nilDescriptions.size > 8) nilDescriptions.delete(nilDescriptions.keys().next().value!);
  void description.catch(() => { if (nilDescriptions.get(key) === description) nilDescriptions.delete(key); });
  return description;
};
let nyBuildController: AbortController | null = null;
const nyRoot = () => envFiles.location() || mcpStore.workspace();
const nyStatus = (): NyStatus => {
  const options = nyOptions(); const tools = resolveNyToolchain(nyRoot(), options);
  const available = !!tools.lsp || !!tools.compiler;
  return { available, sdkPath: tools.sdkPath, configuredPath: options.sdkPath ?? '', compiler: !!tools.compiler, interpreter: !!tools.interpreter,
    debugger: !!tools.debugger, lsp: !!tools.lsp, builder: !!tools.builder, family: tools.family, message: available ? 'NIL Framework language tools ready.' : tools.error || 'Select a NIL Framework SDK to enable language tools.' };
};
const nyLanguage = (document: NyDocument) => {
  const root = nyRoot(); nySourcePath(root, document?.path);
  const options = nyOptions(); const key = JSON.stringify([root, options]);
  if (!nyLanguageService || key !== nyLanguageKey) { nyLanguageService?.dispose(); nyLanguageService = new NyLanguageServer(root, options); nyLanguageKey = key; }
  return nyLanguageService;
};
const nyBuild = async (path: string, mode: 'check' | 'build') => {
  assertNotCommittingAutomaticRestart();
  if (nyBuildController) throw new Error('A Ny build is already running. Cancel it before starting another.');
  const controller = new AbortController(); nyBuildController = controller;
  try { return await buildNyFile(nyRoot(), path, mode, nyOptions(), controller.signal); }
  finally { if (nyBuildController === controller) nyBuildController = null; }
};
const nilAnalysis = async (document: NyDocument) => {
  const root = nyRoot(); nySourcePath(root, document?.path);
  const generation = nilAnalysisGeneration; const options = nyOptions(); const tools = resolveNyToolchain(root, options);
  if (tools.family !== 'nil' || !tools.compiler) return null;
  const project = await analysisProject(root, document.path, options);
  if (generation !== nilAnalysisGeneration || root !== nyRoot()) throw new Error('The language workspace changed.');
  const context = project ? { includePaths: project.includePaths, sdkPath: project.sdkPath ?? undefined, ...project.analysis } : {};
  const key = JSON.stringify([root, options, context]);
  if (!nilAnalysisService || key !== nilAnalysisKey) {
    nilAnalysisService?.dispose(); nilAnalysisService = new NilAnalysisService(root, options, context); nilAnalysisKey = key;
  }
  return nilAnalysisService;
};
ipcMain.handle('ny:status', event => { requireMainFrame(event); return nyStatus(); });
ipcMain.handle('ny:restart', event => {
  requireMainFrame(event); nyLanguageService?.dispose(); nyLanguageService = null; disposeNilAnalysis();
  return nyStatus();
});
ipcMain.handle('ny:chooseSdk', async event => {
  requireMainFrame(event);
  const chosen = await dialog.showOpenDialog(mainWindow!, { title: 'Select NIL Framework SDK or repository', properties: ['openDirectory'] });
  if (chosen.canceled || !chosen.filePaths[0]) return null;
  const sdkPath = chosen.filePaths[0]; const tools = resolveNyToolchain(nyRoot(), { sdkPath });
  if (!tools.compiler || !tools.interpreter || !tools.lsp || !tools.debugger) throw new Error('Choose a complete NIL Framework SDK with compiler, interpreter, language server, and debugger tools.');
  writePrivateFileAtomic(nySettingsPath, JSON.stringify({ version: 1, sdkPath }, null, 2) + '\n');
  nyLanguageService?.dispose(); nyLanguageService = null; disposeNilAnalysis();
  return nyStatus();
});
ipcMain.handle('ny:completion', async (event, document: NyDocument) => {
  requireMainFrame(event); const analyzer = await nilAnalysis(document);
  if (analyzer) return analyzer.completion(document);
  const result = await nyLanguage(document).query('completion', document);
  return Array.isArray(result) ? result : (result && typeof result === 'object' && 'items' in result && Array.isArray(result.items) ? result.items : []);
});
ipcMain.handle('ny:hover', (event, document: NyDocument) => { requireMainFrame(event); return nyLanguage(document).query('hover', document); });
ipcMain.handle('ny:symbols', (event, document: NyDocument) => { requireMainFrame(event); return nyLanguage(document).query('documentSymbol', document); });
ipcMain.handle('ny:inspectNil', (event, path: string) => { requireMainFrame(event); return inspectNyModule(nyRoot(), path); });
ipcMain.handle('ny:diagnostics', async (event, document: NyDocument) => { requireMainFrame(event); const analyzer = await nilAnalysis(document); return analyzer ? analyzer.diagnostics(document) : nyLanguage(document).diagnostics(document); });
ipcMain.handle('ny:definition', async (event, document: NyDocument) => {
  requireMainFrame(event); const analyzer = await nilAnalysis(document);
  if (analyzer) return analyzer.definition(document);
  const result = await nyLanguage(document).query('definition', document);
  return (Array.isArray(result) ? result : result ? [result] : []).flatMap((location: NyLocation) => {
    try { const file = nySourcePath(nyRoot(), fileURLToPath(location.uri)); return [{ ...location, path: relative(realpathSync(nyRoot()), file).replace(/\\/g, '/') }]; }
    catch { return []; }
  });
});
ipcMain.handle('ny:check', (event, path: string) => { requireMainFrame(event); return nyBuild(path, 'check'); });
ipcMain.handle('ny:build', (event, path: string) => { requireMainFrame(event); return nyBuild(path, 'build'); });
ipcMain.handle('ny:cancel', event => { requireMainFrame(event); nyBuildController?.abort(); });
ipcMain.handle('ny:run', async (event, path: string) => {
  requireMainFrame(event); const root = nyRoot(); const tools = resolveNyToolchain(root, nyOptions());
  if (!tools.interpreter) throw new Error('Select a NIL Framework SDK containing an interpreter.');
  if (typeof path === 'string' && /\.nil$/i.test(path)) {
    assertNotCommittingAutomaticRestart();
    return envExec.start({ command: tools.interpreter, args: [nyModulePath(root, path)], cwd: root, label: `NIL · ${path}` });
  }
  const result = await nyBuild(path, 'build');
  if (!result.success || !result.artifact) throw new Error(result.output);
  if (root !== nyRoot()) throw new Error('The project changed while compiling. Run again in the selected project.');
  return envExec.start({ command: tools.interpreter, args: [result.artifact], cwd: root, label: `Ny · ${path}` });
});
ipcMain.handle('ny:createProject', async (event, name: string) => {
  requireMainFrame(event);
  const chosen = await dialog.showOpenDialog(mainWindow!, { title: 'Choose parent folder for the new Ny project', properties: ['openDirectory', 'createDirectory'] });
  if (chosen.canceled || !chosen.filePaths[0]) return null;
  return createNyProject(chosen.filePaths[0], name);
});

// Project tasks share cancellation with single-file builds. No command text comes from manifests.
async function nilOperation<T>(operation: (root: string, signal: AbortSignal) => Promise<T>): Promise<T> {
  assertNotCommittingAutomaticRestart();
  if (nyBuildController) throw new Error('A build is already running. Stop it before starting another task.');
  const controller = new AbortController(); nyBuildController = controller;
  try { return await operation(nyRoot(), controller.signal); }
  finally { if (nyBuildController === controller) nyBuildController = null; }
}
ipcMain.handle('nil-project:describe', (event, path?: string) => {
  requireMainFrame(event); return describeNilProject(nyRoot(), path, nyOptions());
});
ipcMain.handle('nil-project:check', (event, path?: string) => {
  requireMainFrame(event); return nilOperation((root, signal) => buildNilProject(root, path, 'check', nyOptions(), signal));
});
ipcMain.handle('nil-project:build', (event, path?: string, target: NilProjectTarget = 'vm') => {
  requireMainFrame(event); return nilOperation((root, signal) => buildNilProject(root, path, 'build', nyOptions(), signal, target));
});
ipcMain.handle('nil-project:run', (event, path?: string, target: NilProjectTarget = 'vm') => {
  requireMainFrame(event);
  return nilOperation(async (root, signal) => {
    const options = nyOptions();
    const project = await describeNilProject(root, path, options, signal);
    signal.throwIfAborted();
    if (root !== nyRoot()) throw new Error('The workspace changed. Run again in the selected workspace.');
    if (!project) throw new Error('No NIL project manifest (nil.project.nildata, .json, .yaml or .yml) was found in this workspace.');
    await envDebug.stop();
    signal.throwIfAborted();
    return envExec.start(nilProjectInvocation(project, resolveNyToolchain(root, options), 'run', target));
  });
});
ipcMain.handle('nil-project:debug', (event, path: string | undefined, breakpoints: envDebug.Breakpoint[]) => {
  requireMainFrame(event); assertNotCommittingAutomaticRestart();
  if (nyBuildController) throw new Error('Stop the current build before debugging.');
  const root = nyRoot(); const projectFile = findNilProject(root, path);
  if (!projectFile) throw new Error('No NIL project manifest (nil.project.nildata, .json, .yaml or .yml) was found in this workspace.');
  envExec.stop();
  const options = nyOptions();
  return envDebug.start({ file: projectFile, nilProjectPath: projectFile, root, breakpoints, nySdkPath: resolveNyToolchain(root, options).sdkPath ?? options.sdkPath });
});
ipcMain.handle('nil-project:create', async (event, name: string, language: NilProjectLanguage) => {
  requireMainFrame(event);
  const chosen = await dialog.showOpenDialog(mainWindow!, { title: 'Choose parent folder for the new NIL Framework project', properties: ['openDirectory', 'createDirectory'] });
  if (chosen.canceled || !chosen.filePaths[0]) return null;
  return createNilProject(chosen.filePaths[0], name, language);
});

// Conversations: the threads themselves, what is selected, what is pinned, and anything typed
// but not sent. Saved here rather than in the renderer's storage so a conversation survives a
// reload, a restart, and a look at the file.
const chatImports = new ChatImportService({
  origins: () => conversations.snapshot().threads.flatMap((thread) => thread.importedFrom ? [thread.importedFrom] : []),
  import: (input) => conversations.importThreads(input),
});
function requireChatImportFrame(event: Electron.IpcMainInvokeEvent): void {
  requireMainFrame(event);
  if (!event.senderFrame || !isAppearancePage(event.senderFrame.url, 'index.html', join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL)) {
    throw new Error('Chat imports are available only in the main Antimatter window.');
  }
}
function requireChatCoordinationFrame(event: Electron.IpcMainInvokeEvent): void {
  requireMainFrame(event);
  if (!event.senderFrame || !isAppearancePage(event.senderFrame.url, 'index.html', join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL)) {
    throw new Error('Chat connections are available only in the main Antimatter window.');
  }
}
function requireRuntimeProfilesFrame(event: Electron.IpcMainInvokeEvent): void {
  requireMainFrame(event);
  if (!event.senderFrame || !isAppearancePage(event.senderFrame.url, 'index.html', join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL)) {
    throw new Error('Runtime profiles are available only in the main Antimatter window.');
  }
}
function requireBotChatFrame(event: Electron.IpcMainInvokeEvent): void {
  requireMainFrame(event);
  if (!event.senderFrame || !isAppearancePage(event.senderFrame.url, 'index.html', join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL)) {
    throw new Error('Bot chat controls are available only in the main Antimatter window.');
  }
}
registerBotChatIpc(ipcMain, { requireSender: requireBotChatFrame, store: requireBotChat });
ipcMain.handle('model-runtime-profiles:state', (event, sourceId: string, modelId: string) => {
  requireRuntimeProfilesFrame(event);
  return requireRuntimeProfiles().state(sourceId, modelId);
});
ipcMain.handle('model-runtime-profiles:capture', (event, sourceId: string, modelId: string) => {
  requireRuntimeProfilesFrame(event);
  return requireRuntimeProfiles().capture(sourceId, modelId);
});
ipcMain.handle('model-runtime-profiles:copy', (event, sourceId: string, modelId: string, profileId: string) => {
  requireRuntimeProfilesFrame(event);
  return requireRuntimeProfiles().copy(sourceId, modelId, profileId);
});
ipcMain.handle('model-runtime-profiles:remove', (event, sourceId: string, modelId: string, profileId: string) => {
  requireRuntimeProfilesFrame(event);
  return requireRuntimeProfiles().remove(sourceId, modelId, profileId);
});
ipcMain.handle('model-runtime-profiles:update', (event, sourceId: string, modelId: string, profileId: string, patch: import('../api/modelRuntimeProfiles').ModelRuntimeProfilePatch) => {
  requireRuntimeProfilesFrame(event);
  return requireRuntimeProfiles().update(sourceId, modelId, profileId, patch);
});
ipcMain.handle('model-runtime-profiles:apply', (event, sourceId: string, modelId: string, profileId: string) => {
  requireRuntimeProfilesFrame(event);
  return requireRuntimeProfiles().apply(sourceId, modelId, profileId);
});
ipcMain.handle('chat-coordination:state', (event, threadId: string) => {
  requireChatCoordinationFrame(event);
  return requireChatCoordination().state(threadId);
});
ipcMain.handle('chat-coordination:connect', (event, threadId: string, peerId: string) => {
  requireChatCoordinationFrame(event);
  const store = requireChatCoordination();
  store.connect(threadId, peerId);
  return store.state(threadId);
});
ipcMain.handle('chat-coordination:disconnect', (event, threadId: string, peerId: string) => {
  requireChatCoordinationFrame(event);
  const store = requireChatCoordination();
  store.disconnect(threadId, peerId);
  return store.state(threadId);
});
ipcMain.handle('chat-coordination:dismiss', (event, threadId: string, messageId: string) => {
  requireChatCoordinationFrame(event);
  const store = requireChatCoordination();
  store.dismiss(threadId, messageId);
  return store.state(threadId);
});
ipcMain.handle('chat-import:choose', async (event, value: unknown) => {
  requireChatImportFrame(event);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid import choice.');
  const { source, mode } = value as Record<string, unknown>;
  if ((source !== 'claude' && source !== 'codex' && source !== 'opencode') || (mode !== 'files' && mode !== 'folder')) throw new Error('Invalid import choice.');
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: `Import ${{ claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }[source]} chats`,
    defaultPath: source === 'codex' ? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
      : source === 'claude' && mode === 'folder' ? join(homedir(), '.claude', 'projects') : app.getPath('downloads'),
    properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
    ...(mode === 'files' ? { filters: [{ name: 'Chat exports and sessions', extensions: source === 'opencode' ? ['json'] : ['json', 'jsonl'] }] } : {}),
  });
  requireChatImportFrame(event);
  if (result.canceled || !result.filePaths.length) return null;
  return chatImports.prepare(event.sender.id, result.filePaths, source, mode);
});
ipcMain.handle('chat-import:commit', (event, value: unknown) => { requireChatImportFrame(event); return chatImports.commit(event.sender.id, value); });
ipcMain.handle('chat-import:discard', (event, batchId: unknown) => {
  requireChatImportFrame(event);
  if (typeof batchId !== 'string' || batchId.length > 64) throw new Error('Invalid import preview.');
  chatImports.discard(event.sender.id, batchId);
});
/** Freeze inherited folders before another chat can change the global default. */
function workspaceForConversation(threadId: string, persist = true) {
  const thread = conversations.chatMetadata().find((candidate) => candidate.id === threadId);
  if (!thread) return null;
  const bound = thread.workspaceBinding;
  const workspace = resolveConversationWorkspace(thread, {
    defaultWorkspace: bound?.path ?? mcpStore.workspace(),
    defaultConfirmed: bound?.confirmed ?? mcpStore.workspaceConfirmed(),
    context: thread.workspaceBinding === undefined ? transcriptCache.context(threadId) : null,
  });
  if (persist && workspace.needsBinding) conversations.bindWorkspace(threadId, workspace.binding);
  return workspace;
}

function bindConversationWorkspaces(): void {
  for (const thread of conversations.chatMetadata()) {
    if (!thread.workspaceBinding) {
      try { workspaceForConversation(thread.id); }
      catch (error) { console.warn('[conversations] workspace could not be bound:', thread.id, error); }
    }
  }
}

ipcMain.handle('conversations:load', () => {
  bindConversationWorkspaces();
  return conversations.load();
});
ipcMain.handle('conversations:removeTranscript', (_event, threadId: string) => {
  if (activeThreads.runFor(threadId)) {
    throw new Error('Stop the active turn before deleting this conversation.');
  }
  transcriptCache.remove(threadId);
});
ipcMain.handle('conversations:save', (_event, next: Parameters<typeof conversations.save>[0]) => {
  const before = new Set(conversations.load().threads.map((thread) => thread.id));
  const saved = conversations.save(next);
  const live = new Set(saved.threads.map((thread) => thread.id));
  for (const id of before) {
    if (!live.has(id) && !activeThreads.runFor(id)) transcriptCache.remove(id);
  }
  bindConversationWorkspaces();
  return conversations.load();
});
ipcMain.handle('conversations:info', () => conversations.info());

// Typed host-side mutations (including a phone-owned turn) are reflected into the desktop
// renderer one conversation at a time. Renderer whole-file checkpoints remain a compatibility
// path, so do not echo their own replace notification back into a save loop.
conversations.subscribe((change) => {
  if (change.kind === 'replace' || change.kind === 'delete') {
    try { for (const threadId of chatNotes.pruneDeleted()) send(CHAT_NOTES_IPC.changed, { threadId, kind: 'deleted' }); }
    catch (error) { console.error('[chat-notes] could not remove deleted notes:', error); }
  }
  if (change.kind === 'replace' || change.kind === 'conflict' || change.kind === 'delete') {
    const checkpoint = conversations.snapshot();
    remoteLiveTranscript.retainThreads(new Set(checkpoint.threads.map((thread) => thread.id)));
    for (const thread of checkpoint.threads) remoteLiveTranscript.checkpoint(thread.id,
      thread.messages.map((message) => ({ id: message.id, content: message.content, finishedAt: message.meta.finishedAt })));
  }
  // Scope changes revoke links immediately, even if the chat later returns to its old folder.
  try { chatCoordination?.reconcile(); }
  catch (error) { console.error('[chat-coordination] could not reconcile connections:', error); }
  try { botChat?.reconcile(); }
  catch (error) { console.error('[bot-chat] could not reconcile participants:', error); }
  send('chat-coordination:changed', { threadIds: conversations.snapshot().threads.map((thread) => thread.id) });
  send('bot-chat:changed', { channelIds: [], threadIds: conversations.chatMetadata().map((thread) => thread.id), settingsChanged: false });
  if (change.kind !== 'replace') send('conversations:changed', { change, stored: conversations.load() });
  // The compatibility renderer checkpoints whole state. A paired client treats that as an
  // invalidation and fetches one authoritative snapshot, which also discovers desktop-started
  // turns without exposing the renderer's broad save operation as a remote API.
  if ((change.kind === 'replace' || change.kind === 'conflict' || change.kind === 'import' || change.kind === 'workspace') && remoteHost) {
    remoteHost.emitAll(remoteEvent('catalog.changed', { revision: String(change.revision) }));
  }
});

const remoteTurnSinks = new Map<string, RemoteTurnSink>();

const jsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function requireRemoteHost(): RemoteWorkspaceHost {
  if (!remoteHost) throw new Error('Remote connections are still starting.');
  return remoteHost;
}

function remoteProjectForThread(thread: Pick<conversations.ConversationThread, 'id' | 'directory'>): { id: string; name: string } | null {
  const host = requireRemoteHost();
  try {
    const workspace = workspaceForConversation(thread.id, false);
    const root = workspace ? conversationWorkspaceProjectRoot(workspace) : null;
    if (!root) return null;
    return host.projectForRoot(root);
  } catch {
    return null;
  }
}

function storedRemoteThread(projectId: string, threadId: string): conversations.ConversationThread {
  const thread = conversations.snapshot().threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new RemoteProtocolError('NOT_FOUND', 'Conversation not found.', 404);
  if (remoteProjectForThread(thread)?.id !== projectId) {
    throw new RemoteProtocolError('PROJECT_MISMATCH', 'Conversation belongs to another project.', 403);
  }
  return thread;
}

const remoteTurnStartDependencies: RemoteTurnStartDependencies = {
  activeTurns: activeThreads,
  resolveProject: (projectId) => requireRemoteHost().resolveProject(projectId),
  loadThread: storedRemoteThread,
  resolveModel: (providerId, modelId) => {
    const source = sourceStore.listPublic().find((candidate) => candidate.id === providerId);
    return source?.models.some((model) => model.id === modelId) ? { name: source.name } : null;
  },
};

function remoteModelCatalog(): JsonValue[] {
  const preferred = modelChoice.read();
  const catalog = sourceStore.listPublic().flatMap((source) => source.models.map((model) => ({
    providerId: source.id,
    modelId: model.id,
    name: model.name,
    providerName: source.name,
    ...(model.architecture ? { architecture: model.architecture } : {}),
    ...(model.quantization ? { quantization: model.quantization } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.vision !== undefined ? { supportsVision: model.vision } : {}),
    localToHost: ['beholdd', 'llama-cpp', 'ollama'].includes(source.kind),
  })));
  // Android starts a new remote conversation on the first catalog entry. Put the host's durable
  // picker choice first so desktop and phone agree without inventing a second "default" setting.
  if (preferred) {
    catalog.sort((left, right) =>
      Number(right.providerId === preferred.providerId && right.modelId === preferred.modelId) -
      Number(left.providerId === preferred.providerId && left.modelId === preferred.modelId)
    );
  }
  return catalog.map((entry) => jsonValue(entry));
}

function remoteThreadSummary(thread: conversations.ConversationThread, projectId: string): JsonValue {
  const active = activeThreads.list().find((turn) => turn.threadId === thread.id);
  return jsonValue({
    id: thread.id,
    projectId,
    title: thread.title,
    pinned: thread.pinnedAt !== undefined,
    archived: false,
    updatedAt: thread.updatedAt,
    revision: String(thread.revision),
    ...(thread.providerId && thread.modelId
      ? {
          providerId: thread.providerId,
          modelId: thread.modelId,
          model: { providerId: thread.providerId, modelId: thread.modelId },
        }
      : {}),
    ...(active ? { activeRequestId: active.runId } : {}),
  });
}

function remoteToolSnapshot(tool: conversations.RemoteToolProjection): JsonValue {
  const description = describeRemoteTool(tool.toolName);
  return jsonValue({
    callId: tool.callId,
    ...(tool.activityId ? { activityId: tool.activityId } : {}),
    ...(tool.approvalId ? { approvalId: tool.approvalId } : {}),
    requestId: tool.requestId,
    ...(tool.contentOffset !== undefined ? { contentOffset: tool.contentOffset } : {}),
    serverName: tool.serverName,
    toolName: tool.toolName,
    tier: tool.tier,
    summary: tool.summary ?? description.summary,
    argumentsPreview: tool.argumentsPreview ?? description.argumentsPreview,
    status: tool.status,
    awaitingApproval: tool.awaitingApproval,
    ...(tool.approvalReason ? { approvalReason: tool.approvalReason } : {}),
    ...(tool.approvalDetails ? { approvalDetails: tool.approvalDetails } : {}),
    ...(tool.preview ? {
      preview: {
        kind: 'asset',
        previewKind: 'image',
        id: tool.preview.assetId,
        assetId: tool.preview.assetId,
        title: tool.preview.title,
      },
    } : {}),
  });
}

function remoteThreadSnapshot(threadId: string, projectId?: string): JsonValue | null {
  flushSnapshotDeltas(remoteTurnSinks.values(), flushRemoteDelta, threadId);
  const stored = conversations.snapshot().threads.find((thread) => thread.id === threadId);
  if (!stored) return null;
  const project = remoteProjectForThread(stored);
  if (!project || (projectId && project.id !== projectId)) return null;
  const projected = remoteLiveTranscript.project(conversations.remoteProjection(threadId).threads[0]);
  return jsonValue({
    id: projected.id,
    title: projected.title,
    projectId: project.id,
    projectName: project.name,
    pinned: projected.pinnedAt !== undefined,
    archived: false,
    updatedAt: projected.updatedAt,
    revision: String(projected.revision),
    accessMode: projected.accessMode,
    ...(projected.providerId ? { providerId: projected.providerId } : {}),
    ...(projected.modelId ? { modelId: projected.modelId } : {}),
    ...(projected.providerId && projected.modelId
      ? { model: { providerId: projected.providerId, modelId: projected.modelId } }
      : {}),
    messages: projected.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.modelId && projected.providerId
        ? { model: { providerId: projected.providerId, modelId: message.modelId } }
        : {}),
      ...(message.sourceName ? { sourceName: message.sourceName } : {}),
      failed: message.failed,
      attachments: message.attachments,
      tools: message.tools.map(remoteToolSnapshot),
    })),
  });
}

function remoteBootstrap(context: RemoteBootstrapContext): JsonValue {
  const host = requireRemoteHost();
  bindConversationWorkspaces();
  flushSnapshotDeltas(remoteTurnSinks.values(), flushRemoteDelta);
  const snapshot = conversations.snapshot();
  const summaries = snapshot.threads.flatMap((thread) => {
    const project = remoteProjectForThread(thread);
    return project ? [remoteThreadSummary(thread, project.id)] : [];
  });
  const selectedId = context.selectedThreadId ?? snapshot.activeThreadId;
  const selectedThread = selectedId ? remoteThreadSnapshot(selectedId) : null;
  const active = activeThreads.list().flatMap((turn) => {
    const thread = snapshot.threads.find((candidate) => candidate.id === turn.threadId);
    const project = thread ? remoteProjectForThread(thread) : null;
    if (!thread || !project) return [];
    const sink = remoteTurnSinks.get(turn.runId);
    return [jsonValue({
      threadId: turn.threadId,
      requestId: turn.runId,
      responseMessageId: turn.responseMessageId ?? turn.runId,
      projectId: project.id,
      startedAt: turn.startedAt,
      waiting: sink?.waiting ?? false,
      cancellationRequested: sink?.cancellationRequested ?? false,
      ...(remoteInference.get(turn.runId) ? { inference: remoteInference.get(turn.runId) } : {}),
    })];
  });
  const capabilities = context.device.capabilities;
  return jsonValue({
    protocolVersion: 1,
    hostVersion: host.appRelease(),
    host: { ...context.workspace },
    workspace: { ...context.workspace },
    capabilities,
    revision: String(snapshot.revision),
    projects: context.projects.map((project, index) => ({
      ...project,
      revision: '1',
      capabilities,
      isDefault: index === 0,
    })),
    models: remoteModelCatalog(),
    conversations: summaries,
    ...(selectedThread ? { selectedThread } : {}),
    activeTurns: active,
    cursor: context.cursor,
  });
}

function remoteEvent(
  kind: string,
  payload: unknown,
  context: { projectId?: string; threadId?: string } = {}
): JsonValue {
  const workspaceId = requireRemoteHost().workspace().id;
  return jsonValue({
    protocolVersion: 1,
    hostId: workspaceId,
    ...context,
    kind,
    payload,
  });
}

function emitRemoteTurn(sink: RemoteTurnSink, kind: string, payload: unknown): void {
  requireRemoteHost().emitAll(
    remoteEvent(kind, payload, { projectId: sink.projectId, threadId: sink.threadId })
  );
}

function flushRemoteDelta(sink: RemoteTurnSink): void {
  if (sink.flushTimer) clearTimeout(sink.flushTimer);
  sink.flushTimer = null;
  if (!sink.pendingDelta || sink.persistenceError) return;
  const delta = sink.pendingDelta;
  try {
    const updated = conversations.appendAssistantDelta(
      sink.threadId,
      sink.responseMessageId,
      delta,
      Date.now(),
      sink.revision
    );
    sink.revision = updated.revision;
    sink.pendingDelta = '';
  } catch (error) {
    sink.persistenceError = error as Error;
    cancelTurn(sink.requestId);
  }
}

function queueRemoteDelta(sink: RemoteTurnSink, content: string): void {
  if (sink.persistenceError) return;
  sink.pendingDelta += content;
  if (sink.pendingDelta.length >= 4_096) {
    flushRemoteDelta(sink);
  } else if (!sink.flushTimer) {
    sink.flushTimer = setTimeout(() => flushRemoteDelta(sink), 50);
    sink.flushTimer.unref?.();
  }
}

function toolActivityForStore(payload: Record<string, unknown>, sink: Pick<RemoteTurnSink, 'requestId'>): conversations.ConversationToolActivity {
  const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
  const args = typeof payload.args === 'string' ? payload.args : undefined;
  const description = describeRemoteTool(toolName, args);
  return {
    callId: String(payload.callId),
    ...(typeof payload.activityId === 'string' ? { activityId: payload.activityId } : {}),
    ...(typeof payload.approvalId === 'string' ? { approvalId: payload.approvalId } : {}),
    requestId: sink.requestId,
    ...(typeof payload.contentOffset === 'number' ? { contentOffset: payload.contentOffset } : {}),
    ...(typeof payload.serverId === 'string' ? { serverId: payload.serverId } : {}),
    serverName: typeof payload.serverName === 'string' ? payload.serverName : 'Workspace',
    toolName,
    tier: payload.tier === 'write' || payload.tier === 'danger' ? payload.tier : 'read',
    ...(args !== undefined ? { args } : {}),
    ...(typeof payload.result === 'string' ? { result: payload.result } : {}),
    remoteSummary: description.summary,
    remoteArgumentsPreview: description.argumentsPreview,
    remoteApprovalDetails: description.approvalDetails,
    status: ['pending', 'running', 'done', 'failed', 'denied'].includes(String(payload.status))
      ? payload.status as conversations.ConversationToolStatus
      : 'pending',
    ...(typeof payload.awaitingApproval === 'boolean' ? { awaitingApproval: payload.awaitingApproval } : {}),
    ...(typeof payload.caution === 'string' ? { caution: payload.caution } : {}),
    ...(payload.subagent && typeof payload.subagent === 'object'
      ? { subagent: payload.subagent as conversations.ConversationToolActivity['subagent'] }
      : {}),
    ...(payload.preview && typeof payload.preview === 'object'
      ? { preview: payload.preview as conversations.ConversationToolActivity['preview'] }
      : {}),
  };
}

function remoteToolEvent(activity: conversations.ConversationToolActivity): JsonValue {
  const description = describeRemoteTool(activity.toolName, activity.args);
  return jsonValue({
    callId: activity.callId,
    ...(activity.activityId ? { activityId: activity.activityId } : {}),
    ...(activity.approvalId ? { approvalId: activity.approvalId } : {}),
    requestId: activity.requestId,
    ...(activity.contentOffset !== undefined ? { contentOffset: activity.contentOffset } : {}),
    serverName: activity.serverName,
    toolName: activity.toolName,
    tier: activity.tier,
    summary: activity.remoteSummary ?? description.summary,
    argumentsPreview: activity.remoteArgumentsPreview ?? description.argumentsPreview,
    status: activity.status,
    awaitingApproval: activity.awaitingApproval === true,
    ...(activity.awaitingApproval ? { approvalReason: `${activity.tier} access requires approval.` } : {}),
    ...((activity.remoteApprovalDetails ?? description.approvalDetails)
      ? { approvalDetails: activity.remoteApprovalDetails ?? description.approvalDetails }
      : {}),
    ...(activity.result !== undefined ? { resultPreview: activity.status === 'done' ? 'Completed' : activity.status } : {}),
  });
}

const desktopStreamEvents: DesktopStreamEventDependencies = {
  live: remoteLiveTranscript,
  hasConsumers: () => remoteHost?.hasEventConsumers() ?? false,
  activeTurn: (runId) => activeThreads.recordForRun(runId),
  projectForThread: remoteProjectForThread,
  toolActivity: (data, runId) => toolActivityForStore(data, { requestId: runId }),
  toolEvent: remoteToolEvent,
  emit: (kind, body, scope) => remoteHost?.emitAll(remoteEvent(kind, body, scope)),
};

appEvents.subscribe(({ channel, payload }) => {
  if (!payload || typeof payload !== 'object') return;
  const data = payload as Record<string, unknown>;
  const runId = typeof data.id === 'string'
    ? data.id
    : typeof data.requestId === 'string'
      ? data.requestId
      : typeof data.runId === 'string'
        ? data.runId
        : null;
  if (!runId) return;
  const sink = remoteTurnSinks.get(runId);
  if (!sink) {
    relayDesktopStreamEvent(channel, data, runId, desktopStreamEvents);
    return;
  }

  if (channel === 'chat:stream-data' && typeof data.content === 'string') {
    queueRemoteDelta(sink, data.content);
    emitRemoteTurn(sink, 'text.delta', {
      requestId: sink.requestId,
      responseMessageId: sink.responseMessageId,
      content: data.content,
    });
    return;
  }
  if (channel === 'chat:alive') {
    emitRemoteTurn(sink, 'turn.liveness', { requestId: sink.requestId, waiting: sink.waiting });
    return;
  }
  if (channel === 'chat:waiting' && typeof data.waiting === 'boolean') {
    sink.waiting = data.waiting;
    emitRemoteTurn(sink, 'turn.liveness', { requestId: sink.requestId, waiting: sink.waiting });
    return;
  }
  if (channel === 'chat:context') {
    emitRemoteTurn(sink, 'context.updated', {
      requestId: sink.requestId,
      ...(typeof data.estimatedTokens === 'number' ? { inputTokens: data.estimatedTokens } : {}),
      ...(typeof data.contextTokens === 'number' ? { contextLimit: data.contextTokens } : {}),
    });
    return;
  }
  if (channel === 'chat:metrics') {
    const inference = projectInferenceProgress(data);
    if (inference) emitRemoteTurn(sink, 'context.updated', { requestId: sink.requestId, inference });
    return;
  }
  if (channel === 'tools:activity' || channel === 'tools:approval-request') {
    flushRemoteDelta(sink);
    if (sink.persistenceError) return;
    try {
      const activity = toolActivityForStore(data, sink);
      const updated = conversations.upsertToolActivity(
        sink.threadId,
        sink.responseMessageId,
        activity,
        Date.now(),
        sink.revision
      );
      sink.revision = updated.revision;
      emitRemoteTurn(
        sink,
        channel === 'tools:approval-request' ? 'approval.requested' : 'tool.changed',
        { activity: remoteToolEvent(activity) }
      );
    } catch (error) {
      sink.persistenceError = error as Error;
      cancelTurn(sink.requestId);
    }
  }
});

function validateRemoteCommand(device: PublicDeviceRecord, command: RemoteCommand): void {
  const host = requireRemoteHost();
  if (!host.resolveProject(command.projectId)) {
    throw new RemoteProtocolError('PROJECT_MISMATCH', 'Project is no longer available.', 403);
  }
  if (command.kind === 'thread.create') {
    if (command.payload.model) {
      const source = sourceStore.listPublic().find((candidate) => candidate.id === command.payload.model?.providerId);
      if (!source?.models.some((model) => model.id === command.payload.model?.modelId)) {
        throw new RemoteProtocolError('MODEL_UNAVAILABLE', 'The selected model is not available on this host.', 409, true);
      }
    }
    return;
  }

  if (command.kind === 'turn.cancel' || command.kind === 'turn.steer' || command.kind === 'approval.resolve') {
    if (!activeRemoteControl(device, command)) {
      throw new RemoteProtocolError('TURN_NOT_FOUND', 'That turn is no longer running in this project.', 404);
    }
    if (command.kind === 'turn.steer' && !steering.has(command.payload.requestId)) {
      throw new RemoteProtocolError('TURN_NOT_STEERABLE', 'That turn cannot accept a steering note.', 409, true);
    }
    if (
      command.kind === 'approval.resolve' &&
      pendingApprovals.get(command.payload.approvalId)?.runId !== command.payload.requestId
    ) {
      throw new RemoteProtocolError('APPROVAL_NOT_FOUND', 'That approval is no longer pending.', 404);
    }
    return;
  }

  if (command.kind === 'turn.start') {
    inspectRemoteTurnStart(command, remoteTurnStartDependencies);
    return;
  }

  const thread = storedRemoteThread(command.projectId, command.payload.threadId);
  expectedRemoteThreadRevision(command, thread.revision);
  if (command.kind === 'thread.delete' && activeThreads.runFor(thread.id)) {
    throw new RemoteProtocolError('TURN_ACTIVE', 'Stop the active turn before deleting this conversation.', 409, true);
  }
  if (command.kind === 'thread.set_model') {
    if (activeThreads.runFor(thread.id)) {
      throw new RemoteProtocolError('TURN_ACTIVE', 'Stop the active turn before changing models.', 409, true);
    }
    const source = sourceStore.listPublic().find((candidate) => candidate.id === command.payload.model.providerId);
    if (!source?.models.some((model) => model.id === command.payload.model.modelId)) {
      throw new RemoteProtocolError('MODEL_UNAVAILABLE', 'The selected model is not available on this host.', 409, true);
    }
  }
}

function emitThreadChanged(thread: conversations.ConversationThread, projectId: string): void {
  requireRemoteHost().emitAll(
    remoteEvent('thread.changed', remoteThreadSummary(thread, projectId), { projectId, threadId: thread.id })
  );
}

const remoteTurnDependencies: RemoteTurnDependencies = {
  activeTurns: activeThreads,
  desktopTurns: remoteDesktopTurns,
  sinks: remoteTurnSinks,
  stream: (request, reservation) => streamChat(request, {
    owner: reservation.active.owner,
    projectId: reservation.active.projectId,
    workspace: reservation.project.root,
    workspaceConfirmed: true,
    reservedTurn: reservation.active,
  }),
  flush: flushRemoteDelta,
  emit: emitRemoteTurn,
  threadChanged: emitThreadChanged,
};

function runRemoteTurn(
  device: PublicDeviceRecord,
  command: Extract<RemoteCommand, { kind: 'turn.start' }>,
  reservation: RemoteTurnStartReservation,
  effect: conversations.RemoteConversationEffect,
  initialized: { resolve(): void; reject(error: unknown): void }
): Promise<void> {
  return executeRemoteTurn(device, command, reservation, effect, initialized, remoteTurnDependencies);
}

const REMOTE_CONVERSATION_EFFECTS = new Set<RemoteCommand['kind']>([
  'thread.create',
  'thread.rename',
  'thread.set_pinned',
  'thread.set_model',
  'thread.delete',
  'turn.start',
]);

function reconcileRemoteTurnEffect(command: Extract<RemoteCommand, { kind: 'turn.start' }>): void {
  const thread = conversations.snapshot().threads.find((candidate) => candidate.id === command.payload.threadId);
  if (!thread) return;
  const response = thread.messages.find((message) => message.id === command.payload.responseMessageId);
  if (!response || response.role !== 'assistant' || response.meta.finishedAt !== undefined) return;
  const failed = conversations.failAssistantMessage(thread.id, response.id, {
    finishedAt: Date.now(),
    userMessage: 'The host restarted before this turn finished. Retry from the current conversation.',
  }, thread.revision);
  emitThreadChanged(failed, command.projectId);
}

function activeRemoteControl(
  device: PublicDeviceRecord,
  command: Extract<RemoteCommand, { kind: 'turn.cancel' | 'turn.steer' | 'approval.resolve' }>
): ActiveTurnRecord | null {
  return inspectRemoteTurnControl(device, command, {
    activeTurn: (requestId) => activeThreads.recordForRun(requestId),
    projectForThread: (threadId) => {
      const thread = conversations.chatMetadata().find((candidate) => candidate.id === threadId);
      return thread ? remoteProjectForThread(thread)?.id ?? null : null;
    },
  });
}

async function dispatchRemoteCommand(
  device: PublicDeviceRecord,
  command: RemoteCommand,
  receipt: RemoteCommandReceipt,
  context: RemoteDispatchContext
): Promise<RemoteDispatchResult> {
  const appliedEffect = REMOTE_CONVERSATION_EFFECTS.has(command.kind)
    ? conversations.remoteEffect(context.effect)
    : null;
  if (appliedEffect) {
    if (command.kind === 'thread.create') {
      const stableResult = appliedEffect.result ?? (
        receipt.result && conversations.snapshot().threads.some((thread) => thread.id === receipt.result?.threadId)
          ? receipt.result
          : undefined
      );
      if (!stableResult || stableResult.clientThreadId !== command.payload.clientThreadId) {
        throw new RemoteProtocolError(
          'CREATE_OUTCOME_UNKNOWN',
          'The conversation was created, but its stable host identity could not be recovered. Refresh this workspace.',
          409,
          true
        );
      }
      return { state: 'applied', result: stableResult };
    }
    if (command.kind === 'turn.start' && !activeThreads.recordForRun(command.payload.requestId)) {
      reconcileRemoteTurnEffect(command);
    }
    if (command.kind === 'thread.delete') transcriptCache.remove(command.payload.threadId);
    return 'applied';
  }
  // Initial acceptance already validated mutable state. A recovered command must re-establish
  // that authority after restart, except when its atomic marker proved the effect already landed.
  if (context.recovery && REMOTE_CONVERSATION_EFFECTS.has(command.kind)) {
    validateRemoteCommand(device, command);
  }

  switch (command.kind) {
    case 'thread.create': {
      const creationResult = receipt.result;
      if (!creationResult) throw new Error('Thread creation receipt has no host thread id.');
      const threadId = creationResult.threadId;
      const project = requireRemoteHost().resolveProject(command.projectId);
      if (!project) throw new Error('Remote project disappeared during thread creation.');
      const created = conversations.createThread({
        id: threadId,
        title: command.payload.title,
        projectId: 'inbox',
        createdAt: Date.now(),
        providerId: command.payload.model?.providerId,
        modelId: command.payload.model?.modelId,
        directory: project.root,
        accessMode: 'ask',
      }, conversations.snapshot().revision, {
        ...context.effect,
        result: { ...creationResult },
      });
      const bound = conversations.bindWorkspace(created.id, { path: project.root, confirmed: true }, created.revision);
      emitThreadChanged(bound, command.projectId);
      return { state: 'applied', result: { ...creationResult } };
    }
    case 'thread.rename': {
      const current = storedRemoteThread(command.projectId, command.payload.threadId);
      const updated = conversations.renameThread(
        current.id,
        command.payload.title,
        expectedRemoteThreadRevision(command, current.revision),
        context.effect
      );
      emitThreadChanged(updated, command.projectId);
      return 'applied';
    }
    case 'thread.set_pinned': {
      const current = storedRemoteThread(command.projectId, command.payload.threadId);
      const updated = conversations.setThreadPinned(
        current.id,
        command.payload.pinned ? Date.now() : null,
        expectedRemoteThreadRevision(command, current.revision),
        context.effect
      );
      emitThreadChanged(updated, command.projectId);
      return 'applied';
    }
    case 'thread.set_model': {
      const current = storedRemoteThread(command.projectId, command.payload.threadId);
      const updated = conversations.setThreadModel(
        current.id,
        command.payload.model.providerId,
        command.payload.model.modelId,
        expectedRemoteThreadRevision(command, current.revision),
        context.effect
      );
      emitThreadChanged(updated, command.projectId);
      return 'applied';
    }
    case 'thread.delete': {
      const current = storedRemoteThread(command.projectId, command.payload.threadId);
      conversations.deleteThread(
        current.id,
        expectedRemoteThreadRevision(command, current.revision),
        context.effect
      );
      transcriptCache.remove(current.id);
      requireRemoteHost().emitAll(remoteEvent('thread.deleted', {
        threadId: current.id,
        revision: String(conversations.snapshot().revision),
      }, { projectId: command.projectId, threadId: current.id }));
      return 'applied';
    }
    case 'turn.start': {
      // Validation ran before the durable receipt, but another HTTP request may have passed the
      // same check at that async boundary. Re-read mutable state and acquire both thread/request
      // ownership before runRemoteTurn is allowed to append either message.
      const reservation = reserveRemoteTurnStart(device, command, remoteTurnStartDependencies);
      let resolveInitialized!: () => void;
      let rejectInitialized!: (error: unknown) => void;
      const initialized = new Promise<void>((resolve, reject) => {
        resolveInitialized = resolve;
        rejectInitialized = reject;
      });
      void runRemoteTurn(device, command, reservation, context.effect, {
        resolve: resolveInitialized,
        reject: rejectInitialized,
      }).catch((error) => {
        console.error('[remote] turn could not be initialized:', error);
        remoteHost?.emitAll(remoteEvent('turn.failed', {
          requestId: command.payload.requestId,
          responseMessageId: command.payload.responseMessageId,
          code: 'internal',
          userMessage: 'The host could not start this turn. Refresh the conversation and try again.',
          retryable: true,
        }, { projectId: command.projectId, threadId: command.payload.threadId }));
      });
      await initialized;
      return 'applied';
    }
    case 'turn.cancel': {
      if (!activeRemoteControl(device, command)) return 'already_finished';
      const sink = remoteTurnSinks.get(command.payload.requestId);
      if (sink) sink.cancellationRequested = true;
      cancelTurn(command.payload.requestId);
      return 'applied';
    }
    case 'turn.steer': {
      const active = activeRemoteControl(device, command);
      if (!active || !steering.has(command.payload.requestId)) {
        return 'already_finished';
      }
      if (!steerTurn(command.payload.requestId, command.payload.note, command.payload.now)) {
        return 'already_finished';
      }
      requireRemoteHost().emitDevice(device.id, remoteEvent('steer.acknowledged', {
        requestId: command.payload.requestId,
        commandId: command.commandId,
      }, { projectId: command.projectId, threadId: active.threadId }));
      return 'applied';
    }
    case 'approval.resolve': {
      const active = activeRemoteControl(device, command);
      if (
        !active ||
        pendingApprovals.get(command.payload.approvalId)?.runId !== command.payload.requestId
      ) return 'already_finished';
      if (!resolveToolApproval(command.payload.approvalId, command.payload.approved)) {
        return 'already_finished';
      }
      requireRemoteHost().emitDevice(device.id, remoteEvent('approval.resolved', {
        requestId: command.payload.requestId,
        approvalId: command.payload.approvalId,
        resolution: command.payload.approved ? 'approved' : 'declined',
      }, { projectId: command.projectId, threadId: active.threadId }));
      return 'applied';
    }
  }
}

function disconnectRemoteDevice(deviceId: string): void {
  for (const active of activeThreads.list()) {
    if (active.owner.kind !== 'remote' || active.owner.deviceId !== deviceId) continue;
    const sink = remoteTurnSinks.get(active.runId);
    if (sink) sink.cancellationRequested = true;
    // Resolve prompts before aborting so a tool loop cannot remain blocked on a device that no
    // longer has authority to answer. The stream abort remains the final stop signal.
    settleApprovalsForRun(active.runId);
    settleQuestionsForRun(active.runId);
    cancelTurn(active.runId);
  }
}

function updateRemotePowerPolicy(state: { running: boolean; keepAwake: boolean }): void {
  if (state.running && state.keepAwake) {
    if (remotePowerBlocker === null || !powerSaveBlocker.isStarted(remotePowerBlocker)) {
      remotePowerBlocker = powerSaveBlocker.start('prevent-app-suspension');
    }
  } else if (remotePowerBlocker !== null) {
    if (powerSaveBlocker.isStarted(remotePowerBlocker)) powerSaveBlocker.stop(remotePowerBlocker);
    remotePowerBlocker = null;
  }
}

function requireNodePeers(): NodePeerStore {
  if (!nodePeers) throw new Error('Inference nodes are still starting.');
  return nodePeers;
}

function requireNodeAgent(): NodeAgent {
  if (!nodeAgent) throw new Error('The node agent is still starting.');
  return nodeAgent;
}

/**
 * The two halves of ADR 0001 stage 5, both off until someone turns them on.
 *
 * The agent answers questions about this box; the peer store holds the boxes this one has been
 * paired with. They share a directory and a keyring protector but not a file, so revoking a
 * controller here cannot disturb a pairing made in the other direction.
 */
function createNodeAgent(): { agent: NodeAgent; peers: NodePeerStore } {
  const protector = createRemoteSafeStorageProtector(safeStorage);
  const controls = {
    vitals: async () => clusterVitals(await sampler.sample()),
    engines: () => inferenceServers.list(),
    action: (input: ClusterEngineAction) => {
      assertNotCommittingAutomaticRestart();
      return input.action === 'start' ? inferenceServers.start(input.serverId)
        : inferenceServers[input.action](input.serverId, input.force);
    },
  };
  const agent = new NodeAgent({
    userData: app.getPath('userData'),
    appVersion: app.getVersion(),
    protector,
    cluster: controls,
    readings: {
      // The same driver readings the Vitals panel shows, per device, with an absent figure left
      // absent rather than counted as zero free.
      accelerators: async () => (await vitalsSources.gpus()).map((gpu) => ({
        name: gpu.name,
        memoryFree: gpu.memoryTotal === null || gpu.memoryUsed === null ? null : Math.max(0, gpu.memoryTotal - gpu.memoryUsed),
        memoryTotal: gpu.memoryTotal,
      })),
      // Only checkpoints the download queue has verified on disk. A partial transfer is not an
      // inventory item: a controller placing work by it would be placing it on half a model.
      checkpoints: async () => workloadDeployments.list()
        .filter((workload) => workload.download?.state === 'ready')
        .map((workload) => ({ id: workload.id, name: workload.name, bytes: workload.bytes })),
    },
    onState: (status) => {
      try {
        send('node-agent:state', status);
      } catch (error) {
        console.warn('[node-agent] could not publish state:', error);
      }
    },
  });
  const peers = new NodePeerStore({ path: join(app.getPath('userData'), 'node-agent', 'peers.json'), protector });
  clusterService = new ClusterService({ peers, local: { ...controls, report: () => agent.localReport() } });
  return { agent, peers };
}
ipcMain.handle(CLUSTER_IPC.snapshot, (event) => {
  requireTrustedMain(event);
  if (!clusterService) throw new Error('Cluster services are starting.');
  return clusterService.snapshot();
});
ipcMain.handle(CLUSTER_IPC.action, (event, node: string, input: ClusterEngineAction) => {
  requireTrustedMain(event);
  assertNotCommittingAutomaticRestart();
  if (!clusterService) throw new Error('Cluster services are starting.');
  return clusterService.action(node, input);
});

const nodeOfferId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value)) throw new Error('Invalid pairing offer identifier.');
  return value;
};

ipcMain.handle(NODE_AGENT_IPC.status, (event) => { requireMainFrame(event); return requireNodeAgent().status(); });
ipcMain.handle(NODE_AGENT_IPC.configure, (event, patch: unknown) => {
  requireMainFrame(event);
  const input = (patch ?? {}) as Record<string, unknown>;
  return requireNodeAgent().configure({
    ...(input.enabled === undefined ? {} : { enabled: !!input.enabled }),
    ...(input.address === undefined ? {} : { address: input.address === null ? null : String(input.address) }),
    ...(input.port === undefined ? {} : { port: Number(input.port) }),
  });
});
ipcMain.handle(NODE_AGENT_IPC.createPairingOffer, (event, scopes?: import('../api/nodeAgent').NodeScope[]) => { requireTrustedMain(event); return requireNodeAgent().createPairingOffer(scopes); });
ipcMain.handle(NODE_AGENT_IPC.copyPairingCode, (event, offerId: unknown) => {
  requireMainFrame(event);
  const code = requireNodeAgent().pairingCode(nodeOfferId(offerId));
  if (!code) return false;
  // The code holds a one-time bearer. It reaches the clipboard only on an explicit copy, and
  // never the renderer.
  clipboard.writeText(code);
  return true;
});
ipcMain.handle(NODE_AGENT_IPC.cancelPairingOffer, (event, offerId: unknown) => {
  requireMainFrame(event);
  return requireNodeAgent().cancelPairingOffer(nodeOfferId(offerId));
});
ipcMain.handle(NODE_AGENT_IPC.revokeController, (event, controllerId: unknown) => {
  requireMainFrame(event);
  return requireNodeAgent().revokeController(String(controllerId ?? ''));
});
ipcMain.handle(NODE_AGENT_IPC.listPaired, (event) => { requireMainFrame(event); return requireNodePeers().list(); });
ipcMain.handle(NODE_AGENT_IPC.pair, async (event, code: unknown) => {
  requireMainFrame(event);
  // Parsing happens here and not in the renderer: the code carries a bearer, and a window that
  // has never held one cannot leak it.
  const parsedCode = parseNodePairingCode(code);
  if (parsedCode.expiresAt <= Date.now()) throw new Error('That pairing code has expired. Create a new one on the other box.');
  const pairing = await pairWithNode(parsedCode, hostname(), app.getVersion());
  return requireNodePeers().remember({
    endpoint: parsedCode.endpoint,
    certificatePin: parsedCode.certificatePin,
    nodeId: pairing.nodeId,
    name: pairing.name,
    credential: pairing.credential,
    scopes: pairing.scopes,
  });
});
ipcMain.handle(NODE_AGENT_IPC.forget, (event, key: unknown) => { requireMainFrame(event); return requireNodePeers().forget(key); });

function createRemoteWorkspaceHost(): RemoteWorkspaceHost {
  return new RemoteWorkspaceHost({
    userData: app.getPath('userData'),
    appVersion: app.getVersion(),
    protector: createRemoteSafeStorageProtector(safeStorage),
    callbacks: {
      currentProject: () => mcpStore.workspaceConfirmed()
        ? { root: mcpStore.workspace(), name: inferRemoteProjectName(mcpStore.workspace()) }
        : null,
      knownProjects: () => {
        bindConversationWorkspaces();
        return conversations.chatMetadata().flatMap((thread) => {
          try {
            const workspace = workspaceForConversation(thread.id, false);
            const root = workspace ? conversationWorkspaceProjectRoot(workspace) : null;
            return root ? [{ root, name: inferRemoteProjectName(root) }] : [];
          } catch { return []; }
        });
      },
      bootstrap: remoteBootstrap,
      thread: (_device, threadId) => remoteThreadSnapshot(threadId),
      validateCommand: validateRemoteCommand,
      dispatch: dispatchRemoteCommand,
      onDeviceDisconnected: (deviceId) => disconnectRemoteDevice(deviceId),
      onPairingInvalidated: (pairingCode, offerId) => {
        // The renderer gets only the public identifier so it can discard stale QR pixels. The
        // bearer remains confined to main and an exact-match clipboard cleanup.
        try {
          send('remote:pairing-invalidated', { offerId });
        } catch (error) {
          console.warn('[remote] could not dismiss invalidated pairing UI:', error);
        }
        // Do not erase something the user copied after the pairing attempt began.
        void clipboard.readText()
          .then((current) => {
            if (current === pairingCode) clipboard.clear();
          })
          .catch((error) => console.warn('[remote] could not clear the consumed pairing code:', error));
      },
      onDispatchError: (device, command, error) => {
        console.error(`[remote] accepted command ${command.commandId} could not be dispatched:`, error);
        remoteHost?.emitDevice(device.id, remoteEvent('command.failed', {
          commandId: command.commandId,
          requestId: 'requestId' in command.payload ? command.payload.requestId : null,
          code: 'dispatch_failed',
          userMessage: 'The host could not apply that command. Refresh the workspace and try again.',
        }, { projectId: command.projectId }));
      },
      onState: (state) => {
        updateRemotePowerPolicy(state);
        send('remote:changed', state);
      },
    },
  });
}

registerRemoteIpcHandlers(ipcMain, {
  host: requireRemoteHost,
  isAllowedSender: (event) => Boolean(
    mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
  ),
  writeClipboard: (value) => clipboard.writeText(value),
});

// Snitch IPC handlers. Every mutating call answers with the whole project, because these are
// small files and a partial update that disagrees with disk is worse than a slightly larger reply.
ipcMain.handle('snitch:config', () => snitch.config());
ipcMain.handle('snitch:setRoot', (_event, root: string | null) => snitch.setRoot(root));
ipcMain.handle('snitch:projects', () => snitch.listProjects());
ipcMain.handle('snitch:project', (_event, name: string) => snitch.loadProject(name));
ipcMain.handle('snitch:createProject', (_event, name: string, repo?: string | null) =>
  snitch.createProject(name, repo ?? null)
);
ipcMain.handle('snitch:deleteProject', (_event, name: string) => {
  const project = snitch.loadProject(name);
  const liveWorker = orchestrator.snapshot().running.some((entry) => ownsSnitchTarget(entry.issueId, name));
  if (liveWorker || project.items.some((item) => isActiveStage(item.pipeline.stage))) {
    throw new Error('Cancel active fix and QA runs and wait for them to stop before deleting this project.');
  }
  snitch.deleteProject(name);
  for (const item of project.items) transcriptCache.remove(item.id);
  transcriptCache.removePrefix(`snitch:${name}/`);
  return snitch.listProjects();
});
ipcMain.handle('snitch:updateProject', (_event, name: string, patch: snitch.ProjectPatch) =>
  snitch.updateProject(name, patch)
);

ipcMain.handle('snitch:addItem', (_event, name: string, kind: ItemKind, draft: ItemDraft) =>
  snitch.addItem(name, kind, draft)
);
ipcMain.handle('snitch:updateItem', (_event, name: string, item: SnitchItem) => snitch.updateItem(name, item));
ipcMain.handle('snitch:deleteItems', (_event, name: string, itemIds: string[]) => {
  const wanted = new Set(itemIds);
  const doomed = snitch.loadProject(name).items.filter((item) => wanted.has(item.id));
  const liveWorker = orchestrator.snapshot().running.some((entry) => ownsSnitchTarget(entry.issueId, name, wanted));
  if (liveWorker || doomed.some((item) => isActiveStage(item.pipeline.stage))) {
    throw new Error('Cancel the active fix or QA run and wait for it to stop before deleting its item.');
  }
  const saved = snitch.deleteItems(name, itemIds);
  for (const item of doomed) {
    transcriptCache.remove(item.id);
    transcriptCache.removePrefix(`snitch:${name}/${item.id}#`);
  }
  return saved;
});
ipcMain.handle('snitch:setStatus', (_event, name: string, itemIds: string[], status: ItemStatus) =>
  snitch.setStatus(name, itemIds, status)
);
ipcMain.handle('snitch:setRelease', (_event, name: string, itemIds: string[], releaseId: string | null) =>
  snitch.setRelease(name, itemIds, releaseId)
);

ipcMain.handle('snitch:addRelease', (_event, name: string, releaseName: string) =>
  snitch.addRelease(name, releaseName)
);
ipcMain.handle('snitch:updateRelease', (_event, name: string, release: SnitchRelease) =>
  snitch.updateRelease(name, release)
);
ipcMain.handle('snitch:deleteRelease', (_event, name: string, releaseId: string) =>
  snitch.deleteRelease(name, releaseId)
);

// One click: queue the item and wake the orchestrator, which does the rest unattended.
ipcMain.handle('snitch:fix', (_event, name: string, itemId: string) => {
  assertNotCommittingAutomaticRestart();
  return pipeline.dispatch(name, itemId);
});
ipcMain.handle('snitch:cancel', (_event, name: string, itemId: string) => pipeline.cancel(name, itemId));
ipcMain.handle('snitch:acknowledge', (_event, name: string, itemId: string) => pipeline.acknowledge(name, itemId));
ipcMain.handle('snitch:pipeline', () => pipeline.snapshot());

// Carbons — the on-disk record of what each turn actually sent and did.
ipcMain.handle('carbon:list', (_event, limit?: number) => carbon.list(limit ?? 50));
ipcMain.handle('carbon:read', (_event, path: string) => carbon.read(path));
ipcMain.handle('carbon:location', () => carbon.location());
ipcMain.handle('carbon:forThread', (_event, threadId: string) => ({
  id: threadId,
  path: carbon.pathFor(threadId),
}));

/** Writes the whole conversation — every message and every tool call — wherever you choose. */
ipcMain.handle('carbon:export', async (_event, threadId: string, suggestedName: string) => {
  const text = carbon.contents(threadId);
  if (!text) return { saved: false, reason: 'This conversation has no carbon yet — send a message first.' };

  const options = {
    title: 'Export conversation',
    defaultPath: join(app.getPath('downloads'), suggestedName || `${threadId.slice(0, 8)}.md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { saved: false };

  writeFileSync(result.filePath, text);
  return { saved: true, path: result.filePath };
});

// MCP IPC handlers
ipcMain.handle('mcp:list', () => mcp.statuses());
ipcMain.handle('mcp:connect', (_event, id: string) => withMcpControl(() => mcp.connect(id)));
ipcMain.handle('mcp:disconnect', (_event, id: string) => withMcpControl(() => mcp.disconnect(id)));
ipcMain.handle('mcp:connectEnabled', () => withMcpControl(() => mcp.connectEnabled()));
ipcMain.handle('mcp:refresh', (_event, id: string) => withMcpControl(() => mcp.refresh(id)));

ipcMain.handle('mcp:setEnabled', async (_event, id: string, enabled: boolean) => {
  if (id.startsWith(mcp.MANAGED_SERVER_PREFIX)) throw new Error('Enable or disable this plugin from Plugins so its reviewed configuration stays authoritative.');
  return withMcpControl(async () => {
    mcpStore.update(id, { enabled });
    return enabled ? mcp.connect(id) : mcp.disconnect(id);
  });
});

ipcMain.handle('mcp:setToolEnabled', (_event, id: string, toolName: string, enabled: boolean) => {
  if (id.startsWith(mcp.MANAGED_SERVER_PREFIX)) throw new Error('Plugin tool permissions follow the conversation access mode. Disable the whole plugin from Plugins.');
  const server = mcpStore.list().find((entry) => entry.id === id);
  if (!server) return null;
  const disabled = new Set(server.disabledTools ?? []);
  enabled ? disabled.delete(toolName) : disabled.add(toolName);
  mcpStore.update(id, { disabledTools: [...disabled] });
  return mcp.statuses().find((status) => status.id === id) ?? null;
});

ipcMain.handle('mcp:call', (_event, id: string, toolName: string, args: Record<string, unknown>) => {
  assertNotCommittingAutomaticRestart();
  return withMcpWorkspace(mcpStore.workspace(), () => mcp.callTool(id, toolName, args ?? {}));
});

ipcMain.handle('mcp:workspace', () => mcpStore.workspace());
ipcMain.handle('mcp:workspaceState', (_event, threadId?: string) => {
  if (threadId !== undefined) {
    if (typeof threadId !== 'string') throw new Error('Invalid conversation ID.');
    const workspace = workspaceForConversation(threadId);
    if (!workspace) throw new Error('Conversation not found.');
    return { path: workspace.path, confirmed: workspace.confirmed, available: workspace.available, reason: workspace.reason };
  }
  return { path: mcpStore.workspace(), confirmed: mcpStore.workspaceConfirmed(), available: true };
});
/** Accepts the inherited directory as the one to work in, without moving it. */
ipcMain.handle('mcp:confirmWorkspace', (event, threadId?: string, expectedPath?: string) => {
  requireMainFrame(event);
  if (threadId !== undefined) {
    if (typeof threadId !== 'string') throw new Error('Invalid conversation ID.');
    const workspace = workspaceForConversation(threadId);
    if (!workspace) throw new Error('Conversation not found.');
    if (typeof expectedPath !== 'string' || expectedPath !== workspace.path) {
      throw new Error('This conversation’s workspace changed. Review its folder before confirming it.');
    }
    conversations.confirmWorkspace(threadId);
    return { path: workspace.path, confirmed: true, available: true };
  }
  mcpStore.confirmWorkspace();
  return { path: mcpStore.workspace(), confirmed: true, available: true };
});

// Servers read the workspace path when they spawn, so reconnect them to pick up a new one.
ipcMain.handle('mcp:setWorkspace', async (_event, directory: string | null, confirmed = true) => {
  return withMcpControl(async () => {
    // Choosing a directory in the UI is itself the confirmation.
    const applied = mcpStore.setWorkspace(directory, confirmed);
    await mcp.shutdown();
    await mcp.connectEnabled();
    return applied;
  });
});

ipcMain.handle('mcp:storeInfo', () => ({ path: mcpStore.storeLocation() }));

// Recovery shell IPC. State also arrives on 'recovery:state' whenever it changes, so a page that
// loaded late is corrected by the next change; these are the actions from the recovery page.
ipcMain.handle('recovery:state', () => recoveryShell.state());
ipcMain.handle('recovery:send', (_event, line: string) => {
  assertNotCommittingAutomaticRestart();
  return recoveryShell.sendLine(String(line ?? ''));
});
ipcMain.handle('recovery:approve', (_event, approvalId: string, allowed: boolean) =>
  recoveryShell.approve(String(approvalId ?? ''), !!allowed)
);
ipcMain.handle('recovery:cancel', () => recoveryShell.cancel());

/**
 * About window IPC handlers. The about window shows copyright, build number, tech stack, and
 * open source licenses. It is opened by clicking the Antimatter logo in the sidebar.
 */
ipcMain.handle('about:open', (event) => {
  requireTrustedMain(event);
  console.log('[about] open request received');
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      console.log('[about] main window not available');
      return false;
    }
    
    // Check if about window already exists
    if (aboutWindow && !aboutWindow.isDestroyed()) {
      console.log('[about] window already exists, focusing');
      aboutWindow.focus();
      return true;
    }
    
    // Create about window
    console.log('[about] creating new window');
    createAboutWindow();
    return true;
  } catch (error) {
    console.error('[about] error opening window:', error);
    return false;
  }
});

ipcMain.handle('about:close', (event) => {
  requireAboutAccess(event);
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.close();
    aboutWindow = null;
  }
  return true;
});
ipcMain.handle('about:support', async (event) => {
  requireAboutAccess(event);
  await shell.openExternal('https://ko-fi.com/execsoftware');
});

/**
 * System vitals, for the monitor tool window.
 *
 * The renderer polls rather than subscribing: a panel that is closed stops asking, which leaves
 * nothing to leak and nobody to unregister. Electron's own process metrics ride along, because
 * "is the machine busy" and "is Antimatter the reason" are the same question.
 */
const sampler = new Sampler(() =>
  app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.serviceName ?? metric.type,
    cpu: (metric.cpu?.percentCPUUsage ?? 0) / 100,
    // Electron reports the working set in kilobytes.
    memory: (metric.memory?.workingSetSize ?? 0) * 1024,
  }))
);

ipcMain.handle('vitals:sample', () => sampler.sample());

/**
 * Where a loaded checkpoint is resident, for the inference debug overlay. Polled while that
 * overlay is open and not otherwise, for the same reason vitals is.
 *
 * The units passed are the engines the lifecycle has started, because a cgroup squeezing one of
 * those is the explanation for a slow answer that no GPU tool can show: a capped `MemoryHigh`
 * reclaims the mmap'd weights the GPU still needs through GTT, and the only visible symptom is
 * that everything is inexplicably slow.
 */
/**
 * Installed font families, for the Appearance panel's pickers. Cached in the reader, so an open
 * panel re-asking costs nothing and a machine without fontconfig is probed once.
 */
ipcMain.handle('fonts:list', (event) => {
  requireMainFrame(event);
  return listSystemFonts();
});

ipcMain.handle('device-memory:sample', (event) => {
  requireMainFrame(event);
  return readDeviceMemory(localEngines.states().map((engine) => engine.unit));
});

// Model Hub IPC handlers. Every queue mutation answers with the whole list; progress also arrives on
// hub:downloads, so a page that missed an event is corrected by the next one.
ipcMain.handle('workloads:list', (event) => { requireMainFrame(event); return workloadDeployments.list(); });
ipcMain.handle('workloads:download', (event, id: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  downloadWorkload(hub.downloads, id);
  return workloadDeployments.list();
});
ipcMain.handle('workloads:configure', (event, id: unknown, peers: string[]) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  const workload = workloadById(id);
  if (providerManager.busy(`workload-${workload.id}`)) throw new Error('Wait for this workload’s active request to finish before changing its configuration.');
  const { source, contextTokens } = workloadDeployments.configure(id, peers);
  const existing = sourceStore.find(source.id);
  // Reconfiguration changes hardware settings without discarding a user's card edits.
  if (existing) {
    source.createdAt = existing.createdAt;
    source.models = source.models.map((model) => ({ ...model, ...existing.models.find((entry) => entry.id === model.id),
      contextWindow: contextTokens, deployment: peers.length ? 'distributed' : 'local' }));
  }
  providerManager.addConfig(sourceStore.save(source));
  modelProfiles.setOverride(source.id, workload.id, { contextTokens,
    maxOutputTokens: Math.min(workload.maxOutputTokens, Math.floor(contextTokens / 4)),
    maxToolCallsPerMessage: workload.maxToolCallsPerMessage });
  send('providers:changed', { at: Date.now() });
  return workloadDeployments.list();
});

ipcMain.handle('hub:state', () => hub.state());
ipcMain.handle('hub:search', (_event, query: HubSearchQuery) => hub.search(query));
ipcMain.handle('hub:model', (_event, repoId: string) => hub.model(repoId));
ipcMain.handle('hub:downloads', () => hub.downloads.list());
ipcMain.handle('hub:download', (_event, input: { repoId: string; revision: string; variantKey: string }) =>
  hub.download(input)
);
ipcMain.handle('hub:pause', (_event, id: string) => {
  hub.downloads.pause(id);
  return hub.downloads.list();
});
ipcMain.handle('hub:resume', (_event, id: string) => {
  hub.downloads.resume(id);
  return hub.downloads.list();
});
ipcMain.handle('hub:cancel', (_event, id: string) => {
  hub.downloads.cancel(id);
  return hub.downloads.list();
});
ipcMain.handle('hub:remove', (_event, id: string, deleteFiles: boolean) => {
  hub.downloads.remove(id, !!deleteFiles);
  return hub.downloads.list();
});
ipcMain.handle('hub:reregister', (_event, id: string) => hub.reregister(id));
ipcMain.handle('hub:setToken', (_event, token: string | null) => hub.settings.setToken(token));
ipcMain.handle('hub:importToken', () => ({ imported: hub.settings.importToken(), token: hub.settings.tokenState() }));
ipcMain.handle('hub:whoami', () => hub.whoami());
ipcMain.handle('hub:setRoot', (_event, path: string | null) => hub.settings.setRoot(path));

// Update IPC handlers. State also arrives on updates:state whenever it changes.
ipcMain.handle('updates:state', () => updates.state());
ipcMain.handle('updates:check', () => updates.check());
ipcMain.handle('updates:apply', () => updates.apply());
ipcMain.handle('updates:setAutomatic', (_event, automatic: boolean) => {
  const state = updates.setAutomatic(!!automatic);
  if (!state.automatic) {
    automaticRestartCoordinator?.cancel();
    cancelPendingRendererPreparation('Automatic updates were turned off.');
  }
  return state;
});
ipcMain.handle('updates:setFeed', (_event, path: string | null) => updates.setFeed(path || null));
ipcMain.handle('updates:restartPrepared', (event, requestId: string, reported: unknown) => {
  const pending = pendingRestartPreparation;
  if (!pending || event.sender !== pending.sender || requestId !== pending.requestId) return false;
  const blockers = Array.isArray(reported)
    ? reported
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 32)
        .map((entry) => entry.slice(0, 500))
    : ['The main window returned an invalid restart response.'];
  pending.finish(blockers);
  return true;
});
/** Relaunches through the installer's launcher (or the AppImage), so the new `current` release opens. */
ipcMain.handle('updates:restart', async () => {
  const target = updates.restartTarget(process.argv.slice(1));
  if (!target) return false;
  await relaunchAfterExit(target, process.env);
  quitApplication();
  return true;
});

// Local beholdd server IPC handlers
ipcMain.handle('hag:state', (event) => { requireMainFrame(event); return hag.state(); });
ipcMain.handle('pensieve:getState', event => { requireMainFrame(event); return pensieve.state(); });
ipcMain.handle('pensieve:setEnabled', (event, enabled: unknown) => {
  requireMainFrame(event); assertNotCommittingAutomaticRestart();
  if (typeof enabled !== 'boolean') throw new Error('Pensieve enabled must be a boolean.');
  return enabled ? pensieve.enable() : pensieve.disable();
});
ipcMain.handle('hag:enable', (event) => { requireMainFrame(event); assertNotCommittingAutomaticRestart(); return hag.enable(); });
ipcMain.handle('hag:disable', (event) => { requireMainFrame(event); assertNotCommittingAutomaticRestart(); return hag.disable(); });
ipcMain.handle('hag:dismissWelcome', (event) => { requireMainFrame(event); return hag.dismissWelcome(); });
ipcMain.handle('beholdd:info', () => beholdd.info());
ipcMain.handle('beholdd:status', () => beholdd.inspectStatus());
ipcMain.handle('beholdd:start', async (_event, options: { configPath?: string; host?: string; port?: number }) => {
  return startNative(options ?? {});
});
ipcMain.handle('beholdd:restart', async (_event, options: { configPath?: string; host?: string; port?: number }) => {
  return startNative(options ?? {}, true);
});
ipcMain.handle('beholdd:stop', () => beholdd.stop());

// The app-owned inference servers, as one list with stop/restart. `force` is the renderer's
// explicit choice to abandon an in-flight turn, never a default.
ipcMain.handle('inference-servers:list', (event) => { requireMainFrame(event); return inferenceServers.list(); });
ipcMain.handle('inference-servers:start', (event, id: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  return inferenceServers.start(id);
});
ipcMain.handle('inference-servers:stop', (event, id: unknown, options: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  return inferenceServers.stop(id, assertInferenceServerAction(options).force);
});
ipcMain.handle('inference-servers:restart', (event, id: unknown, options: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  return inferenceServers.restart(id, assertInferenceServerAction(options).force);
});

// Terminal IPC handlers. Sessions live in the main process and outlive the panel, so hiding the
// tool window detaches from a running shell rather than killing it.
terminal.connect({
  onData: (id, data, offset) => send('terminal:data', { id, data, offset }),
  onExit: (id, exit) => send('terminal:exit', { id, ...exit }),
  onCommand: (info) => {
    // The tool's normal approval has already completed. Reveal the local input surface for
    // privilege prompts, but never send keystrokes or passwords through the conversation.
    //
    // Only sudo earns the interruption. Every agent command runs in this console, and popping
    // it open for each `ls` buries whatever the person was reading; a password prompt is the
    // one case where the console is useless unless it is in front of them. The renderer is
    // told rather than asked, so the rule lives in one place instead of a second regex there.
    const needsInput = needsLocalInput(info.command);
    if (needsInput) showMainWindow();
    send('terminal:command', { ...info, needsInput });
  },
});

ipcMain.handle('terminal:create', (event, options: { cwd?: string | null; cols?: number; rows?: number }) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  return terminal.create(options ?? {});
});
ipcMain.handle('terminal:list', (event) => { requireMainFrame(event); return terminal.list(); });
const requireMainFrame = (event: Electron.IpcMainInvokeEvent): void => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('This action is only available in the Antimatter window.');
};
const appearanceAuthority = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
  const surface: 'main' | 'about' | 'avatar' | 'recovery' | 'detached' | null = event.sender === mainWindow?.webContents
    ? (isAppearancePage(event.senderFrame?.url ?? '', 'recovery.html', join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL) ? 'recovery' : 'main')
    : event.sender === aboutWindow?.webContents ? 'about'
      : desktopAvatar?.ownsWebContents(event.sender) ? 'avatar'
        : detachedWindows.ownsWebContents(event.sender) ? 'detached' : null;
  const mainFrame = !event.sender.isDestroyed() && event.senderFrame !== null && event.senderFrame === event.sender.mainFrame;
  const entry = surface === 'main' ? 'index.html' : surface === 'about' ? 'about.html' : surface === 'recovery' ? 'recovery.html' : surface === 'detached' ? 'detached.html' : 'avatar.html';
  const trustedPage = mainFrame && isAppearancePage(event.senderFrame!.url, entry, join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL);
  return { surface, mainFrame, trustedPage };
};
const requireAppearanceAccess = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, write = false): void => {
  const { surface, mainFrame, trustedPage } = appearanceAuthority(event);
  if (!(write ? mayUpdateAppearance : mayReadAppearance)(surface, mainFrame, trustedPage)) throw new Error('Appearance settings are only available in the trusted Antimatter window.');
};
function requireTrustedMain(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void {
  const authority = appearanceAuthority(event);
  if (authority.surface !== 'main' || !authority.mainFrame || !authority.trustedPage) {
    throw new Error('This action is only available in the Antimatter window.');
  }
}
function requireAboutAccess(event: Electron.IpcMainInvokeEvent): void {
  const authority = appearanceAuthority(event);
  if (!['main', 'about'].includes(authority.surface ?? '') || !authority.mainFrame || !authority.trustedPage) {
    throw new Error('This action is only available in the Antimatter window.');
  }
}
const desktopPreferencesIpc = registerDesktopPreferencesIpc({ ipcMain, store: desktopPreferencesStore,
  getWindow: () => mainWindow, authorize: requireTrustedMain, platform: process.platform });
registerDoomIpc({ ipcMain, authorize: requireTrustedMain, dialog, getWindow: () => mainWindow,
  runtimeDirectory: app.isPackaged ? join(process.resourcesPath, 'doom')
    : process.env.ANTIMATTER_DOOM_RUNTIME || join(app.getAppPath(), 'resources', 'doom'),
  saves: new DoomSaveStore(join(app.getPath('userData'), 'doom-saves')) });
ipcMain.handle('features:get', (event) => { requireTrustedMain(event); return features.get(); });
const handleConnection = (channel: string, callback: (...args: any[]) => unknown) => ipcMain.handle(`connections:${channel}`, (event, ...args) => {
  requireTrustedMain(event); assertNotCommittingAutomaticRestart(); return callback(...args);
});
handleConnection('get', () => connections.get());
handleConnection('enable', (...args: Parameters<ConnectionsService['enable']>) => connections.enable(...args));
handleConnection('registration', (...args: Parameters<ConnectionsService['registration']>) => connections.registration(...args));
handleConnection('connect', (...args: Parameters<ConnectionsService['connect']>) => connections.connect(...args));
handleConnection('disconnect', (id: string) => connections.disconnect(id));
handleConnection('authorize', (...args: Parameters<ConnectionsService['authorize']>) => connections.authorize(...args));
handleConnection('complete', (...args: Parameters<ConnectionsService['complete']>) => connections.complete(...args));
handleConnection('cancel-authorization', (id: string) => connections.oauth.cancel(id));
handleConnection('access', (id: string, threadId: string, read: boolean, send: boolean) => connections.access(id, securityWorkspace(threadId), read, send));
handleConnection('project-access', (id: string, threadId: string) => connections.projectAccess(id, securityWorkspace(threadId)));
handleConnection('folders', (id: string, cursor?: string) => connections.folders(id, cursor));
handleConnection('messages', (id: string, folder: string, cursor?: string) => connections.messages(id, folder, cursor));
handleConnection('message', (id: string, folder: string, message: string) => connections.message(id, folder, message));
handleConnection('send', (draft: import('../api/connections').ConnectionDraft) => connections.send(draft));
handleConnection('receipt', (requestId: string) => connections.receipt(requestId));
ipcMain.handle('features:update', (event, revision: number, mutation: import('../api/features').FeatureMutation) => {
  requireTrustedMain(event); return features.update(revision, mutation);
});
ipcMain.handle('features:configure-api', (event, enabled: boolean) => { requireTrustedMain(event); return features.configureApi(enabled); });
const securityWorkspace = (threadId: string): string => {
  if (typeof threadId !== 'string' || !threadId) throw new Error('Choose a chat with a project folder.');
  const bound = workspaceForConversation(threadId);
  if (!bound?.available || !bound.confirmed) throw new Error('Choose and confirm a project folder in this chat.');
  return bound.path;
};
ipcMain.handle(SECURITY_IPC.list, (event, threadId: string) => { requireTrustedMain(event); return security.list(securityWorkspace(threadId)); });
ipcMain.handle(SECURITY_IPC.scan, (event, threadId: string, options: Parameters<SecurityService['scan']>[1]) => {
  requireTrustedMain(event); assertNotCommittingAutomaticRestart(); return security.scan(securityWorkspace(threadId), options);
});
ipcMain.handle(SECURITY_IPC.cancel, (event, threadId: string) => { requireTrustedMain(event); return security.cancel(securityWorkspace(threadId)); });
ipcMain.handle(SECURITY_IPC.triage, (event, threadId: string, update: Parameters<SecurityService['triage']>[1]) => {
  requireTrustedMain(event); return security.triage(securityWorkspace(threadId), update);
});
ipcMain.handle(SECURITY_IPC.remove, (event, threadId: string, reportId: string) => {
  requireTrustedMain(event); return security.remove(securityWorkspace(threadId), reportId);
});
ipcMain.handle(SECURITY_IPC.exportReport, async (event, threadId: string, reportId: string, format: import('../api/security').SecurityExportFormat) => {
  requireTrustedMain(event);
  const report = await security.serializeExport(securityWorkspace(threadId), reportId, format);
  if (!mainWindow) throw new Error('The main window is unavailable.');
  const result = await dialog.showSaveDialog(mainWindow, { title: 'Export security report', defaultPath: report.filename });
  if (result.canceled || !result.filePath) return { path: null };
  writeFileSync(result.filePath, report.contents, { mode: 0o600 });
  return { path: result.filePath };
});
registerChatNotesIpc({ ipc: ipcMain, store: chatNotes,
  assertTrusted: (event) => requireTrustedMain(event as Electron.IpcMainInvokeEvent),
  broadcast: (change) => send(CHAT_NOTES_IPC.changed, change) });
ipcMain.handle('sidebar:load', (event) => { requireTrustedMain(event); return sidebarStore.read(); });
ipcMain.handle('sidebar:update', (event, input: import('../api/sidebar').SidebarUpdate) => {
  requireTrustedMain(event);
  const next = sidebarStore.update(input);
  send('sidebar:changed', { revision: next.revision });
  return next;
});
ipcMain.handle('idle-compaction:get', (event) => { requireTrustedMain(event); return idleCompaction.state(); });
ipcMain.handle('idle-compaction:update', (event, patch: unknown) => { requireTrustedMain(event); return idleCompaction.update(patch); });
ipcMain.handle('idle-compaction:activity', (event, threadId: string | null) => {
  requireTrustedMain(event);
  if (threadId !== null && !conversations.snapshot().threads.some((thread) => thread.id === threadId)) return;
  idleCompaction.activity(threadId);
});
ipcMain.handle('pensieve-library:get', (event, workspace?: string | null) => {
  requireTrustedMain(event); return pensieveLibrary.get(workspace);
});
ipcMain.handle('pensieve-library:update', (event, input: Parameters<PensieveLibrary['update']>[0]) => {
  requireTrustedMain(event);
  const next = pensieveLibrary.update(input);
  send('pensieve-library:changed', { revision: next.revision });
  return next;
});
/**
 * Sleeps until the exact instant the schedule flips instead of polling a clock. The broadcast
 * payload is the unchanged settings object: every surface derives the theme from it, so a
 * boundary needs no new state, only a nudge. Main owns this timer because renderer timers are
 * throttled when the window is in the background.
 */
let themeBoundaryTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleThemeBoundary = (settings: AppearanceSettings): void => {
  if (themeBoundaryTimer !== undefined) clearTimeout(themeBoundaryTimer);
  themeBoundaryTimer = undefined;
  const boundary = nextThemeBoundary(settings);
  if (!boundary) return;
  // Fire a second into the new minute so the re-resolve cannot land on the old side of it, and
  // clamp to setTimeout's 32-bit ceiling so a wild clock cannot wrap into an immediate loop.
  const delay = Math.min(Math.max(boundary.getTime() - Date.now(), 0) + 1_000, 2 ** 31 - 1);
  themeBoundaryTimer = setTimeout(() => {
    themeBoundaryTimer = undefined;
    applyAppearance(appearanceStore.get());
  }, delay);
};

const applyAppearance = (settings: AppearanceSettings): void => {
  nativeTheme.themeSource = resolveTheme(settings);
  for (const window of [mainWindow, aboutWindow]) {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.setBackgroundColor(appearanceBackground(settings));
    const entry = window === mainWindow
      ? (isAppearancePage(window.webContents.getURL(), 'recovery.html', join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL) ? 'recovery.html' : 'index.html') : 'about.html';
    if (isAppearancePage(window.webContents.getURL(), entry, join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL)) {
      window.webContents.send('appearance:changed', settings);
    }
  }
  desktopAvatar?.sendAppearance(settings);
  detachedWindows.appearanceChanged(settings, appearanceBackground(settings));
  scheduleThemeBoundary(settings);
};
ipcMain.on('appearance:initial', (event) => {
  // Always resolve synchronous IPC, even for rejected frames. No filesystem work on this path.
  try { requireAppearanceAccess(event); event.returnValue = appearanceStore.get(); }
  catch { event.returnValue = null; }
});
ipcMain.handle('appearance:get', (event) => { requireAppearanceAccess(event); return appearanceStore.get(); });
ipcMain.handle('appearance:update', (event, patch: unknown) => {
  requireAppearanceAccess(event, true);
  const next = appearanceStore.update(patch);
  applyAppearance(next);
  return next;
});

/**
 * Being told a turn finished.
 *
 * Split across the two processes along the line of what each can actually do. The window knows
 * that a turn settled, which conversation it was, and whether the person stopped it themselves.
 * Only the main process knows whether the window has focus, and only it can raise a desktop
 * notification. Only the window can make a noise. So the window reports, this decides, and the
 * reply tells the window what to play.
 *
 * `planTurnNotification` holds the whole decision and is pure, which is why none of the rules
 * are written out again here.
 */
const publishNotifications = (next: NotificationSettings): NotificationSettings => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('notifications:changed', next);
  }
  return next;
};
/** Held only so a notification cannot be collected between being shown and being clicked. */
const liveNotifications = new Set<Notification>();
ipcMain.handle('notifications:get', (event) => { requireMainFrame(event); return notificationStore.get(); });
ipcMain.handle('notifications:update', (event, patch: unknown) => {
  requireMainFrame(event);
  return publishNotifications(notificationStore.update(patch));
});
ipcMain.handle('notifications:chooseSound', async (event) => {
  requireMainFrame(event);
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose a notification sound',
    properties: ['openFile'],
    // Extensions narrow the list; what is actually in the file decides. A sound saved under the
    // wrong name should be pickable and then refused for a reason, not invisible with none.
    filters: [{ name: 'Sounds', extensions: [...SOUND_FILE_EXTENSIONS] }, { name: 'All files', extensions: ['*'] }],
  });
  // The window may have been replaced while the picker was open; it must still be the one that asked.
  requireMainFrame(event);
  const chosen = result.canceled ? null : result.filePaths[0];
  if (!chosen) return null;
  return publishNotifications(notificationStore.setCustomSound(
    adoptSoundFile(chosen, app.getPath('userData')),
  ));
});
ipcMain.handle('notifications:clearSound', (event) => {
  requireMainFrame(event);
  return publishNotifications(notificationStore.setCustomSound(null));
});
ipcMain.handle('notifications:soundData', (event) => {
  requireMainFrame(event);
  const sound = notificationStore.get().customSound;
  return sound ? readSoundDataUrl(sound) : null;
});
ipcMain.handle('notifications:turnFinished', (event, value: unknown) => {
  requireMainFrame(event);
  const turn = parseFinishedTurn(value);
  const plan = planTurnNotification(notificationStore.get(), turn, {
    focused: mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused(),
  });
  if (plan.desktop && Notification.isSupported()) {
    // Silent: the sound is ours to play, at the chosen volume and the chosen sound. Letting the
    // desktop add its own would mean two noises for one finished turn, one of them unconfigurable.
    const notification = new Notification({ ...plan.desktop, silent: true, urgency: 'normal' });
    const retire = () => liveNotifications.delete(notification);
    notification.on('close', retire);
    notification.on('failed', retire);
    notification.on('click', () => {
      retire();
      showMainWindow();
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('notifications:activate', { threadId: turn.threadId });
      }
    });
    liveNotifications.add(notification);
    notification.show();
  }
  return plan;
});
const requireVoiceFrame = (event: Electron.IpcMainInvokeEvent): void => {
  requireMainFrame(event);
  if (!isVoiceRenderer(event.sender)) throw new Error('Voice is available only in the main chat window.');
};
ipcMain.handle('voice:get', async (event) => {
  requireVoiceFrame(event);
  // Read-only discovery of installed local voice models; never load a model here.
  if (Date.now() - lastSpeechDiscovery > 30_000) {
    lastSpeechDiscovery = Date.now();
    [localSpeechSource, localTranscriptionSource] = await Promise.all([
      discoverLocalSpeechSource().catch(() => null), discoverLocalTranscriptionSource().catch(() => null),
    ]);
  }
  try {
    return { settings: voiceSettings.read(), sources: voiceSources(availableVoiceSources()), state: voiceSession.snapshot() };
  } catch (error) {
    return { settings: defaultVoiceSettings(availableVoiceSources()), sources: voiceSources(availableVoiceSources()),
      state: voiceSession.snapshot(), configurationError: error instanceof Error ? error.message : 'Save voice settings to repair the configuration.' };
  }
});
ipcMain.handle('voice:configure', (event, settings: unknown) => {
  requireVoiceFrame(event);
  if (voiceSession.snapshot().active) throw new Error('Stop voice before changing its sources.');
  return { settings: voiceSettings.save(settings), sources: voiceSources(availableVoiceSources()), state: voiceSession.snapshot() };
});
ipcMain.handle('voice:probe', (event) => {
  requireVoiceFrame(event);
  const settings = voiceSettings.read();
  return probeVoiceBackend(selectedVoiceSource(settings.inputSourceId), settings.inputModel,
    { inputMode: settings.inputMode, allowRemote: settings.allowRemote });
});
ipcMain.handle('voice:begin', (event, threadId: string) => {
  requireVoiceFrame(event); assertNotCommittingAutomaticRestart();
  if (!voiceHasVisibleControls()) throw new Error('Show Antimatter or its desktop avatar before starting the microphone.');
  const settings = voiceSettings.read();
  selectedVoiceSource(settings.inputSourceId);
  if (!settings.inputModel) throw new Error('Choose an audio input model in Voice setup.');
  if (settings.speechEnabled) selectedVoiceSource(settings.speechSourceId);
  return voiceSession.begin(threadId, settings);
});
ipcMain.handle('voice:end', (event, sessionId: string) => { requireVoiceFrame(event); voiceSession.end(sessionId); });
ipcMain.handle('voice:update', (event, sessionId: string, status: { phase?: VoicePhase; muted?: boolean; speaking?: boolean; error?: string | null }) => {
  requireVoiceFrame(event); voiceSession.update(sessionId, status);
});
ipcMain.handle('voice:cancel', (event, sessionId: string, requestId: string) => { requireVoiceFrame(event); voiceSession.cancel(sessionId, requestId); });
ipcMain.handle('voice:beginTranscription', (event, sessionId: string, requestId: string) => {
  requireVoiceFrame(event);
  if (voiceSession.assert(sessionId).inputMode !== 'realtime') return { active: false };
  // The input request owns the socket until cancellation, while this invoke resolves
  // at readiness so the renderer can start capture without buffering a cold load.
  let ready!: (result: { active: boolean }) => void;
  let failed!: (error: unknown) => void;
  const readiness = new Promise<{ active: boolean }>((resolve, reject) => { ready = resolve; failed = reject; });
  void voiceSession.request(sessionId, requestId, 'input', async (settings, signal) => {
    const transport = new RealtimeTranscription();
    const entry = { sessionId, senderId: event.sender.id, transport };
    liveTranscriptions.set(requestId, entry);
    try {
      await transport.start(sessionId, selectedVoiceSource(settings.inputSourceId), settings.inputModel, {
        signal, allowRemote: settings.allowRemote,
        onEvent: (update) => {
          if (!signal.aborted && !event.sender.isDestroyed()) event.sender.send('voice:transcription', { ...update, requestId });
        },
      });
      if (signal.aborted) throw new Error('Live transcription cancelled.');
      ready({ active: true });
      await transport.waitUntilClosed();
    } finally {
      transport.stop(sessionId);
      if (liveTranscriptions.get(requestId) === entry) liveTranscriptions.delete(requestId);
    }
  }).catch(failed);
  return readiness;
});
const ownedLiveTranscription = (event: Electron.IpcMainInvokeEvent, sessionId: string, requestId: string) => {
  requireVoiceFrame(event); voiceSession.assert(sessionId);
  const entry = liveTranscriptions.get(requestId);
  if (!entry || entry.sessionId !== sessionId || entry.senderId !== event.sender.id) throw new Error('This live transcription request has ended.');
  return entry.transport;
};
ipcMain.handle('voice:appendTranscription', (event, sessionId: string, requestId: string, pcmBase64: string) =>
  ownedLiveTranscription(event, sessionId, requestId).append(sessionId, pcmBase64));
ipcMain.handle('voice:commitTranscription', (event, sessionId: string, requestId: string) =>
  ownedLiveTranscription(event, sessionId, requestId).commit(sessionId));
ipcMain.handle('voice:clearTranscription', (event, sessionId: string, requestId: string) =>
  ownedLiveTranscription(event, sessionId, requestId).clear(sessionId));
ipcMain.handle('voice:transcribe', (event, sessionId: string, requestId: string, payload: { wavBase64?: unknown; sampleRate?: unknown }) => {
  requireVoiceFrame(event);
  if (!payload || typeof payload.wavBase64 !== 'string' || payload.wavBase64.length > 3_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.wavBase64)) throw new Error('Invalid or oversized voice recording.');
  const audio = Buffer.from(payload.wavBase64, 'base64');
  return voiceSession.request(sessionId, requestId, 'input', async (settings, signal) => {
    if (settings.inputMode === 'realtime') throw new Error('Use streaming transcription for this input model.');
    const result = await transcribeVoice(selectedVoiceSource(settings.inputSourceId), settings.inputModel, audio,
      { mode: settings.inputMode, signal, allowRemote: settings.allowRemote });
    return result.text;
  });
});
ipcMain.handle('voice:synthesize', (event, sessionId: string, requestId: string, text: unknown) => {
  requireVoiceFrame(event);
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Speech text must contain 1–4,000 characters.');
  return voiceSession.request(sessionId, requestId, 'speech', async (settings, signal) => {
    if (!settings.speechEnabled) throw new Error('Spoken replies are disabled in Voice setup.');
    const result = await synthesizeVoice(selectedVoiceSource(settings.speechSourceId), settings.speechModel, settings.speechVoice, text,
      { signal, allowRemote: settings.allowRemote });
    return { audioBase64: Buffer.from(result.audio).toString('base64'), mimeType: result.mediaType };
  });
});
ipcMain.handle('voice:synthesizeStream', (event, sessionId: string, requestId: string, text: unknown) => {
  requireVoiceFrame(event);
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Speech text must contain 1–4,000 characters.');
  return voiceSession.request(sessionId, requestId, 'speech', async (settings, signal) => {
    if (!settings.speechEnabled) throw new Error('Spoken replies are disabled in Voice setup.');
    const delivery = new VoiceSpeechDelivery(sessionId, requestId, event.sender.id, signal,
      (chunk) => event.sender.send('voice:speechChunk', chunk));
    speechDeliveries.set(requestId, delivery);
    try {
      await synthesizeVoiceStream(selectedVoiceSource(settings.speechSourceId), settings.speechModel, settings.speechVoice, text,
        (chunk) => delivery.send(chunk), { signal, allowRemote: settings.allowRemote });
    } finally { if (speechDeliveries.get(requestId) === delivery) speechDeliveries.delete(requestId); }
  });
});
ipcMain.handle('voice:acknowledgeSpeechChunk', (event, sessionId: string, requestId: string, sequence: unknown) => {
  requireVoiceFrame(event);
  speechDeliveries.get(requestId)?.acknowledge(sessionId, requestId, event.sender.id, sequence);
});
ipcMain.handle('voice:guide', (event, sessionId: string, runId: string, utteranceId: string, text: string) => {
  requireVoiceFrame(event); voiceSession.assert(sessionId);
  const active = activeThreads.recordForRun(runId);
  const queue = steering.get(runId)?.voice;
  if (!active || active.threadId !== voiceSession.snapshot().threadId || active.owner.kind !== 'renderer' || !queue) return null;
  const guidance = queue.enqueue(utteranceId, text, runningTurnCarbons.get(runId)?.partial.length ?? 0);
  // Acceptance is authoritative even if optional diagnostics cannot be written. Rejecting
  // after enqueue would make an uncertain retry look like a new instruction to the user.
  try { carbon.add(active.threadId, { kind: 'note', label: 'Spoken guidance queued', body: guidance.text, runId }); }
  catch (error) { console.error('[voice] guidance diagnostic could not be saved:', error); }
  send('voice:guidance', { threadId: active.threadId, runId, guidance: [guidance] });
  return guidance;
});
const extensionWorkspace = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid extension workspace.');
  return value;
};
ipcMain.handle('extensions:catalog', (event, workspace: unknown) => {
  requireMainFrame(event);
  return extensions.catalog(extensionWorkspace(workspace));
});
ipcMain.handle('extensions:readSkill', (event, workspace: unknown, id: unknown, resource: unknown) => {
  requireMainFrame(event);
  if (typeof id !== 'string' || id.length > 128 || (resource !== undefined && (typeof resource !== 'string' || resource.length > 2048))) throw new Error('Invalid skill resource.');
  return extensions.readSkill(extensionWorkspace(workspace), id, resource as string | undefined);
});
ipcMain.handle('extensions:importPlugin', async (event) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  const picked = await dialog.showOpenDialog(mainWindow!, { title: 'Import a local plugin folder', properties: ['openDirectory'] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  // Import only records a disabled plugin. No commands or hooks run here.
  return extensions.importPlugin(picked.filePaths[0]);
});
ipcMain.handle('extensions:setPluginEnabled', async (event, id: unknown, enabled: unknown, fingerprint: unknown) => {
  requireMainFrame(event);
  assertNotCommittingAutomaticRestart();
  if (typeof id !== 'string' || id.length > 128 || typeof enabled !== 'boolean' ||
      (fingerprint !== undefined && (typeof fingerprint !== 'string' || fingerprint.length > 128))) throw new Error('Invalid plugin configuration.');
  return withMcpControl(async () => {
    const plugin = extensions.setPluginEnabled(id, enabled, fingerprint as string | undefined);
    const statuses = await mcp.connectEnabled();
    const ids = new Set(extensions.mcpServers().filter((server) => server.pluginId === id).map((server) => server.id));
    const failed = statuses.some((status) => ids.has(status.id) && !status.connected);
    extensions.setActivationError(id, failed ? 'Could not connect' : null);
    return extensions.catalog(null).plugins.find((entry) => entry.id === id) ?? plugin;
  });
});
registerCodeReviewIpc(ipcMain, {
  store: codeReviews,
  requireSender: (event) => {
    requireMainFrame(event);
    if (!isAppearancePage(event.senderFrame?.url ?? '', 'index.html', join(__dirname, '../renderer'), process.env.VITE_DEV_SERVER_URL)) {
      throw new Error('Code review is only available in the Antimatter workspace.');
    }
  },
  author: () => ({ kind: 'human', label: 'You' }),
});

ipcMain.handle('pull-requests:list', (event, workspace: string | null) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Only the Antimatter window can list pull requests.');
  return listPullRequests(workspace);
});
ipcMain.handle('pull-requests:read', (event, workspace: string | null, number: number) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Only the Antimatter window can read pull requests.');
  return readPullRequest(workspace, number);
});
ipcMain.handle('terminal:openExternal', (event, directory: unknown) => {
  if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Only the Antimatter window can open a terminal.');
  assertNotCommittingAutomaticRestart();
  return openExternalTerminal(directory);
});
ipcMain.handle('terminal:history', (event, id: string) => { requireMainFrame(event); return terminal.history(id); });
ipcMain.handle('terminal:snapshot', (event, id: string) => { requireMainFrame(event); return terminal.snapshot(id); });
ipcMain.handle('terminal:write', (event, id: string, data: string) => {
  requireMainFrame(event);
  if (typeof id !== 'string' || typeof data !== 'string' || data.length > 64_000) throw new Error('Invalid terminal input.');
  terminal.write(id, data);
});
ipcMain.handle('terminal:resize', (event, id: string, cols: number, rows: number) => {
  requireMainFrame(event); terminal.resize(id, cols, rows);
});
ipcMain.handle('terminal:kill', (event, id: string) => { requireMainFrame(event); terminal.kill(id); });

// Workspace IPC handlers
ipcMain.handle('workspace:choose-directory', async (event, threadId?: string) => {
  // Detached Snitch panels also choose folders, but may not retarget a saved conversation.
  const requirePickerFrame = () => {
    if (threadId !== undefined || !detachedWindows.ownsFrame(event)) requireMainFrame(event);
  };
  requirePickerFrame();
  if (threadId !== undefined && typeof threadId !== 'string') throw new Error('Invalid conversation ID.');
  const thread = threadId === undefined ? null : conversations.snapshot().threads.find((candidate) => candidate.id === threadId);
  if (threadId !== undefined && !thread) throw new Error('Conversation not found.');
  if (thread && activeThreads.runFor(thread.id)) throw new Error('Stop this conversation’s active turn before changing its folder.');
  const options: OpenDialogOptions = {
    title: 'Choose working directory',
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  requirePickerFrame();
  const chosen = result.canceled ? null : result.filePaths[0] ?? null;
  if (chosen && thread) {
    requireMainFrame(event);
    if (activeThreads.runFor(thread.id)) throw new Error('Stop this conversation’s active turn before changing its folder.');
    conversations.setWorkspaceDirectory(thread.id, chosen, thread.revision);
  }
  return chosen;
});

// A newly created Code project is an explicit folder selection for the active chat.
ipcMain.handle('workspace:set-directory', (event, threadId: string, directory: string) => {
  requireMainFrame(event);
  if (typeof threadId !== 'string' || !threadId || typeof directory !== 'string' || !directory) {
    throw new Error('Choose a valid chat and folder.');
  }
  if (activeThreads.runFor(threadId)) throw new Error('Stop this conversation’s active turn before changing its folder.');
  const thread = conversations.setWorkspaceDirectory(threadId, directory);
  return thread.workspaceBinding?.path ?? directory;
});

ipcMain.handle('workspace:choose-file', async (_event, options?: { title?: string; filters?: Electron.FileFilter[] }) => {
  const dialogOptions: OpenDialogOptions = {
    title: options?.title ?? 'Choose a file',
    filters: options?.filters,
    properties: ['openFile'],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  return result.canceled ? null : result.filePaths[0] ?? null;
});

/**
 * Refresh startup catalogs through the same source identity and observation-order checks as
 * manual refresh. A slow startup observation must not restore a deleted source or an older cap.
 */
async function adoptNewModels(sources: InferenceSource[]): Promise<void> {
  for (const source of sources) {
    if ((source.kind ?? 'beholdd') !== 'beholdd') continue;
    try {
      const result = await refreshSource(source, true, {
        current: sourceStore.find,
        probe: probeSource,
        save: sourceStore.save,
      });
      if (!result.saved) continue;
      providerManager.addConfig(result.saved);
      console.log(`[sources] ${result.saved.name}: refreshed model metadata`);
    } catch {
      continue;
    }
  }
}

if (primaryInstance) {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    applyAppearance(appearanceStore.get());
    // A suspended machine wakes with a timer that may be hours stale, and the clock can be
    // changed by hand or by NTP. Re-resolving is idempotent, so just redo it on every such event.
    // Each is registered separately because powerMonitor's overloads do not accept a union.
    const reresolveAppearance = () => applyAppearance(appearanceStore.get());
    try {
      powerMonitor.on('resume', reresolveAppearance);
      powerMonitor.on('unlock-screen', reresolveAppearance);
    } catch { /* Not every platform emits these; the timer still covers the normal case. */ }
    let compatibility: InferenceSource | null = null;
    try {
      compatibility = llamaVulkan.sourceConfig();
    } catch (error) {
      console.error('[llama-vulkan] compatibility source was not seeded:', error);
    }

    let configuredSources = sourceStore.list();
    const removedStaleCompatibility =
      compatibility === null && configuredSources.some((source) => source.id === llamaVulkan.SOURCE_ID);
    if (removedStaleCompatibility) {
      // This id is reserved for Antimatter's managed bridge. A --skip-model install (or a removed
      // checkpoint) must not leave yesterday's unusable source in the picker or provider registry.
      sourceStore.remove(llamaVulkan.SOURCE_ID);
      configuredSources = configuredSources.filter((source) => source.id !== llamaVulkan.SOURCE_ID);
    }
    configuredSources.forEach((source) => providerManager.addConfig(source));
    try { hag.initialize(); } catch (error) { console.error('[hag] source restoration failed:', error); }

    // Pick up a store written by something other than this window. The file was previously read
    // once per launch and cached for the lifetime of the process, so a source added by a
    // provisioning script, a stack installed from the hub, or an edit by hand simply did not
    // exist as far as the picker was concerned - and nothing said so. The model was loaded, the
    // server was answering, and there was no card to select.
    sourceStore.watchStore(() => {
      try {
        sourceStore.list().forEach((source) => providerManager.addConfig(source));
        // A source whose vision capability changed must not keep the previous answer, which is
        // cached for a minute and decides where every `look` is sent.
        eyes.forget();
        send('providers:changed', { at: Date.now() });
        console.info('[sources] reloaded after an external change to the store.');
      } catch (error) {
        console.error('[sources] could not reload the store after it changed:', error);
      }
    });
    // The bundled server is Antimatter's zero-configuration inference source. Bring its HTTP
    // listener up before exposing the composer, so the first message cannot beat server startup.
    const localStatus = await beholdd.start({}).catch((error) => {
      console.error('[beholdd] automatic startup failed:', error);
      return null;
    });

    // A model added to a server after its source was configured was invisible until someone
    // remembered to press Refresh models, because nothing else ever asks the server again. Probe
    // only after the bundled listener has had its startup attempt: otherwise an ordinary relaunch
    // races its own stopped server and never imports new capability metadata. Adoption stays
    // additive, so a curated list remains curated and a source that is down cannot empty it.
    void adoptNewModels(configuredSources);

    // A new profile should be able to send its first message without visiting Settings. Never
    // rewrite an existing source list, and describe a listener we adopted rather than spawned as
    // external so neither the UI nor the user mistakes it for an app-owned process.
    if (configuredSources.length === 0 && localStatus?.ready) {
      const baseUrl = `http://${beholdd.DEFAULT_HOST}:${beholdd.DEFAULT_PORT}/v1`;
      const discovered = await probeSource(baseUrl);
      if (discovered.ok && discovered.models.length > 0) {
        const owned = localStatus.ownership === 'app';
        const seeded = sourceStore.save({
          id: owned ? 'bundled-beholdd' : 'local-beholdd-external',
          name: owned ? 'Beholdd (native)' : 'beholdd (external local server)',
          kind: 'beholdd',
          protocol: 'openai-chat',
          apiKey: '',
          baseUrl,
          models: discovered.models.map((model) => persistedModel(model)),
          supportsStreaming: true,
          createdAt: Date.now(),
        });
        providerManager.addConfig(seeded);
      } else {
        console.error(
          '[beholdd] bundled endpoint could not be seeded:',
          discovered.error ?? 'the configured server exposes no models'
        );
      }
    }
    // The bridge is advertised from its pinned local model identity, so it can be selected while
    // its authenticated router is still stopped. Starting Antimatter never allocates GPU/model
    // memory; the model selection preflight above starts the router, and its first request loads.
    if (compatibility) {
      const existing = configuredSources.find((source) => source.id === compatibility.id);
      const saved = sourceStore.save({
        ...compatibility,
        createdAt: existing?.createdAt ?? compatibility.createdAt,
      });
      providerManager.addConfig(saved);
    } else if (removedStaleCompatibility && modelChoice.read()?.providerId === llamaVulkan.SOURCE_ID) {
      const fallback = providerManager.listProviders().find((source) => source.models[0]);
      if (fallback) {
        const next = modelChoice.save({ providerId: fallback.id, modelId: fallback.models[0].id });
        lastUsed.select(next.providerId, next.modelId);
      } else {
        modelChoice.clear();
        lastUsed.clear();
      }
    }
    // After the bundled server is up, so re-registering finished downloads reads what it now serves.
    hub.start();
    // The remote host exposes the same confirmed MCP workspace and survives window hides/reloads.
    // Seed that authority before a phone can bootstrap, then restore the opt-in listener.
    mcpStore.ensureSeeded();
    try {
      remoteHost = createRemoteWorkspaceHost();
      await remoteHost.startConfigured();
    } catch (error) {
      console.error('[remote] host initialization failed:', error);
    }
    try {
      const nodes = createNodeAgent();
      nodeAgent = nodes.agent;
      nodePeers = nodes.peers;
      // Never throws: a box that cannot bind its agent is a box that does not answer, not a box
      // that will not start.
      await nodeAgent.initialize();
    } catch (error) {
      console.error('[node-agent] initialization failed:', error);
    }
    desktopReady = true;
    desktopAvatar = new DesktopAvatar({
      dataDirectory: app.getPath('userData'), mainDirectory: __dirname,
      isMainSender: (event) => event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame,
      showMain: showMainWindow,
      voice: () => voiceSession.snapshot(),
      onVoiceCommand: (command) => {
        if (command === 'open') showMainWindow();
        if (command === 'stop') stopVoice();
        else send('voice:command', command);
      },
      onVisibilityChange: (visible) => {
        if (!visible && (!mainWindow?.isVisible() || mainWindow.isMinimized()) && voiceSession.snapshot().active) stopVoice();
      },
      activity: () => ({ running: activeThreads.list().length + taskQueue.list().filter((task) => task.state === 'running').length,
        approvals: pendingApprovals.size }),
    });
    desktopAvatar.initialize();
    detachedWindows.initialize();
    createTray();
    await createWindow();
    // Adopt whatever MCP servers are installed on first run, then bring the enabled ones up.
    watchWorkflow();
    await withMcpControl(() => mcp.connectEnabled()).catch((error) =>
      console.error('[mcp] initial connect failed:', error)
    );
    taskQueue.requeueRunning();
    agentRunner.tick();
    updates.start();
    idleCompaction.start();
    void features.initialize().catch((error) => console.error('[features] local SDK unavailable:', error));
  });
}

app.on('before-quit', () => {
  quitting = true;
  idleCompaction.dispose();
  connections.dispose(); security.dispose(); nativeProject?.dispose();
  void features.stop();
  stopVoice();
  desktopAvatar?.dispose();
  detachedWindows.dispose();
});

// If a renderer is destroyed unexpectedly, the tray still owns the desktop application and can
// create a replacement window. Ordinary window closes are intercepted above and never reach here.
app.on('window-all-closed', () => {});

/**
 * A dev reload lands while the coding agent is mid-edit: changing the app's own source (say
 * `src/main/index.ts`) rebuilds and restarts the main process — and that process is the one
 * delivering the result of the very write that triggered it. Without a hold, the kill arrives
 * after the bytes are on disk but before the tool answer crosses the MCP transport, so the
 * model hears "failed", retries into the same restart, and the edit that did land is lost.
 *
 * `will-quit` therefore waits for any in-flight edit (bounded, so a quit can never hang) while
 * the MCP server holds its own exit long enough to answer (see mcp/server.ts). The write is
 * durable and atomic underneath, so even a kill that still lands mid-write leaves the file
 * whole or untouched rather than half-written.
 */
const RELOAD_WRITE_HOLD_MS = 2_000;
let waitForWritesHeld = false;
let waitForLlamaVulkanHeld = false;
let waitForRemoteHeld = false;
let waitForLocalEnginesHeld = false;
let waitForHagHeld = false;
let waitForNativeHeld = false;

app.on('will-quit', (event) => {
  if (!waitForNativeHeld) {
    event.preventDefault(); waitForNativeHeld = true;
    void beholdd.stopOnQuit().then(() => app.quit()).catch((error) => {
      waitForNativeHeld = false;
      console.error('[beholdd] shutdown failed:', error);
      dialog.showErrorBox('Native engine could not stop', String(error));
    });
    return;
  }
  if (!waitForHagHeld) {
    event.preventDefault(); waitForHagHeld = true;
    void hag.stop(true).catch((error) => console.error('[hag] shutdown failed:', error)).finally(() => app.quit());
    return;
  }
  // One wait per quit: a second will-quit (app.quit() after the wait) proceeds straight through.
  if (editLock.busy() && !waitForWritesHeld) {
    event.preventDefault();
    waitForWritesHeld = true;
    void editLock.waitIdle(RELOAD_WRITE_HOLD_MS).finally(() => app.quit());
    return;
  }
  // Remote lives with the tray rather than a particular window. Close its listener only for the
  // application's explicit exit and let outstanding long polls receive a bounded disconnect.
  if (remoteHost?.state().running && !waitForRemoteHeld) {
    event.preventDefault();
    waitForRemoteHeld = true;
    void remoteHost.stop().finally(() => app.quit());
    return;
  }
  // A detached router owns a process group containing any model worker it launched. Hold this one
  // quit cycle for graceful group shutdown and the bounded SIGKILL fallback; hiding to the tray
  // never reaches will-quit and deliberately leaves inference running.
  if (llamaVulkan.status().ownership === 'app' && !waitForLlamaVulkanHeld) {
    event.preventDefault();
    waitForLlamaVulkanHeld = true;
    void llamaVulkan.stopOnQuit().finally(() => app.quit());
    return;
  }
  // The unit-backed loopback engines, for the same reason: a quit must not leave a 30B
  // checkpoint resident with nothing left to ask it anything.
  if (localEngines.states().some((engine) => engine.ownership === 'app') && !waitForLocalEnginesHeld) {
    event.preventDefault();
    waitForLocalEnginesHeld = true;
    void localEngines.stopOnQuit().finally(() => app.quit());
    return;
  }
  for (const [runId, { carbonKey, model, partial, flushedContentLength }] of runningTurnCarbons) {
    const unflushed = partial.slice(flushedContentLength);
    if (unflushed.trim()) {
      carbon.add(carbonKey, { kind: 'assistant', label: 'assistant — partial', body: unflushed, runId, model });
    }
    carbon.add(carbonKey, {
      kind: 'note',
      label: 'note',
      body: 'Antimatter exited while this turn was still running; the inference result is incomplete.',
      runId,
      model,
    });
  }
  runningTurnCarbons.clear();
  for (const [runId, state] of orchestratorCarbonRuns) {
    flushOrchestratorContent(runId, 'assistant — partial');
    carbon.add(state.carbonKey, {
      kind: 'note',
      label: 'orchestrator interrupted',
      body: 'Antimatter exited while this orchestrator turn was still running; the result is incomplete.',
      runId,
      model: state.model,
    });
  }
  orchestratorCarbonRuns.clear();
  tray?.destroy();
  tray = null;
  recoveryShell.shutdown();
  if (watchedWorkflow) unwatchFile(watchedWorkflow);
  agentRunner.shutdown();
  hub.shutdown();
  automaticRestartCoordinator?.stop();
  updates.stop();
  // The listener and, more importantly, any pairing material still in memory.
  void nodeAgent?.stop();
  void orchestrator.stop();
  terminal.shutdown();
  envExec.shutdown();
  nyBuildController?.abort(); nyLanguageService?.dispose(); disposeNilAnalysis();
  void envDebug.stop();
  void mcp.shutdown();
});

app.on('activate', () => {
  showMainWindow();
});
