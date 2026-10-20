"""Private IPC for explicitly prepared local executable trial artifacts."""
import json
import sys
import time
import uuid
from prepared_trial import PreparedTrial, read_prepared

OPERATIONS = ['capabilities', 'prepare', 'start', 'snapshot', 'status', 'disconnect', 'control']


class PreparedService:
    def __init__(self):
        self.trial = None
        self.start_attempted = False
        self.release_package = None

    def start(self, payload):
        if self.start_attempted:
            raise RuntimeError('Start already attempted; never replay within this worker')
        if not isinstance(payload, dict) or set(payload) != {'manifest'} or not isinstance(payload['manifest'], str) or not payload['manifest']:
            raise ValueError('Expected explicit local prepared manifest path')
        from runtime_core import Runtime, EXPECTED, DATA, find_game
        from session_lock import acquire_session
        import frida
        manifest, source = read_prepared(payload['manifest'], EXPECTED)
        if manifest['mode'] != 'visual' or manifest.get('battleCli') is not True:
            raise ValueError('This entry requires a controllable visual trial')
        self.start_attempted = True
        probe = Runtime()
        try:
            connection = probe.connect(information=False)
            if connection['snapshot']['state'] != 'HomeBaseGameState':
                raise RuntimeError('Return to the tavern before starting a private trial')
        finally:
            probe.disconnect()
        from trial_store import acquire
        self.release_package = acquire(manifest)
        self.trial = PreparedTrial(manifest, source, DATA/'trials'/('trial-'+uuid.uuid4().hex+'.json'), frida.attach, acquire_session)
        game = find_game()
        self.trial.start(game['pid'])
        return dict(started=True, pid=game['pid'], evidence=str(self.trial.evidence))

    def prepare(self, payload):
        if self.trial is not None:
            raise RuntimeError('Finish this trial before preparing another')
        from runtime_core import ASSETS, DATA
        from capture_prepare import prepare_request
        return prepare_request(payload, ASSETS, DATA/'prepared')

    def control(self, payload):
        if self.trial is None:
            raise RuntimeError('No prepared trial started')
        return self.trial.control(payload)

    def snapshot(self):
        if self.trial is None:
            raise RuntimeError('No prepared trial started')
        return self.trial.snapshot()

    def status(self):
        return self.trial.status() if self.trial else {'started': False}

    def _release_package(self):
        if self.release_package is not None:
            self.release_package()
            self.release_package = None

    def disconnect(self):
        if self.trial is None or self.trial.detached:
            self._release_package()
            return {'disconnected': True}
        if self.trial.script is None:
            self.trial.close()
            self._release_package()
            return {'disconnected': True}
        self.trial.stop()
        if not self.trial.done.wait(20):
            raise TimeoutError('Native cleanup pending; worker ownership retained')
        status = self.trial.close()
        if status['detached']:
            self._release_package()
        return dict(disconnected=status['detached'], cleanup=status['completion']['cleanup'])

    def retain_until_clean(self):
        # The input pipe closing is not permission to unload an active trial.
        while self.trial is not None and not self.trial.detached:
            try:
                self.disconnect()
            except Exception as error:
                try:
                    sys.stderr.write('Prepared trial retained: ' + str(error) + '\n')
                    sys.stderr.flush()
                except (OSError, ValueError):
                    pass  # A vanished UI pipe must never terminate ownership.
                time.sleep(5)


def run_prepared(source, destination, service=None):
    service = service or PreparedService()
    def emit(value):
        destination.write(json.dumps(value, ensure_ascii=False)+'\n')
        destination.flush()
    try:
        for line in source:
            request_id = None
            try:
                if len(line.encode('utf8')) > 16384:
                    raise ValueError('Request exceeds 16 KiB')
                request = json.loads(line)
                if not isinstance(request, dict) or set(request)-{'id','operation','payload'}:
                    raise ValueError('Expected id, operation and optional payload')
                request_id = request.get('id')
                if type(request_id) not in (int, str):
                    raise ValueError('Invalid request id')
                operation = request.get('operation')
                if operation not in OPERATIONS:
                    raise ValueError('Unknown prepared trial operation')
                payload = request.get('payload')
                if operation not in ('start', 'prepare', 'control') and payload not in (None, {}):
                    raise ValueError('This operation takes no payload')
                if operation == 'capabilities':
                    result = dict(protocol='prepared-trial-v1', operations=OPERATIONS,
                                  scope='Explicit locally prepared script; not arbitrary replay data')
                else:
                    result = getattr(service, operation)(payload) if operation in ('start', 'prepare', 'control') else getattr(service, operation)()
                emit(dict(id=request_id, ok=True, result=result))
            except Exception as error:
                emit(dict(id=request_id, ok=False, error=str(error)))
    finally:
        try:
            cleanup = service.disconnect()
        except Exception:
            service.retain_until_clean()
            cleanup = {'disconnected': True}
        emit(dict(event='closed', cleanup=cleanup))
