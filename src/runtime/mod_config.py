"""Persistent package-scoped configuration; never executes or hot-reloads a Mod."""
import hashlib
import json
import math
import os
from pathlib import Path
import uuid

from mod_store import directory, locked, _registration, _lease
from mod_package import unique_object
from mod_config_schema import resolve


def encode(values):
    def check(value, depth=0):
        if depth > 16:
            raise ValueError('Configuration nesting exceeds 16 levels')
        if value is None or type(value) in (bool, str):
            return
        if type(value) in (int, float):
            if not math.isfinite(value) or abs(value) > 9007199254740991:
                raise ValueError('Configuration number is outside portable JSON range')
            return
        if type(value) is list:
            for item in value:
                check(item, depth + 1)
            return
        if type(value) is dict and all(type(key) is str for key in value):
            for item in value.values():
                check(item, depth + 1)
            return
        raise ValueError('Configuration requires JSON values')
    if type(values) is not dict:
        raise ValueError('Configuration must be a JSON object')
    check(values)
    raw = json.dumps(values, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                     allow_nan=False).encode('ascii')
    if len(raw) > 8192:
        raise ValueError('Configuration exceeds 8 KiB')
    return raw


def _read(root, sha, schema):
    path = root / 'config' / (sha + '.json')
    if path.exists():
        with path.open('rb') as stream:
            raw = stream.read(8193)
        if len(raw) > 8192:
            raise ValueError('Stored configuration exceeds 8 KiB')
        values = json.loads(raw, object_pairs_hook=unique_object)
    else:
        values = {}
    raw = encode(values)
    return {'sha256': sha, 'revision': hashlib.sha256(raw).hexdigest(),
            'values': resolve(schema, values), 'schema': schema}


def read(sha, root=None):
    root = Path(root) if root else directory()
    with locked(root):
        manifest, _, _ = _registration(sha, root)
        return _read(root, sha, manifest.get('configuration'))


def write(sha, revision, values, root=None):
    raw = encode(values)
    root = Path(root) if root else directory()
    with locked(root):
        manifest, _, _ = _registration(sha, root)
        schema = manifest.get('configuration')
        raw = encode(resolve(schema, values))
        current = _read(root, sha, schema)
        if revision != current['revision']:
            raise ValueError('Configuration changed; read the latest revision before saving')
        # A disabled but registered package still owns its factory snapshot.
        release = _lease(sha, root)
        try:
            folder = root / 'config'
            folder.mkdir(exist_ok=True)
            temporary = folder / (uuid.uuid4().hex + '.partial')
            try:
                with temporary.open('xb') as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, folder / (sha + '.json'))
            finally:
                temporary.unlink(missing_ok=True)
            return {**_read(root, sha, schema), 'activation': 'next-registration'}
        finally:
            release()
