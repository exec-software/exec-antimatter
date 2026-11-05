import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export interface PullRequestRepository {
  workspace: string;
  owner: string;
  name: string;
  slug: string;
  url: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  base: string;
  head: string;
  updatedAt: string;
  review: 'approved' | 'changes-requested' | 'required' | 'none';
  checks: 'passing' | 'failing' | 'pending' | 'none';
}

export interface PullRequestIssue {
  kind: 'no-workspace' | 'git-missing' | 'not-repository' | 'no-origin' | 'unsupported-origin' | 'gh-missing' | 'authentication' | 'unreachable' | 'failed';
  message: string;
  action: string;
}

export interface PullRequestListState {
  repository: PullRequestRepository | null;
  items: PullRequestSummary[];
  limit: number;
  fetchedAt: number;
  issue: PullRequestIssue | null;
}

export interface PullRequestDetail {
  repository: PullRequestRepository;
  pullRequest: PullRequestSummary;
  body: string;
  files: Array<{ path: string; additions: number; deletions: number }>;
  changedFiles: number;
  additions: number;
  deletions: number;
  filesTruncated: boolean;
}

export type PullRequestCommand = (command: 'git' | 'gh', args: readonly string[], cwd: string) => Promise<string>;

const LIMIT = 100;
const MAX_FILES = 1000;
const SUMMARY_FIELDS = 'number,title,author,isDraft,baseRefName,headRefName,updatedAt,reviewDecision,statusCheckRollup';

/** No shell, checkout, hooks, prompts, token storage, or write-capable GitHub commands. */
export const runPullRequestCommand: PullRequestCommand = (command, args, cwd) => new Promise((resolve, reject) => {
  execFile(command, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
  }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr }));
    else resolve(stdout);
  });
});

class PullRequestFailure extends Error {
  constructor(readonly issue: PullRequestIssue) { super(`${issue.message} ${issue.action}`); }
}

function fail(kind: PullRequestIssue['kind'], message: string, action: string): never {
  throw new PullRequestFailure({ kind, message, action });
}

/** Parse only a GitHub.com repository identity; never reuse a remote's credentials as a URL. */
export function githubRepository(remote: string, workspace: string): PullRequestRepository | null {
  let path: string;
  const scp = /^git@github\.com:([^?#\s]+)$/i.exec(remote.trim());
  if (scp) path = scp[1];
  else {
    let parsed: URL;
    try { parsed = new URL(remote.trim()); } catch { return null; }
    if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.search || parsed.hash || parsed.password) return null;
    if (parsed.protocol === 'ssh:') {
      if (parsed.username !== 'git') return null;
    } else if (parsed.protocol !== 'https:' || parsed.username) return null;
    path = parsed.pathname.replace(/^\//, '');
  }
  path = path.replace(/\/$/, '').replace(/\.git$/i, '');
  const parts = /^([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]+)$/i.exec(path);
  if (!parts || parts[2] === '.' || parts[2] === '..') return null;
  const [, owner, name] = parts;
  const slug = `${owner}/${name}`;
  return { workspace, owner, name, slug, url: `https://github.com/${slug}` };
}

async function repositoryAt(workspace: string | null, run: PullRequestCommand): Promise<PullRequestRepository> {
  if (!workspace || !isAbsolute(workspace)) fail('no-workspace', 'Choose a project to see its pull requests.', 'Open a project folder first.');
  let root: string;
  try { root = (await run('git', ['rev-parse', '--show-toplevel'], workspace)).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') fail('git-missing', 'Git is not installed or is not on PATH.', 'Install Git, then restart Antimatter.');
    fail('not-repository', 'This project is not an accessible Git repository.', 'Choose the repository folder and refresh.');
  }
  if (!isAbsolute(root)) fail('not-repository', 'Git did not return a usable repository folder.', 'Choose the repository folder and refresh.');
  let remote: string;
  try { remote = await run('git', ['remote', 'get-url', 'origin'], root); }
  catch { fail('no-origin', 'This repository has no readable origin remote.', 'Add a GitHub origin remote in your terminal, then refresh.'); }
  const repository = githubRepository(remote, root);
  if (!repository) fail('unsupported-origin', 'This origin is not a supported, credential-free GitHub URL.', 'Use an SSH or HTTPS github.com origin without embedded tokens. Other Git hosts are not supported by this view yet.');
  return repository;
}

function commandIssue(error: unknown): PullRequestIssue {
  if (error instanceof PullRequestFailure) return error.issue;
  const detail = error as { code?: string | number; stderr?: string; message?: string; killed?: boolean };
  if (detail?.code === 'ENOENT') return { kind: 'gh-missing', message: 'GitHub CLI (gh) is not installed or is not on PATH.', action: 'Install GitHub CLI, run gh auth login in your terminal, then restart Antimatter.' };
  const diagnostic = `${detail?.stderr ?? ''} ${detail?.message ?? ''}`;
  if (/gh auth login|not logged|authentication|bad credentials|HTTP 401|HTTP 403|token.*(?:expired|invalid)|oauth/i.test(diagnostic)) {
    return { kind: 'authentication', message: 'GitHub CLI needs access to this repository.', action: 'Run gh auth login or gh auth refresh in your terminal, then refresh this page.' };
  }
  if (detail?.killed || /timed? ?out|ENOTFOUND|ECONN|network|no such host|could not resolve|unable to connect|error connecting/i.test(diagnostic)) {
    return { kind: 'unreachable', message: 'GitHub could not be reached.', action: 'Check your connection or VPN, then refresh.' };
  }
  // Never echo command output: a remote, gh config, or transport error can include credentials.
  return { kind: 'failed', message: 'GitHub CLI could not read the pull requests.', action: 'Check gh auth status and repository access in your terminal, then refresh.' };
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 500): string => typeof value === 'string' ? value.slice(0, max) : '';
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function pullRequestChecks(value: unknown): PullRequestSummary['checks'] {
  if (!Array.isArray(value) || !value.length) return 'none';
  let pending = false;
  for (const raw of value) {
    const check = record(raw);
    const conclusion = text(check.conclusion || check.state).toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion)) return 'failing';
    if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) pending = true;
  }
  return pending ? 'pending' : 'passing';
}

function summary(raw: unknown, repository: PullRequestRepository): PullRequestSummary {
  const item = record(raw);
  const number = count(item.number);
  if (!number) throw new Error('GitHub returned an invalid pull request number.');
  return {
    number, title: text(item.title) || `Pull request #${number}`,
    url: `${repository.url}/pull/${number}`,
    author: text(record(item.author).login, 100) || 'Unknown author',
    draft: item.isDraft === true, base: text(item.baseRefName), head: text(item.headRefName),
    updatedAt: text(item.updatedAt, 100), checks: pullRequestChecks(item.statusCheckRollup),
    review: item.reviewDecision === 'APPROVED' ? 'approved' : item.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested' : item.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : 'none',
  };
}

export async function listPullRequests(workspace: string | null, run: PullRequestCommand = runPullRequestCommand): Promise<PullRequestListState> {
  let repository: PullRequestRepository | null = null;
  try {
    repository = await repositoryAt(workspace, run);
    const raw: unknown = JSON.parse(await run('gh', ['pr', 'list', '--repo', `github.com/${repository.slug}`, '--state', 'open', '--limit', String(LIMIT), '--json', SUMMARY_FIELDS], repository.workspace));
    if (!Array.isArray(raw)) throw new Error('GitHub returned an invalid pull request list.');
    const items = raw.slice(0, LIMIT).map((item) => summary(item, repository!));
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { repository, items, limit: LIMIT, fetchedAt: Date.now(), issue: null };
  } catch (error) {
    return { repository, items: [], limit: LIMIT, fetchedAt: Date.now(), issue: commandIssue(error) };
  }
}

export async function readPullRequest(workspace: string | null, number: number, run: PullRequestCommand = runPullRequestCommand): Promise<PullRequestDetail> {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Choose a valid pull request number.');
  try {
    const repository = await repositoryAt(workspace, run);
    const item = record(JSON.parse(await run('gh', ['pr', 'view', String(number), '--repo', `github.com/${repository.slug}`, '--json', `${SUMMARY_FIELDS},body,files,changedFiles,additions,deletions`], repository.workspace)));
    const pullRequest = summary(item, repository);
    if (pullRequest.number !== number) throw new Error('GitHub returned a different pull request.');
    const rawFiles = Array.isArray(item.files) ? item.files : [];
    const files = rawFiles.slice(0, MAX_FILES).map((raw) => {
      const file = record(raw);
      return { path: text(file.path, 2048), additions: count(file.additions), deletions: count(file.deletions) };
    }).filter((file) => file.path);
    const changedFiles = Math.max(count(item.changedFiles), rawFiles.length);
    return { repository, pullRequest, body: text(item.body, 65_536), files, changedFiles,
      additions: count(item.additions), deletions: count(item.deletions), filesTruncated: files.length < changedFiles };
  } catch (error) {
    const issue = commandIssue(error);
    throw new Error(`${issue.message} ${issue.action}`);
  }
}

/** Bounded, authenticated read for review chats; never shells out to an arbitrary gh command. */
export async function readPullRequestPatch(workspace: string | null, number: number, offset = 0, run: PullRequestCommand = runPullRequestCommand) {
  if (!Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('Invalid pull request number or diff offset.');
  try {
    const repository = await repositoryAt(workspace, run);
    const patch = await run('gh', ['pr', 'diff', String(number), '--repo', `github.com/${repository.slug}`, '--color', 'never'], repository.workspace);
    const lines = patch.split('\n');
    const page: string[] = [];
    let length = 0;
    for (let i = offset; i < Math.min(lines.length, offset + 200); i++) {
      const line = lines[i].slice(0, 4000);
      if (length + line.length > 32_000) break;
      page.push(`${i + 1}: ${line}${line.length < lines[i].length ? ' [long line truncated]' : ''}`);
      length += line.length;
    }
    const nextOffset = offset + page.length < lines.length ? offset + page.length : null;
    return { repository: repository.slug, number, totalLines: lines.length, offset, nextOffset, patch: page.join('\n') };
  } catch (error) {
    const issue = commandIssue(error);
    throw new Error(`${issue.message} ${issue.action} Very large diffs may need to be inspected on GitHub.`);
  }
}
