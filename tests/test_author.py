import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from mod_author import pack
from mod_package import inspect_package


class AuthorTests(unittest.TestCase):
    def test_official_battle_control_uses_public_factory(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'battle-control.bluemilk'
            pack(ROOT / 'mods/battle-control', output)
            manifest = inspect_package(output)['manifest']
            self.assertEqual(manifest['id'], 'bluemilk.battle-control')
            self.assertEqual(manifest['capabilities'], ['battle.control'])
            self.assertIn('sdk.battle.control.install()', (ROOT / 'mods/battle-control/main.js').read_text())

    def test_official_trial_public_factory(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'trial.bluemilk'
            pack(ROOT / 'mods/trial', output)
            manifest = inspect_package(output)['manifest']
            self.assertEqual(manifest['id'], 'bluemilk.trial')
            self.assertEqual(manifest['capabilities'], ['battle.trial'])
            self.assertIn('sdk.battle.trial.install()', (ROOT / 'mods/trial/main.js').read_text())

    def test_configuration_example_and_runtime_validator_match(self):
        from mod_config_schema import resolve
        self.assertEqual((ROOT / 'tools/mod_config_schema.py').read_bytes(),
                         (ROOT / 'src/runtime/mod_config_schema.py').read_bytes())
        self.assertEqual((ROOT / 'tools/mod_package.py').read_bytes(),
                         (ROOT / 'src/runtime/mod_package.py').read_bytes())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'configuration.bluemilk'
            pack(ROOT / 'examples/configuration', output)
            schema = inspect_package(output)['manifest']['configuration']
            values = resolve(schema, {})
            self.assertEqual(values['rows'], 5)
            self.assertEqual(values['showDetails'], True)
            with self.assertRaises(ValueError):
                resolve(schema, {'rows': 1000})

    def test_reproducible_validated_package(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = (Path(directory) / name for name in ('a.bluemilk', 'b.bluemilk'))
            first = pack(ROOT / 'examples/lifecycle', a)
            second = pack(ROOT / 'examples/lifecycle', b)
            self.assertEqual(a.read_bytes(), b.read_bytes())
            self.assertEqual(first['sha256'], second['sha256'])
            self.assertFalse(inspect_package(a)['executed'])
            with self.assertRaises(FileExistsError):
                pack(ROOT / 'examples/lifecycle', a)

    def test_missing_entry_creates_no_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            source.mkdir()
            manifest = json.loads((ROOT / 'examples/lifecycle/mod.json').read_text())
            (source / 'mod.json').write_text(json.dumps(manifest))
            (source / 'other.js').write_text('throw Error("must not execute")')
            output = Path(directory) / 'bad.bluemilk'
            with self.assertRaises(ValueError):
                pack(source, output)
            self.assertFalse(output.exists())

    def test_output_inside_source_rejected(self):
        with self.assertRaises(ValueError):
            pack(ROOT / 'examples/lifecycle', ROOT / 'examples/lifecycle/bad.bluemilk')


if __name__ == '__main__':
    unittest.main()
