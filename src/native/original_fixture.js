'use strict';
// Concatenate after runtime_api.js. Call createOriginalFixture only inside
// RuntimeApi.runOnMainThreadOnce. Does not initialize/tick a battle, install
// hooks, invoke network services, or serialize inventory/account objects.
(() => {
  const R=globalThis.RuntimeApi,A=R.arg;
  if(!R)throw Error('original_fixture.js requires runtime_api.js');
  function call(object,name,args=[]) {
    return R.invoke(R.findMethod(R.classOf(object),name,args.length),object,args);
  }
  function inject(name) {
    const type=R.api('type_get_object','pointer',['pointer'])(
      R.api('class_get_type','pointer',['pointer'])(R.findClass(name)));
    const injector=R.readRef(R.nil,'_instance',R.findClass('Injector'));
    return R.invoke(R.findMethod(R.findClass('Injector'),'Get',4),injector,
      [A.ref(type),A.ref(R.nil),A.ref(R.nil),A.value('bool',false)]);
  }
  function requireObject(object,label) {
    if(!object || object.isNull())throw Error('Original fixture requires '+label);
    return object;
  }
  function ids(value,label) {
    if(!Array.isArray(value)||value.length===0||value.some(id=>typeof id!=='string'||id.length===0))
      throw Error(label+' must contain original unit base IDs');
    return value.slice();
  }
  function diagnostics(fixture) {
    return {kind:'original-fixture-assembled',battleStarted:false,
      state:R.fullName(R.classOf(requireObject(R.readRef(fixture.state,'<CurrentState>k__BackingField'),'current state'))),
      flags:fixture.options.flags,seed:fixture.options.seed,
      playerIds:fixture.options.playerIds.slice(),opponentIds:fixture.options.opponentIds.slice(),
      mission:Object.assign({},fixture.options.mission),
      context:R.fullName(R.classOf(fixture.context)),domain:R.fullName(R.classOf(fixture.domain)),
      unitSource:fixture.options.definitionDemo?'private original definition factory; level85/gear13/relic7, original skill tier lists, no mods':'original loaded inventory UnitDO, original copy constructor; original stats and abilities unchanged'};
  }
  function createOriginalFixture(options={}) {
    const settings={definitionDemo:options.definitionDemo||null,flags:options.flags===undefined?7:options.flags,
      seed:options.seed===undefined?8:options.seed,
      playerIds:ids(options.playerIds===undefined?['VADER']:options.playerIds,'playerIds'),
      opponentIds:ids(options.opponentIds===undefined?['STORMTROOPER']:options.opponentIds,'opponentIds'),
      mission:Object.assign({campaignId:'C01D',mapId:'M01',nodeId:'N01',missionId:'Mi05',
        difficulty:1,encounterId:'1'},options.mission||{})};
    // Only the body-proven simulation+skip-result-view branches are admitted.
    if(settings.flags!==6 && settings.flags!==7)throw Error('Fixture flags must be SIMULATION|SKIP_END_BATTLE_VIEW, optionally HEADLESS (6 or 7)');
    if(!Number.isInteger(settings.seed)||settings.seed<-2147483648||settings.seed>2147483647)
      throw Error('Battle seed must fit the original Int32 field');
    if(!Number.isInteger(settings.mission.difficulty)||settings.mission.difficulty<0||settings.mission.difficulty>255)
      throw Error('Mission difficulty must be an explicit runtime CampaignNodeDifficultyEnum byte');
    for(const name of ['campaignId','mapId','nodeId','missionId','encounterId'])
      if(typeof settings.mission[name]!=='string'||!settings.mission[name])throw Error('Missing original mission '+name);
    const state=R.findBound('StateController');
    const current=requireObject(R.readRef(state,'<CurrentState>k__BackingField'),'current game state');
    const stateName=R.fullName(R.classOf(current));
    if(stateName!=='HomeBaseGameState')throw Error('Fixture requires idle HomeBaseGameState: '+stateName);
    const live=R.findBound('BattleDomainController');
    if(!R.readRef(live,'<CurrentBattleState>k__BackingField').isNull())throw Error('Live battle exists');

    const inventory=requireObject(call(R.findBound('InventoryDomainController'),'get_Inventory'),'loaded inventory');
    const originals=new Map();
    for(const id of [...settings.playerIds,...settings.opponentIds])
      if(!originals.has(id))originals.set(id,requireObject(options.definitionDemo
        ? globalThis.createDefinitionDemoUnit(id,options.definitionDemo)
        : call(inventory,'GetUnitWithBaseId',[A.ref(R.string(id))]),'fixture unit '+id));
    const missionId=R.newObject(R.findClass('CampaignElementIdentifierDO'));
    for(const [property,key] of [['CampaignID','campaignId'],['MapID','mapId'],['NodeID','nodeId'],['MissionID','missionId']])
      call(missionId,'set_'+property,[A.ref(R.string(settings.mission[key]))]);
    call(missionId,'set_Difficulty',[A.value('u8',settings.mission.difficulty)]);
    const campaign=R.findBound('CampaignDomainController');
    const mission=requireObject(call(campaign,'GetMission',[A.ref(missionId)]),'original campaign mission');
    requireObject(call(campaign,'GetEncounter',[A.ref(missionId),A.ref(R.string(settings.mission.encounterId))]),'original encounter');

    const unitClass=R.findClass('UnitDO'),cellClass=R.findClass('SquadCellDO');
    let privateSlot=0;
    function squad(unitIds) {
      const squad=R.newObject(R.findClass('SquadDO')),cells=call(squad,'get_SquadCells');
      unitIds.forEach((id,index)=>{
        const unit=R.newObject(unitClass,R.findMethod(unitClass,'.ctor',1,['UnitDO']),[A.ref(originals.get(id))]);
        // A duplicate base definition is legal in a private demo, but every
        // combat instance must have a distinct ID (including across teams).
        privateSlot++;
        if(settings.definitionDemo||[...settings.playerIds,...settings.opponentIds].filter(v=>v===id).length>1)
          R.writeRef(unit,'Id',R.string('private-demo-'+privateSlot+'-'+id));
        const cell=R.newObject(cellClass,R.findMethod(cellClass,'.ctor',1,['UnitDO']),[A.ref(unit)]);
        // Native cell ctor: +30 unit; word+10=0x0102 (DEFAULT, selectable),
        // +13=1 (death required). Only squad placement is assigned here.
        R.writeValue(cell,'CellIndex','i32',index);
        R.writeValue(cell,'SquadUnitType','u8',index===0?0:2); // LEADER / DEFAULT
        call(cells,'Add',[A.ref(cell)]);
      });
      return squad;
    }
    const player=squad(settings.playerIds),opponent=squad(settings.opponentIds);
    const data=R.newObject(R.findClass('BattleGameState+TransitionData'));
    call(data,'set_CampaignMissionIdentifier',[A.ref(missionId)]);
    call(data,'set_BattleTypeEnum',[A.value('u8',1)]); // runtime PVE_BATTLE
    call(data,'set_CombatTypeEnum',[A.value('u8',0)]); // runtime CHARACTER, not wire 1
    call(data,'set_PlayerBattleSquad',[A.ref(player)]);
    call(data,'set_OpponentBattleSquad',[A.ref(opponent)]);
    const factory=inject('BattleContext+Factory');
    const context=requireObject(call(factory,'Get',[A.ref(data),A.value('i32',settings.flags)]),'simulation context');
    call(data,'set_BattleContext',[A.ref(context)]);
    const domain=requireObject(call(context,'get_BattleDomainController'),'simulation domain');
    if(R.fullName(R.classOf(domain))!=='BattleDomainSimulationController')
      throw Error('Factory did not select the original simulation domain');
    const simulation=R.newObject(R.findClass('BattleSimulationController'));
    call(simulation,'set_HeadlessMode',[A.value('bool',(settings.flags&1)!==0)]);
    call(context,'set_BattleController',[A.ref(simulation)]);
    // Use the original zero-argument ctor: the short five-argument ctor only
    // assigns five fields and does not initialize _battleUnitDefinitions (+68).
    const battleData=R.newObject(R.findClass('BattleDataDO'));
    const squads=R.newObject(R.classOf(requireObject(call(battleData,'get_Squads'),'default squad dictionary')));
    call(squads,'Add',[A.ref(R.string(settings.mission.encounterId)),A.ref(opponent)]);
    call(battleData,'set_Squads',[A.ref(squads)]); // never mutate shared EMPTY_SQUADS
    call(battleData,'set_EncounterId',[A.ref(R.string(settings.mission.encounterId))]);
    call(battleData,'set_BattleSeed',[A.value('i32',settings.seed)]);
    call(battleData,'set_PlayerSquad',[A.ref(player)]);
    call(domain,'set_BattleData',[A.ref(battleData)]);
    const restoreDefinitions=options.definitionBytes?.length?globalThis.installDemoDefinitions(options.definitionBytes):null;
    return {data,context,domain,battleData,player,opponent,state,simulation,missionId,mission,options:settings,restoreDefinitions};
  }
  globalThis.createOriginalFixture=createOriginalFixture;
  globalThis.originalFixtureDiagnostics=diagnostics;
  globalThis.OriginalFixtureTools={call,inject,diagnostics};
})();
