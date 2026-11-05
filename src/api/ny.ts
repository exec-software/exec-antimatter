export interface NyPosition { line: number; character: number }
export interface NyRange { start: NyPosition; end: NyPosition }
export interface NyDocument { path: string; text: string; line?: number; character?: number; documents?: Array<{ path: string; text: string }> }
export interface NyCompletionItem {
  label: string; kind?: number; detail?: string; documentation?: string | { kind: string; value: string };
  insertText?: string; insertTextFormat?: number; sortText?: string; filterText?: string;
  textEdit?: { range: NyRange; newText: string };
}
export interface NyHover { contents: string | { kind?: string; language?: string; value: string } | Array<string | { language?: string; value: string }>; range?: NyRange }
export interface NyLocation { uri: string; range: NyRange; path?: string }
export interface NyDiagnostic { range: NyRange; message: string; severity?: number; source?: string; path?: string }
export interface NyStatus {
  available: boolean; message: string; sdkPath: string | null; configuredPath: string;
  compiler: boolean; interpreter: boolean; debugger: boolean; lsp: boolean;
  builder?: boolean; family?: 'nil' | 'ny' | null;
}
export interface NyBuildResult { success: boolean; output: string; diagnostics: NyDiagnostic[]; artifact: string | null }
export interface NyProjectResult { root: string; entry: string }
