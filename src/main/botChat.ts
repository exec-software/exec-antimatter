import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import {
  BOT_CHAT_LIMITS, type BotChatChange, type BotChatChannel, type BotChatChannelInput,
  type BotChatChannelPatch, type BotChatHumanPost, type BotChatMessage, type BotChatPage,
  type BotChatPostOptions, type BotChatReadOptions, type BotChatState, type BotChatTarget,
} from '../api/botChat';
import { canonicalChatWorkspace } from './chatCoordination';
import type { ConversationThread } from './conversations';
import { migratePrivateFile, writePrivateFileAtomic } from './privateState';

const MAX_STORE_BYTES = 96 * 1024 * 1024;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const clone = <T>(value: T): T => structuredClone(value);
const clean = (value: string): string => value.replace(CONTROL, '');
const title = (value: string): string => clean(value).slice(0, 240);
const validId = (value: unknown, label = 'Identity'): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || clean(value) !== value) throw new Error(`${label} is invalid.`);
  return value;
};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const bounded = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined) return fallback;
  if (!positive(value)) throw new Error('The requested page size is invalid.');
  return Math.min(value, maximum);
};
const crop = (value: string, maximum: number): string => value.slice(0,
  /[\uD800-\uDBFF]/.test(value[maximum - 1] ?? '') ? maximum - 1 : maximum);
const channelName = (value: string): string => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Channel names need 1–64 lowercase letters, numbers, underscores or hyphens.');
  return value;
};
const description = (value: string): string => {
  if (typeof value !== 'string' || value.length > BOT_CHAT_LIMITS.descriptionLength) throw new Error('Channel descriptions can contain at most 500 characters.');
  return clean(value);
};
/**
 * The display name an outside agent gives itself.
 *
 * It carries no authority: nothing verifies that the sender is who it says, and
 * the inbox is writable by anything that can write to the user's config
 * directory. The name exists so a reader can tell two outside agents apart, not
 * so anyone can trust one. Impersonating the person or an Antimatter agent is
 * prevented by the sender *kind*, which the inbox cannot choose, rather than by
 * this.
 */
const externalName = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('An outside sender needs a name.');
  const result = clean(value).slice(0, 64).trim();
  if (!result) throw new Error('An outside sender needs a name.');
  return result;
};
const bodyText = (value: string): string => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > BOT_CHAT_LIMITS.bodyBytes) throw new Error('Public messages can contain at most 8 KiB of text.');
  const result = clean(value);
  if (!result.trim()) throw new Error('Write a message before posting.');
  return result;
};

type ThreadMetadata = Pick<ConversationThread, 'id' | 'title' | 'directory'>;
interface Participant { id: string; threadId: string; title: string; workspace: string | null; enrolledAt: number }
interface Mention {
  threadId: string; participantId: string; status: 'queued' | 'delivered' | 'dismissed';
  leaseRunId?: string; deliveredAt?: number;
}
interface StoredMessage extends BotChatMessage {
  clientMessageId: string;
  requestHash: string;
  sourceWorkspace?: string | null;
  mentions: Mention[];
}
interface StoredState {
  version: 1; enabled: boolean; generation: number; nextSequence: number;
  channels: BotChatChannel[]; participants: Participant[]; messages: StoredMessage[];
}
export interface BotChatDependencies {
  threads(): ThreadMetadata[];
  activeRun(threadId: string): string | null;
  onChanged?(event: BotChatChange): void;
}
interface Scope { threads: Map<string, ThreadMetadata>; workspaces: Map<string, string | null> }
interface ChannelGuard { posting?: boolean; expectedGeneration?: number; expectedRevision?: number }

function publicMessage(message: StoredMessage): BotChatMessage {
  const { clientMessageId: _client, requestHash: _hash, sourceWorkspace: _workspace, mentions: _mentions, ...visible } = message;
  return clone(visible);
}

/** Explicitly public posts live separately from private conversation checkpoints and imports. */
export class BotChatStore {
  private stored: StoredState;
  private readonly listeners = new Set<(event: BotChatChange) => void>();

  constructor(private readonly path: string, private readonly dependencies: BotChatDependencies) {
    this.stored = this.load();
    if (this.stored.messages.some((message) => message.mentions.some((mention) => mention.leaseRunId))) {
      const next = clone(this.stored);
      for (const message of next.messages) for (const mention of message.mentions) delete mention.leaseRunId;
      this.commit(next, [], []);
    }
  }

  enabled(): boolean { return this.stored.enabled; }
  subscribe(listener: (event: BotChatChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(next: StoredState, channelIds: string[], threadIds: string[], settingsChanged = false): void {
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error('Public Bot chat storage is full.');
    writePrivateFileAtomic(this.path, serialized);
    this.stored = next;
    const event = { channelIds: [...new Set(channelIds)], threadIds: [...new Set(threadIds)], settingsChanged };
    for (const listener of [this.dependencies.onChanged, ...this.listeners]) {
      if (listener) try { listener(clone(event)); } catch (error) { console.error('[bot-chat] change listener failed:', error); }
    }
  }

  private load(): StoredState {
    const empty: StoredState = { version: 1, enabled: false, generation: 0, nextSequence: 1, channels: [], participants: [], messages: [] };
    if (!existsSync(this.path)) return empty;
    try {
      const stats = lstatSync(this.path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STORE_BYTES) throw new Error('invalid file');
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as StoredState;
      if (raw.version !== 1 || typeof raw.enabled !== 'boolean' || !Number.isSafeInteger(raw.generation) || raw.generation < 0 ||
          !positive(raw.nextSequence) || !Array.isArray(raw.channels) || raw.channels.length > BOT_CHAT_LIMITS.channels ||
          !Array.isArray(raw.participants) || raw.participants.length > BOT_CHAT_LIMITS.participants ||
          !Array.isArray(raw.messages) || raw.messages.length > BOT_CHAT_LIMITS.messages) throw new Error('invalid state');
      const channelIds = new Set<string>(); const channelNames = new Set<string>();
      const channels = raw.channels.map((channel): BotChatChannel => {
        validId(channel.id); channelName(channel.name); description(channel.description);
        if (channelIds.has(channel.id) || channelNames.has(channel.name) || typeof channel.archived !== 'boolean' ||
            typeof channel.postingPaused !== 'boolean' || !Number.isFinite(channel.createdAt) || !positive(channel.revision)) throw new Error('invalid channel');
        channelIds.add(channel.id); channelNames.add(channel.name);
        return { id: channel.id, name: channel.name, description: description(channel.description), archived: channel.archived,
          postingPaused: channel.postingPaused, createdAt: channel.createdAt, revision: channel.revision };
      });
      const workspace = (value: unknown): value is string | null => value === null ||
        (typeof value === 'string' && value.length <= 4096 && isAbsolute(value));
      const participantIds = new Set<string>(); const participantThreads = new Set<string>();
      const participants = raw.participants.map((participant): Participant => {
        validId(participant.id); validId(participant.threadId);
        if (participantIds.has(participant.id) || participantThreads.has(participant.threadId) ||
            typeof participant.title !== 'string' || participant.title.length > 240 || !workspace(participant.workspace) ||
            !Number.isFinite(participant.enrolledAt)) throw new Error('invalid participant');
        participantIds.add(participant.id); participantThreads.add(participant.threadId);
        return { id: participant.id, threadId: participant.threadId, title: title(participant.title),
          workspace: participant.workspace, enrolledAt: participant.enrolledAt };
      });
      const messageIds = new Set<string>(); const occurrenceIds = new Set<string>(); const sequences = new Set<number>();
      const pending = new Map<string, number>();
      const messages = raw.messages.map((message): StoredMessage => {
        validId(message.id); validId(message.clientMessageId);
        if (!channelIds.has(message.channelId) || messageIds.has(message.id) || !positive(message.sequence) ||
            message.sequence >= raw.nextSequence || sequences.has(message.sequence) || !Number.isFinite(message.createdAt) ||
            !/^[a-f0-9]{64}$/.test(message.requestHash) || !Array.isArray(message.mentions) ||
            message.mentions.length > BOT_CHAT_LIMITS.mentions || !Array.isArray(message.mentionThreadIds) ||
            message.mentionThreadIds.length > BOT_CHAT_LIMITS.mentions) throw new Error('invalid message');
        if (message.redactedAt !== undefined ? !Number.isFinite(message.redactedAt) || message.body !== '' : bodyText(message.body) !== message.body) throw new Error('invalid body');
        let sender: BotChatMessage['sender'];
        if (message.sender.kind === 'agent') {
          validId(message.sender.threadId); validId(message.sender.runId);
          if (typeof message.sender.title !== 'string' || message.sender.title.length > 240 || !workspace(message.sourceWorkspace) ||
              message.sender.workspace !== (message.sourceWorkspace ? title(basename(message.sourceWorkspace)) : null)) throw new Error('invalid sender');
          sender = { kind: 'agent', threadId: message.sender.threadId, runId: message.sender.runId,
            title: title(message.sender.title), workspace: message.sender.workspace };
        } else if (message.sender.kind === 'human' && message.sender.name === 'You') sender = { kind: 'human', name: 'You' };
        else if (message.sender.kind === 'external') sender = { kind: 'external', name: externalName(message.sender.name) };
        else throw new Error('invalid sender');
        const occurrence = JSON.stringify([sender.kind, sender.kind === 'agent' ? sender.threadId : '', sender.kind === 'agent' ? sender.runId : '',
          sender.kind === 'external' ? sender.name : '', message.clientMessageId]);
        if (occurrenceIds.has(occurrence)) throw new Error('duplicate occurrence');
        occurrenceIds.add(occurrence); messageIds.add(message.id); sequences.add(message.sequence);
        const targets = new Set<string>();
        const mentions = message.mentions.map((mention): Mention => {
          validId(mention.threadId); validId(mention.participantId);
          if (targets.has(mention.threadId) || !['queued', 'delivered', 'dismissed'].includes(mention.status) ||
              (mention.deliveredAt !== undefined && !Number.isFinite(mention.deliveredAt))) throw new Error('invalid mention');
          if (mention.leaseRunId !== undefined) validId(mention.leaseRunId);
          targets.add(mention.threadId);
          if (mention.status === 'queued') pending.set(mention.threadId, (pending.get(mention.threadId) ?? 0) + 1);
          return { threadId: mention.threadId, participantId: mention.participantId, status: mention.status,
            ...(mention.status === 'queued' && mention.leaseRunId ? { leaseRunId: mention.leaseRunId } : {}),
            ...(mention.deliveredAt === undefined ? {} : { deliveredAt: mention.deliveredAt }) };
        });
        if (message.mentionThreadIds.length !== targets.size || message.mentionThreadIds.some((target) => !targets.delete(target))) throw new Error('invalid mention list');
        if (message.replyTo !== undefined) validId(message.replyTo);
        if (message.moderationReason !== undefined && (typeof message.moderationReason !== 'string' || message.moderationReason.length > 500)) throw new Error('invalid moderation');
        return { id: message.id, channelId: message.channelId, sender, body: message.body,
          mentionThreadIds: [...message.mentionThreadIds], createdAt: message.createdAt, sequence: message.sequence,
          clientMessageId: message.clientMessageId, requestHash: message.requestHash, mentions,
          ...(sender.kind === 'agent' ? { sourceWorkspace: message.sourceWorkspace } : {}),
          ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
          ...(message.redactedAt === undefined ? {} : { redactedAt: message.redactedAt }),
          ...(message.moderationReason === undefined ? {} : { moderationReason: clean(message.moderationReason) }) };
      });
      if ([...pending.values()].some((count) => count > BOT_CHAT_LIMITS.pendingPerTarget)) throw new Error('too many mentions');
      messages.sort((a, b) => a.sequence - b.sequence);
      migratePrivateFile(this.path);
      return { version: 1, enabled: raw.enabled, generation: raw.generation, nextSequence: raw.nextSequence, channels, participants, messages };
    } catch { throw new Error('Public Bot chat could not be read. The saved file was left unchanged.'); }
  }

  private scope(threadIds = this.stored.participants.map((participant) => participant.threadId)): Scope {
    const threads = new Map(this.dependencies.threads().map((thread) => [thread.id, thread]));
    const workspaces = new Map<string, string | null>();
    const paths = new Map<string, string | null>();
    for (const threadId of threadIds) {
      const thread = threads.get(threadId);
      if (!thread) continue;
      const directory = thread.directory ?? '';
      if (!paths.has(directory)) paths.set(directory, canonicalChatWorkspace(directory));
      workspaces.set(thread.id, paths.get(directory)!);
    }
    return { threads, workspaces };
  }

  reconcile(): void {
    const scope = this.scope();
    const participants = this.stored.participants.filter((participant) =>
      scope.threads.has(participant.threadId) && scope.workspaces.get(participant.threadId) === participant.workspace &&
      (!scope.threads.get(participant.threadId)!.directory || participant.workspace !== null));
    const live = new Set(participants.map((participant) => participant.id));
    const changed = this.stored.participants.filter((participant) => !live.has(participant.id)).map((participant) => participant.threadId);
    const updates: { message: number; mention: number; dismiss: boolean }[] = [];
    const channels: string[] = [];
    for (const [messageIndex, message] of this.stored.messages.entries()) for (const [mentionIndex, mention] of message.mentions.entries()) {
      if (mention.status !== 'queued') continue;
      if (!live.has(mention.participantId) || message.redactedAt !== undefined || this.stored.channels.find((channel) => channel.id === message.channelId)?.archived) {
        updates.push({ message: messageIndex, mention: mentionIndex, dismiss: true });
        changed.push(mention.threadId); channels.push(message.channelId);
      } else if (mention.leaseRunId && this.dependencies.activeRun(mention.threadId) !== mention.leaseRunId) {
        updates.push({ message: messageIndex, mention: mentionIndex, dismiss: false }); changed.push(mention.threadId);
      }
    }
    if (changed.length) {
      const next = clone(this.stored); next.participants = participants;
      for (const update of updates) {
        const mention = next.messages[update.message].mentions[update.mention];
        if (update.dismiss) mention.status = 'dismissed';
        delete mention.leaseRunId;
      }
      this.commit(next, channels, changed);
    }
  }

  assertEnabled(expectedGeneration?: number): number {
    if (!this.stored.enabled) throw new Error('Public Bot chat is disabled. Enable it in Settings to use public channels.');
    if (expectedGeneration !== undefined && expectedGeneration !== this.stored.generation) throw new Error('Public Bot chat settings changed. Retry the operation.');
    return this.stored.generation;
  }

  /** expectedWorkspace was canonicalized once when the host created this run. */
  assertSource(threadId: string, runId: string, expectedWorkspace?: string | null): void {
    this.assertEnabled(); validId(threadId); validId(runId);
    const scope = this.scope([threadId]);
    if (!scope.threads.has(threadId)) throw new Error('That chat is no longer available.');
    if ((scope.threads.get(threadId)!.directory && !scope.workspaces.get(threadId)) ||
        (expectedWorkspace !== undefined && scope.workspaces.get(threadId) !== expectedWorkspace)) throw new Error('This chat changed project folders. Start a new turn before using public channels.');
    if (this.dependencies.activeRun(threadId) !== runId) throw new Error('This chat turn is no longer active.');
  }

  assertChannel(channelId: string, options: ChannelGuard = {}): BotChatChannel {
    this.assertEnabled(options.expectedGeneration);
    const channel = this.channel(channelId);
    if (channel.archived) throw new Error('This public channel is archived.');
    if (options.expectedRevision !== undefined && options.expectedRevision !== channel.revision) throw new Error('This public channel changed. Retry the operation.');
    if (options.posting && channel.postingPaused) throw new Error('Posting is paused in this public channel.');
    return clone(channel);
  }

  private channel(channelId: string): BotChatChannel {
    const channel = this.stored.channels.find((candidate) => candidate.id === validId(channelId, 'Channel'));
    if (!channel) throw new Error('That public channel is no longer available.');
    return channel;
  }

  private enrollment(next: StoredState, threadId: string, scope: Scope): void {
    const thread = scope.threads.get(threadId)!;
    const existing = next.participants.find((participant) => participant.threadId === threadId);
    if (existing) { existing.title = title(thread.title); return; }
    if (next.participants.length >= BOT_CHAT_LIMITS.participants) throw new Error('Public Bot chat has reached its participant limit.');
    next.participants.push({ id: randomUUID(), threadId, title: title(thread.title), workspace: scope.workspaces.get(threadId) ?? null, enrolledAt: Date.now() });
  }

  /** Only explicit successful public tool use enrolls a chat, never tool advertisement. */
  enroll(threadId: string, runId: string, expectedWorkspace?: string | null): void {
    this.assertSource(threadId, runId, expectedWorkspace); this.reconcile();
    const next = clone(this.stored); this.enrollment(next, threadId, this.scope([threadId]));
    if (JSON.stringify(next.participants) !== JSON.stringify(this.stored.participants)) this.commit(next, [], [threadId]);
  }

  private targets(): BotChatTarget[] {
    return this.stored.participants.map((participant) => ({ id: participant.threadId, title: participant.title,
      workspace: participant.workspace ? title(basename(participant.workspace)) : null,
      running: Boolean(this.dependencies.activeRun(participant.threadId)) }));
  }
  state(): BotChatState {
    this.reconcile();
    return clone({ enabled: this.stored.enabled, generation: this.stored.generation, channels: this.stored.channels, targets: this.targets() });
  }
  listChannels(): BotChatChannel[] { this.assertEnabled(); return clone(this.stored.channels.filter((channel) => !channel.archived)); }
  listTargets(): BotChatTarget[] { this.assertEnabled(); this.reconcile(); return clone(this.targets()); }

  configure(settings: { enabled: boolean }): BotChatState {
    if (!settings || typeof settings !== 'object' || typeof settings.enabled !== 'boolean') throw new Error('Choose whether Public Bot chat is enabled.');
    if (settings.enabled === this.stored.enabled) return this.state();
    const next = clone(this.stored); next.enabled = settings.enabled; next.generation += 1;
    if (settings.enabled && next.channels.length === 0) next.channels.push({ id: randomUUID(), name: 'general', description: '', archived: false, postingPaused: false, createdAt: Date.now(), revision: 1 });
    for (const message of next.messages) for (const mention of message.mentions) delete mention.leaseRunId;
    this.commit(next, next.channels.map((channel) => channel.id), next.participants.map((participant) => participant.threadId), true);
    return this.state();
  }

  createChannel(input: BotChatChannelInput): BotChatChannel {
    if (!input || typeof input !== 'object') throw new Error('Channel settings are invalid.');
    const name = channelName(input.name); const details = description(input.description ?? '');
    if (this.stored.channels.length >= BOT_CHAT_LIMITS.channels) throw new Error('Public Bot chat supports at most 100 channels.');
    if (this.stored.channels.some((channel) => channel.name === name)) throw new Error('A channel already has that name.');
    const channel: BotChatChannel = { id: randomUUID(), name, description: details, archived: false, postingPaused: false, createdAt: Date.now(), revision: 1 };
    const next = clone(this.stored); next.channels.push(channel); this.commit(next, [channel.id], []);
    return clone(channel);
  }

  updateChannel(channelId: string, patch: BotChatChannelPatch): BotChatChannel {
    if (!patch || typeof patch !== 'object') throw new Error('Channel settings are invalid.');
    const old = this.channel(channelId);
    const next = clone(this.stored); const channel = next.channels.find((candidate) => candidate.id === old.id)!;
    if (patch.name !== undefined) channel.name = channelName(patch.name);
    if (next.channels.some((candidate) => candidate.id !== channelId && candidate.name === channel.name)) throw new Error('A channel already has that name.');
    if (patch.description !== undefined) channel.description = description(patch.description);
    for (const key of ['archived', 'postingPaused'] as const) if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'boolean') throw new Error('Channel settings are invalid.');
      channel[key] = patch[key];
    }
    channel.revision += 1;
    const targets: string[] = [];
    if (channel.archived) for (const message of next.messages) if (message.channelId === channelId) for (const mention of message.mentions) if (mention.status === 'queued') {
      mention.status = 'dismissed'; delete mention.leaseRunId; targets.push(mention.threadId);
    }
    this.commit(next, [channelId], targets);
    return clone(channel);
  }

  read(channelId: string, options: BotChatReadOptions = {}): BotChatPage {
    this.assertChannel(channelId); return this.readHistory(channelId, options);
  }
  /** Trusted UI can inspect history even while the feature or channel is disabled. */
  readHistory(channelId: string, options: BotChatReadOptions = {}): BotChatPage {
    if (!options || typeof options !== 'object') throw new Error('History options are invalid.');
    const channel = this.channel(channelId);
    const limit = bounded(options.limit, 50, BOT_CHAT_LIMITS.pageMessages);
    const maxChars = bounded(options.maxChars, BOT_CHAT_LIMITS.pageChars, BOT_CHAT_LIMITS.pageChars);
    if (options.before !== undefined && !positive(options.before)) throw new Error('The history cursor is invalid.');
    const candidates = this.stored.messages.filter((message) => message.channelId === channelId && (options.before === undefined || message.sequence < options.before));
    const messages: BotChatMessage[] = []; let characters = 0; let truncated = false;
    for (let index = candidates.length - 1; index >= 0 && messages.length < limit; index -= 1) {
      const message = publicMessage(candidates[index]);
      if (characters + message.body.length > maxChars) {
        if (messages.length) break;
        message.body = crop(message.body, maxChars); message.truncated = true; truncated = true;
      }
      messages.unshift(message); characters += message.body.length;
      if (characters >= maxChars) break;
    }
    const oldest = messages[0]?.sequence;
    return clone({ channel, messages, nextBefore: oldest !== undefined && candidates.some((message) => message.sequence < oldest) ? oldest : null, truncated });
  }

  post(threadId: string, channelId: string, body: string, options: BotChatPostOptions): BotChatMessage {
    if (!options || typeof options !== 'object') throw new Error('Public post options are invalid.');
    this.assertSource(threadId, options.runId, options.expectedWorkspace);
    this.assertChannel(channelId, { posting: true, expectedGeneration: options.expectedGeneration, expectedRevision: options.expectedChannelRevision });
    this.reconcile(); const scope = this.scope([threadId]); const thread = scope.threads.get(threadId)!;
    const workspace = scope.workspaces.get(threadId) ?? null;
    return this.addMessage(channelId, body, options, { kind: 'agent', threadId, runId: options.runId,
      title: title(thread.title), workspace: workspace ? title(basename(workspace)) : null }, workspace, scope);
  }

  postHuman(channelId: string, body: string, options: Omit<BotChatHumanPost, 'body'>): BotChatMessage {
    if (!options || typeof options !== 'object') throw new Error('Public post options are invalid.');
    this.assertChannel(channelId, { posting: true }); this.reconcile();
    return this.addMessage(channelId, body, options, { kind: 'human', name: 'You' });
  }

  /**
   * A message from an agent running outside Antimatter, delivered through the
   * inbox. It takes the same path as every other post -- the same body limits,
   * the same mention caps, the same duplicate rule -- because a second way in
   * is a second thing to get wrong.
   *
   * The caller supplies the name. It cannot supply the kind, so nothing
   * arriving this way can present itself as the person or as a local agent.
   */
  postExternal(channelId: string, body: string, name: string, options: Omit<BotChatHumanPost, 'body'>): BotChatMessage {
    if (!options || typeof options !== 'object') throw new Error('Public post options are invalid.');
    this.assertChannel(channelId, { posting: true }); this.reconcile();
    return this.addMessage(channelId, body, options, { kind: 'external', name: externalName(name) });
  }

  private addMessage(channelId: string, body: string, options: Omit<BotChatHumanPost, 'body'>,
    sender: BotChatMessage['sender'], sourceWorkspace?: string | null, scope?: Scope): BotChatMessage {
    validId(options.clientMessageId, 'Message occurrence'); const content = bodyText(body);
    if (options.mentionThreadIds !== undefined && (!Array.isArray(options.mentionThreadIds) || options.mentionThreadIds.length > BOT_CHAT_LIMITS.mentions)) throw new Error('Mention at most 64 public participants.');
    const mentionThreadIds = [...new Set((options.mentionThreadIds ?? []).map((target) => validId(target)))].sort();
    if (options.replyTo !== undefined) validId(options.replyTo);
    const requestHash = createHash('sha256').update(JSON.stringify([channelId, content, options.replyTo ?? null, mentionThreadIds])).digest('hex');
    // Matched per kind rather than "human, or else agent". With a third kind
    // that shorthand reads an outside sender as an agent and compares a
    // threadId it does not have.
    const sameSender = (other: BotChatMessage['sender']): boolean => {
      if (other.kind !== sender.kind) return false;
      if (sender.kind === 'agent') return other.kind === 'agent' && other.threadId === sender.threadId && other.runId === sender.runId;
      if (sender.kind === 'external') return other.kind === 'external' && other.name === sender.name;
      return true; // there is one person, so a human occurrence identifies itself
    };
    const duplicate = this.stored.messages.find((message) =>
      message.clientMessageId === options.clientMessageId && sameSender(message.sender));
    if (duplicate) {
      if (duplicate.requestHash !== requestHash) throw new Error('This message occurrence was already used for different content.');
      return publicMessage(duplicate);
    }
    if (options.replyTo !== undefined && !this.stored.messages.some((message) => message.id === options.replyTo && message.channelId === channelId && message.redactedAt === undefined)) throw new Error('Reply to an available message in this channel.');
    const mentions: Mention[] = mentionThreadIds.map((threadId) => {
      const participant = this.stored.participants.find((candidate) => candidate.threadId === threadId);
      if (!participant) throw new Error('Mentions can only target a current public participant.');
      const pending = this.stored.messages.filter((message) => message.mentions.some((mention) => mention.threadId === threadId && mention.status === 'queued')).length;
      if (pending >= BOT_CHAT_LIMITS.pendingPerTarget) throw new Error('That public participant already has 64 pending mentions.');
      return { threadId, participantId: participant.id, status: 'queued' };
    });
    const next = clone(this.stored);
    if (sender.kind === 'agent') this.enrollment(next, sender.threadId, scope!);
    if (next.messages.length >= BOT_CHAT_LIMITS.messages) {
      const removable = next.messages.findIndex((message) => !message.mentions.some((mention) => mention.status === 'queued') &&
        (message.sender.kind !== 'agent' || this.dependencies.activeRun(message.sender.threadId) !== message.sender.runId));
      if (removable < 0) throw new Error('Public Bot chat retention is full of active messages. Try again after active turns finish.');
      next.messages.splice(removable, 1);
    }
    if (!positive(next.nextSequence + 1)) throw new Error('Public Bot chat has reached its sequence limit.');
    const message: StoredMessage = { id: randomUUID(), channelId, sender: clone(sender), body: content,
      mentionThreadIds, createdAt: Date.now(), sequence: next.nextSequence++, clientMessageId: options.clientMessageId,
      requestHash, mentions, ...(sender.kind === 'agent' ? { sourceWorkspace } : {}),
      ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }) };
    next.messages.push(message); this.commit(next, [channelId], [...mentionThreadIds, ...(sender.kind === 'agent' ? [sender.threadId] : [])]);
    return publicMessage(message);
  }

  moderate(channelId: string, messageId: string, reason?: string): void {
    this.channel(channelId); validId(messageId);
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) throw new Error('Moderation notes can contain at most 500 characters.');
    const next = clone(this.stored); const message = next.messages.find((candidate) => candidate.id === messageId && candidate.channelId === channelId);
    if (!message) throw new Error('That public message is no longer available.');
    if (message.redactedAt !== undefined) return;
    message.body = ''; message.redactedAt = Date.now();
    if (reason?.trim()) message.moderationReason = clean(reason);
    for (const mention of message.mentions) if (mention.status === 'queued') { mention.status = 'dismissed'; delete mention.leaseRunId; }
    this.commit(next, [channelId], message.mentionThreadIds);
  }

  pendingCount(threadId: string, excludeIds: string[] = []): number {
    validId(threadId); if (!this.enabled()) return 0; this.reconcile();
    const excluded = new Set(excludeIds);
    return this.stored.messages.filter((message) => !excluded.has(message.id) && message.mentions.some((mention) =>
      mention.threadId === threadId && mention.status === 'queued' && !mention.leaseRunId)).length;
  }

  claimMentions(threadId: string, runId: string, options: { limit?: number; maxChars?: number } = {}): BotChatMessage[] {
    this.assertSource(threadId, runId); this.reconcile();
    const limit = bounded(options.limit, 8, 8); const maxChars = bounded(options.maxChars, 32768, 32768);
    const next = clone(this.stored); const claimed: BotChatMessage[] = []; let characters = 0;
    for (const message of next.messages) {
      const mention = message.mentions.find((candidate) => candidate.threadId === threadId && candidate.status === 'queued' && !candidate.leaseRunId);
      if (!mention) continue;
      if (claimed.length >= limit || characters + message.body.length > maxChars) break;
      mention.leaseRunId = runId; claimed.push(publicMessage(message)); characters += message.body.length;
    }
    if (claimed.length) this.commit(next, claimed.map((message) => message.channelId), [threadId]);
    return claimed;
  }

  /** Delivered means checkpointed into a turn; it does not claim that a model read the note. */
  ackMentions(threadId: string, runId: string, messageIds: string[]): void {
    this.assertSource(threadId, runId); this.reconcile();
    if (!Array.isArray(messageIds) || messageIds.length > 64) throw new Error('The mention acknowledgement is invalid.');
    const ids = new Set(messageIds.map((id) => validId(id))); const next = clone(this.stored); const channels: string[] = [];
    for (const id of ids) {
      const message = next.messages.find((candidate) => candidate.id === id);
      const mention = message?.mentions.find((candidate) => candidate.threadId === threadId);
      if (!message || !mention || mention.status !== 'queued' || mention.leaseRunId !== runId) throw new Error('That public mention is no longer reserved for this turn.');
      mention.status = 'delivered'; mention.deliveredAt = Date.now(); delete mention.leaseRunId; channels.push(message.channelId);
    }
    if (ids.size) this.commit(next, channels, [threadId]);
  }

  release(runId: string): void {
    validId(runId); const next = clone(this.stored); const targets: string[] = [];
    for (const message of next.messages) for (const mention of message.mentions) if (mention.leaseRunId === runId) {
      delete mention.leaseRunId; targets.push(mention.threadId);
    }
    if (targets.length) this.commit(next, [], targets);
  }
}
