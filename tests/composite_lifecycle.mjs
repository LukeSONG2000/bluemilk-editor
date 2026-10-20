import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const manifest=JSON.parse(fs.readFileSync(new URL('../examples/battle-events/mod.json',import.meta.url),'utf8'));
manifest.capabilities.push('battle.information.ui','battle.information.read');
const registry=fs.readFileSync(new URL('../sdk/mod_runtime.js',import.meta.url),'utf8');
function fixture(entry){
 const log=[],handles={},c=vm.createContext({rpc:{exports:{}}});
 let fail=null,unconfirmed=null,readyFail=null;
 for(const [provider,kind] of [['installBattleInfo','information'],['installBattleEventsMod','events']])c[provider]=()=>{
  log.push('install '+kind);let lifecycle='enabled';
  const h={ready:readyFail===kind?Promise.reject(Error('ready failed')):Promise.resolve(),status:()=>({lifecycle}),
   command:()=>({source:kind}),async stop(){log.push('stop '+kind);if(fail===kind)throw Error('stop failed');
    if(unconfirmed===kind)return {};lifecycle='stopped';return {lifecycle};}};
  h.ready.catch(()=>{});handles[kind]=h;return h;
 };
 vm.runInContext(registry,c);c.BlueMilkMods.registerPackage(manifest,entry,'a'.repeat(64));
 return {mods:c.BlueMilkMods,log,handles,set fail(x){fail=x;},set unconfirmed(x){unconfirmed=x;},set readyFail(x){readyFail=x;}};
}
const entry=`module.exports=sdk=>{sdk.battle.information.install();const events=sdk.battle.events.install();
 return sdk.lifecycle.compose({command:(name,payload)=>events.command(name,payload)});};`;
const f=fixture(entry);
await f.mods.command('enable',{id:manifest.id});
assert.equal((await f.mods.invoke(manifest.id,'read',{})).source,'events');
f.fail='events';await assert.rejects(f.mods.command('disable',{id:manifest.id}),/stop failed/);
assert.ok(!f.log.includes('stop information'),'older dependency retained on newer failure');
f.fail='information';await assert.rejects(f.mods.command('disable',{id:manifest.id}),/stop failed/);
assert.equal(f.log.filter(x=>x==='stop events').length,2);
f.fail=null;await f.mods.command('disable',{id:manifest.id});
assert.equal(f.log.filter(x=>x==='stop events').length,2,'successful child is not stopped again on retry');
await f.mods.command('enable',{id:manifest.id});await f.mods.shutdown();
for(const suffix of ["throw Error('factory failed');",'return {};']){
 const partial=fixture(`module.exports=sdk=>{sdk.battle.information.install();sdk.battle.events.install();${suffix}};`);
 await assert.rejects(partial.mods.command('enable',{id:manifest.id}));
 await partial.mods.command('disable',{id:manifest.id});
 assert.deepEqual(partial.log.slice(-2),['stop events','stop information']);
}
const readiness=fixture(entry);readiness.readyFail='events';
await assert.rejects(readiness.mods.command('enable',{id:manifest.id}),/ready failed/);
await readiness.mods.command('disable',{id:manifest.id});
assert.deepEqual(readiness.log.slice(-2),['stop events','stop information']);
const unconfirmed=fixture(entry);await unconfirmed.mods.command('enable',{id:manifest.id});
unconfirmed.unconfirmed='events';await assert.rejects(unconfirmed.mods.command('disable',{id:manifest.id}),/unconfirmed/);
assert.ok(!unconfirmed.log.includes('stop information'));
unconfirmed.unconfirmed=null;await unconfirmed.mods.shutdown();
const duplicate=fixture(`module.exports=sdk=>{sdk.battle.events.install();sdk.battle.events.install();};`);
await assert.rejects(duplicate.mods.command('enable',{id:manifest.id}),/already acquired/);
await duplicate.mods.command('disable',{id:manifest.id});assert.equal(duplicate.log.filter(x=>x==='install events').length,1);
const sealed=fixture(`module.exports=sdk=>{sdk.lifecycle.compose();sdk.battle.events.install();};`);
await assert.rejects(sealed.mods.command('enable',{id:manifest.id}),/before composing/);
await sealed.mods.command('disable',{id:manifest.id});assert.deepEqual(sealed.log,[]);
console.log('PASS composed SDK resources: reverse cleanup, retry without duplicate stop, partial factory/readiness failures, duplicate and sealed acquisition');
