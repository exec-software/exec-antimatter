import type { Message } from './types';

/**
 * Turning a prompt that was written for a person into one an agent can execute.
 *
 * Prompt Studio otherwise never rewrites the person's words. This is the one deliberate
 * exception: the button says what it does, the result replaces the editor only after the model
 * has answered, and nothing is sent until the person presses Run.
 */

export const MAX_REINTERPRET_INPUT_BYTES = 64 * 1024;

/**
 * The brief the active model rewrites against.
 *
 * It names Antimatter's own tools because the point is not a generic "coding prompt" — it is a
 * prompt that knows this agent can read the workspace, run the tests, open a browser and look at
 * what it made. The tool names are qualified with "when available": a conversation may not have
 * every server connected, and a prompt that assumes one it does not have is worse than one that
 * names the obvious next step.
 */
export const REINTERPRET_SYSTEM_PROMPT = `You rewrite a rough request into one complete, self-contained prompt for an autonomous coding agent working inside Antimatter, on the user's own machine.

Return only the rewritten prompt as Markdown. No preamble, no explanation, and no surrounding code fence.

Substance:
- Keep every concrete detail from the input: names, paths, files, versions, APIs, commands, data, examples, constraints, acceptance criteria, and the user's intent.
- Never invent a path, API, library, or requirement that is not implied by the input. If a decision cannot be inferred, state a short assumption inside the prompt instead of asking the person.
- Preserve every {{field}} placeholder exactly as written. Do not fill one in, rename it, or wrap it differently.
- Rewrite vague wording into checkable requirements, but do not change the job. If the input is already clear, improve its structure and leave its substance alone.
- Write for an agent that can inspect and change the workspace, run commands and tests, use a browser, and show images. It should not hand back work it can do itself.

Shape:
Use short Markdown headings, only the ones the job needs, chosen from:
## Goal
## Context
## Requirements
## Constraints
## Plan
## Verification
## Deliverables

Workflow:
The prompt must tell the agent to:
1. Inspect the workspace first — read and search the relevant files, check git status/diff, and follow the project's existing conventions.
2. Make the smallest coherent set of edits that satisfies the request.
3. Run the relevant tests, build, typecheck, or linter. Fix what fails and report the exact commands and results.
4. For anything visual, launch or preview it, take a screenshot, and inspect the image. Iterate until it looks right rather than assuming it does.
5. For a web page or service, use the preview and browser tools to open and read it, and web search or fetch when available.
6. For artwork or generated imagery, use the image generation tool when available, then preview the result.
7. Use ask_user only when a decision genuinely belongs to the person. Otherwise take the obvious next step.

Antimatter tools worth naming when they fit the task, and only then: read_file, list_directory, find_files, search_text, write_file, edit_file, run_command, launch_program, preview_image, preview_url, preview_read, preview_capture, screenshot, look_at_image, image_generate, web_search, web_fetch, start_agent.

Accuracy:
- Do not claim a command, test, or build passed unless it was run and its output read.
- Do not add fake transcripts, tool calls, or code that the request does not need.
- The agent sees this prompt and the workspace, not the conversation that produced it. Make the prompt stand on its own.`;

export interface ReinterpretRequest {
  text: string;
  providerId: string;
  modelId: string;
}

export interface ReinterpretResult {
  /** The rewritten prompt, ready to replace the editor contents. */
  text: string;
}

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

const required = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing.`);
  return value.trim();
};

/** Validates the renderer's request before any model or provider is touched. */
export function normalizeReinterpretRequest(value: unknown): ReinterpretRequest {
  if (!value || typeof value !== 'object') throw new Error('Choose a prompt and a model first.');
  const source = value as Record<string, unknown>;
  const text = required(source.text, 'The prompt');
  if (utf8Length(text) > MAX_REINTERPRET_INPUT_BYTES) {
    throw new Error(`That prompt is larger than ${Math.round(MAX_REINTERPRET_INPUT_BYTES / 1024)} KiB and cannot be reinterpreted.`);
  }
  return {
    text,
    providerId: required(source.providerId, 'The model source'),
    modelId: required(source.modelId, 'The model'),
  };
}

/** No tools: this is one question about the text, not a coding turn in the workspace. */
export function reinterpretMessages(text: string): Message[] {
  return [
    { id: 'prompt-reinterpret-system', role: 'system', content: REINTERPRET_SYSTEM_PROMPT },
    { id: 'prompt-reinterpret-user', role: 'user', content: text },
  ];
}

/**
 * A model occasionally wraps its answer in a fence even when told not to. Unwrap one outer
 * fence; leave anything else alone, because a prompt may legitimately contain its own code
 * fences and stripping all of them would damage it.
 */
export function cleanReinterpretedPrompt(reply: string): string {
  let text = reply.replace(/^\uFEFF/, '').trim();
  const fenced = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  return text;
}
