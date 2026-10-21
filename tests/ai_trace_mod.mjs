import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const manifest = JSON.parse(read('../mods/ai-analysis/mod.json'));
const entry = read('../mods/ai-analysis/main.js');
function fixture({ home=false, partial=false, failStop=false, legacy=false, failFlushAt=0 }={}) {
  let retained=0,released=0,stops=0,installed=0,flushes=0,options;
  const nil={isNull:()=>true},state={isNull:()=>false},controller={isNull:()=>false},context={isNull:()=>false};
  const trace={snapshot:()=>({rows:[{sequence:1}],errors:[]}),stop(){stops++;if(failStop){failStop=false;throw Error('detach failed');}}};
  const c=vm.createContext({rpc:{exports:{}},
    RuntimeApi:{nil,runOnMainThreadOnce:fn=>Promise.resolve().then(fn),findBound:()=>state,
      readRef:(_p,f)=>f==='<CurrentState>k__BackingField'?state:f==='_battleController'?controller:context,
      classOf:x=>x,fullName:()=>home?'HomeBaseGameState':'BattleGameState',
      retain(){retained++;return 7;},release(value){assert.equal(value,7);released++;}},
    BattleInstanceIdentity:{read:()=> 'test-battle'},Interceptor:{flush(){if(++flushes===failFlushAt)throw Error('flush failed');}},
    installOriginalAITrace(_context,o){installed++;options=o;if(partial){const e=Error('partial attach');e.cleanupHandle=trace;throw e;}return trace;},
    ...(legacy?{trialAITrace:{status:()=>({pendingHooks:2})}}:{}),
  });
  vm.runInContext(read('../src/native/ai_trace_mod.js'),c);
  vm.runInContext(read('../sdk/mod_runtime.js'),c);
  c.BlueMilkMods.registerPackage(manifest,entry,'a'.repeat(64));
  return {c,mods:c.BlueMilkMods,counts:()=>({retained,released,stops,installed,options})};
}
const f=fixture();
for(let i=0;i<2;i++){
 await f.mods.command('enable',{id:manifest.id});
 assert.equal(f.counts().options.experimentalPrediction,false);
 const result=await f.mods.invoke(manifest.id,'read',{});
 assert.equal(result.battleInstanceKey,'test-battle');result.trace.rows.length=0;
 assert.equal((await f.mods.invoke(manifest.id,'read',{})).trace.rows.length,1);
 await assert.rejects(f.mods.invoke(manifest.id,'predict',{}),/Expected read/);
 await assert.rejects(f.mods.invoke(manifest.id,'read',{unknown:true}),/Expected read/);
 await f.mods.command('disable',{id:manifest.id});
 await assert.rejects(f.mods.invoke(manifest.id,'read',{}),/enabled/);
}
assert.equal(f.counts().retained,2);assert.equal(f.counts().released,2);

for(const settings of [{home:true},{legacy:true}]){
 const g=fixture(settings);
 await assert.rejects(g.mods.command('enable',{id:manifest.id}),/original battle|already owns/);
 assert.equal(g.counts().retained,0);
 await g.mods.command('disable',{id:manifest.id});
}
const g=fixture({failStop:true});
await g.mods.command('enable',{id:manifest.id});
await assert.rejects(g.mods.command('disable',{id:manifest.id}),/detach failed/);
assert.equal(g.counts().released,0);
await g.mods.command('disable',{id:manifest.id});
assert.equal(g.counts().released,1);

const p=fixture({partial:true,failStop:true});
await assert.rejects(p.mods.command('enable',{id:manifest.id}),/partial attach/);
assert.equal(p.counts().released,0,'failed installation retains the context until explicit cleanup');
await assert.rejects(p.mods.command('disable',{id:manifest.id}),/detach failed/);
assert.equal(p.counts().released,0);
await p.mods.command('disable',{id:manifest.id});
assert.equal(p.counts().released,1);

const early=fixture();const h=early.c.installAITraceMod();await h.stop();
assert.equal(early.counts().installed,0);assert.equal(early.counts().retained,0);
const denied=fixture();
denied.mods.registerPackage({...manifest,id:'example.denied',capabilities:[]},entry,'b'.repeat(64));
await assert.rejects(denied.mods.command('enable',{id:'example.denied'}),/Missing capability/);
const exclusive=fixture();
exclusive.mods.registerPackage({...manifest,id:'example.other'},entry,'c'.repeat(64));
await exclusive.mods.command('enable',{id:manifest.id});
await assert.rejects(exclusive.mods.command('enable',{id:'example.other'}),/exclusive/);
await exclusive.mods.command('disable',{id:manifest.id});
for(const failFlushAt of [1,2]){
 const f=fixture({failFlushAt});
 if(failFlushAt===1)await assert.rejects(f.mods.command('enable',{id:manifest.id}),/flush failed/);
 else{
  await f.mods.command('enable',{id:manifest.id});
  await assert.rejects(f.mods.command('disable',{id:manifest.id}),/flush failed/);
 }
 assert.equal(f.counts().released,0,'flush failure retains the context');
 await f.mods.command('disable',{id:manifest.id});
 assert.equal(f.counts().released,1);
}
console.log('AI trace Mod: original provider, copied reads, current-battle scope, lifecycle failures, early stop and capability checks passed');
