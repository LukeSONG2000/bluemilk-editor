'use strict';
// Presentation only. No battle setters, input commands, account writes or RPCs.
globalThis.installBattleInfo=()=>{
 if(globalThis.battleInfoInstance&&globalThis.battleInfoInstance.status().lifecycle!=='stopped')throw Error('Information module already active or awaiting cleanup');
 const R=RuntimeApi,S=SceneApi,A=R.arg,call=S.invoke,hooks=[],popups=new Map(),targets=new Map(),shipTargets=new Map();
 const marker='\n[80DFFF]',stats={shows:0,updates:0,modeGateCalls:0,tutorialDisplays:0,errors:[],healthAnomalies:[],last:null,target:null};
 let stopped=false,refreshTimer=null,refreshPending=false,stopPromise=null;
 stats.lifecycle='installing';
 stats.errorCount=0;
 stats.timing={};stats.popupVisibilityChecks=0;
 function measure(name,fn){
  const started=Date.now();
  try{return fn();}finally{
   const elapsed=Date.now()-started,item=stats.timing[name]||(stats.timing[name]={calls:0,totalMs:0,maxMs:0});
   item.calls++;item.totalMs+=elapsed;item.maxMs=Math.max(item.maxMs,elapsed);
  }
 }
 const list=l=>l.isNull()?[]:S.array(R.readRef(l,'_items')).slice(0,R.readValue(l,'_size','i32'));
 const active=o=>!!R.unbox(call('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(o)),'bool');
 const withString=(text,fn)=>{const string=R.api('string_new','pointer',['pointer'])(Memory.allocUtf8String(text)),handle=R.retain(string);try{return fn(string);}finally{R.release(handle);}};
 const setText=(label,text)=>withString(text,string=>call('UILabel','set_text',label,[A.ref(string)]));
 function safe(fn){try{return fn();}catch(e){stats.errorCount++;const message=String(e);if(!stats.errors.includes(message)){stats.errors.push(message);send({kind:'battle-info-error',error:message,stack:e.stack});}}}
 function detachHooks(){for(let i=hooks.length-1;i>=0;i--)safe(()=>{hooks[i].detach();hooks.splice(i,1);});}
 function hook(type,name,n,callbacks){hooks.push(Interceptor.attach(R.findMethod(R.findClass(type),name,n).readPointer(),callbacks));}
 function setVector(t,name,values){const p=Memory.alloc(4*values.length);values.forEach((v,i)=>p.add(i*4).writeFloat(v));call('UnityEngine.Transform','set_'+name,t,[A.byRef(p)]);}
 function makeLabel(popup,options={}){
  const template=R.readRef(popup,'_ultimateChargeLabel');
  const clone=call('UnityEngine.Object','Instantiate',R.nil,[A.ref(S.gameObject(template)),A.ref(options.parent||S.parent(S.transform(template))),A.value('bool',false)],['UnityEngine.Object','UnityEngine.Transform','System.Boolean']);
  withString(options.name||'REA_AbsoluteHealth',name=>call('UnityEngine.Object','set_name',clone,[A.ref(name)]));
  const label=call('UnityEngine.GameObject','GetComponent',clone,[A.ref(S.type('UILabel'))],['System.Type']);
  for(const anchor of ['leftAnchor','rightAnchor','topAnchor','bottomAnchor']){const a=R.readRef(label,anchor);if(!a.isNull())R.writeRef(a,'target',R.nil);}
  call('UIWidget','set_pivot',label,[A.value('i32',options.pivot??0)]);
  call('UIWidget','set_width',label,[A.value('i32',options.width||450)]);
  call('UIWidget','set_height',label,[A.value('i32',48)]);
  call('UILabel','set_fontSize',label,[A.value('i32',options.font||20)]);
  call('UILabel','set_maxLineCount',label,[A.value('i32',2)]);
  call('UILabel','set_alignment',label,[A.value('i32',options.align??3)]);
  call('UILabel','set_supportEncoding',label,[A.value('bool',true)]);
  setVector(S.transform(label),'localPosition',options.position||[-205,-75,0]);
  const color=Memory.alloc(16);[1,1,1,1].forEach((v,i)=>color.add(i*4).writeFloat(v));call('UIWidget','set_color',label,[A.byRef(color)]);
  call('UnityEngine.GameObject','SetActive',clone,[A.value('bool',true)]);
  return label;
 }
 function destroyOwnedLabel(label){
  const object=S.gameObject(label);
  call('UnityEngine.GameObject','SetActive',object,[A.value('bool',false)]);
  call('UnityEngine.Object','Destroy',R.nil,[A.ref(object)],['UnityEngine.Object']);
  stats.labelDestroyRequests=(stats.labelDestroyRequests||0)+1;
 }
 function healthText(unit){
  const read=n=>R.unbox(call('BattleUnitController','get_'+n,unit),'i32');
  const values={};
  // Original CurrentShield caps the usable total at max(0, MaxShield).
  // A negative native ceiling can coexist with retained permanent shield;
  // expose it as a restriction, without rewriting either native reading.
  const pair=(label,a,b)=>{values[a]=read(a);values[b]=read(b);return label+' '+values[a]+' / '+(values[b]<0?'受限('+values[b]+')':values[b]);};
  const text=[pair('生命','CurrentHP','MaxHP'),pair('总护盾','CurrentShield','MaxShield'),pair('永久护盾','CurrentPermanentShield','MaxPermanentShield'),pair('临时护盾','CurrentBonusShield','MaxBonusShield')].join('\n');
  if(Object.values(values).some(v=>v<0)&&stats.healthAnomalies.length<16){
   const key=unit.toString()+':'+JSON.stringify(values);
   if(!stats.healthAnomalies.some(row=>row.key===key)){
    const row={key,values,observedAt:Date.now(),unitType:R.fullName(R.classOf(unit))};
    // Preserve native values. Do not clamp a negative stat or substitute a
    // previous target's maximum before the source of the anomaly is known.
    try{
     row.maxShieldStat=R.unbox(call('BattleUnitController','GetStatValue',unit,[A.value('u8',25)],['UnitStatEnum']),'f32');
     row.unitId=S.string(R.readRef(call('BattleUnitController','get_UnitDO',unit),'Id'));
    }catch(e){row.diagnosticError=String(e);}
    stats.healthAnomalies.push(row);send({kind:'battle-info-health-anomaly',...row});
   }
  }
  return text;
 }
 function widgetBounds(parent,control){
  const box=call('NGUIMath','CalculateRelativeWidgetBounds',R.nil,[A.ref(parent),A.ref(S.transform(control))],['UnityEngine.Transform','UnityEngine.Transform']);
  const p=R.api('object_unbox','pointer',['pointer'])(box);
  return {left:p.readFloat()-p.add(12).readFloat(),right:p.readFloat()+p.add(12).readFloat(),y:p.add(4).readFloat()};
 }
 function nativeColor(box){
  const p=R.api('object_unbox','pointer',['pointer'])(box);
  return [0,4,8].map(i=>Math.round(Math.max(0,Math.min(1,p.add(i).readFloat()))*255).toString(16).padStart(2,'0')).join('').toUpperCase();
 }
 function barColor(bar){
  return nativeColor(call('UIWidget','get_color',call('UIProgressBar','get_foregroundWidget',bar)));
 }
 function numericHealth(unit,bars,healthComponent,shieldAbove=false,deriveHealthColor=false){
  const read=n=>R.unbox(call('BattleUnitController','get_'+n,unit),'i32');
  const hp=deriveHealthColor?nativeColor(call('UnitHealthBar','GetHealthColor',healthComponent,[A.value('f32',read('MaxHP')>0?read('CurrentHP')/read('MaxHP'):0)])):barColor(bars.health),full=nativeColor(call('UnitHealthBar','GetHealthColor',healthComponent,[A.value('f32',1)]));
  const shield=barColor(bars.shield),bonus=barColor(bars.bonus);
  const pair=(current,max,currentColor,maxColor=currentColor)=>
   '['+currentColor+']'+current+'[-][FFFFFF]/[-]['+maxColor+']'+max+'[-]';
  const healthLine=pair(read('CurrentHP'),read('MaxHP'),hp,full);
  const bonusCurrent=read('CurrentBonusShield');
  const permanentMax=read('MaxPermanentShield');
  const shieldLine=[
   bonusCurrent===0?'':pair(bonusCurrent,read('MaxBonusShield'),bonus),
   permanentMax===0?'':pair(read('CurrentPermanentShield'),permanentMax,shield)
  ].filter(Boolean).join('    ');
  // Popup bars place protection above health; the target HUD does the reverse.
  return (shieldAbove?[shieldLine,healthLine]:[healthLine,shieldLine]).join('\n');
 }
 function targetNumbers(item){
  const bars={health:R.readRef(item.target,'_healthBar'),shield:R.readRef(item.target,'_shieldBar'),bonus:R.readRef(item.target,'_bonusShieldBar')};
  return numericHealth(item.unit,bars,R.readRef(R.readRef(item.view,'_effectDetailsPopup'),'_healthBar'));
 }
 function timedPrefix(matches){
  const counts=[...new Set(matches.flatMap(e=>e.conditions.filter(c=>c.kind==='event-count'&&Number.isInteger(c.remaining)).map(c=>c.remaining)))];
  return counts.length?'[FFFFFF]('+counts.join('/')+')[-] ':'';
 }
 function layoutTarget(item){
  const name=R.readRef(item.target,'_nameLabel'),parent=S.parent(S.transform(name));
  // Anchor to the bars, not the ability grids below them: extra abilities must
  // not push these numbers away from the health/protection display.
  const controls=[R.readRef(item.target,'_healthBar'),R.readRef(item.target,'_shieldBar')];
  const bounds=control=>{
   const box=call('NGUIMath','CalculateRelativeWidgetBounds',R.nil,[A.ref(parent),A.ref(S.transform(control))],['UnityEngine.Transform','UnityEngine.Transform']);
   const p=R.api('object_unbox','pointer',['pointer'])(box);
   return {left:p.readFloat()-p.add(12).readFloat(),right:p.readFloat()+p.add(12).readFloat()};
  };
  let left=null;
  const measured=[];
  for(const control of controls){
   const isActive=active(control);
   if(!isActive){measured.push({active:false});continue;}
   const measuredBounds=bounds(control);measured.push({active:true,...measuredBounds});
   const minX=measuredBounds.left;
   if(Number.isFinite(minX)&&(left===null||minX<left))left=minX;
  }
  if(left===null){stats.targetLayout={measured,unavailable:true};return;}
  const position=S.vector(S.transform(name),'localPosition');
  const health=widgetBounds(parent,R.readRef(item.target,'_healthBar')),shield=widgetBounds(parent,R.readRef(item.target,'_shieldBar'));
  const center=(health.y+shield.y)/2;
  const gap=16;
  setVector(S.transform(item.label),'localPosition',[left-gap,center,position[2]]);
  // A cloned label can carry scaling/geometry offsets. Correct its actual
  // right edge rather than treating the Transform origin as the edge.
  const actual=bounds(item.label),delta=left-gap-actual.right;
  if(Number.isFinite(delta))setVector(S.transform(item.label),'localPosition',[left-gap+delta,center,position[2]]);
  stats.targetLayout={controlsLeft:left,label:bounds(item.label),gap,measured};
 }
 function refreshShipTarget(view){
  const key=view.toString(),portrait=R.readRef(view,'_opponentPortraitContainer');
  const unit=portrait.isNull()?R.nil:R.readRef(portrait,'_currentlyShownUnit');
  stats.targetSource={viewType:R.fullName(R.classOf(view)),selected:!unit.isNull()};
  let item=shipTargets.get(key);
  if(unit.isNull()){if(item)setText(item.label,'');stats.target=null;return;}
  stats.targetSource.unitId=S.string(R.readRef(R.readRef(unit,'_unitDO'),'Id'));
  stats.targetSource.portraitPresent=!portrait.isNull();stats.targetSource.portraitActive=!portrait.isNull()&&active(portrait);
  if(portrait.isNull()||!active(portrait)){if(item)setText(item.label,'');stats.target=null;return;}
  const popup=R.readRef(view,'_effectDetailsPopup'),health=R.readRef(popup,'_healthBar');
  const parent=S.parent(S.transform(portrait));
  if(!item){item={view,label:makeLabel(popup,{parent,name:'REA_ShipTargetAbsoluteHealth',pivot:5,width:400,font:18,position:[0,0,0]})};shipTargets.set(key,item);}
  const bars={health:R.readRef(health,'_health'),shield:R.readRef(health,'_shield'),bonus:R.readRef(health,'_bonusShield')};
  const text=numericHealth(unit,bars,health,false,true);setText(item.label,text);stats.target=text;
  const bounds=widgetBounds(parent,portrait),component=R.readRef(view,'_opponentAbilitiesComponent');
  let left=bounds.left;
  if(!component.isNull())for(const field of ['_abilityButtonGrid','_leaderAndUniqueIconsGrid']){
   const grid=R.readRef(component,field);if(!grid.isNull()&&active(grid))left=Math.min(left,widgetBounds(parent,grid).left);
  }
  setVector(S.transform(item.label),'localPosition',[left-16,bounds.y,0]);
  const labelBounds=widgetBounds(parent,item.label),delta=left-16-labelBounds.right;
  if(Number.isFinite(delta))setVector(S.transform(item.label),'localPosition',[left-16+delta,bounds.y,0]);
  stats.targetLayout={fleet:true,controlsLeft:left,label:widgetBounds(parent,item.label),gap:16};
 }
 function refreshCurrentTarget(){
  const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
  if(state.isNull()||R.fullName(R.classOf(state))!=='BattleGameState'){stats.target=null;return;}
  const controller=R.readRef(state,'_battleController');if(controller.isNull())return;
  const context=R.readRef(controller,'_battleContext');if(context.isNull())return;
  const view=call('BattleContext','get_BattleView',context);
  if(view.isNull())return;
  stats.targetSource={viewType:R.fullName(R.classOf(view))};
  if(R.fullName(R.classOf(view))==='BattleShipView'){refreshShipTarget(view);return;}
  const target=R.readRef(view,'_opponentTargetComponent');
  if(target.isNull()||!active(target)){stats.target=null;return;}
  let item=targets.get(target.toString());
  if(!item){
   // A tool can attach after native target selection has already happened.
   // Initialize from the current view without replaying a selection callback.
   const selected=R.readRef(view,'<SelectedOpponent>k__BackingField');
   if(selected.isNull()){stats.target=null;return;}
   renderTarget(view,selected);
   item=targets.get(target.toString());
  }
  if(!item||!item.view.equals(view)){stats.target=null;return;}
  // Native selection can change without either observed health callback.
  // The view's selected opponent is authoritative, never the cached hook unit.
  item.unit=R.readRef(view,'<SelectedOpponent>k__BackingField');
  if(item.unit.isNull()){setText(item.label,'');stats.target=null;return;}
  const text=targetNumbers(item);setText(item.label,text);stats.target=text;
  for(const row of stats.healthAnomalies)if(!row.deferred&&row.key.startsWith(item.unit.toString()+':')){
   row.deferred={observedAt:Date.now(),text};
   send({kind:'battle-info-health-deferred',key:row.key,...row.deferred});
  }
  layoutTarget(item);
 }
 function updateTargetItem(item,unit){
  item.unit=unit;
  if(unit.isNull()){setText(item.label,'');stats.target=null;return;}
  const text=targetNumbers(item);setText(item.label,text);stats.target=text;
 }
 function renderTarget(view,unit){
  const target=R.readRef(view,'_opponentTargetComponent');if(target.isNull())return;
  let item=targets.get(target.toString());
  if(unit.isNull()){if(item)updateTargetItem(item,unit);else stats.target=null;return;}
  if(!item){
   const name=R.readRef(target,'_nameLabel'),transform=S.transform(name),position=S.vector(transform,'localPosition');
   const label=makeLabel(R.readRef(view,'_effectDetailsPopup'),{parent:S.parent(transform),name:'REA_TargetAbsoluteHealth',pivot:5,width:400,font:18,position:[position[0],position[1],position[2]]});
   item={target,label,unit,view};targets.set(target.toString(),item);
  }
  layoutTarget(item);
  updateTargetItem(item,unit);
 }
 function visibleEffectOverlay(sprite){
  const overlay=R.readRef(sprite,'_overlaySprite');
  // Pooled native sprites retain their old atlas name while hidden.
  if(overlay.isNull()||!active(overlay))return '';
  return S.string(call('BattleEffectSprite','get_EffectOverlaySpriteName',sprite))||'';
 }
 function render(popup,unit){
  return measure('popupRender',()=>{
   if(!stats.coldPopupProfile&&S.profileCalls){
    stats.coldPopupProfile={sampling:true};
    try{const sample=S.profileCalls(()=>renderBody(popup,unit));
     stats.coldPopupProfile={rows:sample.rows,dropped:sample.dropped,scope:sample.scope};return sample.result;
    }catch(error){stats.coldPopupProfile={error:String(error)};throw error;}
   }
   return renderBody(popup,unit);
  });
 }
 function refreshPopupVisibility(popup){
  if(stopped)return;
  const item=popups.get(popup.toString());if(!item)return;
  const now=Date.now();
  if(now-Math.max(item.lastTime,item.lastCheckTime||0)<=300)return;
  // Advance even while hidden (or if the getter fails), not only after render.
  item.lastCheckTime=now;
  safe(()=>{stats.popupVisibilityChecks++;
   if(R.unbox(call('BattleEffectsPopupView','get_IsDisplaying',popup),'bool'))render(popup,item.unit);
  });
 }
 function renderBody(popup,unit){
  if(unit.isNull())return;
  const key=popup.toString();let item=popups.get(key);
  if(!item)measure('popupItemSetup',()=>{item={popup,unit,label:measure('popupLabelCreate',()=>makeLabel(popup,{pivot:3,align:1,width:240,font:13})),rows:new Map(),table:S.transform(R.readRef(popup,'_effectsTable')),lastTime:0};item.tablePosition=S.vector(item.table,'localPosition');popups.set(key,item);});
  item.unit=unit;
  const status=measure('popupStatusRead',()=>readBattleStatus(unit));
  const healthComponent=R.readRef(popup,'_healthBar');
  const bars={health:R.readRef(healthComponent,'_health'),shield:R.readRef(healthComponent,'_shield'),bonus:R.readRef(healthComponent,'_bonusShield')};
  const text=measure('popupHealthRead',()=>numericHealth(unit,bars,healthComponent,true));
  measure('popupHealthLayout',()=>{
  setText(item.label,text);
  const parent=S.parent(S.transform(item.label)),hb=widgetBounds(parent,bars.health),sb=widgetBounds(parent,bars.shield);
  setVector(S.transform(item.label),'localPosition',[Math.max(hb.right,sb.right)+12,(hb.y+sb.y)/2,0]);
  call('UnityEngine.GameObject','SetActive',S.gameObject(item.label),[A.value('bool',true)]);
  });
  const displayed=[];
  measure('popupEffectRows',()=>{
  for(const row of list(R.readRef(popup,'_effectItemsPool'))){
   if(row.isNull()||!active(row))continue;
   const sprite=R.readRef(row,'_battleEffectDetails'),label=R.readRef(row,'_battleEffectDescription');
   const icon=S.string(call('BattleEffectSprite','get_EffectSpriteName',sprite));
   const overlay=visibleEffectOverlay(sprite);
   const matches=status.effects.filter(e=>e.iconSprite===icon&&(e.overlaySprite||'')===overlay);
   const original=S.string(call('UILabel','get_text',label)).split(marker)[0];
   let saved=item.rows.get(label.toString());
   const base=saved&&original===saved.rendered?saved.base:original;
   if(!saved){
    const widget=call('UnityEngine.GameObject','GetComponent',S.gameObject(row),[A.ref(S.type('UIWidget'))],['System.Type']);
    saved={label,base,widget,overflow:R.unbox(call('UILabel','get_overflowMethod',label),'i32'),lines:R.unbox(call('UILabel','get_maxLineCount',label),'i32'),height:widget.isNull()?null:R.unbox(call('UIWidget','get_height',widget),'i32')};
    item.rows.set(label.toString(),saved);
   }else saved.base=base;
   call('UILabel','set_overflowMethod',label,[A.value('i32',3)]);
   call('UILabel','set_maxLineCount',label,[A.value('i32',0)]);
   const suffix=timedPrefix(matches);
   saved.rendered=suffix+base;
   setText(label,saved.rendered);
   const size=R.api('object_unbox','pointer',['pointer'])(call('UILabel','get_printedSize',label));
   if(!saved.widget.isNull())call('UIWidget','set_height',saved.widget,[A.value('i32',Math.max(saved.height,Math.ceil(size.add(4).readFloat())+12))]);
   displayed.push({icon,overlay,suffix,instances:matches.length});
  }
  call('UITable','Reposition',R.readRef(popup,'_effectsTable'));
  });
  item.lastTime=Date.now();stats.updates++;stats.last={health:text,effects:displayed};
 }
 function refreshOpponent(enabled=true){
  const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
  if(state.isNull())return;
  if(R.fullName(R.classOf(state))!=='BattleGameState')return;
  const controller=R.readRef(state,'_battleController');if(controller.isNull())return;
  const context=R.readRef(controller,'_battleContext');if(context.isNull())return;
  if(enabled===null){
   // Resolve only from the current battle. A previous battle's helper may
   // already have been collected when the UI host is stopped in the tavern.
   const helper=call('BattleContext','get_BattleOpponentAbilityInfoEnabledHelper',context);
   if(helper.isNull())return;
   enabled=R.unbox(call('BattleOpponentAbilityInfoEnabledController','IsEnabled',helper),'bool');
  }
  const view=call('BattleContext','get_BattleView',context);
  if(view.isNull())return;
  call('BattleBaseView','FilterOpponentAbilityDisplay',view,[A.value('bool',enabled)]);
 }
 function showEmptyPopup(view,unit,effects){
  const data=call('UnitListItemRendererData+Factory','Get',R.readRef(view,'_unitListItemRenderDataFactory'),[
   A.ref(call('BattleUnitController','get_UnitDO',unit)),A.ref(R.nil),A.value('i32',-1),A.value('bool',false),A.value('bool',false),A.value('i32',R.readValue(view,'_battleMode','i32'))]);
  const health=call('UnitHealthRenderDataFactory','Get',R.readRef(view,'_UnitHealthRenderDataFactory'),[A.ref(unit)],['IBattleUnit']);
  call('UnitListItemRendererData','set_HealthRenderData',data,[A.ref(health)]);
  call('UnitListItemRendererData','set_ShowHealthBar',data,[A.value('bool',true)]);
  const popup=R.readRef(view,'_effectDetailsPopup');
  call('BattleEffectsPopupView','Show',popup,[A.ref(unit),A.ref(data),A.ref(effects),A.ref(R.readRef(view,'_resourceLoader')),A.ref(R.readRef(view,'_localizationManager'))]);
  // Calls originating inside an interceptor may bypass nested interceptors.
  stats.shows++;render(popup,unit);
 }
 const ready=R.runOnMainThreadOnce(()=>{
  if(stopped)return {cancelled:true};
  hook('BattleOpponentAbilityInfoEnabledController','IsEnabled',0,{onLeave(result){if(!stopped){result.replace(1);stats.modeGateCalls++;}}});
  hook('BattleBaseView','FilterOpponentAbilityDisplay',1,{onEnter(args){if(!stopped)args[1]=ptr(1);}});
  hook('BattleBaseView','SetupOpponentAbilities',4,{
   onEnter(args){this.view=args[0];this.values=[args[1],args[2],args[3],args[4]];},
   onLeave(){if(stopped)return;safe(()=>{
    if(R.unbox(call('BattleBaseView','get_IsInOnboarding',this.view),'bool')){
     const c=R.readRef(this.view,'_opponentAbilitiesComponent');if(c.isNull())return;
     call('BattleAbilityComponent','SetupAbilities',c,[...this.values.map(A.ref),A.ref(R.nil),A.ref(R.readRef(this.view,'_keyboardBindingDomainController')),A.value('i32',0),A.value('i32',0)]);
     call('BattleAbilityComponent','ToggleAbilityButtonsVisible',c,[A.value('bool',true)]);stats.tutorialDisplays++;
    }
    call('BattleBaseView','FilterOpponentAbilityDisplay',this.view,[A.value('bool',true)]);
    const target=R.readRef(this.view,'_opponentTargetComponent'),item=targets.get(target.toString());
    if(item)layoutTarget(item);
   });}
  });
  hook('BattleBaseView','SetOpponentUnitData',1,{onEnter(args){this.view=args[0];this.unit=args[1];},onLeave(){if(!stopped)safe(()=>renderTarget(this.view,this.unit));}});
  hook('BattleTargetComponent','SetHealth',1,{onEnter(args){this.target=args[0];this.unit=args[1];},onLeave(){if(!stopped)safe(()=>{const item=targets.get(this.target.toString());if(item)updateTargetItem(item,this.unit);});}});
  hook('BattleEffectsPopupView','Show',5,{onEnter(args){this.popup=args[0];this.unit=args[1];},onLeave(){if(!stopped)safe(()=>{stats.shows++;render(this.popup,this.unit);});}});
  hook('BattleBaseView','HandleEffectsLongPressed',3,{onEnter(args){this.view=args[0];this.unit=args[1];this.effects=args[2];this.updateOnly=args[3].toInt32()!==0;this.before=stats.shows;},onLeave(){if(!stopped&&!this.updateOnly&&stats.shows===this.before)safe(()=>showEmptyPopup(this.view,this.unit,this.effects));}});
  hook('BattleEffectsPopupView','UpdateHealth',2,{onEnter(args){this.popup=args[0];this.unit=args[1];},onLeave(){if(!stopped)safe(()=>render(this.popup,this.unit));}});
  hook('BattleEffectsPopupView','Update',0,{onEnter(args){this.popup=args[0];},onLeave(){refreshPopupVisibility(this.popup);}});
  Interceptor.flush();
  safe(refreshOpponent);
  refreshTimer=setInterval(()=>{
   if(stopped||refreshPending)return;
   refreshPending=true;
   R.runOnMainThreadOnce(()=>{if(!stopped)safe(()=>measure('targetRefresh',refreshCurrentTarget));})
    .catch(e=>{if(!stopped)safe(()=>{throw e;});}).finally(()=>{refreshPending=false;});
  },300);
  stats.lifecycle='enabled';
  send({kind:'battle-info-installed',pid:Process.id,scope:'UI only',hooks:hooks.length});
  return {enabled:true,hooks:hooks.length};
 }).catch(error=>{
  stopped=true;stats.lifecycle='failed';
  if(refreshTimer!==null){clearInterval(refreshTimer);refreshTimer=null;}
  detachHooks();
  throw error;
 });
 ready.catch(error=>send({kind:'battle-info-error',error:String(error)}));
 globalThis.battleInfoStatus=()=>stats;
 globalThis.battleInfoRefreshPopup=(popup,unit)=>{if(!stopped)render(popup,unit);};
 globalThis.battleInfoTestPopup=showEmptyPopup;
 globalThis.battleInfoTestTarget=renderTarget;
 globalThis.stopBattleInfo=()=>{
  if(stopPromise)return stopPromise;
  stopped=true;stats.lifecycle='stopping';
  stopPromise=(async()=>{
  await ready.catch(()=>{});
  stats.lifecycle='stopping';
  const errorsBefore=stats.errorCount;
  if(refreshTimer!==null){clearInterval(refreshTimer);refreshTimer=null;}
  detachHooks();
  await R.runOnMainThreadOnce(()=>{
   const alive=new Set(S.all('BattleEffectsPopupView').map(p=>p.toString()));
   for(const item of popups.values())if(alive.has(item.popup.toString()))safe(()=>{
    destroyOwnedLabel(item.label);
    for(const row of item.rows.values()){
     setText(row.label,row.base);
     call('UILabel','set_overflowMethod',row.label,[A.value('i32',row.overflow)]);
     call('UILabel','set_maxLineCount',row.label,[A.value('i32',row.lines)]);
     if(!row.widget.isNull())call('UIWidget','set_height',row.widget,[A.value('i32',row.height)]);
    }
    call('UITable','Reposition',R.readRef(item.popup,'_effectsTable'));
    setVector(item.table,'localPosition',item.tablePosition);
   });
   const liveTargets=new Set(S.all('BattleTargetComponent').map(p=>p.toString()));
   for(const item of targets.values())if(liveTargets.has(item.target.toString()))safe(()=>destroyOwnedLabel(item.label));
   const liveShips=new Set(S.all('BattleShipView').map(p=>p.toString()));
   for(const item of shipTargets.values())if(liveShips.has(item.view.toString()))safe(()=>destroyOwnedLabel(item.label));
   popups.clear();targets.clear();shipTargets.clear();
   safe(()=>refreshOpponent(null));
  });
  stats.lifecycle=stats.errorCount===errorsBefore&&hooks.length===0?'stopped':'cleanup-failed';
  return stats;
  })().catch(error=>{stats.lifecycle='cleanup-failed';throw error;});
  return stopPromise;
 };
 rpc.exports={...rpc.exports,status:()=>stats,stop:()=>globalThis.stopBattleInfo()};
 const instance={ready,status:()=>stats,stop:globalThis.stopBattleInfo};
 globalThis.battleInfoInstance=instance;
 return instance;
};
if(!globalThis.deferBattleInfoInstallation)globalThis.installBattleInfo();
