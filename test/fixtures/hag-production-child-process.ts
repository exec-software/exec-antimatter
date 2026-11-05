/** No shell, inference server, MCP process, updater or terminal may run in this smoke. */
import * as actual from 'node:child_process';
export * from 'node:child_process';
const denied = (method: string) => (...args: unknown[]): never => {
  (globalThis as any).__hagProductionSmoke.boundaries.deniedChildren.push({ method, command: String(args[0]) });
  throw new Error(`HAG production smoke forbids child_process.${method}`);
};
export const spawn = denied('spawn');
export const spawnSync = denied('spawnSync');
export const exec = denied('exec');
export const execSync = denied('execSync');
export const execFile = denied('execFile');
export const execFileSync = denied('execFileSync');
export const fork = denied('fork');
export default { ...actual, spawn, spawnSync, exec, execSync, execFile, execFileSync, fork };
