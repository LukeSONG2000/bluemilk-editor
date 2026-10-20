import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const manifest=JSON.parse(read('../../mods/trial/mod.json'));
const entry=read('../../mods/trial/main.js');
const good=()=>({cleanup:{home:true,guardRestored:true,gcReleased:true,errors:[]}});
function environment(prepared=true){
 let resolve,starts=0;
 const ctx=vm.createContext({rpc:{exports:{}},deferOriginalVisualTrial:prepared,
  runOriginalVisualTrial:()=>{starts++;return new Promise(r=>resolve=r);}});
 vm.runInContext(read('mod_runtime.js'),ctx);vm.runInContext(read('trial_mod.js'),ctx);
 ctx.BlueMilkMods.registerPackage(manifest,entry,'a'.repeat(64));
 return {ctx,mods:ctx.BlueMilkMods,finish:r=>resolve(r),starts:()=>starts};
}
const id=manifest.id;
{
 const e=environment(),m=e.mods;
 await m.command('enable',{id});assert.equal(e.starts(),0,'Enabling must not enter a battle');
 m.registerPackage({...manifest,id:'example.second'},entry,'b'.repeat(64));
 await assert.rejects(m.command('enable',{id:'example.second'}),/exclusive/);
 await m.command('disable',{id});await m.command('enable',{id});assert.equal(e.starts(),0);
 await m.invoke(id,'start',{});assert.equal(e.starts(),1);
 await assert.rejects(m.invoke(id,'start',{}),/already attempted/);
 let stopped=false;const shutdown=m.shutdown().then(()=>{stopped=true;});
 await Promise.resolve();assert.equal(e.ctx.originalTrialStopRequested,true);
 assert.equal(stopped,false,'Stop request is not cleanup confirmation');
 assert.equal((await m.command('list')).mods[0].state,'disabling');
 e.finish(good());await shutdown;
 assert.equal((await m.command('list')).mods[0].state,'disabled');
 await m.command('enable',{id});await assert.rejects(m.invoke(id,'start',{}),/already attempted/);
 await m.command('disable',{id});
}
{
 const e=environment();await e.mods.command('enable',{id});await e.mods.invoke(id,'start',{});
 const bad=good();bad.cleanup.errors.push('hook cleanup failed');e.finish(bad);
 await assert.rejects(e.mods.shutdown(),/cleanup unconfirmed/);
 assert.equal((await e.mods.command('list')).mods[0].state,'cleanup-failed');
 await assert.rejects(e.mods.command('disable',{id}),/cleanup unconfirmed/);
}
{
 const e=environment(false);await e.mods.command('enable',{id});
 await assert.rejects(e.mods.invoke(id,'start',{}),/prepared capture/);assert.equal(e.starts(),0);
 await e.mods.shutdown();
}
console.log('PASS trial Mod: enable is inert, exclusive owner, original engine only, stop waits, failure retained, no replay, prepared worker required');

{
 const e=environment();
 assert.equal(e.ctx.requestOriginalTrialStop().stopRequested,true);
 await e.mods.command('enable',{id});await e.mods.invoke(id,'start',{});
 assert.equal(e.ctx.originalTrialStopRequested,true,'Starting cannot erase an early host stop');
 e.finish(good());await e.mods.shutdown();
}
