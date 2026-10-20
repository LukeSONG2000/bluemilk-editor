import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/native/battle_info_ui.js',import.meta.url),'utf8');
function fixture(failAt=0){
 const queue=[],live=new Set();let attaches=0,timers=0;
 const nil={isNull:()=>true};
 const R={arg:{},runOnMainThreadOnce:fn=>new Promise((resolve,reject)=>queue.push(()=>{try{resolve(fn());}catch(e){reject(e);}})),
  findClass:x=>x,findMethod:(t,m)=>({readPointer:()=>t+'.'+m}),findBound:()=>({}),readRef:()=>nil};
 const ctx=vm.createContext({deferBattleInfoInstallation:true,RuntimeApi:R,SceneApi:{all:()=>[]},rpc:{exports:{}},
  Process:{id:1},send(){},setInterval(){timers++;return 1;},clearInterval(){timers--;},
  Interceptor:{flush(){},attach(a){attaches++;if(attaches===failAt)throw Error('attach failed');live.add(a);return {detach(){live.delete(a);}};}}});
 vm.runInContext(source,ctx);
 return {ctx,live,queue,get timers(){return timers;},async tick(){for(let i=0;i<12&&!queue.length;i++)await Promise.resolve();assert.ok(queue.length);queue.shift()();await Promise.resolve();await Promise.resolve();await Promise.resolve();}};
}

const payload=JSON.parse(fs.readFileSync(0,'utf8'));
const registry=fs.readFileSync(new URL('../sdk/mod_runtime.js',import.meta.url),'utf8');
const f=fixture();vm.runInContext(registry,f.ctx);
const mods=f.ctx.BlueMilkMods;
mods.registerPackage(payload.manifest,payload.source,payload.sha256);
assert.equal(f.live.size,0);assert.equal(f.queue.length,0);
for(let n=0;n<2;n++){
 const enabling=mods.command('enable',{id:payload.manifest.id});
 await f.tick();assert.equal((await enabling).state,'enabled');assert.equal(f.live.size,9);
 const disabling=mods.command('disable',{id:payload.manifest.id});
 await f.tick();assert.equal((await disabling).state,'disabled');assert.equal(f.live.size,0);
 assert.equal(f.timers,0);
}
// A package throwing after SDK acquisition must retain a cleanup handle.
const b=fixture();vm.runInContext(registry,b.ctx);
b.ctx.BlueMilkMods.registerPackage(payload.manifest,
 'module.exports=sdk=>{sdk.battle.information.install();throw Error("after acquire")}', 'b'.repeat(64));
await assert.rejects(b.ctx.BlueMilkMods.command('enable',{id:payload.manifest.id}),/after acquire/);
const stopping=b.ctx.BlueMilkMods.command('disable',{id:payload.manifest.id});
await b.tick();await b.tick();assert.equal((await stopping).state,'disabled');assert.equal(b.live.size,0);
// Capability checks happen before allocating UI hooks.
const c=fixture();vm.runInContext(registry,c.ctx);
c.ctx.BlueMilkMods.registerPackage({...payload.manifest,capabilities:[]},payload.source,'c'.repeat(64));
await assert.rejects(c.ctx.BlueMilkMods.command('enable',{id:payload.manifest.id}),/Missing capability/);
assert.equal(c.queue.length,0);assert.equal(c.live.size,0);
console.log('PASS installed information package: two enable/disable cycles, declared capabilities, cleanup after factory failure');
