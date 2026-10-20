import asyncio
import json
import secrets
import os
import subprocess
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus
from app_server import AppServer


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = Mock()
        self.runtime.call.return_value = {'state': 'Home'}
        self.runtime.disconnect.return_value = {'disconnected': True}
        self.token = secrets.token_urlsafe(32)
        self.server = AppServer(self.runtime, self.token)
        self.uri = await self.server.start()

    async def asyncTearDown(self):
        self.runtime.disconnect.side_effect = None
        await self.server.stop()

    def client(self, **kwargs):
        return connect(self.uri, additional_headers={'Authorization': 'Bearer ' + self.token},
                       proxy=None, **kwargs)

    async def call(self, client, request_id, operation='snapshot', **extra):
        params = {'instance': self.server.instance, 'operation': operation, **extra}
        await client.send(json.dumps({'jsonrpc': '2.0', 'id': request_id,
                                     'method': 'runtime.call', 'params': params}))
        return json.loads(await client.recv())

    async def test_two_real_connections_share_runtime_and_disconnect_does_not_cleanup(self):
        async with self.client() as desktop, self.client() as cli:
            first, second = await asyncio.gather(self.call(desktop, 'desktop-1'), self.call(cli, 'cli-1'))
            self.assertEqual(first['result'], second['result'])
            self.assertEqual(self.runtime.call.call_count, 2)
        self.runtime.disconnect.assert_not_called()
        async with self.client() as reconnected:
            self.assertEqual((await self.call(reconnected, 'cli-2'))['result']['state'], 'Home')

    async def test_id_dedup_survives_disconnect_and_rejects_changed_request(self):
        async with self.client() as first:
            reply = await self.call(first, 'once')
        async with self.client() as second:
            self.assertEqual(await self.call(second, 'once'), reply)
            altered = await self.call(second, 'once', payload={'detailScope': 'all'})
            self.assertIn('error', altered)
        self.runtime.call.assert_called_once()

    async def test_auth_and_browser_origins_rejected_before_runtime(self):
        with self.assertRaises(InvalidStatus):
            async with connect(self.uri, proxy=None):
                self.fail('unauthenticated client accepted')
        with self.assertRaises(InvalidStatus):
            async with self.client(origin='https://example.com'):
                self.fail('browser origin accepted')
        self.runtime.call.assert_not_called()

    async def test_old_instance_and_bad_json_do_not_dispatch(self):
        async with self.client() as client:
            response = await self.call(client, 'old', instance='stale-server')
            self.assertEqual(response['error']['code'], -32602)
            await client.send('{')
            self.assertEqual(json.loads(await client.recv())['error']['code'], -32700)
        self.runtime.call.assert_not_called()

    async def test_cleanup_failure_keeps_listener_alive(self):
        self.runtime.disconnect.side_effect = RuntimeError('cleanup incomplete')
        with self.assertRaisesRegex(RuntimeError, 'cleanup incomplete'):
            await self.server.stop()
        async with self.client() as client:
            response = await self.call(client, 'after-failure')
            self.assertIn('result', response)

    async def test_runtime_failure_is_not_reexecuted(self):
        self.runtime.call.side_effect = RuntimeError('unknown original callback outcome')
        async with self.client() as client:
            first = await self.call(client, 'unknown')
            second = await self.call(client, 'unknown')
            self.assertEqual(first, second)
            self.assertIn('error', first)
        self.runtime.call.assert_called_once()

    async def test_capabilities_describe_shared_transport(self):
        async with self.client() as client:
            reply = await self.call(client, 'capabilities', 'capabilities')
            self.assertEqual(reply['result']['protocol'], 'jsonrpc-2.0-websocket')
            self.assertIn('EOF retains session', reply['result']['lifecycle'])

    async def test_cli_process_uses_shared_server_and_eof_retains_runtime(self):
        request = json.dumps({'id': 'same', 'operation': 'snapshot'}) + '\n'
        completed = await asyncio.to_thread(subprocess.run,
            [sys.executable, str(Path(__file__).with_name('app.py')), '--jsonl', '--server', self.uri],
            input='{\n' + request + request, text=True, encoding='utf8', capture_output=True,
            timeout=15, env={**os.environ, 'BLUEMILK_SERVER_TOKEN': self.token})
        self.assertEqual(completed.returncode, 0, completed.stderr)
        rows = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertFalse(rows[0]['ok'])
        self.assertEqual(rows[1], rows[2])
        self.assertEqual(rows[1]['result']['state'], 'Home')
        self.assertFalse(rows[-1]['runtimeCleanupRequested'])
        self.runtime.call.assert_called_once()
        self.runtime.disconnect.assert_not_called()

    async def test_shared_trial_survives_frontend_eof_and_retains_failed_cleanup(self):
        self.runtime.session = None
        trial = SimpleNamespace(detached=False, complete=None, evidence=Path('trial-evidence.json'))
        prepared = Mock(trial=trial)
        prepared.start.return_value = {'started':True,'pid':123}
        prepared.status.return_value = {'pid':123,'messages':[{'event':'observed'}]}
        prepared.snapshot.return_value = {'state':'BattleGameState','units':[]}
        prepared.disconnect.side_effect = RuntimeError('cleanup pending')
        with patch('shared_trials.PreparedService',return_value=prepared):
            async with self.client() as first:
                response = await self.call(first,'trial-start','trial-start',payload={'manifest':'explicit.json'})
                self.assertTrue(response['result']['started'])
                again = await self.call(first,'trial-start','trial-start',payload={'manifest':'explicit.json'})
                self.assertEqual(again,response)
            prepared.disconnect.assert_not_called()
            async with self.client() as second:
                state = await self.call(second,'trial-state','trial-status')
                self.assertTrue(state['result']['active'])
                self.assertEqual(state['result']['eventCount'],1)
                self.assertNotIn('messages',state['result'])
                snapshot = await self.call(second,'trial-snapshot')
                self.assertEqual(snapshot['result']['sessionMode'],'prepared')
                self.assertIn('error',await self.call(second,'start-again','trial-start',payload={'manifest':'explicit.json'}))
                self.assertIn('error',await self.call(second,'normal-connect','connect'))
                self.assertIn('error',await self.call(second,'failed-stop','trial-stop'))
                self.assertTrue(self.server.session.trials.owns_session)
                self.assertEqual(self.server.game_pid,123)
                prepared.disconnect.side_effect = None
                prepared.disconnect.return_value = {'disconnected':True}
                stopped = await self.call(second,'confirmed-stop','trial-stop')
                self.assertTrue(stopped['result']['disconnected'])
                self.assertFalse(self.server.session.trials.owns_session)
                self.assertIsNone(self.server.game_pid)
        prepared.start.assert_called_once()
        self.runtime.connect.assert_not_called()

    async def test_explicit_shutdown_ack_and_listener_close(self):
        async with self.client() as client:
            await client.send(json.dumps({'jsonrpc': '2.0', 'id': 'stop', 'method': 'server.shutdown',
                                         'params': {'instance': self.server.instance}}))
            response = json.loads(await client.recv())
            self.assertTrue(response['result']['stopped'])
        await asyncio.wait_for(self.server.wait_closed(), 2)
        self.runtime.disconnect.assert_called_once()

    async def test_failed_shutdown_keeps_runtime_recoverable(self):
        self.runtime.disconnect.side_effect = RuntimeError('original cleanup failed')
        async with self.client() as client:
            await client.send(json.dumps({'jsonrpc': '2.0', 'id': 'stop', 'method': 'server.shutdown',
                                         'params': {'instance': self.server.instance}}))
            self.assertIn('error', json.loads(await client.recv()))
            self.assertIn('result', await self.call(client, 'still-alive', 'capabilities'))


if __name__ == '__main__':
    unittest.main()
