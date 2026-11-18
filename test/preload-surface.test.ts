import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Every `window.electronAPI.<namespace>.<method>` the renderer calls must exist in the preload.
 *
 * This is the seam, and nothing checked it. The renderer's `window.electronAPI` type is a hand
 * written `declare global` block, so it describes what the preload is *supposed* to expose; the
 * preload is a plain object literal. Nothing compares the two, and TypeScript cannot: the type
 * says the method is there, so every call site typechecks whatever the object actually contains.
 *
 * On 2026-11-17 adding the `whiteboard` namespace spliced it into the middle of `providers`,
 * which silently moved five live methods — `test`, `refresh`, `probe`, `storeInfo`, `readiness` —
 * onto `whiteboard`. `npm run typecheck` was clean, the whole suite passed, and the app crashed
 * the moment anything opened source settings. A brace in the wrong place deleted a fifth of the
 * provider API with no diagnostic anywhere.
 */

// The suite bundles to CJS and runs from the repo root, so `import.meta` is empty here.
const ROOT = process.cwd();

/** The namespaces and methods the preload actually exposes, read from the object literal. */
function exposedSurface(): Map<string, Set<string>> {
  const file = join(ROOT, 'src/preload/index.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const surface = new Map<string, Set<string>>();

  const nameOf = (property: ts.ObjectLiteralElementLike): string | null => {
    const name = property.name;
    if (!name) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    return null;
  };

  /** Unwraps `{...} satisfies T` / `as T`, which several namespaces use. */
  const literalOf = (node: ts.Expression): ts.ObjectLiteralExpression | null => {
    let current = node;
    while (ts.isSatisfiesExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    }
    return ts.isObjectLiteralExpression(current) ? current : null;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'exposeInMainWorld' &&
      node.arguments.length === 2
    ) {
      const root = literalOf(node.arguments[1]);
      assert.ok(root, 'the preload exposes something other than an object literal');
      const top = new Set<string>();
      for (const property of root.properties) {
        const name = nameOf(property);
        if (!name) continue;
        top.add(name);
        // A namespace is a property whose value is itself an object literal.
        const nested = ts.isPropertyAssignment(property) ? literalOf(property.initializer) : null;
        if (nested) {
          surface.set(name, new Set(nested.properties.map(nameOf).filter((value): value is string => value !== null)));
        }
      }
      surface.set('', top);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(surface.size > 1, 'found no exposed namespaces, so this test is checking nothing');
  return surface;
}

function rendererFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) found.push(path);
    }
  };
  walk(join(ROOT, 'renderer/src'));
  return found;
}

/** Call sites written out in full, optional chaining and all: `electronAPI.providers.storeInfo`. */
const CALL = /\belectronAPI\??\.\s*([A-Za-z_$][\w$]*)\??\.\s*([A-Za-z_$][\w$]*)/g;

test('every namespaced electronAPI method the renderer names is exposed by the preload', () => {
  const surface = exposedSurface();
  const missing: string[] = [];

  for (const file of rendererFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const [, namespace, method] of text.matchAll(CALL)) {
      const members = surface.get(namespace);
      // An unknown namespace is reported against the top level, which catches a renamed one too.
      if (!members) {
        if (!surface.get('')!.has(namespace)) missing.push(`${file.slice(ROOT.length + 1)}: electronAPI.${namespace}`);
        continue;
      }
      if (!members.has(method)) missing.push(`${file.slice(ROOT.length + 1)}: electronAPI.${namespace}.${method}`);
    }
  }

  assert.deepEqual(missing, [], `the renderer calls preload methods that do not exist:\n  ${missing.join('\n  ')}`);
});

test('the five provider methods a misplaced brace moved are on providers, not whiteboard', () => {
  // Named explicitly because this is the regression: the suite passed while they were gone, and a
  // generic surface check would also pass if a future edit moved them somewhere else plausible.
  const surface = exposedSurface();
  for (const method of ['test', 'refresh', 'probe', 'storeInfo', 'readiness']) {
    assert.ok(surface.get('providers')?.has(method), `providers.${method} is missing from the preload`);
  }
  assert.deepEqual([...(surface.get('whiteboard') ?? [])].sort(), ['edit', 'get']);
});
