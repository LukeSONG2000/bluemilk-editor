'use strict';
// Observe one NATURAL server-response conversion, never invoke the response handler.
// Snapshot only Protos.BattleData; Player/InventoryDelta/auth response data are excluded.
globalThis.BattleCapture=(()=>{
 const R=RuntimeApi,S=SceneApi,depth=new Map(),hooks=[];
 let captured=false,errors=[],factoryResult=null,resultHandle=null,provenance=null;
 const captureId=Process.id+':'+Date.now()+':'+Math.random().toString(36).slice(2);
 function releaseResult(){if(resultHandle!==null)R.release(resultHandle);resultHandle=null;factoryResult=null;}
 hooks.push(Interceptor.attach(R.module.base.add(0xF8F750),{
  onEnter(){this.t=Process.getCurrentThreadId();depth.set(this.t,(depth.get(this.t)||0)+1);},
  onLeave(){const n=(depth.get(this.t)||1)-1;if(n)depth.set(this.t,n);else depth.delete(this.t);}
 }));
 hooks.push(Interceptor.attach(R.module.base.add(0x1D0BFF0),{
  onEnter(args){
   if(captured||errors.length>=5||!depth.get(Process.getCurrentThreadId()))return;
   try{
    if(R.fullName(R.classOf(args[1]))!=='Protos.BattleData')throw Error('Unexpected factory input');
    const mission={};
    if(!args[2].isNull())for(const field of ['_campaignID','_mapId','_nodeId','_missionId'])mission[field]=S.string(R.readRef(args[2],field));
    if(!args[2].isNull())mission.difficulty=R.readValue(args[2],'_difficulty','u8');
    // DeepClone loses non-zero/default struct fields in both original serializers.
    // Serialize the original callback input directly; never persist an intermediate clone.
    // Decoding still needs a schema-default fidelity check before this can be replayed.
    const bytes=serializeOriginalBattleProto(args[1]);
    captured=true;this.captureOwner=true;
    send({kind:'original-battle-proto-captured',captureId,scope:'natural response factory input; BattleData only',encoding:'direct-protobuf-v2',semanticRoundtripVerified:false,mission,overrideRelicTier:args[3].toInt32()&255,bytes:bytes.byteLength},bytes);
   }catch(e){errors.push(String(e));send({kind:'original-battle-proto-capture-error',error:String(e)});}
  },
  onLeave(result){
   if(!this.captureOwner)return;
   try{if(result.isNull()||R.fullName(R.classOf(result))!=='BattleDataDO')throw Error('Unexpected battle factory result');
    resultHandle=R.retain(result);factoryResult=result;
   }catch(e){errors.push(String(e));send({kind:'original-battle-proto-capture-error',error:String(e)});}
  }
 }));
 hooks.push(Interceptor.attach(R.findMethod(R.findClass('BattleGameState'),'SC_Enter',2).readPointer(),{
  onEnter(args){this.transition=args[1];},
  onLeave(){
   if(!factoryResult||provenance)return;
   try{
    const data=this.transition;
    if(R.fullName(R.classOf(data))!=='BattleGameState+TransitionData')return;
    const context=R.readRef(data,'<BattleContext>k__BackingField');if(context.isNull())return;
    const domain=R.readRef(context,'<BattleDomainController>k__BackingField');if(domain.isNull())return;
    if(!R.readRef(domain,'<BattleData>k__BackingField').equals(factoryResult))return;
    provenance={kind:'original-battle-mode-provenance',captureId,
     association:'exact factory BattleDataDO equals transition context domain BattleData',
     battleType:R.readValue(data,'<BattleTypeEnum>k__BackingField','u8'),
     combatType:R.readValue(data,'<CombatTypeEnum>k__BackingField','u8'),
     replayCompatibilityVerified:false};
    send(provenance);releaseResult();
   }catch(e){if(errors.length<5){errors.push(String(e));send({kind:'original-battle-proto-capture-error',error:String(e)});}}
  }
 }));
 return {status:()=>({captured,provenance,errors}),stop:()=>{for(const hook of hooks)hook.detach();releaseResult();}};
})();
