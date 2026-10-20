import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Execute the real cleanup loop, with an asynchronous native state transition.
const source=fs.readFileSync(new URL('./probe_visual.js',import.meta.url),'utf8');
const start=source.indexOf('const deadline=Date.now()+10000;');
const end=source.indexOf("if(!cleanup.home){cleanup.errors.push",start);
assert.ok(start>=0&&end>start);
const loop=source.slice(start,end);
async function run({foreign=false,complete=true,loading=false,stuck=false}={}){
 let tick=0,dispatches=0;const trace=[];
 const state={isNull:()=>false,equals:o=>o===state,name:'BattleGameState'};
 const nil={isNull:()=>true,equals:()=>false,name:null};
 let active=state;
 const cleanup={home:false,exitedOwnedStates:0,errors:[]};
 const ctx={cleanup,f:{},entered:state,ownedCampaign:null,campaignExpected:false,
  readyAt:loading?0:1,traceCleanup:(phase,details)=>trace.push({phase,...details}),
  call:()=>({}),
  foreignTransition:foreign,returningHome:false,R:{nil,runOnMainThreadOnce:async f=>f(),
   readValue:(_,field)=>field==='_nextState'?1:stuck||tick<3?19:34},
  current:()=>active,typename:o=>o.name,
  enterType:name=>{assert.equal(name,'HomeBaseGameState');if(loading)assert.ok(tick>=3&&!stuck);dispatches++;},
  wait:async()=>{tick++;active=loading&&!dispatches?state:tick<3?state:tick<6||!complete?nil:{name:'HomeBaseGameState'};},
  Date:{now:()=>tick*1000}};
 await vm.runInNewContext(`(async()=>{${loop}})()`,ctx);
 return {cleanup,dispatches,tick,trace};
}
const ok=await run();
assert.equal(ok.dispatches,1);
assert.equal(ok.cleanup.home,true);
assert.equal(ok.tick,6,'must wait through old and null intermediate states');
assert.equal(ok.trace.filter(x=>x.phase==='home-enter-requested').length,1);
assert.equal(ok.trace.find(x=>x.phase==='home-enter-requested').inputReadyObserved,true);
assert.ok(ok.trace.some(x=>x.phase==='home-enter-returned'));
const timeout=await run({complete:false});
assert.equal(timeout.dispatches,1);
assert.equal(timeout.cleanup.home,false,'missing callback must not be labelled restored');
const foreign=await run({foreign:true});
assert.equal(foreign.dispatches,0);
assert.equal(foreign.cleanup.home,false);
assert.match(foreign.cleanup.errors[0],/Unowned/);
assert.ok(foreign.trace.some(x=>x.phase==='foreign-state-retained'));
assert.ok(!foreign.trace.some(x=>x.phase==='home-enter-requested'));
const loading=await run({loading:true});
assert.equal(loading.dispatches,1);
assert.equal(loading.cleanup.home,true);
assert.equal(loading.trace.filter(x=>x.phase==='waiting-for-battle-ready').length,1);
assert.ok(loading.trace.findIndex(x=>x.phase==='battle-ready-for-exit')<loading.trace.findIndex(x=>x.phase==='home-enter-requested'));
const stuck=await run({loading:true,stuck:true});
assert.equal(stuck.dispatches,0,'loading timeout must never force original Shutdown');
assert.equal(stuck.cleanup.home,false);
assert.equal(stuck.cleanup.waitingForBattleReady,true);
// This test models the original completion callback only. It does not prove
// that the original client tolerates an exit during early battle loading.
assert.ok(!source.includes("call(f.state,'ExitState'"));
console.log('PASS native Home transition once, asynchronous wait, timeout and foreign ownership');
