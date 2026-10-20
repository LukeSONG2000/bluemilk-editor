// Read original loading views without hiding them or advancing their lifecycle.
function originalTransitionTokens(){
 const R=RuntimeApi,c=R.findBound('NguiTransitionController'),list=R.readRef(c,'_activeTokens');
 const count=R.readValue(list,'_size','i32'),items=R.readRef(list,'_items');
 if(count<0||count>256||(!items.isNull()&&count>items.add(24).readU64().toNumber())||(count&&items.isNull()))throw Error('Transition token list bounds invalid');
 return {controller:c,tokens:Array.from({length:count},(_,i)=>items.add(32+i*8).readPointer())};
}
// Caller must validate the exact owned battle context (private trial or current result).
globalThis.releaseShutdownHomeTransitions=()=>{
 const R=RuntimeApi,S=SceneApi,T='NguiTransitionController+TransitionToken';
 const candidates=originalTransitionTokens().tokens;let released=0,retained=0;
 for(const token of candidates){
  if(!originalTransitionTokens().tokens.some(t=>t.equals(token)))continue;
  const requester=S.invoke(T,'get_Requester',token);
  if(requester.isNull()||R.fullName(R.classOf(requester))!=='HomeBaseController'||
     !R.unbox(S.invoke('FeatureController','get_WasShutdown',requester),'bool')||
     R.unbox(S.invoke('FeatureController','get_IsInitialized',requester),'bool')){retained++;continue;}
  S.invoke(T,'Release',token);released++;
 }
 return {transitionConfirmed:true,released,retained,profile:readLoadingProfile()};
};
globalThis.readLoadingProfile=()=>{
 const R=RuntimeApi,S=SceneApi,views=[],errors=[];
 for(const type of ['NguiLoadingView','NguiBusyWaitView','NguiFastTransitionView']){
  try{
   for(const view of S.all(type)){
    const row={type,path:null,active:null};views.push(row);
    try{
     row.path=S.path(S.transform(view));
     row.active=R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(view)),'bool');
    }catch(e){errors.push({type,error:String(e)});}
   }
  }catch(e){errors.push({type,error:String(e)});}
 }
 let controller=null;
 try{
  const original=originalTransitionTokens(),c=original.controller,tokens=[];
  for(const token of original.tokens){
   const requester=S.invoke('NguiTransitionController+TransitionToken','get_Requester',token);
   const requesterType=requester.isNull()?null:R.fullName(R.classOf(requester));
   tokens.push({type:R.unbox(S.invoke('NguiTransitionController+TransitionToken','get_Type',token),'i32'),requesterType,
    requesterShutdown:requesterType==='HomeBaseController'?R.unbox(S.invoke('FeatureController','get_WasShutdown',requester),'bool'):null,
    requesterInitialized:requesterType==='HomeBaseController'?R.unbox(S.invoke('FeatureController','get_IsInitialized',requester),'bool'):null});
  }
  controller={singularTransition:R.readValue(c,'_singularTransition','i32'),tokens};
 }catch(e){errors.push({type:'NguiTransitionController',error:String(e)});}
 return {readConfirmed:true,readOnly:true,views,controller,errors,
  scope:'Original view activation and token requester types; does not prove load completion.'};
};
