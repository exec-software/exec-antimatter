import type { NyCompletionItem, NyDiagnostic, NyDocument, NyHover, NyLocation } from './ny';
import type { Breakpoint, DebugState } from '../main/environment/debug';
import type { RunState } from '../main/environment/exec';

export type NativeLanguage = 'rust' | 'cpp';
export type NativeProjectKind = 'cargo' | 'cmake' | 'rust-file' | 'cpp-file';
export type NativeProfile = 'debug' | 'release';
export type NativeAction = 'check' | 'build' | 'test';
export interface NativeTools { cargo: string | null; rustc: string | null; cmake: string | null; ctest: string | null; cpp: string | null; rustAnalyzer: string | null; clangd: string | null; debugger: string | null }
export interface NativeProject {
  root: string;
  kind: NativeProjectKind;
  name: string;
  source: string | null;
  buildDirectory: string;
  tools: NativeTools;
}
export interface NativeBuildRequest { root: string; source?: string; action: NativeAction; profile: NativeProfile; target?: string; args?: string[] }
export interface NativeArtifact { name: string; path: string; executable: boolean }
export interface NativeBuildResult {
  root: string;
  action: NativeAction;
  success: boolean;
  cancelled: boolean;
  exitCode: number;
  output: string;
  diagnostics: NyDiagnostic[];
  artifacts: NativeArtifact[];
  buildDirectory: string;
}
export interface NativeBuildProgress { root: string; action: NativeAction; output: string }
export interface NativeTemplateRequest { root: string; directory: string; name: string; language: NativeLanguage }
export interface NativeSourceRequest { root: string; path: string; language: NativeLanguage; name: string }
export interface BoardCard { id: string; path: string; label: string; x: number; y: number }
export interface BoardEdge { from: string; to: string }
export interface ProjectBoard { root: string; revision: string; cards: BoardCard[]; edges: BoardEdge[] }
export interface SaveProjectBoard { root: string; expectedRevision: string; cards: BoardCard[]; edges: BoardEdge[] }
export type SaveProjectBoardResult = { saved: true; board: ProjectBoard } | { saved: false; board: ProjectBoard };

export interface NativeProjectAPI {
  inspect(source?: string): Promise<NativeProject | null>;
  create(input: NativeTemplateRequest): Promise<{ root: string; entry: string }>;
  createSource(input: NativeSourceRequest): Promise<{ path: string }>;
  build(input: NativeBuildRequest): Promise<NativeBuildResult>;
  run(input: NativeBuildRequest): Promise<{ build: NativeBuildResult; run: RunState }>;
  debug(input: NativeBuildRequest, breakpoints: Breakpoint[]): Promise<DebugState>;
  cancel(): Promise<void>;
  onProgress(callback: (progress: NativeBuildProgress) => void): () => void;
  board(): Promise<ProjectBoard>;
  saveBoard(input: SaveProjectBoard): Promise<SaveProjectBoardResult>;
  connectCards(input: SaveProjectBoard & { edge: BoardEdge; sourceRevision: string }): Promise<SaveProjectBoardResult>;
  language: {
    completion(document: NyDocument): Promise<NyCompletionItem[]>;
    hover(document: NyDocument): Promise<NyHover | null>;
    definition(document: NyDocument): Promise<NyLocation[]>;
    diagnostics(document: NyDocument): Promise<NyDiagnostic[]>;
    restart(): Promise<void>;
  };
}

export const NATIVE_PROJECT_IPC = {
  inspect: 'native-project:inspect', create: 'native-project:create', createSource: 'native-project:create-source',
  build: 'native-project:build', run: 'native-project:run', debug: 'native-project:debug', cancel: 'native-project:cancel',
  progress: 'native-project:progress', board: 'native-project:board', saveBoard: 'native-project:save-board', connectCards: 'native-project:connect-cards',
  completion: 'native-project:completion', hover: 'native-project:hover', definition: 'native-project:definition',
  diagnostics: 'native-project:diagnostics', restart: 'native-project:language-restart',
} as const;
