"""Client of an existing private host. Never attaches to or owns the game."""
import json
from pathlib import Path
import time
import uuid
import psutil


class TrialClient:
    def __init__(self, directory, pid):
        if type(pid) is not int or pid <= 0:
            raise ValueError('Expected positive game PID')
        self.directory = Path(directory).resolve(strict=True)
        self.pid = pid
        self.host = None
        self.birth = None
        self.closed = False
        owner = self.owner()
        self.host = owner['hostPid']
        self.birth = psutil.Process(self.host).create_time()
        self.owner()

    def read(self, path):
        return json.loads(path.read_text(encoding='utf-8-sig'))

    def owner(self):
        if self.closed:
            raise RuntimeError('Trial mailbox disconnected')
        owner = self.read(self.directory/f'trial-status-{self.pid}.json')
        host = owner.get('hostPid')
        if (owner.get('pid') != self.pid or owner.get('kind') != 'captured-trial'
                or owner.get('detached') is not False or owner.get('battleCli') is not True
                or owner.get('needsAttention') or type(host) is not int or host <= 0):
            raise RuntimeError('No controllable private trial')
        process = psutil.Process(host)
        if self.host is not None and (host != self.host or process.create_time() != self.birth):
            raise RuntimeError('Private host changed; reconnect explicitly')
        if self.read(self.directory/f'runtime-session-{self.pid}.lock') != {'hostPid':host,'gamePid':self.pid}:
            raise RuntimeError('Private host ownership mismatch')
        return owner

    def snapshot(self):
        owner = self.owner()
        path = self.directory/f'trial-snapshot-{self.pid}.json'
        data = self.read(path)
        if data.get('pid') != self.pid or data.get('hostPid') != owner['hostPid'] or data.get('trial') is not True:
            raise RuntimeError('Private snapshot ownership mismatch')
        age = time.time()-path.stat().st_mtime
        if age < -2 or age > 10:
            raise RuntimeError('Private snapshot is stale')
        return dict(data, snapshotAgeSeconds=age, transport='private-host-mailbox')

    def call(self, operation, payload=None):
        if operation == 'inspect':
            if payload:
                raise ValueError('Private snapshot scope is owned by the existing host')
            return self.snapshot()
        if operation == 'battleinspect':
            if payload == {'close':True}:
                command = {'action':'inspect-close'}
            elif isinstance(payload, dict) and set(payload) == {'unitId'} and isinstance(payload['unitId'], str) and 1 <= len(payload['unitId']) <= 256:
                command = {'action':'inspect-unit',**payload}
            else:
                raise ValueError('Expected unitId or close')
            return self.send('demo-control', command)
        raise ValueError('Operation unavailable on private mailbox transport')

    def send(self, operation, payload):
        owner = self.owner()
        identity = str(uuid.uuid4())
        box = self.directory/'commands'
        box.mkdir(exist_ok=True)
        request = box/f'{identity}.request.json'
        temporary = box/f'{identity}.tmp'
        with temporary.open('x', encoding='utf-8') as file:
            json.dump(dict(id=identity,pid=self.pid,hostPid=owner['hostPid'],operation=operation,
                           payload=payload,expiresAt=time.time()*1000+10000),file)
        temporary.replace(request)
        result = box/f'{identity}.result.json'
        deadline = time.monotonic()+25
        while time.monotonic() < deadline:
            if result.exists():
                response = self.read(result)
                if response.get('id') != identity:
                    raise RuntimeError('Command receipt identity mismatch')
                if response.get('ok') is not True:
                    raise RuntimeError(json.dumps(response,ensure_ascii=False))
                return response
            time.sleep(.1)
        request.unlink(missing_ok=True)
        raise RuntimeError(f'Outcome unknown; inspect {result}; do not retry blindly')

    def disconnect(self):
        self.closed = True
        return {'disconnected':True,'hostStopped':False,
                'scope':'Client closed; existing private host retains ownership and its original expiry'}
