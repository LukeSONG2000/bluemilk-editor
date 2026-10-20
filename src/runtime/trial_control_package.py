"""Validate an explicitly selected battle-control package for an isolated trial."""
import hashlib
import io
import json
from pathlib import Path
import zipfile
from mod_package import inspect_bytes, LIMIT


def read_control(request):
    if not isinstance(request, dict) or set(request) != {'package', 'sha256', 'policy'}:
        raise ValueError('Control requires explicit package, sha256 and policy')
    if not isinstance(request['package'], str) or not Path(request['package']).is_absolute():
        raise ValueError('Control package requires an absolute path')
    policy = request['policy']
    if (not isinstance(policy, dict) or set(policy) != {'enabled', 'oneClickTaunt', 'allowedTargets', 'manualUI'}
            or any(type(policy[k]) is not bool for k in ('enabled', 'oneClickTaunt', 'manualUI'))
            or not isinstance(policy['allowedTargets'], list) or len(policy['allowedTargets']) > 16
            or any(not isinstance(v, str) or not v or len(v) > 256 for v in policy['allowedTargets'])
            or len(set(policy['allowedTargets'])) != len(policy['allowedTargets'])):
        raise ValueError('Invalid trial control policy')
    if policy['manualUI'] and (policy['enabled'] or policy['oneClickTaunt'] or policy['allowedTargets']):
        raise ValueError('Manual UI cannot combine with policy control')
    if policy['enabled'] and not policy['oneClickTaunt'] and not policy['allowedTargets']:
        raise ValueError('Select permitted targets or one-click taunt')
    with Path(request['package']).open('rb') as stream:
        raw = stream.read(LIMIT + 1)
    if hashlib.sha256(raw).hexdigest() != request['sha256']:
        raise ValueError('Selected control package integrity mismatch')
    record = inspect_bytes(raw)
    manifest = record['manifest']
    if (manifest['id'] != 'bluemilk.battle-control' or manifest['capabilities'] != ['battle.control']
            or manifest['dependencies']):
        raise ValueError('This trial adapter requires the standalone official battle-control package')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entry = archive.read(manifest['entry']).decode('utf8')
    return dict(manifest=manifest, source=entry, sha256=record['sha256'], policy=json.loads(json.dumps(policy)))
