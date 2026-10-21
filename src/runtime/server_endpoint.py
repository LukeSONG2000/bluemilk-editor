"""Windows current-user discovery. Never serialize a plaintext bearer token."""
import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import math
import os
from pathlib import Path
import uuid
from urllib.parse import urlsplit

import psutil
from update_lease import UpdateLease, global_directory


class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def protect(value, decrypt=False):
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    buf = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise OSError(ctypes.get_last_error(), 'Windows user protection failed')
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        ctypes.memset(result.data, 0, result.size)
        kernel.LocalFree(result.data)


def directory(path=None):
    path = path or os.environ.get('BLUEMILK_SERVER_DIRECTORY')
    # AppData can be redirected by the launcher package (including an agent's
    # own MSIX). A profile-level directory stays common to both entry points.
    return (Path(path) if path else Path(os.environ['USERPROFILE']) / '.bluemilk' / 'server').resolve()


def validate_endpoint(data):
    if not isinstance(data, dict) or type(data.get('schemaVersion')) is not int or data['schemaVersion'] != 1:
        raise ValueError('Unsupported endpoint record')
    url = urlsplit(data['uri'])
    if (url.scheme != 'ws' or url.hostname != '127.0.0.1' or not url.port or url.path != '/rpc' or
            url.query or url.fragment or url.username is not None or url.password is not None):
        raise ValueError('Only local app-server endpoints are allowed')
    if str(uuid.UUID(data['instance'])) != data['instance']:
        raise ValueError('Invalid server instance')
    if (type(data['pid']) is not int or data['pid'] <= 0 or type(data['created']) not in (int, float) or
            not math.isfinite(data['created']) or data['created'] <= 0):
        raise ValueError('Invalid server process identity')


def read_endpoint(path=None):
    file = directory(path) / 'endpoint.json'
    try:
        # The owner may remove or atomically replace the record during discovery.
        # Read one bounded snapshot rather than racing exists/stat/read calls.
        with file.open('rb') as stream:
            raw = stream.read(16385)
    except FileNotFoundError:
        return None
    if len(raw) > 16384:
        raise ValueError('Endpoint record too large')
    data = json.loads(raw.decode('utf8'))
    validate_endpoint(data)
    try:
        process = psutil.Process(data['pid'])
        if abs(process.create_time() - data['created']) > 0.001:
            return None
    except psutil.NoSuchProcess:
        return None
    protected = base64.b64decode(data['protectedToken'], validate=True)
    token = protect(protected, decrypt=True).decode('ascii')
    if len(token) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise ValueError('Invalid protected endpoint token')
    return {**data, 'token': token}


class EndpointOwner:
    def __init__(self, path=None):
        self.root = directory(path)
        self.file = self.root / 'endpoint.json'
        self.instance = None
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateMutexW.restype = wintypes.HANDLE
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        name = 'Local\\BlueMilk-AppServer-' + hashlib.sha256(str(self.root).casefold().encode()).hexdigest()
        self.lease = UpdateLease(self.root)
        self.global_lease = None
        try:
            self.global_lease = UpdateLease(global_directory())
            self.handle = self.kernel.CreateMutexW(None, False, name)
            if not self.handle:
                raise OSError(ctypes.get_last_error(), 'Cannot create app-server mutex')
            if self.kernel.WaitForSingleObject(self.handle, 0) not in (0, 0x80):
                self.kernel.CloseHandle(self.handle)
                self.handle = None
                raise RuntimeError('A shared app-server already owns this endpoint directory')
        except BaseException:
            if self.global_lease is not None:
                self.global_lease.close()
            self.lease.close()
            raise

    def publish(self, uri, instance, token):
        if self.instance is not None or self.handle is None:
            raise RuntimeError('Endpoint owner already published or closed')
        if not isinstance(token, str) or len(token) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError('Invalid endpoint token')
        data = {'schemaVersion': 1, 'uri': uri, 'instance': instance, 'pid': os.getpid(),
                'created': psutil.Process().create_time(),
                'protectedToken': base64.b64encode(protect(token.encode('ascii'))).decode('ascii')}
        validate_endpoint(data)
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = self.root / (str(uuid.uuid4()) + '.partial')
        try:
            with temporary.open('x', encoding='utf8') as stream:
                json.dump(data, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file)
            self.instance = instance
        finally:
            temporary.unlink(missing_ok=True)

    def close(self):
        if self.handle is None:
            return
        try:
            if self.instance and self.file.exists():
                data = json.loads(self.file.read_text(encoding='utf8'))
                if data.get('instance') == self.instance and data.get('pid') == os.getpid():
                    self.file.unlink()
        finally:
            self.kernel.ReleaseMutex(self.handle)
            self.kernel.CloseHandle(self.handle)
            self.handle = None
            self.lease.close()
            self.global_lease.close()
