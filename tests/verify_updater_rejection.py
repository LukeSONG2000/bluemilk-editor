"""Run the published self-contained helper against invalid jobs; no installs."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
helper = str(Path(sys.argv[1]).resolve())
root = ROOT / 'logs' / ('updater-rejection-' + uuid.uuid4().hex[:8])
root.mkdir()
results = {}
for case in ('wrong-hash', 'wrong-size', 'unsigned-msix', 'invalid-channel', 'relative-install'):
    folder = root / case
    folder.mkdir()
    package = folder / 'package.bin'
    package.write_bytes(b'not an installer')
    job = dict(SchemaVersion=1, Channel='exe', Version='0.1.10.0', PackagePath=str(package),
        Size=package.stat().st_size, Sha256=hashlib.sha256(package.read_bytes()).hexdigest(),
        InstallDirectory=str(folder / 'install'), ServerDirectory=str(folder / 'server'),
        ParentPid=2147483647, ParentStartedUtcTicks=1)
    if case == 'wrong-hash': job['Sha256'] = '0' * 64
    if case == 'wrong-size': job['Size'] += 1
    if case == 'unsigned-msix': job['Channel'] = 'msix'
    if case == 'invalid-channel': job['Channel'] = 'other'
    if case == 'relative-install': job['InstallDirectory'] = 'relative'
    path = folder / 'job.json'
    path.write_text(json.dumps(job))
    command = [helper, str(path)]
    run = subprocess.run(command, timeout=20, capture_output=True,
        env={**os.environ, 'PATH': r'C:\Windows\System32'}, creationflags=subprocess.CREATE_NO_WINDOW)
    assert run.returncode == 1, (case, run.stderr)
    receipt = (folder / 'receipt.json').read_bytes()
    record = json.loads(receipt)
    assert record['state'] == 'failed' and record['phase'] == 'validating', record
    assert not (folder / 'install').exists()
    retry = subprocess.run(command, timeout=20, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    assert retry.returncode == 3
    assert (folder / 'receipt.json').read_bytes() == receipt
    results[case] = 'rejected; receipt retained; replay refused'
(root / 'result.json').write_text(json.dumps(results, indent=2))
print(json.dumps({'evidence':str(root),'cases':results}))
