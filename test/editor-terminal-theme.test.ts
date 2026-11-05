import assert from 'node:assert/strict';
import test from 'node:test';
import { Compartment, EditorState } from '@codemirror/state';
import { history, undoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import type { Terminal } from '@xterm/xterm';
import { editorAppearanceFor } from '../renderer/src/environment/highlight';
import { followTerminalAppearance, terminalThemeFor } from '../renderer/src/plugins/terminal/theme';
import { contrastRatio, paletteFor } from '../renderer/src/theme';

const dark = { theme: 'dark' as const, secondaryAccent: '#33b7a6' };
const light = { theme: 'light' as const, secondaryAccent: '#176f83' };

test('terminal themes follow shared surfaces and provide a distinct readable light ANSI palette', () => {
  const darkTheme = terminalThemeFor(dark);
  const lightTheme = terminalThemeFor(light);
  for (const settings of [dark, light]) {
    const terminal = terminalThemeFor(settings);
    const palette = paletteFor(settings);
    assert.equal(terminal.background, palette.surface0);
    assert.equal(terminal.foreground, palette.ink);
    assert.equal(terminal.cursor, palette.primary);
    assert.equal(terminal.selectionBackground, `${palette.accent}40`);
  }
  assert.notEqual(lightTheme.background, darkTheme.background);
  assert.notEqual(lightTheme.blue, darkTheme.blue);
  assert.notEqual(lightTheme.brightWhite, darkTheme.brightWhite);
  assert.equal(darkTheme.red, '#e05252', 'dark ANSI output retains its established palette');
  assert.equal(darkTheme.brightBlue, '#7ab8e8');
  for (const name of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const) {
    const color = lightTheme[name];
    assert.ok(color);
    assert.ok(contrastRatio(color, paletteFor(light).surface0) >= 4.5, `${name} must be readable on the light terminal surface`);
  }
});

test('live terminal appearance changes mutate only options.theme and unsubscribe on disposal', () => {
  const selectedBuffer = { lines: ['existing output', 'password prompt'], cursor: 2 };
  const terminal = { options: { scrollback: 5000, theme: {} }, buffer: selectedBuffer };
  const listeners = new Set<(settings: typeof dark | typeof light) => void>();
  const stop = followTerminalAppearance(terminal as Pick<Terminal, 'options'>, {
    read: () => dark,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  const options = terminal.options;
  assert.deepEqual(terminal.options.theme, terminalThemeFor(dark));
  for (const listener of listeners) listener(light);
  assert.equal(terminal.options, options);
  assert.deepEqual(terminal.options.theme, terminalThemeFor(light));
  assert.equal(terminal.buffer, selectedBuffer);
  assert.deepEqual(terminal.buffer.lines, ['existing output', 'password prompt']);
  assert.equal(terminal.options.scrollback, 5000);
  stop();
  assert.equal(listeners.size, 0);
  for (const listener of listeners) listener(dark);
  assert.deepEqual(terminal.options.theme, terminalThemeFor(light));
});

test('accent-only changes recolor the terminal cursor and selection without reinterpreting ANSI output', () => {
  const before = terminalThemeFor(dark);
  const after = terminalThemeFor({ ...dark, secondaryAccent: '#aa8cf4' });
  assert.notEqual(before.cursor, after.cursor);
  assert.notEqual(before.selectionBackground, after.selectionBackground);
  for (const role of ['background', 'foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightRed', 'brightWhite'] as const) assert.equal(after[role], before[role]);
});

test('CodeMirror appearance reconfiguration updates dark facet without losing text, selection, or undo', () => {
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: 'const before = 1;',
    extensions: [history(), compartment.of(editorAppearanceFor(dark))],
  });
  state = state.update({ changes: { from: 6, to: 12, insert: 'after' }, selection: { anchor: 8 } }).state;
  assert.equal(undoDepth(state), 1);
  assert.equal(state.facet(EditorView.darkTheme), true);
  const document = state.doc;
  const selection = state.selection;
  state = state.update({ effects: compartment.reconfigure(editorAppearanceFor(light)) }).state;
  assert.equal(state.facet(EditorView.darkTheme), false);
  assert.equal(state.doc, document);
  assert.equal(state.selection, selection);
  assert.equal(undoDepth(state), 1);
  state = state.update({ effects: compartment.reconfigure(editorAppearanceFor(dark)) }).state;
  assert.equal(state.facet(EditorView.darkTheme), true);
  assert.equal(state.doc, document);
  assert.equal(undoDepth(state), 1);
});

test('CodeMirror cached documents can change appearance independently before being restored', () => {
  const compartment = new Compartment();
  const states = ['first.ts', 'second.ts'].map((name) => EditorState.create({
    doc: name, selection: { anchor: 2 },
    extensions: [history(), compartment.of(editorAppearanceFor(dark))],
  }));
  const updated = states.map((state) => state.update({ effects: compartment.reconfigure(editorAppearanceFor(light)) }).state);
  updated.forEach((state, index) => {
    assert.equal(state.facet(EditorView.darkTheme), false);
    assert.equal(state.doc, states[index].doc);
    assert.equal(state.selection, states[index].selection);
  });
});
