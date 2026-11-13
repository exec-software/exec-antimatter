/** Small UI intents shared by the empty editor and project bar; no task runs automatically. */
export const NEW_FRAMEWORK_PROJECT_EVENT = 'antimatter:new-framework-project';
export type ProjectStarter = 'ny' | 'matrix' | 'mixed' | 'rust' | 'cpp';
export function showNewFrameworkProject(starter: ProjectStarter = 'ny'): void {
  window.dispatchEvent(new CustomEvent(NEW_FRAMEWORK_PROJECT_EVENT, { detail: starter }));
}

export const CODE_PANE_EVENT = 'antimatter:code-pane';
export type CodePane = 'output' | 'problems' | 'variables' | 'stack';
export function showCodePane(pane: CodePane): void {
  window.dispatchEvent(new CustomEvent(CODE_PANE_EVENT, { detail: pane }));
}

export async function openCodeFolder(): Promise<void> {
  const { actions } = await import('./store');
  await actions.chooseFolder();
}
