import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import type { ConversationWorkspaceBinding, ConversationWorkspaceState } from '../api/conversationWorkspace';

export interface WorkspaceConversation {
  directory?: string | null;
  /** Undefined is legacy/unbound; null records an intentional change to the folder selection. */
  workspaceBinding?: ConversationWorkspaceBinding | null;
}

export interface ConversationWorkspaceOptions {
  defaultWorkspace: string;
  defaultConfirmed: boolean;
  context?: { key: string } | null;
}

export interface ResolvedConversationWorkspace extends ConversationWorkspaceState {
  binding: ConversationWorkspaceBinding;
  needsBinding: boolean;
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768 &&
    !value.includes('\0') && isAbsolute(value);
}

export function normalizeWorkspaceBinding(value: unknown): ConversationWorkspaceBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const binding = value as Partial<ConversationWorkspaceBinding>;
  return validPath(binding.path) && typeof binding.confirmed === 'boolean'
    ? { path: normalize(binding.path), confirmed: binding.confirmed } : null;
}

function canonical(path: string): string {
  if (!validPath(path)) throw new Error('The conversation workspace must be an absolute folder path. Choose a folder for this conversation.');
  try { return realpathSync(path); } catch { return normalize(path); }
}

/**
 * The format-1 standing-context key records the exact tool workspace at index 1. The summary's
 * projectRoot may be an ancestor (for example the Git root), so it must never be used as a grant
 * or as a replacement workspace. A transcript contains no evidence of folder confirmation.
 */
export function transcriptWorkspace(context: { key: string } | null | undefined): string | null {
  if (!context || typeof context.key !== 'string' || context.key.length > 100_000) return null;
  try {
    const key: unknown = JSON.parse(context.key);
    return Array.isArray(key) && key.length === 8 && key[0] === 1 && validPath(key[1]) &&
      validPath(key[2]) && typeof key[3] === 'boolean' && typeof key[4] === 'boolean' &&
      typeof key[5] === 'number' && ['list', 'read', 'write'].includes(key[6]) &&
      typeof key[7] === 'number' ? normalize(key[1]) : null;
  } catch { return null; }
}

/** Inspect the frozen identity without replacing it with another folder or following a new symlink. */
export function inspectConversationWorkspace(binding: ConversationWorkspaceBinding): ConversationWorkspaceState {
  const valid = normalizeWorkspaceBinding(binding);
  if (!valid) throw new Error('The conversation workspace binding is invalid. Choose a folder for this conversation.');
  try {
    if (!statSync(valid.path).isDirectory()) throw new Error('not a directory');
    if (realpathSync(valid.path) !== valid.path) {
      return { ...valid, available: false, reason: 'This conversation’s workspace now points to a different folder. Choose the folder again to continue.' };
    }
    return { ...valid, available: true };
  } catch {
    return { ...valid, available: false, reason: 'This conversation’s workspace is missing or inaccessible. Choose a folder to continue.' };
  }
}

/** Read-only resolution. The caller persists `binding` before making it available to either origin. */
export function resolveConversationWorkspace(
  thread: WorkspaceConversation,
  options: ConversationWorkspaceOptions
): ResolvedConversationWorkspace {
  let binding = normalizeWorkspaceBinding(thread.workspaceBinding);
  const needsBinding = !binding;
  if (!binding) {
    if (thread.directory) {
      // An explicitly selected folder retains the existing UI's confirmation semantics.
      binding = { path: canonical(thread.directory), confirmed: true };
    } else {
      const previous = thread.workspaceBinding === undefined ? transcriptWorkspace(options.context) : null;
      // A saved canonical path must not be re-canonicalized to a symlink replacement. Missing
      // legacy folders stay unavailable rather than silently inheriting today's global folder.
      const path = previous ?? canonical(options.defaultWorkspace);
      binding = {
        path,
        confirmed: options.defaultConfirmed && path === canonical(options.defaultWorkspace),
      };
    }
  }
  return { ...inspectConversationWorkspace(binding), binding, needsBinding };
}

/** A project identity is eligible for remote projection only after explicit existing confirmation. */
export function conversationWorkspaceProjectRoot(workspace: ConversationWorkspaceState): string | null {
  return workspace.available && workspace.confirmed ? workspace.path : null;
}

/** The transient avatar exception is a host option from its dedicated desktop IPC, never request data. */
export function assertStreamConversation(
  threadId: string | undefined,
  boundWorkspace: ConversationWorkspaceState | null,
  options: { transientAvatar?: boolean; remote?: boolean } = {}
): void {
  if (options.transientAvatar) {
    if (options.remote || typeof threadId !== 'string' || !threadId || threadId.length > 256 || boundWorkspace) {
      throw new Error('The environment assistant requires its own private desktop session.');
    }
    return;
  }
  if (threadId && !boundWorkspace) {
    throw new Error('This conversation is no longer available. Refresh it before sending again.');
  }
}
