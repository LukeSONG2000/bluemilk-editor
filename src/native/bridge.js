'use strict';
// Observation and explicit next-match control. Never navigates or starts a fight.
let desktopArena=null;
const arenaSnapshot=()=>desktopArena?desktopArena.snapshot():null;
rpc.exports={
 ...rpc.exports,
 battleinspect(request){return RuntimeApi.runOnMainThreadOnce(()=>BattleInputBridge.inspectUnit(request));},
 enemystatus(){return RuntimeApi.runOnMainThreadOnce(()=>arenaSnapshot());},
 enemyinput(operation,request){return RuntimeApi.runOnMainThreadOnce(()=>{
  if(!['ability','basic','target','unit','cancel','resume','button','tap'].includes(operation))throw Error('Unknown enemy operation');
  if(!desktopArena)throw Error('No owned enemy controller; arm the next battle first');
  if(!request||typeof request.token!=='string'||!request.token)throw Error('Current enemy input token required');
  // Original gate owns context/turn/candidate/readiness and duplicate checks.
  return desktopArena.input(operation,request);
 });},
 async inspect(options){
  if(options&&Object.keys(options).some(k=>k!=='detailScope'))throw Error('Unknown snapshot option');
  const detailScope=options?.detailScope??'selected';
  if(!['selected','all'].includes(detailScope))throw Error('Invalid snapshot detail scope');
  const snapshot=await readRuntimeSnapshot({detailScope});
  const arena=await RuntimeApi.runOnMainThreadOnce(()=>arenaSnapshot());
  let roster=[],arenaReady=false;
  if(snapshot.state==='PvpPreBattleState'){
   const selection=await RuntimeApi.runOnMainThreadOnce(()=>{
   const R=RuntimeApi,S=SceneApi;
   const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
   const loading={roster:[],ready:false};
   if(state.isNull()||R.fullName(R.classOf(state))!=='PvpPreBattleState')return loading;
   const controller=R.readRef(state,'_featureController');
   if(controller.isNull())return loading;
   const squad=R.readRef(controller,'_currentSquad'),saved=R.readRef(controller,'_savedTransitionData');
   if(squad.isNull()||saved.isNull())return loading;
   const cells=R.readRef(squad,'_squadCells');if(cells.isNull())return loading;
   const items=R.readRef(cells,'_items');if(items.isNull())return loading;
   const roster=S.array(items).slice(0,R.readValue(cells,'_size','i32')).flatMap(c=>{
    if(c.isNull())return [];
    const u=R.readRef(c,'Unit');if(u.isNull())return [];
    const definition=R.readRef(u,'<Definition>k__BackingField');if(definition.isNull())return [];
    return [{unitId:S.string(R.readRef(u,'Id')),baseId:S.string(R.readRef(definition,'BaseId')),owner:0}];
   });
   return {roster,ready:roster.length>0};
   });roster=selection.roster;arenaReady=selection.ready;
  }
  return {...snapshot,arena,roster,arenaReady};
 },
 arm(request){return RuntimeApi.runOnMainThreadOnce(()=>{
  const R=RuntimeApi;
  if(request?.manualUI!==undefined&&typeof request.manualUI!=='boolean')throw Error('无效手动控制选项');
  if(request?.manualUI&&(request.enabled||request.oneClickTaunt||request.allowedTargets?.length))throw Error('手动操作与策略控制不能同时启用');
  const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
  if(state.isNull())throw Error('游戏页面仍在加载');
  if(desktopArena?.status().armed)throw Error('本场已启用；请使用应用配置');
  if(request?.scope==='all'){
   if(R.fullName(R.classOf(state))==='BattleGameState')throw Error('请在进入战斗前启用下一场控制');
   if(![0,1].includes(request.combatType))throw Error('请选择下一场的小队或舰队类型');
   desktopArena?.stop();
   desktopArena=installLiveBattleControl({battleType:'all',combatType:request.combatType,manualUI:request.manualUI===true,own:handle=>{desktopArena=handle;}},request);
   return desktopArena.snapshot();
  }
  if(request?.scope!==undefined&&request.scope!=='arena')throw Error('未知控制范围');
  if(R.fullName(R.classOf(state))!=='PvpPreBattleState')throw Error('请先进入小队或舰队竞技场的阵容选择页');
  const controller=R.readRef(state,'_featureController');
  if(controller.isNull())throw Error('阵容页面仍在加载，请稍候再启用');
  const saved=R.readRef(controller,'_savedTransitionData');
  if(saved.isNull())throw Error('阵容页面仍在加载，请稍候再启用');
  const type=R.readValue(saved,'<CombatType>k__BackingField','u8');
  desktopArena=installLiveArenaTaunt(type,request,{manualUI:request.manualUI===true,own:handle=>{desktopArena=handle;}});return desktopArena.snapshot();
 });},
 configure(request){return RuntimeApi.runOnMainThreadOnce(()=>{
  if(!desktopArena)throw Error('请先启用本场控制');
  if(desktopArena.status().manualUI&&(request.enabled||request.oneClickTaunt||request.allowedTargets?.length))throw Error('本场为手动操作，请解除后再配置下一场策略');
  return desktopArena.configure(request);
 });},
 disarm(){return RuntimeApi.runOnMainThreadOnce(()=>{if(desktopArena)desktopArena.stop();return arenaSnapshot();});},
 async shutdown(){
  if(globalThis.BlueMilkMods)await BlueMilkMods.shutdown();
  await RuntimeApi.runOnMainThreadOnce(()=>{if(desktopArena)desktopArena.stop();});
  return {stopped:true};
 }
};

// SDK adapter owns the existing one-match controller; enabling adds no hooks.
const originalControl={arm:rpc.exports.arm,configure:rpc.exports.configure,
 disarm:rpc.exports.disarm,status:rpc.exports.enemystatus,input:rpc.exports.enemyinput};
let controlOwner=null;
globalThis.installBattleControlMod=modId=>{
 if(controlOwner)throw Error('Another Mod owns battle control');
 let lifecycle='enabled';
 const handle={modId,ready:Promise.resolve(),
  status:()=>({lifecycle,armed:desktopArena?.status().armed===true}),
  async stop(){
   if(lifecycle==='stopped')return {lifecycle};
   lifecycle='stopping';
   try{
    await originalControl.disarm();
    desktopArena=null;controlOwner=null;lifecycle='stopped';return {lifecycle};
   }catch(error){lifecycle='cleanup-failed';throw error;}
  },
  async command(name,payload){
   if(controlOwner!==handle||lifecycle!=='enabled')throw Error('Battle control owner is not enabled');
   if(name==='enemy-input'){
    if(Object.keys(payload).sort().join(',')!=='operation,request')throw Error('Enemy input requires operation and request');
    return originalControl.input(payload.operation,payload.request);
   }
   if(!['arm','configure','disarm','status'].includes(name))throw Error('Unknown battle control command');
   if(['disarm','status'].includes(name)&&Object.keys(payload).length)throw Error('This command takes no payload');
   return originalControl[name](payload);
  }
 };
 controlOwner=handle;return handle;
};
rpc.exports={...rpc.exports,
 async arm(request){
  // Existing explicit arm entry points still work through the packaged Mod.
  if(!controlOwner)await BlueMilkMods.command('enable',{id:'bluemilk.battle-control'});
  return BlueMilkMods.invoke(controlOwner.modId,'arm',request);
 },
 configure:request=>BlueMilkMods.invoke(controlOwner?.modId,'configure',request),
 disarm:()=>controlOwner?BlueMilkMods.invoke(controlOwner.modId,'disarm',{}):originalControl.disarm(),
 enemyinput:(operation,request)=>BlueMilkMods.invoke(controlOwner?.modId,'enemy-input',{operation,request})
};

// Prepared trial owns guard/GC lifetime; stop the resource handle directly here
// so engine cleanup never re-enters a registry operation awaiting that engine.
globalThis.stopPreparedBattleControl=()=>controlOwner?controlOwner.stop():Promise.resolve({lifecycle:"stopped"});
