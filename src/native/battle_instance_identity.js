'use strict';
// Session-local identity from observed original state entry/exit, never mission or address alone.
globalThis.BattleInstanceIdentity=(()=>{
 const R=RuntimeApi,epoch=Process.id+':'+Date.now()+':'+Math.random().toString(36).slice(2);
 let serial=0,current=null,stopped=false;
 const hooks=[];
 try{
  hooks.push(Interceptor.attach(R.findMethod(R.findClass('BattleGameState'),'SC_Enter',2).readPointer(),{
   onEnter(args){if(!stopped)current={state:args[0].toString(),key:'battle:'+epoch+':'+(++serial),context:null,exited:false};}
  }));
  hooks.push(Interceptor.attach(R.findMethod(R.findClass('BattleGameState'),'SC_Exit',2).readPointer(),{
   onEnter(args){if(current?.state===args[0].toString())current.exited=true;}
  }));
 }catch(error){for(const hook of hooks)hook.detach();throw error;}
 return {
  read(state,context){
   if(stopped||!current||current.exited||current.state!==state.toString()||context.isNull())return null;
   const key=context.toString();
   if(current.context!==null&&current.context!==key)return null;
   current.context=key;return current.key;
  },
  stop(){stopped=true;for(const hook of hooks)hook.detach();current=null;return {stopped:true};}
 };
})();
rpc.exports.battleidentitystop=()=>BattleInstanceIdentity.stop();
