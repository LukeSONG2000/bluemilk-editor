'use strict';
// Main-thread lease for the original captured PVE definitions. The original
// factory installs this table for conversion; battle-time summons also need it.
globalThis.activateCapturedDefinitions=(gameData,definitionMap)=>{
 const R=RuntimeApi,key='_pveUnitDefinitionMap';
 if(gameData.isNull()||definitionMap.isNull())throw Error('Captured definition scope requires original objects');
 const previous=R.readRef(gameData,key);
 if(!previous.isNull())R.retain(previous);
 R.retain(definitionMap);
 R.writeRef(gameData,key,definitionMap);
 let restored=false;
 return ()=>{
  if(restored)return;
  if(!R.readRef(gameData,key).equals(definitionMap))throw Error('Definition scope changed by another owner; not overwritten');
  R.writeRef(gameData,key,previous);
  if(!R.readRef(gameData,key).equals(previous))throw Error('Original definitions not restored');
  restored=true;
 };
};
