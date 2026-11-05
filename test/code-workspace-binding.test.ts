import assert from 'node:assert/strict';
import test from 'node:test';
import { actions, environmentSnapshot, type CodeWorkspaceContext } from '../renderer/src/environment/store';
import type { RunState } from '../renderer/src/types';

const opened: Array<{ path: string | null; threadId?: string }> = [];
const writes: Array<{ root: string; path: string; text: string }> = [];
let hostRoot = ''; let stopCalls = 0; let chosen: string | null = null;
let delayedOpen: { path: string; resolve(): void } | null = null;
let finishRun: ((run: RunState) => void) | null = null;
const files = new Map<string, string>();
const context = (id: string, path: string, extras: Partial<CodeWorkspaceContext> = {}): CodeWorkspaceContext => ({
  threadId: id, title: `Chat ${id}`, path, available: true, ready: true, ...extras,
});
const callbacks = { chooseWorkspace: async () => chosen, bindWorkspace: async (path: string) => path };
(globalThis as any).localStorage = { getItem: () => null, setItem() {} };
(globalThis as any).window = { electronAPI: {
  environment: {
    async open(path: string | null, threadId?: string) {
      opened.push({ path, threadId });
      if (delayedOpen?.path === path) await new Promise<void>(resolve => { delayedOpen!.resolve = resolve; });
      hostRoot = path ?? '/default'; return { root: hostRoot, entries: [] };
    },
    async list() { return []; },
    async read(path: string) { return { path, text: files.get(`${hostRoot}:${path}`) ?? 'saved source', modified: 1, binary: false }; },
    async unchanged() { return true; },
    async write(path: string, text: string) { writes.push({ root: hostRoot, path, text }); files.set(`${hostRoot}:${path}`, text); return { path, text, modified: 2, binary: false }; },
    async suggestCommand(path: string) { return `node ${path}`; },
    async run() { return await new Promise<RunState>(resolve => { finishRun = resolve; }); },
    async stop() { stopCalls++; }, async debugStop() {},
  },
  nilProject: { async describe() { return null; }, async create() { return { root: '/created', entry: 'src/main.matrix' }; } },
  ny: { async status() { return { available: false, compiler: false, interpreter: false, debugger: false, lsp: false, sdkPath: null, configuredPath: '', message: 'No SDK' }; }, async cancel() {} },
  workspace: { async chooseDirectory() { return chosen; } },
} };

async function settle(): Promise<void> { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)); }

// These cases run serially against the same store, as the single Code workspace does.
test('Code waits for the host chat binding, then opens that exact folder and chat identity', async () => {
  await actions.followWorkspace(context('a', '/alpha', { ready: false }), callbacks);
  assert.equal(opened.length, 0, 'a pending chat must not inherit the global default');
  await actions.followWorkspace(context('a', '/alpha'), callbacks);
  assert.deepEqual(opened.at(-1), { path: '/alpha', threadId: 'a' });
  assert.equal(environmentSnapshot().root, '/alpha'); assert.equal(environmentSnapshot().boundThreadId, 'a');
  assert.equal(environmentSnapshot().pendingWorkspace, null);
});

test('unsaved buffers hold a chat switch until Save & switch writes them in the previous root', async () => {
  await actions.openFile('main.matrix'); actions.edit('main.matrix', 'unsaved Matrix');
  const count = opened.length;
  await actions.followWorkspace(context('b', '/beta'), callbacks);
  assert.equal(opened.length, count); assert.equal(environmentSnapshot().root, '/alpha');
  assert.equal(environmentSnapshot().files[0].text, 'unsaved Matrix');
  assert.equal(environmentSnapshot().pendingWorkspace?.threadId, 'b');
  assert.equal(await actions.switchWorkspace('save'), true);
  assert.deepEqual(writes.at(-1), { root: '/alpha', path: 'main.matrix', text: 'unsaved Matrix' });
  assert.equal(environmentSnapshot().root, '/beta'); assert.equal(environmentSnapshot().files.length, 0);
  assert.deepEqual(opened.at(-1), { path: '/beta', threadId: 'b' });
});

test('Discard & switch is explicit and never writes the discarded buffer to either folder', async () => {
  await actions.openFile('main.ny'); actions.edit('main.ny', 'discard me'); const count = writes.length;
  await actions.followWorkspace(context('c', '/gamma'), callbacks);
  assert.equal(environmentSnapshot().root, '/beta');
  await actions.switchWorkspace('discard');
  assert.equal(environmentSnapshot().root, '/gamma'); assert.equal(writes.length, count);
});

test('same-folder chats retain their open unsaved file while rebinding host identity', async () => {
  await actions.openFile('shared.ny'); actions.edit('shared.ny', 'keep my work');
  await actions.followWorkspace(context('d', '/gamma'), callbacks);
  assert.equal(environmentSnapshot().pendingWorkspace, null); assert.equal(environmentSnapshot().boundThreadId, 'd');
  assert.equal(environmentSnapshot().files[0].text, 'keep my work');
  assert.deepEqual(opened.at(-1), { path: '/gamma', threadId: 'd' });
  await actions.saveAll();
});

test('a same-folder chat rebind preserves an in-flight run and its eventual task cleanup', async () => {
  actions.setCommand('example');
  const running = actions.run(); await settle();
  assert.equal(environmentSnapshot().task, 'run'); assert.ok(finishRun);
  await actions.followWorkspace(context('d-same-folder', '/gamma'), callbacks);
  assert.equal(environmentSnapshot().task, 'run');
  finishRun!({ id: 'same-folder-run', spec: { command: 'example', args: [], cwd: '/gamma', label: 'example' }, startedAt: 1, pid: 1, exit: { code: 0 } });
  await running; finishRun = null;
  assert.equal(environmentSnapshot().task, null); assert.equal(environmentSnapshot().nyBuilding, false);
  assert.equal(environmentSnapshot().run?.id, 'same-folder-run');
});

test('running work requires an explicit stop before opening another chat folder', async () => {
  actions.setNyBuilding(true); const count = stopCalls;
  await actions.followWorkspace(context('e', '/epsilon'), callbacks);
  assert.equal(environmentSnapshot().root, '/gamma'); assert.equal(stopCalls, count);
  await actions.switchWorkspace('save');
  assert.equal(stopCalls, count + 1); assert.equal(environmentSnapshot().root, '/epsilon');
});

test('a missing chat folder does not silently fall back and the picker binds its replacement', async () => {
  await actions.followWorkspace(context('missing', '/gone', { available: false, reason: 'Folder is missing.' }), callbacks);
  assert.equal(environmentSnapshot().root, ''); assert.equal(environmentSnapshot().boundThreadId, 'missing');
  assert.equal(environmentSnapshot().workspaceUnavailable, 'Folder is missing.');
  chosen = '/replacement'; await actions.chooseFolder(); chosen = null;
  assert.equal(environmentSnapshot().root, '/replacement'); assert.equal(environmentSnapshot().workspaceUnavailable, null);
  assert.deepEqual(opened.at(-1), { path: '/replacement', threadId: 'missing' });
});

test('a new project binds its chosen path to the active chat before opening its entrypoint', async () => {
  const bound: string[] = [];
  await actions.followWorkspace(context('new', '/start'), { ...callbacks, async bindWorkspace(path) { bound.push(path); return path; } });
  assert.equal(await actions.createProject('example', 'matrix'), true);
  assert.deepEqual(bound, ['/created']); assert.deepEqual(opened.at(-1), { path: '/created', threadId: 'new' });
  assert.equal(environmentSnapshot().activePath, 'src/main.matrix');
  // React may replay old props during a synchronous store notification before its queued
  // host-binding state update commits. That render cannot restore the previous folder.
  await actions.followWorkspace(context('new', '/start'), callbacks);
  assert.equal(environmentSnapshot().root, '/created');
  assert.equal(environmentSnapshot().activePath, 'src/main.matrix');
});

test('an early host binding event still opens a newly created project entrypoint', async () => {
  const earlyCallbacks = { ...callbacks, async bindWorkspace(path: string) {
    await actions.followWorkspace(context('early-project', path), earlyCallbacks);
    return path;
  } };
  await actions.followWorkspace(context('early-project', '/before-project'), earlyCallbacks);
  assert.equal(await actions.createProject('example', 'matrix'), true);
  assert.equal(environmentSnapshot().root, '/created');
  assert.equal(environmentSnapshot().activePath, 'src/main.matrix');
});

test('a host selection can complete while the same chat binding is refreshing', async () => {
  const waitingCallbacks = { ...callbacks, async bindWorkspace(path: string) {
    await actions.followWorkspace(context('waiting-project', '/before-wait', { ready: false }), waitingCallbacks);
    return path;
  } };
  await actions.followWorkspace(context('waiting-project', '/before-wait'), waitingCallbacks);
  assert.equal(await actions.createProject('example', 'matrix'), true);
  assert.equal(environmentSnapshot().root, '/created'); assert.equal(environmentSnapshot().pendingWorkspace, null);
  assert.equal(environmentSnapshot().activePath, 'src/main.matrix');
});

test('an early host picker event is accepted only for the same chat and selected path', async () => {
  const earlyCallbacks = { ...callbacks, async chooseWorkspace() {
    await actions.followWorkspace(context('early-picker', '/picked'), earlyCallbacks);
    return '/picked';
  } };
  await actions.followWorkspace(context('early-picker', '/before-picker'), earlyCallbacks);
  await actions.chooseFolder();
  assert.equal(environmentSnapshot().root, '/picked'); assert.equal(environmentSnapshot().boundThreadId, 'early-picker');
  await actions.followWorkspace(context('late-picker', '/late-before'), { ...callbacks, async chooseWorkspace() {
    await actions.followWorkspace(context('different-chat', '/different'), callbacks);
    return '/must-not-open';
  } });
  await actions.chooseFolder();
  assert.equal(environmentSnapshot().root, '/different'); assert.equal(environmentSnapshot().boundThreadId, 'different-chat');
});

test('a chat arriving during an open wins without a stale renderer root', async () => {
  delayedOpen = { path: '/slow', resolve() {} };
  const slow = actions.followWorkspace(context('slow', '/slow'), callbacks);
  await actions.followWorkspace(context('latest', '/latest'), callbacks);
  delayedOpen.resolve(); await slow; delayedOpen = null; await settle();
  assert.equal(environmentSnapshot().root, '/latest'); assert.equal(environmentSnapshot().boundThreadId, 'latest');
  assert.equal(environmentSnapshot().pendingWorkspace, null);
});

test('without an active chat Code retains the ordinary global folder fallback', async () => {
  await actions.followWorkspace({ threadId: null, title: '', path: null, available: true, ready: true }, callbacks);
  assert.equal(environmentSnapshot().root, '/default'); assert.deepEqual(opened.at(-1), { path: null, threadId: undefined });
});
