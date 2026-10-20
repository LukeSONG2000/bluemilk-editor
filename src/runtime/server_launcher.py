"""Start or discover the shared host. Never connect to the game or retry commands."""
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from server_endpoint import directory, read_endpoint


def ensure_server(timeout=25):
    endpoint = read_endpoint()
    if endpoint is not None:
        return endpoint
    root = directory()
    root.mkdir(parents=True, exist_ok=True)
    log = root / ('startup-' + uuid.uuid4().hex + '.log')
    command = ([sys.executable, '--app-server'] if getattr(sys, 'frozen', False) else
               [sys.executable, str(Path(__file__).with_name('desktop_host.py')), '--app-server'])
    # A frozen child must unpack independently: the launching CLI can exit first.
    env = dict(os.environ, PYINSTALLER_RESET_ENVIRONMENT='1')
    with log.open('xb') as output:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                 env=env, creationflags=subprocess.CREATE_NO_WINDOW)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        endpoint = read_endpoint()
        if endpoint is not None:
            return endpoint
        # A racing starter may exit because another host owns the mutex but has
        # not published yet. Continue discovery; do not spawn another process.
        time.sleep(0.1)
    raise RuntimeError(f'Shared server startup unconfirmed; no commands sent. Check {log}; '
                       f'launcher PID {child.pid}, exit status {child.poll()}')
