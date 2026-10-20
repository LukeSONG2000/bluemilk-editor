"""Deterministic authoring tool; never executes Mod code."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile
from mod_package import LIMIT, inspect_bytes, inspect_package, safe_name, unique_object


def pack(source, output):
    root = Path(source).resolve()
    destination = Path(output).absolute()
    if destination.resolve().is_relative_to(root):
        raise ValueError('Output must be outside the source directory')
    content = {}
    total = 0
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
            raise ValueError('Source links are unsupported')
        if path.is_dir():
            continue
        name = safe_name(path.relative_to(root).as_posix())
        with path.open('rb') as stream:
            data = stream.read(LIMIT + 1)
        total += len(data)
        if total > LIMIT or len(content) >= 128:
            raise ValueError('Source exceeds package limits')
        content[name] = data
    if 'mod.json' not in content or len(content['mod.json']) > 65536:
        raise ValueError('Missing or oversized mod.json')
    manifest = json.loads(content.pop('mod.json').decode('utf-8'), object_pairs_hook=unique_object)
    manifest['packageVersion'] = 1
    manifest['files'] = {name: hashlib.sha256(data).hexdigest() for name, data in content.items()}
    content['mod.json'] = json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as bundle:
        for name, data in sorted(content.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            bundle.writestr(entry, data)
    raw = archive.getvalue()
    result = inspect_bytes(raw)
    # Refuse overwrite; callers choose a new artifact path for every build.
    with destination.open('xb') as stream:
        stream.write(raw)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    build = commands.add_parser('pack')
    build.add_argument('source')
    build.add_argument('output')
    inspect = commands.add_parser('inspect')
    inspect.add_argument('path')
    args = parser.parse_args()
    try:
        result = pack(args.source, args.output) if args.command == 'pack' else inspect_package(Path(args.path).resolve())
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
