'use strict';
// Reorder copies of original conditions/results; never write the shared tree.
globalThis.installOriginalAIPriority=(context,order)=>{
 const R=RuntimeApi,A=R.arg;
 const ref=(p,f)=>R.readRef(p,f),value=(p,f,t)=>R.readValue(p,f,t);
 const source=ref(ref(context,'<GameDataDomainController>k__BackingField'),'_abilityDecisionTreeDO');
 const before=readOriginalAITree(source).graph,count=before.nodes.length;
 if(!count||!Array.isArray(order)||order.length!==count||new Set(order).size!==count||order.some(n=>!Number.isInteger(n)||n<0||n>=count))throw Error('AI priority must be a complete original node permutation');
 let cursor=before.root;const originalOrder=[];
 while(cursor!==null){
  if(originalOrder.includes(cursor))throw Error('AI priority requires an acyclic failure chain');
  const n=before.nodes[cursor];
  if(!n||!n.success||n.success.next!==null||!n.failure)throw Error('AI priority requires original leaf-success/failure-chain topology');
  if(n.failure.next!==null&&(n.failure.abilityTag||n.failure.selectBasic||n.failure.target!==0))throw Error('AI priority requires neutral continuation results');
  originalOrder.push(cursor);cursor=n.failure.next;
 }
 if(originalOrder.length!==count)throw Error('AI priority chain must cover every original node');
 const originals=[];let p=ref(source,'_rootNode');
 for(const index of originalOrder){originals[index]=p;p=ref(ref(p,'<FailureResult>k__BackingField'),'_nextNode');}
 const nodeClass=R.findClass('AbilityDecisionNodeDO'),resultClass=R.findClass('AbilityDecisionResult');
 const nodeCtor=R.findMethod(nodeClass,'.ctor',8),resultCtor=R.findMethod(resultClass,'.ctor',1,['AbilityDecisionNodeDO']);
 function copyResult(original,next){
  const result=R.newObject(resultClass,resultCtor,[A.ref(next)]);
  R.writeRef(result,'_choosenAbilityTag',ref(original,'_choosenAbilityTag'));
  R.writeValue(result,'_resultTarget','i32',value(original,'_resultTarget','i32'));
  R.writeValue(result,'<SelectBasic>k__BackingField','bool',value(original,'<SelectBasic>k__BackingField','bool'));
  return result;
 }
 const nodes=originals.map(n=>{
  const clone=R.newObject(nodeClass,nodeCtor,[A.value('i32',value(n,'_decisionType','i32')),A.value('i32',value(n,'_decisionTarget','i32')),
   A.ref(ref(n,'_params')),A.value('i32',value(n,'_paramModifier','i32')),A.value('bool',value(n,'_decisionTargetExcludeSelf','bool')),
   A.value('f32',value(n,'<Chance>k__BackingField','f32')),A.value('bool',value(n,'<Negate>k__BackingField','bool')),A.ref(R.nil)]);
  // Preserve each node's caches, but isolate future native cache writes.
  for(const [field,type] of [['_paramAsFloatCached','bool'],['_paramAsFloat','f32'],['_paramAsIntCached','bool'],['_paramAsInt','i32']])R.writeValue(clone,field,type,value(n,field,type));
  R.writeRef(clone,'<SuccessResult>k__BackingField',copyResult(ref(n,'<SuccessResult>k__BackingField'),R.nil));
  return clone;
 });
 const terminal=ref(originals[originalOrder.at(-1)],'<FailureResult>k__BackingField');
 order.forEach((index,i)=>{
  const originalFailure=i===count-1?terminal:ref(originals[originalOrder[i]],'<FailureResult>k__BackingField');
  R.writeRef(nodes[index],'<FailureResult>k__BackingField',copyResult(originalFailure,i+1<count?nodes[order[i+1]]:R.nil));
 });
 const treeClass=R.findClass('AbilityDecisionTreeDO');
 const tree=R.newObject(treeClass,R.findMethod(treeClass,'.ctor',3),[A.ref(ref(source,'_id')),A.ref(nodes[order[0]]),A.value('bool',before.evaluateBasic)]);
 const originalRoot=ref(source,'_rootNode'),privateRoot=ref(tree,'_rootNode');
 let stopped=false,detached=false,substitutions=0;const errors=[];
 const hook=Interceptor.attach(R.findMethod(R.findClass('BattleAbilityAIController'),'GetAbilityAIResult',2,['AbilityDecisionNodeDO','BattleAbilityAIContext']).readPointer(),{
  onEnter(args){try{
   if(stopped||!ref(args[0],'_battleContext').equals(context)||!args[1].equals(originalRoot))return;
   const self=ref(args[2],'Self');
   const owner=R.unbox(R.invoke(R.findMethod(R.classOf(self),'get_Owner',0),self,[]),'i32');
   if(owner!==1)return;
   args[1]=privateRoot;substitutions++;
  }catch(e){if(errors.length<10)errors.push(String(e));}}
 });
 return {treeFor:owner=>owner===1?tree:source,
  snapshot:()=>({kind:'original-ai-priority',scope:'owned enemy original evaluator with private reordered chain',order,originalOrder,substitutions,errors,
   originalUnchanged:JSON.stringify(readOriginalAITree(source).graph)===JSON.stringify(before),graph:readOriginalAITree(tree).graph}),
  // Disable substitutions immediately, but retain the hook until detach succeeds.
  // A failed detach must remain retryable by the owning trial's cleanup loop.
  stop(){if(detached)return;stopped=true;hook.detach();detached=true;}};
};
