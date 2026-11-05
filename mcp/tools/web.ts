import { clip, num, str, type ToolDef } from '../types';

const MAX_BODY_BYTES = 400_000;

/** Only http(s) is allowed: file: and data: would turn a fetch into a local read. */
function checkedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refused: only http and https are allowed, got ${url.protocol}`);
  }
  return url;
}

async function readBody(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_BODY_BYTES ? `${text.slice(0, MAX_BODY_BYTES)}\n… [truncated]` : text;
}

/** Strips tags and collapses whitespace so a page fits in a model's context. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const webTools: ToolDef[] = [
  {
    name: 'fetch_text',
    description: 'Fetch a URL and return its readable text with markup stripped. Read-only GET.',
    inputSchema: {
      type: 'object',
      properties: {
        url: str('The http or https URL to fetch.'),
        timeout_ms: num('Give up after this many milliseconds. Default 15000.'),
      },
      required: ['url'],
    },
    async run(args) {
      const url = checkedUrl(args.url);
      const timeout = Math.min(Number(args.timeout_ms) || 15_000, 60_000);
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': 'Antimatter/1.0 (+local tool)' },
      });

      const body = await readBody(response);
      const contentType = response.headers.get('content-type') ?? '';
      const text = contentType.includes('html') ? htmlToText(body) : body;
      return clip(`${response.status} ${response.statusText} · ${url}\n\n${text}`);
    },
  },

  {
    name: 'http_request',
    description:
      'Make an arbitrary HTTP request and return the status, headers, and body. Use for APIs and webhooks.',
    inputSchema: {
      type: 'object',
      properties: {
        url: str('The http or https URL to call.'),
        method: str('HTTP method. Default GET.'),
        headers: { type: 'object', description: 'Request headers as name/value pairs.' },
        body: str('Request body, sent as-is.'),
        timeout_ms: num('Give up after this many milliseconds. Default 15000.'),
      },
      required: ['url'],
    },
    async run(args) {
      const url = checkedUrl(args.url);
      const method = String(args.method ?? 'GET').toUpperCase();
      const timeout = Math.min(Number(args.timeout_ms) || 15_000, 60_000);

      const response = await fetch(url, {
        method,
        headers: (args.headers as Record<string, string>) ?? undefined,
        body: method === 'GET' || method === 'HEAD' ? undefined : String(args.body ?? ''),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });

      const headers = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n');
      return clip(`${method} ${url}\n${response.status} ${response.statusText}\n\n${headers}\n\n${await readBody(response)}`);
    },
  },
];
