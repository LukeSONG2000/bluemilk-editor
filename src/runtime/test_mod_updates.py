import copy
import hashlib
import json
import urllib.error
import unittest
from unittest.mock import patch

import test_mod_package
from mod_package import inspect_package, validate_manifest
from mod_store import install, discover
from mod_updates import check, update, parse_release


class ModUpdateTests(unittest.TestCase):
    setUp = test_mod_package.PackageTests.setUp
    tearDown = test_mod_package.PackageTests.tearDown
    write = test_mod_package.PackageTests.write

    def prepare(self):
        self.manifest.pop('publisher', None)
        self.manifest.update(author='Example', repository='https://github.com/example/reader',
                             updates={'provider': 'github', 'asset': 'Reader-{version}.bluemilk'},
                             publishedAt='2026-10-22T00:00:00Z')
        self.write()
        self.store = self.path.parent / 'store'
        self.old = inspect_package(self.path)['sha256']
        install(self.path, self.old, self.store)
        self.manifest['version'] = '1.1.0'
        self.write()
        self.raw = self.path.read_bytes()
        self.digest = hashlib.sha256(self.raw).hexdigest()
        self.release = dict(draft=False, prerelease=False, tag_name='v1.1.0',
                            published_at='2026-10-22T00:00:00Z', assets=[dict(
                                id=123, name='Reader-1.1.0.bluemilk', state='uploaded',
                                size=len(self.raw), digest='sha256:'+self.digest)])

    def test_offline_source_survives_and_update_installs_without_execution(self):
        self.prepare()
        with patch('mod_updates.fetch', side_effect=[json.dumps(self.release).encode(),
                                                   json.dumps(self.release).encode(), self.raw]):
            result = check(self.old, self.store)
            self.assertEqual(result['state'], 'update-available')
            installed = update(self.old, '1.1.0', self.digest, self.store)
        self.assertEqual(installed['manifest']['author'], 'Example')
        self.assertEqual(installed['activation'], 'not-requested')
        self.assertEqual(len(discover(self.store)['packages']), 2)

    def test_same_or_older_release_is_up_to_date(self):
        self.prepare()
        for tag in ('v1.0.0', 'v0.9.0'):
            release = {**self.release, 'tag_name': tag}
            with patch('mod_updates.fetch', return_value=json.dumps(release).encode()):
                self.assertEqual(check(self.old, self.store)['state'], 'up-to-date')

    def test_no_release_is_not_repository_missing(self):
        self.prepare()
        missing = lambda: urllib.error.HTTPError('https://api.github.com', 404, 'missing', {}, None)
        with patch('mod_updates.fetch', side_effect=[missing(), b'{}']):
            self.assertEqual(check(self.old, self.store)['state'], 'no-release')
        with patch('mod_updates.fetch', side_effect=[missing(), missing()]):
            self.assertEqual(check(self.old, self.store)['state'], 'repository-unavailable')

    def test_release_mutation_and_wrong_bytes_preserve_old_package(self):
        self.prepare()
        with patch('mod_updates.fetch', return_value=json.dumps(self.release).encode()):
            with self.assertRaisesRegex(ValueError, 'changed'):
                update(self.old, '1.1.0', '0'*64, self.store)
        with patch('mod_updates.fetch', side_effect=[json.dumps(self.release).encode(), b'wrong']):
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                update(self.old, '1.1.0', self.digest, self.store)
        self.assertEqual(len(discover(self.store)['packages']), 1)

    def test_wrong_mod_id_and_version_rejected_after_hash_verification(self):
        for field, wrong in (('id', 'org.other.reader'), ('version', '1.2.0'),
                             ('repository', 'https://github.com/other/reader')):
            with self.subTest(field=field):
                self.prepare()
                self.manifest[field] = wrong
                self.write()
                raw = self.path.read_bytes()
                digest = hashlib.sha256(raw).hexdigest()
                self.release['assets'][0].update(size=len(raw), digest='sha256:'+digest)
                with patch('mod_updates.fetch', side_effect=[json.dumps(self.release).encode(), raw]):
                    with self.assertRaisesRegex(ValueError, 'differs'):
                        update(self.old, '1.1.0', digest, self.store)
                self.assertEqual(len(discover(self.store)['packages']), 1)
                # Restore fixture identity before the next subtest.
                self.manifest.update(id='org.example.reader', version='1.0.0')

    def test_ambiguous_missing_digest_or_prerelease_rejected(self):
        self.prepare()
        self.manifest['version'] = '1.0.0'
        for change in ('duplicate', 'digest', 'prerelease'):
            release = copy.deepcopy(self.release)
            if change == 'duplicate': release['assets'] *= 2
            if change == 'digest': release['assets'][0]['digest'] = None
            if change == 'prerelease': release['prerelease'] = True
            with self.assertRaises(ValueError): parse_release(self.manifest, release)

    def test_manifest_optional_metadata_and_rejected_sources(self):
        self.prepare()
        validate_manifest(self.manifest)
        for key, value in [('repository', 'https://github.com.evil.test/example/reader'),
                           ('repository', 'http://github.com/example/reader'),
                           ('repository', 'https://github.com/../reader'),
                           ('publishedAt', '2026-10-22'),
                           ('updates', {'provider':'github','asset':'../{version}.bluemilk'})]:
            bad = {**self.manifest, key:value}
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_manifest(bad)


if __name__ == '__main__': unittest.main()
