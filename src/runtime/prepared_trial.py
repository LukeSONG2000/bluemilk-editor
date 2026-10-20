"""Own an explicitly prepared native trial without Node/npm or a second injection."""
import hashlib
import json
import threading
from pathlib import Path


def cleanup_complete(result, mode):
    if not isinstance(result, dict):
        return False
    clean = result.get('cleanup')
    if not isinstance(clean, dict) or clean.get('guardRestored') is not True or clean.get('gcReleased') is not True or clean.get('errors') != []:
        return False
    if mode == 'visual':
        return clean.get('home') is True
    if mode != 'headless' or clean.get('hooksDetached') is not True:
        return False
    return clean.get('loopStopped') is True or (clean.get('attempted') is False and type(result.get('ticks')) is int and result['ticks'] == 0)


def read_prepared(path, expected):
    manifest = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if (manifest.get('schemaVersion') != 1 or manifest.get('mode') not in ('visual', 'headless')
            or type(manifest.get('durationSeconds')) is not int or not 15 <= manifest['durationSeconds'] <= 600
            or manifest.get('originalAssemblySha256') != expected):
        raise ValueError('Invalid prepared trial manifest or game revision')
    # Prepared source is executable code, not an untrusted replay file. A caller
    # must explicitly select a locally prepared manifest; never auto-discover/run.
    source = Path(manifest['source']).read_bytes()
    if hashlib.sha256(source).hexdigest() != manifest.get('sourceSha256'):
        raise ValueError('Prepared source integrity mismatch')
    return manifest, source.decode('utf-8-sig')


class PreparedTrial:
    def __init__(self, manifest, source, evidence, attach, acquire):
        self.manifest, self.source = manifest, source
        self.evidence = Path(evidence)
        self.attach, self.acquire = attach, acquire
        self.session = self.script = self.release = None
        self.complete = None
        self.messages = []
        self.errors = []
        self.pid = None
        self.detached = False
        self.started = False
        self.stop_sent = False
        self.done = threading.Event()
        self.lock = threading.RLock()
        # Reserve evidence before taking ownership or running native code.
        self.evidence.parent.mkdir(parents=True, exist_ok=True)
        with self.evidence.open('x', encoding='utf8') as stream:
            json.dump({'starting': True}, stream)

    def persist(self):
        with self.lock:
            temporary = self.evidence.with_suffix(self.evidence.suffix + '.tmp')
            temporary.write_text(json.dumps(self.status(), ensure_ascii=False, indent=2), encoding='utf8')
            try:
                temporary.replace(self.evidence)
            except OSError as error:
                if getattr(error, 'winerror', None) != 17:
                    raise
                # Some encrypted Windows directories reject replacement even
                # for siblings. This file is our reserved evidence, not state
                # used to authorize native actions. Readers wait for IPC close.
                self.evidence.write_bytes(temporary.read_bytes())
                temporary.unlink()

    def cleanup_confirmed(self):
        if not cleanup_complete(self.complete, self.manifest['mode']):
            return False
        expected=self.manifest.get('trialPackageSha256')
        if not expected:
            return True
        trial=self.complete.get('trialMod', {})
        mods=trial.get('registry', {}).get('mods', [])
        return (trial.get('packageSha256')==expected and isinstance(mods,list) and bool(mods)
                and all(isinstance(m,dict) and m.get('state')=='disabled' for m in mods)
                and any(m.get('manifest',{}).get('id')=='bluemilk.trial' and m.get('packageSha256')==expected for m in mods))

    def status(self):
        with self.lock:
            return dict(pid=self.pid, mode=self.manifest['mode'], detached=self.detached,
                        stopSent=self.stop_sent, completion=self.complete,
                        cleanupConfirmed=self.cleanup_confirmed(),
                        errors=list(self.errors), messages=list(self.messages))

    def message(self, message, data):
        with self.lock:
            self.messages.append(message)
            payload = message.get('payload', {})
            expected = 'visual-probe-complete' if self.manifest['mode'] == 'visual' else 'simulation-probe-complete'
            if message.get('type') == 'send' and payload.get('kind') == expected:
                self.complete = payload
                self.done.set()
            if message.get('type') == 'error':
                self.errors.append(message.get('description', 'Native script error'))
            try:
                self.persist()
            except Exception as error:
                self.errors.append('Evidence persistence failed: ' + str(error))

    def start(self, pid):
        if self.started:
            raise RuntimeError('Trial start cannot be replayed')
        self.started = True
        self.pid = pid
        self.release = self.acquire(pid)
        try:
            self.session = self.attach(pid)
            self.script = self.session.create_script(self.source)
            self.script.on('message', self.message)
            self.script.load()
            self.persist()
        except Exception:
            # Once a script exists, load may already have executed callbacks.
            if self.script is None:
                self.close()
            raise

    def snapshot(self):
        if self.script is None or self.detached or self.complete is not None:
            raise RuntimeError('No active prepared trial')
        return self.script.exports_sync.snapshot({'detailScope': 'selected'})

    def control(self, payload):
        if (self.script is None or self.detached or self.complete is not None or self.stop_sent
                or not self.manifest.get('controlPackageSha256')):
            raise RuntimeError('No active packaged-control trial')
        if (not isinstance(payload, dict) or set(payload) != {'command', 'payload'}
                or payload['command'] not in ('status', 'configure', 'enemy-input', 'disable')
                or not isinstance(payload['payload'], dict)):
            raise ValueError('Expected trial control command and payload')
        return self.script.exports_sync.trialmodcommand(payload['command'], payload['payload'])

    def stop(self):
        if self.complete is not None:
            return self.status()
        if self.script is None or self.detached or self.manifest.get('battleCli') is not True:
            raise RuntimeError('Trial stop unavailable')
        if not self.stop_sent:
            # Set before dispatch: an RPC exception must never cause replay.
            self.stop_sent = True
            if self.manifest.get('trialPackageSha256'):
                self.script.exports_sync.trialstop()
            else:
                self.script.exports_sync.trialcommand('demo-control', {'action': 'stop'})
        return self.status()

    def close(self):
        if self.detached:
            return self.status()
        if self.script is not None and not self.cleanup_confirmed():
            raise RuntimeError('Native cleanup unconfirmed; retain host, script and session ownership')
        if self.session is not None:
            self.session.detach()
            self.session = None
        if self.release is not None:
            self.release()
            self.release = None
        self.detached = True
        self.persist()
        return self.status()
