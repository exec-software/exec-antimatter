export const CHAT_NOTES_IPC = {
  get: 'chat-notes:get',
  save: 'chat-notes:save',
  changed: 'chat-notes:changed',
} as const;

export const MAX_CHAT_NOTE_BYTES = 512 * 1024;

/** Personal annotations, separate from the transcript and the model's context. */
export interface ChatNote {
  threadId: string;
  markdown: string;
  revision: number;
  updatedAt: number | null;
}

export interface SaveChatNoteInput {
  threadId: string;
  markdown: string;
  expectedRevision: number;
}

export type SaveChatNoteResult =
  | { saved: true; note: ChatNote }
  | { saved: false; reason: 'conflict'; note: ChatNote };

export type ChatNoteChange =
  | { threadId: string; kind: 'saved'; revision: number }
  | { threadId: string; kind: 'deleted' };

export interface ChatNotesAPI {
  get(threadId: string): Promise<ChatNote>;
  save(input: SaveChatNoteInput): Promise<SaveChatNoteResult>;
  onChanged(callback: (change: ChatNoteChange) => void): () => void;
}
