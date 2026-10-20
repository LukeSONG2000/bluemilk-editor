'use strict';
// Read only, no hooks or game-state writes. Invoke on the original main thread.
// Requires runtime_api.js and unity_scene_api.js. Never calls IsMatch/IsMet,
// ConditionTypeMet, Reset, or any effect mutation/constructor.
(() => {
 const R=globalThis.RuntimeApi,S=globalThis.SceneApi;
 const LIMIT=100000,P=8;
 // Cache only immutable field layouts. Values are read anew on every call.
 // Validate each layout against the existing typed IL2CPP getter before use.
 const layouts=new Map();
 function readField(object,name,kind){
  const klass=R.classOf(object),key=klass.toString()+':'+name+':'+kind;
  let layout=layouts.get(key);
  const types={ref:[8,'readPointer'],i32:[4,'readS32'],u8:[1,'readU8'],bool:[1,'readU8']};
  const [bytes,method]=types[kind];
  const original=()=>kind==='ref'?R.readRef(object,name):R.readValue(object,name,kind);
  if(!layout){
   const value=original(),field=R.field(klass,name);
   const flags=R.api('field_get_flags','uint',['pointer'])(field);
   if(flags&0x10)return value; // Static/thread-static storage is not object-relative.
   const offset=Number(R.api('field_get_offset','size_t',['pointer'])(field));
   const size=R.api('class_instance_size','int',['pointer'])(klass);
   if(!Number.isSafeInteger(offset)||offset<2*P||offset+bytes>size)throw Error('Status field layout out of bounds');
   layout={offset};
   const raw=object.add(offset)[method](),direct=kind==='bool'?raw!==0:raw;
   if(kind==='ref'?!direct.equals(value):direct!==value)throw Error('Status field layout disagrees with original getter');
   layouts.set(key,layout);
   return value;
  }
  const raw=object.add(layout.offset)[method]();return kind==='bool'?raw!==0:raw;
 }
 const ref=(object,name)=>readField(object,name,'ref');
 const scalarField=(object,name,kind)=>readField(object,name,kind);
 const countNames={1:'全场行动结束',2:'全场行动开始',8:'自身行动完成',9:'自身普通攻击',10:'自身特殊技能',
  23:'自身回合开始',33:'自身回合结束',36:'自身行动开始',37:'自身普通攻击开始',38:'自身特殊技能开始',54:'自身完整回合完成'};
 function requireRef(value,label){if(!value||value.isNull())throw Error('Missing original '+label);return value;}
 function arrayRefs(array,count){
  if(array.isNull()){if(count===0)return [];throw Error('Null array with live entries');}
  const exported=Number(R.api('array_length','size_t',['pointer'])(array));
  const header=array.add(24).readU64().toNumber();
  if(!Number.isSafeInteger(exported)||exported<0||exported>LIMIT||header!==exported||count<0||count>exported)
   throw Error('Original reference-array bounds mismatch');
  return Array.from({length:count},(_,i)=>array.add(32+i*P).readPointer());
 }
 function listRefs(list){
  if(list.isNull())return [];
  return arrayRefs(ref(list,'_items'),scalarField(list,'_size','i32'));
 }
 function dictionaryRefs(dictionary){
  if(dictionary.isNull())return new Map();
  const array=ref(dictionary,'_entries'),count=scalarField(dictionary,'_count','i32');
  if(array.isNull()){if(count===0)return new Map();throw Error('Null dictionary storage');}
  const length=Number(R.api('array_length','size_t',['pointer'])(array));
  if(!Number.isSafeInteger(length)||length<0||length>LIMIT||length!==array.add(24).readU64().toNumber()||count<0||count>length)
   throw Error('Original dictionary bounds mismatch');
  const element=R.api('class_get_element_class','pointer',['pointer'])(R.classOf(array));
  const stride=R.api('class_value_size','int',['pointer','pointer'])(element,Memory.alloc(4));
  const offset=name=>Number(R.api('field_get_offset','size_t',['pointer'])(R.field(element,name)))-2*P;
  const keyOffset=offset('key'),valueOffset=offset('value');
  if(!Number.isSafeInteger(stride)||stride<=0||stride>65536||keyOffset<0||valueOffset<0||keyOffset+P>stride||valueOffset+P>stride)
   throw Error('Original dictionary entry stride mismatch');
  const map=new Map();
  for(let i=0;i<count;i++){
   const entry=array.add(32+i*stride),key=entry.add(keyOffset).readPointer(),value=entry.add(valueOffset).readPointer();
   // These keys/values are reference types; removed entries have cleared keys.
   if(!key.isNull()&&!value.isNull())map.set(key.toString(),value);
  }
  return map;
 }
 const stringField=(object,name)=>S.string(ref(object,name));
 function readCondition(condition,statuses){
  const type=scalarField(condition,'<ConditionType>k__BackingField','u8');
  const value=stringField(condition,'<ConditionValue>k__BackingField');
  const row={conditionType:type,conditionValue:value,kind:'non-turn-condition',remaining:null};
  const status=statuses.get(condition.toString());
  if(!status){row.reason='Original condition status unavailable';return row;}
  row.requiredCount=scalarField(status,'_triggerCount','i32');
  row.observedCount=scalarField(status,'_conditionMetCount','i32');
  row.valueParsedAsCount=scalarField(status,'_conditionValueIsTriggerCount','bool');
  row.reported=scalarField(status,'IsReported','bool');
  // ConditionStatus.IsMet (RVA17DCE30) compares these actual counters for
  // non-CHANCE events. Do not mistake parsed numeric CHANCE or ROUND_COUNT for
  // a duration. Preserve unknown/compound expiration semantics explicitly.
  if(Object.prototype.hasOwnProperty.call(countNames,type)){
   row.kind='event-count';row.eventName=countNames[type];
   row.remaining=Math.max(0,row.requiredCount-row.observedCount);
   row.text='剩余 '+row.remaining+' 次'+row.eventName;
  }else{row.reason='Not a supported turn/action expiration counter';}
  return row;
 }
 function durationText(conditions){
  if(!conditions.length)return '无固定回合（可由条件或驱散移除）';
  const exact=conditions.filter(c=>c.kind==='event-count').map(c=>c.text);
  if(!exact.length)return '无固定回合（按原条件移除）';
  // Never collapse distinct event types to min/max or use icon stack count.
  return exact.join('；')+(conditions.length>exact.length?'；另有原移除条件':'');
 }
 function readBattleStatus(unit){
  requireRef(unit,'battle unit');
  const readInt=name=>R.unbox(S.invoke('BattleUnitController','get_'+name,unit),'i32');
  const result={hp:readInt('CurrentHP'),maxHp:readInt('MaxHP'),shield:readInt('CurrentShield'),maxShield:readInt('MaxShield'),effects:[],warnings:[]};
  const controller=requireRef(ref(unit,'_battlePersistentEffectsController'),'persistent effects controller');
  const tracker=ref(controller,'_expirationConditionTracker');
  const statuses=tracker.isNull()?new Map():dictionaryRefs(ref(tracker,'_conditionStatuses'));
  const effectMap=ref(controller,'_persistentEffects');
  if(effectMap.isNull())return result;
  const groups=ref(effectMap,'_persistentEffectDataMap');
  if(groups.isNull())return result;
  const values=arrayRefs(ref(groups,'values'),scalarField(groups,'_size','i32'));
  for(const group of values)for(const instance of listRefs(group)){
   if(instance.isNull())continue;
   const effect=requireRef(ref(instance,'_effect'),'effect instance definition');
   const definition=requireRef(ref(effect,'_definition'),'effect definition');
   const isBuff=scalarField(effect,'<IsPersistentBuff>k__BackingField','bool');
   const isDebuff=scalarField(effect,'<IsPersistentDebuff>k__BackingField','bool');
   const conditions=listRefs(ref(instance,'_expirationConditionInstances')).map(c=>readCondition(c,statuses));
   const row={
    instanceKey:instance.toString(),effectKey:effect.toString(),
    effectId:stringField(definition,'Id'),locKey:stringField(definition,'PersistentLocKey'),
    tooltipKey:stringField(effect,'<TooltipKey>k__BackingField'),
    iconSprite:stringField(definition,'PersistentIcon'),overlaySprite:stringField(definition,'PersistentIconOverlay'),
    backgroundSprite:stringField(effect,'<BackgroundSprite>k__BackingField'),iconColor:stringField(definition,'IconColor'),
    persistentIconPriority:scalarField(definition,'PersistentIconPriority','u8'),
    effectIconPriority:scalarField(effect,'<IconPriority>k__BackingField','i32'),
    groupable:scalarField(definition,'PersistantIconGroupable','bool'),
    isBuff,isDebuff,
    stackingLine:stringField(instance,'_stackingLine'),
    conditions,durationText:durationText(conditions),
    permanent:null // No fixed expiry is not proof of immunity to removal.
   };
   result.effects.push(row);
  }
  result.warnings.push('Effect rows may share icons; retain all matching instance durations. Priority fields preserve source names; UI GetEffectKey mapping is not inferred. DisplayStackCount is not duration.');
  return result;
 }
 globalThis.readBattleStatus=readBattleStatus;
 globalThis.BattleStatusReader={readBattleStatus,durationText,countNames};
})();
