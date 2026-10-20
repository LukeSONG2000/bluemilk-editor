"""Exact installed trial snapshots and leases; no game execution."""
from pathlib import Path
from mod_store import directory, locked, _registration, _lease, install
from mod_profile import _read as read_profile
from mod_config import _read as read_config


def snapshot(bundled_path, bundled_sha, root=None):
    root = Path(root) if root else directory()
    with locked(root):
        selected = read_profile(root)['selections'].get('bluemilk.trial')
        if selected:
            return _snapshot(root, selected['sha256'])
    # Installation honors a previous explicit uninstall. Selection is read again
    # under the store lock, so a concurrent profile change is never half applied.
    installed = install(bundled_path, bundled_sha, root, bundled=True)
    with locked(root):
        selected = read_profile(root)['selections'].get('bluemilk.trial')
        if not selected and installed.get('suppressed'):
            raise ValueError('Trial Mod was uninstalled; explicitly install it before preparing')
        sha = selected['sha256'] if selected else bundled_sha
        return _snapshot(root, sha)


def _snapshot(root, sha):
    manifest, source, sha = _registration(sha, root)
    if (manifest['id'] != 'bluemilk.trial' or manifest['capabilities'] != ['battle.trial']
            or manifest['dependencies']):
        raise ValueError('Standalone official trial package required')
    config = read_config(root, sha, manifest.get('configuration'))
    return dict(manifest=manifest, source=source, sha256=sha,
                configuration=config['values'], configurationRevision=config['revision'])


def acquire(manifest, root=None):
    """Legacy standalone artifacts do not claim shared-store ownership."""
    references = manifest.get('managedTrialPackage')
    if references is None:
        return lambda: None
    if (type(references) is not dict or set(references) != {'sha256', 'configurationRevision'}
            or references['sha256'] != manifest.get('trialPackageSha256')):
        raise ValueError('Invalid managed trial package reference')
    root = Path(root) if root else directory()
    with locked(root):
        package, _, sha = _registration(references['sha256'], root)
        if package['id'] != 'bluemilk.trial':
            raise ValueError('Managed trial package identity mismatch')
        # The frozen source contains the configuration used when prepared. A
        # subsequent edit requires new preparation rather than silent replay.
        config = read_config(root, sha, package.get('configuration'))
        if config['revision'] != references['configurationRevision']:
            raise ValueError('Trial configuration changed; prepare a new trial')
        return _lease(sha, root)
