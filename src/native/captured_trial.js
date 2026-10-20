'use strict';
// Experimental standalone builder. Fresh inventory per trial, original saved squad,
// original captured mission and simulation context. No fabricated opponent/skill rules.
// Selected squad with Datacron, external Era units or battle state is not yet audited.
globalThis.createCapturedTrial=options=>{
 const R=RuntimeApi,A=R.arg,call=OriginalFixtureTools.call;
 const list=p=>p.isNull()?[]:Array.from({length:R.readValue(p,'_size','i32')},(_,i)=>R.readRef(p,'_items').add(32+i*8).readPointer());
 const state=R.findBound('StateController'),current=R.readRef(state,'<CurrentState>k__BackingField');
 const selected=options.currentSelection===true;
 if(R.fullName(R.classOf(current))!==(selected?'PvePreBattleState':'HomeBaseGameState'))throw Error(selected?'Current PVE selection required':'Idle Home required');
 if(!R.readRef(R.findBound('BattleDomainController'),'<CurrentBattleState>k__BackingField').isNull())throw Error('Live battle exists');
 if(![6,7].includes(options.flags)||!Number.isInteger(options.squadType))throw Error('Explicit simulation flags 6/7 and saved squad type required');
 if(selected&&options.flags!==6)throw Error('Current selection requires visual trial');
 let source=null,built=null,selection=null,player;
 if(selected){selection=SelectedSquadTools.fromPrebattle();SelectedSquadTools.requireMission(selection,options.capturedMetadata?.mission);}
 // Derive squad storage and native combat module from the original mission.
 const converted=convertCapturedBattle(options.capturedBytes,options.capturedMetadata),battleData=converted.battleData,missionId=converted.missionId;
 const mission=call(R.findBound('CampaignDomainController'),'GetMission',[A.ref(missionId)]);
 if(mission.isNull())throw Error('Original mission unavailable');
 const combatType=R.readValue(mission,'CombatType','u8');
 if(![0,1].includes(combatType))throw Error('Unsupported original mission combat type');
 if(options.modeProvenance&&(options.modeProvenance.battleType!==1||options.modeProvenance.combatType!==combatType))throw Error('Original captured mode differs from PVE mission; refusing mode substitution');
 if(selected){player=selection.player;}
 else{
 source=deserializeOriginalInventoryProto(options.inventoryBytes);built=buildPrivateInventory(source.object);
 const roster=R.readRef(built.inventory,'_unitRoster'),units=new Set(list(R.readRef(roster,'_units')).map(String));
 const squads=list(R.readRef(roster,combatType===1?'_shipSquads':'_characterSquads'));
 const matches=squads.filter(s=>R.readValue(s,'SquadType','u8')===options.squadType);
 if(matches.length!==1)throw Error('Saved squad selection is missing or ambiguous; original combatType='+combatType+' available squad types='+JSON.stringify(squads.map(s=>R.readValue(s,'SquadType','u8'))));
 player=matches[0];const cells=list(R.readRef(player,'_squadCells'));
 if(!cells.length)throw Error('Empty saved squad');
 if(list(R.readRef(player,'_squadAbilities')).length)throw Error('Selected squad abilities require isolation audit');
 for(const c of cells){const u=R.readRef(c,'Unit');
  if(!u.isNull()&&!units.has(String(u)))throw Error('Selected unit outside private roster');
  if(!R.readRef(c,'BattleUnitState').isNull())throw Error('Selected persisted battle state requires audit');
 }
 }
 const encounter=call(battleData,'get_EncounterId'),opponent=call(battleData,'GetSquad',[A.ref(encounter)]);
 if(opponent.isNull())throw Error('Captured initial encounter squad missing');
 if(!R.readRef(player,'Datacron').isNull()){
  if(!R.readValue(mission,'IsDatacronAllowed','bool'))throw Error('Original mission does not allow Datacrons; selected squad is preserved and trial rejected');
  throw Error('Datacron objects audited; this allowed mission mode still requires end-to-end validation');
 }
 const data=R.newObject(R.findClass('BattleGameState+TransitionData'));
 call(data,'set_CampaignMissionIdentifier',[A.ref(missionId)]);
 call(data,'set_BattleTypeEnum',[A.value('u8',1)]);
 call(data,'set_CombatTypeEnum',[A.value('u8',combatType)]);
 call(data,'set_PlayerBattleSquad',[A.ref(player)]);
 call(data,'set_OpponentBattleSquad',[A.ref(opponent)]);
 if(selection)SelectedSquadTools.applyToTransition(data,selection,options.capturedMetadata.mission);
 const context=call(OriginalFixtureTools.inject('BattleContext+Factory'),'Get',[A.ref(data),A.value('i32',options.flags)]);
 call(data,'set_BattleContext',[A.ref(context)]);
 const domain=call(context,'get_BattleDomainController');
 if(R.fullName(R.classOf(domain))!=='BattleDomainSimulationController')throw Error('Expected original simulation domain');
 const simulation=R.newObject(R.findClass('BattleSimulationController'));
 call(simulation,'set_HeadlessMode',[A.value('bool',(options.flags&1)!==0)]);
 call(context,'set_BattleController',[A.ref(simulation)]);
 call(battleData,'set_PlayerSquad',[A.ref(player)]);
 call(domain,'set_BattleData',[A.ref(battleData)]);
 // Activate last, after all builder rejection paths. Keep the original table
 // through asynchronous VFX preload, summons and state teardown.
 const restoreDefinitions=activateCapturedDefinitions(converted.gameData,converted.definitionMap);
 return {data,context,domain,battleData,player,opponent,state,simulation,missionId,mission,combatType,options,source,built,converted,restoreDefinitions,selection};
};
