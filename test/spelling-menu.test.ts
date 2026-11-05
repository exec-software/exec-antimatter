import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrowserWindow, ContextMenuParams, Menu, MenuItemConstructorOptions, PopupOptions } from 'electron';
import { installSpellingMenu } from '../src/main/spellingMenu';
import { ChatComposer } from '../renderer/src/components/chat/ChatComposer';

class FakeFrame {
  destroyed = false;
  detached = false;
  isDestroyed() { return this.destroyed; }
}

class FakeContents extends EventEmitter {
  destroyed = false;
  mainFrame = new FakeFrame();
  focusedFrame: FakeFrame | null = this.mainFrame;
  replacements: string[] = [];
  dictionary: string[] = [];
  session = { addWordToSpellCheckerDictionary: (word: string) => { this.dictionary.push(word); return true; } };
  isDestroyed() { return this.destroyed; }
  replaceMisspelling(word: string) { this.replacements.push(word); }
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  webContents = new FakeContents();
  isDestroyed() { return this.destroyed; }
}

class FakeMenu {
  popups: PopupOptions[] = [];
  closed: unknown[] = [];
  constructor(readonly template: MenuItemConstructorOptions[]) {}
  popup(options: PopupOptions) { this.popups.push(options); }
  closePopup(window: unknown) { this.closed.push(window); }
  click(label: string) {
    const item = this.template.find((entry) => entry.label === label);
    assert.ok(item, `missing menu item ${label}`);
    assert.ok(item.click, `menu item ${label} has no custom action`);
    item.click({} as never, undefined, {} as never);
  }
}

function fixture(t: { after(fn: () => void): void }) {
  const window = new FakeWindow();
  const contents = window.webContents;
  const menus: FakeMenu[] = [];
  let trusted = true;
  const dispose = installSpellingMenu(window as unknown as BrowserWindow, () => trusted, {
    buildFromTemplate: (template) => {
      const menu = new FakeMenu(template as MenuItemConstructorOptions[]);
      menus.push(menu);
      return menu as unknown as Menu;
    },
  });
  t.after(dispose);
  const params = (changes: Partial<ContextMenuParams> = {}): ContextMenuParams => ({
    frame: contents.mainFrame,
    x: 20, y: 30, isEditable: true, spellcheckEnabled: true, formControlType: 'text-area',
    misspelledWord: 'speling', dictionarySuggestions: ['spelling'], menuSourceType: 'mouse',
    editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: false, canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false },
    ...changes,
  } as unknown as ContextMenuParams);
  const show = (changes: Partial<ContextMenuParams> = {}) => {
    contents.emit('context-menu', {}, params(changes));
    return menus.at(-1)!;
  };
  return { window, contents, menus, dispose, params, show, trust: (value: boolean) => { trusted = value; } };
}

test('native spelling menu uses the originating window/frame and replaces only the chosen word', (t) => {
  const { window, contents, show } = fixture(t);
  const menu = show({ dictionarySuggestions: ['spelling', 'spieling'] });
  assert.deepEqual(menu.popups, [{ window, frame: contents.mainFrame, x: 20, y: 30, sourceType: 'mouse' }]);
  assert.deepEqual(contents.replacements, [], 'opening never edits the draft');
  assert.deepEqual(contents.dictionary, [], 'opening never persists dictionary changes');
  menu.click('spieling');
  assert.deepEqual(contents.replacements, ['spieling']);
  assert.deepEqual(contents.dictionary, []);
});

test('real native misspelling evidence works when Electron reports a false spellcheckEnabled flag', (t) => {
  const { contents, show } = fixture(t);
  const menu = show({ spellcheckEnabled: false, misspelledWord: 'teh', dictionarySuggestions: ['the'] });
  assert.ok(menu, 'Electron 44 can return a genuine misspelling while its context flag is false');
  menu.click('the');
  assert.deepEqual(contents.replacements, ['the']);
  menu.click('Add to dictionary');
  assert.deepEqual(contents.dictionary, ['teh']);
});

test('spelling suggestions are deduplicated, capped, and native menu mnemonics do not change replacement text', (t) => {
  const { contents, show } = fixture(t);
  const menu = show({ dictionarySuggestions: ['A&B', 'A&B', ...Array.from({ length: 15 }, (_, i) => `word${i}`)] });
  const labels = menu.template.filter((item) => item.label).map((item) => item.label);
  assert.deepEqual(labels, ['A&&B', 'word0', 'word1', 'word2', 'word3', 'word4', 'word5', 'word6', 'Add to dictionary']);
  menu.click('A&&B');
  assert.deepEqual(contents.replacements, ['A&B']);
});

test('unrecognized words retain an explicit dictionary action even without suggestions', (t) => {
  const { contents, show } = fixture(t);
  const menu = show({ misspelledWord: 'Antimatter', dictionarySuggestions: [] });
  assert.deepEqual(menu.template[0], { label: 'No spelling suggestions', enabled: false });
  menu.click('Add to dictionary');
  assert.deepEqual(contents.dictionary, ['Antimatter']);
  assert.deepEqual(contents.replacements, []);
});

test('ordinary composer context menus retain native editing roles and disabled capabilities', (t) => {
  const { show } = fixture(t);
  const menu = show({ misspelledWord: '', dictionarySuggestions: ['ignored'] });
  assert.deepEqual(menu.template, [
    { role: 'undo', enabled: true }, { role: 'redo', enabled: false }, { type: 'separator' },
    { role: 'cut', enabled: false }, { role: 'copy', enabled: false }, { role: 'paste', enabled: true },
    { type: 'separator' }, { role: 'selectAll', enabled: true },
  ]);
});

test('keyboard context-menu invocation retains its native source', (t) => {
  const { show } = fixture(t);
  const menu = show({ menuSourceType: 'keyboard' });
  assert.equal(menu.popups[0].sourceType, 'keyboard');
});

test('untrusted pages, iframes, missing frames, non-editable controls and opted-out fields get no menu', (t) => {
  const { contents, menus, show, trust } = fixture(t);
  trust(false);
  show();
  assert.equal(menus.length, 0, 'recovery/remote URL trust predicate is authoritative');
  trust(true);
  const rejected: Partial<ContextMenuParams>[] = [
    { frame: null }, { frame: new FakeFrame() as never }, { isEditable: false },
    { spellcheckEnabled: false, misspelledWord: '', dictionarySuggestions: [] }, { formControlType: 'input-password' },
    { formControlType: 'input-text' }, { formControlType: 'none' },
  ];
  for (const change of rejected) {
    show(change);
    assert.equal(menus.length, 0, JSON.stringify(change));
  }
  assert.deepEqual(contents.replacements, []);
  assert.deepEqual(contents.dictionary, []);
});

test('destroyed or detached originating frames cannot show or use spelling actions', (t) => {
  const { contents, menus, show } = fixture(t);
  contents.mainFrame.destroyed = true;
  show();
  assert.equal(menus.length, 0);
  contents.mainFrame.destroyed = false;
  contents.mainFrame.detached = true;
  show();
  assert.equal(menus.length, 0);
  contents.mainFrame.detached = false;
  const menu = show();
  contents.mainFrame.detached = true;
  menu.click('spelling');
  menu.click('Add to dictionary');
  assert.deepEqual(contents.replacements, []);
  assert.deepEqual(contents.dictionary, []);
});

test('focus must remain in the originating top-level frame before showing or using the menu', (t) => {
  const { contents, menus, show } = fixture(t);
  for (const focusedFrame of [null, new FakeFrame()]) {
    contents.focusedFrame = focusedFrame;
    show();
    assert.equal(menus.length, 0);
  }
  contents.focusedFrame = contents.mainFrame;
  const menu = show();
  contents.focusedFrame = new FakeFrame();
  menu.click('spelling');
  menu.click('Add to dictionary');
  assert.deepEqual(contents.replacements, []);
  assert.deepEqual(contents.dictionary, []);
});

for (const event of ['did-start-navigation', 'render-process-gone'] as const) {
  test(`${event} closes the native menu and invalidates captured actions`, (t) => {
    const { window, contents, show } = fixture(t);
    const menu = show();
    contents.emit(event);
    assert.deepEqual(menu.closed, [window]);
    menu.click('spelling');
    menu.click('Add to dictionary');
    assert.deepEqual(contents.replacements, []);
    assert.deepEqual(contents.dictionary, []);
  });
}

for (const event of ['hide', 'minimize'] as const) {
  test(`${event} invalidates the menu without removing the window's future spellcheck handler`, (t) => {
    const { window, contents, show } = fixture(t);
    const menu = show();
    window.emit(event);
    assert.deepEqual(menu.closed, [window]);
    menu.click('spelling');
    menu.click('Add to dictionary');
    assert.deepEqual(contents.replacements, []);
    assert.deepEqual(contents.dictionary, []);
    show().click('spelling');
    assert.deepEqual(contents.replacements, ['spelling']);
  });
}

test('a newer context menu invalidates old callbacks, including when the next target is excluded', (t) => {
  const { window, contents, menus, show } = fixture(t);
  const old = show();
  const current = show({ misspelledWord: 'teh', dictionarySuggestions: ['the'] });
  assert.deepEqual(old.closed, [window]);
  old.click('spelling');
  old.click('Add to dictionary');
  assert.deepEqual(contents.replacements, []);
  assert.deepEqual(contents.dictionary, []);
  current.click('the');
  assert.deepEqual(contents.replacements, ['the']);
  show({ formControlType: 'input-password' });
  assert.equal(menus.length, 2);
  assert.deepEqual(current.closed, [window]);
  current.click('Add to dictionary');
  assert.deepEqual(contents.dictionary, []);
});

test('callbacks recheck live window, contents, frame identity and page trust', (t) => {
  const { window, contents, show, trust } = fixture(t);
  const menu = show();
  const original = contents.mainFrame;
  for (const [set, restore] of [
    [() => { window.destroyed = true; }, () => { window.destroyed = false; }],
    [() => { contents.destroyed = true; }, () => { contents.destroyed = false; }],
    [() => { contents.mainFrame = new FakeFrame(); }, () => { contents.mainFrame = original; }],
    [() => trust(false), () => trust(true)],
  ]) {
    set();
    menu.click('spelling');
    menu.click('Add to dictionary');
    assert.deepEqual(contents.replacements, []);
    assert.deepEqual(contents.dictionary, []);
    restore();
  }
});

test('disposal is idempotent, removes only its listeners, and invalidates retained menu callbacks', (t) => {
  const { window, contents, menus, show, dispose } = fixture(t);
  let unrelatedCalls = 0;
  const unrelated = () => { unrelatedCalls++; };
  contents.on('context-menu', unrelated);
  const menu = show();
  dispose();
  dispose();
  assert.deepEqual(menu.closed, [window]);
  assert.equal(contents.listenerCount('context-menu'), 1);
  assert.equal(contents.listenerCount('did-start-navigation'), 0);
  assert.equal(contents.listenerCount('render-process-gone'), 0);
  assert.equal(window.listenerCount('hide'), 0);
  assert.equal(window.listenerCount('minimize'), 0);
  assert.equal(window.listenerCount('closed'), 0);
  menu.click('spelling');
  menu.click('Add to dictionary');
  show();
  assert.equal(menus.length, 1);
  assert.equal(unrelatedCalls, 2);
  assert.deepEqual(contents.replacements, []);
  assert.deepEqual(contents.dictionary, []);
});

test('closing a destroyed window cleans up without addressing a dead native popup', (t) => {
  const { window, contents, show } = fixture(t);
  const menu = show();
  window.destroyed = true;
  contents.destroyed = true;
  window.emit('closed');
  assert.deepEqual(menu.closed, []);
  assert.equal(contents.listenerCount('context-menu'), 0);
  assert.equal(window.listenerCount('closed'), 0);
  menu.click('spelling');
  assert.deepEqual(contents.replacements, []);
});

test('composer explicitly opts into browser spellcheck while native integration remains main-window scoped', () => {
  const html = renderToStaticMarkup(createElement(ChatComposer, {
    onSubmit: () => false, providers: [], providerId: '', modelId: '', onOpenModels: () => {},
    access: { mode: 'ask' }, onChangeAccess: () => {}, workspace: null, workspaceConfirmed: false,
    onConfirmWorkspace: () => {}, threadId: 'fixture', draft: { text: 'speling', attachments: [] },
  } as never));
  assert.match(html, /<textarea\b[^>]*spellcheck="true"/);
  assert.match(html, />speling<\/textarea>/);
  const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const createWindow = main.slice(main.indexOf('async function createWindow()'), main.indexOf('let aboutWindow:'));
  assert.match(createWindow, /spellcheck:\s*true/);
  assert.match(createWindow, /installSpellingMenu\(window/);
});
