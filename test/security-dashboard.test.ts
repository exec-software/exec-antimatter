import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecurityService } from '../src/main/security/service';
import { scanWorkspace } from '../src/main/security/scanner';
import { SECURITY_LIMITS } from '../src/api/security';

const scratch = (t: { after(fn: () => void): void }) => { const path = mkdtempSync(join(tmpdir(), 'antimatter-security-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
const fakeCredential = `ghp_${'TESTONLY'.repeat(5)}`;
const fixture = (t: { after(fn: () => void): void }) => { const path = scratch(t); const root = join(path, 'project'); mkdirSync(root); return { path, root, service: new SecurityService(join(path, 'state')) }; };

test('scans hidden source/config files with shared patterns, excludes links/generated/binary content, and never persists evidence', async (t) => {
  const { path, root, service } = fixture(t);
  writeFileSync(join(root, '.env'), `TOKEN=${fakeCredential}`);
  mkdirSync(join(root, '.github')); writeFileSync(join(root, '.github', 'workflow.yml'), 'eval(userInput)');
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'unsafe.js'), 'eval(untrusted)');
  writeFileSync(join(path, 'outside.js'), 'eval(outside)'); symlinkSync(join(path, 'outside.js'), join(root, 'linked.js'));
  writeFileSync(join(root, 'binary'), Buffer.from([0, 255, 0, 12]));
  writeFileSync(join(root, 'oversized'), 'x'.repeat(SECURITY_LIMITS.fileBytes + 1));
  writeFileSync(join(root, 'long.txt'), `${'x'.repeat(2001)}eval(untrusted)\n`);
  const report = await service.scan(root, { modes: ['secrets', 'code'] });
  assert.deepEqual(report.findings.map(f => f.file).sort(), ['.env', '.github/workflow.yml']);
  assert.equal(report.skippedFiles, 3); assert.equal(report.excludedDirectories, 1); assert.equal(report.skippedLines, 1);
  assert.equal(report.scannedFiles, 3); assert.equal(report.truncated, false);
  const persisted = readFileSync(join(path, 'state', readdirSync(join(path, 'state'))[0]), 'utf8');
  assert.doesNotMatch(persisted, new RegExp(fakeCredential)); assert.doesNotMatch(JSON.stringify(report), /evidence|fingerprintKey/);
  assert.equal(statSync(join(path, 'state')).mode & 0o777, 0o700);
  assert.equal(statSync(join(path, 'state', readdirSync(join(path, 'state'))[0])).mode & 0o777, 0o600);
});

test('triage survives reload and unchanged scans; changed or unresolved source reopens findings', async (t) => {
  const { path, root, service } = fixture(t); writeFileSync(join(root, 'app.js'), 'eval(input)');
  const first = await service.scan(root, { modes: ['code'] }); const target = first.findings[0];
  await service.triage(root, { reportId: first.id, findingId: target.id, status: 'dismissed', note: 'Reviewed input path', expected: { status: 'open', note: '' } });
  const reloaded = new SecurityService(join(path, 'state')); assert.equal((await reloaded.list(root)).reports[0].findings[0].status, 'dismissed');
  const next = await reloaded.scan(root, { modes: ['code'] }); assert.equal(next.findings[0].status, 'dismissed'); assert.equal(next.findings[0].note, 'Reviewed input path');
  await reloaded.triage(root, { reportId: next.id, findingId: target.id, status: 'resolved', note: 'Awaiting fix', expected: { status: 'dismissed', note: 'Reviewed input path' } });
  assert.equal((await reloaded.scan(root, { modes: ['code'] })).findings[0].status, 'open');
  writeFileSync(join(root, 'app.js'), 'eval(otherInput)');
  const changed = await reloaded.scan(root, { modes: ['code'] }); assert.notEqual(changed.findings[0].id, target.id); assert.equal(changed.findings[0].note, '');
  await assert.rejects(reloaded.triage(root, { reportId: changed.id, findingId: target.id, status: 'dismissed', note: '', expected: { status: 'open', note: '' } }), /not in this report/);
});

test('exports preserve review and relative source locations without keys, evidence, or host paths', async (t) => {
  const { root, service } = fixture(t); writeFileSync(join(root, 'file with spaces.js'), `eval(input)\n${fakeCredential}`);
  const report = await service.scan(root, { modes: ['code', 'secrets'] });
  await service.triage(root, { reportId: report.id, findingId: report.findings[0].id, status: 'dismissed', note: 'Reviewed | <script>', expected: { status: 'open', note: '' } });
  for (const format of ['json', 'sarif', 'markdown'] as const) {
    const output = await service.serializeExport(root, report.id, format);
    assert.doesNotMatch(output.contents, new RegExp(fakeCredential)); assert.ok(!output.contents.includes(root)); assert.doesNotMatch(output.contents, /fingerprintKey|evidence/);
    if (format === 'sarif') { const parsed = JSON.parse(output.contents); assert.equal(parsed.version, '2.1.0'); assert.equal(parsed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'file%20with%20spaces.js'); assert.equal(parsed.runs[0].results[0].suppressions[0].kind, 'external'); }
    if (format === 'markdown') assert.ok(output.contents.includes('Reviewed \\| \\<script\\>'));
  }
  await assert.rejects(service.serializeExport(root, report.id, 'html' as never), /Choose JSON/);
  await service.remove(root, report.id); assert.equal((await service.list(root)).reports.length, 0); assert.ok(readFileSync(join(root, 'file with spaces.js'), 'utf8').includes(fakeCredential));
});

test('cancellation and finding bounds produce explicitly incomplete saved reports', async (t) => {
  const { root, service } = fixture(t); writeFileSync(join(root, 'large.js'), 'eval(input)\n'.repeat(SECURITY_LIMITS.findings + 10));
  const bounded = await service.scan(root, { modes: ['code'] }); assert.equal(bounded.findings.length, SECURITY_LIMITS.findings); assert.equal(bounded.truncated, true);
  const controller = new AbortController(); controller.abort();
  const cancelled = await scanWorkspace(root, ['code'], 'test-key', controller.signal); assert.equal(cancelled.cancelled, true); assert.equal(cancelled.scannedFiles, 0);
  const running = service.scan(root, { modes: ['code'] });
  while (!(await service.list(root)).running) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(await service.cancel(root), true); assert.equal((await running).cancelled, true);
  assert.equal((await service.list(root)).running, null); assert.equal(await service.cancel(root), false);
});

test('invalid input, cross-project reports, and corrupt persistence are refused without clearing data', async (t) => {
  const { path, root, service } = fixture(t); writeFileSync(join(root, 'code.js'), 'eval(input)');
  await assert.rejects(service.scan(root, { modes: ['shell'] as never }), /Choose a secrets scan/);
  await assert.rejects(service.list('relative/path'), /Choose a workspace/);
  const report = await service.scan(root, { modes: ['code'] });
  const second = join(path, 'other-project'); mkdirSync(second);
  await assert.rejects(service.serializeExport(second, report.id, 'json'), /no longer available/);
  await assert.rejects(service.triage(root, { reportId: report.id, findingId: report.findings[0].id, status: 'open', note: 'x'.repeat(1001), expected: { status: 'open', note: '' } }), /Invalid security report text/);
  const file = readdirSync(join(path, 'state')).map(name => join(path, 'state', name)).find(name => readFileSync(name, 'utf8').includes(report.id))!;
  writeFileSync(file, '{broken'); await assert.rejects(service.list(root)); assert.equal(readFileSync(file, 'utf8'), '{broken');
});

test('retains ten reports without deleting project content', async (t) => {
  const { root, service } = fixture(t); writeFileSync(join(root, 'code.js'), 'eval(input)');
  const first = await service.scan(root, { modes: ['code'] });
  for (let i = 0; i < SECURITY_LIMITS.retainedReports; i++) await service.scan(root, { modes: ['code'] });
  const reports = (await service.list(root)).reports; assert.equal(reports.length, 10); assert.ok(!reports.some(r => r.id === first.id));
});

test('shutdown cancels work and refuses later scans', async t => {
  const { root, service } = fixture(t); writeFileSync(join(root, 'scan.js'), 'eval(input)\n'.repeat(1000));
  const pending = service.scan(root, { modes: ['code'] });
  while (!service.busy()) await new Promise(resolve => setTimeout(resolve, 1));
  service.dispose(); assert.equal((await pending).cancelled, true); assert.equal(service.busy(), false);
  await assert.rejects(service.scan(root, { modes: ['code'] }), /shutting down/);
});

test('concurrent triage compares captured status and note without overwriting a newer review', async t => {
  const { root, service } = fixture(t); writeFileSync(join(root, 'code.js'), 'eval(input)');
  const report = await service.scan(root, { modes: ['code'] });
  const input = { reportId: report.id, findingId: report.findings[0].id, status: 'dismissed' as const, note: 'First review', expected: { status: 'open' as const, note: '' } };
  const results = await Promise.allSettled([service.triage(root, input), service.triage(root, { ...input, note: 'Concurrent review' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const saved = (await service.list(root)).reports[0].findings[0];
  await assert.rejects(service.triage(root, { ...input, expected: { status: saved.status, note: 'Older note with matching status' } }), /changed since your draft/);
  await assert.rejects(service.triage(root, { ...input, expected: undefined } as never), /Invalid security report data/);
  assert.deepEqual((await service.list(root)).reports[0].findings[0], saved);
  const accepted = await service.triage(root, { ...input, expected: { status: saved.status, note: saved.note }, note: 'Reviewed conflict explicitly' });
  assert.equal(accepted.findings[0].note, 'Reviewed conflict explicitly');
});
