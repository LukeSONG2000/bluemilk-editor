"""Persist exact free-calendar dispatch identities before invoking original UI."""
import hashlib
import json
import os
import re
from pathlib import Path
import time
import uuid

OPERATIONS = {'calendar-open', 'calendar-list', 'calendar-select', 'calendar-close',
              'calendar-visibility', 'calendar-claim', 'calendar-claim-status'}


def validate(operation, payload):
    p = {} if payload is None else payload
    expected = ({'calendarId', 'rewardIndex', 'lastClaimed'} if operation in ('calendar-claim', 'calendar-claim-status')
                else {'calendarId'} if operation == 'calendar-select' else set())
    if operation not in OPERATIONS or not isinstance(p, dict) or set(p) != expected:
        raise ValueError('Calendar operation requires its exact identity fields')
    if expected:
        if not isinstance(p['calendarId'], str) or not 1 <= len(p['calendarId']) <= 256:
            raise ValueError('Explicit current calendarId required')
    if 'rewardIndex' in expected:
        if type(p['rewardIndex']) is not int or not 0 <= p['rewardIndex'] <= 10000:
            raise ValueError('Original rewardIndex required')
        if not isinstance(p['lastClaimed'], str) or not re.fullmatch(r'-?[0-9]{1,23}', p['lastClaimed']):
            raise ValueError('Original lastClaimed timestamp string required')
    return p


class CalendarClaims:
    def __init__(self, directory):
        # Windows packaged hosts may redirect AppData onto another volume.
        # Resolve before creating either file so atomic replace stays on it.
        self.directory = Path(directory).resolve()
        self.session = uuid.uuid4().hex

    def path(self, identity):
        validate('calendar-claim', identity)
        key = json.dumps(identity, sort_keys=True, ensure_ascii=False).encode('utf8')
        return self.directory / (hashlib.sha256(key).hexdigest()+'.json')

    def save(self, record):
        path = self.path(record['identity'])
        temp = path.with_suffix('.'+uuid.uuid4().hex+'.tmp')
        try:
            with temp.open('x', encoding='utf8') as stream:
                json.dump(record, stream, ensure_ascii=False)
                stream.flush(); os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)

    def submit(self, identity, call):
        path = self.path(identity)
        if path.exists():
            raise ValueError('Prior calendar submission exists; read status, do not retry')
        live = call('calendar-list', {})
        selected = live.get('selected') or {}
        selected_identity = dict(calendarId=selected.get('id'), rewardIndex=selected.get('rewardIndex'), lastClaimed=selected.get('lastClaimed'))
        if (live.get('readConfirmed') is not True or selected_identity != identity or live.get('claimEnabled') is not True
                or live.get('catchUpRoute') is not False or selected.get('claimed') is not False
                or selected.get('sourceClaimed') is not False or not selected.get('rewards')):
            raise ValueError('Select the exact eligible original free daily reward first')
        self.directory.mkdir(parents=True, exist_ok=True)
        record = dict(schema=1, identity=dict(identity), session=self.session, submittedAt=time.time(),
                      state='reserved-outcome-unknown', retryBlocked=True)
        with path.open('x', encoding='utf8') as stream:
            json.dump(record, stream, ensure_ascii=False)
            stream.flush(); os.fsync(stream.fileno())
        try:
            record.update(state='dispatch-returned', nativeReceipt=call('calendar-claim', identity))
            self.save(record)
        except Exception as error:
            record.update(state='outcome-unknown', error=str(error))
            self.save(record)
            raise
        return record

    def status(self, identity, call=None):
        path = self.path(identity)
        if not path.exists():
            return dict(readConfirmed=True, durableSubmission=None, retryBlocked=False)
        record = json.loads(path.read_text(encoding='utf8'))
        if record.get('schema') != 1 or record.get('identity') != identity:
            raise ValueError('Invalid durable calendar receipt; retained, retry prohibited')
        same_session = bool(call and record.get('session') == self.session)
        if same_session:
            live = call('calendar-claim-status', {})
            matches = [r for r in live.get('claims', []) if all(r.get(k) == v for k, v in identity.items())]
            if len(matches) == 1:
                record['nativeStatus'] = matches[0]
                self.save(record)
        return dict(readConfirmed=True, durableSubmission=record, retryBlocked=True, liveTrackingAvailable=same_session)
