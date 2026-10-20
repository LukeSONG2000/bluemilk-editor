import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
// One Node/Frida owner per client. A live owner is never stolen.
export function acquireRuntimeSession(pid){
 const shared=path.join(process.env.LOCALAPPDATA||os.homedir(),'SWGoH-Tool','sessions');
 const releaseShared=acquireFileSession(pid,shared);
 const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../logs/high_reuse');
 try{
  const releaseLocal=acquireFileSession(pid,dir);
  return ()=>{releaseLocal();releaseShared();};
 }catch(error){releaseShared();throw error;}
}
export function acquireFileSession(pid,dir){
 if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Invalid game PID');
 fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`runtime-session-${pid}.lock`);
 for(let attempt=0;attempt<2;attempt++){
  try{
   const fd=fs.openSync(file,'wx');fs.writeFileSync(fd,JSON.stringify({hostPid:process.pid,gamePid:pid}));
   return ()=>{fs.closeSync(fd);try{const owner=JSON.parse(fs.readFileSync(file,'utf8'));if(owner.hostPid===process.pid)fs.unlinkSync(file);}catch{}};
  }catch(e){
   if(e.code!=='EEXIST')throw e;
   const owner=JSON.parse(fs.readFileSync(file,'utf8'));let alive=true;
   try{process.kill(owner.hostPid,0);}catch(err){if(err.code==='ESRCH')alive=false;}
   if(alive)throw Error(`Runtime already owned by host ${owner.hostPid}; use its cached snapshot, do not attach another host.`);
   fs.unlinkSync(file);
  }
 }
 throw Error('Cannot acquire runtime ownership');
}
