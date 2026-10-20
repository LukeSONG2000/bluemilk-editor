'use strict';
// Concatenate runtime_api.js, offline_socket_guard.js, original_fixture.js, then
// this file. Keep loaded until visual-probe-complete reports cleanup.
// Optional preceding globalThis.visualProbeOptions:
// {autoClick:true,maxDurationMs:35000,capturePath:'F:/.../frame.png',fixture:{seed:8}}
(async()=>{
 const R=RuntimeApi,A=R.arg,call=OriginalFixtureTools.call;
 const options=Object.assign({autoClick:true,autoAfterClick:false,maxDurationMs:35000,capturePath:null},globalThis.visualProbeOptions||{});
 if(typeof options.autoClick!=='boolean'||typeof options.autoAfterClick!=='boolean'||!Number.isFinite(options.maxDurationMs)||options.maxDurationMs<=0)throw Error('Invalid visual probe options');
 if(options.capturePath!==null&&typeof options.capturePath!=='string')throw Error('capturePath must be a string or null');
 const hooks=[],cleanup={home:false,exitedOwnedStates:0,guardRestored:false,gcReleased:false,errors:[]};
 let f=null,guard=null,entered=null,ownedCampaign=null,exitedOwnBattle=false,campaignExpected=false,foreignTransition=false,returningHome=false;
 let serviceCalls=0,last=-1,clicked=false,readyAt=0,error=null,lastSnapshot=null,terminalObserved=false;
 let enemyGate=null,heldToken=null,heldAt=0;
 const capture={path:options.capturePath,requested:false,verified:false,error:null,beforeStamp:null};
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const typename=object=>object&&!object.isNull()?R.fullName(R.classOf(object)):null;
 const current=()=>R.readRef(f?f.state:R.findBound('StateController'),'<CurrentState>k__BackingField');
 function managedType(name){return R.api('type_get_object','pointer',['pointer'])(R.api('class_get_type','pointer',['pointer'])(R.findClass(name)));}
 function enterType(name,data){return R.invoke(R.findMethod(R.classOf(f.state),'EnterState',3,['System.Type','IStateTransitionData','System.Boolean']),f.state,[A.ref(managedType(name)),A.ref(data||R.nil),A.value('bool',false)]);}
 function hook(type,name,count,handlers,types){const h=Interceptor.attach(R.findMethod(R.findClass(type),name,count,types).readPointer(),handlers);hooks.push(h);}
 function fileEvidence(path){
  if(!path)return null;
  const stat=new NativeFunction(Process.getModuleByName('kernel32.dll').getExportByName('GetFileAttributesExW'),'bool',['pointer','int','pointer']);
  const data=Memory.alloc(36);
  if(!stat(Memory.allocUtf16String(path),0,data))return null;
  const size=data.add(28).readU32()*4294967296+data.add(32).readU32();
  return {stamp:data.add(20).readU64().toString(),size};
 }
 function verifyCapture(){
  if(!capture.requested||capture.verified)return;
  try{
   const evidence=fileEvidence(capture.path);if(!evidence||evidence.size<24||evidence.stamp===capture.beforeStamp)return;
   if(evidence.size>256*1024*1024)return;
   const file=new File(capture.path,'rb');let bytes;try{bytes=new Uint8Array(file.readBytes(evidence.size));}finally{file.close();}
   const png=[137,80,78,71,13,10,26,10];
   if(bytes.length<24||png.some((v,i)=>bytes[i]!==v))return;
   if(bytes.length!==evidence.size)return;
   const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),width=view.getUint32(16),height=view.getUint32(20);
   if(!width||!height)return;
   // Validate complete PNG chunks and their CRCs, including terminal IEND.
   // A newly created header alone is not proof that CaptureScreenshot finished.
   let offset=8,hasData=false,ended=false;
   while(offset+12<=bytes.length){
    const length=view.getUint32(offset),end=offset+12+length;
    if(end>bytes.length)return;
    const type=String.fromCharCode(...bytes.slice(offset+4,offset+8));
    if(offset===8&&(type!=='IHDR'||length!==13))return;
    let crc=0xffffffff;
    for(let i=offset+4;i<offset+8+length;i++){
     crc^=bytes[i];for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
    }
    if(((crc^0xffffffff)>>>0)!==view.getUint32(offset+8+length))return;
    if(type==='IDAT')hasData=true;
    if(type==='IEND'){if(length!==0||end!==bytes.length)return;ended=true;break;}
    offset=end;
   }
   if(!ended||!hasData)return;
   Object.assign(capture,{verified:true,width,height,bytes:evidence.size,lastWriteStamp:evidence.stamp});
  }catch(exception){capture.error=String(exception);}
 }
 try{
  await R.runOnMainThreadOnce(()=>{
   if(globalThis.readLoadingProfile)send({kind:'trial-loading-profile',phase:'before-entry',profile:readLoadingProfile()});
   guard=installOfflineSocketGuard(); // covers fixture, entry, polling and exit
   f=createOriginalFixture(Object.assign({},options.fixture||{},{flags:6}));send(originalFixtureDiagnostics(f));
   if(options.aiPriorityOrder)globalThis.trialAIPriority=installOriginalAIPriority(f.context,options.aiPriorityOrder);
   if(options.traceAI)globalThis.trialAITrace=installOriginalAITrace(f.context,{experimentalPrediction:options.experimentalPrediction===true});
   if(options.enemyBasicDemo||options.enemyControl)enemyGate=installEnemyInputGate(f.context,null,{manualUI:options.enemyManualUI===true});
   const loop=R.newObject(R.findClass('UnityGameLoop'));
   const injector=R.readRef(R.nil,'_instance',R.findClass('Injector'));
   R.invoke(R.findMethod(R.findClass('Injector'),'Inject',1),injector,[A.ref(loop)]);
   call(f.context,'set_GameLoop',[A.ref(loop)]);call(f.context,'set_TimeScaleManager',[A.ref(loop)]);
   for(const name of ['SendBattleStartRequest','SendBattleFinishRequest'])hook('BattleService',name,6,{onEnter(){serviceCalls++;}});
   const ownedFsm=call(f.context,'get_BattleFsmController');
   hook('BattleFsmController','SetBattleState',1,{onEnter(args){
    if(args[0].equals(ownedFsm)&&args[1].toInt32()===136){
     terminalObserved=true;
     send({kind:'original-visual-terminal-transition',state:136,source:'original SetBattleState'});
    }
   }});
   // Capture ownership even if EnterState throws after SC_Enter began.
   hook('BattleGameState','SC_Enter',2,{onEnter(args){if(args[1].equals(f.data))entered=args[0];}});
   hook('BattleGameState','SC_Exit',2,{onEnter(args){if(entered&&args[0].equals(entered))exitedOwnBattle=true;}});
   // Generic EnterState<T> may bypass the non-generic overload. Observe the
   // destination's actual lifecycle too, only after our original FSM terminates.
   hook('CampaignGameState','SC_Enter',2,{onEnter(args){
    if(entered&&terminalObserved&&!foreignTransition){campaignExpected=true;ownedCampaign=args[0];}
   }});
   hook('StateController','EnterState',3,{
    onEnter(args){
     this.campaign=false;if(!args[0].equals(f.state))return;
     const name=R.fullName(R.api('class_from_system_type','pointer',['pointer'])(args[1]));
     if(name==='BattleGameState'&&args[2].equals(f.data))return;
     const active=current();
     const ownsActiveBattle=entered&&!active.isNull()&&active.equals(entered);
     // EnterState's hook runs before that call exits the preceding state.
     // Accept only a return that originates in our exact battle, or follows
     // its observed exit without an intervening foreign transition.
     if(name==='CampaignGameState'&&(ownsActiveBattle||exitedOwnBattle)&&!foreignTransition){campaignExpected=true;this.campaign=true;return;}
     if(returningHome&&name==='HomeBaseGameState')return;
     foreignTransition=true;ownedCampaign=null;campaignExpected=false;
    },
    onLeave(result){if(this.campaign&&!result.isNull())ownedCampaign=result;}
   },['System.Type','IStateTransitionData','System.Boolean']);
   const result=enterType('BattleGameState',f.data);if(!result.isNull())entered=result;
   globalThis.visualProbe={fixture:f,entered,enemyGate:options.enemyControl?enemyGate:null};
  });
  const deadline=Date.now()+options.maxDurationMs;
  while(Date.now()<deadline){
   if(globalThis.visualProbe?.stopRequested)break;
   let shouldStop=false;
   await R.runOnMainThreadOnce(()=>{
    if(enemyGate&&!enemyGate.tickPolicy()){
     const snapshot=enemyGate.snapshot();
     if(snapshot.pending){
      if(heldToken!==snapshot.token){heldToken=snapshot.token;heldAt=Date.now();send({kind:'enemy-held-start',snapshot});}
      else if(options.enemyBasicDemo&&Date.now()-heldAt>=2200){
       send({kind:'enemy-held-end',snapshot,elapsed:Date.now()-heldAt});
       const result=enemyGate.chooseBasic(snapshot.token);
       send({kind:'enemy-manual-input',result});
       if(!result.started)send({kind:'enemy-basic-demo-original-fallback',result:enemyGate.resume(result.token)});
      }
      else if(options.enemyControl&&Date.now()>=snapshot.expiresAt){
       send({kind:'enemy-input-timeout',snapshot,result:enemyGate.resume(snapshot.token)});
      }
     }
    }
    const state=current(),name=typename(state);
    if(name==='CampaignGameState'&&campaignExpected&&!foreignTransition&&!ownedCampaign)ownedCampaign=state;
    if(foreignTransition){shouldStop=true;return;}
    const fsm=call(f.context,'get_BattleFsmController');
    const previous=R.readValue(fsm,'_previousNonIdleState','i32'),next=R.readValue(fsm,'_nextState','i32');
    terminalObserved=terminalObserved||(previous===136&&next===0);
    lastSnapshot={previous,next,turns:R.readValue(fsm,'<TurnCount>k__BackingField','i32'),currentState:name};
    if(previous!==last){last=previous;send(Object.assign({kind:'original-visual-progress'},lastSnapshot));}
    if(previous===34&&!readyAt){
     readyAt=Date.now();
     // EnterState can finish asynchronously. Wait for the exact owned battle's
     // input-ready phase before releasing requests from shut-down Home objects.
     if(entered&&state.equals(entered)&&globalThis.releaseShutdownHomeTransitions)
      send({kind:'trial-stale-home-transitions',result:releaseShutdownHomeTransitions()});
    }
    if(previous===34&&options.capturePath&&!capture.requested){
     capture.beforeStamp=(fileEvidence(options.capturePath)||{}).stamp||null;
     capture.requested=true;
     try{R.invoke(R.findMethod(R.findClass('UnityEngine.ScreenCapture'),'CaptureScreenshot',2,['System.String','System.Int32']),R.nil,
       [A.ref(R.string(options.capturePath)),A.value('i32',1)]);
      send({kind:'original-frame-capture-requested',path:options.capturePath,verified:false});
     }catch(exception){capture.error=String(exception);}
    }
    const currentUnit=call(f.context,'get_CurrentUnit');
    const playerAwaiting=previous===34&&next===1&&!currentUnit.isNull()&&R.unbox(call(currentUnit,'get_Owner'),'i32')===0;
    if(playerAwaiting&&globalThis.visualProbe?.pendingAutoMode!==undefined){
     const mode=globalThis.visualProbe.pendingAutoMode;
     const auto=R.readRef(f.context,'<BattleAutoController>k__BackingField');
     if(R.readValue(auto,'<CurrentAutoStatus>k__BackingField','i32')!==mode)call(auto,'SetMode',[A.value('i32',mode)]);
     delete globalThis.visualProbe.pendingAutoMode;
     send({kind:'deferred-player-auto-applied',mode});return;
    }
    if(options.autoClick&&!globalThis.visualProbe?.disableInitialAuto&&playerAwaiting&&readyAt&&Date.now()-readyAt>2000&&!clicked){
     const table=R.readRef(call(f.context,'get_BattleView'),'_playerAbilitiesComponent');
     const buttons=R.readRef(table,'_abilityButtons'),basic=call(table,'get_BasicAttackButton');
     const items=R.readRef(buttons,'_items'),n=R.readValue(buttons,'_size','i32');let index=-1;
     if(n<0||items.isNull()||n>items.add(24).readU64().toNumber())throw Error('Original ability list bounds invalid');
     for(let i=0;i<n;i++)if(items.add(32+8*i).readPointer().equals(basic)){index=i;break;}
     if(index<0)throw Error('Original basic attack button not found');
     call(table,'HandleAbilityButtonClicked',[A.value('i32',index),A.ref(buttons)]);clicked=true;
     send({kind:'original-ui-basic-clicked',index});
     if(options.autoAfterClick){
      const auto=R.readRef(f.context,'<BattleAutoController>k__BackingField');
      if(R.readValue(auto,'<CurrentAutoStatus>k__BackingField','i32')===0)
       call(auto,'SetMode',[A.value('i32',1)]);
      send({kind:'original-trial-auto-selected'});
     }
    }
    if(ownedCampaign&&state.equals(ownedCampaign))shouldStop=true;
   });
   verifyCapture();
   if(shouldStop)break;
   await wait(200);
  }
 }catch(exception){error=String(exception);send({kind:'original-visual-error',error,stack:exception.stack||null});}
 finally{
  try{globalThis.FrameProfile?.finish();}
  catch(exception){cleanup.errors.push('frame profile cleanup: '+String(exception));}
  // The normal captured-trial path owns the same information display as the
  // live host. Restore labels/gates while the owned battle is still valid.
  try{if(typeof globalThis.stopBattleInfo==='function'){
   const status=await globalThis.stopBattleInfo();
   send({kind:'trial-hud-cleanup',status});
   if(status.errors?.length)cleanup.errors.push('HUD reported errors during trial');
  }}catch(exception){cleanup.errors.push('HUD cleanup: '+String(exception));}
  try{
   // Only leave our exact BattleGameState or its tracked original Campaign
   // return. A user/other system's state transition is never overwritten.
   const deadline=Date.now()+10000;
   while(Date.now()<deadline&&!cleanup.home){
    let stop=false;
    await R.runOnMainThreadOnce(()=>{
     const state=current(),name=typename(state);
     if(name==='HomeBaseGameState'){cleanup.home=true;return;}
     if(!f){stop=true;return;}
     if(name==='CampaignGameState'&&campaignExpected&&!foreignTransition&&!ownedCampaign)ownedCampaign=state;
     const owned=!foreignTransition&&((entered&&state.equals(entered))||(ownedCampaign&&state.equals(ownedCampaign)));
     if(owned){
      // Original EnterState creates the non-null ExitState completion delegate
      // and enters Home only after the previous scene unload finishes.
      if(!returningHome){returningHome=true;enterType('HomeBaseGameState',R.nil);cleanup.exitedOwnedStates++;}
     }
     else if(!state.isNull()){cleanup.errors.push('Unowned current state left untouched: '+name);stop=true;return;}
     const after=current();
     if(after.isNull()&&!foreignTransition&&!returningHome){returningHome=true;enterType('HomeBaseGameState',R.nil);}
     cleanup.home=typename(current())==='HomeBaseGameState';
    });
    if(stop||cleanup.home)break;
    await wait(100);
   }
   if(!cleanup.home)cleanup.errors.push('Home restoration not confirmed; GC handles retained');
  }catch(exception){cleanup.errors.push('state cleanup: '+String(exception));}
  finally{
   try{if(enemyGate){
    enemyGate.stop();send({kind:'enemy-gate-complete',events:enemyGate.events,errors:enemyGate.errors,watchdogDeferrals:enemyGate.watchdogDeferrals});
    if(enemyGate.errors.length)error=error||'Enemy input gate reported errors';
   }}
   catch(exception){cleanup.errors.push('enemy gate cleanup: '+String(exception));}
   try{if(globalThis.trialAIPriority){
    trialAIPriority.stop();const priority=trialAIPriority.snapshot();send(priority);
    if(priority.errors.length||!priority.originalUnchanged)error=error||'AI priority scope/integrity check failed';
   }}
   catch(exception){cleanup.errors.push('AI priority cleanup: '+String(exception));}
   try{if(globalThis.trialAITrace){trialAITrace.stop();send(trialAITrace.snapshot());}}
   catch(exception){cleanup.errors.push('AI trace cleanup: '+String(exception));}
   for(const listener of hooks)try{listener.detach();}catch(exception){cleanup.errors.push('detach: '+String(exception));}
   try{if(guard){guard.restore();cleanup.guardRestored=true;}}catch(exception){cleanup.errors.push('guard restore: '+String(exception));}
   // No release while a live original state may still depend on fixture objects.
   if(cleanup.home)try{
    await R.runOnMainThreadOnce(()=>{if(f?.restoreDefinitions){f.restoreDefinitions();cleanup.definitionsRestored=true;}});
    if(globalThis.readLoadingProfile)await R.runOnMainThreadOnce(()=>send({kind:'trial-loading-profile',phase:'after-home',profile:readLoadingProfile()}));
    R.releaseAll();cleanup.gcReleased=true;
   }catch(exception){cleanup.errors.push('definitions/GC release: '+String(exception));}
   verifyCapture();
   const verifiedVisualBattle=!error&&readyAt!==0&&clicked&&terminalObserved&&serviceCalls===0&&cleanup.home&&cleanup.guardRestored&&cleanup.errors.length===0;
   send({kind:'visual-probe-complete',verifiedVisualBattle,error,clicked,terminalObserved,lastSnapshot,serviceCalls,
    blockedSocketCalls:guard?guard.counts:null,socketDiagnostics:guard?guard.diagnostics():null,capture,cleanup,
    originalUiObserved:readyAt!==0,screenshotVerified:capture.verified,
    ownership:{exitedOwnBattle,campaignExpected,foreignTransition}});
  }
 }
})().catch(error=>send({kind:'original-visual-outer-error',error:String(error)}));
