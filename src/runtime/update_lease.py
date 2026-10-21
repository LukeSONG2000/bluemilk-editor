"""Windows handle-backed exclusion between running hosts and package replacement.

Hosts hold shared leases for their entire endpoint lifetime. An updater takes an
exclusive lease only after orderly host shutdown; if another host wins that race,
the updater must postpone installation. Stale files never imply a held lease.
"""
import ctypes
import os
from ctypes import wintypes
from pathlib import Path


def global_directory():
    # Independent of BLUEMILK_SERVER_DIRECTORY and shared by both installations.
    return Path(os.environ['USERPROFILE']) / '.bluemilk' / 'runtime-update'


class UpdateLease:
    def __init__(self, directory, *, exclusive=False):
        root = Path(directory).resolve()
        root.mkdir(parents=True, exist_ok=True)
        kernel = self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                      wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        # OPEN_ALWAYS, read/write, no delete sharing. No inherited handles.
        self.handle = kernel.CreateFileW(str(root / 'update.lock'), 0xC0000000,
                                        0 if exclusive else 3, None, 4, 0x80, None)
        if self.handle == ctypes.c_void_p(-1).value:
            self.handle = None
            error = ctypes.get_last_error()
            if error == 32:
                raise RuntimeError('Update or running host owns the installation lease')
            raise OSError(error, 'Cannot acquire installation lease')

    def close(self):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
