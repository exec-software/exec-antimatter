import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { REMOTE_IPC } from '../api/remoteIpc';
import type { RemoteDesktopTurnsSnapshot } from '../api/remoteDesktopTurns';
import { NODE_AGENT_IPC } from '../api/nodeAgent';
import packageMetadata from '../../package.json';
import { createAboutInfo } from '../api/about';
import { normalizeAppearance, type AppearanceSettings } from '../api/appearance';
import { appearanceBootstrapCss } from './appearance';
import type {
  ChatRequest,
  ModelDeclaration,
  ModelMetadataPatch,
  ProviderConfig,
  PublicProviderConfig,
  WireProtocol,
} from '../api/types';
import type { ProbeResult } from '../main/probe';
import type { SourceReadiness } from '../main/sourceReadiness';
import type { DeveloperSettings } from '../main/developerSettings';
import type { VaultEntryInput, VaultStatus } from '../main/vault/store';
import type { MemoryPageState, MemoryPageTarget } from '../main/memory/page';
import type { Person } from '../main/memory/person';
import type { MemoryNote, MemoryScope, MemorySettings } from '../main/memory/store';
import type { SourceResidency } from '../main/residency';

/** Subscribes to a main-process channel and hands back an unsubscribe function. */
const subscribe = <T>(channel: string, callback: (payload: T) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const aboutInfo = createAboutInfo(packageMetadata, {
  versions: process.versions,
  platform: process.platform,
  architecture: process.arch,
});

const initialAppearance = (() => {
  try { return normalizeAppearance(ipcRenderer.sendSync('appearance:initial')); }
  catch { return normalizeAppearance(null); }
})();
try {
  webFrame.insertCSS(appearanceBootstrapCss(initialAppearance), { cssOrigin: 'author' });
} catch (error) { console.warn('[appearance] first-paint styling unavailable:', error); }

contextBridge.exposeInMainWorld('electronAPI', {
  pensieve: {
    getState: (): Promise<import('../api/pensieve').PensieveExperimentalState> => ipcRenderer.invoke('pensieve:getState'),
    setEnabled: (enabled: boolean): Promise<import('../api/pensieve').PensieveExperimentalState> => ipcRenderer.invoke('pensieve:setEnabled', enabled),
    onChanged: (callback: (state: import('../api/pensieve').PensieveExperimentalState) => void) => subscribe('pensieve:changed', callback),
  } satisfies import('../api/pensieve').PensieveExperimentalAPI,
  hag: {
    state: (): Promise<import('../api/hag').HagExperimentalState> => ipcRenderer.invoke('hag:state'),
    enable: (): Promise<import('../api/hag').HagExperimentalState> => ipcRenderer.invoke('hag:enable'),
    disable: (): Promise<import('../api/hag').HagExperimentalState> => ipcRenderer.invoke('hag:disable'),
    dismissWelcome: (): Promise<import('../api/hag').HagExperimentalState> => ipcRenderer.invoke('hag:dismissWelcome'),
    onChanged: (callback: (state: import('../api/hag').HagExperimentalState) => void) => subscribe('hag:changed', callback),
  },
  appearance: {
    initial: initialAppearance,
    get: (): Promise<AppearanceSettings> => ipcRenderer.invoke('appearance:get'),
    update: (patch: Partial<AppearanceSettings>): Promise<AppearanceSettings> => ipcRenderer.invoke('appearance:update', patch),
    onChanged: (callback: (settings: AppearanceSettings) => void) => subscribe('appearance:changed', callback),
  },
  // Being told a turn finished when the window is not in front of you. The desktop notification
  // is raised in main; the sound is played here, because only a page with a document can.
  notifications: {
    get: () => ipcRenderer.invoke('notifications:get'),
    update: (patch: Partial<import('../api/notifications').NotificationSettings>) =>
      ipcRenderer.invoke('notifications:update', patch),
    chooseSound: () => ipcRenderer.invoke('notifications:chooseSound'),
    clearSound: () => ipcRenderer.invoke('notifications:clearSound'),
    soundData: () => ipcRenderer.invoke('notifications:soundData'),
    turnFinished: (turn: import('../api/notifications').FinishedTurn) =>
      ipcRenderer.invoke('notifications:turnFinished', turn),
    onChanged: (callback: (settings: import('../api/notifications').NotificationSettings) => void) =>
      subscribe('notifications:changed', callback),
    onActivate: (callback: (event: { threadId: string }) => void) => subscribe('notifications:activate', callback),
  },
  voice: {
    get: () => ipcRenderer.invoke('voice:get'),
    configure: (settings: import('../api/voice').VoiceSettings) => ipcRenderer.invoke('voice:configure', settings),
    probe: () => ipcRenderer.invoke('voice:probe'),
    begin: (threadId: string) => ipcRenderer.invoke('voice:begin', threadId),
    end: (sessionId: string) => ipcRenderer.invoke('voice:end', sessionId),
    update: (sessionId: string, state: Partial<import('../api/voice').VoiceState>) => ipcRenderer.invoke('voice:update', sessionId, state),
    cancel: (sessionId: string, requestId: string) => ipcRenderer.invoke('voice:cancel', sessionId, requestId),
    transcribe: (sessionId: string, requestId: string, payload: { wavBase64: string; sampleRate: number }) => ipcRenderer.invoke('voice:transcribe', sessionId, requestId, payload),
    synthesize: (sessionId: string, requestId: string, text: string) => ipcRenderer.invoke('voice:synthesize', sessionId, requestId, text),
    synthesizeStream: (sessionId: string, requestId: string, text: string) => ipcRenderer.invoke('voice:synthesizeStream', sessionId, requestId, text),
    acknowledgeSpeechChunk: (sessionId: string, requestId: string, sequence: number) => ipcRenderer.invoke('voice:acknowledgeSpeechChunk', sessionId, requestId, sequence),
    onSpeechChunk: (callback: (chunk: import('../api/voice').VoiceSpeechEvent) => void) => subscribe('voice:speechChunk', callback),
    beginTranscription: (sessionId: string, requestId: string) => ipcRenderer.invoke('voice:beginTranscription', sessionId, requestId),
    appendTranscription: (sessionId: string, requestId: string, pcmBase64: string) => ipcRenderer.invoke('voice:appendTranscription', sessionId, requestId, pcmBase64),
    commitTranscription: (sessionId: string, requestId: string) => ipcRenderer.invoke('voice:commitTranscription', sessionId, requestId),
    clearTranscription: (sessionId: string, requestId: string) => ipcRenderer.invoke('voice:clearTranscription', sessionId, requestId),
    onTranscription: (callback: (event: import('../api/voice').VoiceTranscriptionEvent) => void) => subscribe('voice:transcription', callback),
    guide: (sessionId: string, runId: string, utteranceId: string, text: string) => ipcRenderer.invoke('voice:guide', sessionId, runId, utteranceId, text),
    onCommand: (callback: (command: import('../api/voice').VoiceCommand) => void) => subscribe('voice:command', callback),
    onState: (callback: (state: import('../api/voice').VoiceState) => void) => subscribe('voice:state', callback),
    onGuidance: (callback: (event: { threadId: string; runId: string; guidance: import('../api/voice').VoiceGuidance[] }) => void) => subscribe('voice:guidance', callback),
  },
  pullRequests: {
    list: (workspace: string | null) => ipcRenderer.invoke('pull-requests:list', workspace),
    read: (workspace: string | null, number: number) => ipcRenderer.invoke('pull-requests:read', workspace, number),
  },
  codeReview: {
    list: (workspace: string) => ipcRenderer.invoke('code-review:list', workspace),
    create: (workspace: string, input: import('../api/codeReview').CreateReviewInput) => ipcRenderer.invoke('code-review:create', workspace, input),
    read: (workspace: string, id: string) => ipcRenderer.invoke('code-review:read', workspace, id),
    mutate: (workspace: string, id: string, revision: number, mutation: import('../api/codeReview').ReviewMutation) =>
      ipcRenderer.invoke('code-review:mutate', workspace, id, revision, mutation),
    onChanged: (callback: (event: { workspace: string; reviewId: string }) => void) => subscribe('code-review:changed', callback),
  } satisfies import('../api/codeReview').CodeReviewAPI,
  extensions: {
    catalog: (workspace: string | null) => ipcRenderer.invoke('extensions:catalog', workspace),
    importPlugin: () => ipcRenderer.invoke('extensions:importPlugin'),
    setPluginEnabled: (id: string, enabled: boolean, fingerprint?: string) => ipcRenderer.invoke('extensions:setPluginEnabled', id, enabled, fingerprint),
    readSkill: (workspace: string | null, id: string, resource?: string) => ipcRenderer.invoke('extensions:readSkill', workspace, id, resource),
  },
  avatar: {
    get: () => ipcRenderer.invoke('avatar:get'),
    update: (patch: { enabled?: boolean; kind?: 'atom' | 'robot' | 'cat' }) => ipcRenderer.invoke('avatar:update', patch),
  },
  // Inference sources
  providers: {
    list: (): Promise<PublicProviderConfig[]> => ipcRenderer.invoke('providers:list'),
    add: (config: ProviderConfig): Promise<PublicProviderConfig> => ipcRenderer.invoke('providers:add', config),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('providers:delete', id),
    replaceCredential: (id: string, apiKey: string): Promise<PublicProviderConfig> =>
      ipcRenderer.invoke('providers:credential-replace', { id, apiKey }),
    declareModel: (sourceId: string, model: ModelDeclaration): Promise<PublicProviderConfig> =>
      ipcRenderer.invoke('providers:model-declare', sourceId, model),
    updateModel: (sourceId: string, modelId: string, patch: ModelMetadataPatch): Promise<PublicProviderConfig> =>
      ipcRenderer.invoke('providers:model-update', sourceId, modelId, patch),
    removeModel: (sourceId: string, modelId: string): Promise<PublicProviderConfig> =>
      ipcRenderer.invoke('providers:model-remove', sourceId, modelId),
    test: (id: string): Promise<ProbeResult> => ipcRenderer.invoke('providers:test', id),
    refresh: (id: string): Promise<ProbeResult> => ipcRenderer.invoke('providers:refresh', id),
    // Newly typed credentials travel to main once and are never returned through any provider DTO.
    probe: (options: { baseUrl: string; apiKey?: string; protocol?: WireProtocol }) =>
      ipcRenderer.invoke('providers:probe', options),
    storeInfo: () => ipcRenderer.invoke('providers:storeInfo'),
    /**
     * Whether this source can be sent a turn yet. Polled while a conversation is open, so that a
     * striped host still reading weights off two peers holds the composer shut instead of taking
     * the request, reaching for a peer that is not there, and aborting the whole load.
     */
    readiness: (id: string): Promise<SourceReadiness> => ipcRenderer.invoke('providers:readiness', id),
  },

  // The model chat opens on
  model: {
    get: (): Promise<{ providerId: string; modelId: string; workloadId?: string } | null> => ipcRenderer.invoke('model:get'),
    // `workloadId` launches one of the model's workloads; omitted uses the model's default.
    set: (providerId: string, modelId: string, workloadId?: string): Promise<{ providerId: string; modelId: string; workloadId?: string }> =>
      ipcRenderer.invoke('model:set', providerId, modelId, workloadId),
  },

  // What local engines are currently holding in memory, and freeing it.
  residency: {
    list: (): Promise<SourceResidency[]> => ipcRenderer.invoke('residency:list'),
    unload: (sourceId: string, modelId: string): Promise<void> =>
      ipcRenderer.invoke('residency:unload', sourceId, modelId),
  },

  // How a turn is run, rather than which model runs it. Main normalizes whatever is sent.
  developer: {
    get: (): Promise<DeveloperSettings> => ipcRenderer.invoke('developer:get'),
    set: (next: DeveloperSettings): Promise<DeveloperSettings> => ipcRenderer.invoke('developer:set', next),
  },
  /**
   * The Vault. `save` is the only call that carries a secret, and it carries it inward: no call
   * here returns one, so the Settings page can list and manage credentials it cannot read.
   */
  vault: {
    status: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:status'),
    setEnabled: (enabled: boolean): Promise<VaultStatus> => ipcRenderer.invoke('vault:set-enabled', enabled),
    save: (entry: VaultEntryInput): Promise<VaultStatus> => ipcRenderer.invoke('vault:save', entry),
    remove: (tag: string): Promise<VaultStatus> => ipcRenderer.invoke('vault:remove', tag),
  },
  workloads: {
    list: () => ipcRenderer.invoke('workloads:list'),
    download: (id: string) => ipcRenderer.invoke('workloads:download', id),
    configure: (id: string, peers: string[]) => ipcRenderer.invoke('workloads:configure', id, peers),
  },
  setup: {
    get: () => ipcRenderer.invoke('setup:get'),
    updateAssistant: (patch: Partial<import('../api/setup').AssistantSettings>) => ipcRenderer.invoke('setup:assistant', patch),
    complete: () => ipcRenderer.invoke('setup:complete'),
    onChanged: (callback: (state: import('../api/setup').SetupState) => void) => subscribe('setup:changed', callback),
  },

  // Notes kept between conversations, and a project's own instructions. A target names another
  // project with notes to look at; without one, the page shows the tools' own workspace.
  memory: {
    state: (target?: MemoryPageTarget): Promise<MemoryPageState> => ipcRenderer.invoke('memory:state', target ?? {}),
    setSettings: (patch: Partial<MemorySettings>): Promise<MemorySettings> => ipcRenderer.invoke('memory:settings', patch),
    save: (target: MemoryPageTarget, scope: MemoryScope, note: { id?: string; name: string; description: string; content: string }): Promise<MemoryNote> =>
      ipcRenderer.invoke('memory:save', target, scope, note),
    remove: (target: MemoryPageTarget, scope: MemoryScope, id: string): Promise<boolean> =>
      ipcRenderer.invoke('memory:remove', target, scope, id),
    openFolder: (target: MemoryPageTarget, scope: MemoryScope): Promise<void> =>
      ipcRenderer.invoke('memory:open-folder', target, scope),
    openInstructions: (target: MemoryPageTarget, path: string): Promise<void> =>
      ipcRenderer.invoke('memory:open-instructions', target, path),
  },

  // Who Antimatter is talking to: a name to use, and whatever they want it to know about them.
  user: {
    get: (): Promise<Person> => ipcRenderer.invoke('user:get'),
    set: (patch: Partial<Person>): Promise<Person> => ipcRenderer.invoke('user:set', patch),
  },

  // Chat
  chat: {
    complete: (request: ChatRequest): Promise<string> => ipcRenderer.invoke('chat:complete', request),
    startStream: (request: ChatRequest): Promise<void> => ipcRenderer.invoke('chat:stream', request),
    startAvatarStream: (request: ChatRequest): Promise<void> => ipcRenderer.invoke('chat:stream-avatar', request),
    remoteTurns: (): Promise<RemoteDesktopTurnsSnapshot> => ipcRenderer.invoke('chat:remote-turns-get'),
    /** Stops a turn in flight. Returns false when it had already finished. */
    cancel: (runId: string): Promise<boolean> => ipcRenderer.invoke('chat:cancel', runId),
    /** Queues a note for the running turn. `now` cuts the current generation short. */
    steer: (runId: string, text: string, now = false): Promise<boolean> =>
      ipcRenderer.invoke('chat:steer', runId, text, now),
    unsteer: (runId: string): Promise<boolean> => ipcRenderer.invoke('chat:steer-cancel', runId),
    /**
     * Changes the permissions of a turn already in flight, so the next tool call it makes is
     * gated on the new mode. Returns false when the turn had already finished.
     */
    setAccess: (runId: string, mode: 'read' | 'ask' | 'full'): Promise<boolean> =>
      ipcRenderer.invoke('chat:access', runId, mode),
  },

  // Tool calls the model makes during a chat
  tools: {
    approve: (approvalId: string, approved: boolean): Promise<boolean> =>
      ipcRenderer.invoke('tools:approve', approvalId, approved),
    /**
     * Answers a question the model asked mid-turn. Resolves false when nothing is waiting under
     * that id any more — the turn ended, or another window answered first — which is the card's
     * cue to say so rather than look as though it worked.
     */
    answer: (askId: string, outcome: unknown): Promise<boolean> =>
      ipcRenderer.invoke('ask:answer', askId, outcome),
  },

  // MCP tool servers
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    connect: (id: string) => ipcRenderer.invoke('mcp:connect', id),
    disconnect: (id: string) => ipcRenderer.invoke('mcp:disconnect', id),
    connectEnabled: () => ipcRenderer.invoke('mcp:connectEnabled'),
    refresh: (id: string) => ipcRenderer.invoke('mcp:refresh', id),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:setEnabled', id, enabled),
    setToolEnabled: (id: string, toolName: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:setToolEnabled', id, toolName, enabled),
    call: (id: string, toolName: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke('mcp:call', id, toolName, args),
    workspace: () => ipcRenderer.invoke('mcp:workspace'),
    /** The directory in use, and whether anyone chose it. Writes are refused until they have. */
    workspaceState: (threadId?: string) => ipcRenderer.invoke('mcp:workspaceState', threadId),
    confirmWorkspace: (threadId?: string, expectedPath?: string) => ipcRenderer.invoke('mcp:confirmWorkspace', threadId, expectedPath),
    setWorkspace: (directory: string | null, confirmed = true) =>
      ipcRenderer.invoke('mcp:setWorkspace', directory, confirmed),
    storeInfo: () => ipcRenderer.invoke('mcp:storeInfo'),
  },

  // Symphony orchestrator
  orchestrator: {
    start: () => ipcRenderer.invoke('orchestrator:start'),
    stop: () => ipcRenderer.invoke('orchestrator:stop'),
    /** Runs one poll tick immediately instead of waiting for the cadence. */
    tick: () => ipcRenderer.invoke('orchestrator:tick'),
    snapshot: () => ipcRenderer.invoke('orchestrator:snapshot'),
    /** Reads WORKFLOW.md and reports why dispatch would be blocked, without starting anything. */
    workflow: () => ipcRenderer.invoke('orchestrator:workflow'),
  },

  // Snitch: projects, issues and requests, plus the one-click fix pipeline
  snitch: {
    config: () => ipcRenderer.invoke('snitch:config'),
    setRoot: (root: string | null) => ipcRenderer.invoke('snitch:setRoot', root),
    projects: () => ipcRenderer.invoke('snitch:projects'),
    project: (name: string) => ipcRenderer.invoke('snitch:project', name),
    createProject: (name: string, repo?: string | null) => ipcRenderer.invoke('snitch:createProject', name, repo),
    deleteProject: (name: string) => ipcRenderer.invoke('snitch:deleteProject', name),
    updateProject: (name: string, patch: unknown) => ipcRenderer.invoke('snitch:updateProject', name, patch),
    addItem: (name: string, kind: string, draft: unknown) => ipcRenderer.invoke('snitch:addItem', name, kind, draft),
    updateItem: (name: string, item: unknown) => ipcRenderer.invoke('snitch:updateItem', name, item),
    deleteItems: (name: string, itemIds: string[]) => ipcRenderer.invoke('snitch:deleteItems', name, itemIds),
    setStatus: (name: string, itemIds: string[], status: string) =>
      ipcRenderer.invoke('snitch:setStatus', name, itemIds, status),
    setRelease: (name: string, itemIds: string[], releaseId: string | null) =>
      ipcRenderer.invoke('snitch:setRelease', name, itemIds, releaseId),
    addRelease: (name: string, releaseName: string) => ipcRenderer.invoke('snitch:addRelease', name, releaseName),
    updateRelease: (name: string, release: unknown) => ipcRenderer.invoke('snitch:updateRelease', name, release),
    deleteRelease: (name: string, releaseId: string) => ipcRenderer.invoke('snitch:deleteRelease', name, releaseId),
    /** Queues the item for an unattended fix, then a QA pass. */
    fix: (name: string, itemId: string) => ipcRenderer.invoke('snitch:fix', name, itemId),
    cancel: (name: string, itemId: string) => ipcRenderer.invoke('snitch:cancel', name, itemId),
    acknowledge: (name: string, itemId: string) => ipcRenderer.invoke('snitch:acknowledge', name, itemId),
    pipeline: () => ipcRenderer.invoke('snitch:pipeline'),
  },

  // Conversations, kept between runs: threads, selection, pins and unsent drafts
  chatImports: {
    choose: (options: Parameters<import('../api/chatImports').ChatImportsAPI['choose']>[0]) => ipcRenderer.invoke('chat-import:choose', options),
    commit: (options: Parameters<import('../api/chatImports').ChatImportsAPI['commit']>[0]) => ipcRenderer.invoke('chat-import:commit', options),
    discard: (batchId: string) => ipcRenderer.invoke('chat-import:discard', batchId),
  },
  conversations: {
    load: () => ipcRenderer.invoke('conversations:load'),
    removeTranscript: (threadId: string) => ipcRenderer.invoke('conversations:removeTranscript', threadId),
    save: (next: unknown) => ipcRenderer.invoke('conversations:save', next),
    info: () => ipcRenderer.invoke('conversations:info'),
  },
  chatCoordination: {
    state: (threadId: string) => ipcRenderer.invoke('chat-coordination:state', threadId),
    connect: (threadId: string, peerId: string) => ipcRenderer.invoke('chat-coordination:connect', threadId, peerId),
    disconnect: (threadId: string, peerId: string) => ipcRenderer.invoke('chat-coordination:disconnect', threadId, peerId),
    dismiss: (threadId: string, messageId: string) => ipcRenderer.invoke('chat-coordination:dismiss', threadId, messageId),
    onChanged: (callback: (event: { threadIds: string[] }) => void) => subscribe('chat-coordination:changed', callback),
  },
  botChat: {
    state: () => ipcRenderer.invoke('bot-chat:state'),
    configure: (settings: { enabled: boolean }) => ipcRenderer.invoke('bot-chat:configure', settings),
    createChannel: (input: import('../api/botChat').BotChatChannelInput) => ipcRenderer.invoke('bot-chat:create-channel', input),
    updateChannel: (channelId: string, patch: import('../api/botChat').BotChatChannelPatch) => ipcRenderer.invoke('bot-chat:update-channel', channelId, patch),
    read: (channelId: string, options?: import('../api/botChat').BotChatReadOptions) => ipcRenderer.invoke('bot-chat:read', channelId, options),
    post: (channelId: string, input: import('../api/botChat').BotChatHumanPost) => ipcRenderer.invoke('bot-chat:post-human', channelId, input),
    moderate: (channelId: string, messageId: string, reason?: string) => ipcRenderer.invoke('bot-chat:moderate', channelId, messageId, reason),
    onChanged: (callback: (event: import('../api/botChat').BotChatChange) => void) => subscribe('bot-chat:changed', callback),
  },
  modelRuntimeProfiles: {
    state: (sourceId: string, modelId: string) => ipcRenderer.invoke('model-runtime-profiles:state', sourceId, modelId),
    capture: (sourceId: string, modelId: string) => ipcRenderer.invoke('model-runtime-profiles:capture', sourceId, modelId),
    copy: (sourceId: string, modelId: string, profileId: string) => ipcRenderer.invoke('model-runtime-profiles:copy', sourceId, modelId, profileId),
    remove: (sourceId: string, modelId: string, profileId: string) => ipcRenderer.invoke('model-runtime-profiles:remove', sourceId, modelId, profileId),
    update: (sourceId: string, modelId: string, profileId: string, patch: import('../api/modelRuntimeProfiles').ModelRuntimeProfilePatch) => ipcRenderer.invoke('model-runtime-profiles:update', sourceId, modelId, profileId, patch),
    apply: (sourceId: string, modelId: string, profileId: string) => ipcRenderer.invoke('model-runtime-profiles:apply', sourceId, modelId, profileId),
    onChanged: (callback: (event: { sourceId: string; modelId: string }) => void) => subscribe('model-runtime-profiles:changed', callback),
  },

  // Remote host controls. Pairing text stays in main. The renderer receives opaque QR pixels, or
  // sends it straight to the clipboard after an explicit Copy action.
  remote: {
    state: () => ipcRenderer.invoke(REMOTE_IPC.state),
    configure: (patch: { enabled?: boolean; address?: string | null; port?: number; keepAwake?: boolean }) =>
      ipcRenderer.invoke(REMOTE_IPC.configure, patch),
    createPairingOffer: () => ipcRenderer.invoke(REMOTE_IPC.createPairingOffer),
    copyPairingCode: (offerId: string) => ipcRenderer.invoke(REMOTE_IPC.copyPairingCode, offerId),
    cancelPairingOffer: (offerId: string) => ipcRenderer.invoke(REMOTE_IPC.cancelPairingOffer, offerId),
    revokeDevice: (deviceId: string) => ipcRenderer.invoke(REMOTE_IPC.revokeDevice, deviceId),
  },

  // Carbons: the on-disk record of what each turn sent and did
  carbon: {
    list: (limit?: number) => ipcRenderer.invoke('carbon:list', limit),
    read: (path: string) => ipcRenderer.invoke('carbon:read', path),
    location: () => ipcRenderer.invoke('carbon:location'),
    forThread: (threadId: string) => ipcRenderer.invoke('carbon:forThread', threadId),
    /** Saves the whole conversation, tool calls included, as Markdown. */
    export: (threadId: string, suggestedName: string) =>
      ipcRenderer.invoke('carbon:export', threadId, suggestedName),
  },

  // Agents, and the queue of work they are given
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    /** Tells the runner which source chat is using, for agents that pin none of their own. */
    useSource: (providerId: string, model: string) => ipcRenderer.invoke('agents:useSource', providerId, model),
    save: (definition: unknown) => ipcRenderer.invoke('agents:save', definition),
    remove: (id: string) => ipcRenderer.invoke('agents:remove', id),
    location: () => ipcRenderer.invoke('agents:location'),
    tasks: () => ipcRenderer.invoke('agents:tasks'),
    counts: () => ipcRenderer.invoke('agents:counts'),
    /** Who is working, whether anything is running, and the totals. One call per refresh. */
    activity: () => ipcRenderer.invoke('agents:activity'),
    dispatch: (task: unknown) => ipcRenderer.invoke('agents:dispatch', task),
    /** Lets the main model choose the agent, then queues the work for it. */
    route: (text: string, workspace?: string | null) => ipcRenderer.invoke('agents:route', text, workspace),
    cancelTask: (taskId: string) => ipcRenderer.invoke('agents:cancelTask', taskId),
    setSchedulePaused: (taskId: string, paused: boolean) => ipcRenderer.invoke('agents:setSchedulePaused', taskId, paused),
    sendMessage: (taskId: string, message: string, interrupt?: boolean) => ipcRenderer.invoke('agents:sendMessage', taskId, message, interrupt),
    removeTask: (taskId: string) => ipcRenderer.invoke('agents:removeTask', taskId),
    /** The carbon behind a run, which is how you open a session after the fact. */
    session: (taskId: string) => ipcRenderer.invoke('agents:session', taskId),
  },

  // Files a conversation wrote, opened from the list beside the transcript.
  outputs: {
    open: (path: string): Promise<'opened' | 'revealed'> => ipcRenderer.invoke('outputs:open', path),
  },

  /**
   * Preview: what the conversation is showing.
   *
   * Images are fetched by path when something is about to draw one, never carried in the
   * transcript. Pages live in a view the main process owns and lays over the pane, so the
   * renderer sends it the rectangle it ended up with and drives it from there.
   */
  preview: {
    image: (
      path: string,
      workspace: string | undefined,
      inline = false
    ): Promise<{ dataUrl: string; width: number; height: number; bytes: number }> =>
      ipcRenderer.invoke('preview:image', { path, workspace, inline }),
    openPage: (url: string) => ipcRenderer.invoke('preview:page:open', url),
    /** Fire-and-forget: this is sent on every resize and must not queue a reply each time. */
    bounds: (rect: { x: number; y: number; width: number; height: number } | null) =>
      ipcRenderer.send('preview:page:bounds', rect),
    back: () => ipcRenderer.invoke('preview:page:back'),
    forward: () => ipcRenderer.invoke('preview:page:forward'),
    reload: () => ipcRenderer.invoke('preview:page:reload'),
    closePage: () => ipcRenderer.invoke('preview:page:close'),
  },

  // The coding environment: files, running, and the debugger
  environment: {
    open: (directory: string | null, threadId?: string) => ipcRenderer.invoke('env:open', directory, threadId),
    list: (directory: string) => ipcRenderer.invoke('env:list', directory),
    read: (path: string) => ipcRenderer.invoke('env:read', path),
    write: (path: string, text: string) => ipcRenderer.invoke('env:write', path, text),
    create: (path: string, kind: 'file' | 'directory') => ipcRenderer.invoke('env:create', path, kind),
    rename: (from: string, to: string) => ipcRenderer.invoke('env:rename', from, to),
    remove: (path: string) => ipcRenderer.invoke('env:delete', path),
    /** False when the file changed underneath us, so saving can ask before overwriting. */
    unchanged: (path: string, modified: number) => ipcRenderer.invoke('env:unchanged', path, modified),

    /** A guess at how to run this file, shown in the toolbar where it can be corrected. */
    suggestCommand: (path: string) => ipcRenderer.invoke('env:suggestCommand', path),
    run: (commandLine: string, label: string) => ipcRenderer.invoke('env:run', commandLine, label),
    runState: () => ipcRenderer.invoke('env:runState'),
    input: (data: string) => ipcRenderer.invoke('env:input', data),
    resize: (cols: number, rows: number) => ipcRenderer.invoke('env:resize', cols, rows),
    stop: () => ipcRenderer.invoke('env:stop'),

    debuggable: (path: string) => ipcRenderer.invoke('env:debuggable', path),
    debugStart: (path: string, breakpoints: unknown[]) => ipcRenderer.invoke('env:debugStart', path, breakpoints),
    debugState: () => ipcRenderer.invoke('env:debugState'),
    debugBreakpoints: (breakpoints: unknown[]) => ipcRenderer.invoke('env:debugBreakpoints', breakpoints),
    resume: () => ipcRenderer.invoke('env:debugResume'),
    pause: () => ipcRenderer.invoke('env:debugPause'),
    selectFrame: (frameId: string) => ipcRenderer.invoke('env:debugSelectFrame', frameId),
    stepOver: () => ipcRenderer.invoke('env:debugStepOver'),
    stepInto: () => ipcRenderer.invoke('env:debugStepInto'),
    stepOut: () => ipcRenderer.invoke('env:debugStepOut'),
    evaluate: (expression: string, frameId?: string) => ipcRenderer.invoke('env:debugEval', expression, frameId),
    debugStop: () => ipcRenderer.invoke('env:debugStop'),
  },

  nilProject: {
    describe: (sourcePath?: string) => ipcRenderer.invoke('nil-project:describe', sourcePath),
    create: (name: string, language: import('../api/nilProject').NilProjectLanguage) => ipcRenderer.invoke('nil-project:create', name, language),
    check: (sourcePath?: string) => ipcRenderer.invoke('nil-project:check', sourcePath),
    build: (sourcePath?: string, target?: import('../api/nilProject').NilProjectTarget) => ipcRenderer.invoke('nil-project:build', sourcePath, target),
    run: (sourcePath?: string, target?: import('../api/nilProject').NilProjectTarget) => ipcRenderer.invoke('nil-project:run', sourcePath, target),
    debug: (sourcePath: string | undefined, breakpoints: unknown[]) => ipcRenderer.invoke('nil-project:debug', sourcePath, breakpoints),
  },

  // Shared NIL Framework language services (legacy API name retained).
  ny: {
    status: () => ipcRenderer.invoke('ny:status'),
    restart: () => ipcRenderer.invoke('ny:restart'),
    chooseSdk: () => ipcRenderer.invoke('ny:chooseSdk'),
    completion: (document: import('../api/ny').NyDocument) => ipcRenderer.invoke('ny:completion', document),
    hover: (document: import('../api/ny').NyDocument) => ipcRenderer.invoke('ny:hover', document),
    symbols: (document: import('../api/ny').NyDocument) => ipcRenderer.invoke('ny:symbols', document),
    inspectNil: (path: string) => ipcRenderer.invoke('ny:inspectNil', path),
    definition: (document: import('../api/ny').NyDocument) => ipcRenderer.invoke('ny:definition', document),
    diagnostics: (document: import('../api/ny').NyDocument) => ipcRenderer.invoke('ny:diagnostics', document),
    check: (path: string) => ipcRenderer.invoke('ny:check', path),
    build: (path: string) => ipcRenderer.invoke('ny:build', path),
    run: (path: string) => ipcRenderer.invoke('ny:run', path),
    cancel: () => ipcRenderer.invoke('ny:cancel'),
    createProject: (name: string) => ipcRenderer.invoke('ny:createProject', name),
  },

  // ADR 0001: the per-model half of the old `profiles:` prefix. `resolve` and
  // `setDefaultSettings` act on the default workload, which is what a single override was.
  modelWorkloads: {
    resolve: (providerId: string, modelId: string) => ipcRenderer.invoke('model-workloads:resolve', providerId, modelId),
    setDefaultSettings: (providerId: string, modelId: string, patch: unknown) =>
      ipcRenderer.invoke('model-workloads:setDefaultSettings', providerId, modelId, patch),
    storeInfo: () => ipcRenderer.invoke('model-workloads:storeInfo'),
    list: (providerId: string, modelId: string) => ipcRenderer.invoke('model-workloads:list', providerId, modelId),
    create: (providerId: string, modelId: string, input: unknown) =>
      ipcRenderer.invoke('model-workloads:create', providerId, modelId, input),
    update: (providerId: string, modelId: string, id: string, patch: unknown) =>
      ipcRenderer.invoke('model-workloads:update', providerId, modelId, id, patch),
    remove: (providerId: string, modelId: string, id: string) =>
      ipcRenderer.invoke('model-workloads:remove', providerId, modelId, id),
    setDefault: (providerId: string, modelId: string, id: string) =>
      ipcRenderer.invoke('model-workloads:setDefault', providerId, modelId, id),
  },

  // ADR 0001 stage 4: the boxes a workload may declare, read from the recipes that name them.
  nodes: {
    list: () => ipcRenderer.invoke('nodes:list'),
    storeInfo: () => ipcRenderer.invoke('nodes:storeInfo'),
  },

  // ADR 0001 stage 5: this box answering as an inference node, and the boxes it has paired with.
  // A pairing code carries a one-time bearer, so it is written and parsed in main; the renderer
  // only ever asks for it to be copied.
  nodeAgent: {
    status: () => ipcRenderer.invoke(NODE_AGENT_IPC.status),
    configure: (patch: { enabled?: boolean; address?: string | null; port?: number }) =>
      ipcRenderer.invoke(NODE_AGENT_IPC.configure, patch),
    createPairingOffer: () => ipcRenderer.invoke(NODE_AGENT_IPC.createPairingOffer),
    copyPairingCode: (offerId: string) => ipcRenderer.invoke(NODE_AGENT_IPC.copyPairingCode, offerId),
    cancelPairingOffer: (offerId: string) => ipcRenderer.invoke(NODE_AGENT_IPC.cancelPairingOffer, offerId),
    revokeController: (controllerId: string) => ipcRenderer.invoke(NODE_AGENT_IPC.revokeController, controllerId),
    listPaired: () => ipcRenderer.invoke(NODE_AGENT_IPC.listPaired),
    pair: (code: string) => ipcRenderer.invoke(NODE_AGENT_IPC.pair, code),
    forget: (key: string) => ipcRenderer.invoke(NODE_AGENT_IPC.forget, key),
  },

  // Terminal sessions. The pty lives in the main process; this is just the wire to it.
  terminal: {
    openExternal: (directory: string) => ipcRenderer.invoke('terminal:openExternal', directory),
    create: (options: { cwd?: string | null; cols?: number; rows?: number }) =>
      ipcRenderer.invoke('terminal:create', options),
    list: () => ipcRenderer.invoke('terminal:list'),
    /** Everything the session has printed, for a panel attaching to a shell already running. */
    history: (id: string) => ipcRenderer.invoke('terminal:history', id),
    snapshot: (id: string) => ipcRenderer.invoke('terminal:snapshot', id),
    write: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  },

  // System vitals for the monitor panel. Polled, so a closed panel costs nothing.
  vitals: {
    sample: () => ipcRenderer.invoke('vitals:sample'),
  },

  // Where a loaded checkpoint is resident, for the inference debug overlay. Polled on the same
  // terms: an overlay that is closed stops asking.
  deviceMemory: {
    sample: () => ipcRenderer.invoke('device-memory:sample'),
  },

  // Installed font families, for the Appearance panel's pickers.
  systemFonts: {
    list: () => ipcRenderer.invoke('fonts:list'),
  },

  // Model Hub: Hugging Face search, downloads, and the token. The token itself never comes back.
  hub: {
    state: () => ipcRenderer.invoke('hub:state'),
    search: (query: unknown) => ipcRenderer.invoke('hub:search', query),
    model: (repoId: string) => ipcRenderer.invoke('hub:model', repoId),
    downloads: () => ipcRenderer.invoke('hub:downloads'),
    download: (input: { repoId: string; revision: string; variantKey: string }) => ipcRenderer.invoke('hub:download', input),
    pause: (id: string) => ipcRenderer.invoke('hub:pause', id),
    resume: (id: string) => ipcRenderer.invoke('hub:resume', id),
    cancel: (id: string) => ipcRenderer.invoke('hub:cancel', id),
    remove: (id: string, deleteFiles: boolean) => ipcRenderer.invoke('hub:remove', id, deleteFiles),
    reregister: (id: string) => ipcRenderer.invoke('hub:reregister', id),
    setToken: (token: string | null) => ipcRenderer.invoke('hub:setToken', token),
    importToken: () => ipcRenderer.invoke('hub:importToken'),
    whoami: () => ipcRenderer.invoke('hub:whoami'),
    setRoot: (path: string | null) => ipcRenderer.invoke('hub:setRoot', path),
  },

  // Updates from the configured release feed
  updates: {
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    apply: () => ipcRenderer.invoke('updates:apply'),
    restart: () => ipcRenderer.invoke('updates:restart'),
    /** Completes main's restart handshake after the renderer has saved durable state. */
    restartPrepared: (requestId: string, blockers: string[]) =>
      ipcRenderer.invoke('updates:restartPrepared', requestId, blockers),
    setAutomatic: (automatic: boolean) => ipcRenderer.invoke('updates:setAutomatic', automatic),
    setFeed: (path: string | null) => ipcRenderer.invoke('updates:setFeed', path),
  },

  // Local beholdd server
  beholdd: {
    info: () => ipcRenderer.invoke('beholdd:info'),
    status: () => ipcRenderer.invoke('beholdd:status'),
    start: (options: { configPath?: string; host?: string; port?: number }) =>
      ipcRenderer.invoke('beholdd:start', options),
    restart: (options: { configPath?: string; host?: string; port?: number }) =>
      ipcRenderer.invoke('beholdd:restart', options),
    stop: () => ipcRenderer.invoke('beholdd:stop'),
  },

  // The app-owned inference servers as one list, so a wedged engine can be recovered without
  // guessing which model selection happens to own the port.
  inferenceServers: {
    list: () => ipcRenderer.invoke('inference-servers:list'),
    start: (id: import('../api/inferenceServers').InferenceServerId) =>
      ipcRenderer.invoke('inference-servers:start', id),
    stop: (id: import('../api/inferenceServers').InferenceServerId, options?: { force?: boolean }) =>
      ipcRenderer.invoke('inference-servers:stop', id, options),
    restart: (id: import('../api/inferenceServers').InferenceServerId, options?: { force?: boolean }) =>
      ipcRenderer.invoke('inference-servers:restart', id, options),
  },

  // Workspace
  workspace: {
    chooseDirectory: (threadId?: string): Promise<string | null> => ipcRenderer.invoke('workspace:choose-directory', threadId),
    setDirectory: (threadId: string, directory: string): Promise<string> => ipcRenderer.invoke('workspace:set-directory', threadId, directory),
    chooseFile: (options?: { title?: string }): Promise<string | null> =>
      ipcRenderer.invoke('workspace:choose-file', options),
  },

  // The recovery shell: the fallback page the window becomes when the normal UI is down. Its
  // state machine lives in the main process and is driven one line at a time from here.
  recovery: {
    state: () => ipcRenderer.invoke('recovery:state'),
    send: (line: string): Promise<{ ok: boolean; content?: string }> => ipcRenderer.invoke('recovery:send', line),
    approve: (approvalId: string, allowed: boolean): Promise<boolean> =>
      ipcRenderer.invoke('recovery:approve', approvalId, allowed),
    cancel: (): Promise<boolean> => ipcRenderer.invoke('recovery:cancel'),
  },

  // About window
  about: {
    open: (): Promise<boolean> => ipcRenderer.invoke('about:open'),
    close: (): Promise<boolean> => ipcRenderer.invoke('about:close'),
    info: aboutInfo,
  },

  // Listen for stream data coming from main process
  onStreamData: (callback: (data: { id: string; content: string }) => void) =>
    subscribe('chat:stream-data', callback),
  onInferenceMetrics: (callback: (data: { id: string; round: number; providerId: string; model: string; metrics: import('../api/types').InferenceMetrics }) => void) =>
    subscribe('chat:metrics', callback),

  // The model's thinking, which is not its answer and does not belong in the transcript. On a
  // reasoning model this is most of the turn, and the only evidence for minutes that it is working.
  onReasoning: (callback: (data: { id: string; content: string }) => void) =>
    subscribe('chat:reasoning', callback),

  // Which carbon a conversation is being written to.
  onChatCarbon: (callback: (event: { threadId: string; id: string; path: string }) => void) =>
    subscribe('chat:carbon', callback),

  onRemoteTurnsChanged: (callback: (snapshot: RemoteDesktopTurnsSnapshot) => void) =>
    subscribe('chat:remote-turns-changed', callback),

  // A queued steer was taken up by the model.
  onChatSteered: (callback: (event: { id: string; note: string; at: number }) => void) =>
    subscribe('chat:steered', callback),

  // The source is alive but has produced nothing yet — a keepalive, or a frame with no content.
  // A note says why, when the source was specific about it: a cold model still reading its weights.
  onChatAlive: (
    callback: (beat: { id: string; at: number; note?: { label: string; model?: string; seconds?: number } }) => void
  ) => subscribe('chat:alive', callback),

  // The turn is holding for the agents it started, or has stopped holding.
  onChatWaiting: (callback: (event: { id: string; waiting: boolean; at: number }) => void) =>
    subscribe('chat:waiting', callback),

  // Listen for tool activity and permission prompts
  onToolActivity: (callback: (activity: unknown) => void) => subscribe('tools:activity', callback),
  /** A tool has something to show: an image it made, or a page it opened. */
  onPreview: (callback: (item: unknown) => void) => subscribe('preview:show', callback),
  /** Where the previewed page has got to: loading, loaded, or failed. */
  onPreviewPage: (callback: (state: unknown) => void) => subscribe('preview:page', callback),
  /** The native page was destroyed before the main window moved into the tray. */
  onPreviewDismissed: (callback: () => void) => subscribe('preview:dismissed', callback),
  onToolApproval: (callback: (request: unknown) => void) => subscribe('tools:approval-request', callback),
  /**
   * The model has asked the person something and is waiting.
   *
   * Only the nudge. The question itself arrives as ordinary tool activity, which is what draws
   * the card and what rebuilds it after a reload; this event exists so a notice can appear when
   * the answer is wanted and the conversation is not what the person is looking at.
   */
  onQuestionWaiting: (callback: (question: unknown) => void) => subscribe('ask:waiting', callback),
  /** That question is no longer waiting — answered, declined, or its turn ended. */
  onQuestionSettled: (callback: (event: unknown) => void) => subscribe('ask:settled', callback),

  // Listen for orchestrator progress. Agent runs are unattended, so these are the only
  // window into what a session is doing while it does it.
  onOrchestratorActivity: (callback: (activity: unknown) => void) => subscribe('orchestrator:activity', callback),
  onOrchestratorContent: (callback: (chunk: unknown) => void) => subscribe('orchestrator:content', callback),
  onOrchestratorLog: (callback: (entry: unknown) => void) => subscribe('orchestrator:log', callback),

  // Snitch items are edited by people in the UI and by agents in the workspace, so the panel
  // reloads on this rather than trusting whatever it last rendered.
  onSnitchChanged: (callback: (change: { reason: string; at: number }) => void) =>
    subscribe('snitch:changed', callback),

  // What the window looked like for a turn: how full it was, and what had to be folded away.
  onChatNotice: (callback: (notice: import('../api/toasts').ToastInput & { id: string; threadId: string }) => void) => subscribe('chat:notice', callback),
  onChatContext: (callback: (report: unknown) => void) => subscribe('chat:context', callback),
  onMemoryChanged: (callback: (change: { at: number }) => void) => subscribe('memory:changed', callback),

  // The queue moved: something was claimed, finished, or fell due.
  routingEnabled: (): Promise<boolean> => ipcRenderer.invoke('routing:enabled'),
  setRoutingEnabled: (value: boolean): Promise<boolean> => ipcRenderer.invoke('routing:set', value),
  listProfiles: () => ipcRenderer.invoke('orchestration:list'),
  selectProfile: (id: string | null) => ipcRenderer.invoke('orchestration:select', id),
  profilesLocation: () => ipcRenderer.invoke('orchestration:location'),
  renameProfile: (id: string, name: string) => ipcRenderer.invoke('orchestration:rename', id, name),
  setProfileMode: (id: string, mode: 'local' | 'distributed' | 'provider' | null) => ipcRenderer.invoke('orchestration:setMode', id, mode),
  saveProfile: (input: unknown) => ipcRenderer.invoke('orchestration:save', input),
  removeProfile: (id: string) => ipcRenderer.invoke('orchestration:remove', id),
  onAgentsChanged: (callback: (change: { at: number }) => void) => subscribe('agents:changed', callback),
  onAgentActivity: (callback: (activity: unknown) => void) => subscribe('agents:activity', callback),
  onAgentContent: (callback: (chunk: { taskId: string; content: string; sessionId?: string; revision?: number; contentOffset?: number }) => void) =>
    subscribe('agents:content', callback),

  // Console output from a run or a debug session, and how it ended.
  onEnvironmentOutput: (callback: (chunk: { id?: string; data: string; source: 'run' | 'debug' }) => void) =>
    subscribe('env:output', callback),
  onEnvironmentExit: (callback: (exit: { id?: string; code: number; signal?: number; source: 'run' | 'debug' }) => void) =>
    subscribe('env:exit', callback),
  onDebugState: (callback: (state: unknown) => void) => subscribe('env:debug-state', callback),
  /** The workspace moved because a directory was opened in the environment. */
  onWorkspaceChanged: (callback: (change: { workspace: string; confirmed: boolean }) => void) =>
    subscribe('mcp:workspace-changed', callback),
  onRemoteChanged: (callback: (state: unknown) => void) => subscribe('remote:changed', callback),
  /** Fires when another box pairs with this one, or its listener changes state. */
  onNodeAgentChanged: (callback: (status: unknown) => void) => subscribe('node-agent:state', callback),
  onRemotePairingInvalidated: (callback: (event: { offerId: string }) => void) =>
    subscribe('remote:pairing-invalidated', callback),
  onConversationsChanged: (callback: (event: unknown) => void) => subscribe('conversations:changed', callback),

  // The updater's state, whenever it changes.
  onUpdateState: (callback: (state: unknown) => void) => subscribe('updates:state', callback),
  /** Main asks immediately before an automatic restart; App replies through restartPrepared. */
  onUpdateRestartRequested: (callback: (request: { requestId: string; version: string }) => void) =>
    subscribe('updates:prepare-restart', callback),
  /** Main abandoned that exact restart attempt, so the renderer may accept input again. */
  onUpdateRestartReleased: (callback: (release: { requestId: string }) => void) =>
    subscribe('updates:restart-released', callback),

  // Download progress and state changes from the Model Hub's queue.
  onHubDownloads: (callback: (records: unknown[]) => void) => subscribe('hub:downloads', callback),
  // A source's model list changed outside the renderer — a download was registered on it.
  onProvidersChanged: (callback: (change: { at: number }) => void) => subscribe('providers:changed', callback),

  // Terminal output, and the shell going away.
  onTerminalData: (callback: (chunk: { id: string; data: string; offset?: number }) => void) => subscribe('terminal:data', callback),
  onTerminalCommand: (callback: (session: import('../main/terminal').SessionInfo) => void) => subscribe('terminal:command', callback),
  onTerminalExit: (callback: (exit: { id: string; code: number; signal?: number }) => void) =>
    subscribe('terminal:exit', callback),

  // The recovery shell changed: it is driven by these pushes so a page that loaded late still
  // catches up, and a page that watches keeps rendering without polling.
  onRecoveryState: (callback: (state: unknown) => void) => subscribe('recovery:state', callback),

  // Host-validated detached-panel bridge; every subscription returns its cleanup.
  detached: {
    create: (id: string, bounds?: import('../api/detachedWindows').DetachedBounds) => ipcRenderer.invoke('detached:create', id, bounds),
    close: (id: string) => ipcRenderer.invoke('detached:close', id),
    dock: (id: string) => ipcRenderer.invoke('detached:dock', id),
    focus: (id: string) => ipcRenderer.invoke('detached:focus', id),
    list: () => ipcRenderer.invoke('detached:list'),
    ready: () => ipcRenderer.invoke('detached:ready'),
    publishShell: (snapshot: import('../api/detachedWindows').DetachedShellSnapshot) => ipcRenderer.invoke('detached:publish-shell', snapshot),
    action: (action: import('../api/detachedWindows').DetachedShellAction) => ipcRenderer.invoke('detached:action', action),
    resolveAction: (id: string, choice: import('../api/detachedWindows').DetachedModelChoice | null) => ipcRenderer.invoke('detached:resolve-action', id, choice),
    onBounds: (callback: (event: import('../api/detachedWindows').DetachedWindowState) => void) => subscribe('detached:bounds', callback),
    onChanged: (callback: (event: import('../api/detachedWindows').DetachedWindowChange) => void) => subscribe('detached:changed', callback),
    onShell: (callback: (event: import('../api/detachedWindows').DetachedShellUpdate) => void) => subscribe('detached:shell', callback),
    onAction: (callback: (event: import('../api/detachedWindows').DetachedActionRequest) => void) => subscribe('detached:action', callback),
  } satisfies import('../api/detachedWindows').DetachedWindowsAPI,
});
