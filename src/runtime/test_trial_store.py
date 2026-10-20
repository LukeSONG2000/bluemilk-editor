import unittest
from unittest.mock import Mock
from pathlib import Path
import test_mod_package
from mod_package import inspect_package
import mod_store
import mod_profile
import mod_config
from trial_store import snapshot, acquire
from prepared_protocol import PreparedService


class TrialStoreTests(unittest.TestCase):
    setUp = test_mod_package.PackageTests.setUp
    tearDown = test_mod_package.PackageTests.tearDown

    def package(self):
        self.manifest.update(id='bluemilk.trial', capabilities=['battle.trial'])
        test_mod_package.PackageTests.write(self)
        return inspect_package(self.path)['sha256']

    def test_selected_version_configuration_and_lease(self):
        root = Path(self.temp.name)/'store'
        old = self.package()
        mod_store.install(self.path, old, root)
        self.manifest['version'] = '2.0.0'
        new = self.package()
        mod_store.install(self.path, new, root)
        profile = mod_profile.read(root)
        mod_profile.write(profile['revision'], {'bluemilk.trial': {'sha256': old, 'enabled': False}}, root)
        config = mod_config.read(old, root)
        mod_config.write(old, config['revision'], {'example': 2}, root)
        record = snapshot(self.path, new, root)
        self.assertEqual(record['sha256'], old)
        self.assertEqual(record['configuration'], {'example': 2})
        manifest = dict(trialPackageSha256=old, managedTrialPackage={
            key: record[key] for key in ('sha256', 'configurationRevision')})
        release = acquire(manifest, root)
        try:
            with self.assertRaisesRegex(RuntimeError, 'in use'):
                mod_config.write(old, record['configurationRevision'], {}, root)
            with self.assertRaisesRegex(RuntimeError, 'in use'):
                mod_profile.write(mod_profile.read(root)['revision'], {}, root)
        finally:
            release()
        mod_config.write(old, record['configurationRevision'], {}, root)
        with self.assertRaisesRegex(ValueError, 'configuration changed'):
            acquire(manifest, root)

    def test_uninstall_suppression_and_running_uninstall(self):
        root = Path(self.temp.name)/'store'
        sha = self.package()
        record = snapshot(self.path, sha, root)
        release = acquire(dict(trialPackageSha256=sha, managedTrialPackage={
            key: record[key] for key in ('sha256', 'configurationRevision')}), root)
        try:
            with self.assertRaisesRegex(RuntimeError, 'in use'):
                mod_store.remove(sha, root)
        finally:
            release()
        mod_store.remove(sha, root)
        with self.assertRaisesRegex(ValueError, 'uninstalled'):
            snapshot(self.path, sha, root)
        self.assertEqual(mod_store.discover(root)['packages'], [])
        acquire({})()  # Existing explicitly selected standalone artifacts still work.

    def test_pending_cleanup_retains_lease(self):
        service = PreparedService()
        release = service.release_package = Mock()
        trial = service.trial = Mock(detached=False)
        trial.done.wait.return_value = False
        with self.assertRaises(TimeoutError):
            service.disconnect()
        release.assert_not_called()
        trial.done.wait.return_value = True
        trial.close.return_value = {'detached': True, 'completion': {'cleanup': {}}}
        self.assertTrue(service.disconnect()['disconnected'])
        release.assert_called_once()


if __name__ == '__main__':
    unittest.main()
