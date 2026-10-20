'use strict';
// Original calendar UI only. Catch-up/purchase routes are deliberately excluded.
globalThis.CalendarBridge=(()=>{
 const R=RuntimeApi,S=SceneApi,A=R.arg,records=[];
 const call=(o,n,args=[])=>R.invoke(R.findMethod(R.classOf(o),n,args.length),o,args);
 const active=o=>!o.isNull()&&!!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(o)),'bool');
 function list(o){if(o.isNull())return [];const n=R.readValue(o,'_size','i32'),a=R.readRef(o,'_items');if(n<0||n>4096||(a.isNull()?n!==0:n>a.add(24).readU64().toNumber()))throw Error('Calendar list bounds');return Array.from({length:n},(_,i)=>a.add(32+8*i).readPointer());}
 function controller(){return R.findBound('CalendarController');}
 function live(){const c=controller(),v=R.readRef(c,'_calendarView');if(!R.readValue(c,'_showing','bool')||!active(v)||R.readValue(c,'_showingInfo','bool')||R.readValue(c,'_bulkClaiming','bool'))throw Error('Calendar view unavailable or busy');return {c,v};}
 function daily(c,id){return call(R.readRef(c,'_playerDC'),'GetDailyLoginWithId',[A.ref(R.string(id))]);}
 function row(c,d){
  const id=S.string(R.readRef(d,'Id')),index=R.readValue(d,'CurrentRewardIndex','i32'),source=daily(c,id);
  const rewards=source.isNull()?[]:list(call(source,'get_DailyReward'));
  const reward=index>=0&&index<rewards.length?rewards[index]:null;
  return {id,rewardIndex:index,title:S.string(R.readRef(d,'DailyLoginTitle')),claimed:!!R.readValue(d,'RewardClaimed','bool'),sourceClaimed:source.isNull()?null:!!R.unbox(call(source,'get_Claimed'),'bool'),lastClaimed:source.isNull()?null:String(R.unbox(call(source,'get_LastClaimed'),'i64')),rewards:reward?[{id:S.string(call(reward,'get_ID')),itemType:R.unbox(call(reward,'get_ItemType'),'u8'),quantity:R.unbox(call(reward,'get_Quantity'),'i32')}]:[]};
 }
 function status(){
  const {c,v}=live(),selected=call(v,'get_ActiveRenderData'),rows=list(R.readRef(v,'_calendarList'));
  if(selected.isNull()||!rows.some(d=>d.equals(selected)))throw Error('Calendar selection ownership mismatch');
  const button=R.readRef(v,'_claimButton'),target=R.readRef(button,'_buttonTarget');
  return {readConfirmed:true,calendars:rows.map(d=>({...row(c,d),selected:d.equals(selected)})),selected:row(c,selected),claimEnabled:active(button)&&!target.isNull()&&!!R.unbox(S.invoke('UIButton','get_isEnabled',target),'bool'),catchUpRoute:!!R.readValue(v,'_catchUpIsFree','bool')};
 }
 function claimStatus(){
  const pending=records.filter(r=>!r.rewardBalanceReconciled);
  if(pending.length){
   // Original bulk claims may credit the same currency/material once for several
   // calendars. Reconcile the entire pending cohort, never each receipt against
   // the combined delta (which could also misidentify a partial settlement).
   const after=InboxClaimTracker.readBalances(pending.flatMap(r=>r.rewards));
   const key=r=>JSON.stringify([r.itemType,r.id]),baselines=new Map();
   let consistent=true;
   for(const r of pending){
    if(!r.before.length)consistent=false;
    for(const b of r.before){
     if(!Number.isSafeInteger(b.value))consistent=false;
     if(baselines.has(key(b))&&baselines.get(key(b))!==b.value)consistent=false;
     baselines.set(key(b),b.value);
    }
   }
   const comparison=after.map(a=>({id:a.id,itemType:a.itemType,before:baselines.get(key(a))??null,after:a.value,expected:a.expected}));
   const exact=consistent&&comparison.length>0&&comparison.length===baselines.size&&comparison.every(c=>Number.isSafeInteger(c.before)&&Number.isSafeInteger(c.after)&&Number.isSafeInteger(c.expected)&&c.expected>0&&c.after-c.before===c.expected);
   const members=pending.map(r=>({calendarId:r.calendarId,rewardIndex:r.rewardIndex,lastClaimed:r.lastClaimed}));
   for(const r of pending)Object.assign(r,{after:after.filter(a=>r.before.some(b=>key(a)===key(b))),batchBalanceComparison:comparison,batchMembers:members,baselineConsistent:consistent,rewardBalanceReconciled:exact,settlementEvidence:exact?(pending.length>1?'native-inventory-batch-delta':'native-inventory-delta'):'unconfirmed'});
  }
  return {readConfirmed:true,claims:records.map(r=>({...r}))};
 }
 function execute(op,p={}){
  if(op==='calendar-claim-status')return claimStatus();
  if(op==='calendar-list')return status();
  if(op==='calendar-open'){
   const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
   if(R.fullName(R.classOf(state))!=='HomeBaseGameState')throw Error('Open calendar from Home');
   const c=controller(),v=R.readRef(c,'_calendarView');
   if(active(v))return {navigationDispatched:false,alreadyVisible:true};
   if(R.readValue(c,'_showing','bool'))throw Error('Calendar opening is already pending; inspect calendar-visibility, do not reopen');
   S.invoke('CalendarController','ShowCalendar',c,[A.ref(R.nil)],['NguiView']);
   return {navigationDispatched:true,visibilityConfirmed:false};
  }
  const {c,v}=live();
  if(op==='calendar-close'){call(v,'OnBackClick');return {navigationDispatched:true};}
  if(op==='calendar-select'){
   if(typeof p.calendarId!=='string'||!p.calendarId.length||p.calendarId.length>256)throw Error('Explicit calendarId required');
   const rows=list(R.readRef(v,'_calendarList'));
   const matches=rows.map((data,index)=>({data,index})).filter(r=>S.string(R.readRef(r.data,'Id'))===p.calendarId);
   if(matches.length!==1)throw Error('Calendar ID missing or ambiguous in current list');
   const selected=call(v,'get_ActiveRenderData');
   if(!rows.some(r=>r.equals(selected)))throw Error('Calendar selection ownership mismatch');
   const unchanged=matches[0].data.equals(selected);
   if(!unchanged)call(v,'ShowCalendar',[A.value('i32',matches[0].index)]);
   return {navigationDispatched:!unchanged,alreadySelected:unchanged,expectedCalendarId:p.calendarId};
  }
  const info=status();
  if(typeof p.calendarId!=='string'||p.calendarId!==info.selected.id||!Number.isInteger(p.rewardIndex)||p.rewardIndex!==info.selected.rewardIndex||p.lastClaimed!==info.selected.lastClaimed)throw Error('Calendar reward identity changed');
  if(op!=='calendar-claim')throw Error('Unsupported calendar operation');
  const selected=info.selected;
  if(!info.claimEnabled||info.catchUpRoute||selected.claimed||selected.sourceClaimed!==false||!selected.rewards.length)throw Error('Original free daily claim unavailable');
  if(records.some(r=>r.calendarId===p.calendarId&&r.rewardIndex===p.rewardIndex&&r.lastClaimed===p.lastClaimed))throw Error('Already submitted; inspect status, do not retry');
  const r={calendarId:p.calendarId,rewardIndex:p.rewardIndex,lastClaimed:p.lastClaimed,rewards:selected.rewards,before:InboxClaimTracker.readBalances(selected.rewards),claimDispatched:false};
  records.push(r); // Retain uncertain submissions, even when native invocation throws.
  call(v,'ClaimButtonClicked');r.claimDispatched=true;
  return {claimDispatched:true,receipt:{...r},settlementConfirmed:false,note:'Original calendar may defer settlement until close; read calendar-claim-status after closing.'};
 }
 function visibility(){
  const c=controller(),showing=!!R.readValue(c,'_showing','bool'),visible=active(R.readRef(c,'_calendarView'));
  const showingInfo=!!R.readValue(c,'_showingInfo','bool'),bulkClaiming=!!R.readValue(c,'_bulkClaiming','bool');
  return {showing,active:visible,showingInfo,bulkClaiming,openingPending:showing&&!visible,readable:showing&&visible&&!showingInfo&&!bulkClaiming};
 }
 return {execute,status,visibility};
})();
rpc.exports.calendarcommand=(op,payload)=>RuntimeApi.runOnMainThreadOnce(()=>CalendarBridge.execute(op,payload));
rpc.exports.calendarvisibility=()=>RuntimeApi.runOnMainThreadOnce(()=>CalendarBridge.visibility());
