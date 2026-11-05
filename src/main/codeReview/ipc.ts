import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { CreateReviewInput, ReviewAuthor, ReviewMutation } from '../../api/codeReview';
import type { CodeReviewStore } from './store';

/** Only the app's main frame may make human decisions. Agent tools use their own attribution. */
export function registerCodeReviewIpc(ipc: Pick<IpcMain, 'handle'>, dependencies: {
  store: CodeReviewStore;
  requireSender(event: IpcMainInvokeEvent): void;
  author(): ReviewAuthor;
}): void {
  const checked = (event: IpcMainInvokeEvent) => { dependencies.requireSender(event); return dependencies.store; };
  ipc.handle('code-review:list', (event, workspace: string) => checked(event).list(workspace));
  ipc.handle('code-review:read', (event, workspace: string, id: string) => checked(event).read(workspace, id));
  ipc.handle('code-review:create', (event, workspace: string, input: CreateReviewInput) =>
    checked(event).create(workspace, input, { ...dependencies.author(), kind: 'human' }));
  ipc.handle('code-review:mutate', (event, workspace: string, id: string, revision: number, mutation: ReviewMutation) =>
    checked(event).mutate(workspace, id, revision, mutation, { ...dependencies.author(), kind: 'human' }));
}
