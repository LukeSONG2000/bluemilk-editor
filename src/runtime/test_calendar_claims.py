import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from calendar_claims import CalendarClaims, validate


class CalendarTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.claims = CalendarClaims(self.temp.name)
        self.identity = dict(calendarId='OCTOBER', rewardIndex=4, lastClaimed='123')
        self.live = dict(readConfirmed=True, selected=dict(id='OCTOBER', rewardIndex=4, lastClaimed='123',
                         claimed=False, sourceClaimed=False, rewards=[dict(id='1', quantity=50, itemType=3)]),
                         claimEnabled=True, catchUpRoute=False)

    def test_exact_payload(self):
        for operation, payload in [('calendar-open', {'force': True}), ('calendar-list', []),
                                   ('calendar-claim', {**self.identity, 'rewardIndex': True}),
                                   ('calendar-claim', {**self.identity, 'lastClaimed': '--1'}),
                                   ('calendar-select', {'calendarId': ''})]:
            with self.assertRaises(ValueError): validate(operation, payload)

    def test_reserve_before_dispatch_and_never_retry_across_sessions(self):
        def call(op, p):
            if op == 'calendar-list': return self.live
            saved = json.loads(self.claims.path(self.identity).read_text())
            self.assertEqual(saved['state'], 'reserved-outcome-unknown')
            return dict(claimDispatched=True, settlementConfirmed=False)
        self.claims.submit(self.identity, call)
        other = CalendarClaims(self.temp.name)
        spy = Mock()
        with self.assertRaises(ValueError): other.submit(self.identity, spy)
        result = other.status(self.identity, spy)
        self.assertTrue(result['retryBlocked'])
        self.assertFalse(result['liveTrackingAvailable'])
        spy.assert_not_called()

    def test_ambiguous_exception_blocks_retry(self):
        call = Mock(side_effect=[self.live, RuntimeError('response lost')])
        with self.assertRaises(RuntimeError): self.claims.submit(self.identity, call)
        self.assertEqual(self.claims.status(self.identity)['durableSubmission']['state'], 'outcome-unknown')
        with self.assertRaises(ValueError): self.claims.submit(self.identity, call)
        self.assertEqual(call.call_count, 2)

    def test_paid_stale_claimed_or_missing_preflight_does_not_reserve(self):
        for change in (dict(catchUpRoute=True), dict(claimEnabled=False), dict(readConfirmed=False),
                       dict(selected={**self.live['selected'], 'sourceClaimed': True}),
                       dict(selected={**self.live['selected'], 'rewardIndex': 5})):
            with self.assertRaises(ValueError):
                self.claims.submit(self.identity, Mock(return_value={**self.live, **change}))
            self.assertFalse(self.claims.path(self.identity).exists())

    def test_settlement_only_exact_native_same_session_identity(self):
        self.claims.submit(self.identity, Mock(side_effect=[self.live, dict(claimDispatched=True)]))
        native = {**self.identity, 'rewardBalanceReconciled': True, 'settlementEvidence': 'native-inventory-delta'}
        r = self.claims.status(self.identity, Mock(return_value={'claims': [native]}))
        self.assertTrue(r['durableSubmission']['nativeStatus']['rewardBalanceReconciled'])
        wrong = {**native, 'lastClaimed': '456'}
        self.claims.status(self.identity, Mock(return_value={'claims': [wrong]}))
        # A new day's claim remains a separate durable identity.
        self.assertNotEqual(self.claims.path(self.identity), self.claims.path({**self.identity, 'lastClaimed':'456'}))

    def test_corrupt_receipt_remains_blocked(self):
        path = self.claims.path(self.identity)
        path.write_text('{')
        with self.assertRaises(ValueError): self.claims.submit(self.identity, Mock())
        with self.assertRaises(ValueError): self.claims.status(self.identity)
        self.assertEqual(path.read_text(), '{')


if __name__ == '__main__':
    unittest.main()
