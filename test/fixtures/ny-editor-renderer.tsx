import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView, activateHover } from '@codemirror/view';
import { acceptCompletion, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { diagnosticCount } from '@codemirror/lint';
import { CodeEditor } from '../../renderer/src/environment/CodeEditor';
import { actions, useEnvironment } from '../../renderer/src/environment/store';
import { initializeAppearance } from '../../renderer/src/appearance';
import { DEFAULT_APPEARANCE } from '../../src/api/appearance';
import type { DebugState } from '../../renderer/src/types';

initializeAppearance({ initial: DEFAULT_APPEARANCE, get: async () => DEFAULT_APPEARANCE, update: async () => DEFAULT_APPEARANCE, onChanged: () => () => {} });
const files: Record<string, string> = {
  'main.ny': 'module demo\nfn main() -> i32\n    let answer: i32 = 42\n    pri\n    return 0\nend fn',
  'helper.ny': 'pub fn helper() -> i32\n    return 42\nend fn',
  'other.txt': 'A plain text file',
};
let debugListener: (state: DebugState) => void = () => {};
window.electronAPI = {
  environment: {
    open: async () => ({ root: '/synthetic/ny-fixture', entries: [] }),
    read: async (path: string) => ({ path, text: files[path], modified: 1, binary: false }),
    suggestCommand: async () => '', debugBreakpoints: async () => {},
  },
  ny: {
    status: async () => ({ available: true, lsp: true, message: 'SDK ready' }),
    completion: async () => [{ label: 'println', kind: 3, detail: 'Print a Ny value', insertText: 'println(${1:answer})', insertTextFormat: 2 }],
    hover: async () => ({ contents: [{ language: 'ny', value: 'let answer: i32' }, 'The answer <script> stays literal.'] }),
    definition: async () => [{ uri: 'file:///synthetic/ny-fixture/helper.ny', path: 'helper.ny', range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } } }],
  },
  onEnvironmentExit: () => () => {},
  onDebugState: (listener: (state: DebugState) => void) => { debugListener = listener; return () => {}; },
} as unknown as typeof window.electronAPI;

function Fixture() {
  const environment = useEnvironment();
  const file = environment.files.find((entry) => entry.path === environment.activePath);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: 10 }}>Ny editor · {file?.path}</div>
    <div style={{ flex: 1, minHeight: 0 }}>{file && <CodeEditor file={file} />}</div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
const view = () => {
  const editor = document.querySelector('.cm-editor');
  if (!editor) throw new Error('Editor is not mounted');
  return EditorView.findFromDOM(editor as HTMLElement)!;
};
Object.assign(window, { nyEditorSmoke: {
  open: actions.openFile,
  view,
  complete: () => {
    const editor = view(), position = editor.state.doc.toString().indexOf('    pri') + 7;
    editor.dispatch({ selection: { anchor: position } });
    startCompletion(editor);
  },
  completions: () => currentCompletions(view().state).map((item) => item.label),
  accept: () => acceptCompletion(view()),
  hover: () => {
    const editor = view();
    editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf('answer') + 2 } });
    return activateHover(editor, editor.state.selection.main.head, -1);
  },
  definition: () => view().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', code: 'F12', bubbles: true })),
  diagnose: () => {
    const editor = view();
    window.dispatchEvent(new CustomEvent('antimatter:ny-diagnostics', { detail: { path: 'main.ny', text: editor.state.doc.toString(), diagnostics: [{ range: { start: { line: 2, character: 8 }, end: { line: 2, character: 14 } }, message: 'Synthetic diagnostic', severity: 2 }] } }));
  },
  edit: () => view().dispatch({ changes: { from: 0, insert: '// edited\n' } }),
  debug: () => {
    actions.toggleBreakpoint('main.ny', 2);
    debugListener({ phase: 'running', reason: null, frames: [], variables: [], resolved: [{ file: 'main.ny', line: 3 }], error: null });
  },
  snapshot: () => ({ text: view().state.doc.toString(), diagnostics: diagnosticCount(view().state), status: document.querySelector('[role=status]')?.textContent,
    hover: document.querySelector('.cm-ny-hover')?.textContent, markers: [...document.querySelectorAll('.cm-breakpoint-dot')].map((node) => node.textContent) }),
} });
