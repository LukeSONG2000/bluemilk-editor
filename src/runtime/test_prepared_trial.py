import tempfile
import unittest
from unittest.mock import patch
import json
from pathlib import Path
from prepared_trial import PreparedTrial, cleanup_complete


GOOD = {'cleanup': {'guardRestored': True, 'gcReleased': True, 'home': True, 'errors': []}}


class FakeScript:
    def __init__(self):
        self.exports_sync = self
        self.fail = False
        self.calls = 0
    def on(self, *_): pass
    def load(self):
        if self.fail: raise RuntimeError('partial load')
    def trialcommand(self, *_):
        self.calls += 1
        raise TimeoutError('unknown RPC result')


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.script = FakeScript()
        self.released = self.detached = 0
        self.host = PreparedTrial({'mode':'visual','battleCli':True}, 'source',
            Path(self.temp.name)/'evidence.json', lambda pid:self, self.acquire)
    def tearDown(self): self.temp.cleanup()
    def acquire(self, pid): return self.release
    def release(self): self.released += 1
    def detach(self): self.detached += 1
    def create_script(self, source): return self.script

    def test_partial_load_retains_ownership(self):
        self.script.fail = True
        with self.assertRaises(RuntimeError): self.host.start(1)
        with self.assertRaises(RuntimeError): self.host.close()
        self.assertEqual((self.released,self.detached),(0,0))

    def test_stop_unknown_never_replays(self):
        self.host.start(1)
        with self.assertRaises(TimeoutError): self.host.stop()
        self.host.stop()
        self.assertEqual(self.script.calls,1)
        with self.assertRaises(RuntimeError): self.host.close()

    def test_confirmed_cleanup_releases_once(self):
        self.host.start(1)
        self.host.message({'type':'send','payload':dict(GOOD,kind='visual-probe-complete')},None)
        self.host.close(); self.host.close()
        self.assertEqual((self.released,self.detached),(1,1))

    def test_disk_failure_cannot_allow_unsafe_detach(self):
        self.host.start(1)
        self.host.persist = lambda: (_ for _ in ()).throw(OSError('disk full'))
        self.host.message({'type':'error','description':'native failure'},None)
        with self.assertRaises(RuntimeError): self.host.close()
        self.assertEqual(self.released,0)
        self.assertEqual(len(self.host.errors),2)

    def test_packaged_trial_requires_matching_disabled_registry(self):
        self.host.manifest['trialPackageSha256']='a'*64
        self.host.complete=dict(GOOD)
        self.assertFalse(self.host.cleanup_confirmed())
        record={'manifest':{'id':'bluemilk.trial'},'packageSha256':'a'*64,'state':'enabled'}
        self.host.complete['trialMod']={'packageSha256':'a'*64,'registry':{'mods':[record]}}
        self.assertFalse(self.host.cleanup_confirmed())
        record['state']='disabled'
        self.assertTrue(self.host.cleanup_confirmed())
        record['packageSha256']='b'*64
        self.assertFalse(self.host.cleanup_confirmed())

    def test_strict_cleanup(self):
        self.assertFalse(cleanup_complete(None,'visual'))
        self.assertFalse(cleanup_complete(GOOD,'headless'))
        self.assertFalse(cleanup_complete({'cleanup':dict(GOOD['cleanup'],errors=['error'])},'visual'))
        self.assertTrue(cleanup_complete(GOOD,'visual'))

    def test_windows_same_directory_replace_fallback(self):
        error = OSError('encrypted directory replacement failed')
        error.winerror = 17
        with patch.object(Path, 'replace', side_effect=error):
            self.host.persist()
        self.assertEqual(json.loads(self.host.evidence.read_text())['detached'], False)
        self.assertFalse(self.host.evidence.with_suffix('.json.tmp').exists())


if __name__ == '__main__': unittest.main()
