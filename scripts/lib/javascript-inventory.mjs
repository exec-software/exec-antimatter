import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

export const JAVASCRIPT_INVENTORY_FILES = Object.freeze({
  sbom: 'JAVASCRIPT_SBOM.cdx.json',
  manifest: 'JAVASCRIPT_LICENSES.manifest.json',
  bundle: 'JAVASCRIPT_LICENSES.txt',
});
const PATH_PROPERTY = 'cdx:npm:package:path';
const MAX_TEXT_BYTES = 32 * 1024 ** 2;
const NOTICE_NAME = /^(?:licen[cs]e|copying|notice|copyright|authors)(?:[._-].*)?$/i;
const PACKAGE_PATH = /^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const json = (data) => Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
const requireCondition = (condition, message) => { if (!condition) throw new Error(`JavaScript inventory: ${message}`); };
const capture = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 ** 2, ...options,
}).trim();

function regular(root, relative) {
  requireCondition(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') &&
    !path.posix.isAbsolute(relative) && relative.split('/').every((part) => part && part !== '.' && part !== '..'),
  'unsafe relative file path');
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    requireCondition(!stat.isSymbolicLink() && (index === parts.length - 1 ? stat.isFile() : stat.isDirectory()),
      `nonregular source entry: ${relative}`);
  }
  return current;
}

function read(root, relative) {
  const file = regular(root, relative);
  requireCondition(fs.statSync(file).size <= MAX_TEXT_BYTES, `oversized text input: ${relative}`);
  return fs.readFileSync(file);
}

function digestFile(file) {
  const digest = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let count; (count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) digest.update(buffer.subarray(0, count));
  } finally { fs.closeSync(descriptor); }
  return digest.digest('hex');
}

const fileRecord = (root, relative) => {
  const file = regular(root, relative);
  return { file: relative, bytes: fs.statSync(file).size, sha256: digestFile(file) };
};
const declaredLicense = (pkg) => typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;

function sourceIdentity(root, runCommand) {
  const packageBytes = read(root, 'package.json');
  const lockBytes = read(root, 'package-lock.json');
  const pkg = JSON.parse(packageBytes);
  const lock = JSON.parse(lockBytes);
  requireCondition(lock.lockfileVersion >= 2 && lock.packages?.[''], 'a modern package lock is required');
  requireCondition(lock.name === pkg.name && lock.version === pkg.version &&
    lock.packages[''].name === pkg.name && lock.packages[''].version === pkg.version, 'package and lock identities differ');
  const commit = runCommand('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
  requireCondition(/^[a-f0-9]{40,64}$/.test(commit), 'invalid source commit');
  return { pkg, lock, source: { commit, name: pkg.name, version: pkg.version,
    packageJsonSha256: sha(packageBytes), packageLockSha256: sha(lockBytes) } };
}

function licenseFiles(root, packagePath) {
  const found = [];
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const name = `${relative}/${entry.name}`;
      requireCondition(!entry.isSymbolicLink(), `symlink inside dependency: ${name}`);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && NOTICE_NAME.test(entry.name)) {
        const contents = read(root, name);
        new TextDecoder('utf-8', { fatal: true }).decode(contents);
        found.push({ path: name.slice(packagePath.length + 1), contents });
      }
    }
  };
  visit(packagePath);
  requireCondition(found.length > 0, `missing license/notice text for ${packagePath}`);
  return found;
}

function loadArchive(root, payloadRoot, suppliedAsar) {
  const archivePath = regular(payloadRoot, 'resources/app.asar');
  const asar = suppliedAsar ?? createRequire(path.join(root, 'package.json'))('@electron/asar');
  const names = new Set(asar.listPackage(archivePath).map((name) => name.replace(/^\//, '')));
  const unpacked = new Map();
  const extract = (relative) => {
    requireCondition(names.has(relative), `packaged file missing: ${relative}`);
    const stat = asar.statFile(archivePath, relative, false);
    requireCondition(!stat.link && !stat.files && Number.isSafeInteger(stat.size) && stat.size <= MAX_TEXT_BYTES,
      `unsafe packaged text: ${relative}`);
    if (stat.unpacked) {
      const file = `resources/app.asar.unpacked/${relative}`;
      unpacked.set(file, fileRecord(payloadRoot, file));
    }
    return asar.extractFile(archivePath, relative, false);
  };
  return { names, extract, unpacked, record: fileRecord(payloadRoot, 'resources/app.asar') };
}

/** Inventory the actual installed production graph and the resulting Electron payload.
 * npm's --omit=dev selector can omit dependencies shared by build/runtime trees; filter the
 * full actual-tree report using the lock's production flags and verify all packaged packages.
 */
export function writeJavaScriptInventory({ root, payloadRoot, outputDirectory, runCommand = capture, asar }) {
  const { pkg, lock, source } = sourceIdentity(root, runCommand);
  const raw = JSON.parse(runCommand('npm', ['sbom', '--sbom-format=cyclonedx', '--sbom-type=application', '--workspaces=false'], {
    cwd: root, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
  }));
  requireCondition(raw.bomFormat === 'CycloneDX' && raw.specVersion === '1.5' && Array.isArray(raw.components) &&
    Array.isArray(raw.dependencies), 'unsupported npm SBOM');
  const selected = [];
  const groups = new Map();
  const seenPaths = new Set();
  const chunks = [Buffer.from('Antimatter JavaScript and Electron license/notice corpus\n\n' +
    'Declared package metadata and exact supplied notice text; this inventory is not a legal compatibility opinion.\n' +
    'Native backends, fonts and Android retain separate inventories.\n')];
  let bundleBytes = chunks[0].length;
  const appendLicense = (component, file, contents) => {
    const heading = Buffer.from(`\n\n===== ${component}: ${file} =====\n`);
    chunks.push(heading, contents);
    const item = { file, bytes: contents.length, sha256: sha(contents), bundleOffset: bundleBytes + heading.length };
    bundleBytes += heading.length + contents.length;
    return item;
  };
  for (const component of raw.components) {
    const location = component.properties?.find((item) => item.name === PATH_PROPERTY)?.value;
    requireCondition(typeof location === 'string' && PACKAGE_PATH.test(location), 'invalid installed dependency location');
    const locked = lock.packages[location];
    requireCondition(locked && !locked.link, `unlocked or linked installed dependency: ${location}`);
    if (locked.dev === true) continue;
    requireCondition(!seenPaths.has(location), `duplicate installed dependency: ${location}`);
    seenPaths.add(location);
    const packageBytes = read(root, `${location}/package.json`);
    const installed = JSON.parse(packageBytes);
    requireCondition(installed.name === component.name && installed.version === component.version &&
      installed.version === locked.version, `installed dependency differs from lock: ${location}`);
    const integrityTokens = typeof locked.integrity === 'string' ? locked.integrity.split(/\s+/) : [];
    requireCondition(integrityTokens.some((token) => {
      const match = token.match(/^sha(256|384|512)-([a-z0-9+/]+=*)$/i);
      return match && component.hashes?.some((hash) => hash.alg === `SHA-${match[1]}` &&
        hash.content === Buffer.from(match[2], 'base64').toString('hex'));
    }), `installed integrity metadata differs from lock: ${location}`);
    const license = declaredLicense(installed);
    requireCondition(typeof license === 'string' && license.length <= 256 && /^[a-z0-9+(). -]+$/i.test(license) &&
      Array.isArray(component.licenses) && component.licenses.length > 0, `unreviewed license declaration: ${location}`);
    requireCondition(!locked.license || locked.license === license, `license metadata differs from lock: ${location}`);
    const ref = `${installed.name}@${installed.version}`;
    requireCondition(component['bom-ref'] === ref && /^[a-z0-9@/_.-]+$/i.test(installed.name) &&
      /^[a-z0-9.+-]+$/i.test(installed.version), `invalid package identity: ${location}`);
    const notices = licenseFiles(root, location).map(({ path: file, contents }) => appendLicense(ref, file, contents));
    const record = { ref, name: installed.name, version: installed.version, installedPath: location,
      optional: locked.optional === true || locked.devOptional === true, license,
      packageJsonSha256: sha(packageBytes), integrity: locked.integrity ?? null, licenseFiles: notices, packagedPaths: [] };
    selected.push(record);
    const existing = groups.get(ref);
    if (existing) {
      const noticeIdentity = (items) => items.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }));
      requireCondition(existing.license === license && existing.integrity === record.integrity &&
        JSON.stringify(noticeIdentity(existing.licenseFiles)) === JSON.stringify(noticeIdentity(notices)),
        `ambiguous duplicate package identity: ${ref}`);
      existing.locations.push(location);
    } else groups.set(ref, { ...record, locations: [location],
      purl: `pkg:npm/${encodeURIComponent(installed.name).replace('%2F', '/')}@${installed.version}`, licenses: component.licenses });
  }
  requireCondition(selected.length > 0, 'empty installed production graph');
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || entry.dev || entry.optional || entry.devOptional) continue;
    requireCondition(seenPaths.has(location), `required locked dependency absent from actual graph: ${location}`);
  }
  const archive = loadArchive(root, payloadRoot, asar);
  const packagedApp = JSON.parse(archive.extract('package.json'));
  requireCondition(packagedApp.name === pkg.name && packagedApp.version === pkg.version, 'packaged application identity differs');
  const packaged = [];
  for (const name of [...archive.names].sort()) {
    if (!name.endsWith('/package.json')) continue;
    const location = name.slice(0, -'/package.json'.length);
    if (!PACKAGE_PATH.test(location)) continue;
    const contents = archive.extract(name);
    const metadata = JSON.parse(contents);
    const ref = `${metadata.name}@${metadata.version}`;
    const expected = groups.get(ref);
    requireCondition(expected && declaredLicense(metadata) === expected.license, `unlisted or changed packaged dependency: ${location}`);
    const copies = selected.filter((item) => item.ref === ref);
    for (const copy of copies) copy.packagedPaths.push(location);
    const notices = [];
    // Verify every notice retained in the payload against the corresponding installed input.
    for (const notice of expected.licenseFiles) {
      const name = `${location}/${notice.file}`;
      if (!archive.names.has(name)) continue;
      const bytes = archive.extract(name);
      requireCondition(sha(bytes) === notice.sha256, `packaged notice changed: ${name}`);
      notices.push({ file: name, bytes: bytes.length, sha256: sha(bytes) });
    }
    requireCondition(notices.length > 0, `packaged dependency has no retained license text: ${location}`);
    packaged.push({ ref, path: location, packageJsonSha256: sha(contents), licenseFiles: notices });
  }
  requireCondition(packaged.length > 0, 'payload has no production package inventory');
  const electron = JSON.parse(read(root, 'node_modules/electron/package.json'));
  const lockedElectron = lock.packages['node_modules/electron'];
  requireCondition(electron.name === 'electron' && electron.version === pkg.devDependencies?.electron &&
    electron.version === lockedElectron?.version && read(root, 'node_modules/electron/dist/version').toString().trim() === electron.version,
  'Electron distribution differs from package/lock pin');
  const executable = pkg.build?.linux?.executableName ?? pkg.name;
  requireCondition(typeof executable === 'string' && /^[a-z0-9._-]+$/i.test(executable), 'invalid executable name');
  const executableRecord = fileRecord(payloadRoot, executable);
  requireCondition(executableRecord.sha256 === digestFile(regular(root, 'node_modules/electron/dist/electron')),
    'packaged Electron executable differs from installed distribution');
  const electronNotices = [];
  for (const [sourcePath, packagedPath] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    const contents = read(payloadRoot, packagedPath);
    requireCondition(contents.equals(read(root, `node_modules/electron/dist/${sourcePath}`)), `Electron notice changed: ${packagedPath}`);
    electronNotices.push(appendLicense(`electron@${electron.version}`, packagedPath, contents));
  }
  const electronRef = `electron@${electron.version}`;
  const rootRef = `${pkg.name}@${pkg.version}`;
  const includedRefs = new Set([...groups.keys(), rootRef]);
  const edges = new Map([...includedRefs].map((ref) => [ref, new Set()]));
  for (const entry of raw.dependencies) {
    if (!includedRefs.has(entry.ref)) continue;
    for (const dependency of entry.dependsOn ?? []) if (includedRefs.has(dependency)) edges.get(entry.ref).add(dependency);
  }
  edges.get(rootRef).add(electronRef);
  edges.set(electronRef, new Set());
  const sbom = { $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json', bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { lifecycles: [{ phase: 'build' }], tools: raw.metadata?.tools?.map(({ vendor, name, version }) => ({ vendor, name, version })),
      component: { type: 'application', 'bom-ref': rootRef, name: pkg.name, version: pkg.version,
        licenses: [{ license: { id: 'MIT' } }], properties: [{ name: 'antimatter:source:commit', value: source.commit },
          { name: 'antimatter:source:lock:sha256', value: source.packageLockSha256 }] } },
    components: [...groups.entries()].map(([ref, item]) => ({ type: 'library', 'bom-ref': ref, name: item.name, version: item.version,
      purl: item.purl, licenses: item.licenses, properties: item.locations.sort().map((value) => ({ name: PATH_PROPERTY, value })) }))
      .concat([{ type: 'framework', 'bom-ref': electronRef, name: 'electron', version: electron.version,
        purl: `pkg:npm/electron@${electron.version}`, licenses: [{ license: { id: 'MIT' } }],
        properties: [{ name: 'antimatter:runtime:executable:sha256', value: executableRecord.sha256 },
          { name: 'antimatter:runtime:chromium-notices:sha256', value: electronNotices[1].sha256 }] }])
      .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
    dependencies: [...edges].map(([ref, dependencies]) => ({ ref, dependsOn: [...dependencies].sort() })).sort((a, b) => a.ref.localeCompare(b.ref)) };
  const sbomBytes = json(sbom);
  const bundle = Buffer.concat(chunks);
  const artifacts = { sbom: { file: JAVASCRIPT_INVENTORY_FILES.sbom, bytes: sbomBytes.length, sha256: sha(sbomBytes) },
    bundle: { file: JAVASCRIPT_INVENTORY_FILES.bundle, bytes: bundle.length, sha256: sha(bundle) } };
  const manifest = { schemaVersion: 1, scope: 'Installed locked production JavaScript graph, packaged ASAR dependencies, and Electron runtime. Native backends, fonts and Android have separate inventories.',
    source, artifacts, packages: selected.sort((a, b) => a.installedPath.localeCompare(b.installedPath)),
    packaged: { archive: archive.record, unpackedFiles: [...archive.unpacked.values()], packages: packaged },
    electron: { version: electron.version, executable: executableRecord, licenseFiles: electronNotices } };
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [name, contents] of [[JAVASCRIPT_INVENTORY_FILES.sbom, sbomBytes], [JAVASCRIPT_INVENTORY_FILES.bundle, bundle], [JAVASCRIPT_INVENTORY_FILES.manifest, json(manifest)]]) {
    fs.writeFileSync(path.join(outputDirectory, name), contents, { flag: 'wx', mode: 0o644 });
  }
  return validateJavaScriptInventory({ root, payloadRoot, outputDirectory, runCommand });
}

/** Publisher-side validation needs source/lock and the three sealed files, not node_modules. */
export function validateJavaScriptInventory({ root, payloadRoot, outputDirectory, runCommand = capture }) {
  const { source, lock, pkg } = sourceIdentity(root, runCommand);
  const manifest = JSON.parse(read(outputDirectory, JAVASCRIPT_INVENTORY_FILES.manifest));
  requireCondition(manifest.schemaVersion === 1 && JSON.stringify(manifest.source) === JSON.stringify(source), 'inventory source/package/lock identity differs');
  const contents = {};
  for (const name of ['sbom', 'bundle']) {
    const expected = manifest.artifacts?.[name];
    requireCondition(expected?.file === JAVASCRIPT_INVENTORY_FILES[name], 'invalid inventory artifact name');
    contents[name] = read(outputDirectory, expected.file);
    requireCondition(expected.bytes === contents[name].length && expected.sha256 === sha(contents[name]), `inventory artifact changed: ${expected.file}`);
  }
  const sbom = JSON.parse(contents.sbom);
  const refs = new Set([sbom.metadata?.component?.['bom-ref'], ...sbom.components?.map((component) => component['bom-ref']) ?? []]);
  requireCondition(sbom.bomFormat === 'CycloneDX' && sbom.specVersion === '1.5' &&
    refs.size === sbom.components.length + 1 && refs.has(`${pkg.name}@${pkg.version}`), 'invalid or duplicate SBOM identities');
  for (const edge of sbom.dependencies ?? []) requireCondition(refs.has(edge.ref) && edge.dependsOn.every((ref) => refs.has(ref)), 'dangling SBOM dependency');
  requireCondition(Array.isArray(manifest.packages) && manifest.packages.length > 0, 'empty license inventory');
  const locations = new Set();
  const checkNotices = (notices) => {
    requireCondition(Array.isArray(notices) && notices.length > 0, 'missing notice inventory');
    for (const notice of notices) {
      requireCondition(Number.isSafeInteger(notice.bundleOffset) && notice.bundleOffset >= 0 && Number.isSafeInteger(notice.bytes) &&
        notice.bytes > 0 && notice.bundleOffset + notice.bytes <= contents.bundle.length &&
        sha(contents.bundle.subarray(notice.bundleOffset, notice.bundleOffset + notice.bytes)) === notice.sha256,
      'license text differs from recorded corpus');
    }
  };
  for (const entry of manifest.packages) {
    const locked = lock.packages[entry.installedPath];
    requireCondition(PACKAGE_PATH.test(entry.installedPath) && !locations.has(entry.installedPath) && locked && !locked.dev &&
      locked.version === entry.version && locked.integrity === entry.integrity &&
      entry.ref === `${entry.name}@${entry.version}` && (!locked.license || locked.license === entry.license) && refs.has(entry.ref),
    'license inventory differs from production lock');
    locations.add(entry.installedPath);
    checkNotices(entry.licenseFiles);
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location && !entry.dev && !entry.optional && !entry.devOptional) requireCondition(locations.has(location), `required package omitted: ${location}`);
  }
  requireCondition(manifest.electron?.version === pkg.devDependencies?.electron &&
    manifest.electron.version === lock.packages['node_modules/electron']?.version && refs.has(`electron@${manifest.electron.version}`), 'Electron inventory pin differs');
  checkNotices(manifest.electron.licenseFiles);
  if (payloadRoot) {
    for (const record of [manifest.packaged.archive, manifest.electron.executable, ...manifest.packaged.unpackedFiles]) {
      const actual = fileRecord(payloadRoot, record.file);
      requireCondition(actual.bytes === record.bytes && actual.sha256 === record.sha256, `payload changed after inventory: ${record.file}`);
    }
    for (const record of manifest.electron.licenseFiles) requireCondition(fileRecord(payloadRoot, record.file).sha256 === record.sha256, `Electron notice changed: ${record.file}`);
  }
  return { ...manifest.artifacts, manifest: fileRecord(outputDirectory, JAVASCRIPT_INVENTORY_FILES.manifest),
    packages: manifest.packages.length, packagedPackages: manifest.packaged.packages.length, sourceCommit: source.commit };
}
