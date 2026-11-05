"""Trust and archive-boundary regressions; no network or downloaded code runs."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('import_beholdd', Path(__file__).resolve().parents[1] / 'scripts/import-beholdd-build.py')
IMPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORT)


def encoded(value):
    return (json.dumps(value) + '\n').encode()


def record(data):
    return {'sha256': IMPORT.sha(data), 'bytes': len(data)}


def fixture():
    config = {'schemaVersion': 1, 'repository': IMPORT.REPOSITORY, 'tag': 'v5', 'sourceCommit': 'a' * 40,
              'archiveName': 'beholdd-v5-linux-x86_64-build.tar.gz', 'archiveSha256': 'f' * 64,
              'workflowRunId': 123, 'workflowPath': IMPORT.WORKFLOW}
    deps = {'dependencies': [{'name': name, 'sourceCommit': config['sourceCommit'], 'repository': IMPORT.REPOSITORY}
                             for name in ['beholdd', 'beholdd-hag']]}
    run = {'id': 123, 'head_sha': config['sourceCommit'], 'status': 'completed', 'conclusion': 'success',
           'event': 'workflow_dispatch', 'path': IMPORT.WORKFLOW,
           'repository': {'full_name': IMPORT.REPO_NAME}, 'head_repository': {'full_name': IMPORT.REPO_NAME}}
    files = {name: (name + '\n').encode() for name in IMPORT.ROOT_FILES | {'docs/serving.md'}}
    files['VERSION'] = b'v5\n'
    source = {name: record(data) for name, data in files.items()}
    source['tools/release/Dockerfile'] = record(b'reviewed dockerfile')
    source['tools/release/python-wheel.json'] = {**IMPORT.NUMPY_PIN_SOURCE, 'executable': False}
    hag_source = {name: (name + '\n').encode() for name in IMPORT.HAG_UPSTREAM_FILES - {'provenance.json'}}
    hag_source.update({'LICENSE': b'MIT license fixture', 'Cargo.lock': b'HAG Cargo lock fixture\n',
                       'VERSION': b'v2\n', 'include/exec_hag.h': b'HAG C header fixture\n'})
    hag_provenance = {'schema_version': 1, 'package': 'exec-hag',
                      'source': {'repository': 'https://github.com/exec-software/exec-hag', 'revision': 'e' * 40, 'dirty': False},
                      'files': {name: record(data) for name, data in hag_source.items()}}
    hag_source['provenance.json'] = encoded(hag_provenance)
    source.update({'vendor/exec-hag/' + name: {**record(data), 'executable': False} for name, data in hag_source.items()})
    source['crates/beholdd-server/src/templates/README.md'] = record(b'Chat template attribution fixture\n')
    files['source-files.json'] = encoded(source)
    manifest = {
        'schemaVersion': 1,
        'source': {'repository': IMPORT.REPOSITORY, 'commit': config['sourceCommit'], 'tree': 'b' * 40,
                   'dirty': False, 'version': 'v5', 'cargoLockSha256': IMPORT.sha(files['Cargo.lock']),
                   'inventorySha256': IMPORT.sha(files['source-files.json'])},
        'containerLimits': IMPORT.LIMITS,
        'dockerfileSha256': source['tools/release/Dockerfile']['sha256'],
        'builderImages': ['node@sha256:' + 'c' * 64] * 3,
        'stages': [{'name': name, 'exitCode': 0, 'oomKilled': False,
                    'network': name in IMPORT.NETWORK_STAGES, 'logSha256': 'd' * 64,
                    'hostAvailableBytes': IMPORT.LIMITS['memoryBytes'] + IMPORT.LIMITS['hostReserveBytes']}
                   for name in IMPORT.STAGES],
        'toolchain': {'glibc': 'glibc 2.31', 'rustc': 'rustc 1.98.0 (test)', 'python': 'Python 3.12.10', 'node': 'v22.20.0'},
        'testDependencies': {'numpy': dict(IMPORT.NUMPY_TEST_PIN)},
        'rustPathRemapping': ['--remap-path-prefix=/source=/usr/src/beholdd', '--remap-path-prefix=/work=/usr/src/beholdd-build',
                             '--remap-path-prefix=/usr/local/cargo=/usr/src/cargo',
                             '--remap-path-prefix=/usr/local/rustup=/usr/src/rust-toolchain'],
        'components': {},
    }
    for component, features in [('cpu', []), ('hag', ['hag-native'])]:
        binary_name = f'{component}/bin/beholdd'
        files[binary_name] = b'\x7fELF' + component.encode()
        receipt = {'cargoFeatures': features, 'binary': {'path': binary_name, **record(files[binary_name])},
                   'emptyRegistryHttpSmoke': 'passed', 'requiredGlibcVersions': ['2.31']}
        manifest['components'][component] = receipt
        files[f'{component}/receipt.json'] = encoded(receipt)
    for name in IMPORT.HAG_FILES - {'lib/libexec_hag.so', 'lib/libexec_hag.a', 'receipt.json'}:
        files['hag-library/' + name] = hag_source[name]
    shared_header = bytearray(64)
    shared_header[:6] = b'\x7fELF\x02\x01'
    shared_header[16:20] = b'\x03\x00\x3e\x00'
    files['hag-library/lib/libexec_hag.so'] = bytes(shared_header) + b'shared fixture'
    files['hag-library/lib/libexec_hag.a'] = b'!<arch>\nstatic fixture'
    manifest['hagLibrary'] = {'cDynamicAndStaticLinkSmoke': 'passed', 'source': hag_provenance['source'],
                              'cargoFeatures': ['capi'], 'version': 'v2',
                              'cargoLockSha256': IMPORT.sha(hag_source['Cargo.lock']),
                              'headerSha256': IMPORT.sha(hag_source['include/exec_hag.h']),
                              'requiredGlibcVersions': ['2.31'],
                              'files': {name: record(files['hag-library/' + name]) for name in ['lib/libexec_hag.so', 'lib/libexec_hag.a']}}
    files['hag-library/receipt.json'] = encoded(manifest['hagLibrary'])
    for component in ['hag', 'hag-library']:
        for name in IMPORT.HAG_UPSTREAM_FILES:
            files[component + '/licenses/hag-upstream/' + name] = hag_source[name]
    for component in ['cpu', 'hag', 'hag-library']:
        relative = 'exec-hag-0.1.0/LICENSE'
        files[component + '/licenses/' + relative] = b'MIT license fixture'
        files[component + '/licenses/inventory.json'] = encoded([
            {'name': 'exec-hag', 'version': '0.1.0', 'license': 'MIT', 'notices': [
                {'file': relative, 'sha256': IMPORT.sha(b'MIT license fixture')}]}])
    runtime_bytes = b'Rust standard-library copyright fixture\n'
    runtime = {'scope': 'standard-library', 'rustc': manifest['toolchain']['rustc'],
               'files': [{'file': 'COPYRIGHT-library.html', 'source': 'share/doc/rust/COPYRIGHT-library.html', **record(runtime_bytes)}],
               'origin': 'Unmodified notices from the digest-pinned Rust builder image.'}
    manifest['toolchain']['rustRuntimeNotices'] = runtime
    for component in ['cpu', 'hag', 'hag-library']:
        files[component + '/licenses/rust-standard-library/COPYRIGHT-library.html'] = runtime_bytes
        files[component + '/licenses/rust-standard-library/provenance.json'] = encoded(runtime)
    for component in ['cpu', 'hag']:
        files[component + '/licenses/chat-templates/README.md'] = b'Chat template attribution fixture\n'
        files[component + '/licenses/chat-templates/LICENSE-APACHE-2.0'] = files['LICENSE']
    files['manifest.json'] = encoded(manifest)
    reseal(files)
    return config, deps, run, files


def reseal(files):
    files['files.json'] = encoded({name: record(data) for name, data in files.items() if name != 'files.json'})


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.config, self.deps, self.run, self.files = fixture()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, entries=None):
        path = self.root / 'build.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data, kind in entries or [(name, data, tarfile.REGTYPE) for name, data in self.files.items()]:
                entry = tarfile.TarInfo(name)
                entry.mode = 0o755 if name in ('cpu/bin/beholdd', 'hag/bin/beholdd') else 0o644
                entry.type = kind
                entry.linkname = '../../outside' if kind == tarfile.SYMTYPE else ''
                entry.size = len(data) if kind == tarfile.REGTYPE else 0
                archive.addfile(entry, io.BytesIO(data) if entry.size else None)
        return path

    def prepare_vendor(self):
        (self.root / 'releases').mkdir()
        (self.root / 'releases/hag-model.json').write_bytes(b'{"model":"fixture"}\n')
        for destination, prefix in [('beholdd-runtime', 'cpu/licenses/rust-standard-library/'),
                                    ('chat-templates', 'cpu/licenses/chat-templates/'),
                                    ('hag-upstream', 'hag/licenses/hag-upstream/')]:
            directory = self.root / 'releases/licenses' / destination
            directory.mkdir(parents=True)
            for name, data in self.files.items():
                if name.startswith(prefix):
                    target = directory / name.removeprefix(prefix)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
        for name, component in [('beholdd', 'cpu'), ('beholdd-hag', 'hag')]:
            payload = {'bin/beholdd': self.files[f'{component}/bin/beholdd'],
                       'share/config.example.yaml': self.files['config.example.yaml'],
                       'share/serving.md': self.files['docs/serving.md']}
            if component == 'hag':
                payload.update({'share/HAG_LICENSE.txt': b'MIT license fixture', 'model.json': b'{"model":"fixture"}\n'})
            target = self.root / 'vendor' / name
            target.mkdir(parents=True)
            (target / 'manifest.json').write_bytes(encoded({
                'schemaVersion': 1, 'name': name, 'source': IMPORT.REPOSITORY, 'commit': self.config['sourceCommit'],
                'dirty': False, 'cargoFeatures': [] if component == 'cpu' else ['hag-native'],
                'artifacts': [{'path': path, 'type': 'file', **record(data)} for path, data in payload.items()]}))
            (target / 'old-unmanifested-file').write_text('old payload replaced only after validation')

    def test_accepts_complete_reviewed_archive_and_preserves_manifests(self):
        IMPORT.validate_config(self.config, self.deps)
        IMPORT.validate_run(self.run, self.config)
        files = IMPORT.read_archive(self.archive())
        IMPORT.validate_archive(files, self.config)
        self.prepare_vendor()
        original = {name: (self.root / 'vendor' / name / 'manifest.json').read_bytes() for name in ['beholdd', 'beholdd-hag']}
        payloads = IMPORT.planned_payloads(self.root, files, self.config)
        IMPORT.install_payloads(self.root, payloads)
        for name in original:
            self.assertEqual((self.root / 'vendor' / name / 'manifest.json').read_bytes(), original[name])
            self.assertFalse((self.root / 'vendor' / name / 'old-unmanifested-file').exists())
            self.assertEqual((self.root / 'vendor' / name / 'bin/beholdd').stat().st_mode & 0o777, 0o755)

    def test_incomplete_pin_or_different_dependency_is_refused(self):
        for field in ['sourceCommit', 'archiveSha256', 'workflowRunId']:
            config = {**self.config, field: None}
            with self.subTest(field=field), self.assertRaises(ValueError):
                IMPORT.validate_config(config, self.deps)
        self.deps['dependencies'][1]['sourceCommit'] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'deps.json'):
            IMPORT.validate_config(self.config, self.deps)

    def test_wrong_source_run_or_workflow_cannot_qualify(self):
        for field, value in [('head_sha', '0' * 40), ('conclusion', 'failure'), ('status', 'in_progress'),
                             ('event', 'pull_request'), ('path', '.github/workflows/other.yml'),
                             ('head_repository', {'full_name': 'unrelated/fork'})]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                IMPORT.validate_run({**self.run, field: value}, self.config)

    def test_unsafe_archive_entries_never_extract(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE),
                           ('cpu/../outside', tarfile.REGTYPE), ('cpu//outside', tarfile.REGTYPE),
                           ('cpu\\outside', tarfile.REGTYPE), ('cpu/link', tarfile.SYMTYPE),
                           ('cpu/device', tarfile.CHRTYPE), ('cpu/hardlink', tarfile.LNKTYPE)]:
            with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                IMPORT.read_archive(self.archive([(name, b'bad', kind)]))

    def test_duplicate_archive_or_json_names_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            IMPORT.read_archive(self.archive([('same', b'a', tarfile.REGTYPE), ('same', b'b', tarfile.REGTYPE)]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            IMPORT.document(b'{"source":1,"source":2}')

    def test_archive_digest_allowlist_and_source_are_independent_gates(self):
        changed = copy.deepcopy(self.files)
        changed['cpu/bin/beholdd'] += b'tampered'
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            IMPORT.validate_archive(changed, self.config)
        changed = copy.deepcopy(self.files)
        changed['cpu/extra-launcher'] = b'executable'
        reseal(changed)
        with self.assertRaisesRegex(ValueError, 'allowlist'):
            IMPORT.validate_archive(changed, self.config)
        with self.assertRaisesRegex(ValueError, 'provenance'):
            IMPORT.validate_archive(self.files, {**self.config, 'sourceCommit': '0' * 40})

    def test_failed_stage_or_relaxed_limits_cannot_qualify(self):
        for mutation in ['limits', 'blasThreads', 'oom', 'network', 'missing', 'python-order']:
            changed = copy.deepcopy(self.files)
            manifest = IMPORT.document(changed['manifest.json'])
            if mutation == 'limits':
                manifest['containerLimits']['swapBytes'] = 1
            elif mutation == 'blasThreads':
                manifest['containerLimits']['blasThreads'] = 8
            elif mutation == 'oom':
                manifest['stages'][3]['oomKilled'] = True
            elif mutation == 'network':
                manifest['stages'][3]['network'] = True
            elif mutation == 'python-order':
                manifest['stages'][2], manifest['stages'][3] = manifest['stages'][3], manifest['stages'][2]
            else:
                manifest['stages'].pop()
            changed['manifest.json'] = encoded(manifest)
            reseal(changed)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                IMPORT.validate_archive(changed, self.config)

    def test_numpy_test_receipt_cannot_substitute_a_wheel_or_ship_test_runtime(self):
        for field, value in [('version', '2.4.5'), ('sha256', '0' * 64), ('bytes', 1),
                             ('url', 'https://example.com/numpy.whl')]:
            changed = copy.deepcopy(self.files)
            manifest = IMPORT.document(changed['manifest.json'])
            manifest['testDependencies']['numpy'][field] = value
            changed['manifest.json'] = encoded(manifest)
            reseal(changed)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'NumPy test dependency'):
                IMPORT.validate_archive(changed, self.config)
        changed = copy.deepcopy(self.files)
        changed['cpu/python-deps/numpy/__init__.py'] = b'not a runtime dependency'
        reseal(changed)
        with self.assertRaisesRegex(ValueError, 'allowlist'):
            IMPORT.validate_archive(changed, self.config)

    def test_numpy_pin_must_be_present_in_the_committed_source_inventory(self):
        changed = copy.deepcopy(self.files)
        source = IMPORT.document(changed['source-files.json'])
        source['tools/release/python-wheel.json']['sha256'] = '0' * 64
        changed['source-files.json'] = encoded(source)
        manifest = IMPORT.document(changed['manifest.json'])
        manifest['source']['inventorySha256'] = IMPORT.sha(changed['source-files.json'])
        changed['manifest.json'] = encoded(manifest)
        reseal(changed)
        with self.assertRaisesRegex(ValueError, 'NumPy test dependency'):
            IMPORT.validate_archive(changed, self.config)

    def test_mismatched_vendor_provenance_never_changes_existing_payload(self):
        self.prepare_vendor()
        manifest = self.root / 'vendor/beholdd-hag/manifest.json'
        original = manifest.read_bytes()
        changed = IMPORT.document(original)
        changed['artifacts'][0]['sha256'] = '0' * 64
        manifest.write_bytes(encoded(changed))
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            IMPORT.planned_payloads(self.root, self.files, self.config)
        self.assertTrue((self.root / 'vendor/beholdd/old-unmanifested-file').is_file())
        self.assertFalse((self.root / 'vendor/beholdd/bin/beholdd').exists())

    def test_runtime_and_template_notices_are_bound_to_compiler_and_source(self):
        for name in ['hag/licenses/rust-standard-library/COPYRIGHT-library.html',
                     'hag/licenses/chat-templates/README.md']:
            changed = copy.deepcopy(self.files)
            changed[name] += b'changed'
            reseal(changed)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'digest mismatch'):
                IMPORT.validate_archive(changed, self.config)
        changed = copy.deepcopy(self.files)
        provenance = IMPORT.document(changed['cpu/licenses/rust-standard-library/provenance.json'])
        provenance['rustc'] = 'another compiler'
        changed['cpu/licenses/rust-standard-library/provenance.json'] = encoded(provenance)
        reseal(changed)
        with self.assertRaisesRegex(ValueError, 'provenance'):
            IMPORT.validate_archive(changed, self.config)

    def test_hag_upstream_notices_are_complete_and_bound_to_public_source(self):
        name = 'hag/licenses/hag-upstream/src/linux/probe_packets.rs'
        changed = copy.deepcopy(self.files)
        changed[name] += b'tampered notice'
        reseal(changed)
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            IMPORT.validate_archive(changed, self.config)
        changed = copy.deepcopy(self.files)
        del changed[name]
        reseal(changed)
        with self.assertRaises(KeyError):
            IMPORT.validate_archive(changed, self.config)
        self.prepare_vendor()
        (self.root / 'releases/licenses/hag-upstream/src/linux/probe_packets.rs').unlink()
        with self.assertRaisesRegex(ValueError, 'hag-upstream notices differ'):
            IMPORT.planned_payloads(self.root, self.files, self.config)

    def test_hag_library_receipt_cannot_misidentify_source_header_or_abi(self):
        for field, value in [('cargoFeatures', []), ('headerSha256', '0' * 64),
                             ('cargoLockSha256', '0' * 64), ('requiredGlibcVersions', ['2.35']),
                             ('source', {'dirty': True}), ('version', 'v99')]:
            changed = copy.deepcopy(self.files)
            manifest = IMPORT.document(changed['manifest.json'])
            manifest['hagLibrary'][field] = value
            changed['manifest.json'] = encoded(manifest)
            changed['hag-library/receipt.json'] = encoded(manifest['hagLibrary'])
            reseal(changed)
            with self.subTest(field=field), self.assertRaises(ValueError):
                IMPORT.validate_archive(changed, self.config)

    def test_hag_library_binary_and_format_must_match_qualification(self):
        for name in ['lib/libexec_hag.so', 'lib/libexec_hag.a']:
            changed = copy.deepcopy(self.files)
            changed['hag-library/' + name] = b'wrong architecture or format'
            reseal(changed)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'digest mismatch'):
                IMPORT.validate_archive(changed, self.config)
            manifest = IMPORT.document(changed['manifest.json'])
            manifest['hagLibrary']['files'][name] = record(changed['hag-library/' + name])
            changed['manifest.json'] = encoded(manifest)
            changed['hag-library/receipt.json'] = encoded(manifest['hagLibrary'])
            reseal(changed)
            with self.subTest(name=name, updatedReceipt=True), self.assertRaisesRegex(ValueError, 'shared ELF and static archive'):
                IMPORT.validate_archive(changed, self.config)

    def test_tracked_notice_copy_must_be_complete_identical_and_without_extras(self):
        self.prepare_vendor()
        IMPORT.validate_project_notices(self.root, self.files)
        directory = self.root / 'releases/licenses/beholdd-runtime'
        notice = directory / 'COPYRIGHT-library.html'
        original = notice.read_bytes()
        for content in [b'tampered', None]:
            if content is None:
                notice.unlink()
            else:
                notice.write_bytes(content)
            with self.subTest(content=content), self.assertRaisesRegex(ValueError, 'notices differ'):
                IMPORT.planned_payloads(self.root, self.files, self.config)
        notice.write_bytes(original)
        (directory / 'extra').write_text('not part of the reviewed notices')
        with self.assertRaisesRegex(ValueError, 'notices differ'):
            IMPORT.planned_payloads(self.root, self.files, self.config)

    def test_vendor_directory_symlinks_are_not_replaced(self):
        self.prepare_vendor()
        payloads = IMPORT.planned_payloads(self.root, self.files, self.config)
        target = self.root / 'vendor/beholdd'
        target.rename(self.root / 'outside')
        target.symlink_to(self.root / 'outside', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'real directory'):
            IMPORT.install_payloads(self.root, payloads)
        self.assertTrue((self.root / 'outside/old-unmanifested-file').is_file())

    def test_redirects_cannot_select_local_or_arbitrary_hosts(self):
        for url in ['file:///tmp/archive', 'http://github.com/a', 'https://example.com/a',
                    'https://github.com@evil.example/a', 'https://github.com:8443/a']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                IMPORT.safe_url(url)
        IMPORT.safe_url('https://release-assets.githubusercontent.com/example')


if __name__ == '__main__':
    unittest.main()
