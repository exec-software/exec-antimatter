export interface NyInspectedLocal { name: string; storage: string; type: string; depth: number }
export interface NyInspectedInstruction {
  /** Zero-based instruction index within its function, not a byte address. */
  offset: number;
  opcode: string;
  operands: string[];
  debugLine: number;
  source?: { path: string; workspacePath?: string; line: number };
  locals?: NyInspectedLocal[];
}
export interface NyInspectedFunction {
  name: string; parameters: string[]; generics: string[]; returnType: string;
  inline: boolean; test: boolean; declarationLine: number; annotations: string[];
  instructions: NyInspectedInstruction[];
}
export interface NyInspectedConstant { name: string; value: string; byteLength: number; encoding: 'utf8' | 'hex' }
export interface NyInspectedMethod {
  name: string; implementation: string; receiverType: string; returnType: string;
  virtual: boolean; abstract: boolean; parameters: string[];
}
export interface NyInspectedType {
  kind: 'struct' | 'enum' | 'class'; name: string; members: { name: string; type: string }[];
  abstract?: boolean; bases?: string[]; methods?: NyInspectedMethod[];
}
export interface NyModuleInspection {
  /** Canonical workspace-relative path and the inspected file's mtime in milliseconds. */
  path: string; modified: number;
  format: 'text' | 'binary'; version: number | null; flags: number; byteLength: number;
  moduleName: string; library: boolean; debugInfo: boolean;
  functions: NyInspectedFunction[]; constants: NyInspectedConstant[]; types: NyInspectedType[];
  tests: string[]; embeddedSources: { path: string; byteLength: number }[]; dependencies: string[];
  warnings: string[];
}
