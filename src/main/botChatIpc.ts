import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { BotChatChannelInput, BotChatChannelPatch, BotChatHumanPost, BotChatReadOptions } from '../api/botChat';
import type { BotChatStore } from './botChat';

/** Human controls have one authorization boundary; the agent runtime never receives it. */
export function registerBotChatIpc(ipc: Pick<IpcMain, 'handle'>, dependencies: {
  requireSender(event: IpcMainInvokeEvent): void;
  store(): BotChatStore;
}): void {
  const storeFor = (event: IpcMainInvokeEvent): BotChatStore => {
    dependencies.requireSender(event);
    return dependencies.store();
  };
  ipc.handle('bot-chat:state', (event) => storeFor(event).state());
  ipc.handle('bot-chat:configure', (event, settings: { enabled: boolean }) => storeFor(event).configure(settings));
  ipc.handle('bot-chat:create-channel', (event, input: BotChatChannelInput) => {
    const store = storeFor(event); store.createChannel(input); return store.state();
  });
  ipc.handle('bot-chat:update-channel', (event, channelId: string, patch: BotChatChannelPatch) => {
    const store = storeFor(event); store.updateChannel(channelId, patch); return store.state();
  });
  ipc.handle('bot-chat:read', (event, channelId: string, options?: BotChatReadOptions) => storeFor(event).readHistory(channelId, options));
  ipc.handle('bot-chat:post-human', (event, channelId: string, input: BotChatHumanPost) => {
    const store = storeFor(event);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A public message is required.');
    store.postHuman(channelId, input.body, {
      clientMessageId: input.clientMessageId, replyTo: input.replyTo, mentionThreadIds: input.mentionThreadIds,
    });
    return store.readHistory(channelId);
  });
  ipc.handle('bot-chat:moderate', (event, channelId: string, messageId: string, reason?: string) => {
    const store = storeFor(event);
    store.moderate(channelId, messageId, reason);
    return store.readHistory(channelId);
  });
}
