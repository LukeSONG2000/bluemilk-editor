"""Build both frontends' native host payloads from explicit local data inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "src/runtime"
sys.path.insert(0, str(RUNTIME))
from runtime_core import MODULES
from protobuf_defaults import read_schema_bundle
from mod_author import pack
from mod_package import inspect_package
import tempfile

TRIAL = [
    "runtime_api.js", "unity_scene_api.js", "offline_socket_guard.js",
    "original_fixture.js", "battle_proto.js", "isolated_inventory.js",
    "captured_battle.js", "definition_scope.js", "selected_squad.js",
    "captured_trial.js", "battle_instance_identity.js", "battle_status_reader.js",
    "battle_info_ui.js", "battle_attributes_reader.js", "battle_input.js",
    "runtime_observer.js", "trial_input.js", "frame_profile.js",
    "graphics_profile.js", "loading_profile.js", "original_ai_trace.js",
    "original_ai_priority.js", "enemy_manual_ui.js", "enemy_input_gate.js",
    "probe_visual.js", "probe_simulation.js",
]


def manifest(folder, names):
    record = {"schemaVersion": 1, "files": {
        name: hashlib.sha256((folder / name).read_bytes()).hexdigest()
        for name in sorted(names)
    }}
    (folder / "manifest.json").write_text(
        json.dumps(record, indent=2), encoding="utf-8")


def prepare(names_path, schema_path):
    # Validate explicit local inputs before writing anything; no empty substitute.
    names_bytes = Path(names_path).read_bytes()
    names = json.loads(names_bytes.decode("utf-8-sig"))
    if (not isinstance(names, dict) or not names or
            any(not isinstance(k, str) or not k or not isinstance(v, str) or not v
                for k, v in names.items())):
        raise ValueError("Expected a nonempty original unit-ID to name mapping")
    schema_bytes = Path(schema_path).read_bytes()
    read_schema_bundle(schema_path)
    assets = RUNTIME / "assets"
    trial = assets / "trial"
    trial.mkdir(parents=True, exist_ok=True)
    native = ROOT / "src/native"
    modules = sorted(set(MODULES + ["bridge.js", "battle_proto.js", "battle_capture.js"]))
    for folder, selected in [(assets, modules), (trial, TRIAL)]:
        for name in selected:
            shutil.copyfile(native / name, folder / name)
    (assets / "names.json").write_bytes(names_bytes)
    (trial / "schema.json").write_bytes(schema_bytes)
    # Build through the same public package format used by third-party authors.
    (ROOT / "logs").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=ROOT / "logs") as temporary:
        package = Path(temporary) / "information.bluemilk"
        pack(ROOT / "mods/information", package)
        inspect_package(package)
        shutil.copyfile(package, assets / "information.bluemilk")
    manifest(assets, modules + ["names.json", "information.bluemilk"])
    manifest(trial, TRIAL + ["schema.json"])
    client_data = ROOT / "src/assets"
    client_data.mkdir(exist_ok=True)
    (client_data / "names.json").write_bytes(names_bytes)
    return assets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--names", type=Path, required=True)
    parser.add_argument("--schema", type=Path, required=True)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    assets = prepare(args.names, args.schema)
    if args.prepare_only:
        print(json.dumps({"prepared": str(assets), "built": False}))
        return
    for name, entry in [("SWGoH-Runtime", "desktop_host.py"), ("bluemilk", "app.py")]:
        work = ROOT / "logs/build-runtime" / name
        work.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
            "--onefile", "--console", "--name", name, "--collect-all", "frida",
            "--paths", str(RUNTIME), "--add-data", str(assets) + ";assets",
            "--distpath", str(ROOT / "src/dist"), "--workpath", str(work / "work"),
            "--specpath", str(work), str(RUNTIME / entry),
        ], cwd=ROOT, check=True)
    print(json.dumps({"built": True, "directory": str(ROOT / "src/dist")}))


if __name__ == "__main__":
    main()
