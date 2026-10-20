import test_paths
import json
import asyncio
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import unittest
import uuid

from server_endpoint import EndpointOwner, read_endpoint


@unittest.skipUnless(os.name == 'nt', 'Windows DPAPI and named mutex required')
class EndpointTests(unittest.TestCase):
    def setUp(self):
        root = test_paths.logs()
        self.temp = tempfile.TemporaryDirectory(prefix='endpoint-test-', dir=root)
        self.root = Path(self.temp.name)
        self.owner = EndpointOwner(self.root)
        self.token = secrets.token_urlsafe(32)
        self.instance = str(uuid.uuid4())

    def tearDown(self):
        self.owner.close()
        self.temp.cleanup()

    def publish(self):
        self.owner.publish('ws://127.0.0.1:12345/rpc', self.instance, self.token)

    def test_dpapi_roundtrip_and_owner_cleanup(self):
        self.publish()
        self.assertNotIn(self.token, self.owner.file.read_text())
        self.assertEqual(read_endpoint(self.root)['token'], self.token)
        self.owner.close()
        self.assertIsNone(read_endpoint(self.root))

    def test_other_process_cannot_acquire_live_owner(self):
        completed = subprocess.run([sys.executable, '-c',
            'from server_endpoint import EndpointOwner; import sys; EndpointOwner(sys.argv[1])',
            str(self.root)], cwd=Path(__file__).parent, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn('already owns', completed.stderr)

    def test_record_removed_during_discovery_is_absent(self):
        from unittest.mock import patch
        self.publish()
        with patch.object(Path, 'open', side_effect=FileNotFoundError):
            self.assertIsNone(read_endpoint(self.root))

    def test_discovery_permission_error_is_not_absence(self):
        from unittest.mock import patch
        self.publish()
        with patch.object(Path, 'open', side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                read_endpoint(self.root)

    def test_oversize_record_rejected_before_json(self):
        self.owner.file.write_bytes(b' ' * 16385)
        with self.assertRaisesRegex(ValueError, 'too large'):
            read_endpoint(self.root)
        self.owner.file.unlink()

    def test_pid_reuse_timestamp_is_not_treated_as_current(self):
        self.publish()
        data = json.loads(self.owner.file.read_text())
        data['created'] -= 100
        self.owner.file.write_text(json.dumps(data))
        self.assertIsNone(read_endpoint(self.root))

    def test_tampered_ciphertext_rejected(self):
        self.publish()
        data = json.loads(self.owner.file.read_text())
        data['protectedToken'] = 'AAAA'
        self.owner.file.write_text(json.dumps(data))
        with self.assertRaises(OSError):
            read_endpoint(self.root)

    def test_owner_does_not_delete_replaced_identity(self):
        self.publish()
        data = json.loads(self.owner.file.read_text())
        data['instance'] = str(uuid.uuid4())
        self.owner.file.write_text(json.dumps(data))
        self.owner.close()
        self.assertTrue(self.owner.file.exists())

    def test_nonlocal_url_refused_before_file_write(self):
        with self.assertRaises(ValueError):
            self.owner.publish('ws://example.com:12345/rpc', self.instance, self.token)
        self.assertFalse(self.owner.file.exists())

    def test_source_host_and_cli_auto_discovery_without_environment_token(self):
        async def run():
            from websockets.asyncio.client import connect
            endpoint_root = self.root / 'host'
            env = {k: v for k, v in os.environ.items() if k != 'BLUEMILK_SERVER_TOKEN'}
            env['BLUEMILK_SERVER_DIRECTORY'] = str(endpoint_root)
            host = await asyncio.create_subprocess_exec(sys.executable,
                str(Path(__file__).with_name('desktop_host.py')), '--app-server',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
            try:
                ready = json.loads((await asyncio.wait_for(host.stdout.readline(), 15)).decode())
                record = read_endpoint(endpoint_root)
                self.assertEqual(record['instance'], ready['instance'])
                cli = await asyncio.create_subprocess_exec(sys.executable,
                    str(Path(__file__).with_name('app.py')), '--jsonl', '--server', 'auto',
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, env=env)
                out, err = await asyncio.wait_for(cli.communicate(b'{"id":"read","operation":"capabilities"}\n'), 15)
                self.assertEqual(cli.returncode, 0, err.decode())
                self.assertEqual(json.loads(out.splitlines()[0])['result']['protocol'], 'jsonrpc-2.0-websocket')
            finally:
                record = read_endpoint(endpoint_root)
                if record:
                    async with connect(record['uri'], additional_headers={'Authorization': 'Bearer ' + record['token']}, proxy=None) as ws:
                        await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 'stop', 'method': 'server.shutdown',
                                                  'params': {'instance': record['instance']}}))
                        self.assertTrue(json.loads(await ws.recv())['result']['stopped'])
                await asyncio.wait_for(host.wait(), 10)
            self.assertEqual(host.returncode, 0)
            self.assertIsNone(read_endpoint(endpoint_root))
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
