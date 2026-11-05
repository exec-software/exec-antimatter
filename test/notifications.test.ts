import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BUILT_IN_SOUNDS,
  DEFAULT_NOTIFICATIONS,
  MAX_CUSTOM_SOUND_BYTES,
  detectSoundType,
  normalizeNotifications,
  notificationsEqual,
  parseFinishedTurn,
  planTurnNotification,
  previewSoundPlan,
  validateNotificationsPatch,
  type FinishedTurn,
  type NotificationSettings,
} from '../src/api/notifications';
import { NotificationSettingsStore, adoptSoundFile, readSoundDataUrl } from '../src/main/notifications';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-notifications-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: join(root, 'state', 'notifications.json') };
}

/** A smallest-possible valid WAV: the RIFF/WAVE headers and one sample of silence. */
function wav(bytes = 8): Buffer {
  const data = Buffer.alloc(bytes);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24);
  head.writeUInt32LE(8000, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Built through the boundary, because that is where a reported turn is sanitized. */
const turn = (patch: Partial<FinishedTurn> = {}): FinishedTurn => parseFinishedTurn({
  threadId: 'thread-1',
  title: 'Port the renderer',
  failed: false,
  stopped: false,
  elapsedMs: 72_999,
  onScreen: false,
  ...patch,
});

const settings = (patch: Partial<NotificationSettings> = {}): NotificationSettings =>
  normalizeNotifications({ ...DEFAULT_NOTIFICATIONS, ...patch });

test('notification defaults fall back rather than selecting something that cannot be played', () => {
  assert.deepEqual(normalizeNotifications(null), DEFAULT_NOTIFICATIONS);
  assert.deepEqual(normalizeNotifications({ soundId: 'nope' }).soundId, 'chime');
  // A chosen sound that is not on record cannot be the selection; the default is audible instead.
  assert.equal(normalizeNotifications({ soundId: 'custom' }).soundId, 'chime');
  assert.equal(normalizeNotifications({ soundId: 'custom', customSound: { path: '/tmp/x.wav', name: 'x.wav', mime: 'audio/wav', bytes: 10 } }).soundId, 'custom');
  // Nonsense in any one field discards that sound rather than keeping half of it.
  for (const broken of [{ path: '', name: 'x', mime: 'audio/wav', bytes: 1 }, { path: '/x', name: '  ', mime: 'audio/wav', bytes: 1 },
    { path: '/x', name: 'x', mime: 'text/plain', bytes: 1 }, { path: '/x', name: 'x', mime: 'audio/wav', bytes: 0 },
    { path: '/x', name: 'x', mime: 'audio/wav', bytes: MAX_CUSTOM_SOUND_BYTES + 1 }, 'x.wav', [], null]) {
    assert.equal(normalizeNotifications({ customSound: broken }).customSound, null);
  }
  for (const [input, expected] of [[-3, 0], [9, 1], [0.613, 0.61], ['loud', DEFAULT_NOTIFICATIONS.volume], [Number.NaN, DEFAULT_NOTIFICATIONS.volume]] as const) {
    assert.equal(normalizeNotifications({ volume: input }).volume, expected);
  }
});

test('notification patches are strict, and a sound file is never named by a renderer', () => {
  assert.deepEqual(validateNotificationsPatch({ desktop: false }), { desktop: false });
  assert.deepEqual(validateNotificationsPatch({ soundId: 'knock' }), { soundId: 'knock' });
  assert.deepEqual(validateNotificationsPatch({ soundId: 'custom' }), { soundId: 'custom' });
  assert.deepEqual(validateNotificationsPatch({ volume: 0.333 }), { volume: 0.33 });
  // The one key that matters: a window that could set this could aim the file reader anywhere.
  assert.throws(() => validateNotificationsPatch({ customSound: { path: '/etc/shadow', name: 'x', mime: 'audio/wav', bytes: 1 } }), /file picker/);
  for (const invalid of [null, [], 'on', new Date(), { chime: true }, { desktop: 'yes' }, { desktop: 1 },
    { sound: null }, { onlyWhenUnfocused: 'true' }, { soundId: 'fanfare' }, { soundId: 1 },
    { volume: -0.1 }, { volume: 1.1 }, { volume: '0.5' }, { volume: Number.NaN },
    JSON.parse('{"__proto__":{"desktop":false}}')]) {
    assert.throws(() => validateNotificationsPatch(invalid));
  }
  assert.equal(notificationsEqual(settings(), settings()), true);
  assert.equal(notificationsEqual(settings(), settings({ volume: 0.3 })), false);
  // customSound is an object, so equality has to compare it by value or every save writes.
  const sound = { path: '/x.wav', name: 'x.wav', mime: 'audio/wav', bytes: 12 };
  assert.equal(notificationsEqual(settings({ customSound: sound }), settings({ customSound: { ...sound } })), true);
  assert.equal(notificationsEqual(settings({ customSound: sound }), settings({ customSound: { ...sound, bytes: 13 } })), false);
});

/**
 * A sound file is identified by its bytes, because the extension is only a claim. A file the
 * decoder will not play has to be refused at the picker, where it can be explained.
 */
test('sound files are identified by content', () => {
  assert.deepEqual(detectSoundType(wav().subarray(0, 16))?.extension, 'wav');
  assert.equal(detectSoundType(Buffer.from('fLaC\0\0\0\0'))?.mime, 'audio/flac');
  assert.equal(detectSoundType(Buffer.from('OggS\0\0\0\0'))?.mime, 'audio/ogg');
  assert.equal(detectSoundType(Buffer.from('ID3\x03\0\0\0\0'))?.mime, 'audio/mpeg');
  assert.equal(detectSoundType(Buffer.from([0xff, 0xfb, 0x90, 0x00]))?.mime, 'audio/mpeg');
  assert.equal(detectSoundType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ')]))?.mime, 'audio/mp4');
  for (const notSound of [Buffer.alloc(0), Buffer.from('RIFF....AVI '), Buffer.from('<html>'), Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    // A reserved MPEG version and a reserved layer are not frames, so 0xffe. alone is not audio.
    Buffer.from([0xff, 0xe9, 0x00, 0x00]), Buffer.from([0xff, 0xf9, 0x00, 0x00]), Buffer.from([0xff, 0x00])]) {
    assert.equal(detectSoundType(notSound), null, notSound.toString('latin1'));
  }
});

test('nothing is announced about a turn the person was watching, or stopped themselves', () => {
  const on = settings();
  // Stopped by hand: they were there, and the app telling them what they just did is noise.
  assert.deepEqual(planTurnNotification(on, turn({ stopped: true }), { focused: false }), { desktop: null, sound: null });
  // Both channels off is the one case where reporting is pointless work.
  assert.deepEqual(planTurnNotification(settings({ desktop: false, sound: false }), turn(), { focused: false }), { desktop: null, sound: null });

  // "Not watching" is both halves: focus and the conversation on screen.
  assert.deepEqual(planTurnNotification(on, turn({ onScreen: true }), { focused: true }), { desktop: null, sound: null });
  assert.notEqual(planTurnNotification(on, turn({ onScreen: true }), { focused: false }).desktop, null);
  assert.notEqual(planTurnNotification(on, turn({ onScreen: false }), { focused: true }).desktop, null);

  // Switched off, the same turn announces itself whatever is in front of you.
  const always = settings({ onlyWhenUnfocused: false });
  assert.notEqual(planTurnNotification(always, turn({ onScreen: true }), { focused: true }).desktop, null);
});

test('what a finished turn says, and which sound it plays', () => {
  const plan = planTurnNotification(settings(), turn(), { focused: false });
  assert.deepEqual(plan.desktop, { title: 'Port the renderer', body: 'Reply ready after 1m 12s.' });
  assert.deepEqual(plan.sound, { kind: 'builtin', id: 'chime', volume: 0.6 });

  // A failure is reported on the same terms: from outside the window it is the more useful of
  // the two to hear about, and silence there is indistinguishable from a turn still running.
  const failed = planTurnNotification(settings(), turn({ failed: true }), { focused: false });
  assert.equal(failed.desktop?.body, 'The turn failed after 1m 12s.');
  assert.notEqual(failed.sound, null);

  // An untitled conversation still has to say who is talking.
  assert.equal(planTurnNotification(settings(), turn({ title: '' }), { focused: false }).desktop?.title, 'Antimatter');
  // Titles are the person's own text, relayed into a desktop notice.
  assert.equal(planTurnNotification(settings(), turn({ title: 'two\nlines\u0000' }), { focused: false }).desktop?.title, 'two lines');

  // Each channel alone.
  assert.equal(planTurnNotification(settings({ sound: false }), turn(), { focused: false }).sound, null);
  assert.equal(planTurnNotification(settings({ desktop: false }), turn(), { focused: false }).desktop, null);
  // Muted on purpose: play nothing rather than an inaudible tone.
  assert.equal(planTurnNotification(settings({ volume: 0 }), turn(), { focused: false }).sound, null);

  const sound = { path: '/x.wav', name: 'x.wav', mime: 'audio/wav', bytes: 12 };
  assert.deepEqual(planTurnNotification(settings({ soundId: 'custom', customSound: sound }), turn(), { focused: false }).sound,
    { kind: 'custom', volume: 0.6 });
  // The preview ignores the switches, and a muted volume previews at the default rather than silently.
  assert.deepEqual(previewSoundPlan(settings({ sound: false, volume: 0 })), { kind: 'builtin', id: 'chime', volume: DEFAULT_NOTIFICATIONS.volume });
  assert.equal(BUILT_IN_SOUNDS.every((entry) => entry.tones.length > 0 && entry.tones.every((tone) => tone.hz > 0 && tone.ms > 0)), true);
});

test('a reported turn is validated like any other renderer input', () => {
  assert.equal(parseFinishedTurn({ threadId: 'a', title: 'x', elapsedMs: -5 }).elapsedMs, 0);
  assert.equal(parseFinishedTurn({ threadId: 'a', elapsedMs: 'soon' }).elapsedMs, 0);
  assert.equal(parseFinishedTurn({ threadId: 'a', title: 42 }).title, '');
  assert.equal(parseFinishedTurn({ threadId: 'a', failed: 'yes' }).failed, false);
  for (const invalid of [null, [], 'a', {}, { threadId: '' }, { threadId: 'x'.repeat(129) }]) {
    assert.throws(() => parseFinishedTurn(invalid));
  }
});

test('notification settings persist privately, and survive a corrupt or hostile file', (t) => {
  const { root, file } = fixture(t);
  const store = new NotificationSettingsStore(file);
  assert.deepEqual(store.get(), DEFAULT_NOTIFICATIONS);

  const saved = store.update({ desktop: false, soundId: 'knock', volume: 0.25 });
  assert.deepEqual(saved, { ...DEFAULT_NOTIFICATIONS, desktop: false, soundId: 'knock', volume: 0.25 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new NotificationSettingsStore(file).get(), saved);

  // A returned snapshot is a copy: mutating it must not reach into the store.
  const snapshot = store.get();
  snapshot.volume = 1;
  assert.equal(store.get().volume, 0.25);

  // A no-op update does not rewrite the file.
  let writes = 0;
  const counted = new NotificationSettingsStore(file, (path, contents) => { writes += 1; writeFileSync(path, contents); });
  counted.update({ volume: 0.25 });
  assert.equal(writes, 0);
  counted.update({ volume: 0.3 });
  assert.equal(writes, 1);

  // A failed write leaves the published value alone rather than claiming a setting was saved.
  const failing = new NotificationSettingsStore(file, () => { throw new Error('read-only disk'); });
  assert.throws(() => failing.update({ desktop: true }), /read-only disk/);
  assert.equal(failing.get().desktop, false);

  for (const contents of ['', 'not json', '[]', 'null', '{"desktop":false}', `{"version":2,"desktop":false}`]) {
    const broken = join(root, 'broken.json');
    writeFileSync(broken, contents);
    assert.deepEqual(new NotificationSettingsStore(broken).get(), DEFAULT_NOTIFICATIONS, contents);
  }
  // A symlinked settings file is not followed, and a missing one is not an error.
  const link = join(root, 'link.json');
  symlinkSync(file, link);
  assert.deepEqual(new NotificationSettingsStore(link).get(), DEFAULT_NOTIFICATIONS);
  assert.deepEqual(new NotificationSettingsStore(join(root, 'absent.json')).get(), DEFAULT_NOTIFICATIONS);
});

test('choosing a sound selects it, and forgetting one puts the selection back on a built-in', (t) => {
  const { root, file } = fixture(t);
  const store = new NotificationSettingsStore(file);
  store.update({ soundId: 'ping' });

  const sound = { path: join(root, 'notification-sound.wav'), name: 'boing.wav', mime: 'audio/wav', bytes: 52 };
  assert.equal(store.setCustomSound(sound).soundId, 'custom', 'nobody picks a sound then expects the old one');
  assert.deepEqual(store.get().customSound, sound);
  assert.equal(store.setCustomSound(null).soundId, DEFAULT_NOTIFICATIONS.soundId);
  assert.equal(store.get().customSound, null);

  // A built-in selection made before a sound was chosen is not disturbed by forgetting one.
  store.update({ soundId: 'knock' });
  assert.equal(store.setCustomSound(null).soundId, 'knock');
});

/**
 * The chosen file is copied rather than referenced. A sound picked out of Downloads otherwise
 * goes silent the first time that folder is emptied, and the only path this app ever reads a
 * sound from should be one inside its own state directory.
 */
test('a chosen sound file is vetted and copied', (t) => {
  const { root } = fixture(t);
  const state = join(root, 'state');
  const source = join(root, 'boing.wav');
  writeFileSync(source, wav(64));

  const adopted = adoptSoundFile(source, state);
  assert.equal(adopted.path, join(state, 'notification-sound.wav'));
  assert.equal(adopted.name, 'boing.wav');
  assert.equal(adopted.mime, 'audio/wav');
  assert.equal(adopted.bytes, statSync(source).size);
  assert.deepEqual(readFileSync(adopted.path), readFileSync(source));
  assert.equal(statSync(adopted.path).mode & 0o777, 0o600);

  // Deleting the original changes nothing: the copy is what gets played.
  rmSync(source);
  const data = readSoundDataUrl(adopted);
  assert.equal(data?.mime, 'audio/wav');
  assert.equal(data?.dataUrl.startsWith('data:audio/wav;base64,'), true);
  assert.equal(Buffer.from(data!.dataUrl.split(',')[1], 'base64').length, adopted.bytes);

  // Anything the decoder would refuse is refused here instead, where it can be explained.
  const text = join(root, 'notes.wav');
  writeFileSync(text, 'this is not a sound');
  assert.throws(() => adoptSoundFile(text, state), /not a WAV, MP3, Ogg, FLAC or M4A/);
  const empty = join(root, 'empty.wav');
  writeFileSync(empty, '');
  assert.throws(() => adoptSoundFile(empty, state), /empty/);
  const huge = join(root, 'huge.wav');
  writeFileSync(huge, Buffer.alloc(MAX_CUSTOM_SOUND_BYTES + 1));
  assert.throws(() => adoptSoundFile(huge, state), /under 2 MB/);
  const directory = join(root, 'folder.wav');
  mkdirSync(directory);
  assert.throws(() => adoptSoundFile(directory, state));
  assert.throws(() => adoptSoundFile(join(root, 'absent.wav'), state));

  // A sound whose file has gone is silent, not a thrown error on the way to playing it.
  assert.equal(readSoundDataUrl({ ...adopted, path: join(root, 'gone.wav') }), null);
});
