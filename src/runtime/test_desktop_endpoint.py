import test_paths
"""Cross-language tests against the actual C# endpoint reader and handshake.

Build client_tests/Client.Tests.csproj first. No game connection is made.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

from server_endpoint import read_endpoint
from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parent
TEST_DLL = ROOT.parent / 'client_tests/bin/Debug/net8.0/Client.Tests.dll'


@unittest.skipUnless(os.name == 'nt', 'Windows DPAPI required')
class DesktopEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_idle_csharp_connection_answers_protocol_ping_without_game_polling(self):
        from unittest.mock import Mock
        from websockets.asyncio.server import serve
        from app_server import AppServer
        from server_endpoint import EndpointOwner
        import secrets
        token = secrets.token_urlsafe(32)
        runtime = Mock()
        server = AppServer(runtime, token)
        with tempfile.TemporaryDirectory(dir=test_paths.logs()) as directory:
            owner = EndpointOwner(directory)
            try:
                async with serve(server._handle, '127.0.0.1', 0,
                                 process_request=server._authenticate, origins=[None],
                                 ping_interval=0.1, ping_timeout=0.3) as listener:
                    uri = f'ws://127.0.0.1:{listener.sockets[0].getsockname()[1]}/rpc'
                    owner.publish(uri, server.instance, token)
                    process = await asyncio.create_subprocess_exec(
                        'dotnet', str(TEST_DLL), '--endpoint-idle', directory,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    stdout, stderr = await asyncio.wait_for(process.communicate(), 15)
                    self.assertEqual(process.returncode, 0, stderr.decode())
                    self.assertEqual(json.loads(stdout)['protocol'], 'jsonrpc-2.0-websocket')
                    runtime.call.assert_not_called()
                    self.assertEqual(len(server._responses), 1)
            finally:
                owner.close()

    async def test_python_owner_and_csharp_reader_fail_closed(self):
        self.assertTrue(TEST_DLL.exists(), 'Build Client.Tests.csproj first')
        with tempfile.TemporaryDirectory(dir=test_paths.logs()) as directory:
            env = dict(os.environ, BLUEMILK_SERVER_DIRECTORY=directory)
            env.pop('BLUEMILK_SERVER_TOKEN', None)
            host = await asyncio.create_subprocess_exec(
                sys.executable, str(ROOT / 'desktop_host.py'), '--app-server',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
            ready = json.loads(await asyncio.wait_for(host.stdout.readline(), 20))
            file = Path(directory) / 'endpoint.json'
            original = json.loads(file.read_text())
            endpoint = read_endpoint(directory)

            async def probe():
                process = await asyncio.create_subprocess_exec(
                    'dotnet', str(TEST_DLL), '--endpoint-probe', directory,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                stdout, stderr = await asyncio.wait_for(process.communicate(), 25)
                self.assertNotIn(endpoint['token'].encode(), stdout + stderr)
                return process.returncode, stdout

            try:
                code, stdout = await probe()
                self.assertEqual(code, 0)
                self.assertEqual(json.loads(stdout)['protocol'], 'jsonrpc-2.0-websocket')
                for key, value, missing in [
                    ('created', original['created'] - 10, True),
                    ('uri', 'ws://example.com:12345/rpc', False),
                    ('protectedToken', 'AAAA', False),
                    ('instance', str(uuid.uuid4()), False),
                ]:
                    file.write_text(json.dumps({**original, key: value}))
                    code, stdout = await probe()
                    if missing:
                        self.assertEqual(code, 0)
                        self.assertEqual(json.loads(stdout), {'found': False})
                    else:
                        self.assertNotEqual(code, 0, key)
            finally:
                file.write_text(json.dumps(original))
                async with connect(ready['uri'], additional_headers={
                    'Authorization': 'Bearer ' + endpoint['token']}, proxy=None) as ws:
                    await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 'shutdown',
                        'method': 'server.shutdown', 'params': {'instance': ready['instance']}}))
                    response = json.loads(await ws.recv())
                    self.assertIn('result', response)
                await asyncio.wait_for(host.wait(), 15)
                self.assertEqual(host.returncode, 0)
                self.assertFalse(file.exists())


if __name__ == '__main__':
    unittest.main()
