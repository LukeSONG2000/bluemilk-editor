'use strict';
// Reuse the original UI bridge, but only for this probe's exact owned battle.
rpc.exports.trialcommand=(operation,request)=>RuntimeApi.runOnMainThreadOnce(()=>{
 const R=RuntimeApi,probe=globalThis.visualProbe;
 if(!probe?.entered||probe.entered.isNull())throw Error('Trial battle not entered');
 const state=R.readRef(probe.fixture.state,'<CurrentState>k__BackingField');
 if(!state.equals(probe.entered))throw Error('Current state is not the owned trial');
 const context=R.readRef(R.readRef(state,'_battleController'),'_battleContext');
 if(!context.equals(probe.fixture.context))throw Error('Trial context ownership mismatch');
 if(operation==='demo-control'){
  if(request?.action==='frame-profile')return FrameProfile.execute(()=>R.readRef(probe.fixture.state,'<CurrentState>k__BackingField').equals(state),request.operation,request.seconds);
  if(['graphics-capture','graphics-capture-status'].includes(request?.action))return captureGraphicsFrame(request);
  if(request?.action==='inspect-unit')return BattleInputBridge.inspectUnit(request);
  if(request?.action==='inspect-close')return BattleInputBridge.inspectUnit({close:true});
  const C=OriginalFixtureTools.call,A=R.arg;
  if(request?.action==='stat-stages'){
   if(typeof request.unitId!=='string'||!Number.isInteger(request.statId)||request.statId<1||request.statId>62)throw Error('Exact unit and stat ID required');
   const list=C(C(context,'get_BattleUnitsController'),'GetAllDeployedUnits'),n=R.readValue(list,'_size','i32'),items=SceneApi.array(R.readRef(list,'_items'));
   if(n<0||n>64||items.length<n)throw Error('Deployed unit list bounds');
   const matches=items.slice(0,n).filter(u=>!u.isNull()&&SceneApi.string(R.readRef(R.readRef(u,'_unitDO'),'Id'))===request.unitId);
   if(matches.length!==1)throw Error('Unique deployed unit required');
   return {unitId:request.unitId,...readBattleStatStages(matches[0],request.statId)};
  }
  if(request?.action==='loading-status'){
   if(!globalThis.readLoadingProfile)throw Error('Loading profile unavailable');
   return readLoadingProfile();
  }
  if(request?.action==='loading-recover'){
   if(!globalThis.releaseShutdownHomeTransitions)throw Error('Transition recovery unavailable');
   return releaseShutdownHomeTransitions();
  }
  if(request?.action==='graphics-profile'){
   if(!globalThis.readGraphicsProfile)throw Error('Graphics profile not included by this trial host');
   return readGraphicsProfile();
  }
  if(request?.action==='ai-priority-status'){
   if(!globalThis.trialAIPriority)throw Error('No original AI priority override installed');
   return {readConfirmed:true,priority:trialAIPriority.snapshot()};
  }
  if(request?.action==='ai-priority-set'){
   if(!globalThis.trialAIPriority||typeof globalThis.installOriginalAIPriority!=='function')throw Error('Start this trial with an explicit priority configuration first');
   if(!BattleInputBridge.snapshot().awaitingAbility)throw Error('Pause at original player ability input before changing priority');
   const previous=trialAIPriority.snapshot();
   if(!previous.originalUnchanged)throw Error('Original AI tree changed; refuse reconfiguration');
   const next=installOriginalAIPriority(context,request.order);
   let after;
   try{
    after=next.snapshot();
    if(!after.originalUnchanged)throw Error('Original AI tree verification failed');
    trialAIPriority.stop();globalThis.trialAIPriority=next;
   }catch(error){next.stop();throw error;}
   return {configured:true,previousOrder:previous.order,priority:after,scope:'Subsequent enemy decisions only; original player evaluator unchanged'};
  }
  if(request?.action==='result-status'){
   const fsm=C(context,'get_BattleFsmController');
   const view=R.readRef(context,'<BattleDefeatView>k__BackingField');
   return {readConfirmed:true,previous:R.readValue(fsm,'_previousNonIdleState','i32'),next:R.readValue(fsm,'_nextState','i32'),
    defeatView:view.isNull()?null:R.fullName(R.classOf(view))};
  }
  if(request?.action==='dismiss-defeat'){
   const fsm=C(context,'get_BattleFsmController');
   const previous=R.readValue(fsm,'_previousNonIdleState','i32');
   const view=R.readRef(context,'<BattleDefeatView>k__BackingField');
   if(view.isNull())throw Error('Original defeat view not ready');
   const type=R.fullName(R.classOf(view));
   if(type!=='BattleDefeatNoOpView'||previous!==118)throw Error('Original private defeat celebration is not ready');
   const callback=R.readRef(view,'OnDefeatCelebrationScrimClicked');
   if(callback.isNull())throw Error('Original defeat callback not ready');
   if(probe.dismissedDefeat?.equals(view))throw Error('Defeat dismissal already dispatched');
   probe.dismissedDefeat=view;
   C(callback,'Invoke');
   return {callbackDispatched:true,transitionConfirmed:false};
  }
  if(request?.action==='dismiss-reminder'){
   const fsm=C(context,'get_BattleFsmController');
   if(R.readValue(fsm,'_previousNonIdleState','i32')!==117)throw Error('Not at original defeat upgrade reminder');
   const module=R.readRef(context,'<CombatTypeModule>k__BackingField');
   if(R.fullName(R.classOf(module))!=='BattleControllerCombatTypeCharacterModule')throw Error('Only character defeat reminder verified');
   const controller=R.readRef(module,'_upgradeReminderController');
   if(controller.isNull()||!R.readRef(controller,'_battleContext').equals(context))throw Error('Reminder context ownership mismatch');
   const view=R.readRef(controller,'_battleUnitUpgradeReminderView');
   if(view.isNull()||R.readRef(controller,'_dismiss').isNull())throw Error('Original reminder not ready');
   if(probe.dismissedReminder?.equals(view))throw Error('Reminder dismissal already dispatched; observe state');
   probe.dismissedReminder=view;
   C(controller,'OnDismissClicked');
   return {callbackDispatched:true,operation:'original defeat reminder dismissal',transitionConfirmed:false};
  }
  if(request?.action==='stop'){
   probe.stopRequested=true;
   return {transitionConfirmed:true,stopRequested:true,cleanupPending:true};
  }
  if(request?.action==='auto'){
   const modes={off:0,on:1,basic:2};
   if(!Object.hasOwn(modes,request.mode))throw Error('Unknown auto mode');
   const auto=R.readRef(context,'<BattleAutoController>k__BackingField');
   if(R.fullName(R.classOf(auto))!=='BattleAutoController')throw Error('Native auto controller unavailable');
   const before=R.readValue(auto,'<CurrentAutoStatus>k__BackingField','i32');
   probe.disableInitialAuto=true;
   if(before===modes[request.mode]){delete probe.pendingAutoMode;return {transitionConfirmed:true,auto:before,unchanged:true};}
   if(probe.enemyGate?.snapshot().pending){
    probe.pendingAutoMode=modes[request.mode];
    return {transitionConfirmed:true,auto:before,requestedAuto:probe.pendingAutoMode,deferredUntilPlayerInput:true};
   }
   C(auto,'SetMode',[A.value('i32',modes[request.mode])]);
   const actual=R.readValue(auto,'<CurrentAutoStatus>k__BackingField','i32');
   return {transitionConfirmed:actual===modes[request.mode],auto:actual};
  }
  if(request?.action==='speed-next'){
   C(C(context,'get_BattleTimeScaleController'),'CycleBattleTimeScale');
   const scale=R.unbox(R.invoke(R.findMethod(R.findClass('UnityEngine.Time'),'get_timeScale',0),R.nil),'f32');
   return {transitionConfirmed:true,nativeTimeScale:scale,operation:'original speed button cycle'};
  }
  throw Error('Unsupported demo control');
 }
 if(['enemy-policy','enemy-basic','enemy-resume','enemy-target','enemy-ability','enemy-unit','enemy-cancel'].includes(operation)){
  if(!probe.enemyGate)throw Error('Explicit enemy control not enabled for this trial');
  if(!request||typeof request.token!=='string')throw Error('Expected enemy input token');
  if(operation==='enemy-policy')return probe.enemyGate.configurePolicy(request);
  if(operation==='enemy-unit')return probe.enemyGate.selectUnit(request);
  if(operation==='enemy-cancel')return probe.enemyGate.cancelSelection(request.token);
  if(operation==='enemy-target'&&request.nativeUI===true)return probe.enemyGate.tapUI(request);
  if(operation==='enemy-ability'&&request.nativeUI===true)return probe.enemyGate.clickUI(request);
  if(operation==='enemy-target')return probe.enemyGate.selectTarget(request);
  if(operation==='enemy-ability')return probe.enemyGate.chooseAbility(request);
  return operation==='enemy-basic'?probe.enemyGate.chooseBasic(request.token):probe.enemyGate.resume(request.token);
 }
 if(probe.enemyGate?.snapshot().pending)throw Error('Use enemy commands while enemy input is held');
 const actions={'battle-ability':BattleInputBridge.choose,'battle-target':BattleInputBridge.selectTarget,
  'battle-unit':BattleInputBridge.selectUnit,'battle-cancel':BattleInputBridge.cancelSelection};
 if(!Object.hasOwn(actions,operation))throw Error('Only battle inputs are available in a trial');
 return actions[operation](request);
});
rpc.exports.enemysnapshot=()=>RuntimeApi.runOnMainThreadOnce(()=>globalThis.visualProbe?.enemyGate?.snapshot()||{pending:false,enabled:false});
