/** electron-builder hook, before signing and AppImage/archive creation. */
const path = require('node:path');
module.exports = async function afterPack(context) {
  const { copyDoomResources, buildFeatureSdk } = await import('./lib/desktop-resources.mjs');
  const root = context.packager.projectDir;
  const runtime = process.env.ANTIMATTER_DOOM_RUNTIME;
  if (!runtime || !path.isAbsolute(runtime)) {
    throw new Error('Packaging requires ANTIMATTER_DOOM_RUNTIME pointing to the complete verified external runtime; run scripts/sync-doom-runtime.mjs --help.');
  }
  const resources = context.packager.getResourcesDir(context.appOutDir);
  copyDoomResources(root, runtime, path.join(resources, 'doom'));
  const { Arch } = require('builder-util');
  buildFeatureSdk(root, path.join(resources, 'sdk/features'), { platform: context.electronPlatformName, arch: Arch[context.arch] });
};
