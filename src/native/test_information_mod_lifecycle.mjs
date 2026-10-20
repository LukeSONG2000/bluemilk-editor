import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./battle_info_ui.js',import.meta.url),'utf8');
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
const f=fixture();
assert.equal(f.queue.length,0,'Deferred module must not schedule or install anything');
const first=f.ctx.installBattleInfo();
assert.throws(()=>f.ctx.installBattleInfo(),/already active/);
const stopped=first.stop();await f.tick();await f.tick();
assert.equal((await stopped).lifecycle,'stopped');assert.equal(f.live.size,0);assert.equal(f.timers,0);
const second=f.ctx.installBattleInfo();await f.tick();await second.ready;
assert.equal(f.live.size,9);assert.equal(second.status().lifecycle,'enabled');
const stop=second.stop();await Promise.resolve();await Promise.resolve();await f.tick();await stop;
assert.equal(f.live.size,0);assert.equal(f.timers,0);
assert.strictEqual(second.stop(),stop,'Stop is idempotent and returns same completion');
const broken=fixture(4),instance=broken.ctx.installBattleInfo();
await broken.tick();await assert.rejects(instance.ready,/attach failed/);
assert.equal(broken.live.size,0,'Partial install rolls back hooks');
assert.equal(instance.status().lifecycle,'failed');
assert.throws(()=>broken.ctx.installBattleInfo(),/awaiting cleanup/);
const clean=instance.stop();await Promise.resolve();await Promise.resolve();await broken.tick();await clean;
assert.equal(instance.status().lifecycle,'stopped');
console.log('PASS information Mod: deferred load, singleton, stop during install, reenable, idempotent stop, partial rollback.');
