import type { NyBuildResult, NyProjectResult } from './ny';

export type NilProjectLanguage = 'ny' | 'matrix' | 'mixed';
export type NilProjectTarget = 'vm' | 'native';
export interface NilProjectDescription {
  schema: 'nil.project.description.v1';
  projectFile: string;
  projectDirectory: string;
  name: string;
  entry: string;
  language: 'ny' | 'matrix';
  includePaths: string[];
  sdkPath: string | null;
  outputDirectory: string;
  vmOutput: string;
  nativeOutput: string;
  analysis: { disabledRules: string[]; warningsAsErrors: boolean };
}

/** Resolve configuration afresh for every operation; renderer paths never select tools. */
export interface NilProjectAPI {
  describe(sourcePath?: string): Promise<NilProjectDescription | null>;
  create(name: string, language: NilProjectLanguage): Promise<NyProjectResult | null>;
  check(sourcePath?: string): Promise<NyBuildResult>;
  build(sourcePath?: string, target?: NilProjectTarget): Promise<NyBuildResult>;
}
