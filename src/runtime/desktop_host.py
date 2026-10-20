"""Private client worker. Packaged with WinUI; never launches the legacy GUI."""
import argparse
import asyncio
import os
import sys
from runtime_core import Runtime
from runtime_protocol import run_jsonl


def main():
    parser = argparse.ArgumentParser(description='Internal SWGoH desktop runtime')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--desktop-ipc', action='store_true')
    mode.add_argument('--prepared-ipc', action='store_true')
    mode.add_argument('--app-server', action='store_true')
    parser.add_argument('--server-directory', help='Explicit app-server endpoint directory')
    args = parser.parse_args()
    if args.server_directory and not args.app_server:
        parser.error('--server-directory requires --app-server')
    if sys.stdin is None or sys.stdout is None:
        raise RuntimeError('Desktop worker requires redirected stdin/stdout')
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    if args.app_server:
        from app_server import run_host
        asyncio.run(run_host(Runtime(), os.environ.get('BLUEMILK_SERVER_TOKEN'), sys.stdout, args.server_directory))
    elif args.prepared_ipc:
        from prepared_protocol import run_prepared
        run_prepared(sys.stdin, sys.stdout)
    else:
        run_jsonl(Runtime(), sys.stdin, sys.stdout)


if __name__ == '__main__':
    main()
