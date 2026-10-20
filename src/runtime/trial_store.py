"""Exact installed trial snapshots and leases; no game execution."""
from pathlib import Path
from mod_store import directory, locked, _registration, _lease, install
from mod_profile import _read as read_profile
from mod_config import _read as read_config


def snapshot(bundled_path, bundled_sha, root=None, *, identity="bluemilk.trial", capability="battle.trial"):
    root = Path(root) if root else directory()
    with locked(root):
        selected = read_profile(root)['selections'].get(identity)
        if selected:
            return _snapshot(root, selected['sha256'], identity, capability)
    # Installation honors a previous explicit uninstall. Selection is read again
    # under the store lock, so a concurrent profile change is never half applied.
    installed = install(bundled_path, bundled_sha, root, bundled=True)
    with locked(root):
        selected = read_profile(root)['selections'].get(identity)
        if not selected and installed.get('suppressed'):
            raise ValueError(identity + ' Mod was uninstalled; explicitly install it before preparing')
        sha = selected['sha256'] if selected else bundled_sha
        return _snapshot(root, sha, identity, capability)


def _snapshot(root, sha, identity, capability):
    manifest, source, sha = _registration(sha, root)
    if (manifest['id'] != identity or manifest['capabilities'] != [capability]
            or manifest['dependencies']):
        raise ValueError('Standalone official trial package required')
    config = read_config(root, sha, manifest.get('configuration'))
    return dict(manifest=manifest, source=source, sha256=sha,
                configuration=config['values'], configurationRevision=config['revision'])


def acquire(manifest, root=None):
    """Acquire both managed packages atomically; rollback if either is unavailable."""
    references = []
    for key, hash_key, identity, capability in (
            ('managedTrialPackage', 'trialPackageSha256', 'bluemilk.trial', 'battle.trial'),
            ('managedControlPackage', 'controlPackageSha256', 'bluemilk.battle-control', 'battle.control')):
        reference = manifest.get(key)
        if reference is None:
            continue
        if (type(reference) is not dict or set(reference) != {'sha256', 'configurationRevision'}
                or reference['sha256'] != manifest.get(hash_key)):
            raise ValueError('Invalid managed trial package reference')
        references.append((reference, identity, capability))
    if not references:
        return lambda: None  # Legacy standalone executable artifacts.
    root = Path(root) if root else directory()
    releases = []
    def release_all():
        while releases:
            releases[-1]()
            releases.pop()
    with locked(root):
        try:
            for reference, identity, capability in references:
                record = _snapshot(root, reference['sha256'], identity, capability)
                if record['configurationRevision'] != reference['configurationRevision']:
                    raise ValueError('Trial configuration changed; prepare a new trial')
                releases.append(_lease(record['sha256'], root))
        except Exception:
            release_all()
            raise
    return release_all
