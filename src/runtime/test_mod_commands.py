import json
import unittest
from unittest.mock import Mock
from types import SimpleNamespace
import test_paths
from runtime_protocol import ProtocolSession


class CommandTests(unittest.TestCase):
    def test_mod_command_preserves_identity_and_payload(self):
        runtime = SimpleNamespace(call_args=Mock())
        runtime.call_args.return_value = {'armed': True}
        payload = {'id': 'bluemilk.battle-control', 'command': 'arm',
                   'payload': {'scope': 'all', 'combatType': 0, 'enabled': True,
                               'oneClickTaunt': True, 'allowedTargets': []}}
        response = ProtocolSession(runtime).dispatch(json.dumps({'id': 'test', 'operation': 'mods-command', 'payload': payload}))
        self.assertTrue(response['ok'], response)
        runtime.call_args.assert_called_once_with('modinvoke', payload['id'], payload['command'], payload['payload'])

    def test_command_rejected_for_trial_and_malformed_payload(self):
        runtime = SimpleNamespace(call_args=Mock())
        session = ProtocolSession(runtime)
        for payload in ({}, {'id': 'test', 'command': 'arm', 'payload': []}):
            response = session.dispatch(json.dumps({'id': 1, 'operation': 'mods-command', 'payload': payload}))
            self.assertFalse(response['ok'])
        session.runtime = Mock()
        response = session.dispatch(json.dumps({'id': 2, 'operation': 'mods-command', 'payload': {'id': 'test', 'command': 'arm', 'payload': {}}}))
        self.assertFalse(response['ok'])
        runtime.call_args.assert_not_called()
