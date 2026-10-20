import io
import json
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from prepared_protocol import run_prepared, PreparedService


class FakeService:
    def __init__(self): self.starts=0; self.closed=0; self.retained=0; self.fail=False
    def start(self,payload): self.starts+=1; return {'started':True}
    def disconnect(self):
        self.closed+=1
        if self.fail: raise RuntimeError('cleanup pending')
        return {'disconnected':True}
    def retain_until_clean(self): self.retained+=1


class ProtocolTests(unittest.TestCase):
    def run_requests(self,requests,service):
        output=io.StringIO()
        run_prepared(io.StringIO(''.join(json.dumps(r)+'\n' for r in requests)),output,service)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_no_start_on_capabilities_or_eof(self):
        service=FakeService()
        rows=self.run_requests([{'id':'a','operation':'capabilities'}],service)
        self.assertEqual(rows[0]['result']['protocol'],'prepared-trial-v1')
        self.assertEqual(service.starts,0)
        self.assertTrue(rows[-1]['cleanup']['disconnected'])

    def test_unknown_and_bad_ids_rejected(self):
        service=FakeService()
        rows=self.run_requests([{'id':True,'operation':'start'},{'id':2,'operation':'connect'},
                                {'id':3,'operation':'disconnect','payload':{'force':True}}],service)
        self.assertTrue(all(not row['ok'] for row in rows[:-1]))
        self.assertEqual(service.starts,0)

    def test_eof_waits_for_owned_cleanup(self):
        service=FakeService();service.fail=True
        rows=self.run_requests([],service)
        self.assertEqual(service.retained,1)
        self.assertTrue(rows[-1]['cleanup']['disconnected'])

    def test_broken_diagnostic_pipe_does_not_end_ownership(self):
        service=PreparedService()
        service.trial=SimpleNamespace(detached=False)
        calls=[]
        def disconnect():
            calls.append(1)
            if len(calls)==1: raise RuntimeError('pending')
            service.trial.detached=True
        service.disconnect=disconnect
        with patch('prepared_protocol.sys.stderr') as stderr, patch('prepared_protocol.time.sleep'):
            stderr.write.side_effect=BrokenPipeError()
            service.retain_until_clean()
        self.assertEqual(len(calls),2)


if __name__=='__main__':unittest.main()
