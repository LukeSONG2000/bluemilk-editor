import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import test_mod_package
from mod_package import inspect_package
from mod_profile import read, write, acquire
from mod_store import install, remove, acquire_package
from runtime_protocol import ProtocolSession


class ProfileTests(unittest.TestCase):
    setUp = test_mod_package.PackageTests.setUp
    tearDown = test_mod_package.PackageTests.tearDown

    def package(self, identity='org.example.reader', version='1.0.0', **extra):
        self.manifest.update(id=identity, version=version, dependencies=[], conflicts=[])
        self.manifest.pop('dependencyVersions', None)
        self.manifest.update(extra)
        test_mod_package.PackageTests.write(self)
        sha = inspect_package(self.path)['sha256']
        install(self.path, sha)
        return {'sha256': sha, 'enabled': True}

    def test_upgrade_rollback_revisions_and_persistence(self):
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            old = self.package()
            new = self.package(version='2.0.0')
            first = read()
            selected = write(first['revision'], {'org.example.reader': old})
            upgraded = write(selected['revision'], {'org.example.reader': new})
            with self.assertRaisesRegex(ValueError, 'changed'):
                write(selected['revision'], {})
            restored = write(upgraded['revision'], {'org.example.reader': old})
            child = subprocess.run([sys.executable, '-c',
                'import json;from mod_profile import read;print(json.dumps(read()))'],
                cwd=Path(__file__).parent, capture_output=True, text=True, timeout=15)
            self.assertEqual(child.returncode, 0, child.stderr)
            self.assertEqual(json.loads(child.stdout),
                             {'selections': restored['selections'], 'revision': restored['revision']})
            with self.assertRaisesRegex(ValueError, 'startup profile'):
                remove(old['sha256'])
            self.assertTrue(remove(new['sha256'])['removed'])
            write(restored['revision'], {})
            self.assertTrue(remove(old['sha256'])['removed'])

    def test_dependencies_versions_conflicts_and_order(self):
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            base = self.package('org.example.zbase')
            child = self.package('org.example.achild', dependencies=['org.example.zbase'],
                                 dependencyVersions={'org.example.zbase': '1.0.0'})
            initial = read()
            with self.assertRaisesRegex(ValueError, 'dependency'):
                write(initial['revision'], {'org.example.achild': child})
            selected = {'org.example.achild': child, 'org.example.zbase': base}
            write(initial['revision'], selected)
            profile, ordered, leases = acquire()
            try:
                self.assertEqual([identity for identity, _ in ordered], ['org.example.zbase', 'org.example.achild'])
                with self.assertRaisesRegex(RuntimeError, 'in use'):
                    write(profile['revision'], {})
            finally:
                for _, release in leases.values(): release()
            newer = self.package('org.example.zbase', '2.0.0')
            with self.assertRaisesRegex(ValueError, 'version mismatch'):
                write(profile['revision'], {**selected, 'org.example.zbase': newer})
            conflicting = self.package('org.example.conflict', conflicts=['org.example.zbase'])
            with self.assertRaisesRegex(ValueError, 'Conflicting'):
                write(profile['revision'], {**selected, 'org.example.conflict': conflicting})

    def test_cycle_and_invalid_identity_rejected(self):
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            a = self.package('org.example.a', dependencies=['org.example.b'])
            b = self.package('org.example.b', dependencies=['org.example.a'])
            initial = read()
            with self.assertRaisesRegex(ValueError, 'Cyclic'):
                write(initial['revision'], {'org.example.a': a, 'org.example.b': b})
            with self.assertRaisesRegex(ValueError, 'mismatch'):
                write(initial['revision'], {'org.example.wrong': a})
            with self.assertRaises(ValueError):
                write(initial['revision'], {'org.example.a': {**a, 'enabled': 1}})
            self.assertEqual(read(), initial)

    def test_acquisition_failure_releases_already_acquired_packages(self):
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            a = self.package('org.example.a')
            b = self.package('org.example.b')
            write(read()['revision'], {'org.example.a': a, 'org.example.b': b})
            _, held = acquire_package(b['sha256'])
            try:
                with self.assertRaisesRegex(RuntimeError, 'in use'):
                    acquire()
                _, free = acquire_package(a['sha256'])
                free()
            finally: held()

    def test_protocol_offline_selection_does_not_execute_runtime(self):
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            item = self.package()
            session = ProtocolSession(object())
            initial = session.dispatch(json.dumps({'id': 1, 'operation': 'mods-profile-read'}))
            saved = session.dispatch(json.dumps({'id': 2, 'operation': 'mods-profile-write', 'payload': {
                'revision': initial['result']['revision'], 'selections': {'org.example.reader': item}}}))
            self.assertTrue(saved['ok'], saved)
            self.assertEqual(saved['result']['activation'], 'next-connection')

    def test_missing_package_can_be_unselected_without_silent_reset(self):
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            item = self.package()
            saved = write(read()['revision'], {'org.example.reader': item})
            path = Path(self.temp.name) / '.bluemilk/mods/packages' / (item['sha256'] + '.bluemilk')
            path.unlink()  # Simulate external corruption of the isolated fixture only.
            with self.assertRaises(FileNotFoundError): acquire()
            self.assertEqual(read()['revision'], saved['revision'])
            self.assertEqual(write(saved['revision'], {})['selections'], {})
