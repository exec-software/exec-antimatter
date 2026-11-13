import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_DOOM_GAME_ID, validateDoomGameId, validateDoomSaves } from '../src/api/doom';
import { DoomSaveStore } from '../src/main/doom';

test('save inputs cannot name arbitrary files, escape game directories, or allocate unbounded storage', () => {
  for (const id of ['../outside', '/absolute', 'x'.repeat(65), null]) assert.throws(() => validateDoomGameId(id));
  for (const name of ['../doomsav0.dsg', 'config.json', 'doomsav99.dsg', '/doomsav0.dsg']) assert.throws(() => validateDoomSaves([{ name, bytes: new Uint8Array([1]) }]));
  assert.throws(() => validateDoomSaves([{ name: 'doomsav0.dsg', bytes: [1] }]));
  assert.throws(() => validateDoomSaves([{ name: 'doomsav0.dsg', bytes: new Uint8Array(2 * 1024 * 1024 + 1) }]));
  assert.throws(() => validateDoomSaves([{ name: 'doomsav0.dsg', bytes: new Uint8Array([1]) }, { name: 'doomsav0.dsg', bytes: new Uint8Array([2]) }]));
});

test('game saves survive process restart, isolate WAD identities, and reject stale iframe sessions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'doom-saves-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new DoomSaveStore(dir);
  const session = store.open(DEFAULT_DOOM_GAME_ID);
  const file = { name: 'doomsav0.dsg', bytes: new Uint8Array([1, 2, 3, 4]) };
  store.save(session.token, [file]);
  assert.equal(statSync(join(dir, `${DEFAULT_DOOM_GAME_ID}.json`)).mode & 0o777, 0o600);
  assert.deepEqual(new DoomSaveStore(dir).open(DEFAULT_DOOM_GAME_ID).saves, [file]);
  assert.deepEqual(store.open('a'.repeat(64)).saves, []);
  store.open(DEFAULT_DOOM_GAME_ID);
  assert.throws(() => store.save(session.token, []), /no longer active/);
});

test('corrupt saves and failed durable writes are reported without clobbering prior saves', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'doom-saves-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, `${DEFAULT_DOOM_GAME_ID}.json`);
  const store = new DoomSaveStore(dir); const session = store.open(DEFAULT_DOOM_GAME_ID);
  store.save(session.token, [{ name: 'doomsav0.dsg', bytes: new Uint8Array([10]) }]);
  const before = readFileSync(file, 'utf8');
  const failed = new DoomSaveStore(dir, () => { throw new Error('disk full'); });
  assert.throws(() => failed.save(failed.open(DEFAULT_DOOM_GAME_ID).token, []), /disk full/);
  assert.equal(readFileSync(file, 'utf8'), before);
  writeFileSync(file, 'bad data'); assert.throws(() => store.open(DEFAULT_DOOM_GAME_ID), /Existing files were kept/);
  assert.equal(readFileSync(file, 'utf8'), 'bad data');
});
