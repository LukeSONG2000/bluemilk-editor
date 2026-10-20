import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from runtime_protocol import ProtocolSession
from calendar_claims import CalendarClaims
from test_paths import logs

class GameOperationsTests(unittest.TestCase):
    identity = dict(calendarId='original', rewardIndex=2, lastClaimed='123')

    def make(self, handoff=None, enabled=True, capable=True):
        def native(method, *args):
            if method == 'modinvoke':
                return handoff if handoff is not None else dict(blueMilkHostOperation=1, operation=args[1], payload=args[2])
            if method == 'modcommand' and args[0] == 'list':
                return {'mods': [{'manifest': {'id': 'bluemilk.game-operations', 'capabilities': ['game.operations'] if capable else []}, 'state': 'enabled' if enabled else 'disabled'}]}
            raise AssertionError((method,args))
        runtime=SimpleNamespace(call_args=Mock(side_effect=native),calendar_command=Mock(return_value={'readConfirmed':True}))
        return runtime,ProtocolSession(runtime)

    def dispatch(self,session,command,payload):
        return session.dispatch(json.dumps({'id':'request','operation':'mods-command','payload':{'id':'bluemilk.game-operations','command':command,'payload':payload}}))

    def test_existing_validator_and_route_reused(self):
        runtime,session=self.make()
        self.assertTrue(self.dispatch(session,'calendar-open',{})['ok'])
        runtime.calendar_command.assert_called_once_with('calendar-open',{})
        self.assertFalse(self.dispatch(session,'calendar-open',{'force':True})['ok'])
        self.assertEqual(runtime.calendar_command.call_count,1)

    def test_no_recursive_lifecycle_or_parameter_rewrite(self):
        for handoff in [dict(blueMilkHostOperation=1,operation='mods-disable',payload={}),
                        dict(blueMilkHostOperation=1,operation='calendar-claim',payload=self.identity),
                        dict(blueMilkHostOperation=True,operation='calendar-open',payload={})]:
            runtime,session=self.make(handoff)
            self.assertFalse(self.dispatch(session,'calendar-open',{})['ok'])
            runtime.calendar_command.assert_not_called()
        for enabled,capable in [(False,True),(True,False)]:
            runtime,session=self.make(enabled=enabled,capable=capable)
            self.assertFalse(self.dispatch(session,'calendar-open',{})['ok'])
            runtime.calendar_command.assert_not_called()

    def test_persistent_unknown_receipt_prevents_second_dispatch(self):
        with tempfile.TemporaryDirectory(dir=logs()) as folder:
            journal=CalendarClaims(folder)
            runtime,session=self.make()
            def original(op,p):
                if op=='calendar-list':
                    return dict(readConfirmed=True,claimEnabled=True,catchUpRoute=False,selected=dict(id=p.get('calendarId','original'),rewardIndex=2,lastClaimed='123',claimed=False,sourceClaimed=False,rewards=[{'id':'item'}]))
                self.assertEqual(json.loads(journal.path(self.identity).read_text())['state'],'reserved-outcome-unknown')
                raise RuntimeError('response lost')
            calls=Mock(side_effect=original)
            runtime.calendar_command=lambda op,p: journal.submit(p,calls) if op=='calendar-claim' else journal.status(p)
            self.assertFalse(self.dispatch(session,'calendar-claim',self.identity)['ok'])
            journal=CalendarClaims(folder)  # new session still cannot resubmit
            result=self.dispatch(session,'calendar-claim',self.identity)
            self.assertFalse(result['ok']);self.assertIn('Prior calendar submission',result['error'])
            self.assertEqual(calls.call_count,2)  # one preflight, one dispatch
            status=self.dispatch(session,'calendar-claim-status',self.identity)
            self.assertTrue(status['ok']);self.assertTrue(status['result']['retryBlocked'])
            self.assertEqual(status['result']['durableSubmission']['state'],'outcome-unknown')
