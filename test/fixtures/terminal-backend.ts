import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTerminalManager, type SessionInfo } from '../../src/main/terminal';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, message: string): Promise<void> {
  const end = Date.now() + 3_000;
  while (!ready()) { assert.ok(Date.now() < end, message); await pause(10); }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A terminated child can briefly remain a zombie while the container's init reaps it.
    if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch { return false; }
}

export async function run(output: string): Promise<void> {
  if (process.platform === 'win32') throw new Error('This smoke uses POSIX Bash commands.');
  const terminal = createTerminalManager();
  const commands: SessionInfo[] = [];
  const seen = new Map<string, string>();
  const offsetErrors: string[] = [];
  terminal.connect({
    onData(id, data, offset) {
      seen.set(id, (seen.get(id) ?? '') + data);
      if (offset !== seen.get(id)!.length) offsetErrors.push(id);
    },
    onExit() {},
    onCommand(info) { commands.push(info); },
  });
  try {
    const result = await terminal.runCommand({ command: "printf '\\033[32mnormal-output\\033[0m\\n'; printf x >> once.txt", cwd: output, timeoutMs: 3_000 });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /normal-output/);
    assert.doesNotMatch(result.text, /\x1b/);
    assert.equal(readFileSync(join(output, 'once.txt'), 'utf8'), 'x', 'exactly one execution, no retry');
    assert.equal(commands.length, 1);

    const privateRun = terminal.runCommand({ command: 'printf "synthetic input: "; IFS= read -r answer; printf "received:%s\\n" "$answer"', cwd: output, timeoutMs: 3_000 });
    await until(() => commands.length === 2 && (seen.get(commands[1].id) ?? '').includes('synthetic input:'), 'native stdin prompt did not appear');
    terminal.write(commands[1].id, 'synthetic-smoke-value\r');
    const privateResult = await privateRun;
    assert.equal(privateResult.ok, true, privateResult.text);
    assert.match(privateResult.text, /private interaction/);
    assert.doesNotMatch(privateResult.text, /synthetic-smoke-value|received:synthetic/);
    assert.ok((seen.get(commands[1].id) ?? '').includes('received:synthetic-smoke-value'), 'the actual PTY received and echoed the synthetic input');
    assert.equal(terminal.list().find((entry) => entry.id === commands[1].id)?.privateInput, true);
    assert.equal(commands.length, 2);

    const controller = new AbortController();
    const cancelled = terminal.runCommand({ command: 'printf "%s\\n" "$$" > parent.pid; sleep 30 & printf "%s\\n" "$!" > child.pid; wait', cwd: output, timeoutMs: 3_000, signal: controller.signal });
    await until(() => existsSync(join(output, 'child.pid')), 'cancellable subprocess did not start');
    const parent = Number(readFileSync(join(output, 'parent.pid'), 'utf8').trim());
    const child = Number(readFileSync(join(output, 'child.pid'), 'utf8').trim());
    assert.ok(parent > 0 && child > 0);
    controller.abort();
    const cancelledResult = await cancelled;
    assert.equal(cancelledResult.ok, false);
    assert.match(cancelledResult.text, /cancelled/);
    await until(() => !alive(parent) && !alive(child), 'cancellation did not stop Bash and its child');
    assert.equal(commands.length, 3, 'three requests produced exactly three terminals');
    assert.deepEqual(offsetErrors, [], 'stream offsets count every real native output character');
  } finally { terminal.shutdown(); }
}
