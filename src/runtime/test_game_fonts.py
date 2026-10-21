import struct
import tempfile
from pathlib import Path
import unittest
import json
from unittest.mock import patch
from types import SimpleNamespace
from game_fonts import find_font, cache_font
from runtime_protocol import ProtocolSession


def font_blob(family):
    name=family.encode('utf-16-be')
    names=struct.pack('>HHH',0,1,18)+struct.pack('>HHHHHH',3,1,1033,1,len(name),0)+name
    head=bytearray(16);struct.pack_into('>I',head,12,0x5F0F3CF5)
    tables=[(b'head',bytes(head)),(b'name',names),(b'cmap',b'\0'*4),(b'maxp',b'\0'*6)]
    offset=12+16*len(tables);directory=b'';body=b''
    for tag,data in tables:
        directory+=struct.pack('>4sIII',tag,0,offset,len(data));body+=data;offset+=len(data)
    return struct.pack('>IHHHH',0x10000,len(tables),0,0,0)+directory+body


class GameFontTests(unittest.TestCase):
    def test_exact_family_and_container_boundaries(self):
        font=font_blob('Fixture-Regular')
        self.assertEqual(find_font(b'container\0'+font+b'unrelated','Fixture-Regular'),font)
        for blob,family in [(font,'Other'),(font[:-2],'Fixture-Regular'),(b'\0'*99,'Fixture-Regular')]:
            with self.assertRaises(ValueError):find_font(blob,family)

    def test_cache_is_separate_from_original_and_checked_on_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);exe=root/'Game.exe';exe.write_bytes(b'fixture')
            assets=root/'Game_Data';assets.mkdir();source=assets/'resources.assets'
            original=b'prefix'+font_blob('Fixture-Regular')+b'tail';source.write_bytes(original)
            result=cache_font(exe,'Fixture-Regular',root/'cache')
            output=Path(result['path']);output.write_bytes(b'corrupted')
            again=cache_font(exe,'Fixture-Regular',root/'cache')
            self.assertEqual(result,again);self.assertEqual(source.read_bytes(),original)
            self.assertEqual(output.read_bytes(),font_blob('Fixture-Regular'))
            with self.assertRaises(ValueError):cache_font(exe,'../escape',root/'cache')

    def test_font_route_requires_package_declaration(self):
        manifest={'id':'org.example.sample','desktop':{'features':[{'floating':{'fontAsset':'Fixture-Regular'}}]}}
        session=ProtocolSession(SimpleNamespace())
        def request(family):return session.dispatch(json.dumps({'id':'font','operation':'mods-font','payload':{'id':'org.example.sample','sha256':'a'*64,'family':family}}))
        with patch('mod_store.registration',return_value=(manifest,'','a'*64)),patch('runtime_core.find_game',return_value={'exe':'fixture.exe'}),patch('game_fonts.cache_font',return_value={'family':'Fixture-Regular'}) as read:
            self.assertFalse(request('Other')['ok']);read.assert_not_called()
            self.assertTrue(request('Fixture-Regular')['ok']);read.assert_called_once_with('fixture.exe','Fixture-Regular')
