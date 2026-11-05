import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, machineWide, machineWideAdvice } from '../src/main/toolPolicy';
import { normalizeScreenCapture } from '../src/main/developerSettings';
import {
  captureHandle,
  isOwnedCaptureSource,
  OWNED_WINDOW_ARG,
  publishesNoWindowTitles,
} from '../src/main/preview/targets';

test('a display capture still reaches past the project in every mode', () => {
  assert.match(machineWide('screenshot', {}) ?? '', /one desktop display/);
  assert.equal(decide('screenshot', 'full', {}), 'ask');
  assert.equal(decide('screenshot', 'ask', {}), 'ask');
});

test('a window named only by a model-supplied substring still asks', () => {
  assert.match(machineWide('screenshot', { window: 'Mail' }) ?? '', /a desktop window/);
  assert.equal(decide('screenshot', 'full', { window: 'Mail' }), 'ask');
});

test('a window Antimatter owns is not machine-wide, and runs under full access', () => {
  const owned = { window: 'Antimatter', [OWNED_WINDOW_ARG]: true };
  assert.equal(machineWide('screenshot', owned), null);
  assert.equal(decide('screenshot', 'full', owned), 'allow');
});

test('owning the window does not grant a capture in the lower modes', () => {
  const owned = { window: 'Antimatter', [OWNED_WINDOW_ARG]: true };
  // 'screenshot' writes a file into the workspace, so read-only still refuses it and Ask still asks.
  assert.equal(decide('screenshot', 'read', owned), 'deny');
  assert.equal(decide('screenshot', 'ask', owned), 'ask');
});

test('only the resolved boolean counts, so a model cannot claim ownership', () => {
  // prepareTool deletes this key before setting it; these are the values a model might try.
  for (const claimed of ['true', 1, {}, [], 'yes']) {
    assert.match(
      machineWide('screenshot', { window: 'Mail', [OWNED_WINDOW_ARG]: claimed }) ?? '',
      /a desktop window/,
      `a ${JSON.stringify(claimed)} claim must not count as ownership`
    );
  }
});

test('capture identity is compared on the window handle', () => {
  assert.equal(isOwnedCaptureSource('window:4194309:0', ['window:4194309:0']), true);
  // The trailing field has differed across platforms; the handle is what identifies the window.
  assert.equal(isOwnedCaptureSource('window:4194309:0', ['window:4194309:1']), true);
  assert.equal(isOwnedCaptureSource('window:4194309:0', ['window:9999999:0']), false);
  assert.equal(isOwnedCaptureSource('screen:0:0', ['window:4194309:0']), false);
  assert.equal(isOwnedCaptureSource('window:4194309:0', []), false);
  assert.equal(captureHandle('screen:0:0'), null);
  assert.equal(captureHandle('window:4194309:0'), '4194309');
});

test('the system capture commands are gated rather than run', () => {
  const captures = [
    'gnome-screenshot -f shot.png',
    'spectacle -b -o shot.png',
    'flameshot gui',
    'scrot shot.png',
    'maim shot.png',
    'grim shot.png',
    'import -window root shot.png',
    'import shot.png',
    'xwd -root -out shot.xwd',
    'cd /tmp && gnome-screenshot -f a.png',
  ];
  for (const command of captures) {
    assert.match(machineWide('run_command', { command }) ?? '', /photographs the screen/, command);
    assert.equal(decide('run_command', 'full', { command }), 'ask', command);
  }
});

test('ordinary commands that merely contain those words are left alone', () => {
  for (const command of [
    'python -c "import sys; print(sys.path)"',
    'grep -r "import" src/',
    'node --eval "import(\'./x.js\')"',
    'git commit -m "add screenshot docs"',
  ]) {
    assert.equal(machineWide('run_command', { command }), null, command);
  }
});

test('a refused capture command is told about the screenshot tool, not virtual environments', () => {
  const why = machineWide('run_command', { command: 'gnome-screenshot -f shot.png' }) as string;
  const advice = machineWideAdvice(why, 'run_command');
  assert.match(advice, /Use the screenshot tool/);
  assert.doesNotMatch(advice, /virtual environment/);
});

test('the generic command advice is unchanged for everything else', () => {
  const why = machineWide('run_command', { command: 'sudo apt install ffmpeg' }) as string;
  assert.match(machineWideAdvice(why, 'run_command'), /virtual environment/);
});

test('a standing answer from the person runs a capture under full access', () => {
  // The switch exists because the automatic exemption cannot be reached on every desktop: with no
  // window titles published, nothing can be recognised as Antimatter's own and the only capture
  // that works is the display, so a validation loop asks on every look.
  const allowed = { mode: 'full' as const, screenCaptureWithoutAsking: true };
  assert.equal(decide('screenshot', allowed, {}), 'allow');
  assert.equal(decide('screenshot', allowed, { window: 'tiny-tasks' }), 'allow');

  // It is a decision, not a claim about the call: the activity still carries why this reaches past
  // the project, so what was photographed is on the record either way.
  assert.match(machineWide('screenshot', {}) ?? '', /one desktop display/);
});

test('the standing answer is for the camera alone, and only under full access', () => {
  const on = { screenCaptureWithoutAsking: true };
  // The lower modes are unchanged: Ask first means ask, and a capture still writes a file.
  assert.equal(decide('screenshot', { ...on, mode: 'ask' }, {}), 'ask');
  assert.equal(decide('screenshot', { ...on, mode: 'read' }, {}), 'deny');

  // Nothing else machine-wide moves. A command that changes the machine is a different question,
  // including the screen-capture commands, which remain the worse way to do this.
  assert.equal(decide('run_command', { ...on, mode: 'full' }, { command: 'sudo apt install imagemagick' }), 'ask');
  assert.equal(decide('run_command', { ...on, mode: 'full' }, { command: 'grim /tmp/shot.png' }), 'ask');
  assert.equal(decide('run_command', { ...on, mode: 'full' }, { command: 'import -window tiny /tmp/shot.png' }), 'ask');

  // And with nothing said, or the switch off, every capture is still put to the person.
  assert.equal(decide('screenshot', 'full', {}), 'ask');
  assert.equal(decide('screenshot', { mode: 'full', screenCaptureWithoutAsking: false }, {}), 'ask');
});

test('the switch is off unless it was stored as exactly true', () => {
  assert.equal(normalizeScreenCapture(undefined).withoutAsking, false);
  assert.equal(normalizeScreenCapture({}).withoutAsking, false);
  assert.equal(normalizeScreenCapture({ withoutAsking: 'yes' }).withoutAsking, false);
  assert.equal(normalizeScreenCapture({ withoutAsking: true }).withoutAsking, true);
});

test('a capturer that names nothing is a session no window can be asked for', () => {
  // What this box answers: one nameless window and one screen. A title match cannot succeed, so
  // the caller says that instead of sending the model back to guess at the title again.
  assert.equal(publishesNoWindowTitles([{ name: '' }]), true);
  assert.equal(publishesNoWindowTitles([{ name: '   ' }, { name: '' }]), true);
  // A list with any real title is an ordinary miss, which the existing refusal already explains.
  assert.equal(publishesNoWindowTitles([{ name: '' }, { name: 'Antimatter' }]), false);
  // Nothing offered at all is a different answer, and the caller has its own words for it.
  assert.equal(publishesNoWindowTitles([]), false);
});
