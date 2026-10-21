'use strict';
// Observe the current original battle. Prediction and priority edits are not
// enabled by this read-only resource. Its retained context is never a query API.
(()=>{
 let owner=null;
 globalThis.installAITraceMod=()=>{
  if(owner)throw Error('Another Mod owns AI tracing');
  let lifecycle='enabling',trace=null,contextHandle=null,battleInstanceKey=null,stopTask=null;
  const handle={
   status:()=>({lifecycle,battleInstanceKey,scope:'current battle; observed original AI decisions'}),
   async stop(){
    if(lifecycle==='stopped')return {lifecycle};
    if(stopTask)return stopTask;
    lifecycle='stopping';
    stopTask=(async()=>{
     try{
      await handle.ready.catch(()=>{});
      await RuntimeApi.runOnMainThreadOnce(()=>{
       if(trace)trace.stop();
       Interceptor.flush();
       if(contextHandle!==null){RuntimeApi.release(contextHandle);contextHandle=null;}
       trace=null;
      });
      lifecycle='stopped';owner=null;return {lifecycle};
     }catch(error){lifecycle='cleanup-failed';throw error;}
     finally{stopTask=null;}
    })();
    return stopTask;
   },
   command(name,payload={}){
    if(lifecycle!=='enabled')throw Error('AI trace is not enabled');
    if(name!=='read'||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length)
     throw Error('Expected read with an empty payload');
    return JSON.parse(JSON.stringify({schemaVersion:1,battleInstanceKey,trace:trace.snapshot()}));
   }
  };
  owner=handle;
  // Defer native work until the registry owns the lifecycle handle.
  handle.ready=Promise.resolve().then(()=>RuntimeApi.runOnMainThreadOnce(()=>{
   if(lifecycle!=='enabling')return;
   const R=RuntimeApi;
   if(typeof installOriginalAITrace!=='function')throw Error('Original AI trace provider unavailable');
   if(globalThis.trialAITrace?.status().pendingHooks)throw Error('Legacy trial already owns AI tracing');
   const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
   if(state.isNull()||R.fullName(R.classOf(state))!=='BattleGameState')throw Error('Enable AI tracing inside a ready original battle');
   const controller=R.readRef(state,'_battleController');
   const context=controller.isNull()?R.nil:R.readRef(controller,'_battleContext');
   if(context.isNull())throw Error('Original battle context is not ready');
   contextHandle=R.retain(context);
   battleInstanceKey=globalThis.BattleInstanceIdentity?.read(state,context)||null;
   try{trace=installOriginalAITrace(context,{experimentalPrediction:false});}
   catch(error){if(error.cleanupHandle)trace=error.cleanupHandle;throw error;}
   Interceptor.flush();lifecycle='enabled';
  }));
  handle.ready.catch(()=>{if(lifecycle==='enabling')lifecycle='failed';});
  return handle;
 };
})();
