import json
import tempfile
import unittest
from unittest.mock import Mock
from inbox_claims import InboxClaims


def eligible():
    return {'messages':[{'id':'m','selected':True,'rewards':[{'quantity':1}]}],
            'selectedDetail':{'messageId':'m','rewardView':True,'active':True,'enabled':True}}


class InboxClaimTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.claims=InboxClaims(self.temp.name)

    def test_reservation_precedes_dispatch_and_restart_blocks_replay(self):
        def call(op, payload):
            if op=='inbox-list':return eligible()
            self.assertEqual(self.claims.read('m')['state'],'reserved-outcome-unknown')
            return {'claimDispatched':True,'tracking':{'id':'1'}}
        self.claims.submit('m',call)
        fresh=InboxClaims(self.temp.name);native=Mock()
        with self.assertRaisesRegex(ValueError,'Prior inbox'):fresh.submit('m',native)
        native.assert_not_called()
        status=fresh.status('m',native)
        native.assert_not_called();self.assertFalse(status['liveTrackingAvailable'])

    def test_lost_reply_remains_unknown_and_cannot_resubmit(self):
        call=Mock(side_effect=[eligible(),RuntimeError('reply lost')])
        with self.assertRaisesRegex(RuntimeError,'reply lost'):self.claims.submit('m',call)
        self.assertEqual(self.claims.read('m')['state'],'outcome-unknown')
        with self.assertRaises(ValueError):self.claims.submit('m',call)
        self.assertEqual(call.call_count,2)

    def test_status_persists_exact_message_evidence_without_claiming(self):
        self.claims.submit('m',Mock(side_effect=[eligible(),{'claimDispatched':True}]))
        status=Mock(return_value={'claims':[{'messageId':'other','rewardBalanceReconciled':True},
                                           {'messageId':'m','outcome':'native-success-callback','rewardBalanceReconciled':False}]})
        result=self.claims.status('m',status)
        status.assert_called_once_with('inbox-claim-status',{})
        self.assertFalse(result['durableSubmission']['nativeStatus']['rewardBalanceReconciled'])
        self.assertEqual(InboxClaims(self.temp.name).status('m')['durableSubmission']['nativeStatus']['outcome'],'native-success-callback')

    def test_invalid_or_custom_action_does_not_reserve(self):
        data=eligible();data['messages'][0]['hasCustomAction']=True
        with self.assertRaises(ValueError):self.claims.submit('m',Mock(return_value=data))
        self.assertIsNone(self.claims.read('m'))

    def test_partial_record_after_crash_still_blocks(self):
        self.claims.path('m').write_text('{',encoding='utf-8')
        native=Mock()
        with self.assertRaises(ValueError):self.claims.submit('m',native)
        with self.assertRaises(json.JSONDecodeError):self.claims.status('m')
        native.assert_not_called()

    def test_competing_reservation_between_preflight_and_dispatch_wins(self):
        def preflight(op, payload):
            self.assertEqual(op,'inbox-list')
            self.claims.path('m').write_text('{"otherOwner":true}',encoding='utf-8')
            return eligible()
        call=Mock(side_effect=preflight)
        with self.assertRaises(FileExistsError):self.claims.submit('m',call)
        call.assert_called_once_with('inbox-list',{})

if __name__=='__main__':unittest.main()
