'use strict';
// Observe original requests only. This does not advance or replace the FSM.
(()=>{
let activationSerial=0;
const session=Date.now().toString(36);
globalThis.installBattleEventsMod=(options={})=>{
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='capacity'))throw Error('Invalid event options');
 const capacity=options.capacity??256;
 if(!Number.isInteger(capacity)||capacity<16||capacity>4096)throw Error('Event capacity must be 16..4096');
 let lifecycle='enabling',listener=null,detached=false,sequence=0,errors=0,lastError=null;
 const ring=new Array(capacity);
 const generation=session+':'+(++activationSerial);
 const handle={
  status:()=>({lifecycle,generation,capacity,lastSequence:sequence,retained:Math.min(sequence,capacity),errors,lastError}),
  async stop(){
   if(lifecycle==='stopped')return {lifecycle};
   lifecycle='stopping';
   await handle.ready.catch(()=>{});
   try{
    if(listener&&!detached){listener.detach();detached=true;}
    Interceptor.flush();listener=null;ring.fill(undefined);lifecycle='stopped';return {lifecycle};
   }catch(error){lifecycle='cleanup-failed';throw error;}
  },
  command(name,payload={}){
   if(lifecycle!=='enabled')throw Error('Battle events are not enabled');
   if(name!=='read'||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>k!=='after'))throw Error('Expected read with optional after cursor');
   let after=0;
   if(payload.after!==undefined){
    const cursor=payload.after;
    if(!cursor||typeof cursor!=='object'||Array.isArray(cursor)||Object.keys(cursor).length!==2||cursor.generation!==generation)throw Error('Stale or invalid event cursor generation');
    after=cursor.sequence;
   }
   if(!Number.isSafeInteger(after)||after<0||after>sequence)throw Error('Invalid event cursor');
   const oldest=Math.max(1,sequence-capacity+1),events=[];
   for(let n=Math.max(after+1,oldest);n<=sequence;n++)events.push({...ring[(n-1)%capacity]});
   return {schemaVersion:1,events,next:{generation,sequence},lost:Math.max(0,oldest-after-1),errors,lastError};
  }
 };
 // Defer installation until the registry has retained this handle, including
 // attach/flush failures. Stop rejects delivery before attempting detach.
 handle.ready=Promise.resolve().then(()=>{
  if(lifecycle!=='enabling')return;
  const R=RuntimeApi;
  const method=R.findMethod(R.findClass('BattleFsmController'),'SetBattleState',1);
  listener=Interceptor.attach(method.readPointer(),{onEnter(args){
   if(lifecycle!=='enabled')return;
   try{
    const event={kind:'battle-state-requested',fsm:args[0].toString(),requestedState:args[1].toInt32(),
     turn:R.readValue(args[0],'<TurnCount>k__BackingField','i32'),at:Date.now()};
    event.sequence=++sequence;ring[(sequence-1)%capacity]=event;
   }catch(error){errors++;lastError=String(error);}
  }});
  Interceptor.flush();lifecycle='enabled';
 });
 handle.ready.catch(()=>{});
 return handle;
};
})();
