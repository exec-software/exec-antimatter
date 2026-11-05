import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { registerBotChatIpc } from '../src/main/botChatIpc';
import { BotChatStore } from '../src/main/botChat';
import type { BotChatPage, BotChatState } from '../src/api/botChat';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

test('every public chat desktop operation authorizes before touching shared state', () => {
  const handlers = new Map<string, Handler>();
  const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as unknown as Pick<IpcMain, 'handle'>;
  let reads = 0;
  const sender = {};
  registerBotChatIpc(ipc, {
    requireSender: (event) => {
      if (event.sender !== sender) throw new Error('Untrusted frame');
    },
    store: () => { reads++; throw new Error('Not reached'); },
  });
  assert.deepEqual([...handlers.keys()].sort(), [
    'bot-chat:state', 'bot-chat:configure', 'bot-chat:create-channel', 'bot-chat:update-channel',
    'bot-chat:read', 'bot-chat:post-human', 'bot-chat:moderate',
  ].sort());
  for (const handler of handlers.values()) {
    assert.throws(() => handler({ sender: {} } as IpcMainInvokeEvent, 'arbitrary'), /Untrusted frame/);
  }
  assert.equal(reads, 0, 'untrusted settings, history, posts, and moderation must not open the store');
  assert.throws(() => handlers.get('bot-chat:state')!({ sender } as IpcMainInvokeEvent), /Not reached/);
  assert.equal(reads, 1);
});

test('desktop history and human posts use separate entry points from agent operations', () => {
  const handlers = new Map<string, Handler>();
  const calls: unknown[][] = [];
  const page = { messages: [] };
  const state = { enabled: false };
  const store = {
    state: () => state,
    configure: (settings: unknown) => { calls.push(['configure', settings]); return state; },
    createChannel: (input: unknown) => { calls.push(['createChannel', input]); return state; },
    updateChannel: (...args: unknown[]) => { calls.push(['updateChannel', ...args]); return state; },
    readHistory: (...args: unknown[]) => { calls.push(['readHistory', ...args]); return page; },
    postHuman: (...args: unknown[]) => { calls.push(['postHuman', ...args]); return { id: 'human-message' }; },
    moderate: (...args: unknown[]) => { calls.push(['moderate', ...args]); },
    post: () => assert.fail('human IPC must not impersonate an agent'),
    read: () => assert.fail('history review must remain available when agent reads are disabled'),
  } as unknown as BotChatStore;
  registerBotChatIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as unknown as Pick<IpcMain, 'handle'>,
    { requireSender: () => {}, store: () => store });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(`bot-chat:${channel}`)!({} as IpcMainInvokeEvent, ...args);
  assert.equal(invoke('state'), state);
  assert.equal(invoke('configure', { enabled: true }), state);
  assert.equal(invoke('create-channel', { name: 'release' }), state);
  assert.equal(invoke('update-channel', 'channel', { postingPaused: true }), state);
  assert.equal(invoke('read', 'channel', { before: 42 }), page);
  assert.equal(invoke('post-human', 'channel', { body: 'Status?', clientMessageId: 'occurrence' }), page);
  assert.throws(() => invoke('post-human', 'channel', null), /public message is required/);
  assert.equal(invoke('moderate', 'channel', 'message', 'Unwanted content'), page);
  assert.deepEqual(calls, [
    ['configure', { enabled: true }], ['createChannel', { name: 'release' }],
    ['updateChannel', 'channel', { postingPaused: true }], ['readHistory', 'channel', { before: 42 }],
    ['postHuman', 'channel', 'Status?', { clientMessageId: 'occurrence', replyTo: undefined, mentionThreadIds: undefined }], ['readHistory', 'channel'],
    ['moderate', 'channel', 'message', 'Unwanted content'], ['readHistory', 'channel'],
  ]);
});

test('desktop channel edits return the full state and human posts retain host identity', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'antimatter-bot-chat-ipc-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new BotChatStore(join(directory, 'public.json'), { threads: () => [], activeRun: () => null });
  const handlers = new Map<string, Handler>();
  registerBotChatIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as unknown as Pick<IpcMain, 'handle'>,
    { requireSender: () => {}, store: () => store });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(`bot-chat:${channel}`)!({} as IpcMainInvokeEvent, ...args);
  invoke('configure', { enabled: true });
  const created = invoke('create-channel', { name: 'release' }) as BotChatState;
  assert.equal(created.enabled, true);
  assert.equal(created.channels.length, 2);
  const channel = created.channels.find((entry) => entry.name === 'release')!;
  const changed = invoke('update-channel', channel.id, { name: 'ny-release' }) as BotChatState;
  assert.equal(changed.channels.find((entry) => entry.id === channel.id)?.name, 'ny-release');
  const posted = invoke('post-human', channel.id, {
    body: 'How is the release?', clientMessageId: 'once', sender: { kind: 'agent', threadId: 'forged' },
  }) as BotChatPage;
  assert.deepEqual(posted.messages[0].sender, { kind: 'human', name: 'You' });
  invoke('configure', { enabled: false });
  assert.throws(() => invoke('post-human', channel.id, { body: 'Blocked', clientMessageId: 'twice' }), /disabled/);
  assert.equal((invoke('read', channel.id) as BotChatPage).messages.length, 1);
  assert.equal((invoke('moderate', channel.id, posted.messages[0].id) as BotChatPage).messages[0].body, '');
});
