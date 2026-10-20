import json
import tempfile
import unittest
from unittest.mock import Mock
from quest_claims import QuestClaims, validate


class QuestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = QuestClaims(self.temp.name)
        self.identity = dict(questId='q', tab=2, subTab=1, dailyResetTimestamp='1792512000')
        self.live = dict(readConfirmed=True, tab=2, subTab=1, dailyResetTimestamp='1792512000',
                         quests=[dict(id='q', readyForClaim=True, claimDisabled=False, claimRequirementMet=True)])

    def test_strict_identity(self):
        for change in ({'tab': True}, {'subTab': 0}, {'dailyResetTimestamp': None},
                       {'dailyResetTimestamp': '01'}, {'dailyResetTimestamp': str(2**63)},
                       {'dailyResetTimestamp': 123}, {'force': True}):
            with self.assertRaises(ValueError):
                validate({**self.identity, **change})
        validate(dict(questId='achievement', tab=3, subTab=0, dailyResetTimestamp=None))

    def test_reservation_precedes_native_and_reconnect_never_retries(self):
        def call(op, payload):
            if op == 'objectives-list': return self.live
            r = json.loads(self.ledger.path(self.identity).read_text())
            self.assertEqual(r['state'], 'reserved-outcome-unknown')
            return dict(trackingId='1', claimDispatched=True)
        self.ledger.submit(self.identity, call)
        other = QuestClaims(self.temp.name)
        spy = Mock()
        with self.assertRaises(ValueError): other.submit(self.identity, spy)
        self.assertFalse(other.status(self.identity, spy)['liveTrackingAvailable'])
        spy.assert_not_called()

    def test_period_stale_or_ineligible_never_dispatches(self):
        for change in ({'dailyResetTimestamp': '1792598400'}, {'readConfirmed': False},
                       {'quests': []}, {'quests': self.live['quests'] * 2},
                       {'quests': [{**self.live['quests'][0], 'claimDisabled': True}]}):
            call = Mock(return_value={**self.live, **change})
            with self.assertRaises(ValueError): self.ledger.submit(self.identity, call)
            self.assertEqual(call.call_count, 1)
            self.assertFalse(self.ledger.path(self.identity).exists())

    def test_lost_response_stays_unknown_and_blocked(self):
        call = Mock(side_effect=[self.live, RuntimeError('lost response')])
        with self.assertRaises(RuntimeError): self.ledger.submit(self.identity, call)
        record = self.ledger.status(self.identity)['durableSubmission']
        self.assertEqual(record['state'], 'outcome-unknown')
        self.assertFalse(record['rewardConfirmed'])
        with self.assertRaises(ValueError): self.ledger.submit(self.identity, call)
        self.assertEqual(call.call_count, 2)

    def test_period_and_tracking_id_correlate_without_claiming_balances(self):
        self.ledger.submit(self.identity, Mock(side_effect=[self.live, {'trackingId': '1'}]))
        wrong = {**self.identity, 'id': '2', 'outcome': 'native-success-callback'}
        r = self.ledger.status(self.identity, Mock(return_value={'readConfirmed': True, 'claims': [wrong]}))
        self.assertNotIn('nativeStatus', r['durableSubmission'])
        native = {**wrong, 'id': '1'}
        r = self.ledger.status(self.identity, Mock(return_value={'readConfirmed': True, 'claims': [native]}))
        self.assertEqual(r['durableSubmission']['nativeStatus']['outcome'], 'native-success-callback')
        self.assertFalse(r['durableSubmission']['rewardConfirmed'])
        self.assertNotEqual(self.ledger.path(self.identity),
                            self.ledger.path({**self.identity, 'dailyResetTimestamp': '1792598400'}))

    def test_corrupt_record_retained_and_blocks(self):
        path = self.ledger.path(self.identity)
        path.write_text('{')
        with self.assertRaises(ValueError): self.ledger.submit(self.identity, Mock())
        with self.assertRaises(ValueError): self.ledger.status(self.identity)
        self.assertEqual(path.read_text(), '{')


if __name__ == '__main__':
    unittest.main()
