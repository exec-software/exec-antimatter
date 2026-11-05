import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatRequest, Message, StreamResult } from '../src/api/types';
import type { PensieveRequest } from '../src/api/pensieve';
import { withPensieve, snapshotPensieveSources, pensieveCompilerSources, PENSIEVE_SERVER } from '../src/main/pensieveRuntime';
import { runToolLoop, type ToolRuntime } from '../src/main/toolLoop';
import { tierOf } from '../src/main/toolPolicy';
import { fitToBudget } from '../src/main/context';
import { runPensieveBridge } from '../src/main/pensieveExperimental';

const request: ChatRequest = { providerId: 'local', model: '30b', messages: [{ id: 'u', role: 'user', content: 'Write the Matrix loop.' }] };
function fixture(enabled = true, results: StreamResult[] = [{ content: 'done', toolCalls: [] }]) {
  const calls: PensieveRequest[] = [];
  const requests: ChatRequest[] = [];
  let toolCalls = 0;
  const memory = { enabled, async invoke<T>(_workspace: string, value: PensieveRequest): Promise<T> {
    calls.push(value);
    return (value.op === 'recall' ? { text: 'Verified Matrix example: repeat while i is at most 5', items: [] } : { event_id: calls.length }) as T;
  } };
  const base: ToolRuntime = { enabledTools: () => [{ serverId: 'antimatter', serverName: 'Tools', tool: {
    name: 'read_file', enabled: true, description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } } }],
    async callTool() { toolCalls++; return { ok: true, text: 'x'.repeat(9000) }; } };
  const provider = { async stream(next: ChatRequest) { requests.push(JSON.parse(JSON.stringify(next))); return results.shift()!; } };
  const bound = withPensieve(base, provider, { memory, workspace: '/project', session: 'chat', runId: 'turn',
    sdkOptions: () => ({}), curriculumPath: '/corpus' });
  return { calls, requests, bound, memory, toolCalls: () => toolCalls };
}

test('disabled memory leaves provider requests and tools untouched and performs no capture', async () => {
  const f = fixture(false);
  await runToolLoop({ provider: f.bound.provider, toolRuntime: f.bound.runtime, prepareMessages: f.bound.prepareMessages,
    request, runId: 'turn', mode: 'full', onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.deepEqual(f.calls, []);
  assert.equal(f.bound.runtime.enabledTools().length, 1);
  assert.deepEqual(f.requests[0].messages, request.messages);
});

test('automatic recall enters before fitting, stays protocol-paired, and exact provider request is captured', async () => {
  const f = fixture();
  let fitted = false;
  await runToolLoop({ provider: f.bound.provider, toolRuntime: f.bound.runtime, prepareMessages: f.bound.prepareMessages,
    request, runId: 'turn', mode: 'full', fit(messages, tools) {
      fitted = true;
      assert.ok(messages.some(m => m.role === 'tool' && m.content.includes('Verified Matrix')));
      return fitToBudget(messages, 6000);
    }, onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.ok(fitted);
  const messages = f.requests[0].messages;
  const tool = messages.find(m => m.role === 'tool')!;
  assert.ok(messages.some(m => m.toolCalls?.some(c => c.id === tool.toolCallId)));
  const offered = new Set(f.requests[0].tools?.map(tool => tool.function.name));
  assert.ok(messages.flatMap(message => message.toolCalls ?? []).every(call => offered.has(call.function.name)));
  const captured = f.calls.find(c => c.op === 'capture' && c.kind === 'inference-request');
  assert.ok(captured?.op === 'capture');
  assert.deepEqual(JSON.parse(captured.content).messages, messages);
});

test('optional recalled context cannot evict the latest request in a tight resumed conversation', async () => {
  const f = fixture();
  const current: Message = { id: 'current-user', role: 'user', content: 'Implement the current requested change. '.repeat(80) };
  const messages: Message[] = [{ id: 'system', role: 'system', content: 'Build the requested application.' },
    { id: 'original-user', role: 'user', content: 'Create a Matrix application.' },
    { id: 'earlier-answer', role: 'assistant', content: 'Earlier discussion. '.repeat(200) }, current];
  await runToolLoop({ provider: f.bound.provider, toolRuntime: f.bound.runtime, prepareMessages: f.bound.prepareMessages,
    request: { ...request, messages }, runId: 'turn', mode: 'full', fit: messages => fitToBudget(messages, 1000),
    onContent() {}, onActivity() {}, requestApproval: async () => true });
  const sent = f.requests[0].messages;
  assert.ok(sent.some(message => message.id === current.id && message.content === current.content));
  assert.ok(sent.some(message => message.id === 'original-user'));
  for (const tool of sent.filter(message => message.role === 'tool')) {
    assert.ok(sent.some(message => message.toolCalls?.some(call => call.id === tool.toolCallId)));
  }
});

test('raw tool result survives UI truncation and arbitrary success is never a verified repair', async () => {
  const f = fixture(true, [{ content: '', toolCalls: [{ id: 'read', type: 'function', function: { name: 'antimatter__read_file', arguments: '{"path":"a.matrix"}' } }] }, { content: 'done', toolCalls: [] }]);
  await runToolLoop({ provider: f.bound.provider, toolRuntime: f.bound.runtime, prepareMessages: f.bound.prepareMessages,
    request, runId: 'turn', mode: 'full', onContent() {}, onActivity() {}, requestApproval: async () => true });
  assert.equal(f.toolCalls(), 1);
  assert.ok(f.calls.some(c => c.op === 'capture' && c.kind === 'tool-outcome' && c.content.includes('x'.repeat(9000))));
  assert.equal(f.calls.some(c => c.op === 'observe'), false);
  assert.equal(f.calls.filter(c => c.op === 'recall').length, 1);
});

test('disabling during a turn removes memory tools and rejects a previously offered recall', async () => {
  const f = fixture(); f.memory.enabled = false;
  const response = await f.bound.runtime.callTool(PENSIEVE_SERVER, 'pensieve_recall', { cue: 'loop' });
  assert.equal(response.ok, false);
  assert.equal(response.attempted, false);
  assert.deepEqual(f.calls, []);
});

test('only app-owned recall/check names receive a read tier', () => {
  assert.equal(tierOf('pensieve_recall', PENSIEVE_SERVER), 'read');
  assert.equal(tierOf('pensieve_check_project', PENSIEVE_SERVER), 'read');
  assert.notEqual(tierOf('pensieve_recall', 'other-server'), 'read');
});

test('source evidence includes whole Matrix source and manifest but rejects linked or external source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pensieve-source-'));
  try {
    const root = join(directory, 'app'); mkdirSync(root); mkdirSync(join(root, 'src'));
    const manifest = join(root, 'nil.project.json'); writeFileSync(manifest, '{}');
    writeFileSync(join(root, 'src/main.matrix'), 'book app\n');
    const first = snapshotPensieveSources(root, [root], manifest);
    assert.equal(first.program['src/main.matrix'], 'book app\n');
    assert.match(first.hashes['src/main.matrix'], /^[a-f0-9]{64}$/);
    writeFileSync(join(directory, 'outside.matrix'), 'book outside');
    symlinkSync(join(directory, 'outside.matrix'), join(root, 'src/linked.matrix'));
    assert.throws(() => snapshotPensieveSources(root, [root], manifest), /symbolic/);
    assert.throws(() => snapshotPensieveSources(root, [directory], manifest), /External/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const bundledRuntime = join(process.cwd(), 'vendor/pensieve');
const bundledCurriculum = join(bundledRuntime, 'curriculum.json');
const actualSdk = (() => { try { return JSON.parse(readFileSync(bundledCurriculum, 'utf8')).sdk.path as string; } catch { return ''; } })();
const hasPinnedSdk = process.platform !== 'win32' && !!actualSdk && existsSync(join(actualSdk, 'nilbuild'));

test('compiler source evidence rejects incomplete, stale and external snapshots rather than guessing the import closure', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pensieve-source-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'app'); mkdirSync(workspace);
  const entry = join(workspace, 'main.matrix'), helper = join(workspace, 'helper.matrix'), sdkFile = join(directory, 'sdk.matrix');
  writeFileSync(entry, 'book app'); writeFileSync(helper, 'book helper'); writeFileSync(sdkFile, 'book library');
  writeFileSync(join(workspace, 'unused.matrix'), 'INVALID UNUSED BOOK');
  const manifest = join(workspace, 'nil.project.json'); writeFileSync(manifest, '{}');
  const captured = snapshotPensieveSources(workspace, [workspace], manifest);
  const sdkHashes = new Map([[sdkFile, createHash('sha256').update('book library').digest('hex')]]);
  const sources = [{ path: entry, text: 'book app' }, { path: helper, text: 'book helper' }, { path: sdkFile, text: 'book library' }];
  const report = { schema: 'nil.analysis.v1', source: entry, success: true, diagnostics: [],
    sources: [], semantic: { schema: 'nil.semantic.v1', sources } };
  const read = (value: unknown, success = true) => pensieveCompilerSources(value, success, workspace, 'main.matrix', captured, sdkHashes);
  assert.deepEqual(read(report), { 'main.matrix': 'book app', 'helper.matrix': 'book helper' });
  assert.equal(read({ ...report, semantic: null }), null);
  assert.equal(read({ ...report, semantic: { ...report.semantic, sources: sources.slice(1) } }), null, 'complete success evidence must include the entry');
  assert.equal(read({ ...report, source: helper }), null);
  assert.equal(read({ ...report, success: false }), null);
  for (const invalid of [
    { path: helper, text: 'book stale' },
    { path: sdkFile, text: 'book changed-library' },
    { path: join(directory, 'external.matrix'), text: 'outside' },
    { path: `${workspace}/../app/helper.matrix`, text: 'book helper' },
  ]) assert.equal(read({ ...report, semantic: { ...report.semantic, sources: [sources[0], invalid] } }), null);
  assert.equal(read({ ...report, semantic: { ...report.semantic, sources: [...sources, sources[1]] } }), null, 'duplicate source identities are rejected');
  const failure = { ...report, success: false, semantic: null,
    diagnostics: [{ path: helper, message: 'expected a value' }], sources: [sources[1]] };
  assert.deepEqual(read(failure, false), { 'main.matrix': 'book app', 'helper.matrix': 'book helper' });
  assert.equal(read({ ...failure, diagnostics: [] }, false), null, 'diagnostic snapshots must correspond to compiler diagnostics');
  const changedCapture = { ...captured, hashes: { ...captured.hashes, 'helper.matrix': '0'.repeat(64) } };
  assert.equal(pensieveCompilerSources(report, true, workspace, 'main.matrix', changedCapture, sdkHashes), null);
});

test('an imported quote helper repair survives a new session without promoting an unused invalid book',
  { skip: !hasPinnedSdk }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'pensieve-import-repair-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const workspace = join(directory, 'app'); mkdirSync(join(workspace, 'src/probe'), { recursive: true });
    const store = join(directory, 'memory.pensieve');
    const entry = 'book app\nread everything from probe.logic\nmain returns number begin paragraph\n' +
      '    say quote-order with units being 4, unit-price being 5, free-threshold being 20, shipping-fee being 3\n    give 0\nend paragraph\n';
    const broken = 'book probe.logic\npublic quote-order receives units as number, unit-price as number, free-threshold as number, shipping-fee as number returns number begin paragraph\n' +
      '    when units is less than or equal to 0 then\n        give -1\n    end when\n' +
      '    value subtotal is units times unit-price\n    when subtotal is greater than or equal to free-threshold then\n        give subtotal\n    end when\n' +
      '    give subtotal plus shipping-fee\nend paragraph\n';
    const repaired = broken.replace('is less than or equal to', 'is at most').replace('is greater than or equal to', 'is at least');
    writeFileSync(join(workspace, 'src/main.matrix'), entry);
    writeFileSync(join(workspace, 'src/probe/logic.matrix'), broken);
    writeFileSync(join(workspace, 'src/unused.matrix'), 'INVALID UNUSED BOOK MUST NOT BECOME A VERIFIED EXAMPLE');
    writeFileSync(join(workspace, 'nil.project.json'), JSON.stringify({ schema: 'nil.project.v1', name: 'quote-check',
      entry: 'src/main.matrix', includePaths: ['src'], sdkPath: actualSdk, outputDirectory: 'build' }));
    const calls: PensieveRequest[] = [];
    const memory = { enabled: true, async invoke<T>(_workspace: string, value: PensieveRequest, signal?: AbortSignal): Promise<T> {
      calls.push(value);
      return await runPensieveBridge({ runtimeRoot: bundledRuntime, curriculumPath: bundledCurriculum, store, request: value, signal }) as T;
    } };
    const base: ToolRuntime = { enabledTools: () => [], async callTool(_server, name, args) {
      if (name === 'edit_file') writeFileSync(join(workspace, args.path as string), args.content as string);
      return { ok: true, text: 'File updated.' };
    } };
    const bind = (session: string) => withPensieve(base, { async stream() { return { content: '', toolCalls: [] }; } },
      { memory, workspace, session, runId: session, curriculumPath: bundledCurriculum, sdkOptions: () => ({ sdkPath: actualSdk }) });
    const failed = await bind('before').runtime.callTool(PENSIEVE_SERVER, 'pensieve_check_project', {});
    assert.equal(failed.ok, false); assert.match(JSON.parse(failed.text).output, /logic\.matrix.*MX0001/);
    const fixed = await bind('after').runtime.callTool('antimatter', 'edit_file', { path: 'src/probe/logic.matrix', content: repaired });
    assert.match(fixed.text, /PASSED \(compile only\)/);
    assert.doesNotMatch(fixed.text, /nil\.semantic\.v1|INVALID UNUSED BOOK/);
    const observations = calls.filter(call => call.op === 'observe');
    assert.equal(observations.length, 2);
    assert.deepEqual(observations.map(call => call.outcome.status), ['failed', 'passed']);
    assert.deepEqual(observations.map(call => Object.keys(call.program!).sort()),
      [['src/main.matrix', 'src/probe/logic.matrix'], ['src/main.matrix', 'src/probe/logic.matrix']]);
    assert.equal((observations[0].program as Record<string, string>)['src/main.matrix'], entry);
    assert.equal((observations[1].program as Record<string, string>)['src/main.matrix'], entry);
    assert.ok(calls.some(call => call.op === 'capture' && call.kind === 'compiler-source-snapshot' && call.content.includes('INVALID UNUSED BOOK')));
    const status = await memory.invoke<{ repairs: number }>(workspace, { op: 'status' });
    assert.equal(status.repairs, 1);
    const recalled = await memory.invoke<{ items: Array<{ source: string; text?: string }>; text: string }>(workspace,
      { op: 'recall', session: 'third', cue: 'quote-order expected a value found or is at most is at least', language: 'matrix', budget_chars: 10000 });
    assert.ok(recalled.items.some(item => item.source === 'repair'));
    assert.match(recalled.text, /is at most|is at least/);
    assert.doesNotMatch(recalled.text, /INVALID UNUSED BOOK/);
  });

/** Exercises the actual compiler and persisted Python bridge, never a shell-result oracle. */
test('ordinary edits automatically learn an attested compiler repair; echoes, reads, and trivial replacements are not acceptance',
  { skip: !hasPinnedSdk }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'pensieve-auto-real-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const workspace = join(directory, 'app'); mkdirSync(join(workspace, 'src'), { recursive: true });
    const store = join(directory, 'memory.pensieve');
    const initial = 'book app\nmain returns number begin paragraph\n    say "Ready"\n    give 0\nend paragraph\n';
    const broken = 'book app\nmain returns number begin paragraph\n    value result is 2 + 3\n    say result\n    give 0\nend paragraph\n';
    const repaired = broken.replace('2 + 3', '2 plus 3');
    writeFileSync(join(workspace, 'src/main.matrix'), initial);
    writeFileSync(join(workspace, 'src/orphan.matrix'), 'INVALID ORPHAN SOURCE MUST NOT BECOME A VERIFIED EXAMPLE');
    writeFileSync(join(workspace, 'nil.project.json'), JSON.stringify({ schema: 'nil.project.v1', name: 'auto-check',
      entry: 'src/main.matrix', includePaths: ['src'], sdkPath: actualSdk, outputDirectory: 'build' }));
    const calls: PensieveRequest[] = [];
    const responses: unknown[] = [];
    const memory = { enabled: true, async invoke<T>(_workspace: string, value: PensieveRequest, signal?: AbortSignal): Promise<T> {
      calls.push(value);
      const response = await runPensieveBridge({ runtimeRoot: bundledRuntime, curriculumPath: bundledCurriculum,
        store, request: value, signal }); responses.push(response); return response as T;
    } };
    const base: ToolRuntime = { enabledTools: () => [], async callTool(_server, name, args) {
      if (name === 'write_file' || name === 'edit_file') writeFileSync(join(workspace, args.path as string), args.content as string);
      return { ok: true, text: name === 'run_command' ? 'PASS: everything implemented; exit 0' : 'File updated.' };
    } };
    const bind = (runId: string) => withPensieve(base, { async stream() { return { content: '', toolCalls: [] }; } },
      { memory, workspace, session: 'compile-learning', runId, curriculumPath: bundledCurriculum, sdkOptions: () => ({ sdkPath: actualSdk }) });
    const bound = bind('one');
    await bound.runtime.callTool('antimatter', 'run_command', { command: 'echo "PASS: every test passed"' });
    await bound.runtime.callTool('antimatter', 'read_file', { path: 'src/main.matrix' });
    await bound.runtime.callTool('antimatter', 'write_file', { path: 'README.md', content: 'Summary only.' });
    assert.equal(calls.some(call => call.op === 'observe'), false);
    const failed = await bound.runtime.callTool('antimatter', 'write_file', { path: 'src/main.matrix', content: broken });
    assert.match(failed.text, /Automatic app-owned compiler check: FAILED/);
    assert.match(failed.text, /MX0001/);
    assert.match(failed.text, /Diagnostic-specific memory/);
    const diagnosticRecall = calls.find(call => call.op === 'recall');
    assert.ok(diagnosticRecall?.op === 'recall');
    assert.match(diagnosticRecall.cue, /MX0001/); assert.equal(diagnosticRecall.task, 'nil.project.json');
    const fixed = await bound.runtime.callTool('antimatter', 'edit_file', { path: 'src/main.matrix', content: repaired });
    assert.match(fixed.text, /PASSED \(compile only\)/);
    assert.match(fixed.text, /actual entry: src\/main.matrix/);
    assert.match(fixed.text, /not runtime or workload acceptance/);
    const observed = calls.filter(call => call.op === 'observe');
    assert.equal(observed.length, 2);
    assert.deepEqual(observed.map(call => call.outcome.status), ['failed', 'passed']);
    assert.ok(observed.every(call => typeof call.program === 'object' && Object.keys(call.program!).join() === 'src/main.matrix'));
    assert.ok(calls.some(call => call.op === 'capture' && call.kind === 'compiler-source-snapshot' && call.content.includes('INVALID ORPHAN SOURCE')));
    assert.ok(responses.some(value => !!value && typeof value === 'object' && 'repair_id' in value && value.repair_id !== null));
    const status = await memory.invoke<{ experiences: number; repairs: number }>(workspace, { op: 'status' });
    assert.equal(status.experiences, 2); assert.equal(status.repairs, 1);
    const cached = await bound.runtime.callTool('antimatter', 'run_command', { command: './sdk/nilbuild check --project nil.project.json' });
    assert.match(cached.text, /same source hashes; cached check/);
    assert.equal(calls.filter(call => call.op === 'observe').length, 2, 'an ordinary check of unchanged source reuses its attested result');
    const shrunk = await bound.runtime.callTool('antimatter', 'write_file', { path: 'src/main.matrix', content: initial.replace('Ready', 'Basic test') });
    assert.match(shrunk.text, /print\/return-only program/);
    assert.equal(calls.filter(call => call.op === 'observe').at(-1)!.outcome.status, 'unknown');
    assert.equal((await memory.invoke<{ repairs: number }>(workspace, { op: 'status' })).repairs, 1);
    const rawOutcomes = calls.filter(call => call.op === 'capture' && call.kind === 'tool-outcome');
    assert.ok(rawOutcomes.every(call => call.op === 'capture' && JSON.parse(call.content).verification === 'unverified'));
    memory.enabled = false;
    const count = calls.length;
    const disabled = await bound.runtime.callTool('antimatter', 'write_file', { path: 'src/main.matrix', content: broken });
    assert.equal(disabled.text, 'File updated.'); assert.equal(calls.length, count);
  });

test('automatic checks respect workspace boundaries and do not run for unchanged ordinary commands', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pensieve-auto-boundary-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'app'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'nil.project.json'), '{"entry":"main.matrix"}');
  writeFileSync(join(workspace, 'main.matrix'), 'book app');
  let checks = 0;
  const f = fixture();
  const bound = withPensieve({ enabledTools: () => [], async callTool() { return { ok: true, text: 'unchanged' }; } },
    { async stream() { return { content: '', toolCalls: [] }; } }, { memory: f.memory, workspace,
      session: 's', runId: 'boundary', curriculumPath: '/none', sdkOptions: () => ({}),
      async checkProject() { checks++; return { ok: true, text: 'compiled' }; } });
  await bound.runtime.callTool('antimatter', 'run_command', { command: 'cat main.matrix' });
  assert.equal(checks, 0);
  const outside = await bound.runtime.callTool('antimatter', 'write_file', { path: '../outside.matrix', content: 'outside' });
  assert.match(outside.text, /inside the open workspace/); assert.equal(checks, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bound.runtime.callTool('antimatter', 'run_command', { command: './sdk/nilbuild check' }, { signal: controller.signal }));
  assert.equal(checks, 0);
});

test('opaque command source changes receive feedback, repeated failures deduplicate, and in-flight cancellation stops the check', async t => {
  const workspace = mkdtempSync(join(tmpdir(), 'pensieve-auto-routing-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'nil.project.json'), '{"entry":"main.matrix"}');
  writeFileSync(join(workspace, 'main.matrix'), 'book app');
  let checks = 0;
  let checking!: () => void;
  const started = new Promise<void>(resolve => { checking = resolve; });
  let waitForAbort = false;
  const f = fixture();
  const bound = withPensieve({ enabledTools: () => [], async callTool(_server, _name, args) {
    if (args.command === 'rewrite') writeFileSync(join(workspace, 'main.matrix'), 'book app\n// wrong comment');
    if (args.command === 'rewrite-again') writeFileSync(join(workspace, 'main.matrix'), 'book app\n// changed comment');
    return { ok: true, text: 'ordinary command finished' };
  } }, { async stream() { return { content: '', toolCalls: [] }; } }, { memory: f.memory, workspace,
    session: 's', runId: 'routing', curriculumPath: '/none', sdkOptions: () => ({}),
    async checkProject(_path, _id, signal) {
      checks++;
      if (waitForAbort) {
        checking();
        await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
      }
      return { ok: false, text: JSON.stringify({ output: "main.matrix:2:1: error MX0001: '/' is not a Matrix operator", entry: 'main.matrix', success: false }) };
    } });
  const first = await bound.runtime.callTool('antimatter', 'run_command', { command: 'rewrite' });
  assert.match(first.text, /Automatic app-owned compiler check: FAILED/);
  assert.equal(checks, 1);
  assert.ok(f.calls.some(call => call.op === 'recall' && call.cue.includes('MX0001') && call.task === 'nil.project.json'));
  const repeated = await bound.runtime.callTool('antimatter', 'run_command', { command: './sdk/nilbuild check' });
  assert.match(repeated.text, /cached check/); assert.equal(checks, 1);
  await bound.runtime.callTool('antimatter', 'run_command', { command: 'cat main.matrix' });
  assert.equal(checks, 1);
  waitForAbort = true;
  const controller = new AbortController();
  const pending = bound.runtime.callTool('antimatter', 'run_command', { command: 'rewrite-again' }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started; controller.abort(); await rejected;
  assert.equal(checks, 2);
});

test('cached stub checks retain current shrink warnings and changed SDK libraries invalidate the cache and attestation',
  { skip: process.platform === 'win32' }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'pensieve-sdk-attestation-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const workspace = join(directory, 'app'); const sdk = join(directory, 'sdk');
    mkdirSync(workspace); mkdirSync(sdk);
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const builder = `#!${process.execPath}
const fs=require('node:fs'), p=require('node:path'); const a=process.argv.slice(2), v=k=>a[a.indexOf(k)+1];
const file=v('--project'), root=p.dirname(file), m=JSON.parse(fs.readFileSync(file,'utf8')), output=p.join(root,'build');
if(a[0]==='describe') process.stdout.write(JSON.stringify({schema:'nil.project.description.v1',name:m.name,projectFile:file,
projectDirectory:root,entry:p.resolve(root,m.entry),includePaths:[root],sdkPath:v('--sdk'),outputDirectory:output,
vmOutput:p.join(output,m.name+'.nil'),nativeOutput:p.join(output,m.name),analysis:{disabledRules:[],warningsAsErrors:false}}));
else process.stdout.write('Fixture compiler check passed.');
`;
    const compiler = String.raw`#!${process.execPath}
const fs=require('node:fs'), p=require('node:path'), a=process.argv.slice(2), entry=a.at(-1);
if(a.includes('--analyze')) {
 if(fs.existsSync('.no-source-evidence')) process.exit(2);
 const text=fs.readFileSync(entry,'utf8');
 if(fs.existsSync('.change-source-during-analysis')) fs.writeFileSync(entry,text+'\n!!! changed during analysis\n');
 if(fs.existsSync('.change-sdk-during-analysis')) fs.writeFileSync(p.join(__dirname,'library.nil'),'changed during analysis');
 process.stdout.write(JSON.stringify({schema:'nil.analysis.v1',source:entry,success:true,diagnostics:[],
 semantic:{schema:'nil.semantic.v1',sources:[{path:entry,text}]}}));
}
`;
    for (const name of ['nilbuild', 'nilcompiler', 'nilinterpreter', 'nillsp', 'nildebugger']) {
      writeFileSync(join(sdk, name), name === 'nilbuild' ? builder : name === 'nilcompiler' ? compiler : `#!${process.execPath}\nprocess.exit(0);\n`);
      chmodSync(join(sdk, name), 0o755);
    }
    writeFileSync(join(sdk, 'library.nil'), 'sealed library');
    const files = ['nilbuild', 'nilcompiler', 'nilinterpreter', 'nillsp', 'nildebugger', 'library.nil']
      .map(path => ({ path, sha256: hash(readFileSync(join(sdk, path))) }));
    const manifest = JSON.stringify({ payload: { files } }); writeFileSync(join(sdk, 'manifest.json'), manifest);
    const curriculumPath = join(directory, 'curriculum.json');
    writeFileSync(curriculumPath, JSON.stringify({ sdk: { manifest_sha256: hash(manifest), compiler_sha256: files[1].sha256 } }));
    writeFileSync(join(workspace, 'nil.project.json'), '{"schema":"nil.project.v1","name":"fixture","entry":"main.matrix"}');
    const stub = 'book app\nmain returns number begin paragraph\n say "Ready"\n give 0\nend paragraph\n';
    writeFileSync(join(workspace, 'main.matrix'), stub);
    const f = fixture();
    const bound = withPensieve({ enabledTools: () => [], async callTool(_server, name, args) {
      if (name === 'write_file') writeFileSync(join(workspace, args.path as string), args.content as string);
      return { ok: true, text: 'ordinary result' };
    } }, { async stream() { return { content: '', toolCalls: [] }; } }, { memory: f.memory, workspace,
      session: 's', runId: 'sdk', curriculumPath, sdkOptions: () => ({ sdkPath: sdk }) });
    await bound.runtime.callTool('antimatter', 'run_command', { command: 'nilbuild check' });
    await bound.runtime.callTool('antimatter', 'write_file', { path: 'main.matrix', content: stub.replace('say "Ready"', 'value result is 3\n say result') });
    const reverted = await bound.runtime.callTool('antimatter', 'write_file', { path: 'main.matrix', content: stub });
    assert.match(reverted.text, /cached check/); assert.match(reverted.text, /Current coverage warning:.*print\/return-only/);
    assert.equal(f.calls.filter(call => call.op === 'observe').length, 2);
    writeFileSync(join(sdk, 'library.nil'), 'tampered library payload');
    const tampered = await bound.runtime.callTool('antimatter', 'run_command', { command: 'nilbuild check' });
    assert.match(tampered.text, /SDK payload differs from its sealed manifest: library.nil/);
    assert.equal(f.calls.filter(call => call.op === 'observe').length, 2, 'changed SDK payload never produces a verified observation');
    writeFileSync(join(sdk, 'library.nil'), 'sealed library');
    writeFileSync(join(sdk, 'nilbuild'), `#!${process.execPath}\nrequire('node:fs').writeFileSync('unattested-driver-executed', 'bad');\n`);
    const changedDriver = await bound.runtime.callTool('antimatter', 'run_command', { command: 'nilbuild check' });
    assert.match(changedDriver.text, /SDK build driver differs from its sealed manifest/);
    assert.equal(existsSync(join(workspace, 'unattested-driver-executed')), false, 'driver is attested before describe can execute it');
    assert.equal(f.calls.filter(call => call.op === 'observe').length, 2);
    writeFileSync(join(sdk, 'nilbuild'), builder);
    writeFileSync(join(workspace, '.no-source-evidence'), '');
    const fallback = await bound.runtime.callTool(PENSIEVE_SERVER, 'pensieve_check_project', {});
    rmSync(join(workspace, '.no-source-evidence'));
    assert.equal(fallback.ok, true);
    const fallbackData = JSON.parse(fallback.text);
    assert.equal(fallbackData.sourceEvidence, 'entry-only');
    assert.deepEqual(fallbackData.observedCodeFiles, ['main.matrix']);
    assert.match(fallbackData.output, /Fixture compiler check passed/);
    for (const changed of ['source', 'sdk']) {
      writeFileSync(join(workspace, 'main.matrix'), stub);
      writeFileSync(join(sdk, 'library.nil'), 'sealed library');
      const marker = join(workspace, `.change-${changed}-during-analysis`); writeFileSync(marker, '');
      const checked = await bound.runtime.callTool(PENSIEVE_SERVER, 'pensieve_check_project', {});
      rmSync(marker);
      assert.equal(checked.ok, false, `${changed} mutation during the extra analysis invalidates the verdict`);
      const data = JSON.parse(checked.text);
      assert.equal(data.sourceStable, false); assert.deepEqual(data.verifiedCodeFiles, []);
      assert.equal(f.calls.filter(call => call.op === 'observe').at(-1)!.outcome.status, 'unknown');
    }
  });

test('a v2 nildata manifest is a project: source edits and manifest edits both reach an automatic check', async t => {
  // The driver's current format is nil.project.nildata; JSON and YAML are kept
  // only for compatibility. Every other test here writes nil.project.json, and
  // that is why a v2 project went unnoticed: automatic feedback did not fail,
  // it went quiet, so a real session edited Matrix for hours and was never
  // checked once. Both the candidate patterns and project discovery have to
  // accept the nildata spelling.
  const workspace = mkdtempSync(join(tmpdir(), 'pensieve-auto-nildata-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'nil.project.nildata'),
    'nildata 1\nobject\n  schema is "nil.project.v1"\n  entry is "main.matrix"\nend object\n');
  writeFileSync(join(workspace, 'main.matrix'), 'book app');
  let checks = 0;
  const f = fixture();
  const bound = withPensieve({ enabledTools: () => [], async callTool(_server, _name, args) {
    if (args.path === 'main.matrix') writeFileSync(join(workspace, 'main.matrix'), String(args.content));
    if (args.path === 'nil.project.nildata') writeFileSync(join(workspace, 'nil.project.nildata'), String(args.content));
    return { ok: true, text: 'written' };
  } }, { async stream() { return { content: '', toolCalls: [] }; } }, { memory: f.memory, workspace,
    session: 's', runId: 'nildata', curriculumPath: '/none', sdkOptions: () => ({}),
    async checkProject() { checks++; return { ok: true, text: 'compiled' }; } });

  const edit = await bound.runtime.callTool('antimatter', 'write_file',
    { path: 'main.matrix', content: 'book app\n!!! changed' });
  assert.equal(checks, 1, 'a Matrix edit in a nildata project must be checked');
  assert.match(edit.text, /Automatic/);

  // Editing the manifest itself was the residual gap: the candidate pattern
  // named nil.project.json alone, so a v2 manifest edit skipped its check.
  await bound.runtime.callTool('antimatter', 'write_file', { path: 'nil.project.nildata',
    content: 'nildata 1\nobject\n  schema is "nil.project.v1"\n  entry is "main.matrix"\n  outputDirectory is "build"\nend object\n' });
  assert.equal(checks, 2, 'editing a nildata manifest must be checked');

  // An unrelated file is still not a candidate.
  await bound.runtime.callTool('antimatter', 'write_file', { path: 'notes.md', content: 'hello' });
  assert.equal(checks, 2, 'an unrelated file must not trigger a check');
});
