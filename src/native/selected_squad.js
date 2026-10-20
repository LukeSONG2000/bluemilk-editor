'use strict';
// Main-thread only. Native SquadDO copy preserves placement/flags; native UnitDO
// copies replace the shared units left by SquadCellDO's copy constructor.
// Objects are owned by RuntimeApi until the trial's normal releaseAll cleanup.
globalThis.SelectedSquadTools=(()=>{
 const R=RuntimeApi,S=SceneApi;
 function list(value){
  if(value.isNull())return [];
  const n=R.readValue(value,'_size','i32'),items=R.readRef(value,'_items');
  if(n<0||n>64||(items.isNull()?n!==0:n>items.add(24).readU64().toNumber()))throw Error('Selected squad list bounds');
  return Array.from({length:n},(_,i)=>items.add(32+i*8).readPointer());
 }
 const identity=unit=>unit.isNull()?null:{unitId:S.string(R.readRef(unit,'Id')),baseId:S.string(R.readRef(R.readRef(unit,'<Definition>k__BackingField'),'BaseId'))};
 function describe(squad){
  return list(R.readRef(squad,'_squadCells')).map(cell=>{
   const row={unit:identity(R.readRef(cell,'Unit'))};
   for(const [name,type] of [['CellIndex','i32'],['SquadUnitType','u8'],['Selectable','bool'],['IsMandatory','bool'],['IsOverkillable','bool'],['DeathRequiredForEncounter','bool'],['IsNonActivatedSquadUnit','bool'],['OverrideAllStatsMultiplier','f32']])row[name]=R.readValue(cell,name,type);
   for(const name of ['MessageReticle','InheritFromDefinitionID','OverrideAllStatsTable'])row[name]=S.string(R.readRef(cell,name));
   return row;
  });
 }
 function copy(source){
  if(source.isNull()||R.fullName(R.classOf(source))!=='SquadDO')throw Error('Original SquadDO required');
  if(!R.readRef(source,'Datacron').isNull())throw Error('Datacron isolation still requires validation; selection was not changed');
  if(list(R.readRef(source,'_squadAbilities')).length)throw Error('Squad ability isolation still requires validation');
  const original=list(R.readRef(source,'_squadCells')),before=describe(source);
  if(!original.length||!original.some(c=>!R.readRef(c,'Unit').isNull()))throw Error('Empty selected squad');
  if(original.some(c=>!R.readRef(c,'BattleUnitState').isNull()))throw Error('Persisted battle unit state isolation still requires validation');
  const cls=R.findClass('SquadDO'),unitClass=R.findClass('UnitDO');
  const player=R.newObject(cls,R.findMethod(cls,'.ctor',1,['SquadDO']),[R.arg.ref(source)]);
  if(player.equals(source))throw Error('Original squad was not copied');
  const cells=list(R.readRef(player,'_squadCells'));
  if(cells.length!==original.length||R.readRef(player,'_squadCells').equals(R.readRef(source,'_squadCells')))throw Error('Squad cell list was not copied');
  const copies=new Map();
  cells.forEach((cell,i)=>{
   if(cell.equals(original[i]))throw Error('Squad cell was not copied');
   const unit=R.readRef(original[i],'Unit');
   if(unit.isNull())return;
   const key=unit.toString();
   if(!copies.has(key))copies.set(key,R.newObject(unitClass,R.findMethod(unitClass,'.ctor',1,['UnitDO']),[R.arg.ref(unit)]));
   const privateUnit=copies.get(key);
   if(privateUnit.equals(unit))throw Error('Unit was not copied');
   R.writeRef(cell,'Unit',privateUnit);
  });
  if(JSON.stringify(before)!==JSON.stringify(describe(player))||JSON.stringify(before)!==JSON.stringify(describe(source)))throw Error('Selection changed during native copy');
  return {player,source,selection:before,copiedUnits:copies.size};
 }
 function fromPrebattle(){
  const status=PreBattleBridge.status();
  if(!status.ready)throw Error('Ready original PVE squad selection required');
  const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
  if(R.fullName(R.classOf(state))!=='PvePreBattleState')throw Error('PVE prebattle changed');
  const controller=R.readRef(state,'_featureController'),source=R.readRef(controller,'_currentSquad');
  const mission=R.readRef(controller,'_campaignMissionIdentifier');
  if(mission.isNull())throw Error('Original mission identity missing');
  const missionIdentity={};
  for(const name of ['CampaignID','MapID','NodeID','MissionID'])missionIdentity[name]=S.string(S.invoke('CampaignElementIdentifierDO','get_'+name,mission));
  missionIdentity.Difficulty=R.unbox(S.invoke('CampaignElementIdentifierDO','get_Difficulty',mission),'u8');
  const selection=describe(source),support=status.selectedSupport;
  if(support?.unit&&!selection.some(c=>c.SquadUnitType===1&&c.unit?.unitId===support.unit.unitId))throw Error('Selected support is not present in original squad');
  const result=copy(source);
  const supportSource=R.readRef(controller,'_battleSupportDO');
  const battleSupport=copySupport(supportSource,result.player);
  return {...result,mission,missionIdentity,eventId:status.eventId,instanceId:status.instanceId,support,battleSupport,
   eventScreenMode:R.readValue(controller,'_eventScreenMode','i32')};
 }
 function copySupport(source,player){
  if(source.isNull())return R.nil;
  if(R.fullName(R.classOf(source))!=='BattleSupportDO')throw Error('Original BattleSupportDO required');
  const unit=R.readRef(source,'<SupportUnit>k__BackingField');
  if(unit.isNull())throw Error('Selected support unit unavailable');
  const expected=identity(unit);
  const matches=list(R.readRef(player,'_squadCells')).filter(c=>R.readValue(c,'SquadUnitType','u8')===1&&JSON.stringify(identity(R.readRef(c,'Unit')))===JSON.stringify(expected));
  if(matches.length!==1)throw Error('Support must match exactly one copied support slot');
  const privateUnit=R.readRef(matches[0],'Unit');
  if(privateUnit.equals(unit))throw Error('Support still uses the live unit');
  // Original managed shallow clone preserves nullable level/ally/reward fields
  // exactly, including null versus zero. The only mutable unit reference is
  // rebound to the already copied slot; immutable definitions remain shared.
  const clone=S.invoke('System.Object','MemberwiseClone',source);
  if(clone.isNull()||clone.equals(source)||R.fullName(R.classOf(clone))!=='BattleSupportDO')throw Error('Support clone failed');
  R.retain(clone);
  S.invoke('BattleSupportDO','set_SupportUnit',clone,[R.arg.ref(privateUnit)],['UnitDO']);
  if(!R.readRef(clone,'<SupportUnit>k__BackingField').equals(privateUnit)||!R.readRef(source,'<SupportUnit>k__BackingField').equals(unit))throw Error('Support copy binding failed');
  return clone;
 }
 function requireMission(selection,capturedMission){
  // Capture files frequently share MissionID (Mi01) across different maps.
  // Match all five original keys before touching even the private transition.
  for(const [name,key] of [['CampaignID','_campaignID'],['MapID','_mapId'],['NodeID','_nodeId'],['MissionID','_missionId'],['Difficulty','difficulty']]){
   if(selection.missionIdentity[name]===undefined||selection.missionIdentity[name]!==capturedMission?.[key])throw Error('Captured mission does not match current selection: '+name);
  }
 }
 function applyToTransition(data,selection,capturedMission){
  requireMission(selection,capturedMission);
  if(R.fullName(R.classOf(data))!=='BattleGameState+TransitionData'||!R.readRef(data,'<BattleContext>k__BackingField').isNull())throw Error('Unbound private battle transition required');
  const set=(name,arg)=>S.invoke('BattleGameState+TransitionData','set_'+name,data,[arg]);
  set('PlayerBattleSquad',R.arg.ref(selection.player));
  set('BattleSupport',R.arg.ref(selection.battleSupport));
  set('EventId',R.arg.ref(selection.eventId===null?R.nil:R.string(selection.eventId)));
  set('EventInstanceId',R.arg.ref(selection.instanceId===null?R.nil:R.string(selection.instanceId)));
  set('EventScreenMode',R.arg.value('i32',selection.eventScreenMode));
  return {missionMatched:true,supportPresent:!selection.battleSupport.isNull()};
 }
 return {copy,describe,fromPrebattle,copySupport,applyToTransition,requireMission};
})();
