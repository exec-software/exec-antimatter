/** Host-owned links: only an explicit action in the desktop UI creates a connection. */
export interface ChatConnection {
  id: string;
  threadIds: [string, string];
  workspace: string;
  createdAt: number;
}

export interface ChatCoordinationPeer {
  id: string;
  title: string;
  directory: string;
  connected: boolean;
  running: boolean;
  linkId?: string;
}

export interface ChatCoordinationMessage {
  id: string;
  sourceThreadId: string;
  targetThreadId: string;
  sourceTitle: string;
  targetTitle: string;
  sourceRunId: string;
  body: string;
  createdAt: number;
  status: 'queued' | 'delivered' | 'dismissed';
  /** Added to a recipient turn; this does not mean the model or person read it. */
  deliveredAt?: number;
}

export interface ChatCoordinationState {
  threadId: string;
  workspace: string | null;
  peers: ChatCoordinationPeer[];
  /** Sent and received notes, oldest first. */
  messages: ChatCoordinationMessage[];
}

export interface ChatTranscriptReadOptions {
  /** Exclusive visible-message ID; omit to read the latest page. */
  before?: string;
  limit?: number;
  maxChars?: number;
}

export interface ChatTranscriptPage {
  threadId: string;
  title: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
    truncated: boolean;
  }>;
  nextBefore: string | null;
  truncated: boolean;
}

export interface ChatCoordinationClaimOptions {
  limit?: number;
  maxChars?: number;
}

export interface ChatCoordinationSendOptions {
  runId: string;
  /** Stable tool-call occurrence identity, so a retried send does not enqueue twice. */
  clientMessageId: string;
  expectedLinkId?: string;
}

export interface ChatCoordinationAPI {
  state(threadId: string): Promise<ChatCoordinationState>;
  connect(threadId: string, peerId: string): Promise<ChatCoordinationState>;
  disconnect(threadId: string, peerId: string): Promise<ChatCoordinationState>;
  dismiss(threadId: string, messageId: string): Promise<ChatCoordinationState>;
  onChanged(listener: (event: { threadIds: string[] }) => void): () => void;
}
