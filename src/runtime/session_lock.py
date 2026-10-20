"""Cross-host runtime ownership shared with the Node CLI, independent of install path."""
import json
import os
from pathlib import Path
import psutil


def acquire_session(pid, directory=None):
    if type(pid) is not int or pid <= 0:
        raise ValueError('Invalid game PID')
    directory = Path(directory) if directory else Path(os.environ.get('LOCALAPPDATA', str(Path.home())))/'SWGoH-Tool'/'sessions'
    directory.mkdir(parents=True, exist_ok=True)
    file = directory/f'runtime-session-{pid}.lock'
    owner = dict(hostPid=os.getpid(), gamePid=pid)
    for _ in range(2):
        try:
            handle = file.open('x', encoding='utf-8')
        except FileExistsError:
            try:
                existing = json.loads(file.read_text(encoding='utf-8'))
                host = existing['hostPid']
                if type(host) is not int or host <= 0:
                    raise ValueError('Invalid host PID')
            except Exception as error:
                raise RuntimeError('连接锁正在写入或无法读取，请稍后重试；未接管现有连接。') from error
            if psutil.pid_exists(host):
                raise RuntimeError(f'游戏已有工具连接（进程 {host}），请先正常断开该工具。')
            file.unlink()
            continue
        try:
            handle.write(json.dumps(owner))
            handle.flush()
        except Exception:
            handle.close()
            file.unlink(missing_ok=True)
            raise
        def release():
            handle.close()
            try:
                if json.loads(file.read_text(encoding='utf-8')) == owner:
                    file.unlink()
            except FileNotFoundError:
                pass
        return release
    raise RuntimeError('无法取得游戏连接锁')
