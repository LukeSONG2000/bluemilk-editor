'use strict';
// Presentation/input adapter only. Never swaps owners or substitutes ability data.
globalThis.installEnemyManualUI=(context,gate,currentActor,abilities)=>{
 const R=RuntimeApi,S=SceneApi,A=R.arg;
 const call=(type,name,obj,args=[],types)=>S.invoke(type,name,obj,args,types);
 let shown=null,view=null,stopped=false,lastError=null,targetDetailsError=null,shownToken=null,lastDispatch=null,lastTap=null,ownedBasic=null,shownTarget=null;
 const deployed=()=>{
  const controller=call('BattleContext','get_BattleUnitsController',context);
  const list=call('BattleUnitsController','GetAllDeployedUnits',controller);
  return S.array(R.readRef(list,'_items')).slice(0,R.readValue(list,'_size','i32'));
 };
 const id=unit=>S.string(R.readRef(R.readRef(unit,'_unitDO'),'Id'));
 const component=unit=>R.readRef(unit,'<UnitGOComponent>k__BackingField');
 const address=R.findMethod(R.findClass('BattleBaseView'),'HandleAbilityButtonClicked',2).readPointer();
 const original=new NativeFunction(address,'void',['pointer','int','pointer','pointer']);
 const handleButton=(self,moveType,ability,info)=>{
  const unit=currentActor();
  if(stopped||unit.isNull()||!view||!self.equals(view))return original(self,moveType,ability,info);
  try{
   if(gate.snapshot().policy.enabled)throw Error('Enemy policy currently owns input');
   const chosen=abilities().find(x=>x.ability.equals(ability));
   if(!chosen)throw Error('Enemy UI ability is outside original controllable list');
   const live=gate.snapshot();
   lastDispatch=gate.chooseAbility({token:live.token,moveType:chosen.moveType,index:chosen.index});
   if(!gate.snapshot().pending){call('BattleBaseView','ToggleAbilityButtonsVisible',view,[A.value('bool',false)]);shown=null;}
  }catch(e){lastError=String(e);send({kind:'enemy-ui-error',error:lastError});}
 };
 const replacement=new NativeCallback(handleButton,'void',['pointer','int','pointer','pointer']);
 Interceptor.replace(address,replacement);Interceptor.flush();
 const tapAddress=R.findMethod(R.findClass('UnitComponentNullable'),'Tapped',1).readPointer();
 const originalTap=new NativeFunction(tapAddress,'void',['pointer','pointer','pointer']);
 const handleTap=(self,tapId,info)=>{
  if(stopped||currentActor().isNull())return originalTap(self,tapId,info);
  try{
   const targetId=S.string(tapId),unit=deployed().find(u=>id(u)===targetId&&component(u).equals(self));
   if(!unit)return originalTap(self,tapId,info);
   const live=gate.snapshot();
   if(live.policy.enabled)throw Error('Enemy policy currently owns input');
   if(live.selectingUnit){lastTap=gate.selectUnit({token:live.token,targetId});return;}
   lastTap=gate.selectTarget({token:live.token,targetId});
   refreshTarget(unit);lastError=null;
  }catch(e){lastError=String(e);send({kind:'enemy-ui-selection-error',error:lastError});}
 };
 const tapReplacement=new NativeCallback(handleTap,'void',['pointer','pointer','pointer']);
 try{Interceptor.replace(tapAddress,tapReplacement);Interceptor.flush();}
 catch(e){Interceptor.revert(address);throw e;}
 // UnitSelectionList.UnitClicked (0x18103C7B0) is the original final
 // selection callback. Tooltip/confirmation presentation remains native.
 const reserveAddress=R.findMethod(R.findClass('UnitSelectionList'),'UnitClicked',1).readPointer();
 const originalReserve=new NativeFunction(reserveAddress,'void',['pointer','pointer','pointer']);
 const handleReserve=(self,data,info)=>{
  if(stopped||currentActor().isNull()||!view)return originalReserve(self,data,info);
  const list=R.readRef(view,'_reinforcementSelectionList');
  if(list.isNull()||!self.equals(list))return originalReserve(self,data,info);
  try{
   const live=gate.snapshot();
   if(!live.selectingUnit||live.selectionKind!=='reinforcement')return originalReserve(self,data,info);
   if(live.policy.enabled)throw Error('Enemy policy currently owns input');
   if(!R.readValue(self,'_listShowing','bool')||data.isNull()||R.fullName(R.classOf(data))!=='UnitListItemRendererData')throw Error('Original reserve tile unavailable');
   const unit=R.readRef(data,'<Unit>k__BackingField');
   if(unit.isNull())throw Error('Original reserve unit unavailable');
   lastTap=gate.selectUnit({token:live.token,targetId:S.string(R.readRef(unit,'Id'))});
   lastError=null;
  }catch(e){lastError=String(e);send({kind:'enemy-ui-reinforcement-error',error:lastError});}
 };
 const reserveReplacement=new NativeCallback(handleReserve,'void',['pointer','pointer','pointer']);
 try{Interceptor.replace(reserveAddress,reserveReplacement);Interceptor.flush();}
 catch(e){Interceptor.revert(tapAddress);Interceptor.revert(address);throw e;}
 function render(factory,value,unit,list,canBeAbilityBlocked){
  if(value.isNull())return R.nil;
  // Resolve the native overload by its actual metadata, including generic spelling.
  const it=Memory.alloc(Process.pointerSize);it.writePointer(R.nil);
  const klass=R.classOf(factory);let method;
  while(!(method=R.api('class_get_methods','pointer',['pointer','pointer'])(klass,it)).isNull()){
   if(R.api('method_get_name','pointer',['pointer'])(method).readUtf8String()!=='Get'||R.api('method_get_param_count','uint',['pointer'])(method)!==4)continue;
   const type=R.api('type_get_name','pointer',['pointer'])(R.api('method_get_param','pointer',['pointer','uint'])(method,0)).readUtf8String();
   if((list&&type.includes('IEnumerable'))||(!list&&type==='AbilityContext'))return R.invoke(method,factory,[A.ref(value),A.ref(unit),A.ref(context),A.value('bool',canBeAbilityBlocked)]);
  }
  throw Error('Native ability render factory overload unavailable');
 }
 function refreshTarget(unit){
  const factory=R.readRef(call('BattleContext','get_BattleFsmController',context),'_abilityButtonRenderDataFactory');
  call('BattleBaseView','ShowAndPositionTargetReticle',view,[A.ref(unit)]);
  call('BattleBaseView','SetOpponentUnitData',view,[A.ref(unit)]);
  try{
   withRenderData(factory,unit,args=>call('BattleBaseView','SetupOpponentAbilities',view,args));targetDetailsError=null;
  }catch(error){
   targetDetailsError={unitId:id(unit),error:String(error)};
   const component=R.readRef(view,'_opponentAbilitiesComponent');
   if(!component.isNull())call('BattleAbilityComponent','ToggleAbilityButtonsVisible',component,[A.value('bool',false)]);
   send({kind:'enemy-target-details-error',...targetDetailsError});
  }
  shownTarget=id(unit);
 }
 function withRenderData(factory,unit,consume){
  const handles=[];
  const keep=p=>{if(!p.isNull())handles.push(R.retain(p));return p;};
  try{
   // Original StartAbilitySelectPhase (0x18193BA20): only specials are
   // blockable. Passing true for an empty leader context reaches the native
   // factory's AbilityDO dereference when the unit is ability-blocked.
   const args=[['_attackAbilityContext',false,false],['_limitBreakAbilityContexts',true,true],
    ['_leaderAbilityContext',false,false],['_uniqueAbilityContexts',true,false]]
    .map(([field,list,blockable])=>{try{return A.ref(keep(render(factory,R.readRef(unit,field),unit,list,blockable)));}catch(error){throw Error(field+': '+String(error));}});
   return consume(args,keep);
  }finally{for(const handle of handles)R.release(handle);}
 }
 function hideOwned(){
  if(view&&ownedBasic){
   const table=R.readRef(view,'_playerAbilitiesComponent'),list=R.readRef(table,'_abilityButtons');
   const first=R.readValue(list,'_size','i32')>0?S.array(R.readRef(list,'_items'))[0]:null;
   const data=first?R.readRef(first,'<RenderData>k__BackingField'):R.nil;
   // A friendly turn may already have rebound the table. Never hide its UI.
   if(!data.isNull()&&R.readRef(data,'<Ability>k__BackingField').equals(ownedBasic))
    call('BattleBaseView','ToggleAbilityButtonsVisible',view,[A.value('bool',false)]);
  }
  shown=null;shownToken=null;ownedBasic=null;shownTarget=null;
 }
 return {
  status:()=>({shown:shown!==null,actor:shown,target:shownTarget,error:lastError,targetDetailsError}),
  click(index){
   if(!shown||!Number.isInteger(index)||index<0)throw Error('Enemy UI not ready');
   const table=R.readRef(view,'_playerAbilitiesComponent'),list=R.readRef(table,'_abilityButtons');
   if(index>=R.readValue(list,'_size','i32'))throw Error('Enemy UI button index out of range');
   lastDispatch=null;
   const button=S.array(R.readRef(list,'_items'))[index];
   const data=R.readRef(button,'<RenderData>k__BackingField');
   if(data.isNull()||!R.readValue(table,'_abilityButtonsVisible','bool')||!R.unbox(call('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(button)),'bool'))throw Error('Native button hidden');
   // The CLI uses the same adapter as screen clicks. Calling a native method
   // inside a Frida callback can bypass nested hooks, so do not claim a click.
   handleButton(view,0,R.readRef(data,'<Ability>k__BackingField'),R.nil);
   if(!lastDispatch)throw Error(lastError||'Native button did not dispatch');
   return {...lastDispatch,originalButtonData:true,inputAdapter:true};
  },
  tap(targetId){
   const unit=deployed().find(u=>id(u)===targetId);if(!unit)throw Error('Unit absent from owned battle');
   lastTap=null;
   handleTap(component(unit),R.string(targetId),R.nil);
   if(!lastTap)throw Error(lastError||'Native unit tap did not dispatch');
   return {...lastTap,targetConfirmed:lastTap.targetConfirmed===true||(lastTap.started===true&&lastTap.allyTarget===targetId),inputAdapter:true};
  },
  tick(){
   const unit=currentActor();if(stopped)return;
   const live=gate.snapshot();
   if(!live.policy.available){shown=null;shownToken=null;ownedBasic=null;return;}
   if(unit.isNull()||live.policy.enabled){hideOwned();return;}
   if(live.selectingUnit){hideOwned();return;}
   view=call('BattleContext','get_BattleView',context);
   // Enemy turns target the original left side. Keep the native target HUD in
   // sync even when selection changed through CLI rather than a screen tap.
   if((shownToken!==live.token||shownTarget!==live.selectedTarget)&&
      live.targets?.some(t=>t.id===live.selectedTarget)){
    const target=deployed().find(u=>id(u)===live.selectedTarget);
    if(target)refreshTarget(target);
   }
   if(shownToken===live.token)return;
   const fsm=call('BattleContext','get_BattleFsmController',context);
   const factory=R.readRef(fsm,'_abilityButtonRenderDataFactory');
   withRenderData(factory,unit,(args,keep)=>{
    const forced=keep(call('BattleUnitController','GetForcedAbilities',unit));
    call('BattleBaseView','SetupAbilityButtons',view,[...args,A.ref(forced),A.ref(unit)]);
   });
   call('BattleBaseView','ToggleAbilityButtonsVisible',view,[A.value('bool',true)]);
   ownedBasic=R.readRef(unit,'_attackAbilityContext');
   shown=live.actor;shownToken=live.token;lastError=null;
   send({kind:'enemy-ui-shown',actor:shown,abilities:live.abilities});
  },
  stop(){if(stopped)return;stopped=true;Interceptor.revert(address);Interceptor.revert(tapAddress);Interceptor.revert(reserveAddress);Interceptor.flush();}
 };
};
