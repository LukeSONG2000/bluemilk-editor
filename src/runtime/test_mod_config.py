import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch
import test_mod_package
from mod_package import inspect_package
from mod_store import install
from mod_config import read, write, encode
from runtime_core import Runtime
from runtime_protocol import ProtocolSession


class ConfigTests(unittest.TestCase):
    setUp = test_mod_package.PackageTests.setUp
    tearDown = test_mod_package.PackageTests.tearDown

    def prepare(self):
        test_mod_package.PackageTests.write(self)
        self.sha = inspect_package(self.path)['sha256']
        install(self.path, self.sha)

    def test_protocol_persistence_revision_conflict_and_native_snapshot(self):
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            self.prepare()
            runtime = Runtime()
            session = ProtocolSession(runtime)
            def call(op, **payload):
                return session.dispatch(json.dumps(dict(id=1, operation=op, payload=payload)))
            initial = call('mods-config-read', sha256=self.sha)['result']
            values = {'mode': '中文', 'nested': {'enabled': True}}
            saved = call('mods-config-write', sha256=self.sha, revision=initial['revision'], values=values)
            self.assertTrue(saved['ok'], saved)
            stale = call('mods-config-write', sha256=self.sha, revision=initial['revision'], values={})
            self.assertFalse(stale['ok'])
            child = subprocess.run([sys.executable, '-c',
                'import sys,json;from mod_config import read;print(json.dumps(read(sys.argv[1])))', self.sha],
                cwd=Path(__file__).parent, capture_output=True, text=True, timeout=15)
            self.assertEqual(child.returncode, 0, child.stderr)
            self.assertEqual(json.loads(child.stdout)['values'], values)
            runtime.script = Mock()
            try:
                runtime.register_package(self.sha)
                self.assertEqual(runtime.script.exports_sync.modregisterpackage.call_args.args[3], values)
                blocked = call('mods-config-write', sha256=self.sha,
                               revision=saved['result']['revision'], values={})
                self.assertFalse(blocked['ok'])
                self.assertIn('in use', blocked['error'])
                self.assertEqual(read(self.sha)['values'], values)
            finally:
                runtime._release_packages()
            self.assertTrue(call('mods-config-write', sha256=self.sha,
                                 revision=saved['result']['revision'], values={})['ok'])

    def test_invalid_and_corrupt_values_do_not_reset_config(self):
        for value in ([], {'x': float('nan')}, {'x': 2**54}, {'x': 'a' * 8192}):
            with self.assertRaises(ValueError):
                encode(value)
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            self.prepare()
            current = read(self.sha)
            write(self.sha, current['revision'], {'x': 1})
            path = Path(self.temp.name) / '.bluemilk/mods/config' / (self.sha + '.json')
            path.write_text('{"x":1,"x":2}')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                read(self.sha)
            self.assertEqual(path.read_text(), '{"x":1,"x":2}')

    def test_other_runtime_lease_blocks_configuration(self):
        with patch.dict(os.environ, USERPROFILE=self.temp.name):
            self.prepare()
            initial = read(self.sha)
            child = subprocess.Popen([sys.executable, '-c',
                'import sys;from mod_store import acquire_package;'
                'p,r=acquire_package(sys.argv[1]);print("ready",flush=True);sys.stdin.readline();r()', self.sha],
                cwd=Path(__file__).parent, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'ready')
                with self.assertRaisesRegex(RuntimeError, 'in use'):
                    write(self.sha, initial['revision'], {'x': 1})
            finally:
                child.communicate('\n', timeout=10)
            self.assertEqual(child.returncode, 0)
