import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import unittest
from unittest.mock import patch
from capture_prepare import prepare_request


class CapturePrepareTests(unittest.TestCase):
    def request(self):
        return dict(battle=str(Path.cwd()/'battle.pb'), inventory=str(Path.cwd()/'inventory.pb'),
                    squadType=8,durationSeconds=60,auto=False)

    def test_unknown_mode_never_treated_as_pve(self):
        with patch('capture_prepare.read_capture',return_value=(b'',{},{})), patch('capture_prepare.read_mode_provenance',return_value=None):
            with self.assertRaisesRegex(ValueError,'provenance missing'):
                prepare_request(self.request(),'missing','missing')

    def test_other_mode_rejected_before_resource_access(self):
        with patch('capture_prepare.read_capture',return_value=(b'',{},{})), patch('capture_prepare.read_mode_provenance',return_value={'battleType':7,'combatType':0}):
            with self.assertRaisesRegex(ValueError,'not supported'):
                prepare_request(self.request(),'missing','missing')

    def test_strict_options(self):
        for change in [{'squadType':True},{'durationSeconds':True},{'auto':1},{'battle':'relative.pb'},{'extra':1}]:
            with self.assertRaises(ValueError):
                prepare_request({**self.request(),**change},'missing','missing')


if __name__=='__main__':unittest.main()
