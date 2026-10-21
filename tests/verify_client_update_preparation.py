"""Windows integration: build Client.Tests, then pass its DLL and frozen host.

Runs isolated endpoints only; never attaches to the game or changes installation.
"""
import asyncio
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/runtime'))
from server_endpoint import EndpointOwner, read_endpoint
from update_lease import UpdateLease
from app_server import AppServer
from websockets.asyncio.client import connect


async def fixture(mode, root):
    class Runtime:
        session = object() if mode == 'active' else None
        script = None

        def disconnect(self):
            self.session = self.script = None
            return {'disconnected': True}

    class Server(AppServer):
        async def dispatch(self, message, client=None):
            method = json.loads(message)['method']
            with (root / 'calls.jsonl').open('a') as stream:
                stream.write(json.dumps(method) + '\n')
            if method == 'test.connections':
                return {'jsonrpc':'2.0', 'id':json.loads(message)['id'], 'result':len(self._clients)}
            if mode == 'cancel' and method == 'server.info':
                await asyncio.sleep(2)
            if mode == 'bad-ack' and method == 'server.shutdownForUpdate':
                return {'jsonrpc': '2.0', 'id': json.loads(message)['id'],
                        'result': {'stopped': False, 'reason': 'update'}}
            reply = await super().dispatch(message, client)
            if mode == 'legacy' and method == 'server.info':
                reply['result'].pop('updateShutdownSupported')
                reply['result'].pop('updateLeaseVersion')
            return reply

    server = Server(Runtime(), secrets.token_urlsafe(32))
    owner = EndpointOwner(root)
    try:
        await server.start()
        owner.publish(server.uri, server.instance, server._token)
        await server.wait_closed()
    finally:
        await server.stop()
        owner.close()


async def main(dll, frozen):
    evidence = ROOT / 'logs' / ('client-update-preparation-' + uuid.uuid4().hex[:8])
    evidence.mkdir()
    results = {}

    async def rpc(ws, endpoint, method):
        await ws.send(json.dumps({'jsonrpc':'2.0','id':uuid.uuid4().hex,'method':method,
                                 'params':{'instance':endpoint['instance']}}))
        return json.loads(await asyncio.wait_for(ws.recv(), 10))

    async def run_case(mode):
        root = evidence / mode
        root.mkdir()
        command = ([frozen, '--app-server', '--server-directory', str(root)] if mode in ('frozen', 'other-client')
                   else [sys.executable, __file__, '--fixture', mode, str(root)])
        out = (root / 'host.log').open('w')
        host = await asyncio.create_subprocess_exec(*command, stdin=subprocess.DEVNULL, stdout=out, stderr=out,
            creationflags=subprocess.CREATE_NO_WINDOW)
        endpoint = None
        try:
            for _ in range(200):
                endpoint = read_endpoint(root)
                if endpoint: break
                if host.returncode is not None: raise AssertionError('fixture exited')
                await asyncio.sleep(.05)
            assert endpoint, 'no fixture endpoint'
            observer = None
            if mode == 'other-client':
                observer = await connect(endpoint['uri'], proxy=None,
                    additional_headers={'Authorization':'Bearer '+endpoint['token']})
            try:
                child = await asyncio.create_subprocess_exec('dotnet', dll,
                    '--prepare-update-cancel' if mode == 'cancel' else '--prepare-update', str(root),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    creationflags=subprocess.CREATE_NO_WINDOW)
                if mode == 'frozen':
                    try:
                        line = await asyncio.wait_for(child.stdout.readline(), 35)
                        assert line.strip() == b'prepared', line
                        assert await asyncio.wait_for(host.wait(), 5) == 0
                        try: UpdateLease(root, exclusive=True)
                        except RuntimeError: pass
                        else: raise AssertionError('coordinator did not hold lease')
                    finally:
                        child.stdin.write(b'\n')
                        await child.stdin.drain()
                        child.stdin.close()
                    assert await asyncio.wait_for(child.wait(), 5) == 0
                    with UpdateLease(root, exclusive=True): pass
                else:
                    stdout, stderr = await asyncio.wait_for(child.communicate(b'\n'), 35)
                    assert child.returncode == 2 and b'prepared' not in stdout, (stdout, stderr)
                    assert host.returncode is None
                    if mode in ('legacy', 'cancel'):
                        calls = (root / 'calls.jsonl').read_text()
                        assert 'shutdown' not in calls, calls
                    if mode == 'cancel':
                        await asyncio.sleep(2.2)
                        async with connect(endpoint['uri'], proxy=None,
                            additional_headers={'Authorization':'Bearer '+endpoint['token']}) as verifier:
                            assert (await rpc(verifier, endpoint, 'test.connections'))['result'] == 1
                    if observer:
                        assert 'result' in await rpc(observer, endpoint, 'server.info')
                results[mode] = 'passed'
            finally:
                if observer: await observer.close()
        finally:
            if host.returncode is None and endpoint:
                async with connect(endpoint['uri'], proxy=None,
                    additional_headers={'Authorization':'Bearer '+endpoint['token']}) as ws:
                    assert (await rpc(ws, endpoint, 'server.shutdown'))['result']['stopped']
                await asyncio.wait_for(host.wait(), 10)
            out.close()

    for mode in ('frozen', 'other-client', 'legacy', 'active', 'bad-ack', 'cancel'):
        await run_case(mode)
    (evidence / 'result.json').write_text(json.dumps(results, indent=2))
    print(json.dumps({'evidence':str(evidence),'cases':results}))


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--fixture':
        asyncio.run(fixture(sys.argv[2], Path(sys.argv[3])))
    elif len(sys.argv) == 3:
        asyncio.run(main(str(Path(sys.argv[1]).resolve()), str(Path(sys.argv[2]).resolve())))
    else:
        raise SystemExit('Supply Client.Tests.dll and SWGoH-Runtime.exe')
