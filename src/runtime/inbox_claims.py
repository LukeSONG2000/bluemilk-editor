"""Durable, at-most-once native inbox dispatch. Unknown outcomes stay blocked."""
import hashlib
import json
import os
from pathlib import Path
import time
import uuid


class InboxClaims:
    def __init__(self, directory):
        # Use the actual volume for both reservation and atomic replacement.
        self.directory = Path(directory).resolve()
        self.session = uuid.uuid4().hex

    def path(self, message_id):
        if not isinstance(message_id, str) or not 1 <= len(message_id) <= 256:
            raise ValueError('Expected current messageId only')
        return self.directory / (hashlib.sha256(message_id.encode('utf-8')).hexdigest()+'.json')

    def read(self, message_id):
        path = self.path(message_id)
        if not path.exists():
            return None
        record = json.loads(path.read_text(encoding='utf-8'))
        if record.get('messageId') != message_id or record.get('schema') != 1:
            raise ValueError('Invalid durable inbox receipt; retained, retry prohibited')
        return record

    def save(self, record):
        path = self.path(record['messageId'])
        temp = path.with_suffix('.'+uuid.uuid4().hex+'.tmp')
        try:
            with temp.open('x', encoding='utf-8') as stream:
                json.dump(record, stream, ensure_ascii=False)
                stream.flush();os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)

    def submit(self, message_id, call):
        path = self.path(message_id)
        if path.exists():
            raise ValueError('Prior inbox submission exists; inspect inbox-claim-status, never retry automatically')
        current = call('inbox-list', {})
        rows = [m for m in current.get('messages', []) if m.get('id') == message_id]
        detail = current.get('selectedDetail') or {}
        if (len(rows) != 1 or not rows[0].get('selected') or not rows[0].get('rewards')
                or rows[0].get('hasCustomAction') or detail.get('messageId') != message_id
                or not all(detail.get(k) for k in ('rewardView', 'active', 'enabled'))):
            raise ValueError('Select an eligible original reward message first')
        self.directory.mkdir(parents=True, exist_ok=True)
        record = dict(schema=1, messageId=message_id, session=self.session,
                      submittedAt=time.time(), state='reserved-outcome-unknown', retryBlocked=True)
        # Exclusive durable reservation precedes native invocation. Even a partial
        # file after a crash blocks retries; only read-only reconciliation follows.
        with path.open('x', encoding='utf-8') as stream:
            json.dump(record, stream, ensure_ascii=False)
            stream.flush();os.fsync(stream.fileno())
        try:
            receipt = call('inbox-claim', {'messageId': message_id})
            record.update(state='dispatch-returned', nativeReceipt=receipt)
            self.save(record)
        except Exception as error:
            record.update(state='outcome-unknown', error=str(error))
            self.save(record)
            raise
        return record

    def status(self, message_id, call=None):
        record = self.read(message_id)
        if record is None:
            return dict(readConfirmed=True, durableSubmission=None, retryBlocked=False)
        # Native tracking IDs are per injection, so never correlate another
        # session's small numeric tracking ID with a historical transaction.
        if call and record['session'] == self.session:
            status = call('inbox-claim-status', {})
            claims = [c for c in status.get('claims', []) if c.get('messageId') == message_id]
            if len(claims) == 1:
                record['nativeStatus'] = claims[0]
                self.save(record)
        return dict(readConfirmed=True, durableSubmission=record, retryBlocked=True,
                    liveTrackingAvailable=bool(call and record['session'] == self.session))
