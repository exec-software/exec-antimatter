#!/usr/bin/env node

/**
 * Fail closed when the tracked Linux release contract drifts.
 *
 * The installer intentionally embeds the identities of the small support files and the model.
 * Keeping this check separate from assembly makes those duplicated values reviewable while still
 * ensuring a maintainer cannot accidentally publish an installer with stale hashes or filenames.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseChannel, rollingPackageVersion } from './lib/release-version.mjs';
import { androidReleaseIdentity } from './lib/android-release.mjs';
import { readDoomLock } from './lib/desktop-resources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASES = path.join(ROOT, 'releases');
const LINUX = path.join(RELEASES, 'linux-x86_64');
const INSTALLER_PATH = path.join(LINUX, 'install.sh');
const UNINSTALLER_PATH = path.join(LINUX, 'uninstall.sh');
const MODEL_MANIFEST_PATH = path.join(RELEASES, 'model-manifest.json');
const APACHE_LICENSE_PATH = path.join(RELEASES, 'licenses', 'Apache-2.0.txt');
const LLAMA_CPP_LICENSE_PATH = path.join(RELEASES, 'licenses', 'llama.cpp', 'LICENSE');
const GRADLE_WRAPPER_JAR_PATH = path.join(ROOT, 'android', 'gradle', 'wrapper', 'gradle-wrapper.jar');
const GRADLE_WRAPPER_PROPERTIES_PATH = path.join(ROOT, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');

const read = (file) => fs.readFileSync(file, 'utf8');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const assertEqual = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label} is out of sync (expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)})`);
  }
};

const packageJson = JSON.parse(read(path.join(ROOT, 'package.json')));
assertEqual(packageJson.build?.afterPack, 'scripts/after-pack.cjs', 'desktop resources packaging hook');
readDoomLock(ROOT);
for (const source of ['README.md', 'CMakeLists.txt', 'antimatter_features.c', 'antimatter_features.h', 'antimatter_features.matrix']) {
  assert(fs.lstatSync(path.join(ROOT, 'sdk/features', source)).isFile(), `Feature SDK source missing: ${source}`);
}
const releaseVersion = read(path.join(ROOT, 'VERSION')).trim();
assert(rollingPackageVersion(releaseVersion), 'VERSION must be an Execute rolling version such as v2');
assertEqual(packageJson.releaseVersion, releaseVersion, 'package releaseVersion');
assertEqual(packageJson.version, rollingPackageVersion(releaseVersion), 'package compatibility version');
const model = JSON.parse(read(MODEL_MANIFEST_PATH));
const installer = read(INSTALLER_PATH);
const uninstaller = read(UNINSTALLER_PATH);
const androidBuild = read(path.join(ROOT, 'android', 'app', 'build.gradle.kts'));
const androidReadme = read(path.join(ROOT, 'android', 'README.md'));
const androidManifest = read(path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'));
const gradleWrapperProperties = read(GRADLE_WRAPPER_PROPERTIES_PATH);

assertEqual(
  sha256(APACHE_LICENSE_PATH),
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  'canonical Apache-2.0 license text'
);
assertEqual(
  sha256(LLAMA_CPP_LICENSE_PATH),
  '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
  'pinned llama.cpp MIT license text'
);
assertEqual(
  sha256(GRADLE_WRAPPER_JAR_PATH),
  '497c8c2a7e5031f6aa847f88104aa80a93532ec32ee17bdb8d1d2f67a194a9c7',
  'pinned Gradle 9.6.0 wrapper JAR'
);
assert(
  gradleWrapperProperties.includes(
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-9.6.0-bin.zip\n'
  ),
  'Gradle wrapper must use the pinned 9.6.0 binary distribution'
);
assert(
  gradleWrapperProperties.includes(
    'distributionSha256Sum=bbaeb2fef8710818cf0e261201dab964c572f92b942812df0c3620d62a529a01\n'
  ),
  'Gradle wrapper must verify the pinned 9.6.0 distribution checksum'
);

const bashLiteral = (source, name) => {
  const match = source.match(new RegExp(`^readonly ${name}='([^'\\n]*)'$`, 'm'));
  if (!match) throw new Error(`install.sh must define ${name} as a single-quoted readonly literal`);
  return match[1];
};

const bashInteger = (source, name) => {
  const match = source.match(new RegExp(`^readonly ${name}=([0-9]+)$`, 'm'));
  if (!match) throw new Error(`install.sh must define ${name} as a readonly integer literal`);
  return Number(match[1]);
};

assert(releaseChannel(packageJson.version), 'package version must be stable or numbered-alpha semver');
const androidVersionName = androidBuild.match(/^\s*versionName = "([^"]+)"$/m)?.[1];
const androidVersionCode = Number(androidBuild.match(/^\s*versionCode = (\d+)$/m)?.[1]);
const androidApplicationId = androidBuild.match(/^\s*applicationId = "([^"]+)"$/m)?.[1];
assertEqual(androidVersionName, packageJson.version, 'Android versionName');
assert(Number.isSafeInteger(androidVersionCode) && androidVersionCode > 0, 'Android versionCode must be a positive integer');
assertEqual(androidApplicationId, packageJson.build?.appId, 'Android applicationId');
androidReleaseIdentity(ROOT);
const androidSigningPolicy = JSON.parse(read(path.join(RELEASES, 'android-signing.json')));
const androidCertificate = new X509Certificate(read(path.join(RELEASES, 'android-release-certificate.pem')));
assertEqual(androidCertificate.fingerprint256.replaceAll(':', '').toLowerCase(), androidSigningPolicy.certificateSha256, 'Android production signing certificate');
assert(
  androidReadme.includes(`\`${packageJson.version}\``),
  `android/README.md does not name package version ${packageJson.version}`
);
assert(
  !androidManifest.includes('android:scheme="antimatter"') &&
    !androidManifest.includes('android.intent.category.BROWSABLE'),
  'Android must not export the one-time pairing secret through a custom-scheme/deep-link handler'
);
assertEqual(bashLiteral(installer, 'VERSION'), packageJson.version, 'installer VERSION');
assertEqual(bashLiteral(installer, 'PLATFORM'), 'linux-x86_64', 'installer PLATFORM');
assertEqual(bashLiteral(installer, 'APP_ID'), packageJson.build?.appId, 'installer APP_ID');
assertEqual(packageJson.build?.directories?.output, 'releases/dist', 'electron-builder output directory');
assertEqual(packageJson.build?.linux?.executableName, 'antimatter', 'Linux executable name');
assertEqual(
  packageJson.build?.linux?.artifactName,
  'Antimatter-${version}-linux-x86_64.${ext}',
  'Linux artifact name'
);
assertEqual(packageJson.devDependencies?.electron, '44.10.2', 'pinned Electron version');

const repository = packageJson.repository?.url?.replace(/\.git$/, '');
assertEqual(repository, 'https://github.com/exec-software/exec-antimatter', 'release repository');
const repositorySlug = new URL(repository).pathname.replace(/^\//, '');
assertEqual(bashLiteral(installer, 'RELEASE_REPOSITORY'), repositorySlug, 'installer release repository');
assert(installer.includes('gh release download "$RELEASE_TAG"'), 'installer lacks authenticated release download support');

const modelMappings = [
  ['MODEL_ID', model.id],
  ['MODEL_REPOSITORY', model.source?.repository],
  ['MODEL_REVISION', model.source?.revision],
  ['MODEL_FILENAME', model.source?.filename],
  ['MODEL_SHA256', model.sha256],
];
for (const [constant, expected] of modelMappings) {
  assertEqual(bashLiteral(installer, constant), expected, `installer ${constant}`);
}
assertEqual(bashInteger(installer, 'MODEL_BYTES'), model.bytes, 'installer MODEL_BYTES');
assertEqual(model.source?.provider, 'Hugging Face', 'model source provider');
assertEqual(model.installRelativePath, `models/${model.id}/${model.source.filename}`, 'model install path');
assert(
  installer.includes(`printf -v quoted_llama_vulkan_model '%q' "$model_file"\n`),
  'installer must shell-quote the installed default model path for the generated launcher'
);
assert(
  installer.includes(
    `  printf 'export ANTIMATTER_LLAMA_VULKAN_MODEL=%s\\n' "$quoted_llama_vulkan_model"\n`
  ),
  'generated launcher must export ANTIMATTER_LLAMA_VULKAN_MODEL'
);
assert(/^https:\/\/huggingface\.co\//.test(model.source?.url ?? ''), 'model URL must use Hugging Face HTTPS');
assert(model.source.url.includes(`/${model.source.revision}/`), 'model URL must contain its pinned revision');
assert(model.source.url.endsWith(`/${model.source.filename}?download=true`), 'model URL filename does not match');
assert(/^[0-9a-f]{64}$/.test(model.sha256 ?? ''), 'model SHA-256 must be a lowercase 64-character digest');

const support = [
  ['CONFIG_TEMPLATE_NAME', 'CONFIG_TEMPLATE_SHA256', 'beholdd.streaming.yaml'],
  ['ICON_NAME', 'ICON_SHA256', 'co.antimatter.app.svg'],
  ['UNINSTALLER_NAME', 'UNINSTALLER_SHA256', 'uninstall.sh'],
];
for (const [nameConstant, hashConstant, expectedName] of support) {
  assertEqual(bashLiteral(installer, nameConstant), expectedName, `installer ${nameConstant}`);
  assertEqual(
    bashLiteral(installer, hashConstant),
    sha256(path.join(LINUX, expectedName)),
    `installer ${hashConstant}`
  );
}

const configTemplate = read(path.join(LINUX, 'beholdd.streaming.yaml'));
assertEqual(model.configTemplate, 'linux-x86_64/beholdd.streaming.yaml', 'model config template');
assertEqual(
  (configTemplate.match(/^    path: '@MODEL_PATH@'$/gm) ?? []).length,
  1,
  'streaming template model placeholder count'
);
assert(configTemplate.includes(`  - id: ${model.id}\n`), 'streaming template model id does not match');
assert(configTemplate.includes('    allow_unsafe_storage: false\n'), 'streaming template must disable unsafe storage');

for (const [file, source] of [
  [INSTALLER_PATH, installer],
  [UNINSTALLER_PATH, uninstaller],
]) {
  assert((fs.statSync(file).mode & 0o111) !== 0, `${path.basename(file)} must be executable`);
  assert(source.includes('Managed by the Antimatter user-local installer.'), `${path.basename(file)} lacks its marker`);
}
execFileSync('bash', ['-n', INSTALLER_PATH, UNINSTALLER_PATH], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-beholdd-licenses.mjs'), '--check'], {
  cwd: ROOT,
  stdio: 'inherit',
});

execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-beholdd-licenses.mjs'), '--component', 'beholdd-hag', '--check'], {
  cwd: ROOT,
  stdio: 'inherit',
});
const hagModel = JSON.parse(read(path.join(RELEASES, 'hag-model.json')));
assertEqual(hagModel.schemaVersion, 1, 'HAG model schema');
assertEqual(hagModel.architecture, 'qwen3', 'HAG model architecture');
assertEqual(hagModel.quantization, 'Q8_0', 'HAG model quantization');
assertEqual(hagModel.bytes, 639447744, 'qualified HAG model size');
assertEqual(hagModel.sha256, 'e150ed544dfe6016930c026a93913a5e3184181ebfe6ab2223ae01dd0491784c', 'qualified HAG model SHA-256');
assert(/^[0-9a-f]{40}$/.test(hagModel.source.revision), 'HAG model must use an exact upstream revision');
assertEqual(hagModel.source.url,
  `https://huggingface.co/${hagModel.source.repository}/resolve/${hagModel.source.revision}/${hagModel.filename}`,
  'HAG model pinned download URL');
assertEqual(hagModel.source.filename, hagModel.filename, 'HAG model filename');

const releaseAnchor = `Current release: **${releaseVersion}** (compatibility package ${packageJson.version}).`;
for (const name of ['README.md', 'releases/README.md', 'android/README.md']) {
  assert(read(path.join(ROOT, name)).split('\n').filter((line) => line === releaseAnchor).length === 1,
    `${name} must contain one current release anchor: ${releaseAnchor}`);
}
assert(read(path.join(RELEASES, 'RELEASE_NOTES.md')).split('\n')[0] === `# Antimatter ${releaseVersion}`,
  `release notes must open with # Antimatter ${releaseVersion}`);

console.log(`verified Linux and Android release inputs for Antimatter ${releaseVersion} (compatibility ${packageJson.version})`);
