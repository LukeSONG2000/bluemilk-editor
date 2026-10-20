'use strict';
// Main-thread, read-only original getters. No hooks, setters or gameplay objects.
// Metadata: il2cpp/dump/cs/il2cpp.cs:72012,72408,72916,503471,595223,602463.
// GetStatValue body: logs/effect_phase2/unit_stat_value.c (includes stat limits).
(() => {
 const R=globalThis.RuntimeApi,S=globalThis.SceneApi;
 const names={1:'MAX_HEALTH',2:'STRENGTH',3:'AGILITY',4:'INTELLIGENCE',5:'SPEED',6:'ATTACK_DAMAGE',7:'ABILITY_POWER',8:'ARMOR',9:'SUPPRESSION',10:'ARMOR_PENETRATION',11:'SUPPRESSION_PENETRATION',12:'DODGE_RATING',13:'DEFLECTION_RATING',14:'ATTACK_CRITICAL_RATING',15:'ABILITY_CRITICAL_RATING',16:'CRITICAL_DAMAGE',18:'ACCURACY',19:'RESISTANCE',24:'HEALTH_STEAL',25:'MAX_SHIELD',28:'ATTACK_CRITICAL_PERCENT_ADDITIVE',29:'ABILITY_CRITICAL_PERCENT_ADDITIVE',61:'MASTERY'};
 const defaultStats=Object.keys(names).map(Number);
 const delta=(current,initial)=>Number.isFinite(current)&&Number.isFinite(initial)?current-initial:null;
 function readBattleAttributes(unit,options={}){
  if(!unit||unit.isNull())throw Error('Original battle unit required');
  const ids=options.statIds===undefined?defaultStats:options.statIds;
  if(!Array.isArray(ids)||ids.some(id=>!Number.isInteger(id)||id<1||id>62))throw Error('UnitStatEnum ids must be integers 1..62');
  const warnings=[];
  function read(label,fn){try {const value=fn();if(typeof value==='number'&&!Number.isFinite(value))throw Error('nonfinite original result');return value;}catch(e){warnings.push(label+': '+String(e.message||e));return null;}}
  function number(type,method,obj,args=[],types=[],kind='f32'){
   return R.unbox(S.invoke(type,method,obj,args,types),kind);
  }
  const scalar=name=>read(name,()=>number('BattleUnitController','get_'+name,unit,[],[],'i32'));
  const result={health:{current:scalar('CurrentHP'),max:scalar('MaxHP')},
   protection:{current:scalar('CurrentShield'),max:scalar('MaxShield'),
    permanent:{current:scalar('CurrentPermanentShield'),max:scalar('MaxPermanentShield')},
    bonus:{current:scalar('CurrentBonusShield'),max:scalar('MaxBonusShield')}},stats:[],warnings};
   const calculator=read('StatCalculator',()=>R.readRef(unit,'_statCalculator'));
  // FDE5C0 -> FDFF40 * recursive FDE5C0(MASTERY). This input is not the
  // final clamped BattleUnitController.GetStatValue(MASTERY) reading.
  const calculatedMastery=(!calculator||calculator.isNull())?null:read('recursive mastery calculation',()=>
   number('StatCalculator','GetCalculatedStatValue',calculator,
    [R.arg.value('u8',61),R.arg.ref(unit),R.arg.value('u8',0),R.arg.value('f32',0),R.arg.value('i32',-1)],
    ['UnitStatEnum','IStatSource','EquipmentExclusionType','System.Single','System.Int32']));
  for(const id of [...new Set([...ids,61])]){
   const args=[R.arg.value('u8',id)],types=['UnitStatEnum'];
   const initial=read('initial '+id,()=>number('BattleUnitController','GetInitialUnitCalculatedStat',unit,args,types));
   const current=read('current '+id,()=>number('BattleUnitController','GetStatValue',unit,args,types));
   // Do not invoke UnitDO.GetCalculatedStatValue: even displayOnly=true writes
   // equipped datacron context without restoring it (native 1011440 -> 10114C0).
   const dtoDisplayOnly=null;
   const hasMasteryContribution=read('mastery flag '+id,()=>number('BattleUnitController','HasMasteryContribution',unit,args,types,'bool')!==0);
   // Invoke native calculation; do not derive contribution from mastery rating.
   // FDFF40 reads primary-stat/role table coefficient, not the applied contribution.
   // It may lazily cache the GameData controller; it does not change battle stats.
   const masteryCoefficient=(!calculator||calculator.isNull()||hasMasteryContribution!==true)?null:
    read('mastery contribution '+id,()=>number('StatCalculator','GetMasteryContribution',calculator,
     [...args,R.arg.ref(unit)],['UnitStatEnum','IStatSource']));
   result.stats.push({id,name:names[id]||'UnitStatEnum_'+id,initial,current,netBattleDelta:delta(current,initial),dtoDisplayOnly,
    hasMasteryContribution,masteryCoefficient,masteryContributionDelta:null,
    masteryPreModifierTerm:hasMasteryContribution===false?0:
     (Number.isFinite(calculatedMastery)&&Number.isFinite(masteryCoefficient)?Math.fround(calculatedMastery*masteryCoefficient):null)});
  }
  const mastery=result.stats.find(s=>s.id===61);
  // GetStatValue 1BBAE55..1BBAE8B passes the original initial stat as the
  // calculator's initialValue. Its later calls apply upper/lower stat limits.
  // This differs from the recursive zero-input term used for other stats.
  const masteryBeforeLimits=(!calculator||calculator.isNull()||!Number.isFinite(mastery.initial))?null:read('mastery before limits',()=>
   number('StatCalculator','GetCalculatedStatValue',calculator,
    [R.arg.value('u8',61),R.arg.ref(unit),R.arg.value('u8',0),R.arg.value('f32',mastery.initial),R.arg.value('i32',-1)],
    ['UnitStatEnum','IStatSource','EquipmentExclusionType','System.Single','System.Int32']));
  result.mastery={initial:mastery.initial,current:mastery.current,netBattleDelta:mastery.netBattleDelta,recursiveCalculationValue:calculatedMastery,
   sourceInputs:{
    compoundable:read('mastery compoundable input',()=>number('BattleUnitController','IStatSource.GetCompoundableStatContribution',unit,
     [R.arg.value('u8',61)],['UnitStatEnum'])),
    nonCompoundable:read('mastery non-compoundable input',()=>number('BattleUnitController','IStatSource.GetNonCompoundableStatContribution',unit,
     [R.arg.value('u8',61),R.arg.value('u8',0),R.arg.value('i32',-1)],['UnitStatEnum','EquipmentExclusionType','System.Int32']))},
   beforeLimits:masteryBeforeLimits,netBeforeLimits:delta(masteryBeforeLimits,mastery.initial),limitAdjustment:delta(mastery.current,masteryBeforeLimits),
   attributedStatChanges:null,reason:'No original baseline mastery-contribution snapshot; total stat delta is not mastery-only delta.'};
  result.contract={bonusShield:'Original CurrentBonusShield/MaxBonusShield getters; not inferred from total minus permanent.',
   dtoDisplayOnly:'Unavailable: original display getter mutates datacron context and is deliberately not invoked.',
   netBattleDelta:'Difference of original current and initial readings; includes all changes, not additive-effect sum.',
   masteryLimits:'Native calculator with original initial mastery, before GetStatValue upper/lower limits. current minus beforeLimits is the observed limit-stage adjustment; not a skill attribution or the zero-input recursive contribution.',
   masteryCoefficient:'Native FDFF40 primary-stat/role lookup coefficient; not current contribution or attributed change.',
   masterySourceInputs:'Original IStatSource inputs for MASTERY only, before calculator modifiers and limits. Neither input is final mastery delta or a per-skill attribution. They may overlap terms already represented elsewhere; do not add them to current or netBattleDelta.',
   masteryPreModifierTerm:'Float32 product of native recursive mastery calculation (initialValue=0) and coefficient, matching FDE5C0 MULSS stage. Initial stat already includes baseline mastery. Before subsequent stat modifiers and limits; not total mastery contribution or final attributed delta.',
   units:'Raw original stat units. Ratings are not converted to percentages.'};
  return result;
 }
 globalThis.readBattleAttributes=readBattleAttributes;
 // Explicit diagnostic only: never added to the normal overlay polling path.
 globalThis.readBattleStatStages=(unit,id)=>{
  if(!Number.isInteger(id)||id<1||id>62)throw Error('UnitStatEnum id must be 1..62');
  const attributes=readBattleAttributes(unit,{statIds:[id]}),stat=attributes.stats.find(s=>s.id===id);
  if(!Number.isFinite(stat.initial))throw Error('Original initial stat unavailable');
  const calculator=R.readRef(unit,'_statCalculator');
  const call=(type,name,obj,args,types)=>R.unbox(S.invoke(type,name,obj,args,types),'f32');
  const beforeLimits=call('StatCalculator','GetCalculatedStatValue',calculator,
   [R.arg.value('u8',id),R.arg.ref(unit),R.arg.value('u8',0),R.arg.value('f32',stat.initial),R.arg.value('i32',-1)],
   ['UnitStatEnum','IStatSource','EquipmentExclusionType','System.Single','System.Int32']);
  const compoundable=call('BattleUnitController','IStatSource.GetCompoundableStatContribution',unit,[R.arg.value('u8',id)],['UnitStatEnum']);
  const nonCompoundable=call('BattleUnitController','IStatSource.GetNonCompoundableStatContribution',unit,
   [R.arg.value('u8',id),R.arg.value('u8',0),R.arg.value('i32',-1)],['UnitStatEnum','EquipmentExclusionType','System.Int32']);
  if(![beforeLimits,compoundable,nonCompoundable,stat.current].every(Number.isFinite))throw Error('Nonfinite native stat stage');
  return {readConfirmed:true,stat,beforeLimits,limitAdjustment:delta(stat.current,beforeLimits),
   sourceInputs:{compoundable,nonCompoundable},mastery:attributes.mastery,warnings:attributes.warnings,
   attributedMasteryDelta:null,
   scope:'Native calculator with original initial stat; includes calculator rounding/minima. limitAdjustment is only the later GetStatValue limits. Source inputs are not final additive gains. No mastery-only attribution or counterfactual is claimed.'};
 };
 globalThis.BattleAttributesReader={readBattleAttributes,delta,defaultStats,names};
})();
