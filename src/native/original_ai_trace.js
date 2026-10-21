'use strict';
// Passive by default. Explicit owned-trial experimentalPrediction also invokes
// the original evaluator on private infrastructure; never roll back live RNG.
// Snapshot the original graph without evaluating conditions or advancing RNG.
globalThis.readOriginalAIRandomState=context=>{
 const result={};
 for(const name of ['BattleRandom','PlayerAbilitySelectionRandom','OpponentAbilitySelectionRandom','PlayerTargetRandom','OpponentTargetRandom']){
  const random=RuntimeApi.readRef(context,'<'+name+'>k__BackingField');
  result[name]=random.isNull()?null:String(RuntimeApi.readValue(random,'_seed','i64'));
 }
 return result;
};

globalThis.copyOriginalAIRandomStreams=context=>{
 const R=RuntimeApi,S=SceneApi,handles=[],streams={},copies=new Map();let disposed=false;
 const names=['BattleRandom','PlayerAbilitySelectionRandom','OpponentAbilitySelectionRandom','PlayerTargetRandom','OpponentTargetRandom'];
 function dispose(){if(disposed)return;disposed=true;for(const handle of handles)R.release(handle);}
 function requireOpen(){if(disposed)throw Error('Random copy already disposed');}
 try{
  for(const name of names){
   const source=R.readRef(context,'<'+name+'>k__BackingField');
   if(source.isNull()||R.fullName(R.classOf(source))!=='JavaRandom')throw Error('Original JavaRandom stream required: '+name);
   let copy=copies.get(source.toString());
   if(!copy){
    copy=S.invoke('System.Object','MemberwiseClone',source);
    if(copy.isNull()||copy.equals(source)||R.fullName(R.classOf(copy))!=='JavaRandom')throw Error('Independent JavaRandom copy required');
    handles.push(R.retain(copy));
    if(String(R.readValue(copy,'_seed','i64'))!==String(R.readValue(source,'_seed','i64')))throw Error('Copied random seed changed');
    copies.set(source.toString(),copy);
   }
   streams[name]=copy;
  }
 }catch(error){dispose();throw error;}
 return {dispose,state(){requireOpen();return Object.fromEntries(names.map(n=>[n,String(R.readValue(streams[n],'_seed','i64'))]));},
  stream(name){requireOpen();if(!Object.hasOwn(streams,name))throw Error('Invalid private random stream');return streams[name];},
  nextInt(name,bound){requireOpen();if(!Object.hasOwn(streams,name)||!Number.isInteger(bound)||bound<1||bound>2147483647)throw Error('Invalid private random draw');return R.unbox(S.invoke('JavaRandom','nextInt',streams[name],[R.arg.value('i32',bound)]),'i32');}};
};

globalThis.verifyOriginalAIRandomCopies=context=>{
 const before=readOriginalAIRandomState(context);let a,b;
 try{
  a=copyOriginalAIRandomStreams(context);b=copyOriginalAIRandomStreams(context);
  const rows=Object.keys(before).map(name=>{
   const first=[1,7,100,2147483647].map(bound=>a.nextInt(name,bound));
   const second=[1,7,100,2147483647].map(bound=>b.nextInt(name,bound));
   return {name,first,second,equal:JSON.stringify(first)===JSON.stringify(second)};
  });
  const after=readOriginalAIRandomState(context);
  const unchanged=JSON.stringify(before)===JSON.stringify(after);
  if(!unchanged||rows.some(r=>!r.equal))throw Error('Private random copy verification failed');
  return {before,after,originalUnchanged:unchanged,rows,scope:'Private RNG copies only; not an isolated AI evaluator'};
 }finally{a?.dispose();b?.dispose();}
};
// Build a fresh pool with the original closed generic type and constructor.
// A shallow clone would share its mutable queue with the running battle.
globalThis.createOriginalAITargetPool=context=>{
 const R=RuntimeApi,source=R.readRef(context,'BattleUnitControllerListPool');
 if(source.isNull())throw Error('Original target pool absent');
 const klass=R.classOf(source),capacity=R.readValue(source,'_initialInstanceCapacity','i32');
 if(!Number.isInteger(capacity)||capacity<0||capacity>4096)throw Error('Unexpected target pool capacity');
 const pool=R.api('object_new','pointer',['pointer'])(klass);
 if(pool.isNull()||pool.equals(source))throw Error('Independent target pool required');
 const handle=R.retain(pool),borrowed=new Map();let disposed=false;
 const call=(p,n,args=[])=>R.invoke(R.findMethod(R.classOf(p),n,args.length),p,args);
 try{
  call(pool,'.ctor',[R.arg.value('i32',0),R.arg.value('i32',capacity)]);
  const queue=R.readRef(pool,'_pool');
  if(queue.isNull()||queue.equals(R.readRef(source,'_pool')))throw Error('Target pool queue is shared');
 }catch(e){R.release(handle);throw e;}
 function requireOpen(){if(disposed)throw Error('Target pool disposed');}
 function giveBack(list){
  requireOpen();if(!borrowed.has(list.toString()))throw Error('List not borrowed from this pool');
  call(list,'Dispose');borrowed.delete(list.toString());
 }
 return {pool,capacity,
  borrow(){requireOpen();const list=call(pool,'GetInstance');
   if(list.isNull()||!R.readRef(list,'Pool').equals(pool)||borrowed.has(list.toString()))throw Error('Private pooled list ownership mismatch');
   borrowed.set(list.toString(),list);return list;},
  giveBack,
  dispose(){if(disposed)return;try{for(const list of [...borrowed.values()])giveBack(list);}finally{disposed=true;R.release(handle);}}
 };
};
globalThis.verifyOriginalAITargetPool=context=>{
 const R=RuntimeApi,source=R.readRef(context,'BattleUnitControllerListPool');
 function sourceState(){const queue=R.readRef(source,'_pool');return {
  queue:queue.toString(),array:R.readRef(queue,'_array').toString(),
  size:R.readValue(queue,'_size','i32'),version:R.readValue(queue,'_version','i32'),
  head:R.readValue(queue,'_head','i32'),tail:R.readValue(queue,'_tail','i32')};}
 const before=sourceState();let privatePool;
 try{
  privatePool=createOriginalAITargetPool(context);
  const a=privatePool.borrow(),b=privatePool.borrow();
  if(a.equals(b))throw Error('Simultaneously borrowed lists alias');
  privatePool.giveBack(a);privatePool.giveBack(b);
  const reused=privatePool.borrow();
  const reuseConfirmed=reused.equals(a)||reused.equals(b);
  const empty=R.readValue(reused,'_size','i32')===0;
  privatePool.giveBack(reused);
  const after=sourceState(),originalUnchanged=JSON.stringify(before)===JSON.stringify(after);
  if(!originalUnchanged||!reuseConfirmed||!empty)throw Error('Private target pool verification failed');
  return {originalUnchanged,reuseConfirmed,empty,capacity:privatePool.capacity,scope:'Original private pool borrow/return only; not AI prediction'};
 }finally{privatePool?.dispose();}
};
// Infrastructure only: units, stat calculators, most game data and other context
// services remain shared. Do not evaluate this controller until audited.
globalThis.createOriginalAIInfrastructure=sourceController=>{
 const R=RuntimeApi,S=SceneApi,handles=[];let random,pool,graph,disposed=false;
 const source=R.readRef(sourceController,'_battleContext');
 const sourceEvaluator=R.readRef(sourceController,'_targetingRuleEvaluator');
 if(source.isNull()||sourceEvaluator.isNull()||!R.readRef(sourceEvaluator,'_battleContext').equals(source))throw Error('AI evaluator/context identity mismatch');
 const sourceData=R.readRef(source,'<GameDataDomainController>k__BackingField');
 if(sourceData.isNull()||!R.readRef(sourceController,'_gameDataDC').equals(sourceData))throw Error('AI game-data identity mismatch');
 function clone(p){const q=S.invoke('System.Object','MemberwiseClone',p);
  if(q.isNull()||q.equals(p)||!R.classOf(q).equals(R.classOf(p)))throw Error('Independent same-type clone required');
  handles.push(R.retain(q));return q;}
 function dispose(){if(disposed)return;disposed=true;
  try{pool?.dispose();}finally{try{random?.dispose();}finally{try{graph?.dispose();}finally{for(const h of handles)R.release(h);}}}}
 try{
  const context=clone(source),controller=clone(sourceController),evaluator=clone(sourceEvaluator);
  random=copyOriginalAIRandomStreams(source);pool=createOriginalAITargetPool(source);
  const gameData=clone(sourceData);graph=copyOriginalAIDecisionGraph(R.readRef(sourceData,'_abilityDecisionTreeDO'));
  R.writeRef(gameData,'_abilityDecisionTreeDO',graph.tree);
  R.writeRef(context,'<GameDataDomainController>k__BackingField',gameData);
  R.writeRef(controller,'_gameDataDC',gameData);
  for(const name of Object.keys(random.state()))R.writeRef(context,'<'+name+'>k__BackingField',random.stream(name));
  R.writeRef(context,'BattleUnitControllerListPool',pool.pool);
  R.writeRef(evaluator,'_battleContext',context);
  R.writeRef(controller,'_battleContext',context);
  R.writeRef(controller,'_targetingRuleEvaluator',evaluator);
  return {context,controller,evaluator,gameData,graph,random,pool,dispose,readyForEvaluation:false};
 }catch(e){dispose();throw e;}
};
globalThis.verifyOriginalAIInfrastructure=sourceController=>{
 const R=RuntimeApi,source=R.readRef(sourceController,'_battleContext');
 const evaluator=R.readRef(sourceController,'_targetingRuleEvaluator');
 const sourceData=R.readRef(source,'<GameDataDomainController>k__BackingField'),sourceTree=R.readRef(sourceData,'_abilityDecisionTreeDO');
 const pool=R.readRef(source,'BattleUnitControllerListPool'),before=readOriginalAIRandomState(source);
 const names=Object.keys(before),originalStreams=names.map(n=>R.readRef(source,'<'+n+'>k__BackingField'));
 let copy;
 try{
  copy=createOriginalAIInfrastructure(sourceController);
  const privateBindings=R.readRef(copy.controller,'_battleContext').equals(copy.context)&&
   R.readRef(copy.controller,'_targetingRuleEvaluator').equals(copy.evaluator)&&
   R.readRef(copy.evaluator,'_battleContext').equals(copy.context)&&
   !copy.gameData.equals(sourceData)&&!copy.graph.tree.equals(sourceTree)&&
   R.readRef(copy.context,'<GameDataDomainController>k__BackingField').equals(copy.gameData)&&
   R.readRef(copy.controller,'_gameDataDC').equals(copy.gameData)&&
   R.readRef(copy.gameData,'_abilityDecisionTreeDO').equals(copy.graph.tree)&&
   R.readRef(copy.context,'BattleUnitControllerListPool').equals(copy.pool.pool)&&
   names.every((n,i)=>!R.readRef(copy.context,'<'+n+'>k__BackingField').equals(originalStreams[i]));
  for(const n of names)copy.random.nextInt(n,100);
  const list=copy.pool.borrow();copy.pool.giveBack(list);
  const originalUnchanged=JSON.stringify(before)===JSON.stringify(readOriginalAIRandomState(source))&&
   R.readRef(sourceController,'_battleContext').equals(source)&&
   R.readRef(sourceController,'_targetingRuleEvaluator').equals(evaluator)&&
   R.readRef(evaluator,'_battleContext').equals(source)&&
   R.readRef(source,'<GameDataDomainController>k__BackingField').equals(sourceData)&&
   R.readRef(sourceController,'_gameDataDC').equals(sourceData)&&R.readRef(sourceData,'_abilityDecisionTreeDO').equals(sourceTree)&&
   R.readRef(source,'BattleUnitControllerListPool').equals(pool)&&
   names.every((n,i)=>R.readRef(source,'<'+n+'>k__BackingField').equals(originalStreams[i]));
  if(!privateBindings||!originalUnchanged)throw Error('Private AI infrastructure verification failed');
  return {privateBindings,originalUnchanged,privateGraphRouting:true,readyForEvaluation:false,scope:'Private context/RNG/pool/evaluator/game-data graph route; remaining services shared; no AI evaluation'};
 }finally{copy?.dispose();}
};
// Preserve graph topology and original lazy parameter caches without evaluating
// any node. Parameter strings/arrays remain shared and are read-only here.
globalThis.copyOriginalAIDecisionGraph=source=>{
 const R=RuntimeApi,S=SceneApi,handles=[],nodes=new Map(),results=new Map();let disposed=false;
 function dispose(){if(disposed)return;disposed=true;for(const h of handles)R.release(h);}
 function clone(p){const q=S.invoke('System.Object','MemberwiseClone',p);
  if(q.isNull()||q.equals(p))throw Error('Independent graph clone required');handles.push(R.retain(q));return q;}
 function branch(p){if(p.isNull())return p;const key=p.toString();if(results.has(key))return results.get(key);
  if(results.size>=1024)throw Error('Original AI graph exceeds 1024 results');
  const q=clone(p);results.set(key,q);R.writeRef(q,'_nextNode',node(R.readRef(p,'_nextNode')));return q;}
 function node(p){if(p.isNull())return p;const key=p.toString();if(nodes.has(key))return nodes.get(key);
  if(nodes.size>=512)throw Error('Original AI graph exceeds 512 nodes');
  const q=clone(p);nodes.set(key,q);
  for(const f of ['<SuccessResult>k__BackingField','<FailureResult>k__BackingField'])R.writeRef(q,f,branch(R.readRef(p,f)));
  return q;}
 try{if(source.isNull())throw Error('Original AI tree absent');const tree=clone(source);R.writeRef(tree,'_rootNode',node(R.readRef(source,'_rootNode')));
  return {tree,nodeCount:nodes.size,resultCount:results.size,dispose};
 }catch(e){dispose();throw e;}
};
globalThis.verifyOriginalAIDecisionGraph=source=>{
 const before=JSON.stringify(readOriginalAITree(source).graph);let copy;
 try{copy=copyOriginalAIDecisionGraph(source);
  const identical=JSON.stringify(readOriginalAITree(copy.tree).graph)===before;
  const originalUnchanged=JSON.stringify(readOriginalAITree(source).graph)===before;
  if(!identical||!originalUnchanged)throw Error('Private graph differs from original');
  return {identical,originalUnchanged,nodes:copy.nodeCount,results:copy.resultCount,scope:'Topology and values copied; no node evaluation'};
 }finally{copy?.dispose();}
};
// Container isolation only; unit and AbilityContext elements remain shared.
globalThis.copyOriginalAIInputs=source=>{
 const R=RuntimeApi,S=SceneApi,handles=[],lists=new Map(),arrays=new Map();let disposed=false;
 function dispose(){if(disposed)return;disposed=true;for(const h of handles)R.release(h);}
 function clone(p,array=false){const q=S.invoke(array?'System.Array':'System.Object',array?'Clone':'MemberwiseClone',p);
  if(q.isNull()||q.equals(p))throw Error('Independent input container required');handles.push(R.retain(q));return q;}
 try{
  if(source.isNull()||R.fullName(R.classOf(source))!=='BattleAbilityAIContext')throw Error('Original AI input context required');
  const context=clone(source);
  for(const f of ['EnemyTargetOptions','Enemies','Allies','SpecialAbilities']){
   const p=R.readRef(source,f);if(p.isNull())continue;
   let q=lists.get(p.toString());
   if(!q){
    const size=R.readValue(p,'_size','i32');if(size<0||size>512)throw Error('AI input list exceeds bounds');
    q=clone(p);lists.set(p.toString(),q);
    const items=R.readRef(p,'_items');if(items.isNull())throw Error('AI input list backing array absent');
    let privateItems=arrays.get(items.toString());
    if(!privateItems){privateItems=clone(items,true);arrays.set(items.toString(),privateItems);}
    R.writeRef(q,'_items',privateItems);
   }
   R.writeRef(context,f,q);
  }
  return {context,dispose,listCount:lists.size,arrayCount:arrays.size,readyForEvaluation:false};
 }catch(e){dispose();throw e;}
};
globalThis.verifyOriginalAIInputs=source=>{
 const R=RuntimeApi,S=SceneApi,fields=['EnemyTargetOptions','Enemies','Allies','SpecialAbilities'];
 function snapshot(p){return fields.map(f=>{const list=R.readRef(p,f);if(list.isNull())return {field:f,null:true};
  return {field:f,size:R.readValue(list,'_size','i32'),version:R.readValue(list,'_version','i32'),items:S.array(R.readRef(list,'_items')).map(x=>x.toString())};});}
 const before=snapshot(source);let copy;
 try{copy=copyOriginalAIInputs(source);
  const contentsEqual=JSON.stringify(snapshot(copy.context))===JSON.stringify(before);
  const independent=fields.every(f=>{const a=R.readRef(source,f),b=R.readRef(copy.context,f);return a.isNull()?b.isNull():!a.equals(b)&&!R.readRef(a,'_items').equals(R.readRef(b,'_items'));});
  const originalUnchanged=JSON.stringify(before)===JSON.stringify(snapshot(source));
  if(!contentsEqual||!independent||!originalUnchanged)throw Error('AI input copy verification failed');
  return {contentsEqual,independent,originalUnchanged,lists:copy.listCount,arrays:copy.arrayCount,scope:'Lists and arrays independent; elements shared; no evaluation'};
 }finally{copy?.dispose();}
};
globalThis.readOriginalAITree=tree=>{
 const R=RuntimeApi,S=SceneApi,indices=new Map(),nodes=[];
 const ref=(p,f)=>R.readRef(p,f),value=(p,f,t)=>R.readValue(p,f,t);
 function branch(result){
  if(result.isNull())return null;
  return {next:visit(ref(result,'_nextNode')),abilityTag:S.string(ref(result,'_choosenAbilityTag')),
   target:value(result,'_resultTarget','i32'),selectBasic:value(result,'<SelectBasic>k__BackingField','bool')};
 }
 function visit(node){
  if(node.isNull())return null;
  const key=node.toString();if(indices.has(key))return indices.get(key);
  if(nodes.length>=512)throw Error('Original AI graph exceeds 512 nodes');
  const index=nodes.length;indices.set(key,index);nodes.push(null);
  const parameters=S.array(ref(node,'_params'));
  if(parameters.length>64)throw Error('Original AI node exceeds 64 parameters');
  nodes[index]={index,type:value(node,'_decisionType','i32'),target:value(node,'_decisionTarget','i32'),
   excludeSelf:value(node,'_decisionTargetExcludeSelf','bool'),parameters:parameters.map(p=>S.string(p)),
   modifier:value(node,'_paramModifier','i32'),chance:value(node,'<Chance>k__BackingField','f32'),
   negate:value(node,'<Negate>k__BackingField','bool'),
   success:branch(ref(node,'<SuccessResult>k__BackingField')),failure:branch(ref(node,'<FailureResult>k__BackingField'))};
  return index;
 }
 if(tree.isNull())throw Error('Original AI tree absent');
 const root=visit(ref(tree,'_rootNode'));
 return {graph:{id:S.string(ref(tree,'_id')),evaluateBasic:value(tree,'<ShouldEvaluateBasicAbility>k__BackingField','bool'),root,nodes},
  indexOf:node=>indices.get(node.toString())??null};
};

globalThis.installOriginalAITrace=(context,options={})=>{
 const decisionLimit=128;
 const R=RuntimeApi,S=SceneApi,A=R.arg,rows=[],errors=[],hooks=[],active=new Map(),trees=new Map();let serial=0,dropped=0,stopped=false;
 const predictions=[];let predictionFailed=false;
 let randomCopyAudit=null,targetPoolAudit=null,infrastructureAudit=null,graphCopyAudit=null,inputCopyAudit=null,auditAttempted=false;
 const ref=(p,f)=>R.readRef(p,f),text=p=>S.string(p);
 const owns=p=>!p.isNull()&&ref(p,'_battleContext').equals(context);
 const call=(p,n,args=[])=>R.invoke(R.findMethod(R.classOf(p),n,args.length),p,args);
 function unit(p){if(p.isNull())return null;const u=ref(p,'_unitDO');return {baseId:text(ref(ref(u,'<Definition>k__BackingField'),'BaseId')),owner:R.unbox(call(p,'get_Owner'),'i32')};}
 function targets(p){if(p.isNull())return [];const n=R.readValue(p,'_size','i32'),items=ref(p,'_items');if(n<0||n>64)throw Error('AI target list bounds');return Array.from({length:n},(_,i)=>unit(items.add(32+i*8).readPointer()));}
 function resultView(value){if(value.isNull())return null;const ability=ref(value,'Ability');return {abilityId:ability.isNull()?null:text(call(ref(ability,'<AbilityDO>k__BackingField'),'get_Id')),enemyTargets:targets(ref(value,'EnemyTargets')),allyTargets:targets(ref(value,'AllyTargets'))};}
 function resultIdentity(value){if(value.isNull())return null;const result={ability:ref(value,'Ability').toString()};
  for(const f of ['EnemyTargets','AllyTargets']){const list=ref(value,f);if(list.isNull()){result[f]=[];continue;}const size=R.readValue(list,'_size','i32');if(size<0||size>64)throw Error('Prediction target bounds');const items=ref(list,'_items');result[f]=Array.from({length:size},(_,i)=>items.add(32+i*8).readPointer().toString());}return result;}
 function predict(controller,input,sequence){
  const record={sequence,actor:unit(ref(input,'Self')),scope:'Experimental immediate AI-entry prediction; shared units and stat scratch',matched:null};predictions.push(record);
  let infrastructure,inputs,value,handle,disposeMethod;
  const before=readOriginalAIRandomState(context),started=Date.now();
  try{
   const resultClass=R.findClass('BattleAbilityAIResult');
   try{disposeMethod=R.findMethod(resultClass,'System.IDisposable.Dispose',0);}catch(e){disposeMethod=R.findMethod(resultClass,'Dispose',0);}
   infrastructure=createOriginalAIInfrastructure(controller);inputs=copyOriginalAIInputs(input);
   value=R.invoke(R.findMethod(R.classOf(infrastructure.controller),'GetAbilityAIResult',1,['BattleAbilityAIContext']),infrastructure.controller,[A.ref(inputs.context)]);
   if(!value.isNull())handle=R.retain(value);
   record.result=resultView(value);record.identity=resultIdentity(value);
   record.privateRandomAfter=readOriginalAIRandomState(infrastructure.context);
  }catch(e){predictionFailed=true;record.error=String(e);}
  finally{
   try{if(value&&!value.isNull())R.invoke(disposeMethod,value,[]);}catch(e){predictionFailed=true;record.cleanupError=String(e);}
   finally{if(handle)R.release(handle);try{inputs?.dispose();}finally{infrastructure?.dispose();}}
   record.originalRandomUnchanged=JSON.stringify(before)===JSON.stringify(readOriginalAIRandomState(context));
   record.elapsedMs=Date.now()-started;
   if(!record.originalRandomUnchanged)predictionFailed=true;
  }
  return record;
 }
 function inspect(fn){try{return fn();}catch(e){if(errors.length<10)errors.push(String(e));return null;}}
 const handle={status:()=>({stopped,pendingHooks:hooks.length}),predictionStatus(owner){
  if(stopped||options.experimentalPrediction!==true||!owner.equals(context))return null;
  return {experimental:true,timing:'immediately before original AI evaluator',scope:'Recent prediction verification history; not a future-turn forecast or final target selection',failed:predictionFailed,total:predictions.length,
   decisionLimit,observedDecisions:rows.length,unpredictedDecisions:rows.length-predictions.length,droppedDecisions:dropped,
   history:predictions.slice(-16).map(p=>({sequence:p.sequence,actor:p.actor,result:p.result,matched:p.matched,originalRandomUnchanged:p.originalRandomUnchanged,randomAfterMatched:p.randomAfterMatched,elapsedMs:p.elapsedMs,error:p.error||p.cleanupError||null}))};
 },snapshot:()=>({kind:'original-ai-trace',scope:'observed original decisions; optional experimental immediate-entry prediction',decisionLimit,rows,trees:Array.from(trees.values(),record=>record.graph),errors,dropped,randomCopyAudit,targetPoolAudit,infrastructureAudit,graphCopyAudit,inputCopyAudit,predictions,predictionFailed}),stop(){stopped=true;active.clear();while(hooks.length){hooks.at(-1).detach();hooks.pop();}}};
 function hook(name,count,types,handlers){
  // A callback already queued before detach must not start another audit/read.
  const guarded=Object.fromEntries(Object.entries(handlers).map(([key,fn])=>[key,function(...args){if(!stopped)return fn.apply(this,args);} ]));
  try{hooks.push(Interceptor.attach(R.findMethod(R.findClass('BattleAbilityAIController'),name,count,types).readPointer(),guarded));}
  catch(cause){
   const error=new Error('AI trace hook installation failed: '+String(cause),{cause});
   try{handle.stop();}catch(cleanupError){error.cleanupHandle=handle;error.cleanupError=String(cleanupError);}
   throw error;
  }
 }
 hook('GetAbilityAIResult',1,['BattleAbilityAIContext'],{
  onEnter(args){inspect(()=>{
   if(!owns(args[0]))return;
   if(rows.length>=decisionLimit){dropped++;return;}
   this.thread=Process.getCurrentThreadId();this.previous=active.get(this.thread);
   this.row={sequence:++serial,actor:unit(ref(args[1],'Self')),chance:R.readValue(args[1],'Chance','i32'),nodes:[],results:[]};
   this.row.randomBefore=readOriginalAIRandomState(context);
   // Streams are initialized by original battle entry, not fixture allocation.
   // Audit at the first real evaluator entry, before its original body runs.
   if(!auditAttempted){auditAttempted=true;randomCopyAudit=inspect(()=>verifyOriginalAIRandomCopies(context));targetPoolAudit=inspect(()=>verifyOriginalAITargetPool(context));infrastructureAudit=inspect(()=>verifyOriginalAIInfrastructure(args[0]));inputCopyAudit=inspect(()=>verifyOriginalAIInputs(args[1]));}
   active.set(this.thread,this.row);rows.push(this.row);
   // Native 16A2EC0 reads context.GameDataDomainController._abilityDecisionTreeDO
   // directly, bypassing the GetAbilityDecisionTree call site.
   const tree=globalThis.trialAIPriority?.treeFor(this.row.actor.owner)||ref(ref(context,'<GameDataDomainController>k__BackingField'),'_abilityDecisionTreeDO');
   if(graphCopyAudit===null)graphCopyAudit=inspect(()=>verifyOriginalAIDecisionGraph(tree))||{failed:true};
   const key=tree.toString();
   if(!trees.has(key)){
    if(trees.size>=16)throw Error('Too many original AI trees');
    trees.set(key,readOriginalAITree(tree));
   }
   const record=trees.get(key);this.row.treeId=record.graph.id;this.row.treeGraph=Array.from(trees.keys()).indexOf(key);
   this.row.evaluateBasic=record.graph.evaluateBasic;
   if(options.experimentalPrediction===true&&!predictionFailed)this.prediction=predict(args[0],args[1],this.row.sequence);

  });},
  onLeave(value){if(!this.row)return;inspect(()=>{
   this.row.randomAfter=readOriginalAIRandomState(context);
   this.row.randomChanged=Object.keys(this.row.randomBefore).filter(k=>this.row.randomBefore[k]!==this.row.randomAfter[k]);
   this.row.result=resultView(value);
   if(this.prediction&&!this.prediction.error){this.prediction.matched=JSON.stringify(this.prediction.identity)===JSON.stringify(resultIdentity(value));this.prediction.randomAfterMatched=JSON.stringify(this.prediction.privateRandomAfter)===JSON.stringify(this.row.randomAfter);if(!this.prediction.matched||!this.prediction.randomAfterMatched)predictionFailed=true;}
  });if(this.previous)active.set(this.thread,this.previous);else active.delete(this.thread);}
 });
 hook('GetAbilityDecisionTree',1,['BattleAbilityAIContext'],{
  onEnter(args){inspect(()=>{this.row=owns(args[0])?active.get(Process.getCurrentThreadId()):null;});},
  onLeave(value){if(this.row&&!value.isNull())inspect(()=>{this.row.treeId=text(ref(value,'_id'));this.row.evaluateBasic=R.readValue(value,'<ShouldEvaluateBasicAbility>k__BackingField','bool');});}
 });
 hook('GetAbilityAIResult',2,['AbilityDecisionNodeDO','BattleAbilityAIContext'],{
  onEnter(args){inspect(()=>{
   if(!owns(args[0]))return;const row=active.get(Process.getCurrentThreadId());if(!row||row.nodes.length>=128||args[1].isNull())return;
   const node=args[1],record=Array.from(trees.values())[row.treeGraph];row.nodes.push({nodeIndex:record?.indexOf(node)??null,type:R.readValue(node,'_decisionType','i32'),target:R.readValue(node,'_decisionTarget','i32'),parameters:S.array(ref(node,'_params')).map(text),modifier:R.readValue(node,'_paramModifier','i32'),chance:R.readValue(node,'<Chance>k__BackingField','f32'),negate:R.readValue(node,'<Negate>k__BackingField','bool')});
  });}
 });
 hook('ProcessResult',4,['AbilityDecisionResult','System.Collections.Generic.List<BattleUnitController>','BattleAbilityAIContext','BattlePreferredTargetsParams'],{
  onEnter(args){inspect(()=>{
   if(!owns(args[0]))return;const row=active.get(Process.getCurrentThreadId());if(!row||row.results.length>=128||args[1].isNull())return;
   row.results.push({abilityTag:text(ref(args[1],'_choosenAbilityTag')),selectBasic:R.readValue(args[1],'<SelectBasic>k__BackingField','bool'),target:R.readValue(args[1],'_resultTarget','i32')});
  });}
 });
 return handle;
};
