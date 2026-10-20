import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch
from runtime_protocol import ProtocolSession


def request(session, identity, op, payload=None):
    return session.dispatch(json.dumps(dict(id=identity, operation=op, payload=payload)))


class ProtocolSessionTests(unittest.TestCase):
    def test_multiple_frontends_share_one_runtime_and_do_not_close_per_request(self):
        runtime = Mock()
        runtime.call_args = Mock(return_value={'mods': []})
        runtime.connect.return_value = {'pid': 123}
        runtime.disconnect.return_value = {'disconnected': True}
        session = ProtocolSession(runtime)
        self.assertTrue(request(session, 'desktop:1', 'connect')['ok'])
        self.assertTrue(request(session, 'cli:1', 'mods-list')['ok'])
        self.assertTrue(request(session, 'desktop:2', 'mods-list')['ok'])
        runtime.connect.assert_called_once()
        runtime.disconnect.assert_not_called()
        session.close(); session.close()
        runtime.disconnect.assert_called_once()
        self.assertFalse(request(session, 'late', 'connect')['ok'])
        runtime.connect.assert_called_once()

    def test_native_commands_are_serialized_across_threads(self):
        runtime = Mock()
        entered, release, second_started = threading.Event(), threading.Event(), threading.Event()
        calls = []
        def native(method, payload):
            calls.append(payload['detailScope'])
            if len(calls) == 1:
                entered.set()
                if not release.wait(3): raise RuntimeError('test timeout')
            return {'sequence': len(calls)}
        runtime.call.side_effect = native
        session = ProtocolSession(runtime)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(request, session, 'a', 'snapshot', {'detailScope':'selected'})
            self.assertTrue(entered.wait(2))
            def second():
                second_started.set()
                return request(session, 'b', 'snapshot', {'detailScope':'all'})
            other = pool.submit(second)
            self.assertTrue(second_started.wait(2))
            self.assertEqual(calls, ['selected'])
            release.set()
            self.assertTrue(first.result(timeout=3)['ok'])
            self.assertTrue(other.result(timeout=3)['ok'])
        self.assertEqual(calls, ['selected','all'])

    def test_cleanup_failure_retains_session_and_never_implicitly_replays(self):
        runtime = Mock()
        runtime.call.side_effect = RuntimeError('response unknown')
        runtime.disconnect.side_effect = [RuntimeError('cleanup incomplete'), {'disconnected':True}]
        session = ProtocolSession(runtime)
        result = request(session, 'a', 'battle-ability', {'abilityId':'x'})
        self.assertFalse(result['ok']); runtime.call.assert_called_once()
        with self.assertRaisesRegex(RuntimeError, 'cleanup incomplete'): session.close()
        self.assertTrue(request(session, 'status', 'capabilities')['ok'])
        self.assertTrue(session.close()['disconnected'])
        runtime.call.assert_called_once()

    def test_trial_routing_survives_separate_dispatches(self):
        native = Mock(); native.session = None
        private = Mock()
        private.snapshot.return_value = {'transport':'private'}
        private.call.return_value = {'state':'Battle'}
        private.disconnect.return_value = {'hostStopped':False}
        session = ProtocolSession(native)
        with patch('trial_client.TrialClient', return_value=private):
            self.assertTrue(request(session, 'a','trial-connect',{'directory':'logs','pid':7})['ok'])
            self.assertTrue(request(session, 'b','snapshot')['ok'])
            private.call.assert_called_once_with('inspect',None)
            self.assertTrue(request(session, 'c','disconnect')['ok'])
            self.assertIs(session.runtime, native)


if __name__ == '__main__':
    unittest.main()
