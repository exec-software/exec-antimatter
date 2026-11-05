/** Public means shared across this installation's chats, not published on a network. */
export const BOT_CHAT_LIMITS = {
  channels: 100, messages: 5000, participants: 1000, bodyBytes: 8192,
  mentions: 64, pendingPerTarget: 64, nameLength: 64, descriptionLength: 500,
  pageMessages: 100, pageChars: 32768,
} as const;

export interface BotChatChannel {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  postingPaused: boolean;
  createdAt: number;
  revision: number;
}

export interface BotChatMessage {
  id: string;
  channelId: string;
  sender: { kind: 'agent'; threadId: string; runId: string; title: string; workspace: string | null }
    | { kind: 'human'; name: string }
    // An agent running outside Antimatter, which posted through the inbox. It is
    // deliberately neither 'human' nor 'agent': it is not the person at the
    // keyboard, and it has no thread here to open. Its name is self-declared and
    // carries no authority, which is why it must be distinguishable at a glance.
    | { kind: 'external'; name: string };
  body: string;
  replyTo?: string;
  mentionThreadIds: string[];
  createdAt: number;
  sequence: number;
  /** Redaction erases body on disk. Provenance remains as a moderation tombstone. */
  redactedAt?: number;
  moderationReason?: string;
  /** Present only on a bounded history projection, never in the stored message. */
  truncated?: boolean;
}

/** Only explicitly enrolled public participants. Workspace is a label, never an absolute path. */
export interface BotChatTarget { id: string; title: string; workspace: string | null; running: boolean }
export interface BotChatState {
  enabled: boolean;
  generation: number;
  channels: BotChatChannel[];
  targets: BotChatTarget[];
}
export interface BotChatReadOptions { before?: number; limit?: number; maxChars?: number }
export interface BotChatPage {
  channel: BotChatChannel;
  messages: BotChatMessage[];
  nextBefore: number | null;
  truncated: boolean;
}
export interface BotChatChannelInput { name: string; description?: string }
export interface BotChatChannelPatch {
  name?: string;
  description?: string;
  archived?: boolean;
  postingPaused?: boolean;
}
export interface BotChatPostOptions {
  runId: string;
  clientMessageId: string;
  replyTo?: string;
  mentionThreadIds?: string[];
  expectedGeneration?: number;
  expectedChannelRevision?: number;
  expectedWorkspace?: string | null;
}
export interface BotChatHumanPost { body: string; clientMessageId: string; replyTo?: string; mentionThreadIds?: string[] }
export interface BotChatChange { channelIds: string[]; threadIds: string[]; settingsChanged: boolean }

export interface BotChatAPI {
  state(): Promise<BotChatState>;
  configure(settings: { enabled: boolean }): Promise<BotChatState>;
  createChannel(input: BotChatChannelInput): Promise<BotChatState>;
  updateChannel(channelId: string, patch: BotChatChannelPatch): Promise<BotChatState>;
  read(channelId: string, options?: BotChatReadOptions): Promise<BotChatPage>;
  post(channelId: string, input: BotChatHumanPost): Promise<BotChatPage>;
  moderate(channelId: string, messageId: string, reason?: string): Promise<BotChatPage>;
  onChanged(listener: (event: BotChatChange) => void): () => void;
}
