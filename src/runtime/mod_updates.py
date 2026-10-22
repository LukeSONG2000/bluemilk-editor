"""GitHub stable Mod updates, shared by Desktop and CLI; never execute downloads."""
import hashlib
import json
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from mod_package import LIMIT, inspect_bytes, unique_object, valid_version
from mod_store import registration, install, directory


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url, *, binary=False, limit=2 * 1024 * 1024):
    opener = urllib.request.build_opener(NoRedirect())
    for hop in range(5):
        headers = {'User-Agent': 'BlueMilk-Editor', 'Accept':
                   'application/octet-stream' if binary else 'application/vnd.github+json'}
        if hop == 0:
            headers['X-GitHub-Api-Version'] = '2022-11-28'
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=20) as response:
                raw = response.read(limit + 1)
                if len(raw) > limit:
                    raise ValueError('GitHub response exceeds size limit')
                return raw
        except urllib.error.HTTPError as error:
            if not binary or error.code not in (301, 302, 303, 307, 308):
                raise
            target = error.headers.get('Location', '')
            parsed = urlsplit(target)
            if (parsed.scheme != 'https' or parsed.netloc not in
                    ('release-assets.githubusercontent.com', 'github-releases.githubusercontent.com')):
                raise ValueError('Unsupported GitHub asset redirect') from error
            url = target
            error.close()
    raise ValueError('Too many GitHub redirects')


def version(value):
    if not valid_version(value):
        raise ValueError('Invalid release version')
    return tuple(map(int, value.split('.')))


def parse_release(manifest, release):
    if release.get('draft') is not False or release.get('prerelease') is not False:
        raise ValueError('Expected a published stable release')
    tag = release.get('tag_name', '')
    latest = tag[1:] if isinstance(tag, str) and tag.startswith('v') else ''
    newer = version(latest) > version(manifest['version'])
    result = {'state': 'update-available' if newer else 'up-to-date',
              'currentVersion': manifest['version'], 'latestVersion': latest,
              'repository': manifest['repository'], 'publishedAt': release.get('published_at')}
    if not newer:
        return result
    definition = manifest.get('updates')
    # Repository-only packages work if the stable release has one .bluemilk asset.
    expected = definition['asset'].replace('{version}', latest) if definition else None
    assets = [a for a in release.get('assets', []) if
              (a.get('name') == expected if expected else
               isinstance(a.get('name'), str) and a['name'].endswith('.bluemilk'))]
    if len(assets) != 1:
        raise ValueError('Release must contain exactly one matching .bluemilk asset')
    asset = assets[0]
    size, asset_id, digest = asset.get('size'), asset.get('id'), asset.get('digest', '')
    if (asset.get('state') != 'uploaded' or type(size) is not int or not 0 < size <= LIMIT
            or type(asset_id) is not int or asset_id <= 0
            or not isinstance(digest, str) or not re.fullmatch(r'sha256:[a-fA-F0-9]{64}', digest)):
        raise ValueError('Release asset lacks valid size or SHA-256')
    return {**result, 'assetId': asset_id, 'size': size, 'sha256': digest[7:].lower(),
            'name': asset['name']}


def check(sha256, root=None):
    manifest, _, _ = registration(sha256, root)
    repository = manifest.get('repository')
    if not repository:
        return {'state': 'no-repository', 'currentVersion': manifest['version']}
    api = 'https://api.github.com/repos/' + repository.removeprefix('https://github.com/')
    try:
        release = json.loads(fetch(api + '/releases/latest'), object_pairs_hook=unique_object)
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        if code == 404:
            try:
                fetch(api)
                state = 'no-release'
            except urllib.error.HTTPError as repo_error:
                state = 'repository-unavailable' if repo_error.code == 404 else 'access-denied-or-rate-limited'
                repo_error.close()
        else:
            state = 'access-denied-or-rate-limited' if code in (401, 403, 429) else 'http-error'
        return {'state': state, 'repository': repository, 'currentVersion': manifest['version']}
    return parse_release(manifest, release)


def update(sha256, expected_version, expected_sha256, root=None):
    # Recheck before mutation; the checked release may have changed since confirmation.
    selected = check(sha256, root)
    if (selected['state'] != 'update-available' or selected['latestVersion'] != expected_version
            or selected['sha256'] != expected_sha256):
        raise ValueError('Release changed since update check; check again')
    api = 'https://api.github.com/repos/' + selected['repository'].removeprefix('https://github.com/')
    raw = fetch(api + '/releases/assets/' + str(selected['assetId']), binary=True, limit=LIMIT)
    if len(raw) != selected['size'] or hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError('Downloaded Mod size or hash mismatch')
    record = inspect_bytes(raw)
    previous, _, _ = registration(sha256, root)
    manifest = record['manifest']
    if (manifest['id'] != previous['id'] or manifest['version'] != expected_version
            or version(manifest['version']) <= version(previous['version'])
            or manifest.get('repository', '').lower() != previous['repository'].lower()):
        raise ValueError('Downloaded Mod ID, version or repository differs from selected package')
    store = Path(root) if root else directory()
    store.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='update-', dir=store) as temporary:
        path = Path(temporary) / 'update.bluemilk'
        path.write_bytes(raw)
        return install(path, expected_sha256, root)
