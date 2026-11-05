/** GGUF architecture tags the bundled native Beholdd can execute end to end. */
export const BUNDLED_BEHOLDD_ARCHITECTURES = ['qwen3', 'qwen3moe'] as const;

/** Native serving support, not proof that any configured checkpoint has bound successfully. */
export interface NativeBeholddInfo {
  schema_version: 1;
  service: 'beholdd';
  generation: 2;
  runtime: 'native';
  execution_backends: string[];
  architectures: string[];
  model_formats: string[];
  operations: { unload: boolean };
}
