import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
import test_mod_package
from mod_package import inspect_package
from mod_store import discover, install, locked, registration
from runtime_protocol import ProtocolSession


@unittest.skipUnless(os.name == 'nt', 'Windows Mod store lock')
class StoreTests(unittest.TestCase):
    setUp = test_mod_package.PackageTests.setUp
    tearDown = test_mod_package.PackageTests.tearDown
    write = test_mod_package.PackageTests.write

    def prepare(self):
        self.write()
        self.root = Path(self.temp.name) / 'store'
        self.digest = inspect_package(self.path)['sha256']

    def test_install_duplicate_and_restart_discovery(self):
        self.prepare()
        first = install(self.path, self.digest, self.root)
        self.assertFalse(first['alreadyInstalled'])
        self.assertFalse(first['executed'])
        self.assertEqual(first['activation'], 'not-requested')
        self.assertTrue(install(self.path, self.digest, self.root)['alreadyInstalled'])
        code = 'from mod_store import discover;import sys,json;print(json.dumps(discover(sys.argv[1])))'
        child = subprocess.run([sys.executable, '-c', code, str(self.root)],
                               cwd=Path(__file__).parent, capture_output=True, text=True, timeout=10)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(json.loads(child.stdout)['packages'][0]['sha256'], self.digest)

    def test_source_replaced_after_inspection(self):
        self.prepare()
        self.manifest['name'] = 'Changed'
        self.write()
        with self.assertRaisesRegex(ValueError, 'changed'):
            install(self.path, self.digest, self.root)
        self.assertFalse(self.root.exists())

    def test_same_version_different_content_refused(self):
        self.prepare()
        install(self.path, self.digest, self.root)
        self.manifest['name'] = 'Changed'
        self.write()
        with self.assertRaisesRegex(ValueError, 'different content'):
            install(self.path, inspect_package(self.path)['sha256'], self.root)
        self.assertEqual(len(discover(self.root)['packages']), 1)

    def test_failed_commit_leaves_no_install(self):
        self.prepare()
        with patch('mod_store.os.replace', side_effect=OSError('injected disk failure')):
            with self.assertRaises(OSError):
                install(self.path, self.digest, self.root)
        self.assertEqual(discover(self.root)['packages'], [])
        self.assertEqual(list((self.root / 'packages').iterdir()), [])

    def test_tampered_store_not_silently_ignored(self):
        self.prepare()
        install(self.path, self.digest, self.root)
        self.manifest['name'] = 'Tampered'
        self.write()
        (self.root / 'packages' / (self.digest + '.bluemilk')).write_bytes(self.path.read_bytes())
        with self.assertRaisesRegex(ValueError, 'integrity'):
            discover(self.root)

    def test_other_process_cannot_write_under_lock(self):
        self.prepare()
        with locked(self.root):
            child = subprocess.run([sys.executable, '-c',
                                    'from mod_store import discover;import sys;discover(sys.argv[1])',
                                    str(self.root)], cwd=Path(__file__).parent,
                                   capture_output=True, text=True, timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('in progress', child.stderr)
        self.assertEqual(discover(self.root)['packages'], [])

    def test_two_protocol_sessions_share_install_without_game(self):
        self.prepare()
        with patch.dict(os.environ, {'USERPROFILE': self.temp.name}):
            def call(operation, payload=None):
                return ProtocolSession(object()).dispatch(json.dumps(
                    {'id': operation, 'operation': operation, 'payload': payload}))
            result = call('mods-package-install', {'path': str(self.path), 'sha256': self.digest})
            self.assertTrue(result['ok'], result)
            listed = call('mods-package-list')
            self.assertTrue(listed['ok'], listed)
            self.assertEqual(listed['result']['packages'][0]['sha256'], self.digest)

    def test_actual_cli_installs_then_fresh_cli_discovers(self):
        self.prepare()
        env = dict(os.environ, USERPROFILE=self.temp.name)
        for operation, payload in (
                ('mods-package-install', {'path': str(self.path), 'sha256': self.digest}),
                ('mods-package-list', {})):
            child = subprocess.run([sys.executable, str(Path(__file__).with_name('app.py')), '--jsonl'],
                                   input=json.dumps({'id': 'package', 'operation': operation,
                                                     'payload': payload})+'\n',
                                   capture_output=True, text=True, encoding='utf-8', env=env, timeout=20)
            self.assertEqual(child.returncode, 0, child.stderr)
            result = json.loads(child.stdout.splitlines()[0])
            self.assertTrue(result['ok'], result)
            if operation.endswith('list'):
                self.assertEqual(result['result']['packages'][0]['sha256'], self.digest)

    def test_registration_uses_verified_installed_snapshot(self):
        self.prepare()
        install(self.path, self.digest, self.root)
        manifest, code, digest = registration(self.digest, self.root)
        self.assertEqual(code, self.code.decode())
        self.assertEqual(manifest['id'], self.manifest['id'])
        self.assertEqual(digest, self.digest)
        self.path.write_bytes(b'changed original download')
        self.assertEqual(registration(self.digest, self.root)[1], code)
        (self.root / 'packages' / (self.digest + '.bluemilk')).write_bytes(b'corrupt stored file')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            registration(self.digest, self.root)

    def test_registration_protocol_passes_verified_manifest_source_and_hash(self):
        self.prepare()
        calls = []
        class Runtime:
            def call_args(self, operation, *args):
                calls.append((operation, args))
                return {'state': 'disabled', 'packageSha256': args[2]}
        with patch.dict(os.environ, {'USERPROFILE': self.temp.name}):
            install(self.path, self.digest)
            result = ProtocolSession(Runtime()).dispatch(json.dumps({
                'id': 1, 'operation': 'mods-package-register', 'payload': {'sha256': self.digest}}))
        self.assertTrue(result['ok'], result)
        self.assertEqual(calls[0][0], 'modregisterpackage')
        self.assertEqual(calls[0][1][1], self.code.decode())
        self.assertEqual(result['result']['state'], 'disabled')
