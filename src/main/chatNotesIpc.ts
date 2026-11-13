import { CHAT_NOTES_IPC, type ChatNoteChange, type SaveChatNoteInput } from '../api/chatNotes';
import type { ChatNotesStore } from './chatNotes';

interface Options {
  ipc: { handle(channel: string, listener: (event: unknown, ...arguments_: any[]) => unknown): void };
  store: ChatNotesStore;
  /** The application must use its existing trusted-renderer sender check here. */
  assertTrusted(event: unknown): void;
  broadcast(change: ChatNoteChange): void;
}

export function registerChatNotesIpc({ ipc, store, assertTrusted, broadcast }: Options): void {
  ipc.handle(CHAT_NOTES_IPC.get, (event, threadId: string) => {
    assertTrusted(event);
    return store.get(threadId);
  });
  ipc.handle(CHAT_NOTES_IPC.save, (event, input: SaveChatNoteInput) => {
    assertTrusted(event);
    const result = store.save(input);
    if (result.saved) {
      broadcast({ threadId: result.note.threadId, kind: 'saved', revision: result.note.revision });
    }
    return result;
  });
}
