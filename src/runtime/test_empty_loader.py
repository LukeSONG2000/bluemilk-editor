import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch
import test_paths
import runtime_core


class EmptyLoaderTests(TestCase):
    def test_connect_without_packages_does_not_install_or_enable(self):
        with tempfile.TemporaryDirectory(dir=test_paths.logs()) as temporary:
            root = Path(temporary)
            for name in runtime_core.MODULES + ['bridge.js']:
                (root / name).write_text('')
            script = Mock()
            script.list_exports_sync.return_value = ['inspect', 'shutdown']
            script.exports_sync.inspect.return_value = {'state':'HomeBaseGameState'}
            session = Mock()
            session.create_script.return_value = script
            with patch.object(runtime_core, 'ASSETS', root), patch.object(runtime_core, 'DATA', root), \
                 patch.object(runtime_core, 'find_game', return_value={'pid':123}), \
                 patch.object(runtime_core, 'acquire_session', return_value=Mock()), \
                 patch.object(runtime_core.frida, 'attach', return_value=session), \
                 patch('mod_profile.acquire', return_value=({'revision':0,'selections':{}}, [], {})), \
                 patch('mod_store.install') as install:
                runtime = runtime_core.Runtime()
                self.assertEqual(runtime.connect()['pid'], 123)
                self.assertTrue(runtime.connect()['reused'])
                session.create_script.assert_called_once()
                install.assert_not_called()
                script.exports_sync.modcommand.assert_not_called()
                runtime.disconnect()

    def test_failed_bootstrap_releases_session_and_allows_retry(self):
        with tempfile.TemporaryDirectory(dir=test_paths.logs()) as temporary:
            root = Path(temporary)
            for name in runtime_core.MODULES + ['bridge.js']:
                (root / name).write_text('')
            script, session, release = Mock(), Mock(), Mock()
            session.create_script.return_value = script
            script.list_exports_sync.return_value = ['snapshot']
            with patch.object(runtime_core, 'ASSETS', root), patch.object(runtime_core, 'DATA', root), \
                 patch.object(runtime_core, 'find_game', return_value={'pid':123}), \
                 patch.object(runtime_core, 'acquire_session', return_value=release), \
                 patch.object(runtime_core.frida, 'attach', return_value=session), \
                 patch('mod_profile.acquire', return_value=({'revision':0,'selections':{}}, [], {})):
                runtime = runtime_core.Runtime()
                with self.assertRaisesRegex(RuntimeError, '初始化'):
                    runtime.connect()
                self.assertIsNone(runtime.session)
                session.detach.assert_called_once()
                release.assert_called_once()
                script.exports_sync.shutdown.assert_not_called()
                script.list_exports_sync.return_value = ['inspect', 'shutdown']
                script.exports_sync.inspect.return_value = {'state':'HomeBaseGameState'}
                self.assertEqual(runtime.connect()['pid'], 123)
                runtime.disconnect()
