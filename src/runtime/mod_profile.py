"""Shared exact-version startup selection. Saving never executes a Mod."""
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

from mod_package import unique_object, valid_id
from mod_store import directory, locked, _registration, _lease


def _encode(selections):
    if type(selections) is not dict or len(selections) > 32:
        raise ValueError('Startup profile requires at most 32 Mod selections')
    for identity, item in selections.items():
        if (not valid_id(identity) or type(item) is not dict or set(item) != {'sha256', 'enabled'}
                or type(item['enabled']) is not bool or type(item['sha256']) is not str
                or not re.fullmatch('[a-f0-9]{64}', item['sha256'])):
            raise ValueError('Invalid startup Mod selection')
    return json.dumps({'version': 1, 'selections': selections}, sort_keys=True,
                      separators=(',', ':')).encode('ascii')


def _read(root):
    path = root / 'profile.json'
    if path.exists():
        with path.open('rb') as stream:
            raw = stream.read(16385)
        if len(raw) > 16384:
            raise ValueError('Startup profile exceeds 16 KiB')
        value = json.loads(raw, object_pairs_hook=unique_object)
        if (type(value) is not dict or set(value) != {'version', 'selections'}
                or type(value['version']) is not int or value['version'] != 1):
            raise ValueError('Invalid startup profile format')
        selections = value['selections']
    else:
        selections = {}
    raw = _encode(selections)
    return {'selections': selections, 'revision': hashlib.sha256(raw).hexdigest()}


def _resolve(root, selections):
    _encode(selections)
    packages = {}
    for identity, item in selections.items():
        payload = _registration(item['sha256'], root)
        if payload[0]['id'] != identity:
            raise ValueError('Selected package ID mismatch: ' + identity)
        packages[identity] = payload
    visiting, ordered = set(), []
    controllers = [identity for identity, payload in packages.items()
                   if selections[identity]['enabled'] and 'battle.control' in payload[0]['capabilities']]
    if len(controllers) > 1:
        raise ValueError('Conflicting startup Mods own exclusive battle.control capability')
    def visit(identity):
        if identity in visiting:
            raise ValueError('Cyclic startup Mod dependencies')
        if identity in ordered:
            return
        visiting.add(identity)
        manifest = packages[identity][0]
        for dependency in manifest['dependencies']:
            if selections[identity]['enabled']:
                if dependency not in selections or not selections[dependency]['enabled']:
                    raise ValueError('Startup dependency must be selected and enabled: ' + dependency)
                required = manifest.get('dependencyVersions', {}).get(dependency)
                if required and packages[dependency][0]['version'] != required:
                    raise ValueError('Startup dependency version mismatch: ' + dependency)
            if dependency in selections:
                visit(dependency)
        visiting.remove(identity)
        ordered.append(identity)
    for identity in sorted(selections):
        visit(identity)
        if selections[identity]['enabled']:
            for conflict in packages[identity][0]['conflicts']:
                if selections.get(conflict, {}).get('enabled'):
                    raise ValueError('Conflicting startup Mods: ' + identity + ' / ' + conflict)
    return [(identity, packages[identity]) for identity in ordered]


def read(root=None):
    root = Path(root) if root else directory()
    with locked(root):
        # Keep corrupt/missing packages recoverable by editing a valid profile.
        return _read(root)


def write(revision, selections, root=None):
    raw = _encode(selections)
    root = Path(root) if root else directory()
    with locked(root):
        current = _read(root)
        if current['revision'] != revision:
            raise ValueError('Startup profile changed; refresh before saving')
        _resolve(root, selections)
        affected = set(current['selections']) | set(selections)
        hashes = {entry['sha256'] for identity in affected
                  if current['selections'].get(identity) != selections.get(identity)
                  for entry in (current['selections'].get(identity), selections.get(identity)) if entry}
        releases = []
        try:
            for sha in sorted(hashes):
                releases.append(_lease(sha, root))
            temporary = root / (uuid.uuid4().hex + '.partial')
            try:
                with temporary.open('xb') as stream:
                    stream.write(raw); stream.flush(); os.fsync(stream.fileno())
                os.replace(temporary, root / 'profile.json')
            finally:
                temporary.unlink(missing_ok=True)
            return {**_read(root), 'activation': 'next-connection'}
        finally:
            for release in reversed(releases):
                release()


def acquire(root=None):
    root = Path(root) if root else directory()
    with locked(root):
        profile = _read(root)
        packages = _resolve(root, profile['selections'])
        acquired = {}
        try:
            for _, payload in packages:
                acquired[payload[2]] = (payload, _lease(payload[2], root))
            return profile, packages, acquired
        except Exception:
            for _, release in acquired.values():
                release()
            raise


def assert_not_selected(root, sha):
    if any(item['sha256'] == sha for item in _read(root)['selections'].values()):
        raise ValueError('Remove this version from the startup profile before uninstalling')
