import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('Android QR permission does not require camera hardware for manual pairing', () => {
  const manifest = readFileSync(join(process.cwd(), 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /<uses-permission\s+android:name="android\.permission\.CAMERA"\s*\/>/);
  const features = [...manifest.matchAll(/<uses-feature\b[^>]*\/>/g)].map(([tag]) => ({
    name: tag.match(/android:name="([^"]+)"/)?.[1],
    required: tag.match(/android:required="([^"]+)"/)?.[1],
  }));
  for (const name of ['android.hardware.camera', 'android.hardware.camera.any', 'android.hardware.camera.autofocus']) {
    const declarations = features.filter((feature) => feature.name === name);
    assert.equal(declarations.length, 1, `${name} must be explicitly declared once`);
    assert.equal(declarations[0].required, 'false', `${name} must not filter manual-pairing devices`);
  }
});
