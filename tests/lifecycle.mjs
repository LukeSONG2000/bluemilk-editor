import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const context = vm.createContext({rpc:{exports:{}}});
vm.runInContext(fs.readFileSync(new URL('../sdk/mod_runtime.js', import.meta.url), 'utf8'), context);
const manifest = JSON.parse(fs.readFileSync(new URL('../examples/lifecycle/mod.json', import.meta.url), 'utf8'));
const source = fs.readFileSync(new URL('../examples/lifecycle/main.js', import.meta.url), 'utf8');
const mods = context.BlueMilkMods;
assert.equal(mods.registerPackage(manifest, source, 'a'.repeat(64)).state, 'disabled');
for (let i = 0; i < 2; i++) {
  assert.equal((await mods.command('enable', {id:manifest.id})).state, 'enabled');
  assert.equal((await mods.command('disable', {id:manifest.id})).state, 'disabled');
}
assert.equal((await mods.shutdown()).stopped, true);
console.log('PASS example registration and two lifecycle cycles (isolated, no game)');
// Ending a battle may race an already accepted main-thread status read.
let finishRead, stopCalls=0, failCleanup=true;
const events=[];
mods.register({...manifest,id:'org.example.drain'},()=>({
 ready:Promise.resolve(),status:()=>({lifecycle:'enabled'}),
 command:()=>new Promise(resolve=>{finishRead=()=>{events.push('read-finished');resolve({read:true});};}),
 stop(){stopCalls++;events.push('stop');if(failCleanup)throw Error('test cleanup failure');return {lifecycle:'stopped'};}
}));
await mods.command('enable',{id:'org.example.drain'});
const reading=mods.invoke('org.example.drain','status',{});
const ending=mods.shutdown();
assert.equal(stopCalls,0,'Shutdown must wait for the accepted command');
await assert.rejects(mods.invoke('org.example.drain','status',{}),/in progress/);
await assert.rejects(mods.command('enable',{id:manifest.id}),/in progress/);
assert.throws(()=>mods.register({...manifest,id:'org.example.late'},()=>{}),/in progress/);
await assert.rejects(mods.shutdown(),/already in progress/);
finishRead();await reading;
await assert.rejects(ending,/test cleanup failure/);
assert.deepEqual(events,['read-finished','stop']);
assert.equal((await mods.command('list')).mods.find(x=>x.manifest.id==='org.example.drain').state,'cleanup-failed');
failCleanup=false;assert.equal((await mods.shutdown()).stopped,true);assert.equal(stopCalls,2);
console.log('PASS shutdown drains accepted commands, rejects new work, retains failed cleanup and permits explicit retry');
