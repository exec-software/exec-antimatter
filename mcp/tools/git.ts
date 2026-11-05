import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clip, num, str, type ToolDef } from '../types';
import { insideWorkspace } from '../workspace';

const run = promisify(execFile);

/**
 * Git is invoked with an argument array (never a shell string), so a branch or path
 * containing shell metacharacters cannot turn into a second command.
 */
async function git(workspace: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd: workspace,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return clip((stdout || stderr || '').trim() || '(no output)');
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message: string };
    const text = (details.stderr || details.stdout || details.message).trim();
    throw new Error(text.includes('not a git repository') ? 'This workspace is not a git repository.' : text);
  }
}

export const gitTools: ToolDef[] = [
  {
    name: 'git_status',
    description: 'Show the working tree status: branch, staged, unstaged, and untracked files.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, { workspace }) {
      const branch = await git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const status = await git(workspace, ['status', '--short', '--branch']);
      return `branch: ${branch}\n\n${status}`;
    },
  },

  {
    name: 'git_log',
    description: 'Show recent commits, most recent first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: num('How many commits to show. Default 20.'),
        path: str('Only show commits touching this path.'),
      },
    },
    async run(args, { workspace }) {
      const limit = Math.min(Number(args.limit) || 20, 200);
      const command = ['log', `-${limit}`, '--pretty=format:%h %ad %an — %s', '--date=short'];
      if (args.path) command.push('--', insideWorkspace(workspace, args.path));
      return git(workspace, command);
    },
  },

  {
    name: 'git_diff',
    description: 'Show changes in the working tree, or for a specific path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Limit the diff to this path.'),
        staged: str('Pass "true" to diff the staged changes instead of the working tree.'),
      },
    },
    async run(args, { workspace }) {
      const command = ['diff', '--stat', '--patch'];
      if (String(args.staged) === 'true') command.push('--staged');
      if (args.path) command.push('--', insideWorkspace(workspace, args.path));
      return git(workspace, command);
    },
  },
];
