import base64
import json
from pathlib import Path
import struct
import tempfile
import unittest
from mod_author import pack

class ModIconTests(unittest.TestCase):
    def test_optional_icon_and_validation(self):
        root = Path(__file__).resolve().parents[2] / "logs"
        root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as temp:
            base = Path(temp); source = base / "source"; source.mkdir()
            manifest = json.loads((Path(__file__).resolve().parents[2] / "examples/battle-observer/mod.json").read_text(encoding="utf-8-sig"))
            (source / "main.js").write_text("module.exports=()=>({});")
            manifest["entry"] = "main.js"
            (source / "mod.json").write_text(json.dumps(manifest))
            self.assertIsNone(pack(source, base / "plain.bluemilk")["iconBase64"])
            png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=")
            manifest["icon"] = "icon.png"
            (source / "mod.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "absent"):
                pack(source, base / "missing.bluemilk")
            (source / "icon.png").write_bytes(png)
            self.assertEqual(base64.b64decode(pack(source, base / "icon.bluemilk")["iconBase64"]), png)
            (source / "icon.png").write_bytes(png[:16] + struct.pack(">I", 257) + png[20:])
            with self.assertRaisesRegex(ValueError, "256x256"):
                pack(source, base / "oversize.bluemilk")
            manifest["icon"] = "https://example.com/icon.png"
            (source / "mod.json").write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                pack(source, base / "external.bluemilk")
