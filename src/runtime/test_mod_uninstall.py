import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch
import test_mod_package
from mod_package import inspect_package
from mod_store import acquire_package, discover, install, remove
from runtime_core import Runtime


@unittest.skipUnless(os.name == 'nt', 'Windows package leases')
class UninstallTests(unittest.TestCase):
    setUp = test_mod_package.PackageTests.setUp
    tearDown = test_mod_package.PackageTests.tearDown
    write = test_mod_package.PackageTests.write

    def prepare(self):
        self.write()
        self.root = Path(self.temp.name) / 'store'
        self.sha = inspect_package(self.path)['sha256']
        install(self.path, self.sha, self.root)

    def test_lease_blocks_removal_until_released(self):
        self.prepare()
        _, release = acquire_package(self.sha, self.root)
        try:
            with self.assertRaisesRegex(RuntimeError, 'in use'):
                remove(self.sha, self.root)
        finally:
            release()
        self.assertTrue(remove(self.sha, self.root)['removed'])
        self.assertEqual(discover(self.root)['packages'], [])

    def test_other_process_lease_prevents_removal(self):
        self.prepare()
        code = ('from mod_store import acquire_package;import sys;'
                'p,r=acquire_package(sys.argv[1],sys.argv[2]);'
                'print("ready",flush=True);sys.stdin.readline();r()')
        child = subprocess.Popen([sys.executable, '-c', code, self.sha, str(self.root)],
                                 cwd=Path(__file__).parent, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            with self.assertRaisesRegex(RuntimeError, 'in use'):
                remove(self.sha, self.root)
        finally:
            child.communicate('\n', timeout=10)
        self.assertEqual(child.returncode, 0)
        self.assertTrue(remove(self.sha, self.root)['removed'])

    def test_uninstall_survives_restart_and_explicit_install_restores(self):
        self.prepare()
        remove(self.sha, self.root)
        child = subprocess.run([sys.executable, '-c',
            'from mod_store import install;import sys,json;print(json.dumps(install(sys.argv[1],sys.argv[2],sys.argv[3],bundled=True)))',
            str(self.path), self.sha, str(self.root)], cwd=Path(__file__).parent,
            capture_output=True, text=True, timeout=10)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertTrue(json.loads(child.stdout)['suppressed'])
        self.assertEqual(discover(self.root)['packages'], [])
        install(self.path, self.sha, self.root)
        self.assertFalse(install(self.path, self.sha, self.root, bundled=True).get('suppressed', False))

    def test_dependency_blocks_version_removal(self):
        self.prepare()
        original_id = self.manifest['id']
        self.manifest.update(id='org.example.dependent', dependencies=[original_id],
                             dependencyVersions={original_id: '1.0.0'})
        self.write()
        install(self.path, inspect_package(self.path)['sha256'], self.root)
        with self.assertRaisesRegex(ValueError, 'depends'):
            remove(self.sha, self.root)
        self.assertEqual(len(discover(self.root)['packages']), 2)

    def test_device_name_mod_id_does_not_become_a_windows_filename(self):
        self.manifest['id'] = 'con.example'
        self.prepare()
        self.assertTrue(remove(self.sha, self.root)['removed'])
        self.assertTrue(install(self.path, self.sha, self.root, bundled=True)['suppressed'])

    def test_native_failure_retains_package_and_lease(self):
        self.write()
        sha = inspect_package(self.path)['sha256']
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            install(self.path, sha)
            runtime = Runtime()
            runtime.script = Mock()
            runtime.register_package(sha)
            runtime.script.exports_sync.modunregisterpackage.side_effect = RuntimeError('cleanup failed')
            try:
                with self.assertRaisesRegex(RuntimeError, 'cleanup failed'):
                    runtime.uninstall_package(sha)
                with self.assertRaisesRegex(RuntimeError, 'in use'):
                    remove(sha)
                runtime.script.exports_sync.modunregisterpackage.side_effect = None
                runtime.script.exports_sync.modunregisterpackage.return_value = {'unregistered': True}
                self.assertTrue(runtime.uninstall_package(sha)['removed'])
            finally:
                runtime._release_packages()
