import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import { CodeEditor } from '../../renderer/src/environment/CodeEditor';
import { actions, useEnvironment } from '../../renderer/src/environment/store';
import { initializeAppearance, saveAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE, type AppearanceAPI, type AppearanceSettings } from '../../src/api/appearance';

let appearance = { ...DEFAULT_APPEARANCE };
const listeners = new Set<(settings: AppearanceSettings) => void>();
const appearanceAPI: AppearanceAPI = {
  initial: appearance, get: async () => appearance,
  update: async (patch) => {
    appearance = { ...appearance, ...patch };
    for (const listener of listeners) listener(appearance);
    return appearance;
  },
  onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
initializeAppearance(appearanceAPI);
const files: Record<string, string> = {
  'sample.ts': '// Editor appearance fixture — no filesystem access\nexport function greet(name: string): string {\n  const prefix = "Hello";\n  return `${prefix}, ${name}!`;\n}\n' +
    Array.from({ length: 50 }, (_, index) => `const sample${index} = { enabled: true, count: ${index}, title: "Preview" };`).join('\n'),
  'second.py': '# A second cached document\ndef greet(name: str):\n    return f"Hello, {name}"\n',
};
window.electronAPI = {
  environment: {
    open: async () => ({ root: '/synthetic/theme-fixture', entries: [] }),
    read: async (path: string) => ({ path, text: files[path], modified: 1, binary: false }),
    suggestCommand: async () => '',
  },
  onEnvironmentExit: () => () => {},
  onDebugState: () => () => {},
} as unknown as typeof window.electronAPI;

function Fixture() {
  const environment = useEnvironment();
  const file = environment.files.find((entry) => entry.path === environment.activePath);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'rgb(var(--color-surface))', color: 'rgb(var(--color-ink))' }}>
    <div style={{ padding: 10, fontFamily: 'system-ui', borderBottom: '1px solid rgb(var(--color-line))' }}>
      Editor · {file?.path ?? 'Open a sample'} · isolated appearance test
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>{file && <CodeEditor file={file} />}</div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const view = () => {
  const element = document.querySelector('.cm-editor');
  const editor = element ? EditorView.findFromDOM(element as HTMLElement) : null;
  if (!editor) throw new Error('Editor fixture is not mounted');
  return editor;
};
Object.assign(window, { editorThemeSmoke: {
  open: async (path: string) => { await actions.openFile(path); return true; },
  appearance: async (next: AppearanceSettings) => { await saveAppearance(next); return true; },
  view,
  edit: (text: string) => { const editor = view(); editor.dispatch({ changes: { from: 0, insert: text }, selection: { anchor: 8 }, userEvent: 'input.type' }); return true; },
  scroll: (value: number) => { view().scrollDOM.scrollTop = value; return true; },
  undo: () => undo(view()),
  snapshot: () => {
    const editor = view();
    return { text: editor.state.doc.toString(), selection: editor.state.selection.main.anchor,
      undo: undoDepth(editor.state), dark: editor.state.facet(EditorView.darkTheme),
      background: getComputedStyle(editor.dom).backgroundColor, scroll: editor.scrollDOM.scrollTop };
  },
} });
