import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createMicroFixture, memoryAblationAdapter, verifyMicroCandidate, isolatedSandbox, assertMicroContinuation, continuationPrompt } from './pensieve-model-eval-support.mjs';

const repo = resolve(import.meta.dirname, '..');
const sdkPath = JSON.parse(fs.readFileSync(join(repo, 'vendor/pensieve/curriculum.json'))).sdk.path;
const scratch = fs.mkdtempSync(join(process.env.PENSIEVE_EVAL_TEST_ROOT || tmpdir(), 'pensieve-eval-tests-'));
const quoteReference = `book probe.logic
public quote-order receives units as number, unit-price as number, free-threshold as number, shipping-fee as number returns number begin paragraph
    when units is at most 0 or unit-price is less than 0 or free-threshold is less than 0 or shipping-fee is less than 0 then
        give -1
    end when
    value subtotal is units times unit-price
    when subtotal is at least free-threshold then
        give subtotal
    end when
    give subtotal plus shipping-fee
end paragraph
`;
const stockReference = `book probe.logic
public stock-state begin record
    field available as number
    field reserved as number
    field fulfilled as number
end record
public new-stock receives units as number returns stock-state begin paragraph
    variable quantity as number is units
    when quantity is less than 0 then
        set quantity to 0
    end when
    give build stock-state with available being quantity, reserved being 0, fulfilled being 0
end paragraph
public reserve-stock receives current as stock-state, units as number returns stock-state begin paragraph
    when units is greater than 0 and units is at most current.available then
        give build stock-state with available being current.available minus units, reserved being current.reserved plus units, fulfilled being current.fulfilled
    end when
    give build stock-state with available being current.available, reserved being current.reserved, fulfilled being current.fulfilled
end paragraph
public cancel-stock receives current as stock-state, units as number returns stock-state begin paragraph
    when units is greater than 0 and units is at most current.reserved then
        give build stock-state with available being current.available plus units, reserved being current.reserved minus units, fulfilled being current.fulfilled
    end when
    give build stock-state with available being current.available, reserved being current.reserved, fulfilled being current.fulfilled
end paragraph
public fulfill-stock receives current as stock-state, units as number returns stock-state begin paragraph
    when units is greater than 0 and units is at most current.reserved then
        give build stock-state with available being current.available, reserved being current.reserved minus units, fulfilled being current.fulfilled plus units
    end when
    give build stock-state with available being current.available, reserved being current.reserved, fulfilled being current.fulfilled
end paragraph
`;
function candidate(name, source) {
  const workspace = join(scratch, name); fs.mkdirSync(join(workspace, 'src/probe'), { recursive: true });
  fs.writeFileSync(join(workspace, 'src/probe/logic.matrix'), source);
  fs.writeFileSync(join(workspace, 'src/main.matrix'), 'book app.main\nmain returns number begin paragraph\n    say "PASS"\n    give 0\nend paragraph\n');
  return workspace;
}

test('off masks initial, explicit and diagnostic recalls while observations/capture/status still reach memory', async () => {
  const requests = []; const masked = [];
  const memory = { enabled: true, async invoke(workspace, request, signal) { requests.push({ workspace, request, signal }); return { text: 'SECRET REFERENCE', items: ['secret'] }; } };
  const arm = memoryAblationAdapter(memory, 'off', request => masked.push(request));
  for (const cue of ['initial user task', 'explicit tool lookup', 'compiler diagnostic']) {
    const result = await arm.invoke('/project', { op: 'recall', cue });
    assert.deepEqual(result.items, []); assert(!result.text.includes('SECRET'));
  }
  for (const op of ['capture', 'observe', 'status']) await arm.invoke('/project', { op });
  assert.equal(masked.length, 3); assert.deepEqual(requests.map(x => x.request.op), ['capture', 'observe', 'status']);
  assert.equal(arm.enabled, true);
  memory.enabled = false; assert.equal(arm.enabled, false);
  const enabled = memoryAblationAdapter(memory, 'on');
  assert.equal((await enabled.invoke('/project', { op: 'recall' })).text, 'SECRET REFERENCE');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(arm.invoke('/project', { op: 'recall' }, controller.signal));
});

test('sandbox permits SDK/project and excludes evaluator and unrelated host projects', () => {
  const workspace = candidate('isolation', quoteReference);
  const result = spawnSync('bwrap', [...isolatedSandbox(workspace, sdkPath), '/bin/sh', '-c', 'test -f src/probe/logic.matrix && test -x "$NIL_SDK_PATH/nilbuild" && test ! -e ' + repo + '/scripts/pensieve-model-eval-support.test.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

for (const [task, source] of [['quote', quoteReference], ['stock', stockReference]]) {
  test(task + ' verifier accepts compiled reference implementation on independent inputs', () => {
    const workspace = candidate(task + '-good', source);
    const report = verifyMicroCandidate({ task, workspace, sdkPath, directory: join(scratch, task + '-good-report') });
    assert.equal(report.apiAcceptance, 'passed', JSON.stringify({ ...report, expected: undefined, actual: undefined, cases: undefined }) + '\n' + fs.readFileSync(join(scratch, task + '-good-report/stderr.txt')));
    assert(report.expectedComparisons > 40);
  });
}

test('quote verifier rejects a compiling constant implementation despite PASS-only main', () => {
  const source = `book probe.logic\npublic quote-order receives units as number, unit-price as number, free-threshold as number, shipping-fee as number returns number begin paragraph\n    give 0\nend paragraph\n`;
  const report = verifyMicroCandidate({ task: 'quote', workspace: candidate('quote-bogus', source), sdkPath, directory: join(scratch, 'quote-bogus-report') });
  assert.equal(report.exitCode, 0); assert.equal(report.apiAcceptance, 'failed'); assert(report.mismatchCount > 1);
});

test('stock verifier rejects shared-handle mutation even if transition values are correct', () => {
  const source = stockReference.replace('give build stock-state with available being current.available minus units, reserved being current.reserved plus units, fulfilled being current.fulfilled', 'set current.available to current.available minus units\n        set current.reserved to current.reserved plus units\n        give current');
  const report = verifyMicroCandidate({ task: 'stock', workspace: candidate('stock-alias', source), sdkPath, directory: join(scratch, 'stock-alias-report') });
  assert.equal(report.exitCode, 0, fs.readFileSync(join(scratch, 'stock-alias-report/stderr.txt'), 'utf8')); assert.equal(report.apiAcceptance, 'failed'); assert(report.mismatchCount > 0);
});

test('stock verifier rejects returning the input record for invalid transitions', () => {
  const source = stockReference.replaceAll('give build stock-state with available being current.available, reserved being current.reserved, fulfilled being current.fulfilled', 'give current');
  const report = verifyMicroCandidate({ task: 'stock', workspace: candidate('stock-invalid-alias', source), sdkPath, directory: join(scratch, 'stock-invalid-alias-report') });
  assert.equal(report.exitCode, 0); assert.equal(report.apiAcceptance, 'failed'); assert(report.mismatchCount > 0);
});

test('fixture task contracts have no warehouse implementation and are stable', () => {
  assert.equal(createMicroFixture('quote').prompts.reservation.sha256, createMicroFixture('quote').prompts.reservation.sha256);
  assert.throws(() => createMicroFixture('unknown'));
});

console.log('Evaluation verifier test evidence:', scratch);

test('continuation requires the same task and unchanged frozen candidate but does not require prior success', () => {
  const initial = { phase: 'reservation', task: 'quote', sourceFingerprint: 'abc123', session: 'old-session', stopReason: 'limit', acceptance: 'failed' };
  assert.deepEqual(assertMicroContinuation('quote', initial, 'abc123'), { session: 'old-session', sourceFingerprint: 'abc123', initialStopReason: 'limit' });
  assert.throws(() => assertMicroContinuation('quote', initial, 'manually-changed'));
  assert.throws(() => assertMicroContinuation('stock', initial, 'abc123'));
  assert.throws(() => assertMicroContinuation('warehouse', initial, 'abc123'));
  assert.throws(() => assertMicroContinuation('quote', null, 'abc123'));
  const original = createMicroFixture('quote').prompts.reservation.text;
  const continued = continuationPrompt(original);
  assert(continued.startsWith(original + '\n\n'));
  assert(continued.includes('query Pensieve'));
  assert(!continued.slice(original.length).includes('is at most'));
});
