"""Shared loopback JSON-RPC transport. Frontend EOF doesn't own runtime lifetime."""
import asyncio
import hmac
import json
import os
import secrets
import uuid
from http import HTTPStatus

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from runtime_protocol import ProtocolSession


class AppServer:
    def __init__(self, runtime, token):
        if not isinstance(token, str) or len(token) < 32 or not token.isascii():
            raise ValueError('Supply a random ASCII bearer token of at least 32 characters')
        self._token = token
        self.instance = str(uuid.uuid4())
        self.session = ProtocolSession(runtime)
        self._gate = asyncio.Lock()
        self._responses = {}
        self._server = None
        self._stopped = False
        self._updating = False
        self._clients = set()
        self.uri = None
        self.game_pid = None

    def _authenticate(self, connection, request):
        headers = request.headers.get_all('Authorization')
        if (request.path != '/rpc' or len(headers) != 1 or
                not hmac.compare_digest(headers[0], 'Bearer ' + self._token)):
            return connection.respond(HTTPStatus.UNAUTHORIZED, 'Authorization required\n')
        if request.headers.get_all('Origin'):
            return connection.respond(HTTPStatus.FORBIDDEN, 'Browser origins are not enabled\n')
        if self._updating or self._stopped:
            return connection.respond(HTTPStatus.SERVICE_UNAVAILABLE, 'Server is closing\n')

    async def start(self, port=0):
        if self._server is not None or self._stopped:
            raise RuntimeError('Server already started or stopped')
        self._server = await serve(
            self._handle, '127.0.0.1', port, process_request=self._authenticate,
            origins=[None], max_size=16384, max_queue=8, compression=None,
            ping_interval=20, ping_timeout=20, server_header=None)
        self.uri = f'ws://127.0.0.1:{self._server.sockets[0].getsockname()[1]}/rpc'
        return self.uri

    @staticmethod
    def error(request_id, code, message):
        return {'jsonrpc': '2.0', 'id': request_id, 'error': {'code': code, 'message': message}}

    async def _handle(self, websocket):
        # A handshake may have begun before update shutdown reserved the server.
        if self._updating or self._stopped:
            await websocket.close(code=1012, reason='Server is closing')
            return
        self._clients.add(websocket)
        try:
            async for message in websocket:
                reply = await self.dispatch(message, websocket)
                await websocket.send(json.dumps(reply, ensure_ascii=False))
                if self._stopped:
                    self._server.close()
                    break
        except ConnectionClosed:
            # A dropped frontend must not disconnect another frontend's runtime.
            pass
        finally:
            self._clients.discard(websocket)
            if self._stopped:
                self._server.close()

    async def dispatch(self, message, client=None):
        request_id = None
        try:
            if not isinstance(message, str) or len(message.encode('utf8')) > 16384:
                return self.error(None, -32600, 'Expected JSON text within 16 KiB')
            try:
                request = json.loads(message)
            except (ValueError, TypeError):
                return self.error(None, -32700, 'Invalid JSON')
            if not isinstance(request, dict):
                return self.error(None, -32600, 'Batch requests are not supported')
            request_id = request.get('id')
            if (not isinstance(request_id, str) or not request_id or len(request_id) > 128 or
                    request.get('jsonrpc') != '2.0' or
                    set(request) - {'jsonrpc', 'id', 'method', 'params'}):
                return self.error(None, -32600, 'Require JSON-RPC 2.0 and a nonempty string id')
            if request.get('method') == 'server.info':
                return {'jsonrpc': '2.0', 'id': request_id, 'result': {
                    'instance': self.instance, 'transport': 'websocket',
                    'hostPid': os.getpid(), 'gamePid': self.game_pid,
                    'sessionMode': 'prepared' if self.session.trials.owns_session else ('normal' if self.game_pid is not None else 'idle'),
                    'sharedRuntime': True, 'remoteEnabled': False,
                    'updateShutdownSupported': True,
                    'updateLeaseVersion': 1,
                    'disconnectPolicy': 'Frontend disconnect retains shared runtime',
                    'retryPolicy': 'Never replay against a different server instance'}}
            if request.get('method') == 'server.shutdownForUpdate':
                if request.get('params') != {'instance': self.instance}:
                    return self.error(request_id, -32602, 'Current server instance required')
                async with self._gate:
                    if self._stopped or self._updating:
                        return self.error(request_id, -32000, 'Server is closing')
                    if client is None or self._clients != {client}:
                        return self.error(request_id, -32020, 'Other frontends are connected; update postponed')
                    # Check retained native ownership, not only the successful connect receipt:
                    # failed/partial connects and prepared starts must block updates too.
                    if (self.game_pid is not None or self.session.trials.owns_session or
                            getattr(self.session.native_runtime, 'session', True) is not None or
                            getattr(self.session.native_runtime, 'script', True) is not None):
                        return self.error(request_id, -32021, 'Game session retained; restore it before updating')
                    self._updating = True
                    try:
                        await asyncio.to_thread(self.session.close)
                        self._stopped = True
                    finally:
                        if not self._stopped:
                            self._updating = False
                return {'jsonrpc': '2.0', 'id': request_id, 'result': {'stopped': True, 'reason': 'update'}}
            if request.get('method') == 'server.shutdown':
                if request.get('params') != {'instance': self.instance}:
                    return self.error(request_id, -32602, 'Current server instance required')
                async with self._gate:
                    await asyncio.to_thread(self.session.close)
                    self._stopped = True
                return {'jsonrpc': '2.0', 'id': request_id, 'result': {'stopped': True}}
            if request.get('method') != 'runtime.call':
                return self.error(request_id, -32601, 'Unknown method')
            params = request.get('params')
            if (not isinstance(params, dict) or
                    set(params) - {'instance', 'operation', 'payload'} or
                    params.get('instance') != self.instance):
                return self.error(request_id, -32602, 'Current server instance and operation required')
            canonical = json.dumps(params, sort_keys=True, ensure_ascii=False)
            async with self._gate:
                if self._stopped:
                    return self.error(request_id, -32000, 'Server stopped')
                previous = self._responses.get(request_id)
                if previous:
                    if previous[0] != canonical:
                        return self.error(request_id, -32600, 'Request id already used with different parameters')
                    return previous[1]
                if len(self._responses) >= 4096:
                    return self.error(request_id, -32000, 'Session request ledger full; no command dispatched')
                line = json.dumps({'id': request_id, 'operation': params.get('operation'),
                                   'payload': params.get('payload')}, ensure_ascii=False)
                # Reserve before awaiting; cancellation or an unknown failure must not permit replay.
                unknown = self.error(request_id, -32001, 'Dispatch outcome unknown; do not replay')
                self._responses[request_id] = (canonical, unknown)
                result = await asyncio.shield(asyncio.to_thread(self.session.dispatch, line))
                if result.get('ok') and params.get('operation') in ('connect', 'trial-start'):
                    self.game_pid = result['result'].get('pid')
                elif result.get('ok') and params.get('operation') in ('disconnect', 'trial-stop'):
                    self.game_pid = None
                if result.get('ok') and params.get('operation') == 'capabilities':
                    result['result'] = {**result['result'], 'protocol': 'jsonrpc-2.0-websocket',
                                        'lifecycle': 'Shared runtime; frontend EOF retains session; explicit disconnect affects all clients'}
                reply = ({'jsonrpc': '2.0', 'id': request_id, 'result': result.get('result')}
                         if result.get('ok') else
                         self.error(request_id, -32010, result.get('error', 'Runtime operation failed')))
                self._responses[request_id] = (canonical, reply)
                return reply
        except Exception:
            # Do not return stack frames or authentication/configuration data to clients.
            return self.error(request_id, -32603, 'App-server request failed; query status before any retry')

    async def stop(self):
        async with self._gate:
            if self._stopped:
                return
            # If cleanup fails, leave the listener/session alive for explicit recovery.
            await asyncio.to_thread(self.session.close)
            self._stopped = True
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def wait_closed(self):
        if self._server is None:
            raise RuntimeError('Server not started')
        await self._server.wait_closed()


async def run_host(runtime, token, destination, endpoint_directory=None):
    from server_endpoint import EndpointOwner
    token = token or secrets.token_urlsafe(32)
    server = AppServer(runtime, token)
    owner = EndpointOwner(endpoint_directory)
    try:
        await server.start()
        owner.publish(server.uri, server.instance, token)
        destination.write(json.dumps({'event': 'server-ready', 'uri': server.uri,
                                      'instance': server.instance}) + '\n')
        destination.flush()
        await server.wait_closed()
    finally:
        await server.stop()
        owner.close()
