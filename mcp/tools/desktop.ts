import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cleanChildEnv } from '../child-env';
import { str, type ToolDef } from '../types';
import { display, insideWorkspace } from '../workspace';

export interface OpenerCommand {
  command: string;
  args: string[];
}

/** Arguments stay separate so a path containing spaces is never reparsed by a shell. */
export function openerCommand(path: string, platform: NodeJS.Platform = process.platform): OpenerCommand {
  if (platform === 'darwin') return { command: 'open', args: [path] };
  // Never route a filename through `cmd /c start`: cmd reparses &, |, ^ and friends from an
  // otherwise legal path as commands. Explorer accepts the path as one process argument and
  // delegates files to their registered desktop application.
  if (platform === 'win32') return { command: 'explorer.exe', args: [path] };
  return { command: 'xdg-open', args: [path] };
}

export function openDetached(path: string): Promise<void> {
  const opener = openerCommand(path);
  return new Promise((resolve, reject) => {
    const child = spawn(opener.command, opener.args, {
      detached: true,
      stdio: 'ignore',
      env: cleanChildEnv(),
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export const desktopTools: ToolDef[] = [
  {
    name: 'open_path',
    description:
      'Open an existing workspace file or directory in the system default desktop app. Use this for GUI editors and file browsers; it returns immediately and must not be replaced with nano or vim through run_command. ' +
      "Not for web pages: the system default for one is a browser, so the page lands outside the app where you cannot see it. Use preview_url to show a page beside the conversation.",
    inputSchema: {
      type: 'object',
      properties: { path: str('Existing file or directory, relative to the workspace root.') },
      required: ['path'],
    },
    async run(args, { workspace }) {
      const target = insideWorkspace(workspace, args.path);
      if (!existsSync(target)) throw new Error(`No file or directory exists at ${display(workspace, target)}.`);
      // The system default for a web page is a browser, so this would put the user's work in a
      // window Antimatter neither owns nor can screenshot, and that the model cannot see
      // afterwards. preview_url renders the same page in the pane beside the conversation.
      if (/\.x?html?$/i.test(target)) {
        throw new Error(
          `${display(workspace, target)} is a web page. Opening it here launches the user's separate browser, ` +
            'outside the app and out of your view. Use preview_url instead — serve it, or give preview_url a file:// URL.'
        );
      }
      await openDetached(target);
      return `Opened ${display(workspace, target)} in the system default application.`;
    },
  },
];
