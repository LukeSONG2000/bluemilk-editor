import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from trial_client import TrialClient


class TrialClientTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.pid=77;self.host=os.getpid()
        self.owner={'pid':77,'hostPid':self.host,'kind':'captured-trial','detached':False,'battleCli':True}
        self.write('trial-status-77.json',self.owner)
        self.write('runtime-session-77.lock',{'hostPid':self.host,'gamePid':77})
        self.write('trial-snapshot-77.json',{'pid':77,'hostPid':self.host,'trial':True,'state':'BattleGameState'})

    def write(self,name,data):
        (self.root/name).write_text(json.dumps(data),encoding='utf-8')

    def test_reject_stale_foreign_snapshot_and_replaced_owner(self):
        client=TrialClient(self.root,self.pid)
        path=self.root/'trial-snapshot-77.json'
        os.utime(path,(time.time()-30,time.time()-30))
        with self.assertRaisesRegex(RuntimeError,'stale'):client.snapshot()
        self.write(path.name,{'pid':77,'hostPid':self.host+1,'trial':True})
        with self.assertRaisesRegex(RuntimeError,'snapshot ownership'):client.snapshot()
        self.write('runtime-session-77.lock',{'hostPid':self.host+1,'gamePid':77})
        with self.assertRaisesRegex(RuntimeError,'ownership mismatch'):client.call('battleinspect',{'close':True})
        self.assertFalse((self.root/'commands').exists())

    def test_one_request_original_receipt_and_disconnect_does_not_stop_host(self):
        client=TrialClient(self.root,self.pid);seen=[]
        def host():
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                for request in (self.root/'commands').glob('*.request.json'):
                    data=json.loads(request.read_text());seen.append(data)
                    result=request.with_name(data['id']+'.result.json')
                    tmp=result.with_suffix('.tmp');tmp.write_text(json.dumps({'id':data['id'],'ok':True,'result':{'transitionConfirmed':True}}));tmp.replace(result)
                    return
                time.sleep(.01)
        thread=threading.Thread(target=host);thread.start()
        result=client.call('battleinspect',{'unitId':'original-instance'})
        thread.join(4)
        self.assertTrue(result['result']['transitionConfirmed']);self.assertEqual(len(seen),1)
        self.assertEqual(seen[0]['payload'],{'action':'inspect-unit','unitId':'original-instance'})
        self.assertFalse(client.disconnect()['hostStopped'])
        self.assertEqual(json.loads((self.root/'trial-status-77.json').read_text()),self.owner)
        with self.assertRaisesRegex(RuntimeError,'disconnected'):client.snapshot()

    def test_no_live_battle_or_arbitrary_operation(self):
        client=TrialClient(self.root,self.pid)
        with self.assertRaises(ValueError):client.call('arm',{})
        self.owner['kind']='live';self.write('trial-status-77.json',self.owner)
        with self.assertRaisesRegex(RuntimeError,'No controllable'):TrialClient(self.root,self.pid)

if __name__=='__main__':unittest.main()
