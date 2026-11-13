#!/usr/bin/env node
/** Exercise the shipped language adapter against an explicitly selected, real clangd. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

if (process.argv.includes('--help')) {
  console.log('ANTIMATTER_CLANGD=/path/to/clangd ANTIMATTER_SMOKE_OUTPUT=/external/build/tests node scripts/smoke-native-language.mjs\nOptional LD_LIBRARY_PATH is inherited. No compiler or background index is started.');
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.ANTIMATTER_SMOKE_OUTPUT;
const clangd = process.env.ANTIMATTER_CLANGD;
if (!output || !isAbsolute(output) || !clangd || !isAbsolute(clangd)) {
  throw new Error('Set absolute ANTIMATTER_SMOKE_OUTPUT and ANTIMATTER_CLANGD; see --help.');
}
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(output, 'native-language-'));
const project = join(scratch, 'project');
mkdirSync(project);
const bundle = join(scratch, 'language.cjs');
await build({ entryPoints: [join(root, 'src/main/environment/nativeLanguageServer.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
const { NativeLanguageServices } = createRequire(import.meta.url)(bundle);
const source = 'struct Counter { int count; };\nint helper() { return 7; }\nint main() { Counter counter; counter.count = helper(); return counter.count; }\n';
writeFileSync(join(project, 'main.cpp'), source);
const language = new NativeLanguageServices(project, join(scratch, 'cache'), { tools: { cargo: null, rustc: null, cmake: null, ctest: null, cpp: null, debugger: null, rustAnalyzer: null, clangd }, diagnosticTimeoutMs: 10000, requestTimeoutMs: 15000 });
try {
  const diagnostics = await language.diagnostics({ path: 'main.cpp', text: source });
  assert.deepEqual(diagnostics, []);
  const text = source.replace('counter.count =', 'counter. =');
  const completion = await language.completion({ path: 'main.cpp', text, line: 2, character: text.split('\n')[2].indexOf('counter.') + 8 });
  assert.ok(completion.some((item) => item.label.includes('count')), 'real member completion');
  const character = source.split('\n')[2].indexOf('helper') + 2;
  const hover = await language.hover({ path: 'main.cpp', text: source, line: 2, character });
  assert.match(JSON.stringify(hover), /helper/);
  const definition = await language.definition({ path: 'main.cpp', text: source, line: 2, character });
  assert.ok(definition.some((item) => item.path === 'main.cpp' && item.range.start.line === 1));
  const broken = source.replace('return 7;', 'return missing_identifier;');
  assert.ok((await language.diagnostics({ path: 'main.cpp', text: broken })).some((item) => item.message.includes('missing_identifier')));
  assert.deepEqual(await language.diagnostics({ path: 'main.cpp', text: source }), [], 'fixed unsaved overlay clears the diagnostic');
  assert.deepEqual(await language.diagnostics({ path: 'other.c', text: 'int main(void) { return 0; }\n' }), [], 'C source uses its own fallback standard');
  await language.restart();
  assert.match(JSON.stringify(await language.hover({ path: 'main.cpp', text: source, line: 2, character })), /helper/);
  console.log(`Real clangd completion, hover, definition, live diagnostics and restart passed: ${scratch}`);
} finally {
  language.dispose();
}
