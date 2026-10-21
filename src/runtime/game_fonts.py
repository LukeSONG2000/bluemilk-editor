"""Read original SFNT fonts into a local cache; never redistribute game files."""
import hashlib
import os
from pathlib import Path
import re
import struct


def find_font(data, family):
    """Bounded SFNT table/name inspection, independent of Unity's typetree."""
    cursor = 0
    while True:
        start = data.find(b'\x00\x01\x00\x00', cursor)
        if start < 0:
            raise ValueError('Requested original font is not present in local resources')
        cursor = start + 1
        try:
            count = struct.unpack_from('>H', data, start + 4)[0]
            if not 4 <= count <= 128:
                continue
            tables = {}
            for index in range(count):
                tag, _, offset, length = struct.unpack_from('>4sIII', data, start + 12 + index * 16)
                if tag in tables or offset < 12 + count * 16 or offset + length > min(len(data) - start, 64 * 1024 * 1024):
                    raise ValueError('Invalid font table boundary')
                tables[tag] = (offset, length)
            if not {b'head', b'name', b'cmap', b'maxp'} <= tables.keys():
                continue
            head = start + tables[b'head'][0]
            if struct.unpack_from('>I', data, head + 12)[0] != 0x5F0F3CF5:
                continue
            offset, length = tables[b'name']; base = start + offset
            _, records, strings = struct.unpack_from('>HHH', data, base)
            if records > 512 or 6 + records * 12 > length:
                continue
            names = set()
            for index in range(records):
                platform, _, _, kind, size, relative = struct.unpack_from('>HHHHHH', data, base + 6 + index * 12)
                if kind not in (1, 4, 6) or strings + relative + size > length or size > 512:
                    continue
                raw = data[base + strings + relative:base + strings + relative + size]
                names.add(raw.decode('utf-16-be' if platform in (0, 3) else 'mac_roman'))
            if family not in names:
                continue
            end = max(o + n for o, n in tables.values())
            return data[start:start + end]
        except (ValueError, UnicodeError, struct.error):
            continue


def cache_font(executable, family, root=None):
    if not isinstance(family, str) or not re.fullmatch(r'[A-Za-z0-9_ -]{1,96}', family):
        raise ValueError('Invalid original font family')
    game = Path(executable).resolve(strict=True)
    source = game.parent / (game.stem + '_Data') / 'resources.assets'
    if source.stat().st_size > 256 * 1024 * 1024:
        raise ValueError('Original font resource exceeds scan limit')
    blob = find_font(source.read_bytes(), family)
    digest = hashlib.sha256(blob).hexdigest()
    directory = Path(root) if root else Path(os.environ['USERPROFILE']) / '.bluemilk' / 'font-cache'
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / (digest + '.ttf')
    if not output.exists() or hashlib.sha256(output.read_bytes()).hexdigest() != digest:
        temporary = output.with_suffix('.tmp')
        temporary.write_bytes(blob); temporary.replace(output)
    return {'path': str(output.resolve()), 'sha256': digest, 'family': family, 'bytes': len(blob), 'source': 'local-original-game'}
