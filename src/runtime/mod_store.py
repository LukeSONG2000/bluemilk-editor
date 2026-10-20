"""Shared immutable package storage. Installation never executes a Mod."""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import uuid

from mod_package import LIMIT, inspect_bytes, inspect_package


def directory():
    return Path(os.environ['USERPROFILE']) / '.bluemilk' / 'mods'


@contextmanager
def locked(root):
    import msvcrt
    root.mkdir(parents=True, exist_ok=True)
    # OS releases the lock after a crash. Never unlink a shared lock file.
    with (root / 'store.lock').open('a+b') as handle:
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise RuntimeError('Another Mod store operation is in progress; retry later') from error
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def _discover(root):
    packages = []
    objects = root / 'packages'
    paths = sorted(objects.glob('*.bluemilk'))
    if len(paths) > 256:
        raise ValueError('Mod store exceeds 256 packages')
    for path in paths:
        if not re.fullmatch(r'[a-f0-9]{64}', path.stem):
            raise ValueError('Unexpected package filename in store')
        record = inspect_package(path)
        if record['sha256'] != path.stem:
            raise ValueError('Stored package integrity failed: ' + path.name)
        packages.append({**record, 'storageState': 'installed', 'activation': 'not-requested'})
    return packages


def discover(root=None):
    root = Path(root) if root else directory()
    with locked(root):
        return {'packages': _discover(root), 'executed': False}


def registration(sha256, root=None):
    """Return verified bytes from the chosen installed version, never a loose source path."""
    import io
    import zipfile
    if not isinstance(sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', sha256):
        raise ValueError('Expected installed package SHA-256')
    root = Path(root) if root else directory()
    with locked(root):
        with (root / 'packages' / (sha256 + '.bluemilk')).open('rb') as stream:
            raw = stream.read(LIMIT + 1)
        if hashlib.sha256(raw).hexdigest() != sha256:
            raise ValueError('Stored package integrity failed')
        record = inspect_bytes(raw)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            source = archive.read(record['manifest']['entry']).decode('utf-8')
        return record['manifest'], source, sha256


def install(path, expected_sha256, root=None):
    if not isinstance(expected_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', expected_sha256):
        raise ValueError('Expected lowercase SHA-256 from package inspection')
    source = Path(path)
    if not source.is_absolute():
        raise ValueError('Package path must be absolute')
    with source.open('rb') as stream:
        raw = stream.read(LIMIT + 1)
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError('Package changed since inspection')
    record = inspect_bytes(raw)
    root = Path(root) if root else directory()
    with locked(root):
        installed = _discover(root)
        for other in installed:
            if other['sha256'] == expected_sha256:
                return {**other, 'alreadyInstalled': True}
            if (other['manifest']['id'], other['manifest']['version']) == (
                    record['manifest']['id'], record['manifest']['version']):
                raise ValueError('Same Mod ID/version already has different content')
        if len(installed) >= 256:
            raise ValueError('Mod store exceeds 256 packages')
        objects = root / 'packages'
        objects.mkdir(exist_ok=True)
        temporary = objects / (uuid.uuid4().hex + '.partial')
        target = objects / (expected_sha256 + '.bluemilk')
        try:
            with temporary.open('xb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return {**record, 'storageState': 'installed', 'activation': 'not-requested',
                'alreadyInstalled': False}
