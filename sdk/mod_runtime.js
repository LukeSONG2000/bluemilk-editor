'use strict';
// Shared lifecycle contract. In-process modules are trusted code, not a sandbox.
globalThis.BlueMilkMods=(()=>{
 const records=new Map();let busy=false,closing=false,invocation=null;const idleWaiters=[];
 function release(){busy=false;for(const resolve of idleWaiters.splice(0))resolve();}
 const validId=x=>typeof x==='string'&&x.length<=128&&/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(x);
 const validVersion=x=>typeof x==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(x)&&x.split('.').every(n=>Number.isSafeInteger(Number(n)));
 const view=r=>({manifest:JSON.parse(JSON.stringify(r.manifest)),state:r.state,error:r.error,packageSha256:r.packageSha256??null,
  runtime:r.instance?.status()??null});
 function register(manifest,factory){
  if(busy||closing)throw Error('Another Mod lifecycle operation is in progress');
  if(!manifest||!validId(manifest.id)||records.has(manifest.id))throw Error('Invalid or duplicate Mod ID');
  if(!validVersion(manifest.version))throw Error('Invalid Mod version; require major.minor.patch');
  for(const key of ['name','publisher'])
   if(typeof manifest[key]!=='string'||!manifest[key].trim()||manifest[key].length>256)throw Error('Invalid Mod '+key);
  if(manifest.sdkVersion!==1||manifest.gameProfile!=='swgoh-0.40.7')throw Error('Unsupported Mod SDK or game profile');
  for(const key of ['capabilities','presentations','conflicts','dependencies'])
   if(!Array.isArray(manifest[key])||manifest[key].some(x=>typeof x!=='string')||new Set(manifest[key]).size!==manifest[key].length)throw Error('Invalid Mod '+key);
  if(!manifest.presentations.length||manifest.presentations.some(x=>!['desktop','cli'].includes(x)))throw Error('Invalid presentation support');
  for(const key of ['dependencies','conflicts'])
   if(manifest[key].some(id=>!validId(id)||id===manifest.id))throw Error('Invalid Mod '+key);
  if(manifest.dependencies.some(id=>manifest.conflicts.includes(id)))throw Error('Mod dependency also declared as conflict');
  const versions=manifest.dependencyVersions===undefined?{}:manifest.dependencyVersions;
  if(!versions||typeof versions!=='object'||Array.isArray(versions)||
   Object.entries(versions).some(([id,version])=>!manifest.dependencies.includes(id)||!validVersion(version)))throw Error('Invalid dependencyVersions; require exact versions of declared dependencies');
  // Check the prospective graph before mutating registration, including forward references.
  const graph=new Map([...records].map(([id,r])=>[id,r.manifest.dependencies]));
  graph.set(manifest.id,manifest.dependencies);
  const visiting=new Set(),visited=new Set();
  function visit(id){
   if(visiting.has(id))throw Error('Cyclic Mod dependencies');
   if(visited.has(id))return;
   visiting.add(id);for(const next of graph.get(id)??[])visit(next);
   visiting.delete(id);visited.add(id);
  }
  for(const id of graph.keys())visit(id);
  if(typeof factory!=='function')throw Error('Mod factory required');
  records.set(manifest.id,{manifest:JSON.parse(JSON.stringify(manifest)),factory,instance:null,state:'disabled',error:null});
 }
 function registerPackage(manifest,source,sha256,configuration={}){
  if(busy||closing)throw Error('Another Mod lifecycle operation is in progress');
  if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||typeof source!=='string')throw Error('Invalid package registration');
  const existing=records.get(manifest?.id);
  if(existing){
   if(existing.packageSha256===sha256)return view(existing);
   throw Error('Another package or builtin already owns this Mod ID');
  }
  if(!configuration||typeof configuration!=='object'||Array.isArray(configuration))throw Error('Configuration must be an object');
  const configurationJson=JSON.stringify(configuration);
  // Compilation does not evaluate the entry. This is trusted native-process
  // code when enabled, not a sandbox, and cannot be made safe by this wrapper.
  const execute=new Function('module','exports','"use strict";\n'+source);
  register(manifest,()=>{
   const module={exports:{}};
   execute(module,module.exports);
   if(typeof module.exports!=='function')throw Error('Mod entry must export a lifecycle factory');
   // Capability declarations describe supported APIs, not a security boundary.
   // Retain an SDK-owned handle even if the package throws after installation.
   let owned=null,creating=true;
   const activation={};records.get(manifest.id).activation=activation;
   function snapshot(options={}){
    if(!manifest.capabilities.includes('battle.information.read'))throw Error('Missing capability: battle.information.read');
    const call=invocation;
    if(!call||!call.accepting||call.record!==records.get(manifest.id)||call.activation!==activation)
     throw Error('Battle queries require this enabled Mod command invocation');
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='detailScope')||
       !['selected','all'].includes(options.detailScope??'selected'))throw Error('Invalid battle snapshot options');
    if(call.reads.length>=16)throw Error('Battle snapshot limit is 16 reads per command');
    if(typeof readRuntimeSnapshot!=='function')throw Error('Original snapshot provider unavailable');
    const detailScope=options.detailScope??'selected';
    const pending=Promise.resolve().then(()=>readRuntimeSnapshot({detailScope})).then(value=>{
     // Opaque session keys are JSON strings, never native object handles. Do not
     // expose unrelated inventory/menu data through a battle-only capability.
     const result=value.state==='BattleGameState'?value:{schemaVersion:value.schemaVersion,state:value.state,units:[],scope:value.scope};
     return JSON.parse(JSON.stringify(result));
    });
    call.reads.push(pending.catch(()=>{}));
    return pending;
   }
   const sdk=Object.freeze({
    version:1,
    mod:Object.freeze({id:manifest.id,version:manifest.version}),
    config:Object.freeze({read:()=>JSON.parse(configurationJson)}),
    battle:Object.freeze({snapshot,events:Object.freeze({
     install(options={}){
      if(!creating)throw Error('Acquire battle events during the Mod factory call');
      if(!manifest.capabilities.includes('battle.events.read'))throw Error('Missing capability: battle.events.read');
      if(owned)throw Error('A lifecycle handle is already acquired by this Mod');
      if(typeof installBattleEventsMod!=='function')throw Error('Original battle events provider unavailable');
      owned=installBattleEventsMod(options);records.get(manifest.id).instance=owned;return owned;
     }
    }),trial:Object.freeze({
     install(){
      if(!creating)throw Error('Acquire trial ownership during the Mod factory call');
      if(!manifest.capabilities.includes('battle.trial'))throw Error('Missing capability: battle.trial');
      if(owned)throw Error('A lifecycle handle is already acquired by this Mod');
      if(typeof installOriginalTrialMod!=='function')throw Error('Original trial provider unavailable');
      owned=installOriginalTrialMod(manifest.id);
      records.get(manifest.id).instance=owned;
      return owned;
     }
    }),control:Object.freeze({
     install(){
      if(!creating)throw Error('Acquire battle control during the Mod factory call');
      if(!manifest.capabilities.includes('battle.control'))throw Error('Missing capability: battle.control');
      if(owned)throw Error('A lifecycle handle is already acquired by this Mod');
      if(typeof installBattleControlMod!=='function')throw Error('Battle control provider unavailable');
      owned=installBattleControlMod(manifest.id);
      records.get(manifest.id).instance=owned;
      return owned;
     }
    }),information:Object.freeze({
     install(){
      if(!creating)throw Error('Acquire information UI during the Mod factory call');
      if(!manifest.capabilities.includes('battle.information.ui'))throw Error('Missing capability: battle.information.ui');
      if(owned)throw Error('Information UI already acquired by this Mod');
      if(typeof installBattleInfo!=='function')throw Error('Information UI provider unavailable');
      owned=installBattleInfo();
      records.get(manifest.id).instance=owned;
      return owned;
     }
    })})
   });
   try{
    const handle=module.exports(sdk);
    if(owned&&handle!==owned)throw Error('Return the acquired lifecycle handle');
    return handle;
   }finally{creating=false;}
  });
  const record=records.get(manifest.id);record.packageSha256=sha256;
  return view(record);
 }
 async function disable(r){
  if(r.state==='disabled')return view(r);
  r.state='disabling';
  try{
   if(!r.instance)throw Error('Missing lifecycle handle; cleanup cannot be confirmed');
   const result=await r.instance.stop();
   if(result?.lifecycle!=='stopped')throw Error('Mod cleanup was not confirmed');
   r.instance=null;r.state='disabled';r.error=null;
   return view(r);
  }catch(error){r.state='cleanup-failed';r.error=String(error);throw error;}
 }
 async function command(operation,payload={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Mod payload must be an object');
  if(operation==='list'){
   if(Object.keys(payload).length)throw Error('Mod list takes no payload');
   return {sdkVersion:1,mods:[...records.values()].map(view)};
  }
  if(!['enable','disable'].includes(operation)||Object.keys(payload).length!==1||typeof payload.id!=='string')throw Error('Mod operation requires only id');
  const r=records.get(payload.id);if(!r)throw Error('Unknown Mod');
  if(busy||closing)throw Error('Another Mod lifecycle operation is in progress');
  busy=true;
  try{
   if(operation==='disable'){
    const dependent=[...records.values()].find(x=>x.state!=='disabled'&&x.manifest.dependencies.includes(r.manifest.id));
    if(dependent)throw Error('Enabled dependent must be disabled first: '+dependent.manifest.id);
    return await disable(r);
   }
   if(r.state==='enabled')return view(r);
   if(r.state!=='disabled')throw Error('Resolve previous Mod cleanup before enabling');
   for(const id of r.manifest.dependencies){
    const dependency=records.get(id);
    if(dependency?.state!=='enabled')throw Error('Required Mod is not enabled: '+id);
    const version=r.manifest.dependencyVersions?.[id];
    if(version&&dependency.manifest.version!==version)throw Error('Required Mod version mismatch: '+id+' requires '+version);
   }
   for(const other of records.values())if(other.state!=='disabled'&&
    (r.manifest.conflicts.includes(other.manifest.id)||other.manifest.conflicts.includes(r.manifest.id)))throw Error('Conflicting Mod: '+other.manifest.id);
   for(const capability of ['battle.control','battle.trial'])
    if(r.manifest.capabilities.includes(capability)&&[...records.values()].some(other=>other!==r&&other.state!=='disabled'&&other.manifest.capabilities.includes(capability)))
     throw Error('Another Mod owns the exclusive '+capability+' capability');
   r.state='enabling';r.error=null;
   try{
    r.instance=r.factory();
    if(!r.instance||typeof r.instance.stop!=='function'||typeof r.instance.status!=='function'||!r.instance.ready)throw Error('Invalid Mod lifecycle handle');
    await r.instance.ready;
    if(r.instance.status().lifecycle!=='enabled')throw Error('Mod installation was not confirmed');
    r.state='enabled';return view(r);
   }catch(error){
    r.state='failed';r.error=String(error);
    // Preserve the handle, so an explicit disable can verify cleanup.
    throw error;
   }
  }finally{release();}
 }
 async function shutdown(){
  if(closing)throw Error('Mod shutdown already in progress');
  // Drain the accepted command before cleanup, and reject new mutations while
  // draining. An unresolved native call retains ownership instead of detaching.
  closing=true;
  if(busy)await new Promise(resolve=>idleWaiters.push(resolve));
  busy=true;
  try{
   // Dependents first; registration order need not equal dependency order.
   const pending=[...records.values()].filter(r=>r.state!=='disabled');
   while(pending.length){
    const index=pending.findIndex(r=>!pending.some(x=>x!==r&&x.manifest.dependencies.includes(r.manifest.id)));
    if(index<0)throw Error('Cyclic Mod dependencies prevent ordered cleanup');
    await disable(pending[index]);pending.splice(index,1);
   }
   return {stopped:true};
  }finally{release();closing=false;}
 }
 async function invoke(id,name,payload={}){
  if(busy||closing)throw Error('Another Mod lifecycle operation is in progress');
  const r=records.get(id);
  if(!r||r.state!=='enabled')throw Error('Mod must be enabled before invoking commands');
  if(typeof name!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(name)||!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Invalid Mod command');
  if(typeof r.instance?.command!=='function')throw Error('Mod does not expose commands');
  busy=true;
  const call={record:r,activation:r.activation,accepting:true,reads:[]};invocation=call;
  try{return await r.instance.command(name,payload);}
  finally{
   // A package may accidentally omit await. Its queued native reads still own
   // the session until settled; disabling/unloading cannot race those reads.
   call.accepting=false;
   try{if(call.reads.length)await Promise.all(call.reads);}finally{invocation=null;release();}
  }
 }
 async function unregisterPackage(id,sha256){
  if(busy||closing)throw Error('Another Mod lifecycle operation is in progress');
  if(!validId(id)||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw Error('Package identity required');
  const r=records.get(id);
  if(!r)return {unregistered:true,alreadyAbsent:true};
  if(r.packageSha256!==sha256)throw Error('A different package or builtin owns this Mod ID');
  const dependent=[...records.values()].find(x=>x.manifest.dependencies.includes(id));
  if(dependent)throw Error('Unregister dependent first: '+dependent.manifest.id);
  busy=true;
  try{
   await disable(r);
   records.delete(id);
   return {unregistered:true,alreadyAbsent:false};
  }finally{release();}
 }
 return {register,registerPackage,command,invoke,shutdown,unregisterPackage};
})();
rpc.exports={...rpc.exports,modcommand:(op,payload)=>BlueMilkMods.command(op,payload),
 modregisterpackage:(manifest,source,sha256,configuration)=>BlueMilkMods.registerPackage(manifest,source,sha256,configuration),
 modinvoke:(id,name,payload)=>BlueMilkMods.invoke(id,name,payload),
 modunregisterpackage:(id,sha256)=>BlueMilkMods.unregisterPackage(id,sha256)};
