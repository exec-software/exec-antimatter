export interface RemoteToolDescription {
  summary: string;
  argumentsPreview: string;
  approvalDetails: string;
}

const PREVIEW_LIMIT = 480;
const DETAILS_LIMIT = 960;
const VALUE_LIMIT = 320;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const SECRET_KEY = /(?:^|[_-])(?:(?:api|private|signing|encryption|ssh)[_-]?key|access[_-]?key(?:[_-]?id)?|auth|authorization|cookie|credential|pass(?:word|wd)?|secret|token)(?:$|[_-])/i;
const OPAQUE_KEY = /(?:commands?|cmd|content|body|data|diff|patch|payload|prompt|script|source[_-]?code|old[_-]?text|new[_-]?text|replacement|headers?|env(?:ironment)?|cookies?)/i;

const compact = (value: unknown, maximum = VALUE_LIMIT): string => {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const oneLine = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length <= maximum ? oneLine : `${oneLine.slice(0, maximum - 1)}…`;
};

const bounded = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

/** Normalize snake/kebab/camel/Pascal/acronym keys before applying credential-name rules. */
function normalizedKey(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

const isSecretKey = (value: string): boolean => SECRET_KEY.test(normalizedKey(value));

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return compact(value, 180);
    parsed.username = '';
    parsed.password = '';
    const hadQuery = !!parsed.search;
    parsed.search = '';
    parsed.hash = '';
    return bounded(`${parsed.toString()}${hadQuery ? '?[query withheld]' : ''}`, 240);
  } catch {
    return compact(value, 180);
  }
}

function redactText(value: string): string {
  let output = compact(value);
  output = output.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]');
  output = output.replace(
    /((?:--)?(?:api[_-]?key|auth|authorization|cookie|credential|pass(?:word|wd)?|secret|token)(?:=|\s+))([^\s;&|]+)/gi,
    '$1[redacted]'
  );
  output = output.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)=([^\s;&|]+)/g,
    '$1=[redacted]'
  );
  output = output.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => safeUrl(candidate));
  return bounded(output, VALUE_LIMIT);
}

function parsedArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

const bareToolName = (name: string): string => name.split('__').at(-1) || name || 'unknown';

const prettyToolName = (name: string): string => {
  const words = bareToolName(name).replace(/[_-]+/g, ' ').trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Tool action';
};

function scalar(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const rendered = redactText(String(value));
      if (rendered) return rendered;
    }
  }
  return '';
}

function summaryFor(toolName: string, args: Record<string, unknown>): string {
  const bare = bareToolName(toolName);
  const path = scalar(args, 'path', 'directory', 'cwd', 'file', 'source', 'destination');
  const url = typeof args.url === 'string' ? safeUrl(args.url) : '';
  switch (bare) {
    case 'write_file': return path ? `Write ${path}` : 'Write file';
    case 'edit_file': return path ? `Edit ${path}` : 'Edit file';
    case 'delete_file': return path ? `Delete ${path}` : 'Delete file';
    case 'move_file': return path ? `Move ${path}` : 'Move file';
    case 'run_command':
    case 'coding_run_command': return 'Run command';
    case 'launch_program': return 'Launch program';
    case 'http_request': return url ? `${scalar(args, 'method').toUpperCase() || 'GET'} ${url}` : 'Send HTTP request';
    case 'fetch_text': return url ? `Fetch ${url}` : 'Fetch URL';
    case 'screenshot': return scalar(args, 'window') ? `Capture window ${scalar(args, 'window')}` : 'Capture desktop display';
    default: {
      const detail = path || url || scalar(args, 'query', 'pattern', 'name', 'ref', 'target');
      return bounded(detail ? `${prettyToolName(bare)} ${detail}` : prettyToolName(bare), 360);
    }
  }
}

function publicFields(args: Record<string, unknown>): { fields: string[]; withheld: string[] } {
  const fields: string[] = [];
  const withheld: string[] = [];
  for (const key of Object.keys(args).sort()) {
    const value = args[key];
    if (isSecretKey(key)) {
      fields.push(`${key}: [redacted]`);
      continue;
    }
    if (OPAQUE_KEY.test(key)) {
      if (typeof value === 'string') fields.push(`${key}: [${value.length} characters withheld]`);
      else if (Array.isArray(value)) fields.push(`${key}: [${value.length} items withheld]`);
      else if (value && typeof value === 'object') fields.push(`${key}: [values withheld]`);
      else withheld.push(key);
      continue;
    }
    if (typeof value === 'string') {
      const rendered = key.toLowerCase().includes('url') ? safeUrl(value) : redactText(value);
      fields.push(`${key}: ${rendered || '[empty]'}`);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      fields.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      fields.push(`${key}: [${value.length} items]`);
    } else if (value && typeof value === 'object') {
      fields.push(`${key}: [${Object.keys(value as Record<string, unknown>).length} fields; values withheld]`);
    } else {
      withheld.push(key);
    }
  }
  return { fields, withheld };
}

/**
 * Builds the only tool-argument representation allowed across the remote boundary. It describes
 * targets and effects, but never forwards the raw argument object, file contents, request bodies,
 * environment values, headers, or credential-like fields.
 */
export function describeRemoteTool(toolName: string, rawArguments?: string): RemoteToolDescription {
  const args = parsedArguments(rawArguments);
  const summary = summaryFor(toolName, args);
  const { fields, withheld } = publicFields(args);
  const joined = fields.join(' · ') || 'No display-safe parameters were supplied.';
  const withheldSuffix = withheld.length ? ` · Withheld fields: ${withheld.join(', ')}` : '';
  const argumentsPreview = bounded(`${joined}${withheldSuffix}`, PREVIEW_LIMIT);
  const approvalDetails = bounded(`${summary}. Host-redacted parameters: ${joined}${withheldSuffix}`, DETAILS_LIMIT);
  return { summary, argumentsPreview, approvalDetails };
}
