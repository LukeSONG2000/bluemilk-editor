'use strict';
// Concatenate (in order): runtime_api.js, offline_socket_guard.js,
// original_fixture.js, probe_simulation.js. This file starts the probe.
// CLI preparation (PowerShell, from repository root):
// Get-Content tools/runtime_reuse/runtime_api.js,tools/runtime_reuse/offline_socket_guard.js,tools/runtime_reuse/original_fixture.js,tools/runtime_reuse/probe_simulation.js | Set-Content -Encoding utf8 logs/high_reuse/runtime_probe_combined.js
// frida -p <existing-original-process-pid> -l logs/high_reuse/runtime_probe_combined.js
// Keep the Frida script loaded until simulation-probe-complete reports cleanup.
// Optional preceding config: globalThis.simulationProbeOptions={seed:8,...}.
(async () => {
 const R=RuntimeApi,A=R.arg,call=OriginalFixtureTools.call;
 const options=Object.assign({flags:7,playerIds:['VADER'],opponentIds:['STORMTROOPER'],seed:8},globalThis.simulationProbeOptions||{});
 if(options.flags!==7)throw Error('The manually ticked probe requires HEADLESS simulation flags 7');
 const hooks=[],healthChanges=[],attacks=[],trace=[];
 const counts={SetBattleState:0,FsmFinishBattle:0,FsmSendBattleFinishRequest:0,SimulationDomainFinishBattle:0,SaveBattleOutcome:0,SendBattleStartRequest:0,SendBattleFinishRequest:0};
 let fixture=null,guard=null,loop=null,fsm=null,initializationAttempted=false,ticks=0,lastState=-1,error=null;
 let terminal=false,callbackObserved=false,fsmOutcome=null,simulationOutcome=null,summary=null;
 const cleanup={attempted:false,loopStopped:false,simulationShutdown:false,hooksDetached:false,guardRestored:false,gcReleased:false,errors:[]};
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 function observe(kind,row={}) {counts[kind]=(counts[kind]||0)+1;if(trace.length<300)trace.push(Object.assign({kind,tick:ticks},row));}
 function hook(type,method,argc,handlers) {
  const address=R.findMethod(R.findClass(type),method,argc).readPointer();
  if(address.isNull())throw Error('Native entry unavailable '+type+'.'+method);
  const listener=Interceptor.attach(address,handlers);hooks.push(listener);return listener;
 }
 function unitRows() {
  const list=call(call(fixture.context,'get_BattleUnitsController'),'get_AllUnitControllers');
  const items=R.readRef(list,'_items'),size=R.readValue(list,'_size','i32');
  if(size<0||size>10000||(!items.isNull()&&size>items.add(24).readU64().toNumber()))throw Error('Unit list bounds invalid');
  if(items.isNull()){if(size!==0)throw Error('Unit list lacks backing array');return [];}
  const result=[];
  for(let i=0;i<size;i++) {
   const unit=items.add(32+i*8).readPointer();
   result.push({owner:R.unbox(call(unit,'get_Owner'),'i32'),hp:R.unbox(call(unit,'get_CurrentHP'),'i32'),
    maxHp:R.unbox(call(unit,'get_MaxHP'),'i32'),shield:R.unbox(call(unit,'get_CurrentShield'),'i32')});
  }
  return result;
 }
 function stateSnapshot() {
  const previousState=R.readValue(fsm,'_previousNonIdleState','i32'),nextState=R.readValue(fsm,'_nextState','i32');
  terminal=previousState===136&&nextState===0;
  fsmOutcome=R.unbox(call(fsm,'get_BattleOutcome'),'i32');
  simulationOutcome=R.unbox(call(fixture.simulation,'get_BattleOutcome'),'i32');
  return {previousState,nextState,terminal,fsmOutcome,simulationOutcome,
   coreBattleStatus:R.readValue(fsm,'_battleStatus','u8'),turns:R.readValue(fsm,'<TurnCount>k__BackingField','i32')};
 }
 try {
  await R.runOnMainThreadOnce(()=>{
   // Install before any fixture/context construction. Builder only assembles
   // original DTOs; it never substitutes a server BattleStartResponse.
   guard=installOfflineSocketGuard();
   fixture=createOriginalFixture(options);
   globalThis.simulationProbe=fixture;
   send(originalFixtureDiagnostics(fixture));
   loop=call(fixture.context,'get_GameLoop');fsm=call(fixture.context,'get_BattleFsmController');
   // Install all lifecycle hooks BEFORE Initialize, so synchronous completion
   // cannot escape observation. Receiver filters exclude unrelated instances.
   hook('BattleFsmController','SetBattleState',1,{onEnter(args){if(args[0].equals(fsm))observe('SetBattleState',{state:args[1].toInt32()});}});
   hook('BattleFsmController','FinishBattle',3,{onEnter(args){if(args[0].equals(fsm))observe('FsmFinishBattle',{submitResults:args[1].toInt32()!==0});}});
   hook('BattleFsmController','SendBattleFinishRequest',1,{onEnter(args){if(args[0].equals(fsm))observe('FsmSendBattleFinishRequest');}});
   hook('BattleDomainSimulationController','FinishBattle',17,{onEnter(args){if(args[0].equals(fixture.domain))observe('SimulationDomainFinishBattle',{outcome:args[1].toInt32()});}});
   hook('BattleSimulationController','SaveBattleOutcome',2,{onEnter(args){if(args[0].equals(fixture.simulation)){callbackObserved=true;observe('SaveBattleOutcome',{outcome:args[1].toInt32()});}}});
   for(const name of ['SendBattleStartRequest','SendBattleFinishRequest'])
    hook('BattleService',name,6,{onEnter(){observe(name);}});
   hook('BattleDataDO','GetSquad',1,{
    onEnter(args){this.match=args[0].equals(fixture.battleData);},
    onLeave(result){if(this.match)observe('GetSquad',{found:!result.isNull()});}
   });
   hook('BattleUnitController','UpdateHealth',5,{onEnter(args){
    if(healthChanges.length<100)healthChanges.push({healthDelta:args[1].toInt32(),shieldDelta:args[2].toInt32()});
   }});
   hook('BattleUnitController','ApplyAttackDamage',11,{onEnter(args){
    if(attacks.length<100)attacks.push({hpDamage:args[1].toInt32(),shieldDamage:args[2].toInt32(),crit:args[3].toInt32()!==0});
   }});
   initializationAttempted=true;
   call(fixture.simulation,'Initialize',[A.ref(fixture.data),A.ref(R.nil)]);
   send({kind:'original-simulation-initialized',loop:R.fullName(R.classOf(loop)),simulationOutcomeDiagnosticOnly:R.unbox(call(fixture.simulation,'get_BattleOutcome'),'i32')});
  });
  const deadline=Date.now()+30000;
  while(!terminal && Date.now()<deadline) {
   await R.runOnMainThreadOnce(()=>{
    for(let i=0;i<50&&!terminal;i++) {
     call(loop,'OnUpdate');ticks++;
     terminal=R.readValue(fsm,'_previousNonIdleState','i32')===136&&R.readValue(fsm,'_nextState','i32')===0;
    }
    const snapshot=stateSnapshot();
    if(snapshot.previousState!==lastState){lastState=snapshot.previousState;
     send(Object.assign({kind:'simulation-progress',ticks,units:unitRows()},snapshot));}
    if(terminal)summary=Object.assign({units:unitRows()},snapshot);
   });
   if(!terminal)await wait(25);
  }
  if(!terminal)error='Original FSM did not reach terminal136/next0 before timeout';
 } catch(exception) {
  error=String(exception);
  send({kind:'simulation-probe-error',error});
 } finally {
  // A dispatch timeout, metadata failure, observer failure, Initialize exception,
  // or native invocation exception all pass through this same cleanup chain.
  try {
   if(fixture&&initializationAttempted) {
    cleanup.attempted=true;
    await R.runOnMainThreadOnce(()=>{
     try {
      if(terminal){call(fixture.simulation,'Shutdown');cleanup.simulationShutdown=true;cleanup.loopStopped=true;}
      else if(loop&&!loop.isNull()){call(loop,'Shutdown');cleanup.loopStopped=true;}
     } catch(exception) {
      cleanup.errors.push('shutdown: '+String(exception));
      // Preserve the original loop-stop fallback if controller shutdown fails.
      if(loop&&!loop.isNull())try{call(loop,'Shutdown');cleanup.loopStopped=true;}catch(fallback){cleanup.errors.push('loop shutdown: '+String(fallback));}
     }
    });
   }
  } catch(exception) {cleanup.errors.push('main-thread cleanup: '+String(exception));}
  finally {
   try {for(const listener of hooks)try{listener.detach();}catch(e){cleanup.errors.push('detach: '+String(e));}cleanup.hooksDetached=true;}
   finally {
    try {if(guard){guard.restore();cleanup.guardRestored=true;}}
    catch(e){cleanup.errors.push('guard restore: '+String(e));}
    finally {try{
     if(fixture?.restoreDefinitions){
      if(initializationAttempted&&!cleanup.loopStopped)throw Error('Definitions retained while simulation may be active');
      await R.runOnMainThreadOnce(()=>fixture.restoreDefinitions());cleanup.definitionsRestored=true;
     }
     R.releaseAll();cleanup.gcReleased=true;
    }catch(e){cleanup.errors.push('definitions/GC release: '+String(e));}}
   }
  }
  const serviceCalls=counts.SendBattleStartRequest+counts.SendBattleFinishRequest;
  send({kind:'simulation-probe-complete',ticks,error,terminal,callbackObserved,
   fsmOutcome,simulationOutcomeDiagnosticOnly:simulationOutcome,
   verifiedVictory:terminal&&fsmOutcome===0&&error===null&&serviceCalls===0&&cleanup.loopStopped&&cleanup.errors.length===0,
   summary,healthChanges,attacks,counts,trace,traceLimit:300,serviceCalls,
   blockedSocketCalls:guard?guard.counts:null,socketDiagnostics:guard?guard.diagnostics():null,cleanup});
 }
})().catch(error=>send({kind:'simulation-probe-outer-error',error:String(error)}));
