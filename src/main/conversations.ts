import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { migratePrivateDirectory, migratePrivateFile, writePrivateFileAtomic } from './privateState';
import type { ImportedChatOrigin } from '../api/chatImports';
import type { ConversationWorkspaceBinding } from '../api/conversationWorkspace';
import { inspectConversationWorkspace, normalizeWorkspaceBinding, resolveConversationWorkspace } from './conversationWorkspace';
import { normalizeOperationalError, operationalError, separateOperationalError, type OperationalError } from '../api/operationalErrors';

/**
 * The compatibility shape spoken by the current renderer. New host-side callers should use
 * snapshot() and the typed mutation functions below: renderer replacement saves have no useful
 * conflict boundary, while a remote client must never win by being the last whole-file writer.
 */
export interface StoredThread {
  id: string;
  title: string;
  createdAt: number;
  /** Base revision returned by load(); stale whole-thread saves never replace a newer host copy. */
  revision?: number;
  /** Everything else a legacy renderer put on a thread is accepted at this boundary only. */
  [key: string]: unknown;
}

export interface StoredDraft {
  text: string;
  attachments: unknown[];
}

export interface ConversationsFile {
  version: 1;
  /** Store revision that the renderer based this compatibility snapshot on. */
  revision?: number;
  threads: StoredThread[];
  activeThreadId: string | null;
  pinned: unknown[];
  drafts: Record<string, StoredDraft>;
}

export type ConversationRole = 'user' | 'assistant' | 'system';
export type ConversationAccessMode = 'read' | 'ask' | 'full';
export type ConversationToolTier = 'read' | 'write' | 'danger';
export type ConversationToolStatus = 'pending' | 'running' | 'done' | 'failed' | 'denied';

export interface ConversationAttachment {
  id: string;
  name: string;
  size: number;
  /** Desktop compatibility: never included in a remote projection. */
  content?: string;
  /** Opaque host asset identity, safe to project when present. */
  assetId?: string;
}

export interface ConversationToolActivity {
  callId: string;
  activityId?: string;
  approvalId?: string;
  requestId: string;
  contentOffset?: number;
  serverId?: string;
  serverName: string;
  toolName: string;
  tier: ConversationToolTier;
  /** Host-private raw values retained for desktop continuity and hidden from remote snapshots. */
  args?: string;
  result?: string;
  /** Host-generated, bounded fields which are safe to show to a paired remote approver. */
  remoteSummary?: string;
  remoteArgumentsPreview?: string;
  remoteApprovalDetails?: string;
  status: ConversationToolStatus;
  awaitingApproval?: boolean;
  caution?: string;
  subagent?: {
    taskId: string;
    agentId: string;
    agentName: string;
    title: string;
    finished?: boolean;
  };
  preview?: {
    kind: 'image' | 'page';
    target?: string;
    title: string;
    workspace?: string;
    assetId?: string;
  };
}

export interface ConversationMessageMeta {
  /** Private diagnostic detail, separate from assistant prose and model history. */
  operationalError?: OperationalError;
  voiceGuidance?: import('../api/voice').VoiceGuidance[];
  inputSource?: 'voice';
  createdAt: number;
  modelId?: string;
  sourceName?: string;
  firstTokenAt?: number;
  finishedAt?: number;
  chunks?: number;
  failed?: boolean;
  tools?: ConversationToolActivity[];
}

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  attachments?: ConversationAttachment[];
  meta: ConversationMessageMeta;
}

export interface ConversationThread {
  id: string;
  title: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  messages: ConversationMessage[];
  providerId?: string;
  modelId?: string;
  pinnedAt?: number;
  /** Host-private project path. A remote projection never includes it. */
  directory?: string | null;
  /** Host-owned effective folder; null deliberately resets it after an explicit selection change. */
  workspaceBinding?: ConversationWorkspaceBinding | null;
  accessMode?: ConversationAccessMode;
  /** Host-owned import identity; never a credential, active execution, or source workspace. */
  importedFrom?: ImportedChatOrigin;
}

export interface PinnedMessage {
  id: string;
  threadId: string;
  messageId: string;
  snippet: string;
  sourceName: string;
  createdAt: number;
}

export interface ConversationDraft {
  text: string;
  attachments: ConversationAttachment[];
}

/**
 * Host-private idempotency marker written in the same atomic file replacement as a remote effect.
 * It is intentionally absent from renderer compatibility and remote projection shapes.
 */
export interface RemoteConversationEffect {
  id: string;
  payloadHash: string;
  kind: string;
  appliedAt: number;
  /** Stable identity allocated by the host for a remote thread.create command. */
  result?: { threadId: string; clientThreadId: string };
}

/** The durable host-authoritative representation. */
export interface ConversationsSnapshot {
  version: 2;
  revision: number;
  threads: ConversationThread[];
  activeThreadId: string | null;
  pinned: PinnedMessage[];
  drafts: Record<string, ConversationDraft>;
  remoteEffects: Record<string, Omit<RemoteConversationEffect, 'id'>>;
}

export interface RemoteAttachmentProjection {
  id: string;
  name: string;
  size: number;
  assetId?: string;
}

export interface RemoteToolProjection {
  callId: string;
  activityId?: string;
  approvalId?: string;
  requestId: string;
  contentOffset?: number;
  serverName: string;
  toolName: string;
  tier: ConversationToolTier;
  status: ConversationToolStatus;
  awaitingApproval: boolean;
  summary?: string;
  argumentsPreview?: string;
  approvalReason?: string;
  approvalDetails?: string;
  subagent?: ConversationToolActivity['subagent'];
  /** Only an opaque host asset may cross. Raw paths, URLs and workspaces never do. */
  preview?: { kind: 'image'; title: string; assetId: string };
}

export interface RemoteMessageProjection {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: number;
  modelId?: string;
  sourceName?: string;
  firstTokenAt?: number;
  finishedAt?: number;
  failed: boolean;
  attachments: RemoteAttachmentProjection[];
  tools: RemoteToolProjection[];
}

export interface RemoteThreadProjection {
  id: string;
  title: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  providerId?: string;
  modelId?: string;
  pinnedAt?: number;
  accessMode: ConversationAccessMode;
  messages: RemoteMessageProjection[];
}

export interface RemoteConversationsProjection {
  revision: number;
  activeThreadId: string | null;
  threads: RemoteThreadProjection[];
  pinned: PinnedMessage[];
}

export type ConversationChangeKind =
  | 'replace'
  | 'conflict'
  | 'create'
  | 'import'
  | 'rename'
  | 'pin'
  | 'model'
  | 'workspace'
  | 'append-user'
  | 'begin-turn'
  | 'begin-assistant'
  | 'append-delta'
  | 'upsert-tool'
  | 'finish'
  | 'fail'
  | 'delete';

export interface ConversationChange {
  kind: ConversationChangeKind;
  revision: number;
  threadId?: string;
  threadRevision?: number;
  /** Present on a compatibility-save conflict: the stale base supplied by the renderer. */
  expectedRevision?: number;
}

export class RevisionConflictError extends Error {
  readonly code = 'revision_conflict';

  constructor(
    readonly scope: 'store' | 'thread',
    readonly expected: number,
    readonly current: number
  ) {
    super(`${scope === 'store' ? 'Conversation store' : 'Conversation'} changed (expected revision ${expected}, current ${current}).`);
    this.name = 'RevisionConflictError';
  }
}

export class ConversationNotFoundError extends Error {
  readonly code = 'conversation_not_found';

  constructor(readonly threadId: string) {
    super(`Conversation "${threadId}" was not found.`);
    this.name = 'ConversationNotFoundError';
  }
}

const EMPTY_V2: ConversationsSnapshot = {
  version: 2,
  revision: 0,
  threads: [],
  activeThreadId: null,
  pinned: [],
  drafts: {},
  remoteEffects: {},
};

/** Pinned conversations count toward this ceiling; oldest unpinned threads make room. */
const MAX_THREADS = 200;
const MAX_ID = 256;
const MAX_TITLE = 240;
const MAX_CONTENT = 16 * 1024 * 1024;
const MAX_DELTA = 1024 * 1024;
const MAX_REMOTE_EFFECTS = 50_000;

let storePath = join(homedir(), '.antimatter', 'conversations.json');
let cache: ConversationsSnapshot | null = null;
const listeners = new Set<(change: ConversationChange) => void>();

const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const finite = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length ? value : undefined;
const optionalFinite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;

function cleanId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function cleanModelId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Model id is invalid.');
  }
  return value.trim();
}

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Conversation title is invalid.');
  const title = value.trim();
  if (!title || title.length > MAX_TITLE) throw new Error(`Conversation title must be 1-${MAX_TITLE} characters.`);
  return title;
}

function cleanContent(value: unknown, label = 'Message content'): string {
  if (typeof value !== 'string' || value.length > MAX_CONTENT) throw new Error(`${label} is invalid or too large.`);
  return value;
}

function normalizeAttachment(value: unknown): ConversationAttachment | null {
  const item = record(value);
  if (!item) return null;
  try {
    const attachment: ConversationAttachment = {
      id: cleanId(item.id, 'Attachment id'),
      name: typeof item.name === 'string' ? item.name.slice(0, 512) : 'attachment',
      size: Math.max(0, finite(item.size)),
    };
    if (typeof item.content === 'string') attachment.content = item.content;
    if (typeof item.assetId === 'string' && item.assetId.length <= MAX_ID) attachment.assetId = item.assetId;
    return attachment;
  } catch {
    return null;
  }
}

function normalizeSubagent(value: unknown): ConversationToolActivity['subagent'] | undefined {
  const item = record(value);
  if (!item) return undefined;
  const taskId = optionalString(item.taskId);
  const agentId = optionalString(item.agentId);
  const agentName = optionalString(item.agentName);
  const title = optionalString(item.title);
  if (!taskId || !agentId || !agentName || !title) return undefined;
  return { taskId, agentId, agentName, title, ...(bool(item.finished) !== undefined ? { finished: bool(item.finished) } : {}) };
}

function normalizePreview(value: unknown): ConversationToolActivity['preview'] | undefined {
  const item = record(value);
  if (!item || (item.kind !== 'image' && item.kind !== 'page') || typeof item.title !== 'string') return undefined;
  return {
    kind: item.kind,
    title: item.title,
    ...(optionalString(item.target) ? { target: String(item.target) } : {}),
    ...(optionalString(item.workspace) ? { workspace: String(item.workspace) } : {}),
    ...(optionalString(item.assetId) ? { assetId: String(item.assetId) } : {}),
  };
}

function normalizeTool(value: unknown): ConversationToolActivity | null {
  const item = record(value);
  if (!item) return null;
  const tier = item.tier;
  const status = item.status;
  if (
    !['read', 'write', 'danger'].includes(String(tier)) ||
    !['pending', 'running', 'done', 'failed', 'denied'].includes(String(status))
  ) return null;
  try {
    const tool: ConversationToolActivity = {
      callId: cleanId(item.callId, 'Tool call id'),
      requestId: cleanId(item.requestId, 'Tool request id'),
      serverName: optionalString(item.serverName)?.slice(0, 240) ?? 'Tool',
      toolName: optionalString(item.toolName)?.slice(0, 240) ?? 'unknown',
      tier: tier as ConversationToolTier,
      status: status as ConversationToolStatus,
    };
    const activityId = optionalString(item.activityId);
    const approvalId = optionalString(item.approvalId);
    const contentOffset = optionalFinite(item.contentOffset);
    const serverId = optionalString(item.serverId);
    if (activityId) tool.activityId = activityId;
    if (approvalId) tool.approvalId = approvalId;
    if (contentOffset !== undefined && contentOffset >= 0) tool.contentOffset = Math.floor(contentOffset);
    if (serverId) tool.serverId = serverId;
    if (typeof item.args === 'string') tool.args = item.args;
    if (typeof item.result === 'string') tool.result = item.result;
    if (typeof item.remoteSummary === 'string') tool.remoteSummary = item.remoteSummary.slice(0, 360);
    if (typeof item.remoteArgumentsPreview === 'string') {
      tool.remoteArgumentsPreview = item.remoteArgumentsPreview.slice(0, 480);
    }
    if (typeof item.remoteApprovalDetails === 'string') {
      tool.remoteApprovalDetails = item.remoteApprovalDetails.slice(0, 960);
    }
    if (typeof item.awaitingApproval === 'boolean') tool.awaitingApproval = item.awaitingApproval;
    if (typeof item.caution === 'string') tool.caution = item.caution;
    const subagent = normalizeSubagent(item.subagent);
    const preview = normalizePreview(item.preview);
    if (subagent) tool.subagent = subagent;
    if (preview) tool.preview = preview;
    return tool;
  } catch {
    return null;
  }
}

function normalizeMeta(value: unknown, fallbackCreatedAt: number): ConversationMessageMeta {
  const item = record(value) ?? {};
  const meta: ConversationMessageMeta = { createdAt: finite(item.createdAt, fallbackCreatedAt) };
  const modelId = optionalString(item.modelId);
  const sourceName = optionalString(item.sourceName);
  if (modelId) meta.modelId = modelId;
  if (sourceName) meta.sourceName = sourceName;
  for (const key of ['firstTokenAt', 'finishedAt', 'chunks'] as const) {
    const value = optionalFinite(item[key]);
    if (value !== undefined) meta[key] = value;
  }
  if (typeof item.failed === 'boolean') meta.failed = item.failed;
  const failure = normalizeOperationalError(item.operationalError);
  if (failure) meta.operationalError = failure;
  if (item.inputSource === 'voice') meta.inputSource = 'voice';
  if (Array.isArray(item.voiceGuidance)) meta.voiceGuidance = item.voiceGuidance.slice(0, 256).flatMap((raw) => {
    const entry = record(raw);
    if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z\d_-]{1,100}$/.test(entry.id) || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 4000 ||
        !['queued', 'delivered', 'undelivered'].includes(String(entry.status))) return [];
    return [{ id: entry.id, text: entry.text, at: finite(entry.at), contentOffset: Math.max(0, Math.floor(finite(entry.contentOffset))),
      status: entry.status as import('../api/voice').VoiceGuidance['status'] }];
  });
  if (Array.isArray(item.tools)) meta.tools = item.tools.map(normalizeTool).filter((tool): tool is ConversationToolActivity => !!tool);
  return meta;
}

function normalizeMessage(value: unknown, fallbackCreatedAt: number): ConversationMessage | null {
  const item = record(value);
  if (!item || !['user', 'assistant', 'system'].includes(String(item.role))) return null;
  try {
    const message: ConversationMessage = {
      id: cleanId(item.id, 'Message id'),
      role: item.role as ConversationRole,
      content: cleanContent(item.content ?? ''),
      meta: normalizeMeta(item.meta, fallbackCreatedAt),
    };
    if (Array.isArray(item.attachments)) {
      message.attachments = item.attachments
        .map(normalizeAttachment)
        .filter((attachment): attachment is ConversationAttachment => !!attachment);
    }
    return separateOperationalError(message);
  } catch {
    return null;
  }
}

function normalizeAccess(value: unknown): ConversationAccessMode | undefined {
  return value === 'read' || value === 'ask' || value === 'full' ? value : undefined;
}

function normalizeImportedOrigin(value: unknown): ImportedChatOrigin | undefined {
  const item = record(value);
  if (!item || !((item.source === 'claude' && (item.format === 'claude-export' || item.format === 'claude-code')) ||
    (item.source === 'codex' && item.format === 'codex-rollout') ||
    (item.source === 'opencode' && item.format === 'opencode-export')) ||
    typeof item.importedAt !== 'number' || !Number.isFinite(item.importedAt) || item.importedAt < 0) return undefined;
  try {
    return { source: item.source as ImportedChatOrigin['source'], format: item.format as ImportedChatOrigin['format'],
      externalId: cleanId(item.externalId, 'Imported conversation id'), importedAt: item.importedAt };
  } catch { return undefined; }
}

function normalizeThread(value: unknown, revision = 1): ConversationThread | null {
  const item = record(value);
  if (!item) return null;
  try {
    const createdAt = finite(item.createdAt, Date.now());
    const messages = Array.isArray(item.messages)
      ? item.messages.map((message) => normalizeMessage(message, createdAt)).filter((message): message is ConversationMessage => !!message)
      : [];
    const latestMessage = messages.reduce((latest, message) => Math.max(latest, message.meta.createdAt), createdAt);
    const thread: ConversationThread = {
      id: cleanId(item.id, 'Conversation id'),
      title: cleanTitle(item.title),
      projectId: optionalString(item.projectId) ?? 'inbox',
      createdAt,
      updatedAt: finite(item.updatedAt, latestMessage),
      revision: Math.max(1, Math.floor(finite(item.revision, revision))),
      messages,
    };
    for (const key of ['providerId', 'modelId'] as const) {
      const field = optionalString(item[key]);
      if (field) thread[key] = field;
    }
    const pinnedAt = optionalFinite(item.pinnedAt);
    if (pinnedAt !== undefined) thread.pinnedAt = pinnedAt;
    if (item.directory === null || typeof item.directory === 'string') thread.directory = item.directory;
    if (item.workspaceBinding === null) thread.workspaceBinding = null;
    else {
      const binding = normalizeWorkspaceBinding(item.workspaceBinding);
      if (binding) thread.workspaceBinding = binding;
    }
    const accessMode = normalizeAccess(item.accessMode);
    if (accessMode) thread.accessMode = accessMode;
    const importedFrom = normalizeImportedOrigin(item.importedFrom);
    if (importedFrom) thread.importedFrom = importedFrom;
    return thread;
  } catch {
    return null;
  }
}

function normalizePin(value: unknown): PinnedMessage | null {
  const item = record(value);
  if (!item) return null;
  try {
    return {
      id: cleanId(item.id, 'Pin id'),
      threadId: cleanId(item.threadId, 'Pinned conversation id'),
      messageId: cleanId(item.messageId, 'Pinned message id'),
      snippet: typeof item.snippet === 'string' ? item.snippet.slice(0, 1000) : '',
      sourceName: typeof item.sourceName === 'string' ? item.sourceName.slice(0, 240) : '',
      createdAt: finite(item.createdAt),
    };
  } catch {
    return null;
  }
}

function normalizeDraft(value: unknown): ConversationDraft | null {
  const item = record(value);
  if (!item || typeof item.text !== 'string') return null;
  return {
    text: item.text,
    attachments: Array.isArray(item.attachments)
      ? item.attachments.map(normalizeAttachment).filter((attachment): attachment is ConversationAttachment => !!attachment)
      : [],
  };
}

function normalizeDrafts(value: unknown, live: Set<string>): Record<string, ConversationDraft> {
  const item = record(value);
  if (!item) return {};
  return Object.fromEntries(
    Object.entries(item)
      .filter(([threadId]) => live.has(threadId))
      .map(([threadId, draft]) => [threadId, normalizeDraft(draft)] as const)
      .filter((entry): entry is readonly [string, ConversationDraft] => !!entry[1])
      .filter(([, draft]) => !!draft.text || draft.attachments.length > 0)
  );
}

function normalizeRemoteEffects(value: unknown): ConversationsSnapshot['remoteEffects'] {
  const item = record(value);
  if (!item) return {};
  const effects = Object.entries(item).flatMap(([id, candidate]) => {
    const effect = record(candidate);
    const result = effect ? record(effect.result) : null;
    const normalizedResult = effect?.result === undefined
      ? undefined
      : result &&
          typeof result.threadId === 'string' &&
          /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.threadId) &&
          typeof result.clientThreadId === 'string' &&
          /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.clientThreadId)
        ? { threadId: result.threadId, clientThreadId: result.clientThreadId }
        : null;
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(id) ||
      !effect ||
      typeof effect.payloadHash !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(effect.payloadHash) ||
      typeof effect.kind !== 'string' ||
      !effect.kind ||
      effect.kind.length > 128 ||
      typeof effect.appliedAt !== 'number' ||
      !Number.isSafeInteger(effect.appliedAt) ||
      normalizedResult === null
    ) return [];
    return [[id, {
      payloadHash: effect.payloadHash,
      kind: effect.kind,
      appliedAt: effect.appliedAt,
      ...(normalizedResult ? { result: normalizedResult } : {}),
    }] as const];
  });
  effects.sort((left, right) => right[1].appliedAt - left[1].appliedAt);
  return Object.fromEntries(effects.slice(0, MAX_REMOTE_EFFECTS));
}

function withRemoteEffect(
  state: ConversationsSnapshot,
  effect?: RemoteConversationEffect
): { effects: ConversationsSnapshot['remoteEffects']; fresh: boolean } {
  if (!effect) return { effects: state.remoteEffects, fresh: false };
  if (!/^[A-Za-z0-9_-]{43}$/.test(effect.id) || !/^[A-Za-z0-9_-]{43}$/.test(effect.payloadHash)) {
    throw new Error('Remote conversation effect identity is invalid.');
  }
  if (!effect.kind || effect.kind.length > 128 || !Number.isSafeInteger(effect.appliedAt)) {
    throw new Error('Remote conversation effect metadata is invalid.');
  }
  if (effect.result && (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(effect.result.threadId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(effect.result.clientThreadId)
  )) {
    throw new Error('Remote conversation effect result is invalid.');
  }
  const existing = state.remoteEffects[effect.id];
  if (existing) {
    if (existing.payloadHash !== effect.payloadHash) {
      throw new Error('Remote conversation effect identity was reused for different content.');
    }
    return { effects: state.remoteEffects, fresh: false };
  }
  const effects: ConversationsSnapshot['remoteEffects'] = {
    ...state.remoteEffects,
    [effect.id]: {
      payloadHash: effect.payloadHash,
      kind: effect.kind,
      appliedAt: effect.appliedAt,
      ...(effect.result ? { result: { ...effect.result } } : {}),
    },
  };
  // A recovered command can be older than every retained marker. Always protect the marker being
  // committed now; otherwise a full store could immediately forget it and replay the effect.
  if (Object.keys(effects).length > MAX_REMOTE_EFFECTS) {
    const evict = Object.entries(effects)
      .filter(([id]) => id !== effect.id)
      .sort((left, right) => left[1].appliedAt - right[1].appliedAt)[0]?.[0];
    if (evict) delete effects[evict];
  }
  return { effects, fresh: true };
}

function trimThreads(threads: ConversationThread[]): ConversationThread[] {
  const ordered = [...threads].sort((a, b) => b.createdAt - a.createdAt);
  const pinned = (thread: ConversationThread) => thread.pinnedAt !== undefined;
  const room = Math.max(0, MAX_THREADS - ordered.filter(pinned).length);
  const keep = new Set([...ordered.filter(pinned), ...ordered.filter((thread) => !pinned(thread)).slice(0, room)]);
  return ordered.filter((thread) => keep.has(thread));
}

function normalizeV2(value: unknown): ConversationsSnapshot | null {
  const item = record(value);
  if (!item || item.version !== 2 || !Array.isArray(item.threads)) return null;
  const threads = trimThreads(item.threads.map((thread) => normalizeThread(thread)).filter((thread): thread is ConversationThread => !!thread));
  const live = new Set(threads.map((thread) => thread.id));
  const activeThreadId = typeof item.activeThreadId === 'string' && live.has(item.activeThreadId) ? item.activeThreadId : null;
  return {
    version: 2,
    revision: Math.max(0, Math.floor(finite(item.revision))),
    threads,
    activeThreadId,
    pinned: Array.isArray(item.pinned)
      ? item.pinned.map(normalizePin).filter((pin): pin is PinnedMessage => !!pin && live.has(pin.threadId))
      : [],
    drafts: normalizeDrafts(item.drafts, live),
    remoteEffects: normalizeRemoteEffects(item.remoteEffects),
  };
}

function migrateV1(value: unknown): ConversationsSnapshot | null {
  const item = record(value);
  if (!item || item.version !== 1 || !Array.isArray(item.threads)) return null;
  const threads = trimThreads(item.threads.map((thread) => normalizeThread(thread, 1)).filter((thread): thread is ConversationThread => !!thread));
  const live = new Set(threads.map((thread) => thread.id));
  return {
    version: 2,
    revision: threads.length || (Array.isArray(item.pinned) && item.pinned.length) || Object.keys(record(item.drafts) ?? {}).length ? 1 : 0,
    threads,
    activeThreadId: typeof item.activeThreadId === 'string' && live.has(item.activeThreadId) ? item.activeThreadId : null,
    pinned: Array.isArray(item.pinned)
      ? item.pinned.map(normalizePin).filter((pin): pin is PinnedMessage => !!pin && live.has(pin.threadId))
      : [],
    drafts: normalizeDrafts(item.drafts, live),
    remoteEffects: {},
  };
}

function write(next: ConversationsSnapshot): void {
  writePrivateFileAtomic(storePath, `${JSON.stringify(next)}\n`);
  cache = next;
}

function readV2(): ConversationsSnapshot {
  if (cache) return cache;
  const ownsDirectory = migratePrivateDirectory(dirname(storePath));
  if (!existsSync(storePath)) {
    cache = clone(EMPTY_V2);
    return cache;
  }
  if (ownsDirectory) migratePrivateFile(storePath);
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as unknown;
    const current = normalizeV2(parsed);
    if (current) {
      cache = current;
      return cache;
    }
    const migrated = migrateV1(parsed);
    if (migrated) {
      write(migrated);
      return migrated;
    }
    console.error('[conversations] unsupported store, starting empty');
  } catch (error) {
    console.error('[conversations] unreadable store, starting empty:', error);
  }
  cache = clone(EMPTY_V2);
  return cache;
}

function legacyThread(thread: ConversationThread): StoredThread {
  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    createdAt: thread.createdAt,
    revision: thread.revision,
    updatedAt: thread.updatedAt,
    messages: clone(thread.messages),
    ...(thread.providerId ? { providerId: thread.providerId } : {}),
    ...(thread.modelId ? { modelId: thread.modelId } : {}),
    ...(thread.pinnedAt !== undefined ? { pinnedAt: thread.pinnedAt } : {}),
    ...(thread.directory !== undefined ? { directory: thread.directory } : {}),
    ...(thread.workspaceBinding !== undefined ? { workspaceBinding: clone(thread.workspaceBinding) } : {}),
    ...(thread.accessMode ? { accessMode: thread.accessMode } : {}),
    ...(thread.importedFrom ? { importedFrom: clone(thread.importedFrom) } : {}),
  };
}

function compatibility(state: ConversationsSnapshot): ConversationsFile {
  return {
    version: 1,
    revision: state.revision,
    threads: state.threads.map(legacyThread),
    activeThreadId: state.activeThreadId,
    pinned: clone(state.pinned),
    drafts: clone(state.drafts),
  };
}

const comparableThread = (thread: ConversationThread): unknown => ({ ...thread, revision: 0 });
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

function assertStoreRevision(state: ConversationsSnapshot, expected: number): void {
  if (state.revision !== expected) throw new RevisionConflictError('store', expected, state.revision);
}

function threadAt(state: ConversationsSnapshot, threadId: string, expectedRevision: number): { thread: ConversationThread; index: number } {
  const index = state.threads.findIndex((thread) => thread.id === threadId);
  if (index < 0) throw new ConversationNotFoundError(threadId);
  const thread = state.threads[index];
  if (thread.revision !== expectedRevision) throw new RevisionConflictError('thread', expectedRevision, thread.revision);
  return { thread, index };
}

function notify(change: ConversationChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (error) {
      console.error('[conversations] change listener failed:', error);
    }
  }
}

function commitThread(
  kind: Exclude<ConversationChangeKind, 'replace' | 'conflict' | 'create' | 'import' | 'delete'>,
  state: ConversationsSnapshot,
  index: number,
  previous: ConversationThread,
  nextValue: ConversationThread,
  effect?: RemoteConversationEffect
): ConversationThread {
  const changed = !same(comparableThread(previous), comparableThread(nextValue));
  const marker = withRemoteEffect(state, effect);
  if (!changed && !marker.fresh) return clone(previous);
  const nextThread = changed ? { ...nextValue, revision: previous.revision + 1 } : previous;
  const nextState = {
    ...state,
    revision: state.revision + 1,
    threads: state.threads.map((thread, candidate) => candidate === index ? nextThread : thread),
    remoteEffects: marker.effects,
  };
  write(nextState);
  notify({ kind, revision: nextState.revision, threadId: nextThread.id, threadRevision: nextThread.revision });
  return clone(nextThread);
}

export const useStorePath = (path: string): void => {
  storePath = path;
  cache = null;
};

export const location = (): string => storePath;

/** Compatibility load for the current renderer. */
export function load(): ConversationsFile {
  return compatibility(readV2());
}

/** Authoritative snapshot for typed local and remote adapters. */
export function snapshot(): ConversationsSnapshot {
  return clone(readV2());
}

/** Public-channel identity needs no access to a chat's transcript, tools, or drafts. */
export function chatMetadata(): Pick<ConversationThread, 'id' | 'title' | 'directory' | 'workspaceBinding'>[] {
  return readV2().threads.map(({ id, title, directory, workspaceBinding }) =>
    ({ id, title, directory, ...(workspaceBinding !== undefined ? { workspaceBinding: clone(workspaceBinding) } : {}) }));
}

/** Freeze a host-resolved workspace once. Renderer saves cannot replace or grant this binding. */
export function bindWorkspace(threadId: string, binding: ConversationWorkspaceBinding, expectedRevision?: number): ConversationThread {
  const state = readV2();
  const index = state.threads.findIndex((thread) => thread.id === threadId);
  if (index < 0) throw new ConversationNotFoundError(threadId);
  const thread = state.threads[index];
  if (expectedRevision !== undefined && expectedRevision !== thread.revision) {
    throw new RevisionConflictError('thread', expectedRevision, thread.revision);
  }
  if (thread.workspaceBinding) return clone(thread);
  const normalized = normalizeWorkspaceBinding(binding);
  if (!normalized) throw new Error('The conversation workspace binding is invalid.');
  return commitThread('workspace', state, index, thread, { ...thread, workspaceBinding: normalized });
}

/** A trusted, explicit user action confirms this chat's folder, never the mutable global default. */
export function confirmWorkspace(threadId: string, expectedRevision?: number): ConversationThread {
  const state = readV2();
  const index = state.threads.findIndex((thread) => thread.id === threadId);
  if (index < 0) throw new ConversationNotFoundError(threadId);
  const thread = state.threads[index];
  if (expectedRevision !== undefined && expectedRevision !== thread.revision) {
    throw new RevisionConflictError('thread', expectedRevision, thread.revision);
  }
  if (!thread.workspaceBinding) throw new Error('Resolve this conversation’s workspace before confirming it.');
  const workspace = inspectConversationWorkspace(thread.workspaceBinding);
  if (!workspace.available) throw new Error(workspace.reason);
  return commitThread('workspace', state, index, thread, {
    ...thread, workspaceBinding: { path: workspace.path, confirmed: true },
  });
}

/** Called only after a trusted native picker selection; choosing the same spelling can rebind a moved symlink. */
export function setWorkspaceDirectory(threadId: string, directory: string, expectedRevision?: number): ConversationThread {
  const state = readV2();
  const index = state.threads.findIndex((thread) => thread.id === threadId);
  if (index < 0) throw new ConversationNotFoundError(threadId);
  const thread = state.threads[index];
  if (expectedRevision !== undefined && expectedRevision !== thread.revision) {
    throw new RevisionConflictError('thread', expectedRevision, thread.revision);
  }
  const workspace = resolveConversationWorkspace({ directory, workspaceBinding: null }, {
    defaultWorkspace: directory, defaultConfirmed: false,
  });
  if (!workspace.available) throw new Error(workspace.reason);
  return commitThread('workspace', state, index, thread, { ...thread, directory, workspaceBinding: workspace.binding });
}

export function hasRemoteEffect(effect: Pick<RemoteConversationEffect, 'id' | 'payloadHash'>): boolean {
  return remoteEffect(effect) !== null;
}

/** Returns host-private reconciliation metadata for an already committed remote effect. */
export function remoteEffect(
  effect: Pick<RemoteConversationEffect, 'id' | 'payloadHash'>
): RemoteConversationEffect | null {
  const existing = readV2().remoteEffects[effect.id];
  if (!existing) return null;
  if (existing.payloadHash !== effect.payloadHash) {
    throw new Error('Remote conversation effect identity was reused for different content.');
  }
  return clone({ id: effect.id, ...existing });
}

/**
 * Compatibility whole-file save. It remains while the desktop renderer migrates, but normalizes
 * every field, preserves revisions for unchanged threads, and advances them for changed ones.
 */
export function save(next: Partial<ConversationsFile>): ConversationsFile {
  const current = readV2();
  const suppliedStoreRevision = typeof next.revision === 'number' && Number.isSafeInteger(next.revision)
    ? next.revision
    : current.revision;
  if (suppliedStoreRevision > current.revision) {
    throw new RevisionConflictError('store', suppliedStoreRevision, current.revision);
  }
  const staleStore = suppliedStoreRevision < current.revision;
  const incomingThreads = next.threads === undefined
    ? current.threads
    : next.threads.map((thread) => normalizeThread(thread)).filter((thread): thread is ConversationThread => !!thread);
  const byId = new Map(current.threads.map((thread) => [thread.id, thread]));
  const conflicts: Array<{ threadId: string; expected: number; current: number }> = [];
  let revised = incomingThreads.map((thread) => {
    const previous = byId.get(thread.id);
    if (!previous) {
      // New renderer-created threads also receive their effective folder only from the host.
      delete thread.workspaceBinding;
      return { ...thread, revision: 1 };
    }
    // The compatibility renderer replaces whole threads. Once another authority has advanced a
    // thread, an older renderer snapshot must not put its earlier messages back over the top.
    // Preserve the host copy and publish a conflict so an adapter can request/reconcile a fresh
    // snapshot. Typed operations reject the same race synchronously with RevisionConflictError.
    if (thread.revision < previous.revision) {
      conflicts.push({ threadId: thread.id, expected: thread.revision, current: previous.revision });
      return previous;
    }
    // Import identity is host-owned and survives older renderers that do not know this field.
    // A compatibility checkpoint must neither erase nor rewrite the deduplication identity.
    if (previous.importedFrom) thread = { ...thread, importedFrom: clone(previous.importedFrom) };
    // Folder selection is an existing explicit UI action, but the resolved folder/confirmation
    // is host-owned. Clearing a selection must not resurrect its older transcript workspace.
    if ((thread.directory || null) !== (previous.directory || null)) thread.workspaceBinding = null;
    else if (previous.workspaceBinding !== undefined) thread.workspaceBinding = clone(previous.workspaceBinding);
    else delete thread.workspaceBinding;
    return {
      ...thread,
      revision: same(comparableThread(previous), comparableThread(thread)) ? previous.revision : previous.revision + 1,
    };
  });
  // A stale whole-file renderer cannot express whether a missing thread is an intentional delete
  // or a thread created by another authority after its snapshot. Preserve those host threads and
  // make the conflict visible; deletion can be retried from the fresh state. This is the crucial
  // difference between optimistic concurrency and "last renderer checkpoint wins".
  if (staleStore) {
    const incomingIds = new Set(revised.map((thread) => thread.id));
    revised = [...revised, ...current.threads.filter((thread) => !incomingIds.has(thread.id))];
  }
  revised = trimThreads(revised);
  const live = new Set(revised.map((thread) => thread.id));
  const candidate: ConversationsSnapshot = {
    version: 2,
    revision: current.revision,
    threads: revised,
    activeThreadId:
      next.activeThreadId === undefined
        ? current.activeThreadId
        : typeof next.activeThreadId === 'string' && live.has(next.activeThreadId)
          ? next.activeThreadId
          : null,
    pinned:
      next.pinned === undefined
        ? current.pinned
        : next.pinned.map(normalizePin).filter((pin): pin is PinnedMessage => !!pin && live.has(pin.threadId)),
    drafts: next.drafts === undefined ? normalizeDrafts(current.drafts, live) : normalizeDrafts(next.drafts, live),
    remoteEffects: current.remoteEffects,
  };
  if (same({ ...current, revision: 0 }, { ...candidate, revision: 0 })) {
    if (staleStore && conflicts.length === 0) {
      notify({
        kind: 'conflict',
        revision: current.revision,
        expectedRevision: suppliedStoreRevision,
      });
    }
    for (const conflict of conflicts) {
      notify({
        kind: 'conflict',
        revision: current.revision,
        threadId: conflict.threadId,
        threadRevision: conflict.current,
        expectedRevision: conflict.expected,
      });
    }
    return compatibility(current);
  }
  candidate.revision = current.revision + 1;
  write(candidate);
  notify({ kind: 'replace', revision: candidate.revision });
  if (staleStore && conflicts.length === 0) {
    notify({
      kind: 'conflict',
      revision: candidate.revision,
      expectedRevision: suppliedStoreRevision,
    });
  }
  for (const conflict of conflicts) {
    notify({
      kind: 'conflict',
      revision: candidate.revision,
      threadId: conflict.threadId,
      threadRevision: conflict.current,
      expectedRevision: conflict.expected,
    });
  }
  return compatibility(candidate);
}

export function subscribe(listener: (change: ConversationChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface ImportThreadsInput {
  projectId: string;
  conversations: Array<Omit<ImportedChatOrigin, 'importedAt'> & {
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: ConversationMessage[];
  }>;
}

function importTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

/** Import never uses normal startup's empty-store recovery or implicit capacity trimming. */
function readForImport(): ConversationsSnapshot {
  if (!existsSync(storePath)) return cache ?? clone(EMPTY_V2);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(storePath, 'utf8')); }
  catch { throw new Error('Cannot import into an unreadable conversation store. Existing data was not changed.'); }
  const raw = record(parsed);
  if (!raw || (raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.threads) ||
    raw.threads.some((thread) => !normalizeThread(thread)) ||
    new Set(raw.threads.map((thread) => record(thread)?.id)).size !== raw.threads.length) {
    throw new Error('Cannot import into an invalid conversation store. Existing data was not changed.');
  }
  if (raw.threads.length > MAX_THREADS) throw new Error(`Conversation capacity exceeded (${MAX_THREADS}). Existing data was not changed.`);
  const disk = normalizeV2(parsed) ?? migrateV1(parsed);
  // Compare canonical ordering too: a successful import appends in memory while reload sorts.
  // Never let a warm process cache overwrite a valid edit made outside this process.
  if (cache && !same(normalizeV2(cache), disk)) throw new Error('The conversation store changed on disk. Reload before importing; existing data was not changed.');
  const state = cache ?? disk;
  if (!state) throw new Error('Cannot import into an invalid conversation store.');
  return state;
}

/** Append validated historical transcripts in one durable transaction; no tools are replayed. */
export function importThreads(input: ImportThreadsInput, now = Date.now()): { imported: ConversationThread[]; skipped: number } {
  const request = record(input);
  const projectId = cleanId(request?.projectId, 'Project id');
  const importedAt = importTimestamp(now, 'Import time');
  if (!Array.isArray(request?.conversations) || request.conversations.length > 2000) throw new Error('Imported conversations are invalid or too numerous.');
  let bytes = 0;
  let messageCount = 0;
  const boundedText = (value: unknown, label: string): string => {
    const text = cleanContent(value, label);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 64 * 1024 * 1024) throw new Error('Imported conversation content exceeds 64 MiB.');
    return text;
  };
  const candidates = request.conversations.map((raw): ConversationThread => {
    const item = record(raw);
    const origin = normalizeImportedOrigin({ ...item, importedAt });
    if (!item || !origin) throw new Error('Imported conversation provenance is invalid.');
    const createdAt = importTimestamp(item.createdAt, 'Conversation creation time');
    const updatedAt = importTimestamp(item.updatedAt, 'Conversation update time');
    if (updatedAt < createdAt || !Array.isArray(item.messages)) throw new Error('Imported conversation history is invalid.');
    const sourceMessageIds = new Set<string>();
    const messages = item.messages.map((rawMessage): ConversationMessage => {
      if (++messageCount > 20_000) throw new Error('Imported conversations contain too many messages.');
      const message = record(rawMessage);
      const metadata = record(message?.meta);
      if (!message || !metadata || (message.role !== 'user' && message.role !== 'assistant')) throw new Error('Imported messages must be user or assistant history, not system instructions.');
      const sourceMessageId = cleanId(message.id, 'Imported message id');
      if (sourceMessageIds.has(sourceMessageId)) throw new Error('Imported message identities are duplicated.');
      sourceMessageIds.add(sourceMessageId);
      const id = randomUUID();
      const at = importTimestamp(metadata.createdAt, 'Message creation time');
      const meta: ConversationMessageMeta = { createdAt: at };
      for (const key of ['modelId', 'sourceName'] as const) {
        if (metadata[key] !== undefined) {
          if (typeof metadata[key] !== 'string' || metadata[key].length > 512) throw new Error('Imported message metadata is invalid.');
          meta[key] = metadata[key];
        }
      }
      for (const key of ['firstTokenAt', 'finishedAt', 'chunks'] as const) {
        if (metadata[key] !== undefined) meta[key] = importTimestamp(metadata[key], 'Message metadata');
      }
      if (metadata.failed !== undefined) {
        if (typeof metadata.failed !== 'boolean') throw new Error('Imported message completion is invalid.');
        meta.failed = metadata.failed;
      }
      // An imported assistant is completed history, never an in-flight local turn. Unknown
      // duration must not be inferred from a conversation that may continue for weeks.
      if (message.role === 'assistant' && meta.finishedAt === undefined) meta.finishedAt = at;
      if (metadata.tools !== undefined) {
        if (!Array.isArray(metadata.tools) || metadata.tools.length > 10_000) throw new Error('Imported tools are invalid or too numerous.');
        meta.tools = metadata.tools.map((rawTool) => {
          const raw = record(rawTool);
          if (!raw || typeof raw.tier !== 'string' || typeof raw.status !== 'string' ||
            typeof raw.toolName !== 'string' || !raw.toolName || raw.toolName.length > 240 ||
            typeof raw.serverName !== 'string' || !raw.serverName || raw.serverName.length > 240 ||
            (raw.args !== undefined && typeof raw.args !== 'string') || (raw.result !== undefined && typeof raw.result !== 'string') ||
            (raw.contentOffset !== undefined && (typeof raw.contentOffset !== 'number' || !Number.isSafeInteger(raw.contentOffset) || raw.contentOffset < 0))) {
            throw new Error('Imported tool activity is invalid.');
          }
          const tool = normalizeTool(rawTool);
          if (!tool) throw new Error('Imported tool activity is invalid.');
          const historical: ConversationToolActivity = {
            callId: randomUUID(), requestId: id, serverName: tool.serverName, toolName: tool.toolName, tier: tool.tier,
            status: tool.status === 'pending' || tool.status === 'running' ? 'failed' : tool.status,
            awaitingApproval: false,
            caution: 'Imported historical tool record; not executed or independently verified by Antimatter.',
          };
          if (tool.args !== undefined) historical.args = boundedText(tool.args, 'Imported tool arguments');
          if (tool.result !== undefined) historical.result = boundedText(tool.result, 'Imported tool result');
          if (tool.contentOffset !== undefined) historical.contentOffset = Math.min(tool.contentOffset, typeof message.content === 'string' ? message.content.length : 0);
          return historical;
        });
      }
      const result: ConversationMessage = { id, role: message.role as ConversationRole, content: boundedText(message.content, 'Imported message content'), meta };
      if (message.attachments !== undefined) {
        if (!Array.isArray(message.attachments) || message.attachments.length > 1000) throw new Error('Imported attachments are invalid or too numerous.');
        result.attachments = message.attachments.map((rawAttachment) => {
          const raw = record(rawAttachment);
          if (!raw || typeof raw.name !== 'string' || raw.name.length > 512 || typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0 ||
            (raw.content !== undefined && typeof raw.content !== 'string')) throw new Error('Imported attachment is invalid.');
          const attachment = normalizeAttachment(rawAttachment);
          if (!attachment) throw new Error('Imported attachment is invalid.');
          return { id: randomUUID(), name: attachment.name, size: attachment.size,
            ...(attachment.content !== undefined ? { content: boundedText(attachment.content, 'Imported attachment content') } : {}) };
        });
      }
      return result;
    });
    return { id: randomUUID(), title: cleanTitle(item.title), projectId, createdAt, updatedAt, revision: 1,
      messages, importedFrom: origin, accessMode: 'ask', directory: null };
  });
  const state = readForImport();
  const identity = (origin: ImportedChatOrigin) => JSON.stringify([origin.source, origin.format, origin.externalId]);
  const seen = new Set(state.threads.flatMap((thread) => thread.importedFrom ? [identity(thread.importedFrom)] : []));
  const imported = candidates.filter((thread) => {
    const key = identity(thread.importedFrom!);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (state.threads.length + imported.length > MAX_THREADS) throw new Error(`Import would exceed the ${MAX_THREADS}-conversation capacity. No conversations were imported or removed.`);
  if (imported.length) {
    const next = { ...state, revision: state.revision + 1, threads: [...state.threads, ...imported] };
    write(next);
    notify({ kind: 'import', revision: next.revision });
  }
  return { imported: clone(imported), skipped: candidates.length - imported.length };
}

export interface CreateThreadInput {
  id: string;
  title?: string;
  projectId: string;
  createdAt: number;
  providerId?: string;
  modelId?: string;
  directory?: string | null;
  accessMode?: ConversationAccessMode;
}

export function createThread(
  input: CreateThreadInput,
  expectedStoreRevision: number,
  effect?: RemoteConversationEffect
): ConversationThread {
  const state = readV2();
  assertStoreRevision(state, expectedStoreRevision);
  const id = cleanId(input.id, 'Conversation id');
  if (state.threads.some((thread) => thread.id === id)) throw new Error(`Conversation "${id}" already exists.`);
  const createdAt = finite(input.createdAt, Date.now());
  const thread = normalizeThread({ ...input, id, title: input.title ?? 'New Conversation', createdAt, updatedAt: createdAt, revision: 1, messages: [] });
  if (!thread) throw new Error('Conversation input is invalid.');
  const marker = withRemoteEffect(state, effect);
  const threads = trimThreads([thread, ...state.threads]);
  if (!threads.some((candidate) => candidate.id === thread.id)) {
    throw new Error('Conversation capacity is occupied by pinned conversations.');
  }
  const next = {
    ...state,
    revision: state.revision + 1,
    threads,
    remoteEffects: marker.effects,
  };
  write(next);
  notify({ kind: 'create', revision: next.revision, threadId: thread.id, threadRevision: thread.revision });
  return clone(thread);
}

export function renameThread(
  threadId: string,
  title: string,
  expectedRevision: number,
  effect?: RemoteConversationEffect
): ConversationThread {
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  return commitThread('rename', state, index, thread, { ...thread, title: cleanTitle(title), updatedAt: Date.now() }, effect);
}

export function setThreadPinned(
  threadId: string,
  pinnedAt: number | null,
  expectedRevision: number,
  effect?: RemoteConversationEffect
): ConversationThread {
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  const next = { ...thread, updatedAt: Date.now() };
  if (pinnedAt === null) delete next.pinnedAt;
  else next.pinnedAt = finite(pinnedAt, Date.now());
  return commitThread('pin', state, index, thread, next, effect);
}

export function setThreadModel(
  threadId: string,
  providerId: string,
  modelId: string,
  expectedRevision: number,
  effect?: RemoteConversationEffect
): ConversationThread {
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  const provider = cleanId(providerId, 'Provider id');
  return commitThread('model', state, index, thread, {
    ...thread,
    providerId: provider,
    modelId: cleanModelId(modelId),
    updatedAt: Date.now(),
  }, effect);
}

export interface AppendUserMessageInput {
  id: string;
  content: string;
  createdAt: number;
  attachments?: ConversationAttachment[];
}

function assertUniqueMessage(thread: ConversationThread, messageId: string): void {
  if (thread.messages.some((message) => message.id === messageId)) {
    throw new Error(`Message "${messageId}" already exists in conversation "${thread.id}".`);
  }
}

export function appendUserMessage(
  threadId: string,
  input: AppendUserMessageInput,
  expectedRevision: number
): ConversationThread {
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  const id = cleanId(input.id, 'Message id');
  assertUniqueMessage(thread, id);
  const createdAt = finite(input.createdAt, Date.now());
  const message: ConversationMessage = {
    id,
    role: 'user',
    content: cleanContent(input.content),
    meta: { createdAt },
    ...(input.attachments?.length ? { attachments: input.attachments.map((item) => normalizeAttachment(item)).filter((item): item is ConversationAttachment => !!item) } : {}),
  };
  return commitThread('append-user', state, index, thread, {
    ...thread,
    updatedAt: Math.max(thread.updatedAt, createdAt),
    messages: [...thread.messages, message],
  });
}

export interface BeginAssistantMessageInput {
  id: string;
  createdAt: number;
  modelId?: string;
  sourceName?: string;
}

export interface BeginTurnInput {
  user: AppendUserMessageInput;
  assistant: BeginAssistantMessageInput;
  providerId: string;
  modelId: string;
}

/**
 * Opens a host-owned turn in one repository commit. A remote adapter must not leave a user
 * message behind when the paired assistant identity is invalid (or vice versa), because the
 * accepted command cannot safely be replayed under a second command id.
 */
export function beginTurn(
  threadId: string,
  input: BeginTurnInput,
  expectedRevision: number,
  effect?: RemoteConversationEffect
): ConversationThread {
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  const userId = cleanId(input.user.id, 'Message id');
  const assistantId = cleanId(input.assistant.id, 'Message id');
  if (userId === assistantId) throw new Error('The user and assistant message identities must be different.');
  assertUniqueMessage(thread, userId);
  assertUniqueMessage(thread, assistantId);
  const userCreatedAt = finite(input.user.createdAt, Date.now());
  const assistantCreatedAt = finite(input.assistant.createdAt, userCreatedAt);
  const user: ConversationMessage = {
    id: userId,
    role: 'user',
    content: cleanContent(input.user.content),
    meta: { createdAt: userCreatedAt },
    ...(input.user.attachments?.length
      ? {
          attachments: input.user.attachments
            .map((item) => normalizeAttachment(item))
            .filter((item): item is ConversationAttachment => !!item),
        }
      : {}),
  };
  const assistant: ConversationMessage = {
    id: assistantId,
    role: 'assistant',
    content: '',
    meta: {
      createdAt: assistantCreatedAt,
      chunks: 0,
      ...(input.assistant.modelId ? { modelId: input.assistant.modelId } : {}),
      ...(input.assistant.sourceName ? { sourceName: input.assistant.sourceName } : {}),
    },
  };
  return commitThread('begin-turn', state, index, thread, {
    ...thread,
    providerId: cleanId(input.providerId, 'Provider id'),
    modelId: cleanModelId(input.modelId),
    updatedAt: Math.max(thread.updatedAt, userCreatedAt, assistantCreatedAt),
    messages: [...thread.messages, user, assistant],
  }, effect);
}

export function beginAssistantMessage(
  threadId: string,
  input: BeginAssistantMessageInput,
  expectedRevision: number
): ConversationThread {
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  const id = cleanId(input.id, 'Message id');
  assertUniqueMessage(thread, id);
  const createdAt = finite(input.createdAt, Date.now());
  const message: ConversationMessage = {
    id,
    role: 'assistant',
    content: '',
    meta: {
      createdAt,
      chunks: 0,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.sourceName ? { sourceName: input.sourceName } : {}),
    },
  };
  return commitThread('begin-assistant', state, index, thread, {
    ...thread,
    updatedAt: Math.max(thread.updatedAt, createdAt),
    messages: [...thread.messages, message],
  });
}

function assistantAt(thread: ConversationThread, messageId: string): { message: ConversationMessage; index: number } {
  const index = thread.messages.findIndex((message) => message.id === messageId);
  if (index < 0) throw new Error(`Message "${messageId}" was not found in conversation "${thread.id}".`);
  const message = thread.messages[index];
  if (message.role !== 'assistant') throw new Error(`Message "${messageId}" is not an assistant message.`);
  return { message, index };
}

function replaceMessage(thread: ConversationThread, index: number, message: ConversationMessage, at: number): ConversationThread {
  return {
    ...thread,
    updatedAt: Math.max(thread.updatedAt, at),
    messages: thread.messages.map((candidate, candidateIndex) => candidateIndex === index ? message : candidate),
  };
}

export function appendAssistantDelta(
  threadId: string,
  messageId: string,
  delta: string,
  at: number,
  expectedRevision: number
): ConversationThread {
  if (typeof delta !== 'string' || delta.length > MAX_DELTA) throw new Error('Assistant delta is invalid or too large.');
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  if (!delta) return clone(thread);
  const target = assistantAt(thread, messageId);
  const content = cleanContent(`${target.message.content}${delta}`);
  const message = {
    ...target.message,
    content,
    meta: {
      ...target.message.meta,
      firstTokenAt: target.message.meta.firstTokenAt ?? at,
      chunks: (target.message.meta.chunks ?? 0) + 1,
    },
  };
  return commitThread('append-delta', state, index, thread, replaceMessage(thread, target.index, message, at));
}

export function upsertToolActivity(
  threadId: string,
  messageId: string,
  activity: ConversationToolActivity,
  at: number,
  expectedRevision: number
): ConversationThread {
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  const target = assistantAt(thread, messageId);
  const normalized = normalizeTool(activity);
  if (!normalized) throw new Error('Tool activity is invalid.');
  const tools = [...(target.message.meta.tools ?? [])];
  const identity = (tool: ConversationToolActivity): string => tool.activityId || tool.callId;
  const existing = tools.findIndex((tool) => identity(tool) === identity(normalized));
  if (existing < 0) tools.push(normalized);
  else tools[existing] = { ...tools[existing], ...normalized };
  const message = { ...target.message, meta: { ...target.message.meta, tools } };
  return commitThread('upsert-tool', state, index, thread, replaceMessage(thread, target.index, message, at));
}

export function finishAssistantMessage(
  threadId: string,
  messageId: string,
  finishedAt: number,
  expectedRevision: number
): ConversationThread {
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  const target = assistantAt(thread, messageId);
  const message = {
    ...target.message,
    meta: { ...target.message.meta, finishedAt, failed: false },
  };
  return commitThread('finish', state, index, thread, replaceMessage(thread, target.index, message, finishedAt));
}

export interface FailAssistantInput {
  finishedAt: number;
  /** Must already be a deliberate user-facing message, never a raw provider exception. */
  userMessage?: string;
}

export function failAssistantMessage(
  threadId: string,
  messageId: string,
  input: FailAssistantInput,
  expectedRevision: number
): ConversationThread {
  const state = readV2();
  const { thread, index } = threadAt(state, threadId, expectedRevision);
  const target = assistantAt(thread, messageId);
  const failure = input.userMessage ? cleanContent(input.userMessage, 'Failure message') : '';
  const message = {
    ...target.message,
    meta: { ...target.message.meta, finishedAt: input.finishedAt, failed: true,
      ...(failure ? { operationalError: operationalError(failure, input.finishedAt) } : {}) },
  };
  return commitThread('fail', state, index, thread, replaceMessage(thread, target.index, message, input.finishedAt));
}

export function deleteThread(
  threadId: string,
  expectedRevision: number,
  effect?: RemoteConversationEffect
): ConversationsSnapshot {
  const state = readV2();
  threadAt(state, threadId, expectedRevision);
  const marker = withRemoteEffect(state, effect);
  const next: ConversationsSnapshot = {
    ...state,
    revision: state.revision + 1,
    threads: state.threads.filter((thread) => thread.id !== threadId),
    activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
    pinned: state.pinned.filter((pin) => pin.threadId !== threadId),
    drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => id !== threadId)),
    remoteEffects: marker.effects,
  };
  write(next);
  notify({ kind: 'delete', revision: next.revision, threadId });
  return clone(next);
}

function safeAttachmentName(value: string): string {
  // basename() is platform-specific. Split both separators before applying it so a Windows path
  // does not cross from a Linux host as an attachment name.
  return basename(value.split('\\').pop() ?? value).slice(0, 512);
}

export function remoteTool(tool: ConversationToolActivity): RemoteToolProjection {
  const projection: RemoteToolProjection = {
    callId: tool.callId,
    requestId: tool.requestId,
    serverName: tool.serverName,
    toolName: tool.toolName,
    tier: tool.tier,
    status: tool.status,
    awaitingApproval: tool.awaitingApproval === true,
  };
  if (tool.activityId) projection.activityId = tool.activityId;
  if (tool.approvalId) projection.approvalId = tool.approvalId;
  if (tool.contentOffset !== undefined) projection.contentOffset = tool.contentOffset;
  if (tool.remoteSummary) projection.summary = tool.remoteSummary;
  if (tool.remoteArgumentsPreview) projection.argumentsPreview = tool.remoteArgumentsPreview;
  // `caution` originates in the desktop/provider path and may contain endpoints, host paths, or
  // reflected provider text. Remote approvers get a deliberately generic reason plus the
  // host-generated redacted details below.
  if (tool.awaitingApproval) projection.approvalReason = `${tool.tier} access requires approval.`;
  if (tool.remoteApprovalDetails) projection.approvalDetails = tool.remoteApprovalDetails;
  if (tool.subagent) projection.subagent = clone(tool.subagent);
  if (tool.preview?.kind === 'image' && tool.preview.assetId) {
    projection.preview = { kind: 'image', title: tool.preview.title, assetId: tool.preview.assetId };
  }
  return projection;
}

function remoteThread(thread: ConversationThread): RemoteThreadProjection {
  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    revision: thread.revision,
    ...(thread.providerId ? { providerId: thread.providerId } : {}),
    ...(thread.modelId ? { modelId: thread.modelId } : {}),
    ...(thread.pinnedAt !== undefined ? { pinnedAt: thread.pinnedAt } : {}),
    accessMode: thread.accessMode ?? 'ask',
    messages: thread.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.meta.createdAt,
      ...(message.meta.modelId ? { modelId: message.meta.modelId } : {}),
      ...(message.meta.sourceName ? { sourceName: message.meta.sourceName } : {}),
      ...(message.meta.firstTokenAt !== undefined ? { firstTokenAt: message.meta.firstTokenAt } : {}),
      ...(message.meta.finishedAt !== undefined ? { finishedAt: message.meta.finishedAt } : {}),
      failed: message.meta.failed === true,
      attachments: (message.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        name: safeAttachmentName(attachment.name),
        size: attachment.size,
        ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
      })),
      tools: (message.meta.tools ?? []).map(remoteTool),
    })),
  };
}

/**
 * Strict remote DTO. Drafts, directories, inline attachment bytes, raw tool arguments/results,
 * preview targets/workspaces and any provider endpoint fields are intentionally absent.
 */
export function remoteProjection(threadId?: string): RemoteConversationsProjection {
  const state = readV2();
  const threads = threadId === undefined
    ? state.threads
    : state.threads.filter((thread) => thread.id === threadId);
  if (threadId !== undefined && threads.length === 0) throw new ConversationNotFoundError(threadId);
  const included = new Set(threads.map((thread) => thread.id));
  return {
    revision: state.revision,
    activeThreadId: state.activeThreadId && included.has(state.activeThreadId) ? state.activeThreadId : null,
    threads: threads.map(remoteThread),
    pinned: state.pinned.filter((pin) => included.has(pin.threadId)).map((pin) => clone(pin)),
  };
}

/** For the settings page: where it is, and how big it has got. */
export function info(): { path: string; bytes: number; threads: number } {
  const current = readV2();
  let bytes = 0;
  try {
    bytes = existsSync(storePath) ? statSync(storePath).size : 0;
  } catch {
    bytes = 0;
  }
  return { path: storePath, bytes, threads: current.threads.length };
}
