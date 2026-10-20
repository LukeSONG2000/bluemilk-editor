import test_paths
import hashlib,json,tempfile,unittest
import sys
from unittest.mock import Mock
from pathlib import Path
from passive_capture import save_capture,save_mode
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from prepare_captured_trial import read_capture,read_mode_provenance

class CaptureTests(unittest.TestCase):
 def test_disconnect_clears_capture_for_later_reconnect(self):
  from app import Runtime
  runtime=Runtime();runtime.session=Mock();runtime.script=Mock();runtime.capture=Mock();runtime.release_ownership=Mock()
  capture=runtime.capture;session=runtime.session
  self.assertTrue(runtime.disconnect()['disconnected'])
  capture.close.assert_called_once();session.detach.assert_called_once()
  self.assertIsNone(runtime.capture);self.assertIsNone(runtime.session)

 def test_capture_cleanup_failure_retains_connection_ownership(self):
  from app import Runtime
  runtime=Runtime();runtime.session=Mock();runtime.script=Mock();runtime.capture=Mock();runtime.release_ownership=Mock()
  runtime.capture.close.side_effect=RuntimeError('Native stop failed')
  with self.assertRaisesRegex(RuntimeError,'Native stop'):runtime.disconnect()
  runtime.session.detach.assert_not_called();runtime.release_ownership.assert_not_called()
  runtime.script.exports_sync.shutdown.assert_not_called()

 def test_original_pair_and_mode_binding(self):
  logs=test_paths.logs()
  with tempfile.TemporaryDirectory(dir=logs) as directory:
   path=Path(directory)/'battle.pb';data=b'original-proto'
   meta=dict(kind='original-battle-proto-captured',encoding='direct-protobuf-v2',captureId='capture1',bytes=len(data))
   saved=save_capture(path,meta,data);self.assertEqual(saved['sha256'],hashlib.sha256(data).hexdigest())
   with self.assertRaises(ValueError):save_capture(path,meta,data)
   mode=dict(kind='original-battle-mode-provenance',captureId='foreign',battleType=7,combatType=0,replayCompatibilityVerified=False)
   with self.assertRaises(ValueError):save_mode(path,mode)
   mode['captureId']='capture1';record=save_mode(path,mode)
   self.assertEqual(record['battleSha256'],saved['sha256'])
   restored,metadata,info=read_capture(path,'original-battle-proto-captured')
   self.assertEqual(restored,data)
   self.assertEqual(read_mode_provenance(path,metadata,info)['battleType'],7)
   with self.assertRaises(FileExistsError):save_mode(path,mode)
   path.write_bytes(b'changed')
   with self.assertRaisesRegex(ValueError,'integrity'):save_mode(path,mode)

 def test_invalid_data_is_not_written(self):
  with tempfile.TemporaryDirectory(dir=test_paths.logs()) as directory:
   p=Path(directory)/'bad.pb'
   with self.assertRaises(ValueError):save_capture(p,{},b'')
   self.assertFalse(p.exists())

if __name__=='__main__':unittest.main()
