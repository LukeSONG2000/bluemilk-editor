"""JSONL frontend to a shared app-server. No automatic reconnection or replay."""
import hashlib
import json
import uuid
from urllib.parse import urlsplit
from websockets.sync.client import connect


def run_shared_jsonl(uri, token, source, destination, expected_instance=None, expected_pid=None):
    parsed = urlsplit(uri)
    if (parsed.scheme != 'ws' or parsed.hostname != '127.0.0.1' or
            not parsed.port or parsed.path != '/rpc' or parsed.query or parsed.fragment or
            parsed.username is not None or parsed.password is not None):
        raise ValueError('This build only supports ws://127.0.0.1:PORT/rpc')
    if not token or len(token) < 32 or not token.isascii():
        raise ValueError('Set BLUEMILK_SERVER_TOKEN to the local app-server token')

    def emit(row):
        destination.write(json.dumps(row, ensure_ascii=False) + '\n')
        destination.flush()

    def exchange(socket, request):
        socket.send(json.dumps(request, ensure_ascii=False))
        raw = socket.recv(timeout=30)
        response = json.loads(raw)
        if (not isinstance(response, dict) or response.get('jsonrpc') != '2.0' or
                response.get('id') != request['id'] or
                ('result' in response) == ('error' in response)):
            raise RuntimeError('Invalid app-server response')
        return response

    client = str(uuid.uuid4())
    try:
        with connect(uri, additional_headers={'Authorization': 'Bearer ' + token},
                     proxy=None, compression=None, max_size=16 * 1024 * 1024) as socket:
            hello = exchange(socket, {'jsonrpc': '2.0', 'id': client, 'method': 'server.info'})
            instance = hello['result']['instance']
            if ((expected_instance is not None and instance != expected_instance) or
                    (expected_pid is not None and hello['result'].get('hostPid') != expected_pid)):
                raise RuntimeError('Discovered server identity changed; no command dispatched')
            for line in source:
                request_id = None
                try:
                    if len(line.encode('utf8')) > 16384:
                        raise ValueError('Request exceeds 16 KiB')
                    request = json.loads(line)
                    if not isinstance(request, dict) or set(request) - {'id', 'operation', 'payload'}:
                        raise ValueError('Expected id, operation and optional payload')
                    request_id = request.get('id')
                    if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
                        raise ValueError('Request id must be a string or integer')
                except (ValueError, TypeError) as error:
                    emit({'id': request_id, 'ok': False, 'error': str(error)})
                    continue
                # Keep repeated IDs within this CLI session stable, without cross-client collisions.
                wire_id = client + ':' + hashlib.sha256(json.dumps(request_id).encode()).hexdigest()
                try:
                    response = exchange(socket, {'jsonrpc': '2.0', 'id': wire_id, 'method': 'runtime.call',
                        'params': {'instance': instance, 'operation': request.get('operation'),
                                   'payload': request.get('payload')}})
                except Exception:
                    emit({'id': request_id, 'ok': False, 'error': 'App-server response unavailable',
                          'outcome': 'unknown', 'retryBlocked': True, 'serverInstance': instance})
                    return
                if 'error' in response:
                    emit({'id': request_id, 'ok': False, 'error': response['error']['message'],
                          'serverInstance': instance, 'code': response['error']['code']})
                else:
                    emit({'id': request_id, 'ok': True, 'result': response['result']})
    finally:
        emit({'event': 'closed', 'connectionClosed': True, 'runtimeCleanupRequested': False})
