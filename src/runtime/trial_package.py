"""Read a standalone official trial package as one verified byte snapshot."""
import hashlib
import io
from pathlib import Path
import zipfile
from mod_package import inspect_bytes, LIMIT


def read_trial_package(path, expected_sha=None):
    with Path(path).open('rb') as stream:
        raw=stream.read(LIMIT+1)
    if expected_sha is not None and hashlib.sha256(raw).hexdigest()!=expected_sha:
        raise ValueError('Trial package integrity mismatch')
    record=inspect_bytes(raw)
    m=record['manifest']
    if m['id']!='bluemilk.trial' or m['capabilities']!=['battle.trial'] or m['dependencies']:
        raise ValueError('Standalone official trial package required')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        source=archive.read(m['entry']).decode('utf8')
    return dict(manifest=m,source=source,sha256=record['sha256'])
