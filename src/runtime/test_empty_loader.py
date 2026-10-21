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
                install.assert_not_called()
                script.exports_sync.modcommand.assert_not_called()
                runtime.disconnect()
