import { readFileSync } from 'node:fs';
import { clip, num, str, type ToolDef } from '../types';
import { display, insideWorkspace, looksBinary, walkFiles } from '../workspace';

export interface Pattern {
  id: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
  regex: RegExp;
}

/** Credentials that should never be committed. Memory refuses to keep them too (src/main/memory). */
export const SECRET_PATTERNS: Pattern[] = [
  { id: 'aws-access-key', severity: 'high', description: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', severity: 'high', description: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'slack-token', severity: 'high', description: 'Slack token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'openai-key', severity: 'high', description: 'OpenAI-style API key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'private-key', severity: 'high', description: 'Private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'jwt', severity: 'medium', description: 'JSON Web Token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'generic-secret', severity: 'medium', description: 'Hardcoded secret assignment', regex: /\b(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
  { id: 'connection-string', severity: 'medium', description: 'Credentials in a URL', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i },
];

/** Code shapes that are worth a second look during review. */
const CODE_PATTERNS: Pattern[] = [
  { id: 'eval', severity: 'high', description: 'Dynamic code execution', regex: /\b(?:eval|new Function)\s*\(/ },
  { id: 'shell-injection', severity: 'high', description: 'Shell execution with interpolation', regex: /\b(?:exec|execSync|spawnSync)\s*\(\s*[`'"][^`'"]*\$\{/ },
  { id: 'python-shell', severity: 'high', description: 'Python shell execution', regex: /\b(?:os\.system|subprocess\.[a-z_]+\([^)]*shell\s*=\s*True)/ },
  { id: 'pickle', severity: 'high', description: 'Unsafe deserialization', regex: /\b(?:pickle\.loads|yaml\.load\s*\((?![^)]*Loader))/ },
  { id: 'inner-html', severity: 'medium', description: 'Unescaped HTML injection', regex: /\.innerHTML\s*=|dangerouslySetInnerHTML/ },
  { id: 'tls-disabled', severity: 'high', description: 'TLS verification disabled', regex: /NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0|verify\s*=\s*False|rejectUnauthorized\s*:\s*false/ },
  { id: 'weak-hash', severity: 'medium', description: 'Weak hash algorithm', regex: /\b(?:createHash\s*\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\()/i },
  { id: 'sql-concat', severity: 'medium', description: 'SQL built by concatenation', regex: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^;'"]*["']\s*\+|\bexecute\s*\(\s*f["']/i },
];

/** Secrets are reported by shape and position, never echoed in full. */
const redact = (match: string): string =>
  match.length <= 12 ? `${match.slice(0, 3)}…` : `${match.slice(0, 6)}…${match.slice(-2)} (${match.length} chars)`;

interface Finding {
  file: string;
  line: number;
  pattern: Pattern;
  evidence: string;
}

function scanContent(patterns: Pattern[], content: string, file: string, redactMatches: boolean): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 2000) continue; // minified bundles produce nothing but noise

    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      if (!match) continue;
      findings.push({
        file,
        line: index + 1,
        pattern,
        evidence: redactMatches ? redact(match[0]) : match[0].trim().slice(0, 160),
      });
    }
  }
  return findings;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

const report = (findings: Finding[], scanned: number, subject: string): string => {
  if (!findings.length) return `No findings in ${scanned} file(s) under ${subject}.`;

  const sorted = findings.sort((a, b) => SEVERITY_ORDER[a.pattern.severity] - SEVERITY_ORDER[b.pattern.severity]);
  const lines = sorted.map(
    (finding) => `[${finding.pattern.severity}] ${finding.file}:${finding.line} ${finding.pattern.description} — ${finding.evidence}`
  );
  const high = findings.filter((finding) => finding.pattern.severity === 'high').length;
  return clip(`${findings.length} finding(s) in ${scanned} file(s), ${high} high severity:\n\n${lines.join('\n')}`);
};

function scanTree(workspace: string, path: string, patterns: Pattern[], redactMatches: boolean, limit: number) {
  const root = insideWorkspace(workspace, path ?? '.');
  const findings: Finding[] = [];
  let scanned = 0;

  for (const file of walkFiles(root, { maxFileBytes: 512 * 1024 })) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (looksBinary(content)) continue;

    scanned += 1;
    findings.push(...scanContent(patterns, content, display(workspace, file), redactMatches));
    if (findings.length >= limit) break;
  }
  return { findings, scanned, root };
}

export const securityTools: ToolDef[] = [
  {
    name: 'scan_secrets',
    description:
      'Scan the workspace for committed credentials: API keys, tokens, private keys, and passwords in URLs. Matches are redacted in the report.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Subdirectory or file to scan. Defaults to the whole workspace.'),
        limit: num('Stop after this many findings. Default 200.'),
      },
    },
    async run(args, { workspace }) {
      const limit = Math.min(Number(args.limit) || 200, 1000);
      const { findings, scanned, root } = scanTree(workspace, args.path, SECRET_PATTERNS, true, limit);
      return report(findings, scanned, display(workspace, root));
    },
  },

  {
    name: 'scan_code',
    description:
      'Scan the workspace for risky code: dynamic evaluation, shell injection, unsafe deserialization, disabled TLS, weak hashes, and SQL built by concatenation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Subdirectory or file to scan. Defaults to the whole workspace.'),
        limit: num('Stop after this many findings. Default 200.'),
      },
    },
    async run(args, { workspace }) {
      const limit = Math.min(Number(args.limit) || 200, 1000);
      const { findings, scanned, root } = scanTree(workspace, args.path, CODE_PATTERNS, false, limit);
      return report(findings, scanned, display(workspace, root));
    },
  },

  {
    name: 'list_patterns',
    description: 'List the patterns scan_secrets and scan_code look for.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const describe = (pattern: Pattern) => `[${pattern.severity}] ${pattern.id} — ${pattern.description}`;
      return [
        'scan_secrets:',
        ...SECRET_PATTERNS.map(describe),
        '',
        'scan_code:',
        ...CODE_PATTERNS.map(describe),
      ].join('\n');
    },
  },
];
