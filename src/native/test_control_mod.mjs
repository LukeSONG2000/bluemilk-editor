import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=name=>fs.readFileSync(new URL(name,import.meta.url),'utf8');
const state={isNull:()=>false};let installs=0,failStop=false,owned;
const ctx=vm.createContext({rpc:{exports:{}},
 RuntimeApi:{runOnMainThreadOnce:fn=>Promise.resolve().then(fn),findBound:()=>state,readRef:()=>state,classOf:()=> 'HomeBaseGameState',fullName:x=>x},
 installLiveBattleControl(scope,policy){
  installs++;let armed=true;
  const handle={status:()=>({armed}),snapshot:()=>({status:{armed},policy}),
   stop(){if(failStop)throw Error('detach failed');armed=false;},
   configure(next){policy=next;return this.snapshot();},input:(operation,request)=>({operation,request})};
  scope.own(handle);owned=handle;return handle;
 }});
vm.runInContext(source('mod_runtime.js'),ctx);vm.runInContext(source('bridge.js'),ctx);
const manifest=JSON.parse(fs.readFileSync(new URL('../../mods/battle-control/mod.json',import.meta.url)));
const entry=fs.readFileSync(new URL('../../mods/battle-control/main.js',import.meta.url),'utf8');
const mods=ctx.BlueMilkMods,id=manifest.id;
mods.registerPackage(manifest,entry,'a'.repeat(64));
mods.registerPackage({...manifest,id:'org.example.other'},entry,'b'.repeat(64));
await mods.command('enable',{id});assert.equal(installs,0,'Enabling must not arm or add native hooks');
await assert.rejects(mods.command('enable',{id:'org.example.other'}),/exclusive/);
assert.equal((await mods.command('list')).mods[1].state,'disabled');
const policy={scope:'all',combatType:0,enabled:true,oneClickTaunt:true,allowedTargets:[]};
assert.equal((await mods.invoke(id,'arm',policy)).status.armed,true);
assert.equal(installs,1);
const request={token:'original-turn',targetId:'original-candidate'};
assert.deepEqual(await mods.invoke(id,'enemy-input',{operation:'target',request}),{operation:'target',request});
failStop=true;
await assert.rejects(mods.command('disable',{id}),/detach failed/);
assert.equal((await mods.command('list')).mods[0].state,'cleanup-failed');
assert.equal(owned.status().armed,true);
await assert.rejects(mods.invoke(id,'arm',policy),/enabled/);
await assert.rejects(mods.command('enable',{id:'org.example.other'}),/exclusive/);
failStop=false;await mods.command('disable',{id});
assert.equal(owned.status().armed,false);
await ctx.rpc.exports.arm(policy);assert.equal(installs,2,'Legacy arm must enable and invoke the packaged Mod');
await ctx.rpc.exports.shutdown();assert.equal(owned.status().armed,false);
assert.equal((await mods.command('list')).mods[0].state,'disabled');
console.log('PASS control SDK: no implicit arm, exclusive owner, unchanged input, failed cleanup retained, retry and legacy routing');

// Exercise the real native installer with failing hook detach/partial install.
for(const partialInstall of [false,true]){
 let retained,failDetach=true,replaceFailure=partialInstall;const hooks=new Set();let replaced=false;
 const ptr={isNull:()=>false,equals:()=>true};
 const native=vm.createContext({send:()=>{},setInterval:()=>1,clearInterval:()=>{},
  NativeFunction:function(){return ()=>{};},NativeCallback:function(fn){return fn;},
  RuntimeApi:{arg:{},findBound:()=>ptr,readRef:()=>ptr,classOf:()=> 'HomeBaseGameState',fullName:x=>x,
   findClass:()=>ptr,findMethod:()=>({readPointer:()=>ptr})},
  Interceptor:{attach(){const hook={detach(){if(failDetach)throw Error('detach failed');hooks.delete(hook);}};hooks.add(hook);return hook;},
   replace(){replaced=true;if(replaceFailure)throw Error('replace failed');},revert(){replaced=false;},flush(){}}
 });
 vm.runInContext(source('live_arena_taunt.js'),native);
 const install=()=>native.installLiveBattleControl({battleType:'all',combatType:0,own:h=>{retained=h;}},{enabled:false,oneClickTaunt:false,allowedTargets:[]});
 if(partialInstall)assert.throws(install,/detach failed/);else{install();assert.throws(()=>retained.stop(),/detach failed/);}
 assert.ok(retained,'Cleanup handle retained before hook installation');
 assert.equal(retained.status().armed,true,'No premature stopped claim');assert.ok(hooks.size);
 failDetach=false;retained.stop();assert.equal(hooks.size,0);assert.equal(replaced,false);assert.equal(retained.status().armed,false);
 retained.stop();assert.equal(hooks.size,0);
}
console.log('PASS actual installer: partial installation retained, failed detach retry removes every owned hook');
