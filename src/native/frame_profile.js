'use strict';
// Explicit diagnostic only; samples the owned battle state, never changes time.
globalThis.FrameProfile=(()=>{
 let hook=null,data=null;
 const stop=(reason='requested')=>{
  if(!hook)return;
  hook.detach();hook=null;
  data.stopReason=reason;data.finishedAt=new Date().toISOString();
  // Preserve the last partial window even when the trial host exits before
  // another status RPC. A stopped window is emitted exactly once.
  send({kind:'frame-profile-complete',...summary()});
 };
 function summary(){
  if(!data)return {readConfirmed:true,active:false,sampleCount:0};
  const sorted=[...data.samplesMs].sort((a,b)=>a-b),n=sorted.length;
  const percentile=q=>n?sorted[Math.ceil(n*q)-1]:null;
  return {readConfirmed:true,active:!!hook,...data,sampleCount:n,
   meanMs:n?sorted.reduce((a,b)=>a+b,0)/n:null,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),
   maxMs:n?sorted[n-1]:null,over33ms:sorted.filter(v=>v>33.333).length,over50ms:sorted.filter(v=>v>50).length,
   scope:'Unity unscaledDeltaTime sampled once per frame at MainThreadDispatcher.ProcessActions while owned battle state is current; not GPU/presentation time. Diagnostic hook overhead is included.'};
 }
 function execute(isOwned,operation,seconds=10){
  if(operation==='status')return summary();
  if(operation==='stop'){stop();return summary();}
  if(operation!=='start'||!Number.isInteger(seconds)||seconds<2||seconds>30)throw Error('Frame profile requires start/status/stop; seconds 2..30');
  if(hook)throw Error('Frame profile already active');
  if(typeof isOwned!=='function'||!isOwned())throw Error('Owned battle required');
  const R=RuntimeApi,S=SceneApi;
  const getter=(type,name,result,kind)=>{
   const method=R.findMethod(R.findClass(type),name,0);
   const fn=new NativeFunction(method.readPointer(),result,['pointer']);
   const reference=R.unbox(S.invoke(type,name,R.nil),kind),value=fn(method);
   if(Math.abs(Number(reference)-Number(value))>1e-6)throw Error('Native frame getter verification failed: '+name);
   return ()=>fn(method);
  };
  const frame=getter('UnityEngine.Time','get_frameCount','int','i32');
  const delta=getter('UnityEngine.Time','get_unscaledDeltaTime','float','f32');
  const focused=getter('UnityEngine.Application','get_isFocused','bool','bool');
  const deadline=Date.now()+seconds*1000;let previous=frame();
  data={seconds,startedAt:new Date().toISOString(),samplesMs:[],unfocusedFrames:0,skippedFrames:0,errors:[]};
  hook=Interceptor.attach(R.findMethod(R.findClass('MainThreadDispatcher'),'ProcessActions',0).readPointer(),{onLeave(){
   try{
    if(!isOwned()){stop('ownership-ended');return;}
    if(Date.now()>=deadline){stop('duration');return;}
    if(data.samplesMs.length>=12000){stop('sample-limit');return;}
    const next=frame();if(next===previous)return;
    data.skippedFrames+=Math.max(0,next-previous-1);previous=next;
    const ms=delta()*1000;if(!Number.isFinite(ms)||ms<=0)throw Error('Invalid original frame delta');
    data.samplesMs.push(ms);if(!focused())data.unfocusedFrames++;
   }catch(error){data.errors.push(String(error));stop('error');}
  }});
  return summary();
 }
 return {execute,finish:()=>{stop('trial-cleanup');return summary();}};
})();
