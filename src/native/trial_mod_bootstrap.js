'use strict';
// Prepared worker bootstrap. Completion is published only after the engine and
// registry have both finished cleanup, so the host cannot detach in between.
rpc.exports.trialstop=()=>requestOriginalTrialStop();
(async()=>{
 const p=globalThis.preparedTrialPackage;
 BlueMilkMods.registerPackage(p.manifest,p.source,p.sha256,p.configuration||{});
 await BlueMilkMods.command('enable',{id:p.manifest.id});
 send({kind:'trial-mod-enabled',packageSha256:p.sha256,mods:await BlueMilkMods.command('list')});
 await BlueMilkMods.invoke(p.manifest.id,'start',{});
 const result=await globalThis.originalTrialCompletion;
 try{await BlueMilkMods.shutdown();}
 catch(error){result.cleanup.errors.push('Registry cleanup: '+String(error));result.verifiedVisualBattle=false;}
 result.trialMod={packageSha256:p.sha256,registry:await BlueMilkMods.command('list')};
 send(result);
})().catch(error=>send({kind:'original-trial-mod-error',error:String(error),stack:error.stack||null}));
