import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const c=vm.createContext({rpc:{exports:{}},saved:[]});
vm.runInContext(fs.readFileSync(new URL('../sdk/mod_runtime.js',import.meta.url),'utf8'),c);
const m=JSON.parse(fs.readFileSync(new URL('../examples/battle-reader/mod.json',import.meta.url),'utf8'));
const source=fs.readFileSync(new URL('../examples/battle-reader/main.js',import.meta.url),'utf8');
const mods=c.BlueMilkMods;
let reads=0,options;
const native={schemaVersion:1,state:'BattleGameState',units:[{unitId:'original',health:42}]};
c.readRuntimeSnapshot=async o=>{reads++;options=o;return native;};
mods.registerPackage(m,source,'a'.repeat(64));
await assert.rejects(mods.invoke(m.id,'snapshot',{}),/enabled/);
await mods.command('enable',{id:m.id});
const result=await mods.invoke(m.id,'snapshot',{});
assert.equal(options.detailScope,'selected');
result.units[0].health=0;assert.equal(native.units[0].health,42);
await assert.rejects(mods.invoke(m.id,'snapshot',{unexpected:1}),/options/);
await mods.invoke(m.id,'snapshot',{detailScope:'all'});assert.equal(options.detailScope,'all');
c.readRuntimeSnapshot=async()=>({schemaVersion:1,state:'HomeBaseGameState',units:[],inventory:'private'});
assert.equal((await mods.invoke(m.id,'snapshot',{})).inventory,undefined);
await mods.command('disable',{id:m.id});
await assert.rejects(mods.invoke(m.id,'snapshot',{}),/enabled/);
const retained=`module.exports=sdk=>{saved.push(sdk.battle.snapshot);let lifecycle='enabled';return {
ready:Promise.resolve(),status:()=>({lifecycle}),stop(){lifecycle='stopped';return {lifecycle};},
command(name){if(name==='old')return saved[0]();if(name==='forgot'){sdk.battle.snapshot();return 'queued';}
if(name==='fail'){sdk.battle.snapshot();throw Error('command failed');}return sdk.battle.snapshot();}};}`;
const r={...m,id:'org.example.retained'};
mods.registerPackage(r,retained,'b'.repeat(64));
await mods.command('enable',{id:r.id});
assert.throws(()=>c.saved[0](),/invocation/);
await mods.command('disable',{id:r.id});await mods.command('enable',{id:r.id});
await assert.rejects(mods.invoke(r.id,'old',{}),/invocation/);
for(const command of ['forgot','fail']){
 let finish; c.readRuntimeSnapshot=()=>new Promise(resolve=>{finish=()=>resolve(native);});
 const pending=mods.invoke(r.id,command,{});
 const observed=pending.then(x=>({x}),e=>({error:e.message}));
 await new Promise(resolve=>setImmediate(resolve));
 assert.throws(()=>c.saved.at(-1)(),/invocation/,'Command already returned; no more queries');
 const ending=mods.shutdown();let ended=false;ending.then(()=>ended=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(ended,false);
 finish();const response=await observed;await ending;
 if(command==='fail')assert.equal(response.error,'command failed');else assert.equal(response.x,'queued');
 await mods.command('enable',{id:r.id});
}
await mods.command('disable',{id:r.id});
const denied={...m,id:'org.example.denied',capabilities:[]};
mods.registerPackage(denied,source,'c'.repeat(64));await mods.command('enable',{id:denied.id});
await assert.rejects(mods.invoke(denied.id,'snapshot',{}),/Missing capability/);
await mods.shutdown();
const bounded={...m,id:'org.example.bounded'};
mods.registerPackage(bounded,`module.exports=sdk=>({ready:Promise.resolve(),status:()=>({lifecycle:'enabled'}),
stop:()=>({lifecycle:'stopped'}),command(){for(let n=0;n<17;n++)sdk.battle.snapshot();}});`,'d'.repeat(64));
await mods.command('enable',{id:bounded.id});
let count=0;c.readRuntimeSnapshot=async()=>{count++;return native;};
await assert.rejects(mods.invoke(bounded.id,'snapshot',{}),/16 reads/);
assert.equal(count,16);await mods.shutdown();
await mods.command('enable',{id:m.id});
c.readRuntimeSnapshot=async()=>{throw Error('native read failed');};
await assert.rejects(mods.invoke(m.id,'snapshot',{}),/native read failed/);
await mods.shutdown();
console.log('PASS SDK snapshots: native copy, options/capability, generation revocation, ignored/error reads drained before shutdown');
