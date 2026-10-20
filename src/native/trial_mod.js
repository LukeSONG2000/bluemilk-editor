'use strict';
// Resource owner for the existing original-runtime trial. This provider does not
// implement combat. Its engine and selected capture exist only in prepared workers.
(()=>{
 let owner=null,claimed=false,stopRequest=null;
 const clean=result=>result?.cleanup?.home===true&&result.cleanup.guardRestored===true&&
  result.cleanup.gcReleased===true&&Array.isArray(result.cleanup.errors)&&result.cleanup.errors.length===0;
 globalThis.installOriginalTrialMod=modId=>{
  if(owner)throw Error('Another Mod owns the trial engine');
  let lifecycle='enabled',phase='ready',completion=null,stopTask=null;
  const requestStop=()=>{
   if(!completion)return {stopRequested:false,started:false};
   globalThis.originalTrialStopRequested=true;
   if(globalThis.visualProbe)visualProbe.stopRequested=true;
   return {stopRequested:true,cleanupPending:phase!=='complete'};
  };
  const handle={ready:Promise.resolve(),
   status:()=>({lifecycle,phase,prepared:typeof runOriginalVisualTrial==='function'&&globalThis.deferOriginalVisualTrial===true,claimed}),
   async stop(){
    if(lifecycle==='stopped')return {lifecycle};
    if(stopTask)return stopTask;
    lifecycle='stopping';requestStop();
    stopTask=(async()=>{
     try{
      if(completion&&!clean(await completion))throw Error('Original trial cleanup unconfirmed; runtime ownership retained');
      lifecycle='stopped';owner=null;stopRequest=null;return {lifecycle};
     }catch(error){lifecycle='cleanup-failed';throw error;}
     finally{stopTask=null;}
    })();
    return stopTask;
   },
   command(name,payload){
    if(lifecycle!=='enabled'||owner!==handle)throw Error('Trial Mod is not enabled');
    if(!payload||Object.keys(payload).length)throw Error('Prepared trial commands take no payload');
    if(name==='status')return handle.status();
    if(name==='stop')return requestStop();
    if(name!=='start')throw Error('Unknown trial command');
    if(!handle.status().prepared)throw Error('Select a prepared capture in a private trial worker before starting');
    if(claimed)throw Error('Prepared trial start was already attempted; no replay');
    claimed=true;phase='running';
    completion=runOriginalVisualTrial({managedByTrialMod:true}).then(result=>{phase='complete';return result;},error=>{phase='failed';throw error;});
    globalThis.originalTrialCompletion=completion;
    // Observe failures even when the caller disappears; keep the same rejected
    // promise for stop/cleanup rather than silently accepting the failed run.
    completion.catch(()=>{});
    return {started:true,modId};
   }
  };
  owner=handle;stopRequest=requestStop;
  return handle;
 };
 globalThis.requestOriginalTrialStop=()=>{
  // A host stop may arrive before the asynchronous bootstrap enables the Mod.
  // Preserve it through start; never lose an accepted early cancellation.
  globalThis.originalTrialStopRequested=true;
  const state=stopRequest?stopRequest():{started:false};
  return {...state,stopRequested:true,cleanupPending:true};
 };
})();
