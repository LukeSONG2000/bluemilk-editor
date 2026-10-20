import test_paths
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import psutil

from server_endpoint import read_endpoint
from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(os.name == 'nt', 'Windows service launcher')
class LauncherTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_launchers_reuse_one_host_after_exit(self):
        with tempfile.TemporaryDirectory(dir=test_paths.logs()) as directory:
            env = dict(os.environ, BLUEMILK_SERVER_DIRECTORY=directory)
            code = ('from server_launcher import ensure_server;import json;'
                    'e=ensure_server();print(json.dumps({k:e[k] for k in ("pid","instance")}))')
            processes = await asyncio.gather(*[
                asyncio.create_subprocess_exec(sys.executable, '-c', code, cwd=ROOT,
                    env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                for _ in range(2)])
            outputs = await asyncio.gather(*[asyncio.wait_for(p.communicate(), 35) for p in processes])
            endpoint = read_endpoint(directory)
            self.assertIsNotNone(endpoint)
            try:
                identities = []
                for process, (stdout, stderr) in zip(processes, outputs):
                    self.assertEqual(process.returncode, 0, stderr.decode())
                    identities.append(json.loads(stdout))
                self.assertEqual(identities[0], identities[1])
                self.assertEqual(identities[0]['pid'], endpoint['pid'])
                async with connect(endpoint['uri'], additional_headers={
                    'Authorization': 'Bearer '+endpoint['token']}, proxy=None) as ws:
                    await ws.send(json.dumps({'jsonrpc':'2.0','id':'info','method':'server.info'}))
                    response = json.loads(await ws.recv())
                    self.assertEqual(response['result']['hostPid'], endpoint['pid'])
                    self.assertIsNone(response['result']['gamePid'])
            finally:
                async with connect(endpoint['uri'], additional_headers={
                    'Authorization':'Bearer '+endpoint['token']}, proxy=None) as ws:
                    await ws.send(json.dumps({'jsonrpc':'2.0','id':'stop','method':'server.shutdown',
                        'params':{'instance':endpoint['instance']}}))
                    self.assertIn('result', json.loads(await ws.recv()))
                for _ in range(50):
                    if not (Path(directory)/'endpoint.json').exists():
                        break
                    await asyncio.sleep(0.1)
                self.assertFalse((Path(directory)/'endpoint.json').exists())
                try:
                    await asyncio.to_thread(psutil.Process(endpoint['pid']).wait, 15)
                except psutil.NoSuchProcess:
                    pass
