"""App-server ownership of one prepared trial; frontend lifetime is independent."""
from prepared_protocol import PreparedService


class SharedTrials:
    def __init__(self):
        self.service = None
        self.last = {'active': False, 'started': False}

    @property
    def owns_session(self):
        # Include partial/unknown starts until an explicit stop confirms cleanup.
        return self.service is not None

    def prepare(self, payload):
        return PreparedService().prepare(payload)

    def start(self, payload):
        if self.service is not None:
            raise RuntimeError('Stop and restore the current trial before another start')
        self.service = PreparedService()
        return self.service.start(payload)

    def status(self):
        if self.service is None:
            return self.last.copy()
        status = self.service.status()
        messages = status.pop('messages', [])
        status.update(active=True, eventCount=len(messages))
        if self.service.trial is not None:
            status['evidence'] = str(self.service.trial.evidence)
        return status

    def snapshot(self):
        if self.service is None:
            raise RuntimeError('No shared trial')
        if self.service.trial is not None and self.service.trial.complete is not None:
            return {'state': 'PreparedTrialComplete', 'sessionMode': 'prepared',
                    'units': [], 'trial': self.status()}
        return {**self.service.snapshot(), 'sessionMode': 'prepared'}

    def mods(self):
        if self.service is None or self.service.trial is None:
            raise RuntimeError('No shared trial registry')
        trial = self.service.trial
        if trial.complete is not None:
            registry = trial.complete.get('trialMod', {}).get('registry')
            if registry is None:
                raise RuntimeError('Legacy prepared trial has no Mod registry receipt')
            return registry
        return trial.script.exports_sync.modcommand('list', {})

    def control(self, payload):
        if self.service is None:
            raise RuntimeError('No shared trial')
        return self.service.control(payload)

    def stop(self):
        if self.service is None:
            return {'disconnected': True}
        result = self.service.disconnect()
        if not isinstance(result, dict) or result.get('disconnected') is not True:
            raise RuntimeError('Trial cleanup not confirmed; shared ownership retained')
        self.last = {**self.status(), 'active': False}
        self.service = None
        return result
