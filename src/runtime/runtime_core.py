"""Shared runtime core for the human client and independent agent CLI."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import frida
import psutil
from session_lock import acquire_session
from inbox_claims import InboxClaims
from calendar_claims import CalendarClaims, validate as validate_calendar
from quest_claims import QuestClaims, validate as validate_quest

ASSETS = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent)) / 'assets'
DATA = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'SWGoH-Tool'
EXPECTED = '12cc254525a58aedea122a2967d0476da05b98ef0c219dc18cfc0b7207538db6'
MODULES = ['runtime_api.js', 'unity_scene_api.js', 'battle_status_reader.js',
           'battle_attributes_reader.js', 'battle_input.js', 'runtime_observer.js',
           'enemy_manual_ui.js', 'enemy_input_gate.js', 'live_arena_taunt.js', 'calendar_bridge.js',
           'battle_info_ui.js', 'battle_events.js', 'original_ai_trace.js', 'ai_trace_mod.js', 'mod_runtime.js', 'trial_mod.js']
def find_game():
    games = []
    for p in psutil.process_iter(['pid','name','exe','cmdline']):
        if (p.info['name'] or '').lower() == 'swgoh.exe':
            games.append(p.info)
        if (p.info['name'] or '').lower() == 'node.exe':
            cmd = ' '.join(p.info['cmdline'] or [])
            if 'run_battle_info.mjs' in cmd or 'run_captured_trial.mjs' in cmd:
                raise RuntimeError('旧版脚本正在连接游戏，请先关闭旧助手或结束试玩，再点击连接。')
    if len(games) != 1:
        raise RuntimeError('请启动一个 SWGoH 原客户端，并登录游戏。')
    game = games[0]
    if not game['exe']:
        raise RuntimeError('无法读取游戏路径，请使用与游戏相同权限运行工具。')
    dll = Path(game['exe']).parent / 'GameAssembly.dll'
    with dll.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    if digest != EXPECTED:
        raise RuntimeError('游戏版本不匹配，已停止连接；需要更新工具以适配此版本。')
    return game

class Runtime:
    def __init__(self):
        self.session = self.script = None
        self.release_ownership = None
        self.capture = None
        self.package_leases = {}
        self.inbox_claims = InboxClaims(DATA/'inbox-claims')
        self.calendar_claims = CalendarClaims(DATA/'calendar-claims')
        self.quest_claims = QuestClaims(DATA/'quest-claims')

    def connect(self, information=False):
        if self.session:
            raise RuntimeError('已经连接')
        game = find_game()
        modules = MODULES.copy()
        source = 'globalThis.deferBattleInfoInstallation=true;\n'
        source += '\n'.join((ASSETS / n).read_text(encoding='utf-8-sig') for n in modules)
        source += '\n' + (ASSETS / 'bridge.js').read_text(encoding='utf-8')
        DATA.mkdir(parents=True, exist_ok=True)
        self.release_ownership = acquire_session(game['pid'])
        try:
            self.session = frida.attach(game['pid'])
            self.script = self.session.create_script(source)
            self.script.on('message', self.message)
            self.script.load()
            from mod_profile import acquire
            startup, selected, leases = acquire()
            self.package_leases.update(leases)
            for _, payload in selected:
                self.register_package(payload[2])
            for identity, _ in selected:
                if startup['selections'][identity]['enabled']:
                    self.call_args('modcommand', 'enable', {'id': identity})
            if information:
                if 'bluemilk.pro' not in startup['selections']:
                    raise RuntimeError('Install BlueMilk Pro and select it in startup settings before enabling information')
                self.script.exports_sync.modcommand('enable', {'id':'bluemilk.pro'})
            self.inbox_claims = InboxClaims(DATA/'inbox-claims')
            self.calendar_claims = CalendarClaims(DATA/'calendar-claims')
            self.quest_claims = QuestClaims(DATA/'quest-claims')
            return {'pid':game['pid'], 'snapshot':self.script.exports_sync.inspect(),
                    'modProfileRevision': startup['revision']}
        except Exception:
            if self.script:
                # A failed installation can own hooks/UI. Verify restoration
                # before detaching; cleanup failure retains the session lock.
                self.script.exports_sync.shutdown()
            if self.session:
                self.session.detach()
            self.session = self.script = None
            self._release_packages()
            self.release_ownership()
            self.release_ownership = None
            raise

    def message(self, message, data):
        with (DATA / 'runtime.jsonl').open('a', encoding='utf-8') as f:
            f.write(json.dumps({'time':time.time(), 'message':message}, ensure_ascii=False) + '\n')

    def call(self, operation, payload=None):
        if not self.script:
            raise RuntimeError('请先连接游戏')
        method = getattr(self.script.exports_sync, operation)
        return method() if payload is None else method(payload)

    def capture_command(self, operation):
        if not self.session:
            raise RuntimeError('请先连接游戏')
        if operation=='capture-start':
            if self.capture and self.capture.script:
                raise RuntimeError('Capture already active; stop it before starting another')
            from passive_capture import PassiveCapture
            self.capture=PassiveCapture(self.session,ASSETS,DATA/'captures')
        if operation=='capture-stop':
            return self.capture.close() if self.capture else {'active':False}
        return self.capture.status() if self.capture else {'active':False}

    def call_args(self, operation, *args):
        if not self.script:
            raise RuntimeError('请先连接游戏')
        return getattr(self.script.exports_sync, operation)(*args)

    def register_package(self, sha256):
        from mod_store import acquire_package
        from mod_config import read
        if not self.script:
            raise RuntimeError('Connect before registering a Mod')
        if sha256 not in self.package_leases:
            payload, release = acquire_package(sha256)
            self.package_leases[sha256] = (payload, release)
        payload, _ = self.package_leases[sha256]
        # Unknown registration outcomes retain the lease until confirmed cleanup.
        return self.call_args('modregisterpackage', *payload, read(sha256)['values'])

    def uninstall_package(self, sha256):
        from mod_store import remove
        from mod_profile import read
        if any(item['sha256'] == sha256 for item in read()['selections'].values()):
            raise ValueError('Remove this version from the startup profile before uninstalling')
        if sha256 in self.package_leases:
            payload, release = self.package_leases[sha256]
            result = self.call_args('modunregisterpackage', payload[0]['id'], sha256)
            if not isinstance(result, dict) or result.get('unregistered') is not True:
                raise RuntimeError('Mod unregister was not confirmed; package retained')
            release()
            del self.package_leases[sha256]
        return remove(sha256)

    def _release_packages(self):
        for _, release in self.package_leases.values():
            release()
        self.package_leases.clear()

    def inbox_reward(self, operation, message_id):
        call = lambda op, payload: self.call_args('inboxcommand', op, payload)
        if operation == 'inbox-claim-status':
            return self.inbox_claims.status(message_id, call if self.script else None)
        if operation != 'inbox-claim' or not self.script:
            raise RuntimeError('Connect before claiming an inbox reward')
        return self.inbox_claims.submit(message_id, call)

    def quest_reward(self, operation, payload):
        identity = validate_quest(payload)
        call = lambda op, p: self.call_args('objectivescommand', op, p)
        if operation == 'objectives-claim-status':
            return self.quest_claims.status(identity, call if self.script else None)
        if operation != 'objectives-claim' or not self.script:
            raise RuntimeError('Connect before claiming an objective reward')
        return self.quest_claims.submit(identity, call)

    def calendar_command(self, operation, payload=None):
        identity = validate_calendar(operation, payload)
        call = lambda op, p: self.call_args('calendarcommand', op, p)
        if operation == 'calendar-claim-status':
            return self.calendar_claims.status(identity, call if self.script else None)
        if not self.script:
            raise RuntimeError('Connect before using the original calendar')
        if operation == 'calendar-claim':
            return self.calendar_claims.submit(identity, call)
        if operation == 'calendar-visibility':
            return self.call('calendarvisibility')
        return call(operation, identity)

    def disconnect(self):
        if self.session:
            try:
                if self.capture:self.capture.close()
                self.script.exports_sync.shutdown()
            except (frida.InvalidOperationError, frida.ProcessNotFoundError):
                pass  # Process exited; no native callbacks remain.
            # Other failures retain ownership so a held callback is not discarded.
            self.session.detach()
            self.session = self.script = None
            self.capture = None
        if self.release_ownership:
            self.release_ownership()
            self.release_ownership = None
        self._release_packages()
        return {'disconnected':True}
