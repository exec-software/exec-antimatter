import type {
  HubFile,
  HubGating,
  HubGgufFacts,
  HubModelDetail,
  HubModelSummary,
  HubSearchPage,
  HubSearchQuery,
  HubSort,
  HubVariant,
} from './types';

/**
 * The Hugging Face Hub's HTTP API, reduced to the three questions the Model Hub asks: what
 * matches a search, what one repository offers, and whose token this is.
 *
 * Everything here is plain `fetch` against documented endpoints, with the transport injectable
 * so it can be tested without the network. Downloads themselves live in transfer.ts, because a
 * 30 GB body is a different problem from a JSON reply.
 */

export type HubTransport = (input: string, init?: RequestInit) => Promise<Response>;

export interface HubClientOptions {
  /** Sent as a bearer token when present: gated and private repositories need it, and it raises rate limits. */
  token?: string | null;
  transport?: HubTransport;
  endpoint?: string;
  signal?: AbortSignal;
}

/** `HF_ENDPOINT` is the Hub's own convention for mirrors, so it is honoured the same way here. */
export const hubEndpoint = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.HF_ENDPOINT?.trim() || 'https://huggingface.co').replace(/\/+$/, '');

export type HubErrorCode =
  | 'unauthorized'
  | 'gated'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'invalid'
  | 'corrupt'
  | 'http';

export class HubError extends Error {
  constructor(
    readonly code: HubErrorCode,
    message: string,
    readonly status: number | null = null,
    /** How long the server asked us to wait, when it said. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'HubError';
  }

  /** Worth trying again unchanged: the network, the server, or a rate limit — never a refusal. */
  get retryable(): boolean {
    return this.code === 'network' || this.code === 'server' || this.code === 'rate_limited';
  }
}

/**
 * Repository ids are `owner/name`. They become URL segments and cache directory names, so the
 * shape is enforced rather than trusted: anything with `..` or a third segment is refused.
 */
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

export function assertRepoId(repoId: string): string {
  const trimmed = repoId.trim();
  if (!REPO_ID.test(trimmed) || trimmed.includes('..')) {
    throw new HubError('invalid', `"${repoId}" is not a Hugging Face repository id (owner/name).`);
  }
  return trimmed;
}

const encodeRepo = (repoId: string) => assertRepoId(repoId).split('/').map(encodeURIComponent).join('/');

/** A path inside a repository, encoded per segment so a `#` or space in a file name survives. */
export const encodeRepoPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

const parseRetryAfter = (response: Response): number | null => {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  // The Hub's own header: `"api";r=0;t=42` — t is seconds until the window resets.
  const reset = /;t=(\d+)/.exec(response.headers.get('ratelimit') ?? '');
  return reset ? Number(reset[1]) * 1000 : null;
};

/**
 * Turns a refusal into something a person can act on. The Hub names its reasons in
 * `x-error-code` (`GatedRepo`, `RepoNotFound`…) and explains them in `x-error-message`, which
 * beats any paraphrase of a status code.
 */
export async function errorFromResponse(response: Response, what: string): Promise<HubError> {
  const code = response.headers.get('x-error-code') ?? '';
  let message = response.headers.get('x-error-message') ?? '';
  if (!message) {
    const body = (await response.text().catch(() => '')).trim();
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      message = typeof parsed.error === 'string' ? parsed.error : body;
    } catch {
      message = body;
    }
  }
  message = message.slice(0, 400);
  const status = response.status;

  if (code === 'GatedRepo') {
    return new HubError(
      'gated',
      `${message || `${what} is gated.`} Accept its terms on huggingface.co with the account whose token is in Settings.`,
      status
    );
  }
  if (status === 401) {
    return new HubError(
      'unauthorized',
      message && message !== 'Invalid username or password.'
        ? `Hugging Face refused ${what}: ${message}`
        : `Hugging Face refused ${what}. The token in Settings is missing, expired, or lacks access.`,
      status
    );
  }
  if (status === 403) return new HubError('gated', message || `Hugging Face denied access to ${what}.`, status);
  if (status === 404) return new HubError('not_found', message || `${what} was not found on Hugging Face.`, status);
  if (status === 429) {
    return new HubError('rate_limited', `Hugging Face is rate limiting requests; try again shortly.`, status, parseRetryAfter(response));
  }
  if (status >= 500) return new HubError('server', `Hugging Face failed on ${what} (${status}).`, status);
  return new HubError('http', `Hugging Face answered ${status} for ${what}${message ? `: ${message}` : ''}.`, status);
}

async function getJson<T>(url: string, what: string, options: HubClientOptions): Promise<{ body: T; response: Response }> {
  const transport = options.transport ?? fetch;
  let response: Response;
  try {
    response = await transport(url, {
      headers: {
        Accept: 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    const cause = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message;
    throw new HubError('network', `Could not reach Hugging Face (${cause}).`);
  }
  if (!response.ok) throw await errorFromResponse(response, what);
  return { body: (await response.json()) as T, response };
}

const SORT_FIELD: Record<HubSort, string> = {
  downloads: 'downloads',
  likes: 'likes',
  trending: 'trendingScore',
  updated: 'lastModified',
  created: 'createdAt',
};

/**
 * Fields requested explicitly. Without `expand`, a search returns ids and little else; asking for
 * `gguf` is what puts a repository's architecture in the result list, which is the one fact that
 * says whether an engine here can run it before anyone downloads 30 GB to find out.
 */
const SUMMARY_FIELDS = ['author', 'downloads', 'likes', 'lastModified', 'pipeline_tag', 'tags', 'gated', 'private', 'gguf'];

export function searchUrl(query: HubSearchQuery, endpoint = hubEndpoint()): string {
  const params = new URLSearchParams();
  if (query.text.trim()) params.set('search', query.text.trim());
  if (query.author?.trim()) params.set('author', query.author.trim());
  if (query.format === 'gguf') params.set('filter', 'gguf');
  if (query.task) params.set('pipeline_tag', query.task);
  params.set('sort', SORT_FIELD[query.sort] ?? 'downloads');
  params.set('direction', '-1');
  params.set('limit', String(Math.min(Math.max(query.limit ?? 30, 1), 100)));
  for (const field of SUMMARY_FIELDS) params.append('expand[]', field);
  if (query.cursor) params.set('cursor', query.cursor);
  return `${endpoint}/api/models?${params.toString()}`;
}

/** The Hub paginates with an RFC 8288 `Link: <…&cursor=…>; rel="next"` header. */
export function nextCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (!match) continue;
    try {
      return new URL(match[1]).searchParams.get('cursor');
    } catch {
      return null;
    }
  }
  return null;
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asGating = (value: unknown): HubGating => (value === 'auto' || value === 'manual' ? value : false);

function ggufFacts(raw: unknown): HubGgufFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const gguf = raw as Record<string, unknown>;
  // The Hub also sends the chat template here, which can run to kilobytes per result; it stays behind.
  return {
    architecture: typeof gguf.architecture === 'string' ? gguf.architecture : null,
    contextLength: asNumber(gguf.context_length),
    parameters: asNumber(gguf.total),
  };
}

export function normalizeSummary(raw: Record<string, unknown>): HubModelSummary {
  const id = String(raw.id ?? raw.modelId ?? '');
  return {
    id,
    author: typeof raw.author === 'string' ? raw.author : id.includes('/') ? id.split('/')[0] : null,
    downloads: asNumber(raw.downloads) ?? 0,
    likes: asNumber(raw.likes) ?? 0,
    updatedAt: typeof raw.lastModified === 'string' ? raw.lastModified : null,
    task: typeof raw.pipeline_tag === 'string' ? raw.pipeline_tag : null,
    gated: asGating(raw.gated),
    private: raw.private === true,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    gguf: ggufFacts(raw.gguf),
  };
}

export async function searchModels(query: HubSearchQuery, options: HubClientOptions = {}): Promise<HubSearchPage> {
  const { body, response } = await getJson<Record<string, unknown>[]>(
    searchUrl(query, options.endpoint ?? hubEndpoint()),
    'the model search',
    options
  );
  return {
    models: (Array.isArray(body) ? body : []).map(normalizeSummary).filter((model) => model.id),
    nextCursor: nextCursor(response.headers.get('link')),
  };
}

/**
 * Quantization names as llama.cpp and the people who publish GGUFs spell them: `Q4_K_M`,
 * `IQ2_XXS`, Unsloth's `UD-Q4_K_XL`, `MXFP4_MOE`, `BF16`. Matched between separators so that a
 * model called `Qwen3` is not mistaken for a quant.
 */
const QUANT = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|TQ\d_\d|MXFP4(?:_MOE)?|B?F(?:16|32)|FP(?:8|16)))(?=$|[-_.])/gi;

export function quantOf(name: string): string | null {
  const stem = name.replace(/\.gguf$/i, '');
  const matches = [...stem.matchAll(QUANT)];
  return matches.length ? matches[matches.length - 1][1].toUpperCase() : null;
}

const SHARD = /^(.*)-(\d{5})-of-(\d{5})$/;

/**
 * Groups a repository's GGUF files into things a person would download. A split model's shards
 * become one variant, in order, because an engine is pointed at the first and finds the rest.
 */
export function groupVariants(files: HubFile[]): HubVariant[] {
  const groups = new Map<string, { files: { file: HubFile; index: number }[]; shards: number; stem: string }>();

  for (const file of files) {
    if (!/\.gguf$/i.test(file.path)) continue;
    const slash = file.path.lastIndexOf('/');
    const directory = slash === -1 ? '' : file.path.slice(0, slash + 1);
    const stem = file.path.slice(slash + 1).replace(/\.gguf$/i, '');
    const shard = SHARD.exec(stem);
    const base = shard ? shard[1] : stem;
    const key = shard ? `${directory}${base}` : file.path;
    const group = groups.get(key) ?? { files: [], shards: shard ? Number(shard[3]) : 1, stem: base };
    group.files.push({ file, index: shard ? Number(shard[2]) : 1 });
    groups.set(key, group);
  }

  const variants: HubVariant[] = [...groups.entries()].map(([key, group]) => {
    const ordered = group.files.sort((a, b) => a.index - b.index).map((entry) => entry.file);
    const quant = quantOf(group.stem);
    const projector = /mmproj/i.test(group.stem);
    return {
      key,
      label: projector ? `mmproj${quant ? ` ${quant}` : ''}` : (quant ?? group.stem),
      quant,
      files: ordered,
      bytes: ordered.reduce((total, file) => total + file.size, 0),
      shards: group.shards,
      role: projector ? 'projector' : 'model',
      complete: ordered.length === group.shards,
    };
  });

  return variants.sort((a, b) =>
    a.role === b.role ? a.bytes - b.bytes || a.label.localeCompare(b.label) : a.role === 'model' ? -1 : 1
  );
}

const DETAIL_FIELDS = ['sha', 'siblings', 'gguf', 'gated', 'private', 'pipeline_tag', 'cardData', 'lastModified'];

/** Without a revision this lists the default branch; with one, exactly that commit. */
export function detailUrl(repoId: string, revision: string | null = null, endpoint = hubEndpoint()): string {
  const params = new URLSearchParams({ blobs: 'true' });
  for (const field of DETAIL_FIELDS) params.append('expand[]', field);
  if (revision !== null && !/^[0-9a-f]{40}$/.test(revision)) {
    throw new HubError('invalid', `"${revision}" is not a commit hash.`);
  }
  const at = revision ? `/revision/${revision}` : '';
  return `${endpoint}/api/models/${encodeRepo(repoId)}${at}?${params.toString()}`;
}

interface RawSibling {
  rfilename?: unknown;
  size?: unknown;
  lfs?: { sha256?: unknown; size?: unknown };
}

const SHA256 = /^[0-9a-f]{64}$/;

export async function modelDetail(
  repoId: string,
  options: HubClientOptions & { revision?: string | null } = {}
): Promise<HubModelDetail> {
  const { body } = await getJson<Record<string, unknown>>(
    detailUrl(repoId, options.revision ?? null, options.endpoint ?? hubEndpoint()),
    assertRepoId(repoId),
    options
  );
  const revision = typeof body.sha === 'string' ? body.sha : '';
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new HubError('invalid', `Hugging Face did not say which commit ${repoId} is at.`);
  }

  const siblings = Array.isArray(body.siblings) ? (body.siblings as RawSibling[]) : [];
  const files: HubFile[] = siblings
    .map((sibling) => {
      const path = typeof sibling.rfilename === 'string' ? sibling.rfilename : '';
      const sha = typeof sibling.lfs?.sha256 === 'string' ? sibling.lfs.sha256.toLowerCase() : null;
      return {
        path,
        size: asNumber(sibling.lfs?.size) ?? asNumber(sibling.size) ?? 0,
        sha256: sha && SHA256.test(sha) ? sha : null,
      };
    })
    // A path from the network becomes a path on disk: nothing absolute, nothing that climbs.
    .filter((file) => file.path && !file.path.startsWith('/') && !file.path.split('/').includes('..'));

  const card = (body.cardData ?? {}) as Record<string, unknown>;
  const license = Array.isArray(card.license) ? card.license.join(', ') : typeof card.license === 'string' ? card.license : null;

  return {
    id: typeof body.id === 'string' ? body.id : repoId,
    revision,
    gated: asGating(body.gated),
    private: body.private === true,
    task: typeof body.pipeline_tag === 'string' ? body.pipeline_tag : null,
    license,
    updatedAt: typeof body.lastModified === 'string' ? body.lastModified : null,
    gguf: ggufFacts(body.gguf),
    variants: groupVariants(files),
    otherFiles: files.filter((file) => !/\.gguf$/i.test(file.path)).length,
  };
}

export interface HubAccount {
  name: string;
  fullname: string | null;
  /** What the token itself is allowed to do: `read`, `write`, or `fineGrained`. */
  tokenRole: string | null;
  tokenName: string | null;
}

export async function whoami(options: HubClientOptions): Promise<HubAccount> {
  if (!options.token) throw new HubError('unauthorized', 'No Hugging Face token is set.');
  const { body } = await getJson<Record<string, unknown>>(
    `${options.endpoint ?? hubEndpoint()}/api/whoami-v2`,
    'the token check',
    options
  );
  const access = ((body.auth as Record<string, unknown> | undefined)?.accessToken ?? {}) as Record<string, unknown>;
  return {
    name: String(body.name ?? ''),
    fullname: typeof body.fullname === 'string' ? body.fullname : null,
    tokenRole: typeof access.role === 'string' ? access.role : null,
    tokenName: typeof access.displayName === 'string' ? access.displayName : null,
  };
}
