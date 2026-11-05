import { randomUUID } from 'node:crypto';
import {
  idlePipeline,
  parseStage,
  parseStatus,
  parseValue,
  type ItemDraft,
  type ItemKind,
  type SnitchItem,
} from './model';

/**
 * Item ⇄ Markdown, in exec-snitch's on-disk format.
 *
 * Compatibility runs both ways and is the point: a project directory written by Snitch opens
 * here, and anything written here still opens in Snitch — its frontmatter reader ignores keys
 * it does not know, which is what lets the `pipeline:` block ride along.
 *
 * The one deliberate difference is the body parser. Snitch joins the lines of a section with no
 * separator, so a two-paragraph description comes back as one run-on line; here the lines are
 * kept, because these bodies are written by people and read by models.
 */

const SECTIONS = {
  steps: '## Steps to Reproduce',
  expected: '## Expected Behavior',
  actual: '## Actual Behavior',
} as const;

type Section = keyof typeof SECTIONS | 'description';

const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const unescape = (value: string) => value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

/** Frontmatter here is flat `key: value`; a full YAML parser would invite nesting we never read. */
function splitFrontmatter(content: string): { fields: Map<string, string>; body: string } {
  const fields = new Map<string, string>();
  const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { fields, body: text };

  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fields, body: text };

  for (const line of text.slice(4, end).split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    fields.set(line.slice(0, at).trim(), unescape(line.slice(at + 1).trim().replace(/^"|"$/g, '')));
  }

  return { fields, body: text.slice(end + 4).replace(/^\n/, '') };
}

/** Drop "1. ", "2) " or "- " so a step does not collect a new marker on every round trip. */
const stripMarker = (line: string): string => line.replace(/^\s*(?:\d+[.)]\s+|[-*]\s+)/, '');

const field = (fields: Map<string, string>, key: string): string | undefined => {
  const value = fields.get(key);
  return value && value.length ? value : undefined;
};

const timestamp = (fields: Map<string, string>, key: string, fallback: string): string => {
  const raw = field(fields, key);
  return raw && !Number.isNaN(Date.parse(raw)) ? raw : fallback;
};

export const newItemId = (prefix: string): string =>
  `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

export function createItem(kind: ItemKind, draft: ItemDraft, prefix: string): SnitchItem {
  const now = new Date().toISOString();
  return {
    kind,
    id: newItemId(prefix),
    title: draft.title.trim() || (kind === 'issue' ? 'Untitled issue' : 'Untitled request'),
    status: 'open',
    value: draft.value ?? 'medium',
    created: now,
    updated: now,
    versionFound: draft.versionFound ?? null,
    versionFixed: null,
    releaseId: null,
    description: draft.description?.trim() ?? '',
    steps: (draft.steps ?? []).map((step) => step.trim()).filter(Boolean),
    expected: draft.expected?.trim() ?? '',
    actual: draft.actual?.trim() ?? '',
    pipeline: idlePipeline(),
  };
}

export function toMarkdown(item: SnitchItem): string {
  const lines = ['---', `id: ${item.id}`, `title: "${escape(item.title)}"`, `status: ${item.status}`];
  lines.push(`${item.kind === 'issue' ? 'severity' : 'priority'}: ${item.value}`);
  lines.push(`created: ${item.created}`, `updated: ${item.updated}`);
  if (item.versionFound) lines.push(`version_found: ${item.versionFound}`);
  if (item.versionFixed) lines.push(`version_fixed: ${item.versionFixed}`);
  if (item.releaseId) lines.push(`release_id: ${item.releaseId}`);

  // Written only once a dispatch has happened, so untouched items stay byte-identical to Snitch.
  if (
    item.pipeline.stage !== 'idle' ||
    item.pipeline.generation > 0 ||
    item.pipeline.attempt > 0 ||
    item.pipeline.failures > 0
  ) {
    lines.push(
      `pipeline: ${item.pipeline.stage}`,
      `pipeline_generation: ${item.pipeline.generation}`,
      `pipeline_attempt: ${item.pipeline.attempt}`
    );
    if (item.pipeline.failures > 0) lines.push(`pipeline_failures: ${item.pipeline.failures}`);
    if (item.pipeline.updatedAt) lines.push(`pipeline_updated: ${item.pipeline.updatedAt}`);
    if (item.pipeline.note) lines.push(`pipeline_note: "${escape(item.pipeline.note.replace(/\s+/g, ' ').trim())}"`);
  }
  lines.push('---', '');

  const body: string[] = [];
  if (item.description) body.push(item.description, '');
  if (item.steps.length) {
    body.push(SECTIONS.steps, '', ...item.steps.map((step, index) => `${index + 1}. ${step}`), '');
  }
  if (item.expected) body.push(SECTIONS.expected, '', item.expected, '');
  if (item.actual) body.push(SECTIONS.actual, '', item.actual, '');

  return `${lines.join('\n')}\n${body.join('\n')}`.replace(/\n{3,}$/, '\n\n');
}

export function fromMarkdown(content: string, kind: ItemKind): SnitchItem {
  const { fields, body } = splitFrontmatter(content);
  const created = timestamp(fields, 'created', new Date().toISOString());

  const collected: Record<Section, string[]> = { description: [], steps: [], expected: [], actual: [] };
  let section: Section = 'description';
  for (const line of body.split('\n')) {
    const heading = (Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).find(
      (key) => line.trim() === SECTIONS[key]
    );
    if (heading) {
      section = heading;
      continue;
    }
    if (section === 'steps' && !line.trim()) continue;
    collected[section].push(section === 'steps' ? stripMarker(line).trim() : line);
  }

  const text = (lines: string[]) => lines.join('\n').trim();

  return {
    kind,
    id: field(fields, 'id') ?? newItemId(kind === 'issue' ? 'BUG' : 'REQ'),
    title: field(fields, 'title') ?? (kind === 'issue' ? 'Untitled issue' : 'Untitled request'),
    status: parseStatus(field(fields, 'status')),
    value: parseValue(field(fields, kind === 'issue' ? 'severity' : 'priority') ?? field(fields, 'severity')),
    created,
    updated: timestamp(fields, 'updated', created),
    versionFound: field(fields, 'version_found') ?? null,
    versionFixed: field(fields, 'version_fixed') ?? null,
    releaseId: field(fields, 'release_id') ?? null,
    description: text(collected.description),
    steps: collected.steps.filter(Boolean),
    expected: text(collected.expected),
    actual: text(collected.actual),
    pipeline: {
      stage: parseStage(field(fields, 'pipeline')),
      generation: Math.max(0, Number.parseInt(field(fields, 'pipeline_generation') ?? '0', 10) || 0),
      attempt: Number.parseInt(field(fields, 'pipeline_attempt') ?? '0', 10) || 0,
      failures: Number.parseInt(field(fields, 'pipeline_failures') ?? '0', 10) || 0,
      updatedAt: field(fields, 'pipeline_updated') ?? null,
      note: field(fields, 'pipeline_note') ?? null,
    },
  };
}
