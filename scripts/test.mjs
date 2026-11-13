import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'test');
const buildRoot = process.env.ANTIMATTER_TEST_BUILD_ROOT;
if (buildRoot) mkdirSync(resolve(buildRoot), { recursive: true });
const output = buildRoot ? mkdtempSync(join(resolve(buildRoot), 'unit-')) : join(root, `.test-dist-${process.pid}`);
const entries = readdirSync(source)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => join(source, name));

if (!entries.length) throw new Error('No test/*.test.ts files were found.');
mkdirSync(output, { recursive: true });

try {
  await build({
    entryPoints: entries,
    outdir: output,
    entryNames: '[name]',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    sourcemap: 'inline',
    logLevel: 'warning',
  });

  const tests = readdirSync(output)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join(output, name));
  for (const file of tests) {
    const code = await new Promise((resolveCode, reject) => {
      // Running each bundled entry directly keeps node:test's full assertion diagnostics visible.
      const child = spawn(process.execPath, [file], { cwd: root, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', (status) => resolveCode(status ?? 1));
    });
    if (code !== 0) process.exitCode = code;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
