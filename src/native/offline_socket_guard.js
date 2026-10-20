'use strict';
// Temporary process-local Winsock egress guard; no OS firewall or install changes.
globalThis.installOfflineSocketGuard=()=>{
 const ws=Process.getModuleByName('ws2_32.dll'),entries=[],counts={};
 const installedThread=Process.getCurrentThreadId(),startedAt=Date.now(),callers=new Map();
 let installedThreadCalls=0,untrackedCalls=0,diagnosticErrors=0,backoffCalls=0;
 function record(name,context){
  const thread=Process.getCurrentThreadId();if(thread===installedThread)installedThreadCalls++;
  const address=context?.returnAddress;
  const key=name+':'+thread+':'+(address?address.toString():'unavailable');
  let row=callers.get(key);
  if(!row){
   if(callers.size>=32){untrackedCalls++;return;}
   const module=address?Process.findModuleByAddress(address):null;
   row={api:name,thread,count:0,module:module?.name||null,offset:module?address.sub(module.base).toString():null};
   callers.set(key,row);
  }
  row.count++;
  // Only repeated failures from a background caller back off. Keep the Unity
  // thread and initial failures unchanged; never fake a successful send.
  return thread!==installedThread&&row.count>8?50:5;
 }
 const setError=new NativeFunction(ws.getExportByName('WSASetLastError'),'void',['int']);
 const pause=new NativeFunction(Process.getModuleByName('kernel32.dll').getExportByName('Sleep'),'void',['uint']);
 const signatures={send:['pointer','pointer','int','int'],sendto:['pointer','pointer','int','int','pointer','int'],
  WSASend:['pointer','pointer','uint','pointer','uint','pointer','pointer'],
  WSASendTo:['pointer','pointer','uint','pointer','uint','pointer','int','pointer','pointer'],
  connect:['pointer','pointer','int'],WSAConnect:['pointer','pointer','int','pointer','pointer','pointer','pointer']};
 try{
  for(const [name,args] of Object.entries(signatures)){
   const address=ws.getExportByName(name);counts[name]=0;
   const replacement=new NativeCallback(function(){counts[name]++;let delay=5;try{delay=record(name,this)||5;}catch{diagnosticErrors++;}if(delay>5)backoffCalls++;pause(delay);setError(10050);return -1;},'int',args);
   Interceptor.replace(address,replacement);entries.push({address,replacement});
  }
  Interceptor.flush();
 }catch(e){for(const e of entries)Interceptor.revert(e.address);throw e;}
 return {counts,diagnostics(){return {elapsedMs:Date.now()-startedAt,installedThread,installedThreadCalls,untrackedCalls,diagnosticErrors,initialDelayMs:5,backgroundRepeatDelayMs:50,backoffCalls,callers:[...callers.values()].map(r=>({...r}))};},restore(){
  const errors=[];
  for(const entry of entries){
   if(entry.restored)continue;
   try{Interceptor.revert(entry.address);entry.restored=true;}catch(error){errors.push(String(error));}
  }
  Interceptor.flush();
  if(errors.length)throw Error('Socket restoration failed: '+errors.join('; '));
 }};
};
