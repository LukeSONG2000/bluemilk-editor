"""Offline original capture preparation using packaged original metadata/modules."""
import hashlib
import json
import uuid
from pathlib import Path
from prepare_captured_trial import prepare, read_capture, read_mode_provenance


def prepare_request(payload, assets, output):
    required = {'battle', 'inventory', 'squadType', 'durationSeconds', 'auto'}
    if not isinstance(payload, dict) or set(payload) != required:
        raise ValueError('Expected battle, inventory, squadType, durationSeconds and auto')
    if any(not isinstance(payload[k], str) or not Path(payload[k]).is_absolute() for k in ('battle','inventory')):
        raise ValueError('Select explicit absolute battle and inventory capture paths')
    if type(payload['squadType']) is not int or not 0 <= payload['squadType'] <= 255:
        raise ValueError('Explicit saved squad type required')
    if type(payload['durationSeconds']) is not int or not 15 <= payload['durationSeconds'] <= 600 or type(payload['auto']) is not bool:
        raise ValueError('Invalid duration or auto option')
    _, metadata, info = read_capture(payload['battle'], 'original-battle-proto-captured')
    provenance = read_mode_provenance(payload['battle'], metadata, info)
    if provenance is None:
        raise ValueError('Original battle mode provenance missing; cannot assume PVE compatibility')
    if provenance['battleType'] != 1 or provenance['combatType'] not in (0, 1):
        raise ValueError('Original mode is not supported by the PVE builder')
    folder = Path(assets)/'trial'
    manifest = json.loads((folder/'manifest.json').read_text(encoding='utf8'))
    for name, digest in manifest['files'].items():
        if Path(name).name != name or hashlib.sha256((folder/name).read_bytes()).hexdigest() != digest:
            raise ValueError('Packaged trial resource integrity mismatch')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    prefix = output/('prepared-'+uuid.uuid4().hex)
    result = prepare(payload['battle'], payload['inventory'], None, prefix, payload['squadType'],
                     'visual', payload['durationSeconds'], payload['auto'],
                     schema_bundle=folder/'schema.json', module_root=folder)
    return dict(manifest=str(prefix.with_suffix('.json')), prepared=result,
                started=False, runtimeCompatibilityVerified=False)
