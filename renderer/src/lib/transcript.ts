import type { ToolActivity } from '../types';

export interface TranscriptTextPart {
  kind: 'text';
  /** Stable while more text is appended to this span. */
  key: string;
  text: string;
  /** UTF-16 boundaries in the complete assistant response. */
  start: number;
  end: number;
}

export interface TranscriptToolsPart {
  kind: 'tools';
  key: string;
  tools: ToolActivity[];
  /** Present for known positions; legacy activity is deliberately left unpositioned. */
  offset?: number;
  /** Old stored activity has no trustworthy position in the prose. */
  legacy?: boolean;
}

export type TranscriptPart = TranscriptTextPart | TranscriptToolsPart;

const isUnfinished = (activity: ToolActivity): boolean =>
  activity.status === 'pending' || activity.status === 'running' || activity.awaitingApproval === true;

/**
 * A persisted activity cannot still be running after the desktop process which owned it has
 * restarted. Settle those rows explicitly so a restored transcript never shows a live spinner
 * or an approval button wired to a resolver which no longer exists.
 */
export function settleRestoredToolActivities(tools: readonly ToolActivity[]): ToolActivity[] {
  let changed = false;
  const settled = tools.map((activity) => {
    if (!isUnfinished(activity)) return activity;
    changed = true;
    return {
      ...activity,
      status: 'failed' as const,
      awaitingApproval: false,
      result: activity.result || 'Interrupted before this action finished.',
    };
  });
  return changed ? settled : [...tools];
}

/** Provider call ids can repeat; an app-owned occurrence id, when present, is authoritative. */
const activityKey = (activity: ToolActivity): string =>
  activity.activityId ? `activity:${activity.activityId}` : `call:${activity.callId}`;

/**
 * Adds a newly observed tool occurrence or applies a lifecycle update to the occurrence already
 * present. The text offset belongs to the first event: a later running/done update must not move
 * the card past prose which arrived after the tool started.
 */
export function mergeToolActivity(
  existing: readonly ToolActivity[],
  incoming: ToolActivity,
  currentContentLength: number
): ToolActivity[] {
  const key = activityKey(incoming);
  const index = existing.findIndex((activity) => activityKey(activity) === key);

  if (index < 0) {
    // Main stamps the authoritative boundary before sending tool activity over IPC. The
    // renderer-side length is only a compatibility fallback for older senders; the text and
    // activity channels can be delivered on different ticks, so replacing a supplied anchor
    // here would subtly move the row forward in the transcript.
    const suppliedOffset = incoming.contentOffset;
    const contentOffset =
      typeof suppliedOffset === 'number' && Number.isFinite(suppliedOffset)
        ? suppliedOffset
        : currentContentLength;
    return [...existing, { ...incoming, contentOffset }];
  }

  const previous = existing[index];
  const updated: ToolActivity = { ...previous, ...incoming, contentOffset: previous.contentOffset };
  return existing.map((activity, activityIndex) => (activityIndex === index ? updated : activity));
}

/** A stored offset can be stale or malformed, but it must never make slicing lose prose. */
const clampOffset = (offset: number, contentLength: number): number =>
  Math.min(contentLength, Math.max(0, Math.trunc(offset)));

/**
 * Derives the transcript's visual sequence from append-only assistant prose and tool anchors.
 * Tools recorded at the same boundary stay together in first-seen order. Legacy tools are
 * collected at the end, where the UI can say their original position was not recorded instead
 * of inventing it.
 *
 * Grouping is on the recorded anchor, not on where that anchor lands in this text. Prose and
 * anchors arrive on separate channels and are stored separately, so a transcript can be read
 * back with anchors past the end of the text it has — and clamping first would then pile every
 * one of those calls into a single block at the end, in place of the sequence they happened in.
 */
export function buildTranscriptParts(
  content: string,
  tools: readonly ToolActivity[] = []
): TranscriptPart[] {
  const positioned: Array<{ activity: ToolActivity; index: number; offset: number }> = [];
  const legacy: ToolActivity[] = [];

  tools.forEach((activity, index) => {
    if (typeof activity.contentOffset === 'number' && Number.isFinite(activity.contentOffset)) {
      positioned.push({ activity, index, offset: Math.trunc(activity.contentOffset) });
    } else {
      legacy.push(activity);
    }
  });

  positioned.sort((left, right) => left.offset - right.offset || left.index - right.index);

  const parts: TranscriptPart[] = [];
  let cursor = 0;
  let positionedIndex = 0;

  while (positionedIndex < positioned.length) {
    const anchor = positioned[positionedIndex].offset;
    const offset = clampOffset(anchor, content.length);
    if (offset > cursor) {
      parts.push({ kind: 'text', key: `text:${cursor}`, text: content.slice(cursor, offset), start: cursor, end: offset });
    }

    const group: ToolActivity[] = [];
    while (positionedIndex < positioned.length && positioned[positionedIndex].offset === anchor) {
      group.push(positioned[positionedIndex].activity);
      positionedIndex += 1;
    }
    parts.push({ kind: 'tools', key: `tools:${anchor}`, tools: group, offset });
    cursor = offset;
  }

  if (cursor < content.length) {
    parts.push({ kind: 'text', key: `text:${cursor}`, text: content.slice(cursor), start: cursor, end: content.length });
  }

  if (legacy.length) {
    parts.push({ kind: 'tools', key: 'tools:legacy', tools: legacy, legacy: true });
  }

  return parts;
}

const compact = (value: unknown, maximum = 112): string => {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maximum ? oneLine : `${oneLine.slice(0, maximum - 1)}…`;
};

const parsedArguments = (activity: ToolActivity): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(activity.args || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const argument = (args: Record<string, unknown>, ...names: string[]): string => {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const rendered = compact(value);
      if (rendered) return rendered;
    }
  }
  return '';
};

const bareToolName = (name: string): string => {
  const segments = name.split('__');
  return segments[segments.length - 1] || name;
};

const prettyToolName = (name: string): string => {
  const bare = bareToolName(name);
  const words = bare.replace(/[_-]+/g, ' ').trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Tool';
};

/** A compact Codex-like description for a collapsed tool row. */
export function toolActivitySummary(activity: ToolActivity): string {
  const args = parsedArguments(activity);
  const bareName = bareToolName(activity.toolName);
  const path = argument(args, 'path', 'directory', 'cwd');
  const command = argument(args, 'command', 'cmd');
  const query = argument(args, 'query', 'text');
  const pattern = argument(args, 'pattern', 'glob');
  const url = argument(args, 'url');

  switch (bareName) {
    case 'workspace_info':
      return 'Inspect workspace';
    case 'read_file':
      return path ? `Read ${path}` : 'Read file';
    case 'write_file':
      return path ? `Write ${path}` : 'Write file';
    case 'edit_file':
      return path ? `Edit ${path}` : 'Edit file';
    case 'list_directory':
      return `List ${path || '.'}`;
    case 'find_files':
      return pattern ? `Find ${pattern}` : 'Find files';
    case 'search_text': {
      const where = path ? ` in ${path}` : '';
      return compact(query ? `Search for ${query}${where}` : `Search text${where}`);
    }
    case 'file_info':
      return path ? `Inspect ${path}` : 'Inspect file';
    case 'run_command':
      return command ? `Run ${command}` : 'Run command';
    case 'fetch_text':
      return url ? `Fetch ${url}` : 'Fetch URL';
    case 'http_request':
      return url ? `${argument(args, 'method').toUpperCase() || 'GET'} ${url}` : 'Send HTTP request';
    case 'open_path':
      return path ? `Open ${path}` : 'Open path';
    case 'git_status':
      return path ? `Check git status in ${path}` : 'Check git status';
    case 'git_log':
      return path ? `Read git log in ${path}` : 'Read git log';
    case 'git_diff':
      return path ? `Inspect git diff in ${path}` : 'Inspect git diff';
    case 'scan_secrets':
      return path ? `Scan secrets in ${path}` : 'Scan secrets';
    case 'scan_code':
      return path ? `Scan code in ${path}` : 'Scan code';
    case 'list_patterns':
      return 'List security patterns';
    case 'launch_program':
      return command ? `Start ${command}` : 'Start program';
    case 'start_agent':
    case 'run_agent': {
      const agent = argument(args, 'agent') || 'an agent';
      const label = argument(args, 'title', 'task');
      return compact(label ? `Hand to ${agent}: ${label}` : `Hand work to ${agent}`);
    }
    case 'wait_for_agents': {
      const named = Array.isArray(args.agents) ? args.agents.filter((entry) => typeof entry === 'string') : [];
      return compact(named.length ? `Wait for ${named.join(', ')}` : 'Wait for agents');
    }
    case 'agent_report': {
      const agent = argument(args, 'agent') || 'An agent';
      return compact(`${agent} reported back`);
    }
    case 'vault_list':
      return 'List Vault credentials';
    case 'vault_use': {
      // The tag, never the purpose: the purpose is a sentence and belongs in the card, while the
      // summary is the one line shown in a collapsed transcript.
      const credential = argument(args, 'tag');
      return compact(credential ? `Use the ${credential} credential` : 'Use a Vault credential');
    }
    case 'about_user': {
      const name = argument(args, 'name');
      const pronouns = argument(args, 'pronouns');
      const said = [name, pronouns].filter(Boolean).join(', ');
      return compact(said ? `Remember who you are: ${said}` : 'Remember who you are');
    }
    case 'remember':
    case 'recall':
    case 'forget': {
      const verb = bareName === 'remember' ? 'Remember' : bareName === 'recall' ? 'Recall' : 'Forget';
      const name = argument(args, 'name');
      // Saying where matters most for a save: a note about the user reaches every project.
      const everywhere = bareName === 'remember' && argument(args, 'scope') === 'user' ? ' (every project)' : '';
      return compact(name ? `${verb}: ${name}${everywhere}` : `${verb} a note`);
    }
    default: {
      const detail = argument(args, 'path', 'query', 'pattern', 'url', 'name', 'ref');
      return compact(detail ? `${prettyToolName(bareName)} ${detail}` : prettyToolName(bareName));
    }
  }
}
