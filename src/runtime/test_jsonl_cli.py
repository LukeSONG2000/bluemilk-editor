import io
import json
import unittest
from unittest.mock import Mock, patch
from jsonl_cli import run_jsonl


class JsonlTests(unittest.TestCase):
    def test_mod_routes_share_runtime_without_surface_restriction(self):
        runtime = Mock()
        runtime.call_args = Mock(return_value={'state':'enabled'})
        runtime.disconnect.return_value = {}
        result = self.run_requests(runtime, [
            {'id':1,'operation':'mods-list'},
            {'id':2,'operation':'mods-enable','payload':{'id':'bluemilk.information'}},
            {'id':3,'operation':'mods-disable','payload':{'id':'bluemilk.information'}},
            {'id':4,'operation':'mods-enable','payload':{'id':'bluemilk.information','force':True}},
        ])
        self.assertEqual([r['ok'] for r in result[:-1]], [True,True,True,False])
        self.assertEqual(runtime.call_args.call_count,3)
        runtime.call_args.assert_any_call('modcommand','enable',{'id':'bluemilk.information'})

    def test_quest_routes_require_durable_identity(self):
        runtime = Mock()
        runtime.call_args = Mock()
        runtime.quest_reward.return_value = {'retryBlocked': True}
        runtime.disconnect.return_value = {}
        identity = dict(questId='q', tab=2, subTab=1, dailyResetTimestamp='1792512000')
        result = self.run_requests(runtime, [
            {'id': 1, 'operation': 'objectives-claim', 'payload': identity},
            {'id': 2, 'operation': 'objectives-claim-status', 'payload': identity},
            {'id': 3, 'operation': 'objectives-claim', 'payload': {**identity, 'force': True}},
            {'id': 4, 'operation': 'objectives-claim', 'payload': {**identity, 'dailyResetTimestamp': None}},
        ])
        self.assertEqual([v['ok'] for v in result[:-1]], [True, True, False, False])
        self.assertEqual(runtime.quest_reward.call_count, 2)
        runtime.call_args.assert_not_called()

    def test_calendar_routes_exact_identity_without_purchase(self):
        runtime = Mock()
        runtime.calendar_command.return_value = {'readConfirmed': True}
        runtime.disconnect.return_value = {}
        identity = dict(calendarId='OCTOBER', rewardIndex=4, lastClaimed='123')
        result = self.run_requests(runtime, [
            {'id':1,'operation':'calendar-open'},
            {'id':2,'operation':'calendar-visibility'},
            {'id':3,'operation':'calendar-claim','payload':identity},
            {'id':4,'operation':'calendar-claim','payload':{**identity,'purchase':True}},
            {'id':5,'operation':'calendar-select','payload':{'calendarId':'OCTOBER'}},
            {'id':6,'operation':'calendar-claim-status','payload':identity},
        ])
        self.assertEqual([v['ok'] for v in result[:-1]], [True,True,True,False,True,True])
        self.assertEqual(runtime.calendar_command.call_count,5)
        runtime.calendar_command.assert_any_call('calendar-claim', identity)

    def test_prebattle_routes_and_start_is_not_exposed(self):
        r=Mock();r.call_args=Mock(return_value={});r.call.return_value={};r.disconnect.return_value={}
        result=self.run_requests(r,[{'id':1,'operation':'prebattle-roster'},
                                   {'id':2,'operation':'prebattle-back'},
                                   {'id':3,'operation':'prebattle-start'},
                                   {'id':4,'operation':'events-mission-select','payload':{'eventId':'e','missionId':'m'}}])
        self.assertEqual([v['ok'] for v in result[:-1]],[True,True,False,True])
        r.call.assert_called_once_with('prebattleback')
        r.call_args.assert_any_call('prebattleedit','prebattle-roster',{})
        r.call_args.assert_any_call('eventscommand','events-mission-select',{'eventId':'e','missionId':'m'})

    def test_event_navigation_uses_original_bridge_without_parameters(self):
        r=Mock();r.call_args=Mock(return_value={});r.disconnect.return_value={}
        result=self.run_requests(r,[
            {'id':1,'operation':'events-enter'},
            {'id':2,'operation':'events-challenges'},
            {'id':3,'operation':'events-enter','payload':{'force':True}}])
        self.assertEqual([v['ok'] for v in result[:-1]],[True,True,False])
        self.assertEqual(r.call_args.call_count,2)
        r.call_args.assert_any_call('eventscommand','events-enter',{})
        r.call_args.assert_any_call('eventscommand','events-challenges',{})

    def test_menu_whitelist_identity_and_no_implicit_reward_dispatch(self):
        r=Mock();r.call_args=Mock(return_value={'expectedState':'InboxGameState'});r.disconnect.return_value={}
        result=self.run_requests(r,[
            {'id':1,'operation':'inbox-open'},
            {'id':2,'operation':'inbox-select','payload':{'messageId':'current'}},
            {'id':3,'operation':'inbox-select','payload':{'messageId':'current','claim':True}},
            {'id':4,'operation':'inbox-claim','payload':{'messageId':'current','all':True}},
            {'id':5,'operation':'events-open','payload':{'eventId':'event','instanceId':''}},
            {'id':6,'operation':'objectives-claim'},
            {'id':7,'operation':'objectives-daily'},
            {'id':8,'operation':'events-back'}])
        self.assertEqual([v['ok'] for v in result[:-1]],[True,True,False,False,True,False,True,True])
        self.assertEqual(r.call_args.call_count,5)
        r.call_args.assert_any_call('objectivescommand','events-back',{})
        r.call_args.assert_any_call('eventscommand','events-open',{'eventId':'event','instanceId':''})

    def test_reward_routes_only_through_durable_adapter(self):
        r=Mock();r.inbox_reward.return_value={'retryBlocked':True};r.disconnect.return_value={}
        result=self.run_requests(r,[{'id':1,'operation':'inbox-claim','payload':{'messageId':'m'}},
                                   {'id':2,'operation':'inbox-claim-status','payload':{'messageId':'m'}}])
        self.assertTrue(all(v['ok'] for v in result[:-1]));self.assertEqual(r.inbox_reward.call_count,2)
        r.call.assert_not_called()

    def test_private_transport_never_attaches_and_requires_disconnect(self):
        native=Mock();native.session=None;native.disconnect.return_value={}
        private=Mock();private.snapshot.return_value={'transport':'private-host-mailbox'}
        private.disconnect.return_value={'hostStopped':False}
        with patch('trial_client.TrialClient',return_value=private):
            result=self.run_requests(native,[
                {'id':1,'operation':'trial-connect','payload':{'directory':'logs','pid':7}},
                {'id':2,'operation':'connect'},
                {'id':3,'operation':'disconnect'}])
        self.assertEqual([v['ok'] for v in result[:-1]],[True,False,True])
        native.connect.assert_not_called();private.disconnect.assert_called_once()

    def test_unit_popup_rejects_ambiguous_requests(self):
        r=Mock();r.call.return_value={'transitionConfirmed':True};r.disconnect.return_value={}
        result=self.run_requests(r,[
            {'id':1,'operation':'battle-inspect','payload':{'unitId':'native-unit'}},
            {'id':2,'operation':'battle-inspect','payload':{'unitId':'native-unit','close':True}},
            {'id':3,'operation':'battle-inspect-close','payload':{'unitId':'native-unit'}},
            {'id':4,'operation':'battle-inspect-close'}])
        self.assertEqual([v['ok'] for v in result[:-1]],[True,False,False,True])
        self.assertEqual(r.call.call_count,2)
        r.call.assert_any_call('battleinspect',{'unitId':'native-unit'})
        r.call.assert_any_call('battleinspect',{'close':True})

    def test_capture_is_explicit_and_has_no_caller_output_path(self):
        r=Mock();r.capture_command.return_value={'active':True};r.disconnect.return_value={}
        result=self.run_requests(r,[{'id':1,'operation':'capture-start'},
                                   {'id':2,'operation':'capture-start','payload':{'path':'existing.pb'}}])
        self.assertTrue(result[0]['ok']);self.assertFalse(result[1]['ok'])
        r.capture_command.assert_called_once_with('capture-start')

    def test_enemy_input_preserves_original_token_and_payload(self):
        r=Mock();r.disconnect.return_value={};r.call_args=Mock(return_value={'inputDispatched':True})
        payload={'token':'native-turn','moveType':1,'index':2}
        result=self.run_requests(r,[{'id':1,'operation':'enemy-ability','payload':payload},
                                   {'id':2,'operation':'enemy-basic','payload':{}}])
        self.assertTrue(result[0]['ok']);self.assertFalse(result[1]['ok'])
        r.call_args.assert_called_once_with('enemyinput','ability',payload)

    def run_requests(self, runtime, requests):
        output=io.StringIO()
        run_jsonl(runtime,io.StringIO('\n'.join(json.dumps(r) for r in requests)),output)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def test_routing_and_eof_cleanup(self):
        r=Mock();r.connect.return_value={'pid':7};r.call.return_value={'state':'Home'}
        r.call_args=Mock(return_value={'units':[]});r.disconnect.return_value={'disconnected':True}
        result=self.run_requests(r,[{'id':1,'operation':'connect'}, {'id':2,'operation':'snapshot'},
                                    {'id':3,'operation':'inventory-filter','payload':{'action':'status'}}])
        r.connect.assert_called_once_with(information=False)
        r.call.assert_called_once_with('inspect',None)
        r.call_args.assert_called_once_with('inventorycommand','inventory-filter',{'action':'status'})
        r.disconnect.assert_called_once()
        self.assertTrue(all(v['ok'] for v in result[:-1]));self.assertEqual(result[-1]['event'],'closed')

    def test_invalid_request_never_dispatches_and_next_request_works(self):
        r=Mock();r.disconnect.return_value={}
        result=self.run_requests(r,[{'id':1,'operation':'store-buy'}, {'id':2,'operation':'connect','payload':{'information':'yes'}},
                                    {'id':3,'operation':'snapshot','payload':[]}, {'id':4,'operation':'capabilities'}])
        self.assertEqual([v['ok'] for v in result[:-1]],[False,False,False,True])
        r.connect.assert_not_called();r.call.assert_not_called()
        r.disconnect.assert_called_once()

    def test_native_error_is_reported_without_retry(self):
        r=Mock();r.call.side_effect=RuntimeError('Stale token');r.disconnect.return_value={}
        result=self.run_requests(r,[{'id':1,'operation':'battle-ability','payload':{'token':'old','index':0}}])
        self.assertEqual(result[0]['error'],'Stale token');r.call.assert_called_once()

if __name__=='__main__':unittest.main()
