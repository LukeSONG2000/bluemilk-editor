'use strict';
// The same SDK package and control provider used by the live shared host.
// No second injection, controller implementation or battle-rule replacement.
globalThis.prepareTrialControl=async fixture=>{
 const p=globalThis.trialControlPackage;
 BlueMilkMods.registerPackage(p.manifest,p.source,p.sha256);
 await BlueMilkMods.command('enable',{id:p.manifest.id});
 const status=await BlueMilkMods.invoke(p.manifest.id,'arm',{
  ...p.policy,scope:'all',combatType:fixture.combatType
 });
 send({kind:'trial-mod-armed',packageSha256:p.sha256,status});
};
rpc.exports.trialmodcommand=async(name,payload)=>{
 if(!['status','configure','enemy-input','disable'].includes(name))throw Error('Unsupported trial Mod command');
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('Expected command payload');
 if(name==='disable'&&Object.keys(payload).length)throw Error('Disable takes no payload');
 await RuntimeApi.runOnMainThreadOnce(()=>{
  const p=globalThis.visualProbe,R=RuntimeApi;
  if(!p?.entered||p.stopping)throw Error('No active owned trial');
  const current=R.readRef(p.fixture.state,'<CurrentState>k__BackingField');
  if(!current.equals(p.entered))throw Error('Current state is not the owned trial');
  const context=R.readRef(R.readRef(current,'_battleController'),'_battleContext');
  if(!context.equals(p.fixture.context))throw Error('Trial context ownership mismatch');
 });
 const id=globalThis.trialControlPackage.manifest.id;
 return name==='disable'?BlueMilkMods.command('disable',{id}):BlueMilkMods.invoke(id,name,payload);
};
// Shared snapshot shape lets the existing human control page inspect this owner.
rpc.exports.snapshot=rpc.exports.inspect;
