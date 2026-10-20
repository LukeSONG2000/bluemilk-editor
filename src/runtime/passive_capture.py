"""One passive natural BattleData capture; never enters or requests a battle."""
import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone

MODULES = ['runtime_api.js','unity_scene_api.js','battle_proto.js','battle_capture.js']


def save_capture(path, metadata, data):
    if (metadata.get('kind') != 'original-battle-proto-captured' or metadata.get('encoding') != 'direct-protobuf-v2'
            or not isinstance(data, bytes) or not 0 < len(data) <= 16*1024*1024 or metadata.get('bytes') != len(data)):
        raise ValueError('Invalid original capture payload')
    sidecar=path.with_name(path.name+'.json')
    if path.exists() or sidecar.exists():raise ValueError('Capture already exists')
    path.parent.mkdir(parents=True,exist_ok=True)
    record=dict(metadata,sha256=hashlib.sha256(data).hexdigest(),capturedAt=datetime.now(timezone.utc).isoformat())
    with path.open('xb') as f:f.write(data)
    with sidecar.open('x',encoding='utf8') as f:json.dump(record,f,ensure_ascii=False,indent=2)
    return dict(path=str(path),bytes=len(data),sha256=record['sha256'])


def save_mode(path, provenance):
    metadata=json.loads(path.with_name(path.name+'.json').read_text(encoding='utf8'))
    if (provenance.get('kind') != 'original-battle-mode-provenance' or not metadata.get('captureId')
            or provenance.get('captureId') != metadata['captureId']
            or type(provenance.get('battleType')) is not int or type(provenance.get('combatType')) is not int
            or provenance.get('replayCompatibilityVerified') is not False):
        raise ValueError('Unmatched battle mode provenance')
    if hashlib.sha256(path.read_bytes()).hexdigest()!=metadata['sha256']:
        raise ValueError('Capture integrity mismatch')
    record=dict(provenance,battleSha256=metadata['sha256'])
    with path.with_name(path.name+'.mode.json').open('x',encoding='utf8') as f:json.dump(record,f,indent=2)
    return record


class PassiveCapture:
    def __init__(self, session, assets, directory):
        self.script=None
        self.path=directory/('battle-'+uuid.uuid4().hex+'.pb')
        self.saved=None;self.mode=None;self.errors=[];self.lock=threading.Lock()
        source='\n'.join((assets/n).read_text(encoding='utf-8-sig') for n in MODULES)
        source+='\nrpc.exports={status:()=>BattleCapture.status(),stop:()=>{BattleCapture.stop();return BattleCapture.status();}};'
        self.script=session.create_script(source)
        self.script.on('message',self.message)
        try:self.script.load()
        except Exception:
            self.script.unload();self.script=None
            raise

    def message(self,message,data):
        with self.lock:
            try:
                if message.get('type')=='error':raise RuntimeError(message.get('description','Capture script error'))
                payload=message.get('payload',{})
                if payload.get('kind')=='original-battle-proto-captured':self.saved=save_capture(self.path,payload,data)
                elif payload.get('kind')=='original-battle-mode-provenance':self.mode=save_mode(self.path,payload)
                elif payload.get('kind')=='original-battle-proto-capture-error':raise RuntimeError(payload.get('error'))
            except Exception as error:self.errors.append(str(error))

    def status(self):
        native=self.script.exports_sync.status() if self.script else None
        with self.lock:
            return dict(active=self.script is not None,path=str(self.path),capture=self.saved,
                        modeProvenance=self.mode,errors=list(self.errors),native=native,
                        scope='Passive natural response only; mode provenance does not prove replay compatibility')

    def close(self):
        if self.script:
            self.script.exports_sync.stop()
            self.script.unload();self.script=None
        return self.status()
