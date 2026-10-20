import test_paths
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from mod_package import inspect_package
from runtime_protocol import ProtocolSession


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=test_paths.logs())
        self.path = Path(self.temp.name) / 'example.bluemilk'
        self.code = b'throw Error("Inspection must never execute this");'
        self.manifest = dict(id='org.example.reader', name='Reader', publisher='Example',
                             version='1.0.0', sdkVersion=1, gameProfile='swgoh-0.40.7',
                             capabilities=['read'], presentations=['cli'], dependencies=[], conflicts=[],
                             packageVersion=1, entry='main.js',
                             files={'main.js': hashlib.sha256(self.code).hexdigest()})

    def tearDown(self):
        self.temp.cleanup()

    def write(self, extra=None, manifest=None, code=None):
        with zipfile.ZipFile(self.path, 'w') as archive:
            archive.writestr('mod.json', manifest or json.dumps(self.manifest))
            archive.writestr('main.js', self.code if code is None else code)
            for name, data in extra or []:
                archive.writestr(name, data)

    def test_shared_protocol_inspects_without_game_or_code_execution(self):
        self.write()
        response = ProtocolSession(object()).dispatch(json.dumps({
            'id': 'inspect', 'operation': 'mods-package-inspect', 'payload': {'path': str(self.path)}}))
        self.assertTrue(response['ok'], response)
        self.assertFalse(response['result']['executed'])
        self.assertFalse(response['result']['publisherAuthenticated'])
        self.assertEqual(response['result']['manifest']['presentations'], ['cli'])

    def test_modified_content_rejected(self):
        self.write(code=b'altered')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            inspect_package(self.path)

    def test_path_aliases_and_traversal(self):
        for name in ('../escape.js', '/absolute.js', 'C:/x.js', 'a\\b.js', 'NUL.js', 'folder./a.js', 'MAIN.js'):
            with self.subTest(name=name):
                self.write(extra=[(name, b'x')])
                with self.assertRaises(ValueError):
                    inspect_package(self.path)

    def test_unlisted_payload_rejected(self):
        self.write(extra=[('other.js', b'x')])
        with self.assertRaisesRegex(ValueError, 'inventory'):
            inspect_package(self.path)

    def test_file_directory_collision_rejected(self):
        self.write(extra=[('MAIN.js/child.js', b'x')])
        with self.assertRaisesRegex(ValueError, 'parent directory'):
            inspect_package(self.path)

    def test_duplicate_json_keys_rejected(self):
        self.write(manifest='{"id":"a.b","id":"a.c"}')
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON'):
            inspect_package(self.path)

    def test_symlink_rejected(self):
        self.write()
        with zipfile.ZipFile(self.path, 'a') as archive:
            link = zipfile.ZipInfo('link.js')
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            archive.writestr(link, 'main.js')
        with self.assertRaisesRegex(ValueError, 'Links'):
            inspect_package(self.path)

    def test_compressed_expansion_limit(self):
        with zipfile.ZipFile(self.path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('mod.json', json.dumps(self.manifest))
            archive.writestr('main.js', b' ' * (16 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, 'Expanded'):
            inspect_package(self.path)

    def test_invalid_dependency_version(self):
        self.manifest['dependencies'] = ['org.example.base']
        self.manifest['dependencyVersions'] = {'org.example.base': '>=1.0.0'}
        self.write()
        with self.assertRaisesRegex(ValueError, 'dependencyVersions'):
            inspect_package(self.path)
