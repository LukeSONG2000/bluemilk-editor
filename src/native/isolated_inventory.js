'use strict';
// Standalone experiment only. Does not register factories or swap the live inventory.
// Era/Datacron dependencies require separate audits before this can power a trial.
globalThis.buildPrivateInventory=proto=>{
 const R=RuntimeApi,A=R.arg;
 if(proto.isNull()||R.fullName(R.classOf(proto))!=='Protos.Inventory')throw Error('Complete Inventory proto required');
 const domain=R.newObject(R.findClass('InventoryDomainController'));
 const empty=R.readRef(domain,'<Inventory>k__BackingField');
 if(empty.isNull())throw Error('Original private inventory constructor returned null');
 const originals=[],factories=[];
 function factory(name,fields,overrides={}){
  const original=OriginalFixtureTools.inject(name),copy=R.newObject(R.findClass(name));
  const before=fields.map(field=>R.readRef(original,field));
  fields.forEach((field,i)=>R.writeRef(copy,field,overrides[field]||before[i]));
  originals.push({object:original,fields,before});factories.push(copy);return copy;
 }
 const unit=factory('UnitDO+Factory',['_gameDataDC','_statModFactory','_inventoryDC','_gameConstants','_crewSetFactory','_crewMemberFactory','_powerCalculator','_battleStatDOFactory','_crewRatingCalculatorFactory','_relicFactory'],{_inventoryDC:domain});
 const roster=factory('UnitRosterDO+Factory',['_unitDOFactory','_squadDOFactory','_gameConstants','_eraDomainController'],{_unitDOFactory:unit});
 const inventoryFactory=factory('InventoryDO+Factory',['_statModDOFactory','_gameDataDC','_equipmentDOFactory','_rosterDOFactory','_lightspeedTokenDOFactory'],{_rosterDOFactory:roster});
 const inventory=R.invoke(R.findMethod(R.classOf(inventoryFactory),'Get',1,['Protos.Inventory']),inventoryFactory,[A.ref(proto)]);
 if(inventory.isNull()||inventory.equals(empty))throw Error('Expected freshly constructed inventory');
 R.retain(inventory);R.writeRef(domain,'<Inventory>k__BackingField',inventory);
 const unchanged=originals.every(row=>row.fields.every((field,i)=>R.readRef(row.object,field).equals(row.before[i])));
 if(!unchanged)throw Error('Original factory dependencies changed');
 return {inventory,domain,factories,originalDependenciesUnchanged:unchanged};
};
