import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'tools'))
from mod_author import pack
from trial_control_package import read_control
from prepared_trial import PreparedTrial
from prepare_captured_trial import prepare


class TrialControlTests(unittest.TestCase):
    def setUp(self):
        import test_paths
        self.temp=tempfile.TemporaryDirectory(dir=test_paths.logs());self.folder=Path(self.temp.name)
        self.trial_package=self.folder/'trial.bluemilk'
        self.pack_fixture('trial', 'battle.trial', 'trial', self.trial_package)
        self.package=self.folder/'control.bluemilk'
        self.pack_fixture('battle-control', 'battle.control', 'control', self.package)
        from mod_package import inspect_package
        self.digest=inspect_package(self.package)['sha256']
        self.request=dict(package=str(self.package),sha256=self.digest,policy=dict(enabled=False,oneClickTaunt=True,allowedTargets=[],manualUI=False))
    def pack_fixture(self, name, capability, factory, output):
        source=self.folder/name;source.mkdir()
        manifest=dict(id='bluemilk.'+name,name='Test fixture',author='Test',version='1.0.0',
            sdkVersion=1,gameProfile='swgoh-0.40.7',capabilities=[capability],
            presentations=['cli'],dependencies=[],conflicts=[],entry='main.js')
        (source/'mod.json').write_text(json.dumps(manifest))
        (source/'main.js').write_text('module.exports = sdk => sdk.battle.'+factory+'.install();')
        pack(source, output)
    def tearDown(self):self.temp.cleanup()

    def test_pinned_snapshot_and_policy(self):
        result=read_control(self.request)
        self.assertEqual(result['sha256'],self.digest)
        self.assertIn('sdk.battle.control.install',result['source'])
        self.request['policy']['allowedTargets'].append('later')
        self.assertEqual(result['policy']['allowedTargets'],[])
        self.package.write_bytes(self.package.read_bytes()+b'changed')
        with self.assertRaisesRegex(ValueError,'integrity'):read_control(self.request)

    def test_conflicting_or_invalid_policy_rejected(self):
        for change in [{'manualUI':True},{'enabled':1},{'allowedTargets':['x','x']},{'scope':'all'}]:
            with self.subTest(change=change),self.assertRaises(ValueError):
                read_control({**self.request,'policy':{**self.request['policy'],**change}})
        with self.assertRaisesRegex(ValueError,'legacy'):
            prepare('unused','unused',None,self.folder/'output',8,'visual',30,False,enemy_control=True,control=self.request)

    def test_control_requires_active_owned_package(self):
        host=PreparedTrial({'mode':'visual','controlPackageSha256':self.digest},'source',self.folder/'evidence.json',None,None)
        rpc=Mock(return_value={'ok':True});host.script=SimpleNamespace(exports_sync=SimpleNamespace(trialmodcommand=rpc))
        payload={'command':'configure','payload':{'enabled':False}}
        self.assertEqual(host.control(payload),{'ok':True});rpc.assert_called_once_with('configure',payload['payload'])
        with self.assertRaises(ValueError):host.control({'command':'arm','payload':{}})
        for change in ('stop_sent','detached'):
            setattr(host,change,True)
            with self.assertRaises(RuntimeError):host.control(payload)
            setattr(host,change,False)
        host.complete={}
        with self.assertRaises(RuntimeError):host.control(payload)
        self.assertEqual(rpc.call_count,1)

    def test_assembler_embeds_checked_package_without_legacy_gate(self):
        native=Path(__file__).resolve().parents[1]/'native'
        with patch('prepare_captured_trial.read_capture',return_value=(b'capture',{}, {'sha256':'a'*64})),patch('prepare_captured_trial.read_mode_provenance',return_value={'battleType':1,'combatType':0}),patch('protobuf_defaults.read_schema_bundle',return_value=({},'b'*64)),patch('prepare_captured_trial.materialize',return_value=b'normalized'):
            m=prepare('battle','inventory',None,self.folder/'trial',8,'visual',30,True,schema_bundle='schema',module_root=native,control=self.request,trial_package=self.trial_package)
        source=Path(m['source']).read_text()
        self.assertEqual(m['controlPackageSha256'],self.digest)
        self.assertIn('globalThis.trialControlPackage=',source)
        self.assertIn('await prepareTrialControl(f)',source)
        self.assertFalse(m['enemyControl'])
        self.assertTrue('if(cleanup.home&&modsClean&&cleanup.errors.length===0)' in source)
        self.assertTrue("traceCleanup('offline-guard-retained'" in source)

    def test_managed_assembler_pins_configuration_and_store_reference(self):
        from trial_store import snapshot
        from mod_config import read, write
        root = self.folder/'store'
        import mod_store, mod_profile
        mod_store.install(self.package, self.digest, root)
        mod_profile.write(mod_profile.read(root)['revision'],
            {'bluemilk.battle-control': {'sha256':self.digest,'enabled':False}}, root)
        record = snapshot(self.package, self.digest, root,
                          identity='bluemilk.battle-control', capability='battle.control')
        write(self.digest, record['configurationRevision'], {'sample': 'preserved'}, root)
        record = snapshot(self.package, self.digest, root,
                          identity='bluemilk.battle-control', capability='battle.control')
        record['policy'] = self.request['policy']
        native=Path(__file__).resolve().parents[1]/'native'
        with patch('prepare_captured_trial.read_capture',return_value=(b'capture',{}, {'sha256':'a'*64})),patch('prepare_captured_trial.read_mode_provenance',return_value={'battleType':1,'combatType':0}),patch('protobuf_defaults.read_schema_bundle',return_value=({},'b'*64)),patch('prepare_captured_trial.materialize',return_value=b'normalized'):
            m=prepare('battle','inventory',None,self.folder/'managed',8,'visual',30,True,
                      schema_bundle='schema',module_root=native,managed_control=record,
                      trial_package=self.trial_package)
        self.assertEqual(m['managedControlPackage'], {
            'sha256': self.digest, 'configurationRevision': record['configurationRevision']})
        source=Path(m['source']).read_text()
        self.assertIn('"configuration": {"sample": "preserved"}', source)
        self.assertIn('p.sha256,p.configuration||{}', source)

if __name__=='__main__':unittest.main()
