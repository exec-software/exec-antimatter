/**
 * The shape every Antimatter tool implements. Kept deliberately small: a tool is a name,
 * a JSON Schema the model reads, and a function that returns text.
 */

export interface ToolContext {
  /** Absolute path every file operation is confined to. */
  workspace: string;
  /** Fires when the client cancels the MCP request. Long-running tools should stop promptly. */
  signal?: AbortSignal;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Returns the text handed back to the model. Throwing marks the call as an error. */
  run(args: Record<string, any>, context: ToolContext): Promise<string>;
}

export const str = (description: string) => ({ type: 'string', description });
export const num = (description: string) => ({ type: 'number', description });
export const bool = (description: string) => ({ type: 'boolean', description });

/** Models cope badly with megabyte tool results, so every tool clips its output. */
export const clip = (text: string, max = 24_000): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} more characters]`;
