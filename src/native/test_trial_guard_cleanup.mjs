import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Execute the actual resource-release block, not a copy of its predicate.
const source=fs.readFileSync(new URL('./probe_visual.js',import.meta.url),'utf8');
const start=source.indexOf('   // Keep offline isolation');
const end=source.indexOf('   verifyCapture();',start);
assert.ok(start>=0&&end>start);
async function run({home=true,modsClean=true,errors=[],fail=null}={}){
 const events=[],trace=[];
 const step=name=>{events.push(name);if(fail===name)throw Error(name+' failed');};
 const cleanup={home,errors:[...errors],guardRestored:false,gcReleased:false};
 const ctx={cleanup,modsClean,
  f:{restoreDefinitions:()=>step('definitions')},
  guard:{restore:()=>step('guard')},
  R:{runOnMainThreadOnce:async fn=>fn(),releaseAll:()=>step('release')},
  traceCleanup:(phase,details)=>trace.push({phase,...details})};
 await vm.runInNewContext(`(async()=>{${source.slice(start,end)}})()`,ctx);
 return {cleanup,events,trace};
}
for(const input of [{home:false},{modsClean:false},{errors:['hook detach failed']}]){
 const result=await run(input);
 assert.deepEqual(result.events,[]);
 assert.equal(result.cleanup.guardRestored,false);
 assert.equal(result.cleanup.gcReleased,false);
 assert.equal(result.trace[0].phase,'offline-guard-retained');
}
const normal=await run();
assert.deepEqual(normal.events,['definitions','guard','release']);
assert.equal(normal.cleanup.gcReleased,true);
assert.equal(normal.cleanup.guardRestored,true);
for(const fail of ['definitions','guard']){
 const result=await run({fail});
 assert.equal(result.cleanup.guardRestored,false);
 assert.equal(result.cleanup.gcReleased,false);
 assert.ok(result.cleanup.errors.some(e=>e.includes(fail+' failed')));
 assert.ok(!result.events.includes('release'));
}
const gcFailure=await run({fail:'release'});
assert.equal(gcFailure.cleanup.gcReleased,false);
assert.ok(gcFailure.cleanup.errors.length>0);
console.log('PASS trial offline guard retained on failed Home/hooks/definitions; release ordered after restoration');
