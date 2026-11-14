export type Role = 'user' | 'assistant' | 'system';
export type { VoiceGuidance } from '../../../src/api/voice';
export type { AskAnswer, AskOption, AskOutcome, AskOutcomeKind, AskQuestion } from '../../../src/api/ask';
import type { AskOutcome, AskQuestion } from '../../../src/api/ask';

/**
 * The nudge that a question is waiting, as the window receives it.
 *
 * Carries the questions themselves so a notice can say what is being asked without going to find
 * the conversation it belongs to — the point of the nudge is that the person is somewhere else.
 */
export interface QuestionWaiting {
  askId: string;
  runId: string;
  threadId?: string;
  questions: readonly AskQuestion[];
}

/** That question has settled, and how. Retires a notice still showing for it. */
export interface QuestionSettled {
  askId: string;
  runId: string;
  threadId?: string;
  outcome: AskOutcome['kind'];
}

/** What the window sends back when someone answers. Validated again in the main process. */
export type AskOutcomeMessage =
  | { kind: 'answered'; answers: readonly { chosen: readonly string[]; text: string | null }[] }
  | { kind: 'discuss'; note: string | null }
  | { kind: 'dismissed' };
export type {
  DeviceMemoryCgroup,
  DeviceMemoryClient,
  DeviceMemoryDevice,
  DeviceMemoryReading,
} from '../../../src/api/deviceMemory';
import type { DeviceMemoryReading } from '../../../src/api/deviceMemory';
import type { SystemFontFamily } from '../../../src/api/fonts';
import type { RemoteDesktopTurnsSnapshot } from '../../../src/api/remoteDesktopTurns';
export type { BundledFont, FontChoice, FontRole, FontSettings, SystemFontFamily } from '../../../src/api/fonts';

export interface Attachment {
  id: string;
  name: string;
  size: number;
  content: string;
}

/** What a tool is allowed to do, which is what the permission modes gate on. */
export type ToolTier = 'read' | 'write' | 'danger';

export type ToolStatus = 'pending' | 'running' | 'done' | 'failed' | 'denied';

/** The agent run a start_agent call became. */
export interface SubagentRef {
  taskId: string;
  agentId: string;
  agentName: string;
  title: string;
  /** Set once the run has ended, on the row that started it: its result is then the report. */
  finished?: boolean;
}

/** One tool call the model made during a turn, as it progresses. */
export interface ToolActivity {
  callId: string;
  /** App-owned occurrence id; unlike provider fallback call ids, unique within a run. */
  activityId?: string;
  /** Run-scoped approval key; provider call ids alone can collide across simultaneous turns. */
  approvalId?: string;
  /** The assistant message this call belongs to. */
  requestId: string;
  /** UTF-16 offset in the assistant text where this tool occurrence began. */
  contentOffset?: number;
  serverId: string;
  serverName: string;
  toolName: string;
  tier: ToolTier;
  args: string;
  status: ToolStatus;
  result?: string;
  awaitingApproval?: boolean;
  /** Why a command reaches past the project; such a command is put to the person in any mode. */
  caution?: string;
  /** Set on a start_agent call once the agent exists, and on the report it sends back. */
  subagent?: SubagentRef;
  /** Set on a call that showed something: the picture it drew, or the page it opened. */
  preview?: { kind: 'image' | 'page'; target: string; title: string; workspace?: string };
}

/**
 * Something the conversation is showing: a picture, or a live page.
 *
 * The list in the Preview section is rebuilt from the transcript's own tool calls, the same way
 * Outputs is, so it survives a restart without a store of its own. This is the live event that
 * says one has just happened, so the pane can open on it while it is still news.
 */
export interface PreviewItem {
  id: string;
  kind: 'image' | 'page';
  /** Workspace-relative path for an image; an absolute http(s) URL for a page. */
  target: string;
  title: string;
  at: number;
  /** Canonical root the image path was relative to. Absent on pages and legacy rows. */
  workspace?: string;
  threadId?: string;
}

export interface PreviewImage {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

/** How the previewed page is getting on, as the main process sees it. */
export interface PreviewPageState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

/** Per-turn telemetry, recorded as a message is sent or streamed (read by the Research view). */
export interface MessageMeta {
  voiceGuidance?: import('../../../src/api/voice').VoiceGuidance[];
  inputSource?: 'voice';
  createdAt: number;
  modelId?: string;
  sourceName?: string;
  firstTokenAt?: number;
  finishedAt?: number;
  chunks?: number;
  failed?: boolean;
  operationalError?: import('../../../src/api/operationalErrors').OperationalError;
  tools?: ToolActivity[];
  /**
   * Roughly how much the model thought before answering, in tokens.
   *
   * The count is durable and the thinking itself is not: on a reasoning model it is the bulk of
   * the turn — 12,400 tokens for 300 of answer, measured — and persisting every word of it would
   * put a session's whole deliberation in conversations.json to be read back and re-rendered.
   * What survives the reload is the one fact the transcript needs: that the gap was work.
   */
  reasoningTokens?: number;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  attachments?: Attachment[];
  meta?: MessageMeta;
}

export type ViewMode = 'transcript' | 'atlas' | 'research' | 'code' | 'flow';

export type AppPage =
  | 'comms'
  | 'email'
  | 'security'
  | 'features'
  | 'cluster'
  | 'chat'
  | 'bot-chat'
  | 'settings'
  | 'developer'
  | 'imports'
  | 'tools'
  | 'orchestrator'
  | 'environment'
  | 'whatsnew'
  | 'hub'
  | 'memory'
  | 'pull-requests'
  | 'skills'
  | 'plugins'
  | 'scheduled';

/**
 * How Antimatter runs a turn, as against which model answers it. Kept by the main process, one
 * set per install, because an agent run and a scheduled run are turns with no window open.
 */
export interface AutoContinueSettings {
  enabled: boolean;
  /** How many times one turn may be carried on before it is allowed to end. */
  maxContinues: number;
  /** Also carry on a turn the tool-call ceiling cut short. */
  onRoundLimit: boolean;
}

/** Whether Antimatter asks before every screen capture, or the person has answered in advance. */
export interface ScreenCaptureSettings {
  withoutAsking: boolean;
}

/**
 * Whether Antimatter asks before a command that reaches past the project — `sudo`, a system
 * package manager, an install that lands outside any virtual environment — or the person has
 * answered in advance for a machine that is theirs to change.
 */
export interface MachineWideSettings {
  withoutAsking: boolean;
}

export interface DeveloperSettings {
  autoContinue: AutoContinueSettings;
  screenCapture: ScreenCaptureSettings;
  machineWide: MachineWideSettings;
}

/** The main process clamps it too; the page uses it to bound its own control. */
export const MAX_CONTINUES_CEILING = 50;

export type VaultSecretKind = 'password' | 'token' | 'passphrase' | 'key';

/**
 * One Vault credential as the renderer is allowed to know it: everything except the credential.
 *
 * There is no field here for the secret and no call that returns one. The Settings page lists,
 * renames, retags and deletes credentials it has never been able to read, which is why the only
 * way to change a value is to type a new one over it.
 */
export interface VaultEntrySummary {
  id: string;
  tag: string;
  label: string;
  kind: VaultSecretKind;
  username?: string;
  notes?: string;
  /** The environment variable a granted secret arrives under, derived from the tag. */
  envName: string;
  createdAt: number;
  updatedAt: number;
  usedAt?: number;
  useCount: number;
}

export interface VaultStatus {
  enabled: boolean;
  /** False when the session has no OS keyring; the Vault then cannot be turned on at all. */
  sealingAvailable: boolean;
  entries: VaultEntrySummary[];
  path: string;
}

/** What the Add/Replace form sends inward. `secret` is omitted when editing only the labels. */
export interface VaultEntryInput {
  tag: string;
  label?: string;
  kind?: VaultSecretKind;
  username?: string;
  notes?: string;
  secret?: string;
}

/** Whether a model is answering, was started and has stopped answering, or was never started. */
export type ResidencyState = 'live' | 'dead' | 'absent';

export interface ResidentModel {
  id: string;
  state: ResidencyState;
  /** Why a worker counts as dead, in the server's own words. */
  detail?: string;
  /** Host RSS; small for a model whose weights are on the card. */
  hostBytes?: number;
  /** Turns answering on it right now, including agents and paired devices. */
  turns?: number;
}

export interface SourceResidency {
  sourceId: string;
  /** False when this kind of source has no resident models to report. */
  supported: boolean;
  canUnload: boolean;
  unloadUnavailableReason?: string;
  /** Native execution must finish before unloading; legacy worker recovery may interrupt it. */
  unloadRequiresIdle?: boolean;
  models: ResidentModel[];
  /** Device memory in use, reported for the whole card rather than per model. */
  vramBytes?: number;
  error?: string;
}

export type Model = import('../../../src/api/types').Model;
export type ModelDeclaration = import('../../../src/api/types').ModelDeclaration;
export type ModelMetadataPatch = import('../../../src/api/types').ModelMetadataPatch;
export type ThinkingLevel = import('../../../src/api/types').ThinkingLevel;

/** Product/connector identity. Request shape lives in `WireProtocol`. */
export type SourceKind =
  | 'beholdd'
  | 'llama-cpp'
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'opencode-zen'
  | 'openai-compatible';

export type WireProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  models: Model[];
  supportsStreaming: boolean;
  /** Whether main has a stored credential. The credential itself never crosses IPC. */
  credentialConfigured: boolean;
  kind?: SourceKind;
  /** Absent on legacy saved sources, which remain OpenAI-compatible Chat Completions. */
  protocol?: WireProtocol;
  createdAt?: number;
}

/** One-way input used only while adding a source; responses use the redacted ProviderConfig. */
export interface ProviderInput extends Omit<ProviderConfig, 'credentialConfigured'> {
  apiKey: string;
}

export interface ProbedModel extends Model {
  /** beholdd reports whether a model is resident; other servers omit it. */
  loaded?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  models: ProbedModel[];
  error?: string;
}

/**
 * Whether a source can be sent a turn yet.
 *
 * `loading` protects an engine that is still loading; `unreachable` blocks sending with a reason.
 * `startable` lets the first request launch a verified local runtime. `unknown` blocks nothing.
 * Only loading covers the window; unavailable sources leave settings and navigation usable.
 */
export type ReadinessState = 'ready' | 'startable' | 'loading' | 'unreachable' | 'unknown';

export interface SourceReadiness {
  state: ReadinessState;
  /** A server status or explanation from the app-owned startup lifecycle. */
  detail?: string;
}

export interface SourceStoreInfo {
  path: string;
  encrypted: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}

export interface McpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  serverInfo: { name?: string; version?: string } | null;
  tools: McpTool[];
}

export interface McpToolCallResult {
  ok: boolean;
  text: string;
}

/** One agent session the orchestrator currently has in flight (spec §13.3). */
export interface OrchestratorRun {
  issueId: string;
  identifier: string;
  title: string;
  state: string;
  phase: string;
  attempt: number | null;
  startedAt: number;
  turnCount: number;
  sessionId: string | null;
}

export interface OrchestratorRetry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAt: number;
  error: string | null;
}

export interface OrchestratorSnapshot {
  active: boolean;
  running: OrchestratorRun[];
  retrying: OrchestratorRetry[];
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; secondsRunning: number };
  rateLimits: unknown | null;
  pollIntervalMs: number;
  maxConcurrentAgents: number;
}

/** The subset of the typed workflow config the UI displays. */
export interface WorkflowConfigView {
  tracker: { kind: string | null; endpoint: string; activeStates: string[]; terminalStates: string[] };
  pollIntervalMs: number;
  workspaceRoot: string;
  agent: { maxConcurrentAgents: number; maxTurns: number };
  runner: { approvalPolicy: string | null; providerId: string | null; model: string | null };
}

export interface WorkflowReport {
  path: string;
  ok: boolean;
  /** Why dispatch would be skipped; empty when the workflow is ready. */
  problems: string[];
  config: WorkflowConfigView | null;
  promptChars: number;
}

export interface OrchestratorLog {
  level: 'info' | 'warn' | 'error';
  message: string;
  issueId?: string;
  issueIdentifier?: string;
  sessionId?: string;
  at: number;
}

// ---------------------------------------------------------------------------
// Snitch — issues, requests, releases, and the fix pipeline
// ---------------------------------------------------------------------------

export type ItemKind = 'issue' | 'request';
export type ItemStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
/** Severity on an issue, priority on a request. */
export type ItemValue = 'critical' | 'high' | 'medium' | 'low';
export type ReleaseStatus = 'draft' | 'active' | 'archived';
export type PipelineStage = 'idle' | 'queued' | 'fixing' | 'qa' | 'verified' | 'failed';

export interface PipelineState {
  stage: PipelineStage;
  attempt: number;
  failures: number;
  updatedAt: string | null;
  note: string | null;
}

export interface SnitchItem {
  kind: ItemKind;
  id: string;
  title: string;
  status: ItemStatus;
  value: ItemValue;
  created: string;
  updated: string;
  versionFound: string | null;
  versionFixed: string | null;
  releaseId: string | null;
  description: string;
  steps: string[];
  expected: string;
  actual: string;
  pipeline: PipelineState;
}

export interface SnitchRelease {
  id: string;
  version: string;
  name: string;
  date: string;
  status: ReleaseStatus;
  issueCount: number;
  requestCount: number;
}

export interface SnitchProjectSummary {
  name: string;
  path: string;
  version: string;
  repo: string | null;
  issuePrefix: string;
  requestPrefix: string;
  openItems: number;
  totalItems: number;
  activeItems: number;
}

export interface SnitchProject {
  name: string;
  path: string;
  created: string;
  updated: string;
  version: string;
  issuePrefix: string;
  requestPrefix: string;
  repo: string | null;
  issuesDir: string;
  requestsDir: string;
  releases: SnitchRelease[];
  items: SnitchItem[];
}

export interface SnitchStoreConfig {
  root: string;
  custom: boolean;
}

export interface SnitchItemDraft {
  title: string;
  description?: string;
  value?: ItemValue;
  steps?: string[];
  expected?: string;
  actual?: string;
}

export interface SnitchProjectPatch {
  repo?: string | null;
  issuePrefix?: string;
  requestPrefix?: string;
  version?: string;
}

/** One item the fix pipeline currently has somewhere other than idle. */
export interface PipelineEntry {
  project: string;
  itemId: string;
  title: string;
  kind: ItemKind;
  stage: PipelineStage;
  attempt: number;
  failures: number;
  note: string | null;
  updatedAt: string | null;
  repo: string | null;
}

// ---------------------------------------------------------------------------
// System vitals
// ---------------------------------------------------------------------------

export interface CpuReading {
  model: string;
  cores: number;
  usage: number;
  perCore: number[];
  load: [number, number, number] | null;
  speedMhz: number | null;
}

export interface MemoryReading {
  total: number;
  used: number;
  available: number;
  swapTotal: number;
  swapUsed: number;
}

export interface TemperatureReading {
  label: string;
  source: 'cpu' | 'gpu' | 'drive' | 'board' | 'wireless' | 'battery' | 'other';
  celsius: number;
  /** The sensor's own critical point, when it publishes a believable one. */
  critical: number | null;
}

export interface MountReading {
  mount: string;
  device: string;
  total: number;
  used: number;
}

export interface RateReading {
  read: number;
  write: number;
}

export interface NetworkReading {
  name: string;
  rx: number;
  tx: number;
}

export interface GpuReading {
  name: string;
  usage: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  celsius: number | null;
  watts: number | null;
}

export interface ProcessReading {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
}

export interface AppProcessReading {
  pid: number;
  type: string;
  cpu: number;
  memory: number;
}

export interface VitalsSnapshot {
  at: number;
  platform: string;
  host: { name: string; release: string; uptimeSeconds: number };
  cpu: CpuReading;
  memory: MemoryReading;
  temperatures: TemperatureReading[];
  mounts: MountReading[];
  diskIo: RateReading | null;
  network: NetworkReading[];
  gpus: GpuReading[];
  processes: ProcessReading[];
  app: AppProcessReading[];
  unavailable: string[];
}

// ---------------------------------------------------------------------------
// Model profiles and the rolling context window
// ---------------------------------------------------------------------------

/** Where a number came from, so an unverified guess never looks like a measurement. */
export type ProfileSource = 'override' | 'server' | 'known' | 'default';

export type ModelProfile = import('../../../src/main/modelProfiles').ModelProfile;
export type ProfileOverride = import('../../../src/main/modelProfiles').ProfileOverride;

/** What the window looked like for one turn. */
export interface ContextReport {
  runId: string;
  modelId: string;
  contextTokens: number;
  contextSource: ProfileSource;
  maxOutputTokens: number;
  budgetTokens: number;
  estimatedTokens: number;
  compacted: number;
  summarized: boolean;
  /** Nonzero only when the mandatory system/task opening cannot fit in the advertised window. */
  overflowTokens: number;
  /** False when a tight fit safely kept fewer than the preferred recent-message tail. */
  minimumRecentMet: boolean;
  /** The project instructions and notes the conversation was given. */
  memory?: MemoryContextSummary;
}

// ---------------------------------------------------------------------------
// Memory: notes kept between conversations, and a project's own instructions
// ---------------------------------------------------------------------------

export type MemoryScope = 'user' | 'project';

export interface MemoryNote {
  /** The file's name without `.md`; stable across edits, including a rename. */
  id: string;
  scope: MemoryScope;
  name: string;
  /** The one line a conversation sees before it asks for the rest. */
  description: string;
  content: string;
  updatedAt: number;
}

export interface MemorySettings {
  /** Notes are read into conversations, and the model can keep them. */
  enabled: boolean;
  /** A project's AGENTS.md (or CLAUDE.md) is read into conversations and agent runs in it. */
  instructions: boolean;
}

export interface MemoryInstructionFile {
  path: string;
  label: string;
  length: number;
  /** Part of it is left out of the prompt, because the allowance ran out. */
  truncated: boolean;
}

export interface MemoryProjectSummary {
  root: string;
  directory: string;
  notes: number;
  updatedAt: number | null;
}

export interface MemoryPageState {
  settings: MemorySettings;
  /** Who Antimatter is talking to, which is edited in Settings rather than on the page. */
  person: Person;
  location: string;
  workspace: string;
  /** The project the workspace belongs to. */
  current: string;
  project: { root: string; directory: string; notes: MemoryNote[]; instructions: MemoryInstructionFile[] };
  user: { directory: string; notes: MemoryNote[] };
  projects: MemoryProjectSummary[];
}

/** Another project with notes to look at, by root; the workspace's own without one. */
export interface MemoryPageTarget {
  project?: string | null;
}

/** Who Antimatter is talking to. Kept in ~/.antimatter/user.json, edited in Settings. */
export interface Person {
  name: string;
  /** How to refer to them; empty means they/them rather than a guess from a name. */
  pronouns: string;
  /** Their own words about themselves. The model never edits this. */
  about: string;
  updatedAt: number;
}

export interface MemoryContextSummary {
  projectRoot: string;
  instructions: { label: string; path: string; truncated: boolean }[];
  notes: { user: number; project: number };
}

export interface CarbonSummary {
  path: string;
  name: string;
  bytes: number;
  modified: number;
  /** The working directory the turn ran against — what a list of these is usually scanned for. */
  title: string;
}

// ---------------------------------------------------------------------------
// The coding environment
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string;
  /** Relative to the environment root, forward slashes. '' is the root itself. */
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modified: number;
}

export interface FileContent {
  revision?: string;
  path: string;
  text: string;
  size: number;
  modified: number;
  /** True when the bytes are not text; the editor shows a notice instead of mojibake. */
  binary: boolean;
}

export interface RunState {
  id: string;
  spec: { command: string; args: string[]; cwd: string; label: string };
  startedAt: number;
  pid: number | null;
  exit: { code: number; signal?: number } | null;
}

export interface DebugFrame {
  id: string;
  name: string;
  file: string;
  line: number;
  column: number;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string;
}

export interface Breakpoint {
  file: string;
  line: number;
}

export type DebugPhase = 'starting' | 'running' | 'paused' | 'stopped';

export interface DebugState {
  selectedFrameId?: string;
  phase: DebugPhase;
  reason: string | null;
  frames: DebugFrame[];
  variables: DebugVariable[];
  /** Where breakpoints actually landed: V8 moves them to the next executable line. */
  resolved: Breakpoint[];
  error: string | null;
}

// ---------------------------------------------------------------------------
// Agents and tasks
// ---------------------------------------------------------------------------

/** One orchestration profile as the main process reports it. */
export interface OrchestrationProfileInfo {
  id: string;
  name: string;
  description: string;
  /** Absent means the profile requires a category before it appears under a filter. Tagging is opt-in. */
  mode?: 'local' | 'distributed' | 'provider';
  /** `workload` names which of the model's workloads the slot runs under; null means its default. */
  roles: Record<string, { provider: string | null; model: string; workload: string | null }>;
  path: string;
  builtin: boolean;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tags: string[];
  provider: string | null;
  model: string | null;
  /** Tool names this agent may call. Empty means everything the policy already allows. */
  tools: string[];
  maxRounds: number;
  /**
   * What the agent may do unattended. Nobody is there to approve anything, so under 'ask' every
   * write and every command is refused — right for a reviewer, useless for a test writer.
   */
  access: AccessMode;
  prompt: string;
  path: string;
  builtin: boolean;
}

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** `chat` is work the conversation's own model handed to an agent, with the turn waiting on it. */
export type TaskSource = 'manual' | 'schedule' | 'router' | 'chat';

export interface AgentTask {
  id: string;
  agentId: string;
  title: string;
  prompt: string;
  source: TaskSource;
  state: TaskState;
  workspace: string | null;
  /** The chat turn this run is part of, for work handed out by the conversation's model. */
  parent?: { threadId: string; messageId: string } | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** The carbon for this run: how a finished session is opened and read. */
  carbonId: string | null;
  schedule: string | null;
  paused?: boolean;
  dueAt: number | null;
  error: string | null;
  summary: string | null;
}

export interface NewAgentTask {
  agentId: string;
  title: string;
  prompt: string;
  source?: TaskSource;
  workspace?: string | null;
  /** Minutes between runs. Absent or null for one-shot work. */
  everyMinutes?: number | null;
}

export interface AgentActivity {
  taskId: string;
  agentId: string;
  agentName: string;
  title: string;
  state: TaskState;
  startedAt: number | null;
  carbonId: string | null;
}

export interface RoutedTask {
  agentId: string;
  agentName: string;
  title: string;
  why: string;
  /** True when the fallback scorer chose, because the model could not be reached. */
  guessed: boolean;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export interface TerminalSessionInfo {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  exit: { code: number; signal?: number } | null;
  kind?: 'shell' | 'command';
  command?: string;
  /** Set on the command event when the command prompts locally (sudo) and must be shown. */
  needsInput?: boolean;
  runId?: string;
  threadId?: string;
  activityId?: string;
  privateInput?: boolean;
}

export interface BeholddManifest {
  name: string;
  description: string | null;
  source: string;
  version: string | null;
  commit: string | null;
  committedAt: string | null;
  dirty: boolean;
  builtAt: string;
  builtBy: string;
  artifacts: { path: string; bytes: number; sha256: string }[];
}

export interface BeholddInfo {
  binaryPath: string;
  installed: boolean;
  manifest: BeholddManifest | null;
  defaultConfigPath: string;
  exampleConfigPath: string;
  defaultHost: string;
  defaultPort: number;
}

export interface BeholddStatus {
  running: boolean;
  ready: boolean;
  ownership: 'app' | 'external' | null;
  pid: number | null;
  startedAt: number | null;
  host: string | null;
  port: number | null;
  configPath: string | null;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  logs: string[];
}

/** Model Hub shapes, mirrored from src/main/hub/types.ts. */
export type HubSort = 'downloads' | 'likes' | 'trending' | 'updated' | 'created';
export type HubFormat = 'gguf' | 'any';
export type HubGating = false | 'auto' | 'manual';

export interface HubSearchQuery {
  text: string;
  sort: HubSort;
  format: HubFormat;
  task: string | null;
  author?: string | null;
  cursor?: string | null;
  limit?: number;
}

export interface HubGgufFacts {
  architecture: string | null;
  contextLength: number | null;
  parameters: number | null;
}

export interface HubModelSummary {
  id: string;
  author: string | null;
  downloads: number;
  likes: number;
  updatedAt: string | null;
  task: string | null;
  gated: HubGating;
  private: boolean;
  tags: string[];
  gguf: HubGgufFacts | null;
}

export interface HubSearchPage {
  models: HubModelSummary[];
  nextCursor: string | null;
}

export interface HubFile {
  path: string;
  size: number;
  sha256: string | null;
}

export interface HubVariant {
  key: string;
  label: string;
  quant: string | null;
  files: HubFile[];
  bytes: number;
  shards: number;
  role: 'model' | 'projector';
  complete: boolean;
  /** Bytes of it already in the download directory. */
  localBytes: number;
}

export interface HubModelDetail {
  id: string;
  revision: string;
  gated: HubGating;
  private: boolean;
  task: string | null;
  license: string | null;
  updatedAt: string | null;
  gguf: HubGgufFacts | null;
  variants: HubVariant[];
  otherFiles: number;
}

export type DownloadState = 'queued' | 'downloading' | 'paused' | 'failed' | 'ready';
export type DownloadPhase = 'checking' | 'transferring' | 'finishing' | 'registering';

export interface HubRegistration {
  target: 'bundled' | 'external';
  sourceId: string | null;
  sourceName: string;
  status: 'registered' | 'pending' | 'unsupported' | 'failed';
  modelId: string | null;
  detail: string | null;
  at: number;
}

export interface HubDownload {
  id: string;
  repoId: string;
  revision: string;
  variantKey: string;
  label: string;
  role: 'model' | 'projector';
  files: (HubFile & { done: boolean })[];
  bytesTotal: number;
  bytesDone: number;
  state: DownloadState;
  phase: DownloadPhase | null;
  error: string | null;
  root: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  path: string | null;
  architecture: string | null;
  quantization?: string | null;
  contextLength: number | null;
  modelId: string;
  registrations: HubRegistration[];
  bytesPerSecond?: number;
}

export interface HubTokenState {
  configured: boolean;
  encrypted: boolean;
  importable: 'env' | 'file' | null;
  importPath: string;
}

export interface HubRootState {
  path: string;
  isDefault: boolean;
  defaultPath: string;
}

export interface HubState {
  token: HubTokenState;
  root: HubRootState & { freeBytes: number | null };
  endpoint: string;
}

export interface HubAccount {
  name: string;
  fullname: string | null;
  tokenRole: string | null;
  tokenName: string | null;
}

/** Updater shapes, mirrored from src/main/updates/service.ts. */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'offline'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'failed';

export interface UpdateState {
  status: UpdateStatus;
  version: string;
  install: { kind: 'installer' | 'appimage' | 'development' | 'unmanaged'; canApply: boolean; reason: string | null };
  feed: { path: string | null; configured: boolean; defaultPath: string };
  automatic: boolean;
  lastCheckedAt: number | null;
  available: {
    version: string;
    buildId: string;
    publishedAt: string | null;
    commit: string | null;
    bytes: number;
    notes: string | null;
  } | null;
  progress: { bytesDone: number; bytesTotal: number } | null;
  readyVersion: string | null;
  restart: { pending: boolean; blockers: string[]; error: string | null };
  error: string | null;
  logPath: string | null;
}

export interface UpdateRestartRequest {
  requestId: string;
  version: string;
}

export interface UpdateRestartRelease {
  requestId: string;
}

export interface RemoteInterfaceInfo {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
}

export interface RemoteDeviceInfo {
  id: string;
  name: string;
  capabilities: string[];
  maxAccess: AccessMode;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface RemoteHostState {
  enabled: boolean;
  running: boolean;
  address: string | null;
  port: number;
  keepAwake: boolean;
  endpoint: string | null;
  certificatePin: string | null;
  interfaces: RemoteInterfaceInfo[];
  devices: RemoteDeviceInfo[];
  error: string | null;
}

/** The one-time pairing text stays in main; the renderer receives only its opaque QR pixels. */
export interface RemotePairingOfferView {
  id: string;
  endpoint: string;
  expiresAt: number;
  capabilities: string[];
  maxAccess: AccessMode;
  qrDataUrl: string;
}

export interface Thread {
  id: string;
  title: string;
  messages: Message[];
  projectId: string;
  createdAt: number;
  /** Main-process optimistic concurrency boundary; preserved through renderer edits. */
  revision?: number;
  importedFrom?: import('../../../src/api/chatImports').ImportedChatOrigin;
  providerId?: string;
  modelId?: string;
  /** When the whole conversation was pinned; absent when it is not. See lib/pins.ts. */
  pinnedAt?: number;
  /** The working directory for tools in this conversation. */
  directory?: string | null;
  /** Host-owned effective workspace; renderer saves cannot grant or replace this binding. */
  workspaceBinding?: import('../../../src/api/conversationWorkspace').ConversationWorkspaceBinding | null;
  /** The permission mode for this conversation. */
  accessMode?: AccessMode;
}

/** A draft: what was typed into a conversation but not sent. */
export interface Draft {
  text: string;
  attachments: Attachment[];
}

/** Everything about the chat side of the app that outlives the window. */
export interface StoredConversations {
  version: 1;
  /** Main-process store revision this renderer snapshot was based on. */
  revision?: number;
  threads: Thread[];
  activeThreadId: string | null;
  pinned: PinnedConversation[];
  drafts: Record<string, Draft>;
}

export interface Project {
  id: string;
  name: string;
  description: string;
}

/**
 * A pinned message: a bookmark into a conversation, shown in the sidebar's Pinned list. The name
 * predates pinning whole conversations, which is a flag on the thread instead (Thread.pinnedAt).
 */
export interface PinnedConversation {
  id: string;
  threadId: string;
  messageId: string;
  snippet: string;
  sourceName: string;
  createdAt: number;
}

export type AccessMode = 'read' | 'ask' | 'full';

export interface AccessSettings {
  directory: string | null;
  mode: AccessMode;
}

/** Where the tools point, and whether a person put them there. */
export interface WorkspaceState {
  path: string;
  confirmed: boolean;
}

export type ActivityPhase = 'idle' | 'thinking' | 'streaming' | 'done' | 'error';

export interface StreamStats {
  phase: ActivityPhase;
  startedAt: number;
  firstTokenAt: number;
  lastTokenAt: number;
  finishedAt: number;
  chunks: number;
  chars: number;
  /**
   * When the source last proved it was still there, token or not. A model building a tool call
   * says nothing for minutes, so this is what separates "working" from "hung".
   */
  lastAliveAt: number;
  /**
   * When the turn began holding for the agents it started, or 0 while it is not. Nothing streams
   * then, and the turn is not generating anything, so it should not say it is.
   */
  waitingSince: number;
  /**
   * What the source last said it was doing while producing nothing — a cold model reading its
   * weights, say. Cleared once real output arrives, because by then it is no longer true.
   */
  aliveNote?: LivenessNote;
}

/** Why the source is quiet, when it says. Mirrors `LivenessNote` in the main process. */
export interface LivenessNote {
  label: string;
  model?: string;
  seconds?: number;
}

export interface StreamData {
  id: string;
  content: string;
}

/** The source and model chat opens on: the last one picked, kept by the main process. */
export interface ModelChoice {
  providerId: string;
  modelId: string;
  /** Which of the model's workloads this choice runs under; absent means its default. */
  workloadId?: string;
}

// The recovery shell: the fallback page the window becomes when the normal UI is down. Its state
// travels whole over IPC, so the page needs no chat machinery to render it.
export type RecoveryRole = 'system' | 'prompt' | 'assistant' | 'tool' | 'note' | 'error';

export interface RecoveryMessage {
  id: string;
  role: RecoveryRole;
  content: string;
  at: number;
}

export interface RecoveryApproval {
  approvalId: string;
  what: string;
  caution?: string;
}

export interface RecoveryState {
  visible: boolean;
  trigger: { kind: string; detail: string; at: number } | null;
  messages: RecoveryMessage[];
  busy: boolean;
  approval: RecoveryApproval | null;
  model: { providerId: string; model: string } | null;
  workspace: string;
  version: string;
}

/**
 * Goetic: a work tracker Antimatter talks to as an agent identity rather than as the person at
 * the keyboard. The credential never reaches the renderer, so a connection is described by what
 * it authenticates as, not by the token itself.
 */
export type GoeticArchiveFilter = 'exclude' | 'include' | 'only';

export interface GoeticConnection {
  url: string;
  configured: boolean;
  /** The agent identity the token names. It is an opaque identity, not a credential. */
  agentId: string | null;
  source: 'environment' | 'file' | 'unset';
}

export interface GoeticIdentity {
  workspaceName: string;
  agentName: string;
  entityId: string;
  /** The live per-resource actions this credential holds, as Goetic reports them. */
  scopes: string[];
}

export interface GoeticBoardRef {
  id: string;
  universeId: string;
  name: string;
  kind: string;
  wipLimit: number;
  stageCount: number;
}

export interface GoeticUniverse {
  id: string;
  name: string;
  description: string;
  boards: GoeticBoardRef[];
}

/** One lifecycle phase, with what the board itself says that phase expects. */
export interface GoeticPhase {
  name: string;
  entry: string;
  exit: string;
  evidence: string;
  handoff: string;
}

export interface GoeticCard {
  id: string;
  revision: number;
  stage: number;
  stageName: string;
  title: string;
  description: string;
  acceptance: string;
  assignee: string;
  collaboration: string;
  blocked: boolean;
  blocker: string;
  evidence: string;
  handoff: string;
  /** Who made the current revision: a person's entity, or an agent's. */
  actorId: string;
  archived: boolean;
  at: number;
}

export interface GoeticRevision extends GoeticCard {
  number: number;
  action: string;
}

export interface GoeticBoardView {
  board: GoeticBoardRef;
  universeName: string;
  lifecycleName: string;
  cadence: string;
  phases: GoeticPhase[];
  cards: GoeticCard[];
  total: number;
}

export interface GoeticCardDraft {
  title: string;
  description?: string;
  acceptance?: string;
  assignee?: string;
  collaboration?: string;
  blocked?: boolean;
  blocker?: string;
  evidence?: string;
  handoff?: string;
}

declare global {
  interface Window {
    electronAPI: {
      security: import('../../../src/api/security').SecurityAPI;
      connections: import('../../../src/api/connections').ConnectionsAPI;
      features: import('../../../src/api/features').FeaturesAPI;
      cluster: import('../../../src/api/cluster').ClusterAPI;
      nativeProject: import('../../../src/api/nativeProject').NativeProjectAPI;
      doom: import('../../../src/api/doom').DoomAPI;
      pensieveLibrary: import('../../../src/api/pensieveLibrary').PensieveLibraryAPI;
      desktop: import('../../../src/api/desktopPreferences').DesktopPreferencesAPI;
      chatNotes: import('../../../src/api/chatNotes').ChatNotesAPI;
      sidebar: import('../../../src/api/sidebar').SidebarApi;
      onSidebarChanged(callback: () => void): () => void;
      idleCompaction: import('../../../src/api/idleCompaction').IdleCompactionAPI;
      detached: import('../../../src/api/detachedWindows').DetachedWindowsAPI;
      appearance: import('../../../src/api/appearance').AppearanceAPI;
      notifications: import('../../../src/api/notifications').NotificationsAPI;
      providers: {
        list(): Promise<ProviderConfig[]>;
        add(config: ProviderInput): Promise<ProviderConfig>;
        remove(id: string): Promise<boolean>;
        /** One-way credential rotation that preserves the source id and all model bindings. */
        replaceCredential(id: string, apiKey: string): Promise<ProviderConfig>;
        declareModel(sourceId: string, model: ModelDeclaration): Promise<ProviderConfig>;
        updateModel(sourceId: string, modelId: string, patch: ModelMetadataPatch): Promise<ProviderConfig>;
        removeModel(sourceId: string, modelId: string): Promise<ProviderConfig>;
        test(id: string): Promise<ProbeResult>;
        refresh(id: string): Promise<ProbeResult>;
        /** One-way connection test for a credential that has not been stored yet. */
        probe(options: { baseUrl: string; apiKey?: string; protocol?: WireProtocol }): Promise<ProbeResult>;
        storeInfo(): Promise<SourceStoreInfo>;
        /** Whether this source can be sent a turn yet. Polled while a conversation is open. */
        readiness(id: string): Promise<SourceReadiness>;
      };
      model: {
        get(): Promise<ModelChoice | null>;
        set(providerId: string, modelId: string, workloadId?: string): Promise<ModelChoice>;
      };
      developer: {
        get(): Promise<DeveloperSettings>;
        set(next: DeveloperSettings): Promise<DeveloperSettings>;
      };
      vault: {
        status(): Promise<VaultStatus>;
        setEnabled(enabled: boolean): Promise<VaultStatus>;
        save(entry: VaultEntryInput): Promise<VaultStatus>;
        remove(tag: string): Promise<VaultStatus>;
      };
      workloads: import('../../../src/api/workloads').WorkloadsAPI;
      setup: import('../../../src/api/setup').SetupAPI;
      hag?: import('../../../src/api/hag').HagExperimentalAPI;
      pensieve?: import('../../../src/api/pensieve').PensieveExperimentalAPI;
      user: {
        get(): Promise<Person>;
        set(patch: Partial<Person>): Promise<Person>;
      };
      memory: {
        state(target?: MemoryPageTarget): Promise<MemoryPageState>;
        setSettings(patch: Partial<MemorySettings>): Promise<MemorySettings>;
        save(
          target: MemoryPageTarget,
          scope: MemoryScope,
          note: { id?: string; name: string; description: string; content: string }
        ): Promise<MemoryNote>;
        remove(target: MemoryPageTarget, scope: MemoryScope, id: string): Promise<boolean>;
        openFolder(target: MemoryPageTarget, scope: MemoryScope): Promise<void>;
        openInstructions(target: MemoryPageTarget, path: string): Promise<void>;
      };
      residency: {
        list(): Promise<SourceResidency[]>;
        unload(sourceId: string, modelId: string): Promise<void>;
      };
      chat: {
        complete(request: any): Promise<string>;
        startStream(request: any): Promise<void>;
        startAvatarStream(request: import('../../../src/api/types').ChatRequest): Promise<void>;
        remoteTurns(): Promise<RemoteDesktopTurnsSnapshot>;
        cancel(runId: string): Promise<boolean>;
        steer(runId: string, text: string, now?: boolean): Promise<boolean>;
        unsteer(runId: string): Promise<boolean>;
        /** Applies a permission change to a turn already running. False once it has ended. */
        setAccess(runId: string, mode: 'read' | 'ask' | 'full'): Promise<boolean>;
      };
      tools: {
        approve(approvalId: string, approved: boolean): Promise<boolean>;
        answer(askId: string, outcome: AskOutcomeMessage): Promise<boolean>;
      };
      mcp: {
        list(): Promise<McpServerStatus[]>;
        connect(id: string): Promise<McpServerStatus>;
        disconnect(id: string): Promise<McpServerStatus | null>;
        connectEnabled(): Promise<McpServerStatus[]>;
        refresh(id: string): Promise<McpServerStatus | null>;
        setEnabled(id: string, enabled: boolean): Promise<McpServerStatus | null>;
        setToolEnabled(id: string, toolName: string, enabled: boolean): Promise<McpServerStatus | null>;
        call(id: string, toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
        workspace(): Promise<string>;
        workspaceState(threadId?: string): Promise<{ path: string; confirmed: boolean; available?: boolean; reason?: string }>;
        confirmWorkspace(threadId?: string, expectedPath?: string): Promise<{ path: string; confirmed: boolean; available?: boolean; reason?: string }>;
        setWorkspace(directory: string | null, confirmed?: boolean): Promise<string>;
        storeInfo(): Promise<{ path: string }>;
      };
      orchestrator: {
        start(): Promise<OrchestratorSnapshot>;
        stop(): Promise<OrchestratorSnapshot>;
        tick(): Promise<OrchestratorSnapshot>;
        snapshot(): Promise<OrchestratorSnapshot>;
        workflow(): Promise<WorkflowReport>;
      };
      goetic: {
        config(): Promise<GoeticConnection>;
        connect(update: { url?: string; token?: string | null }): Promise<GoeticConnection>;
        identity(): Promise<GoeticIdentity>;
        universes(): Promise<GoeticUniverse[]>;
        board(universeId: string, boardId: string, archived: GoeticArchiveFilter): Promise<GoeticBoardView>;
        history(universeId: string, boardId: string, cardId: string): Promise<GoeticRevision[]>;
        createCard(universeId: string, boardId: string, draft: GoeticCardDraft): Promise<GoeticCard>;
        updateCard(
          universeId: string,
          boardId: string,
          cardId: string,
          revision: number,
          patch: Partial<GoeticCardDraft>
        ): Promise<GoeticCard>;
        moveCard(
          universeId: string,
          boardId: string,
          cardId: string,
          revision: number,
          stage: number,
          handoff: string,
          evidence?: string
        ): Promise<GoeticCard>;
        setArchived(
          universeId: string,
          boardId: string,
          cardId: string,
          revision: number,
          archived: boolean
        ): Promise<GoeticCard>;
      };
      snitch: {
        config(): Promise<SnitchStoreConfig>;
        setRoot(root: string | null): Promise<SnitchStoreConfig>;
        projects(): Promise<SnitchProjectSummary[]>;
        project(name: string): Promise<SnitchProject>;
        createProject(name: string, repo?: string | null): Promise<SnitchProject>;
        deleteProject(name: string): Promise<SnitchProjectSummary[]>;
        updateProject(name: string, patch: SnitchProjectPatch): Promise<SnitchProject>;
        addItem(name: string, kind: ItemKind, draft: SnitchItemDraft): Promise<SnitchProject>;
        updateItem(name: string, item: SnitchItem): Promise<SnitchProject>;
        deleteItems(name: string, itemIds: string[]): Promise<SnitchProject>;
        setStatus(name: string, itemIds: string[], status: ItemStatus): Promise<SnitchProject>;
        setRelease(name: string, itemIds: string[], releaseId: string | null): Promise<SnitchProject>;
        addRelease(name: string, releaseName: string): Promise<SnitchProject>;
        updateRelease(name: string, release: SnitchRelease): Promise<SnitchProject>;
        deleteRelease(name: string, releaseId: string): Promise<SnitchProject>;
        fix(name: string, itemId: string): Promise<PipelineEntry[]>;
        cancel(name: string, itemId: string): Promise<PipelineEntry[]>;
        acknowledge(name: string, itemId: string): Promise<PipelineEntry[]>;
        pipeline(): Promise<PipelineEntry[]>;
      };
      environment: {
        open(directory: string | null, threadId?: string): Promise<{ root: string; entries: FileEntry[] }>;
        list(directory: string): Promise<FileEntry[]>;
        read(path: string): Promise<FileContent>;
        write(path: string, text: string, expected?: { root: string; revision: string }): Promise<FileContent>;
        create(path: string, kind: 'file' | 'directory'): Promise<FileEntry>;
        rename(from: string, to: string): Promise<FileEntry>;
        remove(path: string): Promise<void>;
        unchanged(path: string, modified: number): Promise<boolean>;
        suggestCommand(path: string): Promise<string>;
        run(commandLine: string, label: string): Promise<RunState>;
        runState(): Promise<RunState | null>;
        input(data: string): Promise<void>;
        resize(cols: number, rows: number): Promise<void>;
        stop(): Promise<void>;
        debuggable(path: string): Promise<boolean>;
        debugStart(path: string, breakpoints: Breakpoint[]): Promise<DebugState>;
        debugState(): Promise<DebugState>;
        debugBreakpoints(breakpoints: Breakpoint[]): Promise<Breakpoint[]>;
        resume(): Promise<DebugState>;
        pause(): Promise<DebugState>;
        selectFrame(frameId: string): Promise<DebugState>;
        stepOver(): Promise<DebugState>;
        stepInto(): Promise<DebugState>;
        stepOut(): Promise<DebugState>;
        evaluate(expression: string, frameId?: string): Promise<string>;
        debugStop(): Promise<void>;
      };
      nilProject: import('../../../src/api/nilProject').NilProjectAPI & {
        run(sourcePath?: string, target?: import('../../../src/api/nilProject').NilProjectTarget): Promise<RunState>;
        debug(sourcePath: string | undefined, breakpoints: Breakpoint[]): Promise<DebugState>;
      };
      ny: {
        status(): Promise<import('../../../src/api/ny').NyStatus>;
        restart(): Promise<import('../../../src/api/ny').NyStatus>;
        chooseSdk(): Promise<import('../../../src/api/ny').NyStatus | null>;
        completion(document: import('../../../src/api/ny').NyDocument): Promise<import('../../../src/api/ny').NyCompletionItem[]>;
        hover(document: import('../../../src/api/ny').NyDocument): Promise<import('../../../src/api/ny').NyHover | null>;
        symbols(document: import('../../../src/api/ny').NyDocument): Promise<import('../../../src/api/nySymbols').NyDocumentSymbol[]>;
        inspectNil(path: string): Promise<import('../../../src/api/nyInspector').NyModuleInspection>;
        definition(document: import('../../../src/api/ny').NyDocument): Promise<import('../../../src/api/ny').NyLocation[]>;
        diagnostics(document: import('../../../src/api/ny').NyDocument): Promise<import('../../../src/api/ny').NyDiagnostic[]>;
        check(path: string): Promise<import('../../../src/api/ny').NyBuildResult>;
        build(path: string): Promise<import('../../../src/api/ny').NyBuildResult>;
        run(path: string): Promise<RunState>;
        cancel(): Promise<void>;
        createProject(name: string): Promise<import('../../../src/api/ny').NyProjectResult | null>;
      };
      agents: {
        list(): Promise<AgentDefinition[]>;
        useSource(providerId: string, model: string): Promise<void>;
        save(definition: AgentDefinition): Promise<AgentDefinition>;
        remove(id: string): Promise<void>;
        location(): Promise<string>;
        tasks(): Promise<AgentTask[]>;
        counts(): Promise<Record<TaskState, number>>;
        activity(): Promise<{ active: AgentActivity[]; busy: boolean; counts: Record<TaskState, number> }>;
        dispatch(task: NewAgentTask): Promise<AgentTask>;
        route(text: string, workspace?: string | null): Promise<{ routed: RoutedTask | null; task: AgentTask | null }>;
        cancelTask(taskId: string): Promise<AgentTask[]>;
        setSchedulePaused(taskId: string, paused: boolean): Promise<AgentTask>;
        sendMessage(taskId: string, message: string, interrupt?: boolean): Promise<void>;
        removeTask(taskId: string): Promise<AgentTask[]>;
        session(taskId: string): Promise<{ task: AgentTask; path: string | null; markdown: string | null;
          transcript?: { sessionId: string; revision: number; content: string; tools: ToolActivity[] } | null } | null>;
      };
      outputs: {
        /** Opens a text file the conversation wrote, or shows anything else in its folder. */
        open(path: string): Promise<'opened' | 'revealed'>;
      };
      preview: {
        /** The pixels behind a path, fetched only when something is about to draw them. */
        image(path: string, workspace: string | undefined, inline?: boolean): Promise<PreviewImage>;
        openPage(url: string): Promise<void>;
        /** Where the pane ended up, so the page can be laid over it. Null hides the page. */
        bounds(rect: { x: number; y: number; width: number; height: number } | null): void;
        back(): Promise<void>;
        forward(): Promise<void>;
        reload(): Promise<void>;
        closePage(): Promise<void>;
      };
      chatImports: import('../../../src/api/chatImports').ChatImportsAPI;
      chatCoordination: import('../../../src/api/chatCoordination').ChatCoordinationAPI;
      botChat: import('../../../src/api/botChat').BotChatAPI;
      modelRuntimeProfiles: import('../../../src/api/modelRuntimeProfiles').ModelRuntimeProfilesAPI;
      conversations: {
        load(): Promise<StoredConversations>;
        removeTranscript(threadId: string): Promise<void>;
        save(next: Partial<StoredConversations>): Promise<StoredConversations>;
        info(): Promise<{ path: string; bytes: number; threads: number }>;
      };
      remote: {
        state(): Promise<RemoteHostState>;
        configure(patch: Partial<Pick<RemoteHostState, 'enabled' | 'address' | 'port' | 'keepAwake'>>): Promise<RemoteHostState>;
        createPairingOffer(): Promise<RemotePairingOfferView>;
        copyPairingCode(offerId: string): Promise<boolean>;
        cancelPairingOffer(offerId: string): Promise<boolean>;
        revokeDevice(deviceId: string): Promise<RemoteHostState>;
      };
      carbon: {
        list(limit?: number): Promise<CarbonSummary[]>;
        read(path: string): Promise<string>;
        location(): Promise<string>;
        forThread(threadId: string): Promise<{ id: string; path: string | null }>;
        export(threadId: string, suggestedName: string): Promise<{ saved: boolean; path?: string; reason?: string }>;
      };
      // ADR 0001: per-model workloads. `resolve`/`setDefaultSettings` act on the default
      // workload, which is what the single per-model override used to be.
      nodes: import('../../../src/api/nodes').NodesAPI;
      nodeAgent: import('../../../src/api/nodeAgent').NodeAgentAPI;
      modelWorkloads: {
        resolve(providerId: string, modelId: string): Promise<ModelProfile>;
        setDefaultSettings(providerId: string, modelId: string, patch: ProfileOverride | null): Promise<ModelProfile>;
        storeInfo(): Promise<{ path: string }>;
        list(providerId: string, modelId: string): Promise<import('../../../src/api/modelWorkloads').ModelWorkloadsView>;
        create(providerId: string, modelId: string, input: { name: string; description?: string; settings?: import('../../../src/api/modelWorkloads').WorkloadSettings }): Promise<import('../../../src/api/modelWorkloads').ModelWorkloadsView>;
        update(providerId: string, modelId: string, id: string, patch: { name?: string; description?: string; settings?: import('../../../src/api/modelWorkloads').WorkloadSettings }): Promise<import('../../../src/api/modelWorkloads').ModelWorkloadsView>;
        remove(providerId: string, modelId: string, id: string): Promise<import('../../../src/api/modelWorkloads').ModelWorkloadsView>;
        setDefault(providerId: string, modelId: string, id: string): Promise<import('../../../src/api/modelWorkloads').ModelWorkloadsView>;
      };
      terminal: {
        openExternal(directory: string): Promise<void>;
        create(options: { cwd?: string | null; cols?: number; rows?: number }): Promise<TerminalSessionInfo>;
        list(): Promise<TerminalSessionInfo[]>;
        history(id: string): Promise<string>;
        snapshot(id: string): Promise<{ data: string; offset: number }>;
        write(id: string, data: string): Promise<void>;
        resize(id: string, cols: number, rows: number): Promise<void>;
        kill(id: string): Promise<void>;
      };
      pullRequests: {
        list(workspace: string | null): Promise<import('../../../src/main/pullRequests').PullRequestListState>;
        read(workspace: string | null, number: number): Promise<import('../../../src/main/pullRequests').PullRequestDetail>;
      };
      codeReview: import('../../../src/api/codeReview').CodeReviewAPI;
      voice: {
        get(): Promise<import('../../../src/api/voice').VoiceConfiguration>;
        configure(settings: import('../../../src/api/voice').VoiceSettings): Promise<import('../../../src/api/voice').VoiceConfiguration>;
        probe(): Promise<import('../../../src/main/voice/backend').VoiceBackendCapabilities>;
        begin(threadId: string): Promise<import('../../../src/api/voice').VoiceState>;
        end(sessionId: string): Promise<void>;
        update(sessionId: string, state: Partial<import('../../../src/api/voice').VoiceState>): Promise<void>;
        cancel(sessionId: string, requestId: string): Promise<void>;
        transcribe(sessionId: string, requestId: string, payload: { wavBase64: string; sampleRate: number }): Promise<string>;
        synthesize(sessionId: string, requestId: string, text: string): Promise<{ audioBase64: string; mimeType: string }>;
        synthesizeStream(sessionId: string, requestId: string, text: string): Promise<void>;
        acknowledgeSpeechChunk(sessionId: string, requestId: string, sequence: number): Promise<void>;
        onSpeechChunk(callback: (event: import('../../../src/api/voice').VoiceSpeechEvent) => void): () => void;
        beginTranscription(sessionId: string, requestId: string): Promise<{ active: boolean }>;
        appendTranscription(sessionId: string, requestId: string, pcmBase64: string): Promise<void>;
        commitTranscription(sessionId: string, requestId: string): Promise<void>;
        clearTranscription(sessionId: string, requestId: string): Promise<void>;
        onTranscription(callback: (event: import('../../../src/api/voice').VoiceTranscriptionEvent) => void): () => void;
        guide(sessionId: string, runId: string, utteranceId: string, text: string): Promise<import('../../../src/api/voice').VoiceGuidance | null>;
        onCommand(callback: (command: import('../../../src/api/voice').VoiceCommand) => void): () => void;
        onState(callback: (state: import('../../../src/api/voice').VoiceState) => void): () => void;
        onGuidance(callback: (event: { threadId: string; runId: string; guidance: import('../../../src/api/voice').VoiceGuidance[] }) => void): () => void;
      };
      extensions: {
        catalog(workspace: string | null): Promise<import('../../../src/main/extensions/types').ExtensionCatalog>;
        importPlugin(): Promise<import('../../../src/main/extensions/types').PluginInfo | null>;
        setPluginEnabled(id: string, enabled: boolean, fingerprint?: string): Promise<import('../../../src/main/extensions/types').PluginInfo>;
        readSkill(workspace: string | null, id: string, resource?: string): Promise<import('../../../src/main/extensions/types').SkillDocument>;
      };
      avatar: {
        get(): Promise<{ enabled: boolean; kind: 'atom' | 'robot' | 'cat'; running: number; approvals: number }>;
        update(patch: { enabled?: boolean; kind?: 'atom' | 'robot' | 'cat' }): Promise<{ enabled: boolean; kind: 'atom' | 'robot' | 'cat'; running: number; approvals: number }>;
      };
      vitals: {
        sample(): Promise<VitalsSnapshot>;
      };
      deviceMemory: {
        sample(): Promise<DeviceMemoryReading>;
      };
      systemFonts: {
        list(): Promise<SystemFontFamily[]>;
      };
      hub: {
        state(): Promise<HubState>;
        search(query: HubSearchQuery): Promise<HubSearchPage>;
        model(repoId: string): Promise<HubModelDetail>;
        downloads(): Promise<HubDownload[]>;
        download(input: { repoId: string; revision: string; variantKey: string }): Promise<HubDownload[]>;
        pause(id: string): Promise<HubDownload[]>;
        resume(id: string): Promise<HubDownload[]>;
        cancel(id: string): Promise<HubDownload[]>;
        remove(id: string, deleteFiles: boolean): Promise<HubDownload[]>;
        reregister(id: string): Promise<HubDownload[]>;
        setToken(token: string | null): Promise<HubTokenState>;
        importToken(): Promise<{ imported: boolean; token: HubTokenState }>;
        whoami(): Promise<HubAccount>;
        setRoot(path: string | null): Promise<HubRootState>;
      };
      updates: {
        state(): Promise<UpdateState>;
        check(): Promise<UpdateState>;
        apply(): Promise<UpdateState>;
        restart(): Promise<boolean>;
        restartPrepared(requestId: string, blockers: string[]): Promise<boolean>;
        setAutomatic(automatic: boolean): Promise<UpdateState>;
        setFeed(path: string | null): Promise<UpdateState>;
      };
      beholdd: {
        info(): Promise<BeholddInfo>;
        status(): Promise<BeholddStatus>;
        start(options: { configPath?: string; host?: string; port?: number }): Promise<BeholddStatus>;
        restart(options: { configPath?: string; host?: string; port?: number }): Promise<BeholddStatus>;
        stop(): Promise<BeholddStatus>;
      };
      inferenceServers: import('../../../src/api/inferenceServers').InferenceServersAPI;
      workspace: {
        chooseDirectory(threadId?: string): Promise<string | null>;
        setDirectory(threadId: string, directory: string): Promise<string>;
        chooseFile(options?: { title?: string }): Promise<string | null>;
      };
      recovery: {
        state(): Promise<RecoveryState>;
        send(line: string): Promise<{ ok: boolean; content?: string }>;
        approve(approvalId: string, allowed: boolean): Promise<boolean>;
        cancel(): Promise<boolean>;
      };
      about: {
        open(): Promise<boolean>;
        close(): Promise<boolean>;
        openSupport(): Promise<void>;
        info: {
          name: string;
          description: string;
          version: string;
          copyrightYear: number;
          releaseVersion?: string;
          electron: string;
          chrome: string;
          node: string;
          platform: string;
          architecture: string;
        };
      };
      onInferenceMetrics(callback: (event: import('../lib/inferenceMetrics').InferenceMetricsEvent) => void): () => void;
      onStreamData(callback: (data: StreamData) => void): () => void;
      onReasoning(callback: (data: StreamData) => void): () => void;
      onChatAlive(callback: (beat: { id: string; at: number; note?: LivenessNote }) => void): () => void;
      onChatWaiting(callback: (event: { id: string; waiting: boolean; at: number }) => void): () => void;
      onChatSteered(callback: (event: { id: string; note: string; at: number }) => void): () => void;
      onChatCarbon(callback: (event: { threadId: string; id: string; path: string }) => void): () => void;
      onRemoteTurnsChanged(callback: (snapshot: RemoteDesktopTurnsSnapshot) => void): () => void;
      onToolActivity(callback: (activity: ToolActivity) => void): () => void;
      onPreview(callback: (item: PreviewItem) => void): () => void;
      onPreviewPage(callback: (state: PreviewPageState) => void): () => void;
      onPreviewDismissed(callback: () => void): () => void;
      onToolApproval(callback: (request: ToolActivity) => void): () => void;
      onQuestionWaiting(callback: (question: QuestionWaiting) => void): () => void;
      onQuestionSettled(callback: (event: QuestionSettled) => void): () => void;
      onOrchestratorActivity(callback: (activity: ToolActivity) => void): () => void;
      onOrchestratorContent(callback: (chunk: { runId: string; content: string }) => void): () => void;
      onOrchestratorLog(callback: (entry: OrchestratorLog) => void): () => void;
      onSnitchChanged(callback: (change: { reason: string; at: number }) => void): () => void;
      routingEnabled(): Promise<boolean>;
      setRoutingEnabled(value: boolean): Promise<boolean>;
      listProfiles(): Promise<{ profiles: OrchestrationProfileInfo[]; selectedId: string | null }>;
      selectProfile(id: string | null): Promise<string | null>;
      profilesLocation(): Promise<string>;
      renameProfile(id: string, name: string): Promise<OrchestrationProfileInfo | null>;
      setProfileMode(id: string, mode: 'local' | 'distributed' | 'provider' | null): Promise<OrchestrationProfileInfo | null>;
      saveProfile(input: {
        id: string; name: string; description?: string;
        mode?: 'local' | 'distributed' | 'provider';
        roles: Record<string, { provider: string | null; model: string; workload?: string | null }>;
      }): Promise<OrchestrationProfileInfo>;
      removeProfile(id: string): Promise<OrchestrationProfileInfo[]>;
      onAgentsChanged(callback: (change: { at: number }) => void): () => void;
      onEnvironmentOutput(callback: (chunk: { id?: string; data: string; source: 'run' | 'debug' }) => void): () => void;
      onEnvironmentExit(callback: (exit: { id?: string; code: number; signal?: number; source: 'run' | 'debug' }) => void): () => void;
      onDebugState(callback: (state: DebugState) => void): () => void;
      onWorkspaceChanged(callback: (change: { workspace: string; confirmed: boolean }) => void): () => void;
      onRemoteChanged(callback: (state: RemoteHostState) => void): () => void;
      onNodeAgentChanged(callback: (status: import('../../../src/api/nodeAgent').NodeAgentStatus) => void): () => void;
      onRemotePairingInvalidated(callback: (event: { offerId: string }) => void): () => void;
      onConversationsChanged(callback: (event: {
        change: { kind: string; revision: number; threadId?: string; threadRevision?: number };
        stored: StoredConversations;
      }) => void): () => void;
      onAgentActivity(callback: (activity: ToolActivity) => void): () => void;
      onAgentContent(callback: (chunk: { taskId: string; content: string; sessionId?: string; revision?: number; contentOffset?: number }) => void): () => void;
      onChatNotice(callback: (notice: import('../../../src/api/toasts').ToastInput & { id: string; threadId: string }) => void): () => void;
      onChatContext(callback: (report: ContextReport) => void): () => void;
      onMemoryChanged(callback: (change: { at: number }) => void): () => void;
      onHubDownloads(callback: (records: HubDownload[]) => void): () => void;
      onUpdateState(callback: (state: UpdateState) => void): () => void;
      onUpdateRestartRequested(callback: (request: UpdateRestartRequest) => void): () => void;
      onUpdateRestartReleased(callback: (release: UpdateRestartRelease) => void): () => void;
      onProvidersChanged(callback: (change: { at: number }) => void): () => void;
      onTerminalData(callback: (chunk: { id: string; data: string; offset?: number }) => void): () => void;
      onTerminalCommand(callback: (session: TerminalSessionInfo) => void): () => void;
      onTerminalExit(callback: (exit: { id: string; code: number; signal?: number }) => void): () => void;
      onRecoveryState(callback: (state: RecoveryState) => void): () => void;
    };
  }
}
