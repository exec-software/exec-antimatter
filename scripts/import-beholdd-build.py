#!/usr/bin/env python3
"""Import a reviewed public Beholdd build without regenerating tracked provenance.

The committed release pin, not a mutable release tag or successful CI result, is
the archive trust anchor. Only --work-dir is configurable; credentials and URL or
digest overrides are deliberately unnecessary. No downloaded executable runs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'https://github.com/exec-software/exec-beholdd'
REPO_NAME = 'exec-software/exec-beholdd'
WORKFLOW = '.github/workflows/public-release-build.yml'
SHA = re.compile(r'[0-9a-f]{64}')
COMMIT = re.compile(r'[0-9a-f]{40}')
LIMITS = {'memoryBytes': 3221225472, 'swapBytes': 0, 'cpus': 1.5,
          'pids': 1152, 'timeoutSeconds': 900, 'hostReserveBytes': 8589934592, 'blasThreads': 1}
STAGES = ['toolchain', 'fetch-python', 'install-python', 'python-tests', 'javascript-tests',
          'fetch', 'fetch-hag-library', 'rust-tests', 'feature-tests', 'build-cpu', 'verify-cpu', 'build-hag',
          'verify-hag', 'hag-library-tests', 'build-hag-library', 'verify-hag-library']
NETWORK_STAGES = {'fetch-python', 'fetch', 'fetch-hag-library'}
NUMPY_TEST_PIN = {
    'name': 'numpy', 'version': '2.4.6',
    'filename': 'numpy-2.4.6-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl',
    'url': 'https://files.pythonhosted.org/packages/99/60/14115e6364fa676c5397c2ad3004e527e9aa487abf5d0706ec81bbd08529/'
           'numpy-2.4.6-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl',
    'sha256': '90f9849678c75fe7afa2d348ac842c168b0a4d3d61919687216dfc547976d853',
    'bytes': 16645538,
}
# Source pin and qualification receipt are independently checked. NumPy is only
# a test dependency; its wheel and installed files must not enter the runtime archive.
NUMPY_PIN_SOURCE = {'sha256': 'b7a79e57501f96819f92e00ce221e3ec91149e44c6243fec3b619afb8b9278d3', 'bytes': 425}
ROOT_FILES = {'README.md', 'LICENSE', 'Cargo.lock', 'VERSION', 'config.example.yaml',
              'config.dev.example.yaml', 'config.hag.example.yaml'}
HAG_FILES = {'lib/libexec_hag.so', 'lib/libexec_hag.a', 'include/exec_hag.h',
             'LICENSE', 'Cargo.lock', 'VERSION', 'provenance.json', 'thirdparty.md', 'receipt.json'}
HAG_UPSTREAM_FILES = {'src/linux/probe_packets.rs', 'src/linux/compute/packets.rs',
                      'src/linux/uapi.rs', 'src/linux/submission_uapi.rs', 'thirdparty.md', 'provenance.json'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f'duplicate JSON key: {key}')
        result[key] = value
    return result


def document(data):
    return json.loads(data, object_pairs_hook=unique_object)


def canonical_path(name):
    require(isinstance(name, str) and 0 < len(name) < 512 and
            not any(ord(char) < 32 for char in name) and '\\' not in name,
            'unsafe archive path')
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts and str(path) == name and name != '.',
            'unsafe archive path')
    return name


def verify_record(data, record, name):
    require(isinstance(record, dict) and isinstance(record.get('sha256'), str)
            and SHA.fullmatch(record['sha256']) and type(record.get('bytes')) is int,
            f'invalid file record: {name}')
    require(len(data) == record['bytes'] and sha(data) == record['sha256'], f'file digest mismatch: {name}')


def validate_config(config, dependencies):
    require(config.get('schemaVersion') == 1 and config.get('repository') == REPOSITORY,
            'build pin must identify the canonical public Beholdd repository')
    tag = config.get('tag')
    require(isinstance(tag, str) and re.fullmatch(r'v[1-9][0-9]*', tag), 'invalid build release tag')
    require(config.get('archiveName') == f'beholdd-{tag}-linux-x86_64-build.tar.gz', 'invalid archive name')
    require(isinstance(config.get('sourceCommit'), str) and COMMIT.fullmatch(config['sourceCommit'])
            and isinstance(config.get('archiveSha256'), str) and SHA.fullmatch(config['archiveSha256'])
            and type(config.get('workflowRunId')) is int and config['workflowRunId'] > 0,
            'reviewed releases/beholdd-build.json is incomplete; pin the verified public build before dispatch')
    require(config.get('workflowPath') == WORKFLOW, 'unexpected Beholdd build workflow')
    selected = [item for item in dependencies['dependencies'] if item['name'] in ('beholdd', 'beholdd-hag')]
    require({item['name'] for item in selected} == {'beholdd', 'beholdd-hag'} and len(selected) == 2,
            'both native backends must be declared exactly once')
    require(all(item.get('sourceCommit') == config['sourceCommit'] and item.get('repository') == REPOSITORY
                for item in selected), 'build pin differs from scripts/deps.json')


def validate_run(run, config):
    require(run.get('id') == config['workflowRunId'] and run.get('head_sha') == config['sourceCommit']
            and run.get('status') == 'completed' and run.get('conclusion') == 'success'
            and run.get('event') == 'workflow_dispatch' and run.get('path') == WORKFLOW
            and run.get('repository', {}).get('full_name') == REPO_NAME
            and run.get('head_repository', {}).get('full_name') == REPO_NAME,
            'public CI run does not match the reviewed source/workflow/success receipt')


def safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and not parsed.username and not parsed.password
            and parsed.port in (None, 443) and parsed.hostname in {
                'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'},
            'download redirected outside the allowed HTTPS hosts')


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        safe_url(new_url)
        return super().redirect_request(request, fp, code, message, headers, new_url)


def download(url, destination, maximum):
    safe_url(url)
    request = urllib.request.Request(url, headers={'User-Agent': 'Antimatter-reviewed-release-build',
                                                  'Accept': 'application/vnd.github+json' if urllib.parse.urlsplit(url).hostname == 'api.github.com'
                                                  else 'application/octet-stream'})
    digest = hashlib.sha256()
    total = 0
    deadline = time.monotonic() + 300
    with urllib.request.build_opener(SafeRedirect).open(request, timeout=30) as response:
        safe_url(response.url)
        with destination.open('xb') as output:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                require(total <= maximum and time.monotonic() < deadline, 'download size or time limit exceeded')
                digest.update(chunk)
                output.write(chunk)
    return digest.hexdigest()


def read_archive(path):
    """Read bounded regular files, never extract paths or follow archive links."""
    files, directories, seen = {}, set(), set()
    total = 0
    with tarfile.open(path, 'r|gz') as archive:
        for member in archive:
            name = canonical_path(member.name)
            require(name not in seen and len(seen) < 8192, 'duplicate or excessive archive members')
            seen.add(name)
            require(member.uid == 0 and member.gid == 0 and member.uname == '' and member.gname == ''
                    and not member.issparse(), 'archive metadata is not normalized')
            require(member.isfile() or member.isdir(), 'archive links and special files are forbidden')
            expected_mode = 0o755 if member.isdir() or name in ('cpu/bin/beholdd', 'hag/bin/beholdd') else 0o644
            require(member.mode == expected_mode, 'archive mode is not normalized')
            if member.isdir():
                directories.add(name)
                continue
            require(0 <= member.size <= 128 * 1024**2, 'archive member is too large')
            total += member.size
            require(total <= 512 * 1024**2, 'archive exceeds expanded size limit')
            with archive.extractfile(member) as source:
                files[name] = source.read(member.size + 1)
            require(len(files[name]) == member.size, 'truncated archive member')
    require(all(any(name.startswith(directory + '/') for name in files) for directory in directories),
            'unexpected empty archive directory')
    require(not any(parent in files for name in files for parent in map(str, PurePosixPath(name).parents)),
            'archive file used as a directory')
    return files


def validate_licenses(files, prefix):
    inventory_name = prefix + '/licenses/inventory.json'
    inventory = document(files[inventory_name])
    require(isinstance(inventory, list) and inventory, 'missing component license inventory')
    allowed = {inventory_name}
    for package in inventory:
        require(isinstance(package.get('license'), str) and package['license'], 'missing license declaration')
        expected = f'{package["name"]}-{package["version"]}/'
        require(package.get('notices'), 'missing dependency notice')
        for notice in package['notices']:
            relative = canonical_path(notice['file'])
            require(relative.startswith(expected) and len(PurePosixPath(relative).parts) == 2,
                    'license path does not match its package')
            name = prefix + '/licenses/' + relative
            require(name not in allowed and sha(files[name]) == notice.get('sha256'), 'invalid dependency notice')
            allowed.add(name)
    return allowed


def validate_runtime_notices(files, manifest, source_files):
    runtime = manifest['toolchain']['rustRuntimeNotices']
    require(runtime.get('rustc') == manifest['toolchain']['rustc'] and runtime.get('origin') ==
            'Unmodified notices from the digest-pinned Rust builder image.', 'runtime notices do not identify the qualified compiler')
    records = runtime.get('files', [])
    require(isinstance(records, list) and records, 'missing Rust runtime notices')
    names = [record.get('file') for record in records]
    require(len(set(names)) == len(names) and all(isinstance(name, str) and re.fullmatch(
        r'(?:COPYRIGHT-library\.html|COPYRIGHT\.html|COPYRIGHT|LICENSE[A-Za-z0-9._-]*)', name) for name in names),
        'unexpected or duplicate Rust runtime notice name')
    require((runtime.get('scope') == 'standard-library' and 'COPYRIGHT-library.html' in names)
            or (runtime.get('scope') == 'full-distribution' and bool(set(names) & {'COPYRIGHT', 'COPYRIGHT.html'})),
            'runtime copyright notice does not match its declared scope')
    allowed = set()
    for component in ('cpu', 'hag', 'hag-library'):
        prefix = component + '/licenses/rust-standard-library/'
        provenance = prefix + 'provenance.json'
        require(document(files[provenance]) == runtime and files[provenance] == files['cpu/licenses/rust-standard-library/provenance.json'],
                'runtime notice provenance differs between components')
        allowed.add(provenance)
        for record in records:
            require(record.get('source') == 'share/doc/rust/' + record['file'], 'unexpected compiler notice source')
            name = prefix + record['file']
            verify_record(files[name], record, name)
            allowed.add(name)
    template_sources = {'README.md': 'crates/beholdd-server/src/templates/README.md', 'LICENSE-APACHE-2.0': 'LICENSE'}
    for component in ('cpu', 'hag'):
        for basename, source in template_sources.items():
            name = component + '/licenses/chat-templates/' + basename
            verify_record(files[name], source_files[source], name)
            require(files[name] == files['cpu/licenses/chat-templates/' + basename], 'template notices differ between components')
            allowed.add(name)
    return allowed


def validate_hag_library(files, manifest, source_files):
    receipt = document(files['hag-library/receipt.json'])
    provenance = document(files['hag-library/provenance.json'])
    source = provenance.get('source', {})
    require(provenance.get('schema_version') == 1 and provenance.get('package') == 'exec-hag'
            and source.get('repository') == 'https://github.com/exec-software/exec-hag'
            and source.get('dirty') is False and COMMIT.fullmatch(source.get('revision', '')),
            'invalid standalone HAG source provenance')
    source_records = {name.removeprefix('vendor/exec-hag/'): record for name, record in source_files.items()
                      if name.startswith('vendor/exec-hag/') and name != 'vendor/exec-hag/provenance.json'}
    require(set(provenance.get('files', {})) == set(source_records), 'HAG provenance omits or invents source files')
    for name, record in source_records.items():
        require(provenance['files'][name] == {key: record[key] for key in ('sha256', 'bytes')},
                'HAG source provenance differs from the qualified source inventory')
    for name in ('include/exec_hag.h', 'LICENSE', 'Cargo.lock', 'VERSION', 'provenance.json', 'thirdparty.md'):
        verify_record(files['hag-library/' + name], source_files['vendor/exec-hag/' + name], 'HAG source ' + name)
    require(receipt == manifest.get('hagLibrary') and receipt.get('source') == source
            and receipt.get('cargoFeatures') == ['capi']
            and receipt.get('version') == files['hag-library/VERSION'].decode().strip()
            and re.fullmatch(r'v[1-9][0-9]*', receipt.get('version', ''))
            and receipt.get('cargoLockSha256') == sha(files['hag-library/Cargo.lock'])
            and receipt.get('headerSha256') == sha(files['hag-library/include/exec_hag.h'])
            and receipt.get('cDynamicAndStaticLinkSmoke') == 'passed',
            'standalone HAG library qualification does not match its source/header')
    require(set(receipt.get('files', {})) == {'lib/libexec_hag.so', 'lib/libexec_hag.a'},
            'standalone HAG library receipt has an unexpected binary set')
    for name, record in receipt['files'].items():
        data = files['hag-library/' + name]
        verify_record(data, record, 'HAG ' + name)
        require(b'/home/' not in data, 'standalone HAG library contains an unremapped home path')
    shared = files['hag-library/lib/libexec_hag.so']
    require(len(shared) >= 64 and shared[:6] == b'\x7fELF\x02\x01' and shared[16:20] == b'\x03\x00\x3e\x00'
            and files['hag-library/lib/libexec_hag.a'].startswith(b'!<arch>\n'),
            'standalone HAG libraries are not an x86_64 shared ELF and static archive')
    versions = receipt.get('requiredGlibcVersions', [])
    require(versions and all(re.fullmatch(r'\d+\.\d+(?:\.\d+)?', item)
            and tuple(map(int, item.split('.'))) <= (2, 34) for item in versions),
            'standalone HAG library glibc floor exceeds 2.34')
    allowed = {'hag-library/' + name for name in HAG_FILES} | validate_licenses(files, 'hag-library')
    for component in ('hag', 'hag-library'):
        for relative in HAG_UPSTREAM_FILES:
            name = component + '/licenses/hag-upstream/' + relative
            verify_record(files[name], source_files['vendor/exec-hag/' + relative], name)
            require(files[name] == files['hag-library/licenses/hag-upstream/' + relative],
                    'HAG upstream notices differ between components')
            allowed.add(name)
    return allowed


def validate_archive(files, config):
    records = document(files['files.json'])
    require(set(records) == set(files) - {'files.json'}, 'archive inventory has missing or unlisted files')
    for name, record in records.items():
        canonical_path(name)
        verify_record(files[name], record, name)
    manifest = document(files['manifest.json'])
    source = manifest['source']
    require(manifest.get('schemaVersion') == 1 and source.get('repository') == REPOSITORY
            and source.get('commit') == config['sourceCommit'] and source.get('dirty') is False
            and source.get('version') == config['tag'] and COMMIT.fullmatch(source.get('tree', '')),
            'archive provenance differs from reviewed build pin')
    require(sha(files['Cargo.lock']) == source.get('cargoLockSha256')
            and sha(files['source-files.json']) == source.get('inventorySha256')
            and files['VERSION'].decode().strip() == config['tag'], 'source inventory or version mismatch')
    source_files = document(files['source-files.json'])
    for name in source_files:
        canonical_path(name)
    source_assets = ROOT_FILES | {name for name in source_files if name.startswith('docs/')}
    for name in source_assets:
        verify_record(files[name], source_files[name], name)
    require(manifest.get('containerLimits') == LIMITS, 'build container limits differ from reviewed contract')
    require(manifest.get('dockerfileSha256') == source_files['tools/release/Dockerfile']['sha256'],
            'container recipe differs from source inventory')
    images = manifest.get('builderImages', [])
    require(len(images) == 3 and all(re.fullmatch(r'[a-z0-9:.-]+@sha256:[0-9a-f]{64}', image) for image in images),
            'builder images are not digest-pinned')
    stages = manifest['stages']
    require([stage.get('name') for stage in stages] == STAGES, 'missing or unexpected build qualification stage')
    for stage in stages:
        require(stage.get('exitCode') == 0 and stage.get('oomKilled') is False
                and stage.get('network') is (stage['name'] in NETWORK_STAGES)
                and stage.get('hostAvailableBytes', 0) >= LIMITS['memoryBytes'] + LIMITS['hostReserveBytes']
                and SHA.fullmatch(stage.get('logSha256', '')), 'build stage did not satisfy qualification bounds')
    toolchain = manifest.get('toolchain', {})
    require(toolchain.get('glibc') == 'glibc 2.31' and toolchain.get('rustc', '').startswith('rustc 1.98.0 ')
            and toolchain.get('python') == 'Python 3.12.10' and toolchain.get('node') == 'v22.20.0',
            'unexpected release builder toolchain')
    require(manifest.get('testDependencies') == {'numpy': NUMPY_TEST_PIN}
            and all(source_files.get('tools/release/python-wheel.json', {}).get(key) == value
                    for key, value in NUMPY_PIN_SOURCE.items()),
            'NumPy test dependency receipt or source pin differs from the reviewed wheel')
    require(manifest.get('rustPathRemapping') == [
        '--remap-path-prefix=/source=/usr/src/beholdd', '--remap-path-prefix=/work=/usr/src/beholdd-build',
        '--remap-path-prefix=/usr/local/cargo=/usr/src/cargo',
        '--remap-path-prefix=/usr/local/rustup=/usr/src/rust-toolchain'], 'missing path remapping')
    allowed = source_assets | {'files.json', 'manifest.json', 'source-files.json'}
    allowed |= validate_runtime_notices(files, manifest, source_files)
    for component, features in [('cpu', []), ('hag', ['hag-native'])]:
        receipt_name = f'{component}/receipt.json'
        binary_name = f'{component}/bin/beholdd'
        receipt = document(files[receipt_name])
        require(receipt == manifest['components'].get(component) and receipt.get('cargoFeatures') == features
                and receipt.get('emptyRegistryHttpSmoke') == 'passed'
                and receipt.get('binary', {}).get('path') == binary_name, 'invalid backend build receipt')
        verify_record(files[binary_name], receipt['binary'], binary_name)
        require(files[binary_name].startswith(b'\x7fELF') and b'/home/' not in files[binary_name],
                'backend is not ELF or contains an unremapped home path')
        versions = receipt.get('requiredGlibcVersions', [])
        require(versions and all(re.fullmatch(r'\d+\.\d+(?:\.\d+)?', item)
                and tuple(map(int, item.split('.'))) <= (2, 34) for item in versions), 'backend glibc floor exceeds 2.34')
        allowed |= {receipt_name, binary_name} | validate_licenses(files, component)
    allowed |= validate_hag_library(files, manifest, source_files)
    require(set(files) == allowed, 'archive contains files outside the reviewed allowlist')
    return manifest


def validate_project_notices(root, files):
    """Copies shipped by Electron and the standalone bundle must be exact and complete."""
    for destination, source in [('beholdd-runtime', 'cpu/licenses/rust-standard-library/'),
                                ('chat-templates', 'cpu/licenses/chat-templates/'),
                                ('hag-upstream', 'hag/licenses/hag-upstream/')]:
        directory = root / 'releases/licenses' / destination
        require(directory.is_dir() and not directory.is_symlink(), f'missing tracked {destination} notice directory')
        actual = {}
        for path in directory.rglob('*'):
            require(not path.is_symlink(), 'tracked notice tree cannot contain symlinks')
            if path.is_dir():
                continue
            require(path.is_file(), 'tracked notice tree cannot contain special files')
            actual[str(path.relative_to(directory))] = path.read_bytes()
        expected = {name.removeprefix(source): data for name, data in files.items() if name.startswith(source)}
        require(actual == expected, f'tracked {destination} notices differ from the qualified compiler/source archive')


def planned_payloads(root, files, config):
    """Validate every byte against existing tracked manifests before any mutation."""
    validate_project_notices(root, files)
    source_files = document(files['source-files.json'])
    licenses = document(files['hag/licenses/inventory.json'])
    hag_notice = [notice['file'] for package in licenses if package['name'] == 'exec-hag'
                  for notice in package['notices'] if notice['file'].endswith('/LICENSE')]
    require(len(hag_notice) == 1, 'expected one HAG MIT license')
    license_bytes = files['hag/licenses/' + hag_notice[0]]
    verify_record(license_bytes, source_files['vendor/exec-hag/LICENSE'], 'HAG source license')
    mappings = {
        'beholdd': {'bin/beholdd': files['cpu/bin/beholdd'],
                    'share/config.example.yaml': files['config.example.yaml'], 'share/serving.md': files['docs/serving.md']},
        'beholdd-hag': {'bin/beholdd': files['hag/bin/beholdd'],
                        'share/config.example.yaml': files['config.example.yaml'], 'share/serving.md': files['docs/serving.md'],
                        'share/HAG_LICENSE.txt': license_bytes, 'model.json': (root / 'releases/hag-model.json').read_bytes()},
    }
    for name, payload in mappings.items():
        manifest_path = root / 'vendor' / name / 'manifest.json'
        require(not manifest_path.is_symlink(), 'vendor manifest cannot be a symlink')
        data = manifest_path.read_bytes()
        manifest = document(data)
        require(manifest.get('schemaVersion') == 1 and manifest.get('name') == name
                and manifest.get('source') == REPOSITORY and manifest.get('commit') == config['sourceCommit']
                and manifest.get('dirty') is False
                and manifest.get('cargoFeatures', []) == ([] if name == 'beholdd' else ['hag-native']),
                'tracked vendor provenance does not match the reviewed build')
        artifacts = manifest.get('artifacts', [])
        require(len(artifacts) == len(payload) and {item['path'] for item in artifacts} == set(payload),
                'tracked vendor manifest does not cover the exact payload')
        for artifact in artifacts:
            require(artifact.get('type') == 'file', 'vendor artifacts must be regular files')
            verify_record(payload[artifact['path']], artifact, name + '/' + artifact['path'])
        payload['manifest.json'] = data
    return mappings


def install_payloads(root, payloads):
    vendor = root / 'vendor'
    require(vendor.is_dir() and not vendor.is_symlink(), 'vendor must be a real directory')
    for name in payloads:
        target = vendor / name
        require(target.is_dir() and not target.is_symlink(), 'vendor backend must be a real directory')
    temporary = Path(tempfile.mkdtemp(prefix='.beholdd-import-', dir=vendor))
    swapped = []
    try:
        for name, files in payloads.items():
            for relative, data in files.items():
                target = temporary / name / canonical_path(relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                target.chmod(0o755 if relative == 'bin/beholdd' else 0o644)
        for name in payloads:
            destination, backup = vendor / name, temporary / (name + '-previous')
            destination.rename(backup)
            try:
                (temporary / name).rename(destination)
            except BaseException:
                backup.rename(destination)
                raise
            swapped.append((destination, backup))
    except BaseException:
        for destination, backup in reversed(swapped):
            shutil.rmtree(destination)
            backup.rename(destination)
        raise
    finally:
        shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-dir', type=Path, required=True, help='new external directory for downloaded evidence')
    args = parser.parse_args()
    config = document((ROOT / 'releases/beholdd-build.json').read_bytes())
    validate_config(config, document((ROOT / 'scripts/deps.json').read_bytes()))
    work = args.work_dir.absolute()
    require(not work.exists() and not work.resolve().is_relative_to(ROOT), 'work directory must be new and outside the repository')
    work.mkdir(parents=True, mode=0o700)
    run_file = work / 'workflow-run.json'
    download(f'https://api.github.com/repos/{REPO_NAME}/actions/runs/{config["workflowRunId"]}', run_file, 2 * 1024**2)
    validate_run(document(run_file.read_bytes()), config)
    archive = work / config['archiveName']
    digest = download(f'{REPOSITORY}/releases/download/{config["tag"]}/{config["archiveName"]}', archive, 256 * 1024**2)
    require(digest == config['archiveSha256'], 'downloaded archive differs from the committed SHA-256 pin')
    files = read_archive(archive)
    manifest = validate_archive(files, config)
    payloads = planned_payloads(ROOT, files, config)
    install_payloads(ROOT, payloads)
    (work / 'verified-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Verified public Beholdd CPU/HAG payloads imported; tracked manifests were preserved byte-for-byte.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f'Beholdd import refused: {error}', file=sys.stderr)
        sys.exit(1)
