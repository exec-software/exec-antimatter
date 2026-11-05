import { existsSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { OrchestratorError, type WorkflowDefinition } from './types';

/**
 * The WORKFLOW.md loader (spec §5.1–5.2).
 *
 * WORKFLOW.md is the repository-owned policy file: YAML front matter for runtime settings, and
 * a Markdown body that is the per-issue prompt template. Keeping it in the repo is the point —
 * the prompt and the runtime settings version with the code they drive.
 */

const FRONT_MATTER_FENCE = '---';

export interface ParsedWorkflow extends WorkflowDefinition {
  /** Absolute path the definition was read from, for logs and file watching. */
  path: string;
}

/**
 * Splits front matter from body without a regex over the whole file, so a `---` inside the
 * prompt body cannot be mistaken for the closing fence.
 */
function split(source: string): { frontMatter: string | null; body: string } {
  // Tolerate a UTF-8 BOM and CRLF line endings; both are common in edited Markdown.
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  if (lines[0]?.trim() !== FRONT_MATTER_FENCE) return { frontMatter: null, body: text };

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === FRONT_MATTER_FENCE);
  if (closing === -1) {
    throw new OrchestratorError('workflow_parse_error', 'Front matter opened with --- but never closed.');
  }

  return {
    frontMatter: lines.slice(1, closing).join('\n'),
    body: lines.slice(closing + 1).join('\n'),
  };
}

/** §5.2 — parse a WORKFLOW.md that is already in memory. */
export function parseWorkflow(source: string): WorkflowDefinition {
  const { frontMatter, body } = split(source);

  if (frontMatter === null) {
    // No front matter: the whole file is the prompt and the config map is empty.
    return { config: {}, promptTemplate: body.trim() };
  }

  let parsed: unknown;
  try {
    parsed = load(frontMatter);
  } catch (error) {
    throw new OrchestratorError('workflow_parse_error', `Front matter is not valid YAML: ${(error as Error).message}`);
  }

  // An empty front matter block is legal and means "no config".
  if (parsed === null || parsed === undefined) return { config: {}, promptTemplate: body.trim() };

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrchestratorError(
      'workflow_front_matter_not_a_map',
      `Front matter must be a map, got ${Array.isArray(parsed) ? 'a list' : typeof parsed}.`
    );
  }

  return { config: parsed as Record<string, unknown>, promptTemplate: body.trim() };
}

/** §5.1 — read and parse the workflow file at `path`. */
export function loadWorkflow(path: string): ParsedWorkflow {
  if (!existsSync(path)) {
    throw new OrchestratorError('missing_workflow_file', `No workflow file at ${path}`);
  }

  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new OrchestratorError('missing_workflow_file', `Cannot read ${path}: ${(error as Error).message}`);
  }

  return { ...parseWorkflow(source), path };
}

const literal = (source: string): unknown => {
  const value = source.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        throw new OrchestratorError('template_parse_error', `Invalid quoted template literal: ${value}`);
      }
    }
    return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  if (value === 'nil' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return undefined;
};

function valueAt(expression: string, scope: Record<string, unknown>): unknown {
  const direct = literal(expression);
  if (direct !== undefined || ['nil', 'null'].includes(expression.trim())) return direct;

  const parts = expression.trim().split('.');
  let value: unknown = scope;
  for (const part of parts) {
    if (!part || value === null || value === undefined || typeof value !== 'object' || !(part in (value as object))) {
      throw new OrchestratorError('template_render_error', `Unknown template variable: ${expression.trim()}`);
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Splits only at delimiters outside quoted literals. */
function splitOutside(source: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? '' : quote || character;
      continue;
    }
    if (!quote && character === delimiter) {
      parts.push(source.slice(start, index));
      start = index + delimiter.length;
    }
  }
  if (quote) throw new OrchestratorError('template_parse_error', 'Unclosed quoted template literal.');
  parts.push(source.slice(start));
  return parts;
}

function indexOutside(source: string, needle: string): number {
  let quote = '';
  let escaped = false;
  for (let index = 0; index <= source.length - needle.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? '' : quote || character;
      continue;
    }
    if (!quote && source.slice(index, index + needle.length) === needle) return index;
  }
  return -1;
}

function evaluate(expression: string, scope: Record<string, unknown>): unknown {
  const [path, ...filters] = splitOutside(expression, '|').map((part) => part.trim());
  let value = valueAt(path, scope);

  for (const source of filters) {
    const separator = indexOutside(source, ':');
    const name = (separator === -1 ? source : source.slice(0, separator)).trim().toLowerCase();
    const args = (separator === -1 ? [] : splitOutside(source.slice(separator + 1), ','))
      .map((arg) => arg.trim())
      .filter(Boolean)
      .map((arg) => {
        const parsed = literal(arg);
        return parsed === undefined ? valueAt(arg, scope) : parsed;
      });

    switch (name) {
      case 'default':
        if (value === null || value === undefined || value === '' || value === false) value = args[0] ?? '';
        break;
      case 'join':
        if (!Array.isArray(value)) throw new OrchestratorError('template_render_error', 'join expects an array.');
        value = value.join(String(args[0] ?? ' '));
        break;
      case 'downcase':
        value = String(value ?? '').toLowerCase();
        break;
      case 'upcase':
        value = String(value ?? '').toUpperCase();
        break;
      case 'strip':
        value = String(value ?? '').trim();
        break;
      case 'size':
        value = Array.isArray(value) || typeof value === 'string' ? value.length : Object.keys((value ?? {}) as object).length;
        break;
      case 'json':
        value = JSON.stringify(value);
        break;
      case 'escape':
        value = String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
        break;
      default:
        throw new OrchestratorError('template_render_error', `Unknown template filter: ${name || source}`);
    }
  }
  return value;
}

const printable = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

type TemplateToken = { kind: 'text' | 'output' | 'tag'; value: string };
type TemplateNode =
  | { kind: 'text'; value: string }
  | { kind: 'output'; expression: string }
  | { kind: 'for'; name: string; expression: string; body: TemplateNode[] }
  | { kind: 'if'; branches: Array<{ condition: string | null; body: TemplateNode[] }> };

/** Tokenize the template once. Rendered issue data is never scanned as template source. */
function tokenize(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let cursor = 0;

  while (cursor < template.length) {
    const outputStart = template.indexOf('{{', cursor);
    const tagStart = template.indexOf('{%', cursor);
    const starts = [outputStart, tagStart].filter((value) => value >= 0);
    const next = starts.length ? Math.min(...starts) : -1;
    const strayOutput = template.indexOf('}}', cursor);
    const strayTag = template.indexOf('%}', cursor);
    const stray = [strayOutput, strayTag].filter((value) => value >= 0);
    if (stray.length && (next === -1 || Math.min(...stray) < next)) {
      throw new OrchestratorError('template_parse_error', 'Unexpected closing Liquid delimiter.');
    }

    if (next === -1) {
      tokens.push({ kind: 'text', value: template.slice(cursor) });
      break;
    }
    if (next > cursor) tokens.push({ kind: 'text', value: template.slice(cursor, next) });

    const output = next === outputStart;
    const close = template.indexOf(output ? '}}' : '%}', next + 2);
    if (close === -1) {
      throw new OrchestratorError(
        'template_parse_error',
        `Unclosed Liquid ${output ? 'output' : 'tag'} delimiter.`
      );
    }
    tokens.push({ kind: output ? 'output' : 'tag', value: template.slice(next + 2, close).trim() });
    cursor = close + 2;
  }
  return tokens;
}

interface ParsedBlock {
  nodes: TemplateNode[];
  next: number;
  stop: string | null;
}

const tagName = (tag: string): string => tag.split(/\s+/, 1)[0]?.toLowerCase() ?? '';

function parseBlock(tokens: TemplateToken[], start: number, stops = new Set<string>()): ParsedBlock {
  const nodes: TemplateNode[] = [];
  let index = start;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === 'text') {
      nodes.push({ kind: 'text', value: token.value });
      index += 1;
      continue;
    }
    if (token.kind === 'output') {
      if (!token.value) throw new OrchestratorError('template_parse_error', 'Empty Liquid output expression.');
      nodes.push({ kind: 'output', expression: token.value });
      index += 1;
      continue;
    }

    const name = tagName(token.value);
    if (stops.has(name)) return { nodes, next: index + 1, stop: token.value };

    const loop = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/i.exec(token.value);
    if (loop) {
      const body = parseBlock(tokens, index + 1, new Set(['endfor']));
      if (!body.stop || tagName(body.stop) !== 'endfor') {
        throw new OrchestratorError('template_parse_error', 'Unclosed Liquid for tag.');
      }
      nodes.push({ kind: 'for', name: loop[1], expression: loop[2].trim(), body: body.nodes });
      index = body.next;
      continue;
    }

    const conditional = /^if\s+(.+)$/i.exec(token.value);
    if (conditional) {
      const branches: Array<{ condition: string | null; body: TemplateNode[] }> = [];
      let condition: string | null = conditional[1].trim();
      let branchStart = index + 1;
      for (;;) {
        const branch = parseBlock(tokens, branchStart, new Set(['elsif', 'else', 'endif']));
        branches.push({ condition, body: branch.nodes });
        if (!branch.stop) throw new OrchestratorError('template_parse_error', 'Unclosed Liquid if tag.');
        const ending = tagName(branch.stop);
        if (ending === 'elsif') {
          const nextCondition = /^elsif\s+(.+)$/i.exec(branch.stop)?.[1]?.trim();
          if (!nextCondition) throw new OrchestratorError('template_parse_error', 'Liquid elsif needs a condition.');
          condition = nextCondition;
          branchStart = branch.next;
          continue;
        }
        if (ending === 'else') {
          const fallback = parseBlock(tokens, branch.next, new Set(['endif']));
          if (!fallback.stop || tagName(fallback.stop) !== 'endif') {
            throw new OrchestratorError('template_parse_error', 'Unclosed Liquid if tag.');
          }
          branches.push({ condition: null, body: fallback.nodes });
          index = fallback.next;
          break;
        }
        index = branch.next;
        break;
      }
      nodes.push({ kind: 'if', branches });
      continue;
    }

    if (['endfor', 'elsif', 'else', 'endif'].includes(name)) {
      throw new OrchestratorError('template_parse_error', `Unexpected Liquid ${name} tag.`);
    }
    throw new OrchestratorError('template_parse_error', `Unsupported Liquid tag: ${token.value}`);
  }

  return { nodes, next: index, stop: null };
}

function keywordOutside(source: string, keyword: string): number {
  const needle = ` ${keyword} `;
  return indexOutside(source, needle);
}

const truthy = (value: unknown): boolean => value !== false && value !== null && value !== undefined;

function evaluateCondition(source: string, scope: Record<string, unknown>): boolean {
  const expression = source.trim();
  for (const operator of ['or', 'and']) {
    const at = keywordOutside(expression, operator);
    if (at >= 0) {
      const left = evaluateCondition(expression.slice(0, at), scope);
      const right = evaluateCondition(expression.slice(at + operator.length + 2), scope);
      return operator === 'or' ? left || right : left && right;
    }
  }

  for (const operator of [' contains ', ' >= ', ' <= ', ' == ', ' != ', ' > ', ' < ']) {
    const at = indexOutside(expression, operator);
    if (at < 0) continue;
    const left = evaluate(expression.slice(0, at), scope);
    const right = evaluate(expression.slice(at + operator.length), scope);
    switch (operator.trim()) {
      case 'contains':
        return Array.isArray(left) ? left.includes(right) : String(left ?? '').includes(String(right ?? ''));
      case '>=':
        return Number(left) >= Number(right);
      case '<=':
        return Number(left) <= Number(right);
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      case '>':
        return Number(left) > Number(right);
      case '<':
        return Number(left) < Number(right);
    }
  }
  return truthy(evaluate(expression, scope));
}

function renderNodes(nodes: TemplateNode[], scope: Record<string, unknown>): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') return node.value;
      if (node.kind === 'output') return printable(evaluate(node.expression, scope));
      if (node.kind === 'for') {
        const collection = evaluate(node.expression, scope);
        if (!Array.isArray(collection)) {
          throw new OrchestratorError('template_render_error', `${node.expression} is not iterable.`);
        }
        return collection.map((item) => renderNodes(node.body, { ...scope, [node.name]: item })).join('');
      }
      const branch = node.branches.find((candidate) =>
        candidate.condition === null ? true : evaluateCondition(candidate.condition, scope)
      );
      return branch ? renderNodes(branch.body, scope) : '';
    })
    .join('');
}

function render(template: string, scope: Record<string, unknown>): string {
  const parsed = parseBlock(tokenize(template), 0);
  if (parsed.stop) throw new OrchestratorError('template_parse_error', `Unexpected Liquid tag: ${parsed.stop}`);
  return renderNodes(parsed.nodes, scope);
}

/** §5.4 — strict Liquid-compatible interpolation, common filters, and nested array loops. */
export function renderPrompt(template: string, issue: Record<string, unknown>, attempt: number | null): string {
  return render(template, { issue, attempt });
}

/** §5.4 — used when the workflow body is empty. A read failure is an error, not this. */
export const FALLBACK_PROMPT = 'You are working on an issue from the tracker.';
