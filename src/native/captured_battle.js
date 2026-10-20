'use strict';
// PENDING-ORIGINAL: experimental standalone probe dependency, NOT a working trial API.
// Direct v2 capture + schema defaults passed original conversion and enemy-copy checks.
// Player isolation and playable mission replay remain unverified. No normal-host loading.
// Main-thread only. Convert the WHOLE original payload so encounter-local definitions,
// overrides and state use the original factory ordering. Does not start a battle.
globalThis.convertCapturedBattle=(bytes,metadata)=>{
 const R=RuntimeApi,S=SceneApi,A=R.arg,handles=[];
 const mission=metadata?.mission;
 if(!mission||!['_campaignID','_mapId','_nodeId','_missionId'].every(k=>typeof mission[k]==='string'&&mission[k]))throw Error('Captured mission identity required');
 for(const value of [mission.difficulty,metadata.overrideRelicTier])if(!Number.isInteger(value)||value<0||value>255)throw Error('Captured enum must be a byte');
 globalThis.captureConversionPhase='deserialize';
 const source=deserializeOriginalBattleProto(bytes);
 const own=p=>{handles.push(R.retain(p));return p;};
 let released=false;
 const release=()=>{if(released)return;released=true;for(const h of handles.splice(0))R.release(h);source.release();};
 let gameData=null,oldMap=null,mapHandle=null,restored=false;
 try{
  globalThis.captureConversionPhase='resolve-factory';
  const factory=OriginalFixtureTools.inject('BattleDataDO+Factory');
  for(const name of ['_gameDataDC','_unitDOFactory','_unitDefinitionFactory','_battleStatDOFactory','_bucketItemDOFactory','_statTranslator','_grantedAbilityFactory','_statFactory','_battleUnitStateFactory','_datacronFactory'])
   if(R.readRef(factory,name).isNull())throw Error('Factory dependency is null: '+name);
  gameData=R.readRef(factory,'_gameDataDC');oldMap=R.readRef(gameData,'_pveUnitDefinitionMap');
  if(!oldMap.isNull())mapHandle=R.retain(oldMap);
  globalThis.captureConversionPhase='mission-identity';
  const identity=own(R.api('object_new','pointer',['pointer'])(R.findClass('CampaignElementIdentifierDO')));
  S.invoke('CampaignElementIdentifierDO','.ctor',identity);
  for(const [property,key] of [['CampaignID','_campaignID'],['MapID','_mapId'],['NodeID','_nodeId'],['MissionID','_missionId']])
   S.invoke('CampaignElementIdentifierDO','set_'+property,identity,[A.ref(R.string(mission[key]))]);
  S.invoke('CampaignElementIdentifierDO','set_Difficulty',identity,[A.value('u8',mission.difficulty)]);
  const method=R.findMethod(R.classOf(factory),'Get',3,['Protos.BattleData','CampaignElementIdentifierDO','RelicTierEnum']);
  if(!method.readPointer().equals(R.module.base.add(0x1D0BFF0)))throw Error('Unexpected BattleData factory revision');
  globalThis.captureConversionPhase='original-factory-get';
  // Let IL2CPP runtime_invoke catch its own managed C++ exception. Frida's
  // default first-chance interception masks it as a generic "system error".
  // Never use propagate on a direct business-method call without this boundary.
  const invokeManaged=new NativeFunction(R.module.getExportByName('il2cpp_runtime_invoke'),
   'pointer',['pointer','pointer','pointer','pointer'],{exceptions:'propagate'});
  const args=Memory.alloc(24),tier=Memory.alloc(1),exception=Memory.alloc(8);
  tier.writeU8(metadata.overrideRelicTier);exception.writePointer(ptr(0));
  args.writePointer(source.object);args.add(8).writePointer(identity);args.add(16).writePointer(tier);
  const returned=invokeManaged(method,factory,args,exception);
  const ex=exception.readPointer();
  if(!ex.isNull()){
   const error=Error('Original BattleData conversion raised a managed exception');
   const buffer=Memory.alloc(16384);
   R.api('format_exception','void',['pointer','pointer','int'])(ex,buffer,16384);
   error.originalException=buffer.readUtf8String();
   // Preserve original exception evidence before releasing temporary objects.
   // native_trace_ips in this client stores module-relative PCs, not absolute pointers.
   error.originalTrace=[];
   try{const trace=R.readRef(ex,'native_trace_ips');if(!trace.isNull()){
    const length=Math.min(Number(trace.add(24).readU64()),128);
    for(let i=0;i<length;i++)error.originalTrace.push(String(trace.add(32+i*8).readPointer()));
   }}catch(diagnostic){error.traceError=String(diagnostic);}
   try{error.originalParameter=S.string(R.readRef(ex,'_paramName'));}catch(_){}

   throw error;
  }
  globalThis.captureConversionPhase='native-function-returned';
  const data=own(returned);
  globalThis.captureConversionPhase='converted';
  const definitionMap=own(R.readRef(gameData,'_pveUnitDefinitionMap'));
  return {battleData:data,missionId:identity,proto:source.object,release,gameData,definitionMap};
 }catch(e){release();throw e;}
 finally{
  try{if(gameData&&oldMap){R.writeRef(gameData,'_pveUnitDefinitionMap',oldMap);restored=R.readRef(gameData,'_pveUnitDefinitionMap').equals(oldMap);}}
  finally{if(mapHandle!==null)R.release(mapHandle);}
  if(gameData&&!restored)throw Error('Original PVE definition map restoration failed');
 }
};
