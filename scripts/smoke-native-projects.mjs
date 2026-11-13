#!/usr/bin/env node
/** Explicit real-tool smoke: tiny Cargo and CMake templates, with build products outside source. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await fs.mkdtemp(path.join(process.env.ANTIMATTER_SMOKE_OUTPUT ?? os.tmpdir(), 'native-projects-'));
const bundle = path.join(output, 'native-projects.cjs');
await build({ entryPoints: [path.join(root, 'src/main/environment/nativeProjects.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
const native = createRequire(import.meta.url)(bundle);
for (const language of ['rust', 'cpp']) {
  const project = native.createNativeProject({ root: output, directory: language, name: `${language}_demo`, language });
  for (const action of ['check', 'build', 'test']) {
    const result = await native.buildNativeProject(project.root, path.join(output, 'cache'), { root: project.root, action, profile: 'debug' }, () => {});
    assert.equal(result.success, true, result.output);
    if (action === 'build') {
      const artifacts = result.artifacts.filter((artifact) => artifact.executable);
      assert.equal(artifacts.length, 1, JSON.stringify(result.artifacts));
      assert.match(execFileSync(artifacts[0].path, [], { encoding: 'utf8', timeout: 10_000 }), /Hello from/);
    }
    console.log(`${language} ${action} passed`);
  }
}
console.log(`Real compiler smoke passed. Artifacts: ${output}`);
