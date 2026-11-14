import { estimateTokens } from '../../../../src/api/tokenEstimate';
import { isPromptVariableName } from '../../../../src/api/promptLibrary';

/**
 * What Prompt Studio knows about a prompt before it is sent.
 *
 * Everything here reads the text and reports what is in it. Nothing rewrites a prompt and nothing
 * scores one: a prompt is the person's own words, and a tool that silently "improved" them would
 * be sending something they did not write. Spelling is deliberately absent — Electron's own
 * spellchecker underlines the textarea and offers corrections on right-click, which is a real
 * dictionary rather than a word list shipped in here.
 */

export type PromptFindingSeverity = 'problem' | 'caution' | 'note';

export type PromptFindingKind =
  | 'placeholder'
  | 'variable'
  | 'vague'
  | 'repeated-word'
  | 'shouting'
  | 'wall-of-text'
  | 'no-ask'
  | 'no-output-shape'
  | 'over-budget';

export interface PromptFinding {
  kind: PromptFindingKind;
  severity: PromptFindingSeverity;
  /** What is wrong, in the second person, as the panel prints it. */
  message: string;
  /** 1-based, so it reads the way the gutter does. Zero means the whole prompt. */
  line: number;
  /** The exact text this is about, for the panel to echo. Empty when the finding has no span. */
  excerpt: string;
}

export interface PromptStats {
  characters: number;
  words: number;
  lines: number;
  /** A planning estimate from the shared heuristic, not a tokenizer count. */
  estimatedTokens: number;
}

export interface PromptVariable {
  name: string;
  occurrences: number;
  /** The value currently supplied, or an empty string when the field has not been filled. */
  value: string;
  /** Where the first `{{name}}` sits, so a finding about it can name the right line. */
  index: number;
}

/** `{{ name }}`, with the spaces optional. The name shape is shared with the saved library. */
const VARIABLE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Left-behind scaffolding. `TODO` and friends are unambiguous; the bracket forms are the shape an
 * unfilled field takes in a prompt pasted from somewhere else.
 */
const PLACEHOLDER_PATTERN = /\b(?:TODO|TBD|FIXME|XXX|WIP)\b|<[a-z][a-z0-9 _-]{1,40}>|\[(?:insert|your|the)\b[^\]\n]{0,60}\]/gi;

/**
 * Wording that reads as an instruction but names nothing a model can act on. Each one is a
 * caution, never a refusal: "etc." in a quoted error message is still "etc.".
 */
const VAGUE_PATTERN = /\b(?:etc\.?|and so on|and such|some stuff|some things|a few things|as (?:needed|appropriate|necessary)|appropriately|properly|correctly|somehow|whatever|if possible|make it (?:better|nicer|good)|clean it up)\b/gi;

/** A prompt with no imperative and no question has not asked for anything. */
const IMPERATIVE_PATTERN = /\?|\b(?:add|build|change|check|compare|convert|create|describe|design|draft|explain|extract|find|fix|generate|give|identify|implement|improve|list|make|move|outline|plan|refactor|remove|rename|rewrite|review|run|show|summar(?:ise|ize)|tell|test|translate|update|use|write)\b/i;
/** A question word opening a sentence, for the questions people write without a question mark. */
const QUESTION_PATTERN = /(?:^|[\n.!?]\s*)\s*(?:which|what|why|how|when|where|who|whose|whether)\b/im;
const asksSomething = (text: string): boolean => IMPERATIVE_PATTERN.test(text) || QUESTION_PATTERN.test(text);

/** Mentions of the shape of the answer. Absent, a long prompt usually wanted one. */
const OUTPUT_SHAPE_PATTERN = /\b(?:answer|bullet|caption|column|csv|diff|format|heading|json|list|markdown|output|paragraph|patch|reply|report|respond|response|return|row|schema|section|sentence|snippet|summary|table|tone|xml|yaml)\b|\bno more than\b|\bat most\b|\bword(?:s)? long\b/i;

const REPEATED_WORD_PATTERN = /\b([A-Za-z]{3,})\s+\1\b/gi;
const SHOUTING_PATTERN = /\b(?:[A-Z][A-Z0-9'’-]{1,}\s+){3,}[A-Z][A-Z0-9'’-]{1,}\b/g;

/** Past this, a single unbroken paragraph is hard for a person to re-read, let alone revise. */
const WALL_OF_TEXT_WORDS = 160;
/** Short prompts get no advice about output shape; a one-liner does not need a format section. */
const OUTPUT_SHAPE_FLOOR_WORDS = 60;
/** How much of a model's window a single prompt may claim before that is worth saying. */
export const PROMPT_BUDGET_SHARE = 0.5;

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

export function promptStats(text: string): PromptStats {
  const words = text.split(/\s+/).filter(Boolean);
  return {
    characters: text.length,
    words: words.length,
    lines: text ? text.split('\n').length : 0,
    estimatedTokens: text.trim() ? estimateTokens(text) : 0,
  };
}

/**
 * The `{{names}}` in a prompt, in the order they first appear, carrying whatever has been filled
 * in for them. A malformed `{{}}` is not a variable and is reported by the lint instead.
 */
export function promptVariables(text: string, values: Record<string, string> = {}): PromptVariable[] {
  const found = new Map<string, PromptVariable>();
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (!isPromptVariableName(name)) continue;
    const existing = found.get(name);
    if (existing) existing.occurrences += 1;
    else found.set(name, { name, occurrences: 1, value: values[name] ?? '', index: match.index });
  }
  return [...found.values()];
}

export interface ComposedPrompt {
  /** The text as it would be sent: variables substituted, trailing whitespace trimmed. */
  text: string;
  /** Variables the prompt uses that have no value yet, in the order they appear. */
  missing: string[];
}

/** Substitutes `{{name}}`. A variable with no value is left standing, so nothing goes out blank. */
export function composePrompt(text: string, values: Record<string, string> = {}): ComposedPrompt {
  const missing: string[] = [];
  const composed = text.replace(VARIABLE_PATTERN, (whole, rawName: string) => {
    if (!isPromptVariableName(rawName)) return whole;
    const value = values[rawName] ?? '';
    if (!value.trim()) {
      if (!missing.includes(rawName)) missing.push(rawName);
      return whole;
    }
    return value;
  });
  return { text: composed.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(), missing };
}

/** Paragraphs, with the index each one starts at, so a finding can name its line. */
const paragraphs = (text: string): { text: string; index: number }[] => {
  const found: { text: string; index: number }[] = [];
  const pattern = /[^\n]+(?:\n[^\n]+)*/g;
  for (const match of text.matchAll(pattern)) found.push({ text: match[0], index: match.index });
  return found;
};

export interface InspectOptions {
  /** Values filled in for `{{variables}}`, so a filled field stops being a finding. */
  values?: Record<string, string>;
  /** The chosen model's context window, when it is known. */
  tokenBudget?: number;
}

/**
 * Reads a prompt and reports what is in it. Ordered worst-first, and capped per kind so one
 * repeated habit cannot bury everything else.
 */
export function inspectPrompt(text: string, { values = {}, tokenBudget }: InspectOptions = {}): PromptFinding[] {
  const findings: PromptFinding[] = [];
  const trimmed = text.trim();
  if (!trimmed) return findings;
  const stats = promptStats(text);
  const add = (finding: PromptFinding) => findings.push(finding);
  const limited = (kind: PromptFindingKind, cap: number) => findings.filter((finding) => finding.kind === kind).length >= cap;

  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    if (limited('placeholder', 6)) break;
    add({ kind: 'placeholder', severity: 'problem', line: lineOf(text, match.index), excerpt: match[0],
      message: 'This placeholder is still unfilled, and the model will read it literally.' });
  }

  for (const variable of promptVariables(text, values)) {
    if (variable.value.trim() || limited('variable', 8)) continue;
    add({ kind: 'variable', severity: 'problem', line: lineOf(text, variable.index), excerpt: `{{${variable.name}}}`,
      message: `Fill in ${variable.name}, or the prompt goes out with the placeholder in it.` });
  }

  for (const match of text.matchAll(VAGUE_PATTERN)) {
    if (limited('vague', 5)) break;
    add({ kind: 'vague', severity: 'caution', line: lineOf(text, match.index), excerpt: match[0],
      message: 'This stands in for something specific. Say which, and the answer can be checked against it.' });
  }

  for (const match of text.matchAll(REPEATED_WORD_PATTERN)) {
    if (limited('repeated-word', 4)) break;
    add({ kind: 'repeated-word', severity: 'caution', line: lineOf(text, match.index), excerpt: match[0],
      message: 'A word is repeated here.' });
  }

  for (const match of text.matchAll(SHOUTING_PATTERN)) {
    if (limited('shouting', 2)) break;
    add({ kind: 'shouting', severity: 'note', line: lineOf(text, match.index), excerpt: match[0],
      message: 'Capitals carry no more weight than words do. Saying what must hold, once, reads better.' });
  }

  if (!asksSomething(text)) {
    add({ kind: 'no-ask', severity: 'problem', line: 0, excerpt: '',
      message: 'Nothing here asks for anything. Name the task, in a sentence that starts with a verb.' });
  }

  if (stats.words >= OUTPUT_SHAPE_FLOOR_WORDS && !OUTPUT_SHAPE_PATTERN.test(text)) {
    add({ kind: 'no-output-shape', severity: 'note', line: 0, excerpt: '',
      message: 'The prompt never says what the answer should look like — its length, shape or format.' });
  }

  for (const paragraph of paragraphs(text)) {
    if (limited('wall-of-text', 3)) break;
    const words = paragraph.text.split(/\s+/).filter(Boolean).length;
    if (words < WALL_OF_TEXT_WORDS) continue;
    add({ kind: 'wall-of-text', severity: 'caution', line: lineOf(text, paragraph.index), excerpt: '',
      message: `${words} words in one block. Breaking it into sections makes it easier to revise and easier to follow.` });
  }

  if (tokenBudget && tokenBudget > 0 && stats.estimatedTokens > tokenBudget * PROMPT_BUDGET_SHARE) {
    const share = Math.round((stats.estimatedTokens / tokenBudget) * 100);
    add({ kind: 'over-budget', severity: stats.estimatedTokens > tokenBudget ? 'problem' : 'caution', line: 0, excerpt: '',
      message: stats.estimatedTokens > tokenBudget
        ? `About ${stats.estimatedTokens.toLocaleString()} tokens against a ${tokenBudget.toLocaleString()}-token window. This will not fit; attach the long parts as files instead.`
        : `About ${stats.estimatedTokens.toLocaleString()} tokens — roughly ${share}% of the window, before the reply or any history.` });
  }

  const rank: Record<PromptFindingSeverity, number> = { problem: 0, caution: 1, note: 2 };
  return findings.sort((left, right) => rank[left.severity] - rank[right.severity] || left.line - right.line);
}

export const promptFindingCounts = (findings: PromptFinding[]): Record<PromptFindingSeverity, number> => ({
  problem: findings.filter((finding) => finding.severity === 'problem').length,
  caution: findings.filter((finding) => finding.severity === 'caution').length,
  note: findings.filter((finding) => finding.severity === 'note').length,
});

/** A prompt is sendable once it has text and no variable left standing. */
export const promptReady = (text: string, values: Record<string, string> = {}): boolean => {
  const composed = composePrompt(text, values);
  return !!composed.text && composed.missing.length === 0;
};

export interface PromptBlock {
  id: string;
  label: string;
  description: string;
  /** Inserted at the cursor. Ends with a newline where the block is a section of its own. */
  body: string;
}

/**
 * Scaffolding, not templates. Each one is a heading the person then fills in: the value is having
 * somewhere to put the constraint you only remember once there is a line for it.
 */
export const PROMPT_BLOCKS: readonly PromptBlock[] = [
  { id: 'task', label: 'Task', description: 'What you want done, as one instruction', body: '## Task\n\n\n' },
  { id: 'context', label: 'Context', description: 'What the model needs to know first', body: '## Context\n\n\n' },
  { id: 'constraints', label: 'Constraints', description: 'What it must not do, and what must hold', body: '## Constraints\n\n- \n' },
  { id: 'output', label: 'Output', description: 'The shape, length and format of the answer', body: '## Output\n\n\n' },
  { id: 'examples', label: 'Example', description: 'One worked case, input and expected answer', body: '## Example\n\nInput:\n\nExpected:\n\n' },
  { id: 'acceptance', label: 'Acceptance check', description: 'How you will tell whether it worked', body: '## Done when\n\n- \n' },
  { id: 'variable', label: 'Variable', description: 'A {{field}} filled in before sending', body: '{{field}}' },
] as const;

/** Inserts a block at the cursor, keeping blank-line spacing sane. Returns the new text and caret. */
export function insertBlock(text: string, at: number, block: string): { text: string; caret: number } {
  const index = Math.max(0, Math.min(at, text.length));
  const before = text.slice(0, index);
  const after = text.slice(index);
  const needsLeading = before.trim() && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const body = `${needsLeading}${block}`;
  return { text: `${before}${body}${after}`, caret: index + body.length };
}
