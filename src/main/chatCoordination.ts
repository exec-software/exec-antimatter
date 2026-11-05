import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type {
  ChatConnection, ChatCoordinationClaimOptions, ChatCoordinationMessage, ChatCoordinationPeer,
  ChatCoordinationSendOptions, ChatCoordinationState, ChatTranscriptPage, ChatTranscriptReadOptions,
} from '../api/chatCoordination';
import type { ConversationThread } from './conversations';
import { migratePrivateFile, writePrivateFileAtomic } from './privateState';

export const MAX_CHAT_NOTE_BYTES = 8 * 1024;
export const MAX_CHAT_PENDING_NOTES = 64;
export const MAX_CHAT_COORDINATION_MESSAGES = 1000;
const MAX_LINKS = 1000;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_READ_MESSAGES = 32;
const MAX_READ_CHARS = 32 * 1024;
const MAX_MESSAGE_CHARS = 8 * 1024;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

interface StoredMessage extends ChatCoordinationMessage {
  linkId: string;
  clientMessageId: string;
  leaseRunId?: string;
}
interface StoredState { version: 1; links: ChatConnection[]; messages: StoredMessage[] }
export interface ChatCoordinationDependencies {
  threads(): ConversationThread[];
  activeRun(threadId: string): string | null;
  onChanged?(threadIds: string[]): void;
}
interface Scope { threads: Map<string, ConversationThread>; workspaces: Map<string, string | null> }

const clone = <T>(value: T): T => structuredClone(value);
const text = (value: string): string => value.replace(CONTROL, '');
const id = (value: unknown, label = 'Chat identity'): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || text(value) !== value) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
};
const title = (value: string): string => text(value).slice(0, 240);
const bounded = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('The requested page size is invalid.');
  return Math.min(value, maximum);
};
const crop = (value: string, maximum: number): string => {
  const end = maximum > 0 && /[\uD800-\uDBFF]/.test(value[maximum - 1] ?? '') ? maximum - 1 : maximum;
  return value.slice(0, end);
};
export function canonicalChatWorkspace(directory: string | null | undefined): string | null {
  if (!directory || !isAbsolute(directory)) return null;
  try {
    const path = realpathSync(directory);
    return statSync(path).isDirectory() ? path : null;
  } catch { return null; }
}
function publicMessage(message: StoredMessage): ChatCoordinationMessage {
  const { linkId: _link, clientMessageId: _client, leaseRunId: _lease, ...visible } = message;
  return clone(visible);
}

/**
 * Connections and mail are independent of renderer conversation checkpoints. All operations are
 * synchronous compare-and-write boundaries; a grant cannot change halfway through a send.
 */
export class ChatCoordinationStore {
  private stored: StoredState;
  private readonly listeners = new Set<(threadIds: string[]) => void>();

  constructor(private readonly path: string, private readonly dependencies: ChatCoordinationDependencies) {
    this.stored = this.load();
    // A lease means only "being added to this process's turn". After a restart, unacknowledged
    // mail is queued again; stable message IDs let a transcript boundary avoid duplicate intake.
    if (this.stored.messages.some((message) => message.leaseRunId)) {
      const recovered = clone(this.stored);
      for (const message of recovered.messages) delete message.leaseRunId;
      this.commit(recovered, []);
    }
  }

  subscribe(listener: (threadIds: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(next: StoredState, threadIds: string[]): void {
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error('Chat coordination storage is full. Dismiss older notes and try again.');
    writePrivateFileAtomic(this.path, serialized);
    this.stored = next;
    const changed = [...new Set(threadIds)];
    if (!changed.length) return;
    for (const listener of [this.dependencies.onChanged, ...this.listeners]) {
      if (!listener) continue;
      try { listener([...changed]); } catch (error) { console.error('[chat-coordination] change listener failed:', error); }
    }
  }

  private load(): StoredState {
    if (!existsSync(this.path)) return { version: 1, links: [], messages: [] };
    try {
      const stats = lstatSync(this.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STORE_BYTES) throw new Error('invalid file');
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as StoredState;
      if (raw.version !== 1 || !Array.isArray(raw.links) || raw.links.length > MAX_LINKS ||
          !Array.isArray(raw.messages) || raw.messages.length > MAX_CHAT_COORDINATION_MESSAGES) throw new Error('invalid state');
      const linkIds = new Set<string>();
      const pairs = new Set<string>();
      const links = raw.links.map((link): ChatConnection => {
        id(link.id);
        if (!Array.isArray(link.threadIds) || link.threadIds.length !== 2 ||
            id(link.threadIds[0]) >= id(link.threadIds[1]) || typeof link.workspace !== 'string' ||
            link.workspace.length > 4096 || !isAbsolute(link.workspace) || !Number.isFinite(link.createdAt)) throw new Error('invalid connection');
        const pair = JSON.stringify(link.threadIds);
        if (linkIds.has(link.id) || pairs.has(pair)) throw new Error('duplicate connection');
        linkIds.add(link.id); pairs.add(pair);
        return { id: link.id, threadIds: [...link.threadIds], workspace: link.workspace, createdAt: link.createdAt };
      });
      const messageIds = new Set<string>();
      const sendIds = new Set<string>();
      const messages = raw.messages.map((message): StoredMessage => {
        for (const key of ['id', 'sourceThreadId', 'targetThreadId', 'sourceRunId', 'linkId', 'clientMessageId'] as const) id(message[key]);
        if (typeof message.body !== 'string' || !message.body.trim() || Buffer.byteLength(message.body) > MAX_CHAT_NOTE_BYTES ||
            text(message.body) !== message.body || typeof message.sourceTitle !== 'string' || message.sourceTitle.length > 240 ||
            typeof message.targetTitle !== 'string' || message.targetTitle.length > 240 || !Number.isFinite(message.createdAt) ||
            !['queued', 'delivered', 'dismissed'].includes(message.status) ||
            (message.deliveredAt !== undefined && !Number.isFinite(message.deliveredAt))) throw new Error('invalid note');
        if (message.leaseRunId !== undefined) id(message.leaseRunId);
        const sendId = JSON.stringify([message.sourceThreadId, message.sourceRunId, message.clientMessageId]);
        if (messageIds.has(message.id) || sendIds.has(sendId)) throw new Error('duplicate note');
        messageIds.add(message.id); sendIds.add(sendId);
        return {
          id: message.id, sourceThreadId: message.sourceThreadId, targetThreadId: message.targetThreadId,
          sourceTitle: title(message.sourceTitle), targetTitle: title(message.targetTitle), sourceRunId: message.sourceRunId,
          body: message.body, createdAt: message.createdAt, status: message.status,
          linkId: message.linkId, clientMessageId: message.clientMessageId,
          ...(message.deliveredAt === undefined ? {} : { deliveredAt: message.deliveredAt }),
          ...(message.status === 'queued' && message.leaseRunId ? { leaseRunId: message.leaseRunId } : {}),
        };
      });
      migratePrivateFile(this.path);
      return { version: 1, links, messages };
    } catch {
      throw new Error('Chat connections could not be read. The saved file was left unchanged.');
    }
  }

  /** Revoke stale links and dismiss their pending mail before any public operation. */
  private scope(): Scope {
    const threads = new Map(this.dependencies.threads().map((thread) => [thread.id, thread]));
    const workspaces = new Map<string, string | null>();
    const paths = new Map<string, string | null>();
    for (const thread of threads.values()) {
      const raw = thread.directory ?? '';
      if (!paths.has(raw)) paths.set(raw, canonicalChatWorkspace(raw));
      workspaces.set(thread.id, paths.get(raw)!);
    }
    const links = this.stored.links.filter((link) => link.threadIds.every((threadId) => workspaces.get(threadId) === link.workspace));
    const live = new Set(links.map((link) => link.id));
    const changed = this.stored.links.filter((link) => !live.has(link.id)).flatMap((link) => link.threadIds);
    const messages = this.stored.messages.map((message) => {
      if (message.status !== 'queued') return message;
      if (!live.has(message.linkId)) {
        const next = { ...message, status: 'dismissed' as const };
        delete next.leaseRunId;
        changed.push(message.sourceThreadId, message.targetThreadId);
        return next;
      }
      if (message.leaseRunId && this.dependencies.activeRun(message.targetThreadId) !== message.leaseRunId) {
        const next = { ...message };
        delete next.leaseRunId;
        changed.push(message.targetThreadId);
        return next;
      }
      return message;
    });
    if (changed.length) this.commit({ version: 1, links, messages }, changed);
    return { threads, workspaces };
  }

  reconcile(): void { this.scope(); }

  private thread(scope: Scope, threadId: string): ConversationThread {
    const thread = scope.threads.get(id(threadId));
    if (!thread) throw new Error('That chat is no longer available.');
    return thread;
  }

  private connection(scope: Scope, source: string, target: string, expectedLinkId?: string): ChatConnection {
    this.thread(scope, source); this.thread(scope, target);
    if (source === target) throw new Error('Choose another chat to connect.');
    const shared = scope.workspaces.get(source);
    if (!shared || shared !== scope.workspaces.get(target)) throw new Error('Both chats must have the same selected project folder.');
    const link = this.stored.links.find((candidate) => candidate.threadIds.includes(source) && candidate.threadIds.includes(target));
    if (!link || (expectedLinkId !== undefined && link.id !== expectedLinkId)) throw new Error('These chats are not connected. Connect them in the chat connections panel first.');
    return link;
  }

  assertConnection(source: string, target: string, expectedLinkId?: string): ChatConnection {
    return clone(this.connection(this.scope(), source, target, expectedLinkId));
  }

  /** expectedWorkspace must be canonicalized once at runtime creation, never re-resolved here. */
  assertSource(threadId: string, expectedWorkspace: string, runId: string): void {
    const scope = this.scope();
    this.thread(scope, threadId);
    const current = scope.workspaces.get(threadId);
    if (!current || current !== expectedWorkspace) throw new Error('This chat changed project folders. Start a new turn before using chat connections.');
    this.active(threadId, runId);
  }

  state(threadId: string): ChatCoordinationState {
    const scope = this.scope();
    this.thread(scope, threadId);
    const shared = scope.workspaces.get(threadId) ?? null;
    const peers: ChatCoordinationPeer[] = [];
    if (shared) for (const thread of scope.threads.values()) {
      if (thread.id === threadId || scope.workspaces.get(thread.id) !== shared) continue;
      const link = this.stored.links.find((candidate) => candidate.threadIds.includes(threadId) && candidate.threadIds.includes(thread.id));
      peers.push({ id: thread.id, title: title(thread.title), directory: shared, connected: !!link,
        running: this.dependencies.activeRun(thread.id) !== null, ...(link ? { linkId: link.id } : {}) });
    }
    return { threadId, workspace: shared, peers, messages: this.stored.messages
      .filter((message) => message.sourceThreadId === threadId || message.targetThreadId === threadId).map(publicMessage) };
  }

  connectedPeers(source: string): ChatCoordinationPeer[] {
    return this.state(source).peers.filter((peer) => peer.connected);
  }

  connect(source: string, target: string): ChatConnection {
    const scope = this.scope();
    this.thread(scope, source); this.thread(scope, target);
    const shared = scope.workspaces.get(source);
    if (source === target) throw new Error('Choose another chat to connect.');
    if (!shared || shared !== scope.workspaces.get(target)) throw new Error('Both chats must have the same selected project folder.');
    const previous = this.stored.links.find((link) => link.threadIds.includes(source) && link.threadIds.includes(target));
    if (previous) return clone(previous);
    if (this.stored.links.length >= MAX_LINKS) throw new Error('There are too many chat connections. Disconnect an unused pair first.');
    const link: ChatConnection = { id: randomUUID(), threadIds: [source, target].sort() as [string, string], workspace: shared, createdAt: Date.now() };
    this.commit({ ...this.stored, links: [...this.stored.links, link] }, [source, target]);
    return clone(link);
  }

  disconnect(source: string, target: string): void {
    const scope = this.scope();
    this.thread(scope, source); id(target);
    const links = this.stored.links.filter((link) => !(link.threadIds.includes(source) && link.threadIds.includes(target)));
    if (links.length === this.stored.links.length) return;
    const live = new Set(links.map((link) => link.id));
    const messages = this.stored.messages.map((message) => {
      if (message.status !== 'queued' || live.has(message.linkId)) return message;
      const dismissed = { ...message, status: 'dismissed' as const };
      delete dismissed.leaseRunId;
      return dismissed;
    });
    this.commit({ ...this.stored, links, messages }, [source, target]);
  }

  read(source: string, target: string, options: ChatTranscriptReadOptions = {}): ChatTranscriptPage {
    const scope = this.scope();
    this.connection(scope, source, target);
    const thread = this.thread(scope, target);
    const limit = bounded(options.limit, 16, MAX_READ_MESSAGES);
    const maxChars = bounded(options.maxChars, MAX_READ_CHARS, MAX_READ_CHARS);
    const visible = thread.messages.filter((message) => message.role === 'user' || message.role === 'assistant');
    const end = options.before === undefined ? visible.length : visible.findIndex((message) => message.id === id(options.before, 'Transcript cursor'));
    if (end < 0) throw new Error('That transcript page is no longer available. Refresh the chat and try again.');
    const messages: ChatTranscriptPage['messages'] = [];
    let remaining = maxChars;
    let index = end - 1;
    for (; index >= 0 && messages.length < limit && remaining > 0; index -= 1) {
      const message = visible[index];
      // Slice before sanitizing: a stored chat can contain a multi-megabyte visible message.
      const ceiling = Math.min(remaining, MAX_MESSAGE_CHARS);
      const content = text(crop(message.content, ceiling));
      messages.unshift({ id: message.id, role: message.role as 'user' | 'assistant', content,
        createdAt: message.meta.createdAt, truncated: message.content.length > ceiling });
      remaining -= content.length;
    }
    return { threadId: target, title: title(thread.title), messages,
      nextBefore: index >= 0 && messages.length ? messages[0].id : null,
      truncated: index >= 0 || messages.some((message) => message.truncated) };
  }

  private active(threadId: string, runId: string): void {
    id(runId, 'Turn identity');
    if (this.dependencies.activeRun(threadId) !== runId) throw new Error('That chat turn is no longer active.');
  }

  send(source: string, target: string, body: string, options: ChatCoordinationSendOptions): ChatCoordinationMessage {
    const scope = this.scope();
    const link = this.connection(scope, source, target, options.expectedLinkId);
    this.active(source, options.runId);
    id(options.clientMessageId, 'Message occurrence');
    if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > MAX_CHAT_NOTE_BYTES) throw new Error('A chat note must contain between 1 character and 8 KiB of text.');
    const clean = text(body);
    if (!clean.trim()) throw new Error('The chat note is empty.');
    const previous = this.stored.messages.find((message) => message.sourceThreadId === source &&
      message.sourceRunId === options.runId && message.clientMessageId === options.clientMessageId);
    if (previous) {
      if (previous.targetThreadId !== target || previous.body !== clean || previous.linkId !== link.id) throw new Error('That message occurrence was already used for another note.');
      return publicMessage(previous);
    }
    if (this.stored.messages.filter((message) => message.targetThreadId === target && message.status === 'queued').length >= MAX_CHAT_PENDING_NOTES) {
      throw new Error('That chat already has 64 pending notes. Wait for delivery or dismiss older notes first.');
    }
    const messages = [...this.stored.messages];
    while (messages.length >= MAX_CHAT_COORDINATION_MESSAGES) {
      // Keep a live sender's occurrence records even after delivery: otherwise retention could
      // turn a retried tool call in that same run into a second send.
      const oldest = messages.findIndex((message) => message.status !== 'queued' &&
        this.dependencies.activeRun(message.sourceThreadId) !== message.sourceRunId);
      if (oldest < 0) throw new Error('The chat note queue is full. Deliver or dismiss pending notes first.');
      messages.splice(oldest, 1);
    }
    const message: StoredMessage = { id: randomUUID(), sourceThreadId: source, targetThreadId: target,
      sourceTitle: title(this.thread(scope, source).title), targetTitle: title(this.thread(scope, target).title),
      sourceRunId: options.runId, body: clean, createdAt: Date.now(), status: 'queued', linkId: link.id,
      clientMessageId: options.clientMessageId };
    messages.push(message);
    this.commit({ ...this.stored, messages }, [source, target]);
    return publicMessage(message);
  }

  pendingCount(target: string): number {
    const scope = this.scope(); this.thread(scope, target);
    return this.stored.messages.filter((message) => message.targetThreadId === target && message.status === 'queued').length;
  }

  claim(target: string, runId: string, options: ChatCoordinationClaimOptions = {}): ChatCoordinationMessage[] {
    const scope = this.scope(); this.thread(scope, target); this.active(target, runId);
    const limit = bounded(options.limit, 8, MAX_CHAT_PENDING_NOTES);
    const maxChars = bounded(options.maxChars, MAX_READ_CHARS, MAX_READ_CHARS);
    const selected: StoredMessage[] = [];
    let chars = 0;
    for (const message of this.stored.messages) {
      if (message.targetThreadId !== target || message.status !== 'queued' || (message.leaseRunId && message.leaseRunId !== runId)) continue;
      this.connection(scope, message.sourceThreadId, target, message.linkId);
      if (selected.length >= limit || chars + message.body.length > maxChars) break;
      chars += message.body.length;
      selected.push(message);
    }
    const fresh = new Set(selected.filter((message) => !message.leaseRunId).map((message) => message.id));
    if (fresh.size) this.commit({ ...this.stored,
      messages: this.stored.messages.map((message) => fresh.has(message.id) ? { ...message, leaseRunId: runId } : message),
    }, [target]);
    return selected.map(publicMessage);
  }

  ack(target: string, runId: string, ids: string[]): void {
    const scope = this.scope(); this.thread(scope, target); this.active(target, runId);
    if (!Array.isArray(ids) || ids.length > MAX_CHAT_PENDING_NOTES) throw new Error('The delivery receipt is invalid.');
    const selected = new Set(ids.map((value) => id(value, 'Note identity')));
    for (const messageId of selected) {
      const message = this.stored.messages.find((candidate) => candidate.id === messageId);
      if (!message || message.targetThreadId !== target || message.status !== 'queued' || message.leaseRunId !== runId) throw new Error('That note is no longer reserved for this turn.');
      this.connection(scope, message.sourceThreadId, target, message.linkId);
    }
    if (!selected.size) return;
    const changed = [target];
    const messages = this.stored.messages.map((message) => {
      if (!selected.has(message.id)) return message;
      const delivered = { ...message, status: 'delivered' as const, deliveredAt: Date.now() };
      delete delivered.leaseRunId;
      changed.push(message.sourceThreadId);
      return delivered;
    });
    this.commit({ ...this.stored, messages }, changed);
  }

  release(runId: string): void {
    id(runId, 'Turn identity'); this.scope();
    const changed: string[] = [];
    const messages = this.stored.messages.map((message) => {
      if (message.leaseRunId !== runId) return message;
      const released = { ...message };
      delete released.leaseRunId;
      changed.push(message.targetThreadId);
      return released;
    });
    if (changed.length) this.commit({ ...this.stored, messages }, changed);
  }

  dismiss(target: string, messageId: string): void {
    const scope = this.scope(); this.thread(scope, target); id(messageId, 'Note identity');
    const message = this.stored.messages.find((candidate) => candidate.id === messageId && candidate.targetThreadId === target);
    if (!message) throw new Error('That received note is no longer available.');
    if (message.status !== 'queued') return;
    const dismissed = { ...message, status: 'dismissed' as const };
    delete dismissed.leaseRunId;
    this.commit({ ...this.stored, messages: this.stored.messages.map((candidate) => candidate.id === messageId ? dismissed : candidate) }, [message.sourceThreadId, target]);
  }
}
