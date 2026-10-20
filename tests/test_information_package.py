import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src/runtime"))
from mod_author import pack
from mod_package import inspect_package
from mod_store import install, registration


class InformationPackageTests(unittest.TestCase):
    def test_installed_package_drives_original_lifecycle_through_sdk(self):
        logs = ROOT / "logs/package-tests"
        logs.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=logs) as temporary:
            folder = Path(temporary)
            package = folder / "information.bluemilk"
            pack(ROOT / "mods/information", package)
            checked = inspect_package(package)
            install(package, checked["sha256"], folder / "store")
            manifest, source, digest = registration(
                checked["sha256"], folder / "store")
            result = subprocess.run(
                ["node", str(ROOT / "tests/information_package.mjs")],
                input=json.dumps(dict(manifest=manifest, source=source, sha256=digest)),
                text=True, encoding="utf-8", capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("PASS installed information package", result.stdout)


if __name__ == "__main__":
    unittest.main()
