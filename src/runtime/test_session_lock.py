import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from session_lock import acquire_session
from unittest.mock import Mock
import runtime_core as app


class SessionLockTests(unittest.TestCase):
    def test_connection_failure_releases_but_cleanup_failure_retains(self):
        runtime=app.Runtime();release=Mock()
        with tempfile.TemporaryDirectory() as root:
            assets=Path(root)
            for name in app.MODULES+['battle_info_ui.js','bridge.js']:
                (assets/name).write_text('',encoding='utf-8')
            with patch.object(app,'ASSETS',assets),patch.object(app,'DATA',assets),patch.object(app,'find_game',return_value={'pid':123}),patch.object(app,'acquire_session',return_value=release),patch.object(app.frida,'attach',side_effect=RuntimeError('attach failed')):
                with self.assertRaisesRegex(RuntimeError,'attach failed'):runtime.connect()
            release.assert_called_once();self.assertIsNone(runtime.release_ownership)
        runtime.session=Mock();runtime.script=Mock();runtime.release_ownership=Mock()
        runtime.script.exports_sync.shutdown.side_effect=RuntimeError('cleanup incomplete')
        with self.assertRaisesRegex(RuntimeError,'cleanup incomplete'):runtime.disconnect()
        runtime.release_ownership.assert_not_called();runtime.session.detach.assert_not_called()
        runtime.script.exports_sync.shutdown.side_effect=None
        release=runtime.release_ownership;runtime.disconnect();release.assert_called_once()

    def test_live_partial_and_replaced_owner(self):
        with tempfile.TemporaryDirectory() as root:
            file=Path(root)/'runtime-session-123.lock'
            release=acquire_session(123,root)
            with self.assertRaises(RuntimeError):acquire_session(123,root)
            release();self.assertFalse(file.exists())
            file.write_text('',encoding='utf-8')
            with self.assertRaises(RuntimeError):acquire_session(123,root)
            self.assertTrue(file.exists());file.unlink()
            release=acquire_session(123,root)
            file.write_text(json.dumps({'hostPid':os.getpid(),'gamePid':456}),encoding='utf-8')
            release();self.assertTrue(file.exists())

    def test_stale_owner(self):
        with tempfile.TemporaryDirectory() as root:
            file=Path(root)/'runtime-session-123.lock'
            file.write_text(json.dumps({'hostPid':987654321,'gamePid':123}),encoding='utf-8')
            with patch('session_lock.psutil.pid_exists',return_value=False):release=acquire_session(123,root)
            release();self.assertFalse(file.exists())

    def test_node_python_interoperability(self):
        module=(Path(__file__).resolve().parent/'runtime_session_lock.mjs').as_uri()
        code=f"import {{acquireRuntimeSession}} from {json.dumps(module)}; const release=acquireRuntimeSession({os.getpid()});console.log('owned');process.stdin.once('data',()=>{{release();process.exit(0);}});"
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)/'SWGoH-Tool'/'sessions'
            env={**os.environ,'LOCALAPPDATA':root}
            release=acquire_session(os.getpid(),folder)
            try:
                blocked=subprocess.run(['node','--input-type=module','-e',code],env=env,capture_output=True,text=True,timeout=15)
                self.assertNotEqual(blocked.returncode,0);self.assertIn('already owned',blocked.stderr)
            finally:
                release()
            child=subprocess.Popen(['node','--input-type=module','-e',code],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(),'owned')
                with self.assertRaises(RuntimeError):acquire_session(os.getpid(),folder)
            finally:
                child.communicate('stop\n',timeout=15)
            self.assertEqual(child.returncode,0)
            acquire_session(os.getpid(),folder)()


if __name__=='__main__':unittest.main()
