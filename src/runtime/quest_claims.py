"""Durable identities for original objective-button submissions."""
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid


def validate(payload):
    if not isinstance(payload, dict) or set(payload) != {'questId', 'tab', 'subTab', 'dailyResetTimestamp'}:
        raise ValueError('Expected questId, tab, subTab and original dailyResetTimestamp')
    if not isinstance(payload['questId'], str) or not 1 <= len(payload['questId']) <= 256:
        raise ValueError('Original questId required')
    tab, sub = payload['tab'], payload['subTab']
    if type(tab) is not int or type(sub) is not int or (tab, sub) not in ((2, 1), (3, 0)):
        raise ValueError('Only original daily and achievement tabs are supported')
    stamp = payload['dailyResetTimestamp']
    if tab == 2:
        if not isinstance(stamp, str) or not re.fullmatch(r'[1-9][0-9]{0,18}', stamp) or int(stamp) > 2**63-1:
            raise ValueError('Original positive int64 daily reset timestamp string required')
    elif stamp is not None:
        raise ValueError('Achievements require null dailyResetTimestamp')
    return dict(payload)


class QuestClaims:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.session = uuid.uuid4().hex

    def path(self, identity):
        key = json.dumps(validate(identity), sort_keys=True, ensure_ascii=False).encode('utf8')
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
        identity = validate(identity)
        path = self.path(identity)
        if path.exists():
            raise ValueError('Prior quest submission exists; inspect status, do not retry')
        live = call('objectives-list', {})
        rows = [q for q in live.get('quests', []) if q.get('id') == identity['questId']]
        if (live.get('readConfirmed') is not True or live.get('tab') != identity['tab']
                or live.get('subTab') != identity['subTab']
                or live.get('dailyResetTimestamp') != identity['dailyResetTimestamp']
                or len(rows) != 1 or rows[0].get('readyForClaim') is not True
                or rows[0].get('claimDisabled') is not False
                or rows[0].get('claimRequirementMet') is not True):
            raise ValueError('Exact original eligible quest and period required')
        self.directory.mkdir(parents=True, exist_ok=True)
        record = dict(schema=1, identity=identity, session=self.session, submittedAt=time.time(),
                      state='reserved-outcome-unknown', retryBlocked=True, rewardConfirmed=False)
        with path.open('x', encoding='utf8') as stream:
            json.dump(record, stream, ensure_ascii=False)
            stream.flush(); os.fsync(stream.fileno())
        try:
            record.update(state='dispatch-returned', nativeReceipt=call('objectives-claim', identity))
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
            raise ValueError('Invalid durable quest receipt; retained, retry prohibited')
        same_session = bool(call and record.get('session') == self.session)
        if same_session:
            live = call('objectives-claim-status', {})
            tracking_id = (record.get('nativeReceipt') or {}).get('trackingId')
            matches = [r for r in live.get('claims', [])
                       if all(r.get(k) == v for k, v in identity.items())
                       and (tracking_id is None or r.get('id') == tracking_id)]
            if live.get('readConfirmed') is True and len(matches) == 1:
                record['nativeStatus'] = matches[0]
                self.save(record)
        return dict(readConfirmed=True, durableSubmission=record, retryBlocked=True,
                    liveTrackingAvailable=same_session)
