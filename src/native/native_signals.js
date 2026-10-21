'use strict';
// Generic in-process notifications. Subscribers are owned by Mod lifecycles.
globalThis.NativeSignals=(()=>{
 const listeners=new Map();
 return {
  on(name,callback){
   if(typeof name!=='string'||typeof callback!=='function')throw Error('Signal name and callback required');
   const set=listeners.get(name)||new Set();listeners.set(name,set);set.add(callback);
   return ()=>{set.delete(callback);if(!set.size)listeners.delete(name);};
  },
  emit(name,payload){for(const callback of [...(listeners.get(name)||[])])try{callback(payload);}catch(error){send({kind:'native-signal-error',name,error:String(error)});}}
 };
})();
