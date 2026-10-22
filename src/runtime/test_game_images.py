import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace
import zlib
from game_images import cache_sprite,cached_sprite
from runtime_protocol import ProtocolSession


class OriginalImageTests(unittest.TestCase):
    def fixture(self):
        return {'name':'test_panel','width':1,'height':2,'rgba':[1,2,3,4,5,6,7,8],'bottomUp':True,'nineGrid':[0,1,0,1]}

    def test_exact_alpha_rows_and_cache_integrity(self):
        with tempfile.TemporaryDirectory() as root:
            record=cache_sprite(self.fixture(),'test_panel',root)
            path=Path(record['path']);data=path.read_bytes();self.assertTrue(data.startswith(b'\x89PNG'))
            size=struct.unpack_from('>I',data,33)[0]
            self.assertEqual(zlib.decompress(data[41:41+size]),b'\0\5\6\7\10\0\1\2\3\4')
            path.write_bytes(b'corrupted');self.assertEqual(cache_sprite(self.fixture(),'test_panel',root),record)
            self.assertEqual(path.read_bytes(),data)
            self.assertIsNone(cached_sprite('test_panel','version-a',root))
            self.assertEqual(cache_sprite(self.fixture(),'test_panel',root,profile='version-a'),record)
            self.assertEqual(cached_sprite('test_panel','version-a',root),record)
            self.assertIsNone(cached_sprite('test_panel','version-b',root))
            path.write_bytes(b'corrupted');self.assertIsNone(cached_sprite('test_panel','version-a',root))
            for field,value in [('width',True),('height',513),('rgba',[1]),('nineGrid',[3,0,0,0])]:
                bad={**self.fixture(),field:value}
                with self.assertRaises(ValueError):cache_sprite(bad,'test_panel',root)

    def test_sprite_route_checks_package_before_native_read(self):
        runtime=SimpleNamespace(call_args=Mock());session=ProtocolSession(runtime)
        manifest={'id':'org.example.test','desktop':{'features':[{'floating':{'spriteAsset':'test_panel'}}]}}
        def request(name):return session.dispatch(json.dumps({'id':'image','operation':'mods-image','payload':{'id':'org.example.test','sha256':'a'*64,'name':name}}))
        with patch('mod_store.registration',return_value=(manifest,'','a'*64)),patch('game_images.cache_sprite',return_value={'name':'test_panel'}) as cache:
            self.assertFalse(request('other_panel')['ok']);runtime.call_args.assert_not_called()
            self.assertTrue(request('test_panel')['ok']);runtime.call_args.assert_called_once_with('uisprite','test_panel');cache.assert_called_once()
