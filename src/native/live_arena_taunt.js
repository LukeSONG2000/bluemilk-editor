'use strict';
// Explicit one-match arm from native PVP prebattle. Reuses the isolated
// input gate; no network hooks, battle result editing or simulation replacement.
globalThis.installLiveArenaTaunt=(expectedCombatType=0,initialPolicy={enabled:false,allowedTargets:[],oneClickTaunt:true},scopeOptions={})=>{
 if(![0,1].includes(expectedCombatType))throw Error('Unsupported arena combat type');
 const autoBattleType=scopeOptions.generic===true&&scopeOptions.battleType==='all';
 const expectedBattleType=autoBattleType?null:(scopeOptions.battleType??0);
 if(!autoBattleType&&(!Number.isInteger(expectedBattleType)||expectedBattleType<0||expectedBattleType>9))throw Error('Unsupported native battle type');
 const R=RuntimeApi,A=R.arg;
 const states=R.findBound('StateController'),current=()=>R.readRef(states,'<CurrentState>k__BackingField');
 if(scopeOptions.generic===true?R.fullName(R.classOf(current()))==='BattleGameState':R.fullName(R.classOf(current()))!=='PvpPreBattleState')throw Error('Arm only from original PVP prebattle');
 const call=(p,n,args=[])=>R.invoke(R.findMethod(R.classOf(p),n,args.length),p,args);
 const address=R.findMethod(R.findClass('BattleInputProvider'),'DoMove',2).readPointer();
 const original=new NativeFunction(address,'void',['pointer','pointer','pointer','pointer']);
 const status={battleType:expectedBattleType,manualUI:scopeOptions.manualUI===true,combatType:expectedCombatType,armed:true,entered:false,finished:false,errors:[],playerOriginalInputs:0};
 let entered=null,data=null,gate=null,ownership=null,timer=null,busy=false,stopped=false,lastCount=-1,attempted=false;
 function validatePolicy(request){
  if(typeof request?.enabled!=='boolean'||typeof request?.oneClickTaunt!=='boolean'||!Array.isArray(request.allowedTargets)||request.allowedTargets.length>16||request.allowedTargets.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(request.allowedTargets).size!==request.allowedTargets.length)throw Error('Invalid enemy policy');
  if(request.enabled&&!request.oneClickTaunt&&!request.allowedTargets.length)throw Error('Select at least one permitted target');
  return {enabled:request.enabled,oneClickTaunt:request.oneClickTaunt,allowedTargets:request.allowedTargets.slice()};
 }
 let desired=validatePolicy(initialPolicy);
 const hooks=[];
 let reportedEvents=0;
 const report=kind=>{const all=gate?.events||[];const events=kind==='live-taunt-progress'?all.slice(reportedEvents):all.slice(-512);reportedEvents=all.length;send({kind,...status,policy:gate?.snapshot().policy,eventCount:all.length,events,gateErrors:gate?.errors||[]});};
 function stop(){
  if(stopped)return;
  if(gate){const pending=gate.snapshot();if(pending.pending&&ownership&&!ownership.exited&&current().equals(entered))gate.resume(pending.token);gate.stop();}else Interceptor.revert(address);
  stopped=true;status.armed=false;if(timer)clearInterval(timer);
  for(const h of hooks)h.detach();Interceptor.flush();report('live-taunt-stopped');
 }
 const bootstrap=new NativeCallback((provider,unit,callback,info)=>{
  if(stopped||!entered||!current().equals(entered))return original(provider,unit,callback,info);
  let handedOff=false;
  try{
   const context=R.readRef(R.readRef(entered,'_battleController'),'_battleContext');
   if(context.isNull()||!R.readRef(provider,'_battleContext').equals(context)||!call(context,'get_CurrentUnit').equals(unit))return original(provider,unit,callback,info);
   if(R.unbox(call(unit,'get_Owner'),'i32')!==1){status.playerOriginalInputs++;return original(provider,unit,callback,info);}
   ownership={fixture:{context,state:states,data},entered,exited:false};
   Interceptor.revert(address);Interceptor.flush();
   gate=installEnemyInputGate(context,ownership,{manualUI:scopeOptions.manualUI===true});
   gate.configurePolicy({token:gate.snapshot().policy.token,...desired});
   handedOff=true;gate.handleInput(provider,unit,callback,info);gate.tickPolicy();
   report('live-taunt-active');
   timer=setInterval(()=>{
    if(busy||stopped)return;busy=true;
    R.runOnMainThreadOnce(()=>{
     if(stopped)return;
     if(!current().equals(entered))return;
     gate.tickPolicy();
     if(gate.events.length!==lastCount){lastCount=gate.events.length;report('live-taunt-progress');}
    }).catch(e=>{status.errors.push(String(e));report('live-taunt-error');}).finally(()=>{busy=false;});
   },100);
  }catch(e){
   status.errors.push(String(e));report('live-taunt-error');
   // Never dispatch the original AI after the gate has taken the callback.
   if(!handedOff)original(provider,unit,callback,info);
  }
 },'void',['pointer','pointer','pointer','pointer']);
 try{
  hooks.push(Interceptor.attach(R.findMethod(R.findClass('BattleGameState'),'SC_Enter',2).readPointer(),{onEnter(args){
   if(stopped||attempted)return;attempted=true;
   try{
    if(R.fullName(R.classOf(args[1]))!=='BattleGameState+TransitionData')throw Error('Unknown original battle transition');
    const actualType=R.readValue(args[1],'<BattleTypeEnum>k__BackingField','u8');
    if(!Number.isInteger(actualType)||actualType<0||actualType>9||(!autoBattleType&&actualType!==expectedBattleType)||R.readValue(args[1],'<CombatTypeEnum>k__BackingField','u8')!==expectedCombatType)throw Error('Next battle does not match armed battle scope');
    status.battleType=actualType;
    entered=args[0];data=args[1];status.entered=true;report('live-taunt-entered');
   }catch(e){status.errors.push(String(e));stop();}
  }}));
  hooks.push(Interceptor.attach(R.findMethod(R.findClass('BattleGameState'),'SC_Exit',2).readPointer(),{onEnter(args){
   if(entered&&args[0].equals(entered)){if(ownership)ownership.exited=true;status.finished=true;stop();}
  }}));
  Interceptor.replace(address,bootstrap);Interceptor.flush();report('live-taunt-armed');
 }catch(e){stop();throw e;}
 return {status:()=>status,stop,
  input(operation,request){
   if(!gate||stopped)throw Error('No owned enemy input');
   const actions={ability:()=>gate.chooseAbility(request),basic:()=>gate.chooseBasic(request.token),target:()=>gate.selectTarget(request),unit:()=>gate.selectUnit(request),cancel:()=>gate.cancelSelection(request.token),resume:()=>gate.resume(request.token),button:()=>gate.clickUI(request),tap:()=>gate.tapUI(request)};
   if(!Object.hasOwn(actions,operation))throw Error('Unknown enemy operation');
   return actions[operation]();
  },
  snapshot:()=>({status:{...status},input:gate&&!stopped?gate.snapshot():{pending:false,policy:{available:false,combatType:expectedCombatType,...desired}}}),
  configure(request){
   if(stopped)throw Error('Arena controller finished; arm another match from prebattle');
   const next=validatePolicy(request);
   if(gate){gate.configurePolicy({...next,token:gate.snapshot().policy.token});desired=next;gate.tickPolicy();}
   else desired=next;
   return this.snapshot();
  }
 };
};

// Explicitly scoped next battle; does not navigate, enter or submit that battle.
globalThis.installLiveBattleControl=(scope,policy={enabled:false,oneClickTaunt:false,allowedTargets:[]})=>{
 if(!scope||!(Number.isInteger(scope.battleType)||scope.battleType==='all')||!Number.isInteger(scope.combatType))throw Error('Explicit battleType (or all) and combatType required');
 return installLiveArenaTaunt(scope.combatType,policy,{...scope,generic:true});
};
