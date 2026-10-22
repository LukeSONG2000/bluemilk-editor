"""Read-only ZIP inspection. Integrity is not publisher authentication or a sandbox."""
from datetime import datetime
import hashlib
import json
import re
import stat
import zipfile
import base64
import struct
from pathlib import Path

LIMIT = 16 * 1024 * 1024
ID = re.compile(r'[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+')
VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key: ' + key)
        result[key] = value
    return result


def valid_id(value):
    return isinstance(value, str) and len(value) <= 128 and ID.fullmatch(value)


def valid_version(value):
    return (isinstance(value, str) and VERSION.fullmatch(value)
            and all(int(x) <= 9007199254740991 for x in value.split('.')))


def validate_manifest(value):
    if not isinstance(value, dict) or not valid_id(value.get('id')):
        raise ValueError('Invalid Mod ID')
    if not valid_version(value.get('version')):
        raise ValueError('Invalid Mod version')
    for key in ('name', *(k for k in ('publisher', 'author') if k in value)):
        text = value.get(key)
        if not isinstance(text, str) or not text.strip() or len(text) > 256:
            raise ValueError('Invalid Mod ' + key)
    if 'publishedAt' in value:
        date = value['publishedAt']
        if not isinstance(date, str) or len(date) > 40:
            raise ValueError('Invalid publishedAt')
        try:
            parsed = datetime.fromisoformat(date.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                raise ValueError()
        except ValueError as error:
            raise ValueError('publishedAt requires an ISO-8601 date with timezone') from error
    if 'repository' in value:
        if not isinstance(value['repository'], str) or not re.fullmatch(
                r'https://github\.com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}', value['repository']):
            raise ValueError('repository requires a canonical HTTPS GitHub repository URL')
        if value['repository'].rsplit('/', 1)[1] in ('.', '..'):
            raise ValueError('Invalid repository')
    if 'updates' in value:
        update = value['updates']
        if (not isinstance(update, dict) or set(update) != {'provider', 'asset'}
                or update['provider'] != 'github' or 'repository' not in value
                or not isinstance(update['asset'], str)
                or update['asset'].count('{version}') != 1
                or not re.fullmatch(r'[A-Za-z0-9_.-]*\{version\}[A-Za-z0-9_.-]*\.bluemilk', update['asset'])
                or len(update['asset']) > 180):
            raise ValueError('Invalid GitHub updates definition')
    if type(value.get('sdkVersion')) is not int or value['sdkVersion'] not in (1, 2):
        raise ValueError('Unsupported SDK')
    if value.get('gameProfile') != 'swgoh-0.40.7':
        raise ValueError('Unsupported game profile')
    for key in ('capabilities', 'presentations', 'dependencies', 'conflicts'):
        items = value.get(key)
        if (not isinstance(items, list) or any(not isinstance(x, str) for x in items)
                or len(set(items)) != len(items)):
            raise ValueError('Invalid Mod ' + key)
    if not value['presentations'] or set(value['presentations']) - {'desktop', 'cli'}:
        raise ValueError('Invalid presentations')
    for key in ('dependencies', 'conflicts'):
        if any(not valid_id(x) or x == value['id'] for x in value[key]):
            raise ValueError('Invalid Mod ' + key)
    if set(value['dependencies']) & set(value['conflicts']):
        raise ValueError('Dependency also conflicts')
    versions = value.get('dependencyVersions', {})
    if (not isinstance(versions, dict) or any(k not in value['dependencies'] or not valid_version(v)
                                             for k, v in versions.items())):
        raise ValueError('Invalid dependencyVersions')
    if 'configuration' in value:
        from mod_config_schema import validate_schema
        validate_schema(value['configuration'])
    if 'desktop' in value:
        from mod_desktop_schema import validate
        validate(value['desktop'])
    if 'icon' in value and (not isinstance(value['icon'], str) or not safe_name(value['icon']).endswith('.png')):
        raise ValueError('Icon must be a package-local PNG path')
    return value


def safe_name(name):
    # Deliberately portable ASCII subset: no Windows aliases, ADS, or directory entries.
    if not isinstance(name, str) or len(name) > 200 or '\\' in name:
        raise ValueError('Invalid package path')
    for part in name.split('/'):
        if (not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', part)
                or part.endswith('.') or part.split('.')[0].upper() in
                {'CON', 'PRN', 'AUX', 'NUL', *('COM'+str(i) for i in range(10)),
                 *('LPT'+str(i) for i in range(10))}):
            raise ValueError('Invalid package path: ' + name)
    return name


def inspect_package(path):
    source = Path(path)
    if not source.is_absolute():
        raise ValueError('Package path must be absolute')
    with source.open('rb') as stream:
        raw = stream.read(LIMIT + 1)
    return inspect_bytes(raw)


def inspect_bytes(raw):
    icon_base64 = None
    if len(raw) > LIMIT:
        raise ValueError('Package exceeds 16 MiB')
    import io
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if not 2 <= len(entries) <= 128:
            raise ValueError('Package requires 2–128 files')
        names = set()
        total = 0
        for item in entries:
            safe_name(item.filename)
            folded = item.filename.casefold()
            if folded in names:
                raise ValueError('Duplicate or case-aliased package path')
            names.add(folded)
            kind = stat.S_IFMT(item.external_attr >> 16)
            if kind not in (0, stat.S_IFREG) or item.flag_bits & 1:
                raise ValueError('Links, directories and encrypted files are unsupported')
            total += item.file_size
            if total > LIMIT:
                raise ValueError('Expanded package exceeds 16 MiB')
        for name in names:
            parts = name.split('/')
            if any('/'.join(parts[:i]) in names for i in range(1, len(parts))):
                raise ValueError('Package file is also a parent directory')
        if 'mod.json' not in archive.namelist():
            raise ValueError('Package requires mod.json')
        if archive.getinfo('mod.json').file_size > 65536:
            raise ValueError('Manifest exceeds 64 KiB')
        manifest = json.loads(archive.read('mod.json').decode('utf-8'), object_pairs_hook=unique_object)
        validate_manifest(manifest)
        if type(manifest.get('packageVersion')) is not int or manifest['packageVersion'] != 1:
            raise ValueError('Unsupported packageVersion')
        entry = safe_name(manifest.get('entry'))
        files = manifest.get('files')
        if (not isinstance(files, dict) or set(files) != set(archive.namelist()) - {'mod.json'}
                or entry not in files or not entry.endswith('.js')):
            raise ValueError('File inventory or JavaScript entry does not match package')
        for name, digest in files.items():
            if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
                raise ValueError('Invalid SHA-256 digest')
            content = archive.read(name)
            if hashlib.sha256(content).hexdigest() != digest:
                raise ValueError('File hash mismatch: ' + name)
            if name == entry:
                content.decode('utf-8')
        if 'icon' in manifest:
            icon = manifest['icon']
            if icon not in files:
                raise ValueError('Icon is absent from package inventory')
            data = archive.read(icon)
            if (len(data) < 33 or len(data) > 262144 or data[:8] != b'\x89PNG\r\n\x1a\n'
                    or data[8:16] != b'\x00\x00\x00\rIHDR'
                    or any(n < 1 or n > 256 for n in struct.unpack('>II', data[16:24]))):
                raise ValueError('Icon must be a PNG up to 256x256 and 256 KiB')
            icon_base64 = base64.b64encode(data).decode('ascii')
    return {'manifest': manifest, 'sha256': hashlib.sha256(raw).hexdigest(),
            'iconBase64': icon_base64,
            'bytes': len(raw), 'expandedBytes': total, 'executed': False,
            'publisherAuthenticated': False,
            'compatibility': 'Manifest checked; installed dependency graph and live game not checked'}
