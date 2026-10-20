"""Shared JSONL protocol for the bundled native runtime. No shell evaluation."""
import json
import threading
from prebattle_requests import ROUTES as PREBATTLE, validate as validate_prebattle
from calendar_claims import OPERATIONS as CALENDAR, validate as validate_calendar
from quest_claims import validate as validate_quest

DIRECT = {'snapshot':'inspect', 'arm':'arm', 'configure':'configure', 'disarm':'disarm',
          'battle-ability':'battleability', 'battle-target':'battletarget',
          'battle-unit':'battleunit', 'battle-cancel':'battlecancel',
          'inventory-home':'inventoryhome', 'enemy-status':'enemystatus'}
ENEMY = {'enemy-'+name for name in ('ability','basic','target','unit','cancel','resume','button','tap')}
INVENTORY = {'inventory-list', 'inventory-filter', 'inventory-unit', 'inventory-back',
             'inventory-skill', 'inventory-skill-close', 'inventory-skill-level',
             'inventory-favorite-status'}
MENUS = {**{name:'inboxcommand' for name in ('inbox-open','inbox-list','inbox-select','inbox-home')},
         **{name:'objectivescommand' for name in ('objectives-open','objectives-list','objectives-daily','objectives-achievements','objectives-home','events-back')},
         **{name:'eventscommand' for name in ('events-enter','events-challenges','events-list','events-open','events-missions','events-missions-back')}}
OPERATIONS = sorted(set(DIRECT) | INVENTORY | ENEMY | set(MENUS) | set(PREBATTLE) | CALENDAR | {'connect','disconnect','capabilities',
                    'inventory-characters','inventory-ships','capture-start','capture-status','capture-stop',
                    'battle-inspect','battle-inspect-close','trial-connect','inbox-claim','inbox-claim-status',
                    'objectives-claim','objectives-claim-status','mods-list','mods-enable','mods-disable',
                    'mods-package-inspect','mods-package-install','mods-package-list','mods-package-register','mods-package-uninstall',
                    'mods-config-read','mods-config-write','mods-profile-read','mods-profile-write','mods-command'})


class ProtocolSession:
    """One persistent runtime and routing state, independent of transport framing.

    Serialize native calls; failed cleanup retains ownership for inspection.
    Client disconnect policy belongs to the app-server, not this dispatcher.
    """
    def __init__(self, runtime):
        self.native_runtime = self.runtime = runtime
        self._gate = threading.RLock()
        self._closed = False
        self._cleanup = None

    def dispatch(self, line):
        with self._gate:
            if self._closed:
                return dict(id=None, ok=False, error='Protocol session is closed')
            return self._dispatch(line)

    def _dispatch(self, line):
        runtime, native_runtime = self.runtime, self.native_runtime
        request_id = None
        try:
            if len(line.encode('utf-8')) > 16384:
                raise ValueError('Request exceeds 16 KiB')
            request = json.loads(line)
            if not isinstance(request, dict) or set(request)-{'id','operation','payload'}:
                raise ValueError('Expected id, operation and optional payload')
            request_id = request.get('id')
            if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
                raise ValueError('Request id must be a string or integer')
            operation = request.get('operation')
            if operation not in OPERATIONS:
                raise ValueError('Unknown operation')
            payload = request.get('payload')
            if payload is not None and not isinstance(payload, dict):
                raise ValueError('Payload must be an object')
            if operation == 'capabilities':
                result = dict(protocol='jsonl-v1', operations=OPERATIONS,
                              lifecycle='Explicit connect; exclusive runtime ownership; EOF disconnects',
                              validation='Native callbacks retain original checks; a dispatch receipt is not settlement')
            elif operation == 'mods-command':
                if runtime is not native_runtime:
                    raise ValueError('Mod commands require the normal runtime')
                if (not payload or set(payload) != {'id', 'command', 'payload'}
                        or not isinstance(payload['id'], str) or not isinstance(payload['command'], str)
                        or not isinstance(payload['payload'], dict)):
                    raise ValueError('Mod command requires id, command and object payload')
                result = runtime.call_args('modinvoke', payload['id'], payload['command'], payload['payload'])
            elif operation in ('mods-profile-read', 'mods-profile-write'):
                from mod_profile import read, write
                if operation == 'mods-profile-read':
                    if payload not in (None, {}):
                        raise ValueError('mods-profile-read takes no payload')
                    result = read()
                else:
                    if not payload or set(payload) != {'revision', 'selections'}:
                        raise ValueError('mods-profile-write requires revision and selections')
                    result = write(payload['revision'], payload['selections'])
            elif operation in ('mods-config-read', 'mods-config-write'):
                from mod_config import read, write
                fields = {'sha256'} if operation == 'mods-config-read' else {'sha256', 'revision', 'values'}
                if not payload or set(payload) != fields:
                    raise ValueError('Configuration payload requires ' + ', '.join(sorted(fields)))
                result = (read(payload['sha256']) if operation == 'mods-config-read' else
                          write(payload['sha256'], payload['revision'], payload['values']))
            elif operation in ('mods-package-register', 'mods-package-uninstall'):
                if runtime is not native_runtime:
                    raise ValueError('Mod package changes require the normal runtime')
                if not payload or set(payload) != {'sha256'}:
                    raise ValueError('Mod package change requires only installed sha256')
                result = (runtime.register_package(payload['sha256']) if operation == 'mods-package-register'
                          else runtime.uninstall_package(payload['sha256']))
            elif operation == 'mods-package-list':
                from mod_store import discover
                if payload not in (None, {}):
                    raise ValueError('mods-package-list takes no payload')
                result = discover()
            elif operation == 'mods-package-install':
                from mod_store import install
                if (not payload or set(payload) != {'path', 'sha256'}
                        or not isinstance(payload['path'], str)):
                    raise ValueError('mods-package-install requires absolute path and inspected sha256')
                result = install(payload['path'], payload['sha256'])
            elif operation == 'mods-package-inspect':
                from mod_package import inspect_package
                if not payload or set(payload) != {'path'} or not isinstance(payload['path'], str):
                    raise ValueError('mods-package-inspect requires only an absolute path')
                result = inspect_package(payload['path'])
            elif operation == 'trial-connect':
                from trial_client import TrialClient
                if runtime is not native_runtime or getattr(native_runtime, 'session', None):
                    raise ValueError('Disconnect current client before selecting a trial host')
                if not payload or set(payload) != {'directory','pid'} or not isinstance(payload['directory'], str):
                    raise ValueError('trial-connect requires directory and pid')
                candidate = TrialClient(payload['directory'],payload['pid'])
                result = candidate.snapshot()
                runtime = candidate
            elif operation == 'connect':
                if runtime is not native_runtime:
                    raise ValueError('Disconnect trial client before attaching')
                options = payload or {}
                if set(options)-{'information'} or type(options.get('information',False)) is not bool:
                    raise ValueError('connect accepts only boolean information')
                result = runtime.connect(information=options.get('information',False))
            elif operation == 'disconnect':
                result = runtime.disconnect()
                runtime = native_runtime
            elif operation in ('mods-list','mods-enable','mods-disable'):
                if runtime is not native_runtime:
                    raise ValueError('Mod management requires the normal runtime')
                options = payload or {}
                if operation == 'mods-list':
                    if options: raise ValueError('mods-list takes no payload')
                elif set(options) != {'id'} or not isinstance(options['id'],str) or not 1 <= len(options['id']) <= 128:
                    raise ValueError('Mod operation requires only id')
                result = runtime.call_args('modcommand', operation.removeprefix('mods-'), options)
            elif operation in ('objectives-claim', 'objectives-claim-status'):
                if runtime is not native_runtime:
                    raise ValueError('Quest rewards require the normal client connection')
                result = runtime.quest_reward(operation, validate_quest(payload))
            elif operation in CALENDAR:
                if runtime is not native_runtime:
                    raise ValueError('Calendar operations require the normal client connection')
                result = runtime.calendar_command(operation, validate_calendar(operation, payload))
            elif operation.startswith('capture-'):
                if payload:raise ValueError('Capture operations take no payload; output path is generated locally')
                result=runtime.capture_command(operation)
            elif operation == 'battle-inspect':
                if not payload or set(payload) != {'unitId'} or not isinstance(payload['unitId'], str) or not 1 <= len(payload['unitId']) <= 256:
                    raise ValueError('battle-inspect requires only a current unitId')
                result = runtime.call('battleinspect', payload)
            elif operation == 'battle-inspect-close':
                if payload:
                    raise ValueError('battle-inspect-close takes no payload')
                result = runtime.call('battleinspect', {'close': True})
            elif operation in ENEMY:
                if not payload or not isinstance(payload.get('token'),str) or not payload['token']:
                    raise ValueError('Current enemy input token required')
                result = runtime.call_args('enemyinput', operation.removeprefix('enemy-'), payload)
            elif operation in ('inbox-claim','inbox-claim-status'):
                if not payload or set(payload) != {'messageId'} or not isinstance(payload['messageId'],str) or not 1 <= len(payload['messageId']) <= 256:
                    raise ValueError('Expected current messageId only')
                result = runtime.inbox_reward(operation, payload['messageId'])
            elif operation in PREBATTLE:
                options = validate_prebattle(operation, payload)
                result = runtime.call(PREBATTLE[operation]) if operation == 'prebattle-back' else runtime.call_args(PREBATTLE[operation], operation, options)
            elif operation in MENUS:
                options = payload or {}
                if operation == 'inbox-select':
                    if set(options) != {'messageId'} or not isinstance(options['messageId'],str) or not 1 <= len(options['messageId']) <= 256:
                        raise ValueError('Expected current messageId only')
                elif operation == 'events-open':
                    if set(options) != {'eventId','instanceId'} or any(not isinstance(options[k],str) or len(options[k]) > 256 for k in options) or not options['eventId']:
                        raise ValueError('Expected current eventId and instanceId only')
                elif options:
                    raise ValueError('This menu operation takes no payload')
                result = runtime.call_args(MENUS[operation], operation, options)
            elif operation in INVENTORY:
                result = runtime.call_args('inventorycommand', operation, payload or {})
            elif operation in ('inventory-characters','inventory-ships'):
                result = runtime.call('openinventory', 'characters' if operation.endswith('characters') else 'ships')
            else:
                result = runtime.call(DIRECT[operation], payload)
            return dict(id=request_id, ok=True, result=result)
        except Exception as error:
            return dict(id=request_id, ok=False, error=str(error))

        finally:
            self.runtime = runtime

    def close(self):
        with self._gate:
            if not self._closed:
                self._cleanup = self.runtime.disconnect()
                self._closed = True
            return self._cleanup


def run_jsonl(runtime, source, destination):
    session = ProtocolSession(runtime)
    def emit(value):
        destination.write(json.dumps(value, ensure_ascii=False)+'\n')
        destination.flush()
    try:
        for line in source:
            emit(session.dispatch(line))
    finally:
        try:
            emit(dict(event='closed', cleanup=session.close()))
        except Exception as error:
            emit(dict(event='cleanup-failed', error=str(error)))
            raise
