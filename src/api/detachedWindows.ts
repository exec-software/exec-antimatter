import type { PublicProviderConfig } from './types';

/** Only panels whose resources can live in another renderer may leave the main window. */
export const DETACHABLE_TOOL_WINDOWS = ['core.sources', 'vitals.monitor', 'agents.tasks', 'agents.roster', 'snitch.items', 'snitch.pipeline'] as const;
export const isDetachableToolWindow = (id: unknown): id is typeof DETACHABLE_TOOL_WINDOWS[number] =>
  typeof id === 'string' && (DETACHABLE_TOOL_WINDOWS as readonly string[]).includes(id);
export interface DetachedBounds { x: number; y: number; width: number; height: number }
export interface DetachedWindowState { toolWindowId: string; bounds: DetachedBounds }
export interface DetachedWindowChange extends DetachedWindowState { kind: 'opened' | 'closed' | 'docked' }
export interface DetachedShellSnapshot {
  workspace: string | null;
  conversation: { id: string; title: string; transcript: string } | null;
  sources: { providers: PublicProviderConfig[]; activeProviderId: string; activeModelId: string };
}
export interface DetachedShellUpdate { revision: number; shell: DetachedShellSnapshot | null }
export interface DetachedModelRequest {
  providerId?: string | null; modelId?: string | null; title: string;
  description?: string; actionLabel?: string; selectedLabel?: string;
}
export type DetachedShellAction = { type: 'openPage'; page: 'hub' | 'orchestrator' }
  | { type: 'selectProvider'; providerId: string }
  | { type: 'openModelLibrary'; request?: DetachedModelRequest };
export interface DetachedModelChoice { providerId: string; modelId: string }
export interface DetachedActionRequest { requestId: string; action: DetachedShellAction }
export interface DetachedWindowsAPI {
  create(toolWindowId: string, bounds?: DetachedBounds): Promise<DetachedWindowState>;
  close(toolWindowId: string): Promise<void>;
  dock(toolWindowId: string): Promise<void>;
  focus(toolWindowId: string): Promise<void>;
  list(): Promise<DetachedWindowState[]>;
  ready(): Promise<DetachedShellUpdate & { toolWindowId: string }>;
  publishShell(shell: DetachedShellSnapshot): Promise<void>;
  action(action: DetachedShellAction): Promise<DetachedModelChoice | null>;
  resolveAction(requestId: string, choice: DetachedModelChoice | null): Promise<void>;
  onBounds(callback: (event: DetachedWindowState) => void): () => void;
  onChanged(callback: (event: DetachedWindowChange) => void): () => void;
  onShell(callback: (event: DetachedShellUpdate) => void): () => void;
  onAction(callback: (event: DetachedActionRequest) => void): () => void;
}
