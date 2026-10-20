import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const c=vm.createContext({rpc:{exports:{}}});
vm.runInContext(fs.readFileSync(new URL('../sdk/mod_runtime.js',import.meta.url),'utf8'),c);
const manifest=JSON.parse(fs.readFileSync(new URL('../mods/game-operations/mod.json',import.meta.url),'utf8'));
const source=fs.readFileSync(new URL('../mods/game-operations/main.js',import.meta.url),'utf8');
const mods=c.BlueMilkMods;
mods.registerPackage(manifest,source,'a'.repeat(64));
for(let i=0;i<2;i++){
 await mods.command('enable',{id:manifest.id});
 const input={calendarId:'observed',rewardIndex:3,lastClaimed:'123'};
 const handoff=await mods.invoke(manifest.id,'calendar-claim',input);
 assert.equal(handoff.blueMilkHostOperation,1);assert.equal(handoff.operation,'calendar-claim');
 assert.deepEqual(JSON.parse(JSON.stringify(handoff.payload)),input);
 handoff.payload.rewardIndex=99;assert.equal(input.rewardIndex,3);
 await mods.command('disable',{id:manifest.id});
 await assert.rejects(mods.invoke(manifest.id,'calendar-open',{}),/enabled/);
}
mods.registerPackage({...manifest,id:'org.example.denied',capabilities:[]},source,'b'.repeat(64));
await assert.rejects(mods.command('enable',{id:'org.example.denied'}),/Missing capability/);
console.log('PASS game operations SDK: exact handoff copy, no native execution, repeated enable/disable, capability required');
