import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import unittest
import json
import tempfile
import hashlib
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

    def test_shared_control_request_uses_managed_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            assets=Path(temporary)/'assets'; folder=assets/'trial';folder.mkdir(parents=True)
            files={}
            for name in ('trial.bluemilk','battle-control.bluemilk'):
                data=name.encode();(folder/name).write_bytes(data)
                files[name]=hashlib.sha256(data).hexdigest()
            (folder/'manifest.json').write_text(json.dumps({'files':files}))
            policy=dict(enabled=False,oneClickTaunt=True,allowedTargets=[],manualUI=False)
            with patch('capture_prepare.read_capture',return_value=(b'',{},{})), patch('capture_prepare.read_mode_provenance',return_value={'battleType':1,'combatType':0}), patch('trial_store.snapshot',side_effect=[{'sha256':'trial'},{'sha256':'control'}]) as snapshots, patch('capture_prepare.prepare',return_value={'verified':False}) as assembler:
                result=prepare_request({**self.request(),'control':{'policy':policy}},assets,Path(temporary)/'out')
            self.assertFalse(result['started'])
            self.assertIsNone(assembler.call_args.kwargs['control'])
            self.assertEqual(assembler.call_args.kwargs['managed_control'], {'sha256':'control','policy':policy})
            self.assertEqual(snapshots.call_args.kwargs['identity'],'bluemilk.battle-control')


if __name__=='__main__':unittest.main()
