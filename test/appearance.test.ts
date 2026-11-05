import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { DEFAULT_APPEARANCE, minutesOfDay, nextThemeBoundary, normalizeAppearance, resolveTheme, validateAppearancePatch } from '../src/api/appearance';
import { AppearanceSettingsStore, appearanceBackground, isAppearancePage, mayReadAppearance, mayUpdateAppearance } from '../src/main/appearance';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'antimatter-appearance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: join(root, 'private', 'appearance.json') };
}

test('appearance defaults and normalization never admit a CSS expression', () => {
  assert.deepEqual(normalizeAppearance(null), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ theme: 'light', secondaryAccent: '#ABcdEF' }), { ...DEFAULT_APPEARANCE, theme: 'light', secondaryAccent: '#abcdef' });
  for (const invalid of ['red', '#abc', '#12345678', 'var(--something)', 'url(https://example.test)', '#123456; color:red', 123456, null]) {
    assert.equal(normalizeAppearance({ secondaryAccent: invalid }).secondaryAccent, '#33b7a6');
  }
  assert.equal(appearanceBackground(normalizeAppearance(null)), '#141414');
  assert.equal(appearanceBackground(normalizeAppearance({ theme: 'light' })), '#f6f5f2');
});

test('appearance updates strictly validate patches without accepting unsupported fields', () => {
  assert.deepEqual(validateAppearancePatch({ theme: 'light' }), { theme: 'light' });
  assert.deepEqual(validateAppearancePatch({ secondaryAccent: '#AABbCC' }), { secondaryAccent: '#aabbcc' });
  assert.deepEqual(validateAppearancePatch({ autoTheme: true }), { autoTheme: true });
  assert.deepEqual(validateAppearancePatch({ autoLightFrom: '00:00', autoDarkFrom: '23:59' }), { autoLightFrom: '00:00', autoDarkFrom: '23:59' });
  for (const invalid of [null, [], 'light', new Date(), { theme: 'system' }, { theme: undefined }, { secondaryAccent: 'transparent' }, { secondaryAccent: '#abc' }, { background: '#000000' }, JSON.parse('{"__proto__":{"theme":"light"}}'),
    { autoTheme: 'yes' }, { autoTheme: 1 }, { autoLightFrom: '7:00' }, { autoLightFrom: '24:00' }, { autoLightFrom: '12:60' }, { autoLightFrom: '12:00:00' }, { autoDarkFrom: '' }, { autoDarkFrom: 1900 }, { autoDarkFrom: '19:00; color:red' }]) {
    assert.throws(() => validateAppearancePatch(invalid));
  }
});

test('appearance persists private atomic state and returns copies of its startup cache', (t) => {
  const { root, file } = fixture(t);
  const store = new AppearanceSettingsStore(file);
  assert.deepEqual(store.get(), DEFAULT_APPEARANCE);
  assert.deepEqual(store.update({ theme: 'light', secondaryAccent: '#FFAA99' }), { ...DEFAULT_APPEARANCE, theme: 'light', secondaryAccent: '#ffaa99' });
  assert.equal(statSync(join(root, 'private')).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, ...DEFAULT_APPEARANCE, theme: 'light', secondaryAccent: '#ffaa99' });
  assert.deepEqual(new AppearanceSettingsStore(file).get(), store.get());
  const external = store.get();
  external.theme = 'dark';
  writeFileSync(file, 'broken after startup');
  assert.equal(store.get().theme, 'light', 'first-paint reads must return the cache without re-reading disk');
  assert.equal(store.get().secondaryAccent, '#ffaa99');
});

test('appearance tolerates malformed, oversize, unknown-version and symlinked disk state', (t) => {
  const { root, file } = fixture(t);
  mkdirSync(join(root, 'private'));
  for (const content of ['not json', 'x'.repeat(5000), '{}', '[]', '{"version":2,"theme":"light"}', 'null']) {
    writeFileSync(file, content);
    assert.deepEqual(new AppearanceSettingsStore(file).get(), DEFAULT_APPEARANCE);
  }
  rmSync(file);
  const target = join(root, 'outside.json');
  writeFileSync(target, '{"version":1,"theme":"light","secondaryAccent":"#aabbcc"}');
  symlinkSync(target, file);
  assert.deepEqual(new AppearanceSettingsStore(file).get(), DEFAULT_APPEARANCE);
});

test('a failed appearance write leaves the cached selection unchanged and does not report success', (t) => {
  const { file } = fixture(t);
  const initial = new AppearanceSettingsStore(file);
  initial.update({ theme: 'light' });
  let writes = 0;
  const store = new AppearanceSettingsStore(file, () => { writes += 1; throw new Error('disk is full'); });
  assert.deepEqual(store.update({}), initial.get(), 'a no-op does not need a filesystem write');
  assert.equal(writes, 0);
  assert.throws(() => store.update({ secondaryAccent: '#ff0000' }), /disk is full/);
  assert.equal(writes, 1);
  assert.deepEqual(store.get(), initial.get());
  assert.deepEqual(new AppearanceSettingsStore(file).get(), initial.get());
});

test('appearance page matching accepts only the exact packaged or development entries', () => {
  const directory = '/application/renderer';
  assert.equal(isAppearancePage(pathToFileURL(join(directory, 'index.html')).href, 'index.html', directory), true);
  assert.equal(isAppearancePage(pathToFileURL(join(directory, 'about.html')).href, 'index.html', directory), false);
  assert.equal(isAppearancePage('file:///elsewhere/index.html', 'index.html', directory), false);
  assert.equal(isAppearancePage('https://example.test/index.html', 'index.html', directory), false);
  assert.equal(isAppearancePage('http://127.0.0.1:4175/', 'index.html', directory, 'http://127.0.0.1:4175/'), true);
  assert.equal(isAppearancePage('http://127.0.0.1:4175/index.html?dev=1', 'index.html', directory, 'http://127.0.0.1:4175/'), true);
  assert.equal(isAppearancePage('http://127.0.0.1:4175/about.html', 'about.html', directory, 'http://127.0.0.1:4175/'), true);
  assert.equal(isAppearancePage('http://127.0.0.1:4175/avatar.html', 'avatar.html', directory, 'http://127.0.0.1:4175/'), true);
  assert.equal(isAppearancePage('http://127.0.0.1:4175/recovery.html', 'recovery.html', directory, 'http://127.0.0.1:4175/'), true);
  assert.equal(isAppearancePage(pathToFileURL(join(directory, 'recovery.html')).href, 'recovery.html', directory), true);
  assert.equal(isAppearancePage(pathToFileURL(join(directory, 'recovery.html')).href, 'index.html', directory), false);
  assert.equal(isAppearancePage('http://127.0.0.1:4176/', 'index.html', directory, 'http://127.0.0.1:4175/'), false);
  assert.equal(isAppearancePage('http://127.0.0.1:4175/preview.html', 'index.html', directory, 'http://127.0.0.1:4175/'), false);
  assert.equal(isAppearancePage('http://user@127.0.0.1:4175/', 'index.html', directory, 'http://127.0.0.1:4175/'), false);
});

test('appearance read authority never grants preview or iframe access; only main can mutate', () => {
  for (const surface of ['main', 'about', 'avatar', 'recovery'] as const) {
    assert.equal(mayReadAppearance(surface, true, true), true);
    assert.equal(mayUpdateAppearance(surface, true, true), surface === 'main');
    assert.equal(mayReadAppearance(surface, false, true), false);
    assert.equal(mayUpdateAppearance(surface, false, true), false);
    assert.equal(mayReadAppearance(surface, true, false), false);
    assert.equal(mayUpdateAppearance(surface, true, false), false);
  }
  assert.equal(mayReadAppearance(null, true, true), false, 'an exact app URL in a preview is still not an app-owned window');
  assert.equal(mayUpdateAppearance(null, true, true), false);
});

test('preloads expose cached first-paint appearance but the avatar bridge has no appearance mutation', () => {
  const main = readFileSync(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8');
  const avatar = readFileSync(join(process.cwd(), 'src', 'preload', 'avatar.ts'), 'utf8');
  assert.match(main, /sendSync\('appearance:initial'\)/);
  assert.match(main, /invoke\('appearance:update', patch\)/);
  assert.match(avatar, /sendSync\('appearance:initial'\)/);
  assert.match(avatar, /invoke\('appearance:get'\)/);
  assert.doesNotMatch(avatar, /appearance:update/);
  assert.match(avatar, /removeListener\('appearance:changed', listener\)/);
});

test('a schedule resolves in local wall-clock time and wraps cleanly past midnight', () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 3, 14, hours, minutes, 0, 0);
  const day = { ...DEFAULT_APPEARANCE, autoTheme: true, autoLightFrom: '07:00', autoDarkFrom: '19:00' };
  assert.equal(resolveTheme(day, at(6, 59)), 'dark', 'the minute before the boundary is still dark');
  assert.equal(resolveTheme(day, at(7, 0)), 'light', 'the boundary minute itself is already light');
  assert.equal(resolveTheme(day, at(18, 59)), 'light');
  assert.equal(resolveTheme(day, at(19, 0)), 'dark', 'the light window excludes its own end');
  assert.equal(resolveTheme(day, at(3)), 'dark');

  // A night shift: light overnight, dark through the working day.
  const night = { ...day, autoLightFrom: '19:00', autoDarkFrom: '07:00' };
  for (const [hour, expected] of [[19, 'light'], [23, 'light'], [0, 'light'], [6, 'light'], [7, 'dark'], [12, 'dark'], [18, 'dark']] as const) {
    assert.equal(resolveTheme(night, at(hour)), expected, `${hour}:00 should be ${expected}`);
  }

  // The switch off, and the degenerate equal-times case, both defer to the manual choice.
  for (const theme of ['dark', 'light'] as const) {
    assert.equal(resolveTheme({ ...day, theme, autoTheme: false }, at(12)), theme);
    assert.equal(resolveTheme({ ...day, theme, autoDarkFrom: '07:00' }, at(12)), theme);
  }
});

test('the next boundary is the nearest future edge, so main sleeps instead of polling', () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 3, 14, hours, minutes, 0, 0);
  const day = { ...DEFAULT_APPEARANCE, autoTheme: true, autoLightFrom: '07:00', autoDarkFrom: '19:00' };
  assert.deepEqual(nextThemeBoundary(day, at(6, 30)), at(7));
  assert.deepEqual(nextThemeBoundary(day, at(7, 0)), at(19), 'standing exactly on an edge looks past it');
  assert.deepEqual(nextThemeBoundary(day, at(12)), at(19));
  assert.deepEqual(nextThemeBoundary(day, at(20)), new Date(2026, 3, 15, 7, 0, 0, 0), 'after the last edge, roll to tomorrow');
  assert.equal(nextThemeBoundary({ ...day, autoTheme: false }, at(12)), null);
  assert.equal(nextThemeBoundary({ ...day, autoDarkFrom: '07:00' }, at(12)), null);

  // Whatever the clock, the boundary is in the future and the theme really does differ across it.
  for (let minute = 0; minute < 1440; minute += 7) {
    const now = at(0, minute);
    const boundary = nextThemeBoundary(day, now);
    assert.ok(boundary && boundary.getTime() > now.getTime());
    assert.notEqual(resolveTheme(day, now), resolveTheme(day, boundary));
  }
});

test('a stored schedule is bounded, and an unusable one cannot strand the app on one theme', () => {
  assert.deepEqual(normalizeAppearance({ autoTheme: true, autoLightFrom: '06:30', autoDarkFrom: '22:15' }),
    { ...DEFAULT_APPEARANCE, autoTheme: true, autoLightFrom: '06:30', autoDarkFrom: '22:15' });
  // Garbage times fall back to the defaults rather than disabling a switch the user turned on.
  for (const invalid of ['7:00', '24:00', '12:60', '', 'noon', null, 1900, '12:00:00', '07:00 ']) {
    const settings = normalizeAppearance({ autoTheme: true, autoLightFrom: invalid, autoDarkFrom: '22:15' });
    assert.equal(settings.autoLightFrom, DEFAULT_APPEARANCE.autoLightFrom);
    assert.equal(settings.autoDarkFrom, '22:15');
    assert.equal(settings.autoTheme, true);
  }
  // Equal boundaries describe no window, so the schedule is dropped instead of pinning a theme.
  const degenerate = normalizeAppearance({ autoTheme: true, autoLightFrom: '08:00', autoDarkFrom: '08:00' });
  assert.equal(degenerate.autoTheme, false);
  assert.deepEqual([degenerate.autoLightFrom, degenerate.autoDarkFrom], [DEFAULT_APPEARANCE.autoLightFrom, DEFAULT_APPEARANCE.autoDarkFrom]);
  assert.equal(minutesOfDay('00:00'), 0);
  assert.equal(minutesOfDay('23:59'), 1439);
});

test('the window background follows the schedule, not just the manual choice', () => {
  const day = { ...DEFAULT_APPEARANCE, theme: 'dark' as const, autoTheme: true, autoLightFrom: '07:00', autoDarkFrom: '19:00' };
  assert.equal(appearanceBackground(day, new Date(2026, 3, 14, 12)), '#f6f5f2', 'a cold daytime window must not flash charcoal');
  assert.equal(appearanceBackground(day, new Date(2026, 3, 14, 22)), '#141414');
  assert.equal(appearanceBackground({ ...day, autoTheme: false }, new Date(2026, 3, 14, 12)), '#141414');
});

test('a schedule edit persists and is reported as a real change', (t) => {
  const { file } = fixture(t);
  const store = new AppearanceSettingsStore(file);
  assert.equal(store.get().autoTheme, false);
  assert.equal(store.update({ autoTheme: true }).autoTheme, true);
  assert.deepEqual(store.update({ autoTheme: true }), store.get(), 'turning it on twice needs no second write');
  assert.equal(store.update({ autoLightFrom: '06:00' }).autoLightFrom, '06:00');
  assert.deepEqual(new AppearanceSettingsStore(file).get(), store.get(), 'the schedule survives a restart');
  // Patching one boundary onto an identical other one is unusable, so it is normalized away.
  assert.equal(store.update({ autoDarkFrom: '06:00' }).autoTheme, false);
});
