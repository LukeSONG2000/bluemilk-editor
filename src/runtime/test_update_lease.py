import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import test_paths
from server_endpoint import EndpointOwner
from update_lease import UpdateLease, global_directory


@unittest.skipUnless(os.name == 'nt', 'Windows file sharing semantics required')
class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='update-lease-', dir=test_paths.logs())
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def child(self, code):
        return subprocess.run([sys.executable, '-c', code, str(self.root)],
            cwd=Path(__file__).parent, capture_output=True, text=True, timeout=10)

    def test_live_host_blocks_update_then_release_allows_it(self):
        owner = EndpointOwner(self.root)
        try:
            result = self.child('from update_lease import UpdateLease; import sys; '
                                'UpdateLease(sys.argv[1], exclusive=True)')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('installation lease', result.stderr)
        finally:
            owner.close()
        with UpdateLease(self.root, exclusive=True):
            pass

    def test_exclusive_update_blocks_host_and_second_update(self):
        with UpdateLease(self.root, exclusive=True):
            for code in (
                'from server_endpoint import EndpointOwner; import sys; EndpointOwner(sys.argv[1])',
                'from update_lease import UpdateLease; import sys; UpdateLease(sys.argv[1], exclusive=True)'):
                result = self.child(code)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('installation lease', result.stderr)
        owner = EndpointOwner(self.root)
        owner.close()

    def test_abrupt_update_exit_releases_lease_without_deleting_file(self):
        result = self.child('from update_lease import UpdateLease; import sys,os; '
                            'lease=UpdateLease(sys.argv[1],exclusive=True); os._exit(7)')
        self.assertEqual(result.returncode, 7)
        self.assertTrue((self.root / 'update.lock').exists())
        with UpdateLease(self.root, exclusive=True):
            pass

    def test_shared_owners_coexist_but_endpoint_mutex_still_single(self):
        with UpdateLease(self.root), UpdateLease(self.root):
            with self.assertRaisesRegex(RuntimeError, 'installation lease'):
                UpdateLease(self.root, exclusive=True)
        owner = EndpointOwner(self.root)
        try:
            result = self.child('from server_endpoint import EndpointOwner; import sys; EndpointOwner(sys.argv[1])')
            self.assertIn('already owns', result.stderr)
        finally:
            owner.close()
        # Failed startup must not leave its shared lease behind.
        with UpdateLease(self.root, exclusive=True):
            pass

    def test_lock_file_cannot_be_removed_while_held(self):
        with UpdateLease(self.root, exclusive=True):
            with self.assertRaises(PermissionError):
                (self.root / 'update.lock').unlink()

    def test_alternate_endpoint_holds_user_update_gate(self):
        owner = EndpointOwner(self.root / 'alternate')
        try:
            with self.assertRaisesRegex(RuntimeError, 'installation lease'):
                UpdateLease(global_directory(), exclusive=True)
        finally:
            owner.close()
        with UpdateLease(global_directory(), exclusive=True):
            for name in ('first', 'second'):
                result = self.child('from server_endpoint import EndpointOwner; import sys; '
                    'from pathlib import Path; EndpointOwner(Path(sys.argv[1]) / "' + name + '")')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('installation lease', result.stderr)
        # Failure to get the global gate must not leak the endpoint-local lease.
        with UpdateLease(self.root / 'first', exclusive=True):
            pass


if __name__ == '__main__':
    unittest.main()
