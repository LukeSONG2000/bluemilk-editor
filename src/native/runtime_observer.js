'use strict';
// Snapshot is read-only; separate explicit RPC exports perform original UI navigation.

// Inventory reads are explicit requests: do not enumerate the full roster on
// every battle-info tick. Only the currently open detail is polled.
globalThis.InventoryBridge=(()=>{
 const R=RuntimeApi,S=SceneApi;
 let filterSession=null,filterSerial=0;
 const filterEpoch=Date.now()+':'+Math.random().toString(36).slice(2);
 const current=()=>R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
 function list(value){
  if(value.isNull())return [];
  const items=R.readRef(value,'_items'),n=R.readValue(value,'_size','i32');
  if(n<0||n>4096||(items.isNull()?n!==0:n>items.add(24).readU64().toNumber()))throw Error('Inventory list bounds invalid');
  return Array.from({length:n},(_,i)=>items.add(32+i*8).readPointer());
 }
 function unitInfo(unit){
  const definition=R.readRef(unit,'<Definition>k__BackingField');
  return {unitId:S.string(R.readRef(unit,'Id')),baseId:S.string(R.readRef(definition,'BaseId')),loaned:!!R.unbox(S.invoke('UnitDO','get_IsLoanedUnit',unit),'bool'),
   level:R.readValue(unit,'<CurrentLevel>k__BackingField','i32'),rarity:R.readValue(unit,'<CurrentRarity>k__BackingField','u8'),tier:R.readValue(unit,'<CurrentTier>k__BackingField','u8')};
 }
 function skills(unit){
  const definition=R.readRef(unit,'<Definition>k__BackingField'),entries=[];
  for(const skill of list(R.readRef(definition,'_skillDefinitions')))entries.push({skill,source:'unit',crewMemberId:null});
  for(const slot of list(R.readRef(definition,'_crewMemberSlots'))){
   const crewMemberId=S.string(R.readRef(slot,'<CrewMemberId>k__BackingField'));
   for(const skill of list(R.readRef(slot,'<CrewSkillDef>k__BackingField')))entries.push({skill,source:'crew',crewMemberId});
  }
  if(entries.length>256)throw Error('Inventory skill definition bound exceeded');
  return entries.map(({skill,source,crewMemberId})=>{
   const id=R.readRef(skill,'Id'),args=[R.arg.ref(id)];
   const present=!!R.unbox(S.invoke('UnitDO','HasSkill',unit,args,['System.String']),'bool');
   // GetSkillTier is an indexer and throws for absent skills. Never guess zero.
   const currentTier=present?R.unbox(S.invoke('UnitDO','GetSkillTier',unit,args,['System.String']),'i32'):null;
   const reference=R.readRef(skill,'AbilityReferenceId');
   const ability=S.invoke('UnitDO','GetAbility',unit,[R.arg.ref(reference)],['System.String']);
   return {skillId:S.string(id),abilityReferenceId:S.string(reference),
    skillDefinitionNameKey:S.string(R.readRef(skill,'NameKey')),
    abilityNameKey:ability.isNull()?null:S.string(S.invoke('AbilityDO','get_NameKey',ability)),
    abilityType:ability.isNull()?null:R.unbox(S.invoke('AbilityDO','get_AbilityType',ability),'u8'),
    baseCooldown:ability.isNull()?null:R.readValue(ability,'CooldownMax','i16'),source,crewMemberId,present,currentTier,
    tierCount:R.unbox(S.invoke('SkillDefinitionDO','GetTotalTiers',skill),'i32'),
    requiredUnitTier:R.readValue(skill,'RequiredTier','u8'),requiredRelicTier:R.readValue(skill,'RequiredRelicTier','u8'),
    skillType:R.readValue(skill,'SkillType','i32'),omicronMode:R.readValue(skill,'OmicronMode','i32'),
    definitionIsZeta:R.readValue(skill,'IsZeta','bool')};
  });
 }
 function inventory(){
  const state=current();if(state.isNull()||R.fullName(R.classOf(state))!=='MasterInventoryGameState')throw Error('Inventory command requires the collection screen');
  const master=R.readRef(state,'_masterInventoryController'),data=R.readRef(master,'_transitionData');
  if(!R.readRef(data,'<ReadOnlyRoster>k__BackingField').isNull())throw Error('Inventory interface requires the player collection');
  const kind=R.readValue(data,'<Type>k__BackingField','i32');
  if(![1,2].includes(kind))throw Error('Select characters or ships first');
  const controller=R.readRef(master,kind===1?'_characterInventoryController':'_shipInventoryController');
  const view=R.readRef(controller,kind===1?'_inventoryView':'_shipInventoryView');
  if(view.isNull())throw Error('Inventory view has not been initialized');
  if(!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(view)),'bool'))throw Error('Inventory view is not ready');
  return {kind,controller,view,rows:list(R.readRef(view,'_filterData'))};
 }
 function abilityOwner(controller,type){
  if(type==='ShipDetailsState')return controller;
  const panels=R.readRef(controller,'_unitDetailsInfoPanelsController');
  return panels.isNull()?R.nil:R.readRef(panels,'_unitDetailsAbilityController');
 }
 function displayRows(controller,type){
   let rows=null;
   if(type==='CharacterDetailsState'){
    const panels=R.readRef(controller,'_unitDetailsInfoPanelsController');
    const abilities=panels.isNull()?R.nil:R.readRef(panels,'_unitDetailsAbilityController');
    if(!abilities.isNull())rows=list(R.readRef(abilities,'_abilityViewData')).map(data=>({data,container:'character'}));
   }else{
    const viewData=R.readRef(controller,'_currentData');
    if(!viewData.isNull()){
     rows=[];
     const append=(group,container,crewSlot=null)=>{if(!group.isNull())for(const data of list(R.readRef(group,'<AbilityData>k__BackingField')))rows.push({data,container,crewSlot});};
     append(R.readRef(viewData,'<ShipAbilityData>k__BackingField'),'ship');
     append(R.readRef(viewData,'<AdvancedAbilityData>k__BackingField'),'advanced');
     list(R.readRef(viewData,'<CrewAbilityData>k__BackingField')).forEach((group,index)=>append(group,'crew',index));
    }
   }
   if(rows!==null&&rows.length>256)throw Error('Skill display bound exceeded');
   return rows;
 }
 function skillMaterials(data){
  const recipe=R.readRef(data,'<RecipeData>k__BackingField');
  if(recipe.isNull())return null;
  const count=R.readValue(recipe,'_size','i32');
  if(count<0||count>128)throw Error('Skill recipe bound exceeded');
  const rows=[];
  // List<KeyValuePair<...>> contains value types: use the original indexer to box
  // each pair instead of interpreting the array as a list of object pointers.
  const get=R.findMethod(R.classOf(recipe),'get_Item',1);
  for(let i=0;i<count;i++){
   const pair=R.invoke(get,recipe,[R.arg.value('i32',i)]),tile=R.readRef(pair,'value');
   if(tile.isNull())throw Error('Null skill recipe tile');
   const itemType=R.readValue(pair,'key','u8'),id=R.readRef(tile,'ID');
   const row={itemType,renderType:R.fullName(R.classOf(tile)),
    id:S.string(id),label:S.string(R.readRef(tile,'<LabelString>k__BackingField')),
    quantityRaw:R.readValue(tile,'<Quantity>k__BackingField','i32'),ownedQuantity:null};
   // ItemTypeEnum.MATERIAL. Other recipe item types require their own inventory getter.
   if(itemType===7)try{
    row.ownedQuantity=R.unbox(S.invoke('InventoryDomainController','GetCraftingMaterialQuantity',R.findBound('InventoryDomainController'),[R.arg.ref(id)],['System.String']),'i32');
   }catch(error){row.inventoryError=String(error);}
   rows.push(row);
  }
  return rows;
 }
 function skillLevel(data){
  if(data.isNull())return null;
  const text=name=>S.string(R.readRef(data,'<'+name+'>k__BackingField'));
  const value=(name,kind='i32')=>R.readValue(data,'<'+name+'>k__BackingField',kind);
  const result={tier:value('AbilityTier'),levelText:text('AbilityLevel'),typeText:text('AbilityLevelType'),
   description:text('AbilityDescription'),requirements:text('AbilityUpgradeRequirements'),
   cooldown:value('Cooldown'),hideCooldown:!!value('HideCooldown','bool'),
   lockedByConditions:!!value('LevelLockedByConditions','bool'),upgradeStatus:value('UpgradeStatus'),
   upgradeAvailable:!!value('UpgradeAvailable','bool'),
   currencyCost:value('RecipeCost'),currencyType:value('RecipeCurrencyType'),
   materials:skillMaterials(data),costComplete:false,currencyOwned:null};
  try{
   result.currencyOwned=R.unbox(S.invoke('InventoryDomainController','GetCurrencyQuantity',R.findBound('InventoryDomainController'),[R.arg.value('i32',result.currencyType)],['CurrencyTypeEnum']),'i32');
  }catch(error){result.currencyError=String(error);}
  return result;
 }
 function skillPopup(controller,type,raw=false){
  const owner=abilityOwner(controller,type);if(owner.isNull())return null;
  for(const [field,viewType] of [['_skillsOverlayView','UnitDetailsSkillOverlayView'],['_abilityDetailsView','AbilityDetailsView']]){
   const view=R.readRef(owner,field);if(view.isNull()||!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(view)),'bool'))continue;
   if(raw)return {view,viewType};
   if(viewType==='UnitDetailsSkillOverlayView'){
    const data=R.readRef(view,'_data');
    if(data.isNull())return {loading:true};
    const levels=list(R.readRef(data,'<AbilityLevelData>k__BackingField'));
    if(levels.length>128)throw Error('Skill level bound exceeded');
    return {kind:'levels',skillId:S.string(R.readRef(data,'<SkillId>k__BackingField')),abilityId:S.string(R.readRef(data,'<AbilityId>k__BackingField')),name:S.string(R.readRef(data,'<AbilityName>k__BackingField')),
     allowUpgrade:!!R.readValue(data,'<AllowUpgrade>k__BackingField','bool'),
     selectedLevel:skillLevel(R.readRef(view,'_selectedLevelData')),levels:levels.map(skillLevel)};
   }
   const label=R.readRef(view,'_abilityName');
   return {kind:'single',name:S.string(S.invoke('UILabel','get_text',label))};
  }
  return null;
 }
 function detail(state){
  const type=R.fullName(R.classOf(state));if(!['CharacterDetailsState','ShipDetailsState'].includes(type))return null;
  const controller=R.readRef(state,'_controller');if(controller.isNull())return {loading:true};
  const data=R.readRef(controller,'_transitionData');
  if(data.isNull())return {loading:true};
  const unit=R.readRef(data,type==='CharacterDetailsState'?'<Unit>k__BackingField':'Unit');
  if(unit.isNull())return {loading:true};
  const result={kind:type==='CharacterDetailsState'?'characters':'ships',...unitInfo(unit)};
  try{result.skills=skills(unit);}catch(error){result.skillsError=String(error);}
  try{
   const rows=displayRows(controller,type);
   result.skillDisplay=rows===null?null:rows.map(({data,container,crewSlot=null})=>({
    container,crewSlot,
    skillId:S.string(R.readRef(data,'<SkillId>k__BackingField')),
    abilityId:S.string(R.readRef(data,'<AbilityId>k__BackingField')),
    name:S.string(R.readRef(data,'<NameText>k__BackingField')),
    levelText:S.string(R.readRef(data,'<LevelText>k__BackingField')),
    currentTier:R.readValue(data,'<CurrentTierForSkill>k__BackingField','i32'),
    requiredSkillTier:R.readValue(data,'<RequiredSkillTier>k__BackingField','i32'),
    displayLevel:R.unbox(S.invoke('UnitDetailsAbilityViewData','get_CurrentTierDisplayValueForSkill',data),'i32'),
    maxed:!!R.readValue(data,'<SkillForAbilityMaxed>k__BackingField','bool'),
    locked:!!R.readValue(data,'<Locked>k__BackingField','bool')
   }));
  }catch(error){result.skillDisplayError=String(error);}
  try{result.skillPopup=skillPopup(controller,type);}catch(error){result.skillPopupError=String(error);}
  return result;
 }
 function execute(operation,request){
  if(operation==='inventory-filter'){
   const live=inventory(),action=request?.action;
   if(!['open','status','select','search','close'].includes(action))throw Error('Unknown inventory filter action');
   const active=p=>!p.isNull()&&!!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(p)),'bool');
   const helper=R.readRef(live.view,'_filterHelper');
   const controller=R.readRef(helper,'_filterSortSelectController'),view=controller.isNull()?R.nil:R.readRef(controller,'_view');
   const showing=active(view);
   const configs=showing?list(R.readRef(controller,'_filters')):[];
   const options=configs.map((p,index)=>({index,name:S.string(R.readRef(p,'<Name>k__BackingField')),textInput:!!R.readValue(p,'<TextInput>k__BackingField','bool')}));
   const popupKey=showing?controller.toString()+':'+view.toString():null;
   if(!showing)filterSession=null;
   else if(filterSession?.key!==popupKey)filterSession={key:popupKey,token:filterEpoch+':'+(++filterSerial)};
   const token=filterSession?.token??null;
   const config=R.readRef(helper,'_filterSortConfig');
   const selectedIndex=R.readValue(config,'FilterIndex','i32');
   if(action==='status')return {readConfirmed:true,kind:live.kind,showing,token,options,selectedIndex};
   if(action==='open'){
    if(showing)throw Error('A filter/sort popup is already open');
    const master=R.readRef(current(),'_masterInventoryController'),masterView=R.readRef(master,'_masterInventoryView');
    const container=R.readRef(masterView,'_filterContainer'),smart=R.readRef(container,'_filterButton');
    const button=S.invoke('SmartButton','get_ButtonTarget',smart);
    if(!active(button)||!R.unbox(S.invoke('UIButton','get_isEnabled',button),'bool')||R.unbox(S.invoke('SmartButton','get_DisabledAndClickable',smart),'bool'))throw Error('Original filter button unavailable');
    S.invoke('UIButton','OnClick',button);
   }else{
    if(!showing||request.token!==token)throw Error('Current filter popup token required');
    if(action==='close')S.invoke('FilterSortSelectView','CloseButtonClicked',view);
    else{
     const choice=options.find(o=>o.index===request.index);
     if(!choice||choice.name!==request.name||choice.textInput!==(action==='search'))throw Error('Choose a current non-text filter or explicit search by index and name');
     if(action==='search'){
      if(typeof request.text!=='string'||!request.text.trim()||request.text.length>128||/[\u0000-\u001f]/.test(request.text))throw Error('Search text must contain 1..128 printable characters');
      const input=R.readRef(view,'_searchInputBox');
      if(!active(input)||R.readValue(view,'_inputIndex','i32')!==request.index)throw Error('Original text search input unavailable');
      S.invoke('FilterSortSelectView','TextBoxSelected',view,[R.arg.ref(S.gameObject(input)),R.arg.value('bool',true)]);
      S.invoke('UIInput','set_value',input,[R.arg.ref(R.string(request.text))],['System.String']);
      S.invoke('FilterSortSelectView','SelectionChanged',view);
      const actual=S.string(R.readRef(configs[request.index],'<TextString>k__BackingField'));
      if(actual!==request.text)throw Error('Original search input normalized or rejected text; inspect before retry');
     }
     if(!R.unbox(S.invoke('FilterSortSelectController','FilterIsSubmittable',controller,[R.arg.value('i32',request.index)]),'bool'))throw Error('Original filter is not submittable');
     S.invoke('FilterSortSelectController','HandleFilterSortItemSelected',controller,[R.arg.value('i32',request.index)]);
    }
   }
   return {callbackDispatched:true,action,expectedShowing:action==='open',expectedIndex:['select','search'].includes(action)?request.index:null};
  }
  if(['inventory-favorite-status','inventory-favorite-set'].includes(operation)){
   const state=current(),type=R.fullName(R.classOf(state));
   if(!['CharacterDetailsState','ShipDetailsState'].includes(type))throw Error('Original unit details required');
   const controller=R.readRef(state,'_controller'),data=R.readRef(controller,'_transitionData');
   const unit=R.readRef(data,type==='CharacterDetailsState'?'<Unit>k__BackingField':'Unit'),info=unitInfo(unit);
   if(info.unitId!==request?.unitId||info.loaned)throw Error('Current owned unit identity required');
   const inventory=R.readRef(R.findBound('InventoryDomainController'),'<Inventory>k__BackingField');
   const roster=R.readRef(inventory,'_unitRoster');
   if(list(R.readRef(roster,'_units')).filter(u=>u.equals(unit)).length!==1)throw Error('Unit is not in original player roster');
   const prefs=R.readRef(controller,'_serverPrefs'),baseId=R.readRef(R.readRef(unit,'<Definition>k__BackingField'),'BaseId');
   const read=()=>!!R.unbox(S.invoke('ServerPrefs','IsUnitFavorited',prefs,[R.arg.ref(baseId)],['System.String']),'bool');
   const before=read();
   if(operation==='inventory-favorite-status')return {readConfirmed:true,...info,favorite:before,serverPersistenceVerified:false};
   if(typeof request.favorite!=='boolean')throw Error('Explicit desired favorite boolean required');
   if(before===request.favorite)return {...info,favorite:before,alreadySelected:true,callbackDispatched:false,localStateConfirmed:true,serverPersistenceVerified:false};
   const viewType=type==='CharacterDetailsState'?'CharacterDetailsView':'ShipDetailsView';
   const view=R.readRef(controller,type==='CharacterDetailsState'?'_characterDetailsView':'_shipDetailsView'),button=R.readRef(view,'_favoriteUnitButton');
   if(button.isNull()||!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(button)),'bool')||!R.unbox(S.invoke('UIButton','get_isEnabled',button),'bool'))throw Error('Original favorite button unavailable');
   S.invoke(viewType,'ToggleFavoriteUnit',view);
   const after=read();
   return {...info,before,favorite:after,callbackDispatched:true,localStateConfirmed:after===request.favorite,serverPersistenceVerified:false,scope:'Original favorite callback and local preferences readback; persistence is owned by the original UI lifecycle'};
  }
  if(['inventory-skill','inventory-skill-close','inventory-skill-level','inventory-skill-quote'].includes(operation)){
   const state=current(),type=R.fullName(R.classOf(state));
   if(!['CharacterDetailsState','ShipDetailsState'].includes(type))throw Error('Skill command requires a unit detail page');
   const controller=R.readRef(state,'_controller'),info=detail(state);
   if(info.loading||!request||request.unitId!==info.unitId)throw Error('Skill command unit changed or missing unitId');
   if(operation==='inventory-skill-quote'){
    const panel=info.skillPopup,selected=panel?.selectedLevel;
    if(info.skillPopupError||panel?.kind!=='levels'||panel.skillId!==request.skillId||!selected||selected.tier!==request.tier)throw Error('Quote requires the current skill and selected tier');
    const costs=selected.materials;
    const complete=Array.isArray(costs)&&costs.every(m=>m.itemType===7&&typeof m.id==='string'&&m.id.length>0&&Number.isInteger(m.quantityRaw)&&m.quantityRaw>=0&&Number.isInteger(m.ownedQuantity)&&m.ownedQuantity>=0&&!m.inventoryError)&&Number.isInteger(selected.currencyCost)&&selected.currencyCost>=0&&Number.isInteger(selected.currencyOwned)&&selected.currencyOwned>=0&&!selected.currencyError&&(selected.currencyCost===0||selected.currencyType>0);
    return {readConfirmed:true,unitId:info.unitId,skillId:panel.skillId,abilityId:panel.abilityId,tier:selected.tier,levelText:selected.levelText,
     currency:{type:selected.currencyType,required:selected.currencyCost,owned:selected.currencyOwned,error:selected.currencyError||null},
     materials:costs,displayCostsComplete:complete,
     originalConditions:{allowUpgrade:panel.allowUpgrade,upgradeAvailable:selected.upgradeAvailable,upgradeStatus:selected.upgradeStatus,lockedByConditions:selected.lockedByConditions,requirements:selected.requirements},
     executionSupported:false,scope:'Current original UI cost snapshot; not a reservation, purchase authorization or server transaction quote'};
   }
   const popup=skillPopup(controller,type,true);
   if(operation==='inventory-skill-level'){
    if(!popup||popup.viewType!=='UnitDetailsSkillOverlayView')throw Error('Level selection requires the original multi-level popup');
    if(!Number.isInteger(request.tier)||request.tier< -1||request.tier>127)throw Error('Invalid skill tier');
    const data=R.readRef(popup.view,'_data');
    if(data.isNull()||S.string(R.readRef(data,'<SkillId>k__BackingField'))!==request.skillId)throw Error('Skill popup changed');
    const levels=list(R.readRef(data,'<AbilityLevelData>k__BackingField'));
    if(levels.length>128)throw Error('Skill level bound exceeded');
    const matches=levels.filter(level=>R.readValue(level,'<AbilityTier>k__BackingField','i32')===request.tier);
    if(matches.length!==1)throw Error('Choose one tier from the original popup levels');
    S.invoke('UnitDetailsSkillOverlayView','AbilityLevelButtonClicked',popup.view,[R.arg.ref(matches[0])]);
    return {expectedState:type,unitId:info.unitId,skillId:request.skillId,selectedTier:request.tier};
   }
   if(operation==='inventory-skill-close'){
    if(!popup)throw Error('No active original skill popup');
    S.invoke(popup.viewType,'OnBackClick',popup.view);
    return {expectedState:type,unitId:info.unitId,closing:true};
   }
   if(popup)throw Error('Close the current skill popup first');
   if(typeof request.skillId!=='string'||!request.skillId.length||request.skillId.length>256)throw Error('Invalid skillId');
   const matches=(displayRows(controller,type)||[]).filter(({data})=>S.string(R.readRef(data,'<SkillId>k__BackingField'))===request.skillId);
   if(matches.length!==1)throw Error('Choose one skill from the current original detail');
   const data=matches[0].data,owner=abilityOwner(controller,type);
   if(type==='CharacterDetailsState')S.invoke('CharacterDetailsAbilityController','AbilityClicked',owner,[R.arg.ref(R.readRef(data,'<AbilityId>k__BackingField'))],['System.String']);
   else S.invoke('ShipDetailsController','AbilityClicked',owner,[R.arg.ref(data)]);
   return {expectedState:type,unitId:info.unitId,skillId:request.skillId,name:S.string(R.readRef(data,'<NameText>k__BackingField'))};
  }
  if(operation==='inventory-back'){
   const state=current(),type=R.fullName(R.classOf(state));
   if(!['CharacterDetailsState','ShipDetailsState'].includes(type))throw Error('Back requires a character or ship detail page');
   const controller=R.readRef(state,'_controller');
   S.invoke(type==='CharacterDetailsState'?'CharacterDetailsController':'FeatureController','OnBackButtonClicked',controller);
   return {expectedState:'MasterInventoryGameState',effect:'original detail back callback'};
  }
  if(!['inventory-list','inventory-unit'].includes(operation))throw Error('Unsupported inventory action');
  const live=inventory();
  const domain=R.findBound('InventoryDomainController'),loadedInventory=R.readRef(domain,'<Inventory>k__BackingField');
  const roster=R.readRef(loadedInventory,'_unitRoster');
  const ownedIds=new Set(list(R.readRef(roster,'_units')).map(unit=>S.string(R.readRef(unit,'Id'))));
  const rows=live.rows.filter(row=>!row.isNull()).map(row=>({row,unit:R.readRef(row,'<Unit>k__BackingField')}))
   .filter(r=>!r.unit.isNull()&&ownedIds.has(S.string(R.readRef(r.unit,'Id'))));
  if(operation==='inventory-list')return {readConfirmed:true,kind:live.kind===1?'characters':'ships',units:rows.filter(r=>!r.unit.isNull()).map(r=>unitInfo(r.unit)),scope:'current player-roster units in the original filtered list; loaned marked; no configuration changes'};
  if(typeof request?.unitId!=='string'||!request.unitId.length||request.unitId.length>256)throw Error('Expected owned inventory unitId');
  const chosen=rows.filter(r=>!r.unit.isNull()&&S.string(R.readRef(r.unit,'Id'))===request.unitId);
  if(chosen.length!==1)throw Error('Choose one owned unit from the current filtered inventory list');
  S.invoke(live.kind===1?'CharacterInventoryController':'ShipInventoryController',live.kind===1?'HandleOnUnitTileClicked':'OnShipInventoryTileClicked',live.controller,[R.arg.ref(chosen[0].row)]);
  return {unitId:request.unitId,expectedState:live.kind===1?'CharacterDetailsState':'ShipDetailsState',effect:'original inventory tile callback'};
 }
 return {execute,detail,readiness(){try{inventory();return {ready:true};}catch(e){return {ready:false,reason:String(e)};}}};
})();

globalThis.InboxBridge=(()=>{
 const R=RuntimeApi,S=SceneApi;
 const submitted=new Set();
 const state=()=>R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
 function view(){
  const current=state();if(R.fullName(R.classOf(current))!=='InboxGameState')throw Error('Inbox page required');
  const controller=R.readRef(current,'_inboxController');if(controller.isNull())throw Error('Inbox loading');
  const inbox=R.readRef(controller,'_inboxView');
  if(inbox.isNull()||!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(inbox)),'bool'))throw Error('Inbox view not ready');
  return {controller,inbox};
 }
 function selectedDetail(live,message){
  const map=R.readRef(live.inbox,'_inboxDetailView');
  const args=[R.arg.value('i32',message.messageType)];
  const detail=R.invoke(R.findMethod(R.classOf(map),'get_Item',1),map,args);
  const type=R.fullName(R.classOf(detail));
  const rewardViews=['InboxRewardDetailView','InboxRankRewardsDetailView','InboxGuildRankedRewardDetailView','InboxGuildExchangeInboxDetailView','InboxParameterizedRewardDetailView','InboxTerritoryCovertMissionRewardDetailView','InboxTerritoryMapCompleteRewardDetailView','InboxTerritoryTournamentEventRewardDetailView','InboxTerritoryTournamentMatchRewardDetailView','InboxTerritoryTournamentRewardDetailView','InboxTerritoryWarCompleteRewardDetailView'];
  if(!rewardViews.includes(type))return {public:{type,rewardView:false},detail:null};
  const button=R.readRef(detail,'_actionButton'),target=R.readRef(button,'_buttonTarget');
  const labels=R.readRef(button,'_labels'),count=R.readValue(labels,'_size','i32'),items=R.readRef(labels,'_items');
  if(count<0||count>16||(items.isNull()?count!==0:count>items.add(24).readU64().toNumber()))throw Error('Action label bounds invalid');
  const text=[];for(let i=0;i<count;i++)text.push(S.string(S.invoke('UILabel','get_text',items.add(32+i*8).readPointer())));
  const active=o=>!!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(o)),'bool');
  return {detail,public:{type,rewardView:true,messageId:S.string(R.readRef(detail,'_messageId')),active:active(detail)&&active(button),enabled:!!R.unbox(S.invoke('UIButton','get_isEnabled',target),'bool'),buttonText:text}};
 }
 function execute(operation,payload={}){
  if(operation==='inbox-claim-status')return InboxClaimTracker.status();
  if(operation==='inbox-claim'){
   if(typeof payload.messageId!=='string'||!payload.messageId.length)throw Error('Explicit messageId required');
   const live=view(),rows=execute('inbox-list').messages.filter(m=>m.id===payload.messageId);
   if(rows.length!==1||!rows[0].selected)throw Error('Select the exact current reward message first');
   const message=rows[0],selected=selectedDetail(live,message),action=selected.public;
   if(!action.rewardView||action.messageId!==message.id||!action.active||!action.enabled||!message.rewards?.length||message.hasCustomAction)throw Error('Original reward action not ready');
   if(submitted.has(message.id))throw Error('Message claim already submitted in this session; inspect status, do not retry');
   const balanceBefore=InboxClaimTracker.readBalances(message.rewards);
   InboxClaimTracker.install();submitted.add(message.id);
   const tracking=InboxClaimTracker.submit({messageId:message.id,rewards:message.rewards,balanceBefore},live.controller,()=>S.invoke('BaseInboxRewardView','ActionButtonClicked',selected.detail));
   return {claimDispatched:true,tracking};
  }
  if(operation==='inbox-open'){
   const current=state();if(R.fullName(R.classOf(current))!=='HomeBaseGameState')throw Error('Open inbox from Home');
   S.invoke('HomeBaseController','OnInboxClicked',R.readRef(current,'_homeBaseController'));
   return {expectedState:'InboxGameState'};
  }
  const live=view();
  if(operation==='inbox-home'){
   S.invoke('FeatureController','OnBackButtonClicked',live.controller);
   return {expectedState:'HomeBaseGameState'};
  }
  if(!['inbox-list','inbox-select'].includes(operation))throw Error('Unsupported inbox command');
  const list=R.readRef(live.inbox,'_filterRenderData');
  if(list.isNull())throw Error('Inbox list not initialized');
  const count=R.readValue(list,'_size','i32'),items=R.readRef(list,'_items');
  if(count<0||count>4096||(items.isNull()?count!==0:count>items.add(24).readU64().toNumber()))throw Error('Inbox list bounds invalid');
  if(operation==='inbox-select'){
   if(typeof payload.messageId!=='string'||!payload.messageId.length||payload.messageId.length>256)throw Error('Explicit messageId required');
   const matches=[];
   for(let i=0;i<count;i++){const data=items.add(32+i*8).readPointer();if(S.string(R.readRef(data,'<Id>k__BackingField'))===payload.messageId)matches.push(data);}
   if(matches.length!==1)throw Error('Message absent or ambiguous in current filtered inbox');
   S.invoke('InboxView','SelectListItem',live.inbox,[R.arg.ref(matches[0])]);
   return {expectedState:'InboxGameState',expectedMessageId:payload.messageId};
  }
  const messages=[];
  for(let i=0;i<count;i++){
   const data=items.add(32+i*8).readPointer();
   const text=name=>S.string(R.readRef(data,'<'+name+'>k__BackingField'));
   const rewardList=R.readRef(data,'<ItemTile>k__BackingField');let rewards=null;
   if(!rewardList.isNull()){
    const n=R.readValue(rewardList,'_size','i32'),array=R.readRef(rewardList,'_items');
    if(n<0||n>256||(array.isNull()?n!==0:n>array.add(24).readU64().toNumber()))throw Error('Inbox reward list bounds invalid');
    rewards=[];
    for(let j=0;j<n;j++){
     const tile=array.add(32+j*8).readPointer(),renderType=R.fullName(R.classOf(tile));
     rewards.push({id:S.string(R.readRef(tile,'ID')),renderType,
      itemType:R.unbox(S.invoke(renderType,'get_ItemType',tile),'u8'),quantity:R.readValue(tile,'<Quantity>k__BackingField','i32')});
    }
   }
   messages.push({id:text('Id'),subject:text('Subject'),source:text('Source'),expires:text('ExpireTime'),
    message:text('Message'),actionLabel:text('ActionButtonLabel'),selected:!!R.readValue(data,'<ItemSelected>k__BackingField','bool'),
    messageType:R.readValue(data,'<MessageType>k__BackingField','i32'),
    hasCustomAction:!R.readRef(data,'<CustomButtonActionLink>k__BackingField').isNull(),rewards});
  }
  let detail=null;const selected=messages.filter(m=>m.selected);
  if(selected.length===1)try{detail=selectedDetail(live,selected[0]).public;}catch(error){detail={unavailable:true,error:String(error)};}
  return {readConfirmed:true,messages,selectedDetail:detail,scope:'Current original filtered inbox list; no claim/delete/custom action dispatched'};
 }
 return {execute,status(){try{const selected=execute('inbox-list').messages.filter(m=>m.selected);return {ready:true,selectedMessageId:selected.length===1?selected[0].id:null};}catch(error){return {ready:false,error:String(error)};}}};
})();

globalThis.InboxClaimTracker=(()=>{
 const R=RuntimeApi,S=SceneApi,records=[],closures=new Map(),hooks=[];
 const type='InboxController+<>c__DisplayClass49_0';let active=null,installed=false;
 function readBalances(rewards){
  if(!rewards?.length)return [];
  const inventory=R.findBound('InventoryDomainController'),totals=new Map();
  for(const r of rewards){
   if(typeof r.id!=='string'||!r.id||!Number.isSafeInteger(r.quantity)||r.quantity<=0)throw Error('Invalid reward quantity or identity');
   const key=JSON.stringify([r.itemType,r.id]),previous=totals.get(key);
   const expected=(previous?.expected||0)+r.quantity;
   if(!Number.isSafeInteger(expected))throw Error('Reward quantity overflow');
   totals.set(key,{id:r.id,itemType:r.itemType,expected});
  }
  return [...totals.values()].map(row=>{
   const {id,itemType}=row;
   try{
    let value;
    if(itemType===2){
     const code=R.unbox(S.invoke('System.Enum','Parse',R.nil,[R.arg.ref(S.type('CurrencyTypeEnum')),R.arg.ref(R.string(id))],['System.Type','System.String']),'i32');
     value=R.unbox(S.invoke('InventoryDomainController','GetCurrencyQuantity',inventory,[R.arg.value('i32',code)],['CurrencyTypeEnum']),'i32');
    }else if(itemType===7){
     value=R.unbox(S.invoke('InventoryDomainController','GetCraftingMaterialQuantity',inventory,[R.arg.ref(R.string(id))],['System.String']),'i32');
    }else return {...row,value:null,unavailable:'Unsupported reward item type'};
    return {...row,value};
   }catch(error){return {...row,value:null,unavailable:String(error)};}
  });
 }
 const expose=r=>{const {owner,target,handle,...result}=r;return {...result,rewardBalanceReconciled:r.rewardBalanceReconciled===true,
  settlementEvidence:r.rewardBalanceReconciled?'native-inventory-delta':r.outcome==='native-success-callback'?'native-success-callback':'unconfirmed'};};
 function finish(target,outcome){
  let r=closures.get(target.toString());
  // Calls made inside our main-thread dispatcher may not re-enter other
  // interceptor listeners. Correlate asynchronous result closures directly;
  // never require observing the synchronous service entry first.
  if(!r&&!target.isNull()&&R.fullName(R.classOf(target))===type){
   const owner=R.readRef(target,'<>4__this'),message=R.readRef(target,'messageDO');
   if(!message.isNull()){
    const id=S.string(R.readRef(message,'<Id>k__BackingField'));
    r=records.find(r=>r.messageId===id&&r.owner.equals(owner)&&r.outcome==='pending');
    if(r){r.target=target;r.handle=R.retain(target);closures.set(target.toString(),r);}
   }
  }
  if(r&&r.outcome==='pending'){r.nativeCallbackObserved=true;r.outcome=outcome;r.finishedAt=new Date().toISOString();}
 }
 function release(target){const r=closures.get(target.toString());if(r){closures.delete(target.toString());R.release(r.handle);r.handle=null;r.target=null;}}
 function install(){
  if(installed)return;
  const entries=[['PlayerService','UpdateInbox',7,{
   onEnter(args){let record=null;try{
    const messageId=S.string(args[1]);record=records.find(r=>r.messageId===messageId&&r.outcome==='pending'&&!r.nativeTransactionObserved);
    if(!record)return;
    const target=R.readRef(args[5],'m_target'),failed=R.readRef(args[6],'m_target');
    record.callbackCheck={action:args[2].toInt32(),targetType:target.isNull()?null:R.fullName(R.classOf(target)),sameTarget:target.equals(failed)};
    if(args[2].toInt32()!==2||target.isNull()||!target.equals(failed)||R.fullName(R.classOf(target))!==type||!R.readRef(target,'<>4__this').equals(record.owner))return;
    const message=R.readRef(target,'messageDO');if(S.string(R.readRef(message,'<Id>k__BackingField'))!==record.messageId)return;
    if(closures.has(target.toString()))throw Error('Duplicate native inbox transaction');
    record.target=target;record.handle=R.retain(target);record.nativeTransactionObserved=true;closures.set(target.toString(),record);
   }catch(error){if(record)record.trackingError=String(error);}}
  }],
  [type,'<UpdateInbox>b__0',0,{onEnter(args){this.target=args[0];finish(this.target,'native-success-callback');},onLeave(){release(this.target);}}],
  [type,'<UpdateInbox>b__1',1,{onEnter(args){this.target=args[0];finish(this.target,'native-failure-callback');},onLeave(){release(this.target);}}]];
  // submit invokes the native UI immediately in this same JS callback. Make
  // all observers effective before the native transaction can run.
  try{const resolved=entries.map(([t,m,n,cb])=>[R.findMethod(R.findClass(t),m,n).readPointer(),cb]);for(const [p,cb] of resolved)hooks.push(Interceptor.attach(p,cb));Interceptor.flush();installed=true;}
  catch(error){for(const h of hooks.splice(0))h.detach();throw error;}
 }
 function submit(info,owner,callback){
  install();if(active||records.length>=256)throw Error('Inbox tracking busy or full');
  const r={...info,owner,id:String(records.length+1),outcome:'pending',nativeTransactionObserved:false,submittedAt:new Date().toISOString()};
  records.push(r);active=r;
  try{callback();return expose(r);}catch(error){r.invocationError=String(error);throw error;}finally{active=null;}
 }
 function status(){
  for(const r of records)if(r.balanceBefore&&!r.rewardBalanceReconciled)try{
   r.balanceAfter=readBalances(r.rewards);
   r.balanceComparison=r.balanceBefore.map(b=>{
    const a=r.balanceAfter.find(a=>a.id===b.id&&a.itemType===b.itemType);
    const delta=Number.isSafeInteger(b.value)&&Number.isSafeInteger(a?.value)?a.value-b.value:null;
    return {id:b.id,itemType:b.itemType,expected:b.expected,delta,matched:delta!==null&&delta===b.expected};
   });
   r.rewardBalanceReconciled=r.balanceBefore.length>0&&r.balanceAfter.length===r.balanceBefore.length&&r.balanceComparison.every(b=>b.matched);
  }catch(error){r.balanceReadError=String(error);}
  return {readConfirmed:true,claims:records.map(expose),scope:'Original callback outcomes and native currency/material inventory deltas; unsupported rewards remain unconfirmed. Deltas cannot exclude unrelated concurrent inventory changes. Never automatically retry pending or uncertain claims.'};
 }
 function dispose(){for(const h of hooks.splice(0))h.detach();for(const r of [...closures.values()])release(r.target);installed=false;return status();}
 return {install,submit,status,dispose,readBalances};
})();

// Observe only closures captured while our exact original claim call is running.
// No callback replacement, synthetic completion, or repeated transaction.
globalThis.QuestClaimTracker=(()=>{
 const R=RuntimeApi,S=SceneApi,records=[],closures=new Map(),hooks=[];
 let active=null,installed=false;
 const closureType='ObjectivesQuestSubController+<>c__DisplayClass17_0';
 function install(){
  if(installed)return;
  const entries=[
   ['EpisodeDomainController','ClaimQuestsAndHeadlines',5,{
    onEnter(args){
     if(!active)return;
     try{
      const ids=args[1],headline=args[2];
      if(ids.isNull()||!headline.isNull()||R.readValue(ids,'_size','i32')!==1)return;
      const items=R.readRef(ids,'_items');
      if(items.isNull()||items.add(24).readU64().toNumber()<1||S.string(items.add(32).readPointer())!==active.questId)return;
      const target=R.readRef(args[3],'m_target'),failureTarget=R.readRef(args[4],'m_target');
      if(target.isNull()||!target.equals(failureTarget)||R.fullName(R.classOf(target))!==closureType||!R.readRef(target,'<>4__this').equals(active.owner))return;
      if(active.nativeTransactionObserved)throw Error('Multiple native transactions during one claim dispatch');
      if(closures.has(target.toString()))throw Error('Claim closure already tracked');
      active.handle=R.retain(target);closures.set(target.toString(),active);active.closure=target;active.nativeTransactionObserved=true;
     }catch(error){active.trackingError=String(error);}
    }
   }],
   [closureType,'<CallClaimQuestsAndHeadlines>b__0',2,{onEnter(args){this.claimTarget=args[0];finish(args[0],'native-success-callback');},onLeave(){releaseTarget(this.claimTarget);}}],
   [closureType,'<CallClaimQuestsAndHeadlines>b__1',1,{onEnter(args){this.claimTarget=args[0];finish(args[0],'native-failure-callback');},onLeave(){releaseTarget(this.claimTarget);}}]
  ];
  try{
   // Resolve all original methods before installing any hook.
   const resolved=entries.map(([type,name,n,callbacks])=>[R.findMethod(R.findClass(type),name,n).readPointer(),callbacks]);
   for(const [address,callbacks] of resolved)hooks.push(Interceptor.attach(address,callbacks));
   // submit may invoke native code before this JS turn returns. Commit hooks
   // now so the transaction and even synchronous callbacks cannot be missed.
   Interceptor.flush();
   installed=true;
  }catch(error){for(const hook of hooks.splice(0))hook.detach();throw error;}
 }
 function finish(target,outcome){
  const record=closures.get(target.toString());if(!record)return;
  if(record.outcome!=='pending')return;
  record.outcome=outcome;record.finishedAt=new Date().toISOString();
 }
 function publicRecord(record){
  const {owner,closure,handle,...plain}=record;return {...plain,rewardConfirmed:false};
 }
 function releaseTarget(target){
  if(!target)return;const key=target.toString(),record=closures.get(key);if(!record)return;
  closures.delete(key);R.release(record.handle);record.handle=null;record.closure=null;
 }
 function dispose(){
  for(const hook of hooks.splice(0))hook.detach();
  for(const record of [...closures.values()])releaseTarget(record.closure);
  installed=false;return {readConfirmed:true,claims:records.map(publicRecord),trackingStopped:true};
 }
 function submit(info,owner,callback){
  install();if(active)throw Error('Nested claim dispatch rejected');
  if(records.length>=256)throw Error('Claim tracking session capacity reached');
  const record={...info,id:String(records.length+1),owner,outcome:'pending',nativeTransactionObserved:false,submittedAt:new Date().toISOString()};
  records.push(record);active=record;
  try{callback();return publicRecord(record);}catch(error){record.invocationError=String(error);throw error;}finally{active=null;}
 }
 function status(){install();return {readConfirmed:true,trackingInstalled:installed,claims:records.map(publicRecord),scope:'Native callback observation only; reward balances are not reconciled. Never retry pending or uncertain claims automatically.'};}
 return {install,submit,status,dispose};
})();

globalThis.ObjectivesBridge=(()=>{
 const R=RuntimeApi,S=SceneApi;
 const submittedClaims=new Set();
 const state=()=>R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
 function view(){
  const current=state();if(R.fullName(R.classOf(current))!=='ObjectivesGameState')throw Error('Objectives page required');
  const controller=R.readRef(current,'_objectivesController');if(controller.isNull())throw Error('Objectives loading');
  const objectives=R.readRef(controller,'_view');
  if(objectives.isNull()||!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(objectives)),'bool'))throw Error('Objectives view not ready');
  return {controller,objectives};
 }
 function execute(operation,payload){
  if(operation==='events-back'){
   const current=state();if(R.fullName(R.classOf(current))!=='EventsParentGameState')throw Error('Events page required');
   S.invoke('FeatureController','OnBackButtonClicked',R.readRef(current,'_eventsParentController'));
   return {fromState:'EventsParentGameState',backDispatched:true};
  }
  if(operation==='objectives-claim-status')return QuestClaimTracker.status();
  if(operation==='objectives-open'){
   const current=state();if(R.fullName(R.classOf(current))!=='HomeBaseGameState')throw Error('Open objectives from Home');
   S.invoke('HomeBaseController','OnNextMissionClicked',R.readRef(current,'_homeBaseController'));
   return {expectedState:'ObjectivesGameState'};
  }
  const live=view();
  if(operation==='objectives-home'){
   S.invoke('FeatureController','OnBackButtonClicked',live.controller);
   return {expectedState:'HomeBaseGameState'};
  }
  if(operation==='objectives-achievements'||operation==='objectives-daily'){
   const tab=operation==='objectives-achievements'?3:2,subTab=tab===3?0:1;
   if(!R.unbox(S.invoke('ObjectivesController','IsTabVisible',live.controller,[R.arg.value('i32',tab)]),'bool'))throw Error('Objectives tab not visible');
   if(subTab&&!R.unbox(S.invoke('ObjectivesController','IsSubTabVisible',live.controller,[R.arg.value('i32',subTab)]),'bool'))throw Error('Objectives subtab not visible');
   const location=S.invoke('ObjectivesView','GetTabLocation',live.objectives,[R.arg.value('i32',tab),R.arg.value('i32',subTab)]);
   // AccordionLocation is two int32 fields; preserve the original returned bits.
   // Original TabClicked checks locks and updates both accordion and content.
   S.invoke('ObjectivesView','TabClicked',live.objectives,[R.arg.value('i64',R.unbox(location,'i64')),R.arg.ref(null)]);
   return {expectedState:'ObjectivesGameState',tab,subTab};
  }
  if(!['objectives-list','objectives-claim','objectives-go'].includes(operation))throw Error('Unsupported objectives command');
  const tab=R.readValue(live.controller,'_currentTabType','i32'),subTab=R.readValue(live.controller,'_currentSubTabType','i32');
  const achievements=tab===3;
  if(!achievements&&(tab!==2||subTab!==1))throw Error('Current objectives tab is not supported for reading');
  const sub=R.readRef(live.controller,achievements?'_achievementsSubController':'_dailyQuestSubController');
  const data=R.readRef(sub,'_renderData'),subView=R.readRef(sub,achievements?'_achievementsSubView':'_dailyQuestSubView');
  if(data.isNull()||subView.isNull()||!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(subView)),'bool'))throw Error('Objectives subview not ready');
  const list=achievements?R.readRef(subView,'_achievementListRenderData'):R.readRef(data,'ActiveQuests');if(list.isNull())throw Error('Quests not initialized');
  const count=R.readValue(list,'_size','i32'),items=R.readRef(list,'_items');
  if(count<0||count>4096||(items.isNull()?count!==0:count>items.add(24).readU64().toNumber()))throw Error('Quest list bounds invalid');
  const quests=[],rows=[];
  for(let i=0;i<count;i++){
   const row=items.add(32+i*8).readPointer();rows.push(row);
   const text=name=>S.string(R.readRef(row,'<'+name+'>k__BackingField'));
   const value=(name,type)=>R.readValue(row,'<'+name+'>k__BackingField',type);
   const link=R.readRef(row,'<ActionLink>k__BackingField');
   const actionLink=link.isNull()?null:{type:R.readValue(link,'<ActionLinkType>k__BackingField','i32'),location:R.readValue(link,'<Location>k__BackingField','i32')};
   const rewardList=R.readRef(row,'<Rewards>k__BackingField');let rewards=null;
   if(!rewardList.isNull()){
    const n=R.readValue(rewardList,'_size','i32'),array=R.readRef(rewardList,'_items');
    if(n<0||n>256||(array.isNull()?n!==0:n>array.add(24).readU64().toNumber()))throw Error('Quest reward list bounds invalid');
    rewards=[];
    for(let j=0;j<n;j++){
     const tile=array.add(32+j*8).readPointer();
     if(tile.isNull())throw Error('Quest reward tile missing');
     const renderType=R.fullName(R.classOf(tile));
     rewards.push({id:S.string(R.readRef(tile,'ID')),renderType,
      itemType:R.unbox(S.invoke(renderType,'get_ItemType',tile),'u8'),quantity:R.readValue(tile,'<Quantity>k__BackingField','i32')});
    }
   }
   quests.push({hasLink:!!value('HasLink','bool'),actionLink,rewards,id:text('Id'),description:text('Description'),progressText:text('ProgressText'),
    currentProgress:String(value('CurrentProgress','i64')),targetProgress:String(value('TargetProgress','i64')),
    readyForClaim:!!value('ReadyForClaim','bool'),claimDisabled:!!value('ClaimDisabled','bool'),
    claimDisabledMessageKey:text('ClaimDisabledMessageKey'),
    claimRequirementMet:!!R.unbox(S.invoke('QuestSlatRenderData','get_ClaimRequirementMet',row),'bool')});
  }
  if(['objectives-claim','objectives-go'].includes(operation)){
   if(typeof payload?.questId!=='string'||!payload.questId.length||payload.questId.length>256||payload.tab!==tab||payload.subTab!==subTab)throw Error('Claim request must match current objectives tab and quest ID');
   const matches=quests.map((q,i)=>({q,i})).filter(x=>x.q.id===payload.questId);
   if(matches.length!==1)throw Error('Claim requires a unique current quest');
   const {q,i}=matches[0];
   if(operation==='objectives-go'){
    if(!q.hasLink||q.actionLink?.type!==0||![12,23,35].includes(q.actionLink.location))throw Error('Quest link is not a verified internal event navigation');
    if(R.readValue(sub,'_wasShutDown','bool')||!R.readRef(sub,'_transitionToken').isNull())throw Error('Original quest controller is busy or shut down');
    const link=R.readRef(rows[i],'<ActionLink>k__BackingField');
    if(!R.unbox(S.invoke('ActionLinkDO','IsValid',link),'bool'))throw Error('Original quest link invalid');
    S.invoke(achievements?'ObjectivesAchievementsSubController':'ObjectivesDailyQuestSubController','HandleGoButtonClicked',sub,[R.arg.ref(link)],['ActionLinkDO']);
    return {expectedState:'EventsParentGameState',questId:q.id,location:q.actionLink.location};
   }
   if(!q.readyForClaim||q.claimDisabled||!q.claimRequirementMet)throw Error('Original quest is not eligible for claim');
   if(R.readValue(sub,'_wasShutDown','bool')||!R.readRef(sub,'_transitionToken').isNull())throw Error('Original quest controller is busy or shut down');
   const dailyResetTimestamp=achievements?null:String(R.readValue(data,'DailyResetTimestamp','i64'));
   if(Object.prototype.hasOwnProperty.call(payload,'dailyResetTimestamp')&&payload.dailyResetTimestamp!==dailyResetTimestamp)throw Error('Original daily quest period changed; refresh the list');
   const key=JSON.stringify([tab,subTab,q.id,dailyResetTimestamp]);
   if(submittedClaims.has(key))throw Error('Claim already submitted in this host session; inspect outcome, do not retry');
   // Reserve before invoking: exceptions or lost replies must not replay a claim.
   QuestClaimTracker.install();
   submittedClaims.add(key);
   const tracking=QuestClaimTracker.submit({questId:q.id,tab,subTab,dailyResetTimestamp},sub,()=>S.invoke(achievements?'ObjectivesAchievementsSubController':'ObjectivesDailyQuestSubController','HandleClaimButtonClicked',sub,[R.arg.ref(R.readRef(rows[i],'<Id>k__BackingField'))],['System.String']));
   return {claimDispatched:true,rewardConfirmed:false,trackingId:tracking.id,questId:q.id,tab,subTab,dailyResetTimestamp,
    scope:'Original reward button callback invoked; asynchronous server outcome is not confirmed. No automatic retry.'};
  }
  if(achievements)return {readConfirmed:true,tab,subTab,quests,scope:'Current original achievement list; no claim dispatched'};
  return {readConfirmed:true,tab,subTab,quests,
   dailyResetTimestamp:String(R.readValue(data,'DailyResetTimestamp','i64')),
   total:R.readValue(data,'TotalQuests','i32'),completed:R.readValue(data,'CompletedQuests','i32'),
   allDailiesClaimable:!!R.readValue(data,'AllDailiesClaimable','bool'),allDailiesCompleted:!!R.readValue(data,'AllDailiesCompleted','bool'),
   scope:'Current original daily quest UI; no reward claim dispatched'};
 }
 return {execute,status(){try{const live=view();return {ready:true,tab:R.readValue(live.controller,'_currentTabType','i32'),subTab:R.readValue(live.controller,'_currentSubTabType','i32')};}catch(error){return {ready:false,error:String(error)};}}};
})();

globalThis.EventsBridge=(()=>{
 const R=RuntimeApi,S=SceneApi;
 const active=v=>!v.isNull()&&!!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(v)),'bool');
 function parentContext(){
  const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
  if(R.fullName(R.classOf(state))!=='EventsParentGameState')throw Error('Events page required');
  const controller=R.readRef(state,'_eventsParentController');
  return {controller,tab:R.readValue(controller,'_currentTabType','i32')};
 }
 function context(){
  const {controller}=parentContext();
  if(R.readValue(controller,'_currentTabType','i32')!==4)throw Error('Challenges tab required');
  const sub=R.readRef(controller,'_challengesSubController');
  return {controller,sub,view:R.readRef(sub,'_challengeView'),missions:R.readRef(sub,'_eventsMissionView')};
 }
 function list(value){
  if(value.isNull())throw Error('Event list not loaded');
  const n=R.readValue(value,'_size','i32'),items=R.readRef(value,'_items');
  if(n<0||n>2048||(items.isNull()?n!==0:n>items.add(24).readU64().toNumber()))throw Error('Event list bounds invalid');
  return Array.from({length:n},(_,i)=>items.add(32+8*i).readPointer());
 }
 function execute(operation,payload){
  if(operation==='events-enter'){
   const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
   if(R.fullName(R.classOf(state))!=='HomeBaseGameState')throw Error('Original Home required');
   const props=S.all('SelectableCantinaV2Prop').filter(p=>active(p)&&R.readValue(p,'_prop','i32')===10);
   if(props.length!==1)throw Error('Expected unique visible Events prop');
   S.invoke('HomeBaseController','OnEventsClicked',R.readRef(state,'_homeBaseController'),[R.arg.value('i32',R.readValue(props[0],'_propState','i32'))]);
   return {expectedState:'EventsParentGameState'};
  }
  if(operation==='events-challenges'){
   const {controller}=parentContext(),view=R.readRef(controller,'_eventsParentView');
   if(!active(view))throw Error('Events tabs not active');
   S.invoke('EventsParentView','ManuallySelectTab',view,[R.arg.value('i32',4)],['EventsTabType']);
   return {expectedState:'EventsParentGameState',expectedTab:4};
  }
  const c=context();
  if(operation==='events-mission-select'){
   if(typeof payload?.eventId!=='string'||!payload.eventId.length||typeof payload?.missionId!=='string'||!payload.missionId.length)throw Error('Mission identity required');
   const current=execute('events-missions');
   if(current.eventId!==payload.eventId)throw Error('Current event changed');
   const matches=current.missions.filter(m=>m.id===payload.missionId);
   if(matches.length!==1)throw Error('Expected unique current mission');
   const mission=matches[0];
   if(![2,3,4,5,6].includes(mission.progressStatus)||!mission.hasMetUnitRequirements)throw Error('Original mission locked or requirements unmet');
   if(mission.currencyAmount!==0)throw Error('Currency-cost mission requires separate authorization');
   if(mission.cooldown===null||mission.cooldown.active||mission.cooldown.maxAttemptsReached)throw Error('Mission attempt/cooldown unavailable or exhausted');
   const rows=list(R.readRef(c.missions,'_missions'));
   const row=rows.find(r=>S.string(R.readRef(r,'<Id>k__BackingField'))===payload.missionId);
   S.invoke('EventsMissionView','MissionSelected',c.missions,[R.arg.ref(row)],['CampaignMapMissionsListItemRendererData']);
   return {expectedState:'PvePreBattleState',eventId:current.eventId,missionId:payload.missionId};
  }
  if(operation==='events-missions'){
   if(!active(c.missions))throw Error('Event missions not active');
   const event=R.readRef(c.sub,'_event');if(event.isNull())throw Error('Current event unavailable');
   const missions=list(R.readRef(c.missions,'_missions')).map(row=>{
    const str=n=>S.string(R.readRef(row,'<'+n+'>k__BackingField'));
    const value=(n,type='i32')=>R.readValue(row,'<'+n+'>k__BackingField',type);
    const cd=R.readRef(row,'<CooldownRenderDataObject>k__BackingField');let cooldown=null;
    if(!cd.isNull()){
     const cv=(n,type='i32')=>R.readValue(cd,'<'+n+'>k__BackingField',type);
     cooldown={hasCooldown:!!cv('HasCoolDown','bool'),active:!!cv('CoolDownActive','bool'),maxAttempts:cv('MaxAttempts'),currentAttemptCount:cv('CurrentAttemptCount'),maxAttemptsReached:!!R.unbox(S.invoke('CooldownRenderData','MaxAttemptsReached',cd),'bool'),canBuyRefresh:!!cv('CanBuyRefresh','bool')};
    }
    return {id:str('Id'),title:str('Title'),subtitle:str('SubTitle'),progressStatus:value('ProgressStatus'),hasMetUnitRequirements:!!value('HasMetUnitRequirements','bool'),
     energyType:value('EnergyType'),energy:value('Energy'),currencyType:value('CurrencyType'),currencyAmount:value('CurrencyAmount'),
     selectLabel:str('SelectButtonLocalizationValue'),unlockRequirement:str('UnlockRequirementLocalizationValue'),
     grindTicketsEnabled:!!value('GrindTicketsEnabledForMission','bool'),playerMeetsGrindTicketRequirements:!!value('PlayerMeetsGrindTicketRequirements','bool'),cooldown};
   });
   return {readConfirmed:true,eventId:S.string(R.readRef(event,'<Id>k__BackingField')),missions,scope:'Original mission UI values; no battle, sweep or refresh dispatched'};
  }
  if(operation==='events-missions-back'){
   if(!active(c.missions))throw Error('Event missions not active');
   S.invoke('SoloEventsSubController','BackFromEventsMissionView',c.sub);return {expectedState:'EventsParentGameState',listExpected:true};
  }
  if(!['events-list','events-open'].includes(operation))throw Error('Unsupported events command');
  if(!active(c.view)||active(c.missions))throw Error('Challenge list not active');
  const rows=list(R.readRef(c.view,'_eventItemRenderData'));
  const events=rows.map(row=>{
   const str=n=>S.string(R.readRef(row,'<'+n+'>k__BackingField'));
   const flag=n=>!!R.readValue(row,'<'+n+'>k__BackingField','bool');
   return {eventId:str('EventId'),instanceId:str('EventInstanceId'),title:str('TitleText'),description:str('EventDescription'),
    locked:flag('IsLocked'),featureLocked:flag('FeatureLocked'),meetsUnitOwnedRequirement:flag('MeetsUnitOwnedRequirement'),hasAnyAllowedUnit:flag('HasAnyAllowedUnit'),lockText:str('LockString')};
  });
  if(operation==='events-list')return {readConfirmed:true,events};
  if(typeof payload?.eventId!=='string'||!payload.eventId.length||typeof payload.instanceId!=='string')throw Error('Event identity required');
  const indices=events.flatMap((e,i)=>e.eventId===payload.eventId&&e.instanceId===payload.instanceId?[i]:[]);
  if(indices.length!==1)throw Error('Expected unique current event');
  const index=indices[0],event=events[index],backing=list(R.readRef(c.sub,'_eventData'));
  if(!backing[index]||!rows[index].equals(backing[index]))throw Error('Event view/controller ordering mismatch');
  if(event.locked||event.featureLocked||!event.meetsUnitOwnedRequirement||!event.hasAnyAllowedUnit)throw Error('Original event entry is locked or unit requirements unmet');
  S.invoke('SoloEventsSubView','OnEventClicked',c.view,[R.arg.value('i32',index)]);
  return {expectedState:'EventsParentGameState',eventId:event.eventId,instanceId:event.instanceId};
 }
 function status(){try{
  const {controller,tab}=parentContext();
  if(tab!==4)return {ready:active(R.readRef(controller,'_eventsParentView')),tab,listSupported:false};
  const c=context(),event=R.readRef(c.sub,'_event');
  return {ready:true,tab,listSupported:true,listActive:active(c.view)&&!active(c.missions),missionsActive:active(c.missions),eventId:event.isNull()?null:S.string(R.readRef(event,'<Id>k__BackingField'))};
 }catch(error){return {ready:false,error:String(error)};}}
 return {execute,status};
})();

globalThis.CampaignMissionBridge=(()=>{
 const R=RuntimeApi,S=SceneApi;
 let submission=null;
 const ticketBalance=()=>R.unbox(S.invoke('InventoryDomainController','GetCurrencyQuantity',R.findBound('InventoryDomainController'),[R.arg.value('i32',10)],['CurrencyTypeEnum']),'i32');
 const active=o=>!o.isNull()&&!!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(o)),'bool');
 function current(){
  const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
  if(state.isNull()||R.fullName(R.classOf(state))!=='CampaignGameState')throw Error('Original campaign map required');
  const campaign=R.readRef(state,'_campaignController'),details=R.readRef(campaign,'_missionsDetailsController');
  if(details.isNull())throw Error('Mission details not ready');
  const component=R.readRef(details,'_missionDetailsComponent'),mission=R.readRef(details,'_selectedMission');
  if(component.isNull()||mission.isNull()||!mission.equals(R.readRef(component,'_mission')))throw Error('Current mission detail ownership mismatch');
  const element=R.readRef(mission,'<CampaignElementDO>k__BackingField'),id=R.readRef(element,'<ElementIdentifierDO>k__BackingField');
  if(id.isNull())throw Error('Mission identifier unavailable');
  const missionIdentity={};
  for(const name of ['CampaignID','MapID','NodeID','MissionID'])missionIdentity[name]=S.string(S.invoke('CampaignElementIdentifierDO','get_'+name,id));
  missionIdentity.Difficulty=R.unbox(S.invoke('CampaignElementIdentifierDO','get_Difficulty',id),'u8');
  const button=R.readRef(component,'_selectMissionButton'),target=button.isNull()?R.nil:R.readRef(button,'_buttonTarget');
  const locked=!!R.readValue(details,'_selectedMissionIsLocked','bool')||!!R.readValue(component,'_missionLocked','bool');
  const enabled=active(component)&&active(button)&&!target.isNull()&&!!R.unbox(S.invoke('UIButton','get_isEnabled',target),'bool');
  return {details,component,mission,public:{readConfirmed:true,missionIdentity,locked,enabled,hasAllowedUnit:!!R.readValue(component,'_userHasAtLeastOneAllowedUnit','bool'),scope:'Current original map mission details; selection enters prebattle, not combat'}};
 }
 function execute(operation,payload){
  if(operation==='campaign-sweep-receipt'){
   if(submission&&!submission.ticketDebitObserved){
    try{const after=ticketBalance();submission.ticketsAfter=after;submission.ticketDebitObserved=submission.ticketsBefore-after===submission.ticketCost;}catch(e){submission.readError=String(e);}
   }
   return {readConfirmed:true,receipt:submission?{...submission}:null,settlementConfirmed:false,note:'Ticket delta alone is not reward settlement; never retry an uncertain submission.'};
  }
  if(operation==='campaign-difficulty'){
   if(![1,2].includes(payload?.difficulty))throw Error('Normal or hard difficulty required');
   const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
   if(state.isNull()||R.fullName(R.classOf(state))!=='CampaignGameState')throw Error('Original campaign map required');
   const view=R.readRef(R.readRef(state,'_campaignController'),'_campaignMissionsView');
   if(!active(view))throw Error('Original campaign view not active');
   const campaign=R.readRef(view,'_campaign');
   if(campaign.isNull()||S.string(R.readRef(campaign,'Id'))!==payload.campaignId)throw Error('Campaign identity changed');
   const list=R.readRef(campaign,'CampaignMaps'),count=R.readValue(list,'_size','i32'),maps=S.array(R.readRef(list,'_items')),index=R.readValue(view,'_selectedMapIndex','i32');
   if(count<1||count>1024||maps.length<count||index<0||index>=count)throw Error('Original map bounds');
   if(S.string(R.readRef(maps[index],'Id'))!==payload.mapId)throw Error('Current chapter changed');
   const expected={expectedCampaignId:payload.campaignId,expectedMapId:payload.mapId,expectedDifficulty:payload.difficulty};
   if(R.readValue(view,'_selectedDifficulty','u8')===payload.difficulty)return {...expected,alreadySelected:true,navigationDispatched:false};
   const unlocked=R.unbox(S.invoke('CampaignMissionsView','DifficultyIsUnlockedForMap',view,[R.arg.value('u8',payload.difficulty),R.arg.value('i32',index)],['CampaignNodeDifficultyEnum','System.Int32']),'bool');
   if(!unlocked)throw Error('Original difficulty locked');
   const button=R.readRef(view,payload.difficulty===1?'_normalDifficultyButton':'_hardDifficultyButton');
   if(!active(button))throw Error('Original difficulty button unavailable');
   const target=R.readRef(button,'_buttonTarget');
   if(target.isNull()||!R.unbox(S.invoke('UIButton','get_isEnabled',target),'bool'))throw Error('Original difficulty button disabled');
   const method=payload.difficulty===1?'OnNormalDifficultyClick':'OnHardDifficultyClick';
   S.invoke('CampaignMissionsView',method,view);
   return {...expected,navigationDispatched:true,invoked:'CampaignMissionsView.'+method};
  }
  if(operation==='campaign-node'){
   const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
   if(state.isNull()||R.fullName(R.classOf(state))!=='CampaignGameState')throw Error('Original campaign map required');
   const view=R.readRef(R.readRef(state,'_campaignController'),'_campaignMissionsView');
   if(!active(view))throw Error('Original campaign view not active');
   const wanted=payload?.missionIdentity,keys=['CampaignID','MapID','NodeID','MissionID','Difficulty'];
   if(!wanted||keys.some(k=>k==='Difficulty'?!Number.isInteger(wanted[k]):typeof wanted[k]!=='string'||!wanted[k].length))throw Error('Full mission identity required');
   const bounded=list=>{
    if(list.isNull())throw Error('Original mission list unavailable');
    const n=R.readValue(list,'_size','i32'),items=S.array(R.readRef(list,'_items'));
    if(n<0||n>1024||items.length<n)throw Error('Original mission list bounds');
    return items.slice(0,n);
   };
   const missions=bounded(S.invoke('CampaignMissionsView','GetMissionsForSelectedMap',view)),matches=[];
   missions.forEach((mission,index)=>{
    const id=R.readRef(R.readRef(mission,'<CampaignElementDO>k__BackingField'),'<ElementIdentifierDO>k__BackingField');
    if(id.isNull())throw Error('Mission identifier unavailable');
    const identity={};
    for(const k of keys)identity[k]=k==='Difficulty'?R.unbox(S.invoke('CampaignElementIdentifierDO','get_'+k,id),'u8'):S.string(S.invoke('CampaignElementIdentifierDO','get_'+k,id));
    if(keys.every(k=>identity[k]===wanted[k]))matches.push(index);
   });
   if(matches.length!==1)throw Error('Unique mission in current chapter and difficulty required');
   const index=matches[0],nodes=bounded(R.readRef(R.readRef(view,'_holoTable'),'_holoTableNodes')),node=nodes[index];
   if(!node||node.isNull()||!active(node)||R.readValue(node,'_index','i32')!==index||R.unbox(S.invoke('HoloTableNode','get_SuppressNode',node),'bool'))throw Error('Original node unavailable');
   const nodeState=R.unbox(S.invoke('HoloTableNode','GetState',node),'i32');
   if(![1,2].includes(nodeState))throw Error('Original node locked');
   // Original repeated click deselects the node. A select command is idempotent.
   if(R.readValue(view,'_selectedMissionIndex','i32')===index&&nodeState===2)return {navigationDispatched:false,alreadySelected:true,expectedMissionIdentity:{...wanted},expectedMissionIndex:index};
   // Original NodeClicked 0x1813BE2B0 rejects disabled nodes and updates details.
   S.invoke('HoloTableNode','OnClick',node);
   return {navigationDispatched:true,expectedMissionIdentity:{...wanted},expectedMissionIndex:index,invoked:'HoloTableNode.OnClick'};
  }
  if(operation==='campaign-stage'){
   const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
   if(state.isNull()||R.fullName(R.classOf(state))!=='CampaignGameState')throw Error('Original campaign map required');
   const controller=R.readRef(state,'_campaignController'),view=R.readRef(controller,'_campaignMissionsView');
   if(!active(view))throw Error('Original campaign view not active');
   const campaign=R.readRef(view,'_campaign');
   if(campaign.isNull()||S.string(R.readRef(campaign,'Id'))!==payload?.campaignId)throw Error('Campaign identity changed');
   const list=R.readRef(campaign,'CampaignMaps');
   const count=R.readValue(list,'_size','i32'),items=S.array(R.readRef(list,'_items'));
   if(count<1||count>1024||items.length<count)throw Error('Invalid campaign map bounds');
   const matches=[];
   for(let i=0;i<count;i++)if(S.string(R.readRef(items[i],'Id'))===payload.mapId)matches.push(i);
   if(matches.length!==1)throw Error('Unique original campaign map required');
   const index=matches[0];
   S.invoke('CampaignMissionsView','OnStageButtonClicked',view,[R.arg.value('i32',index)],['System.Int32']);
   return {navigationDispatched:true,expectedCampaignId:payload.campaignId,expectedMapId:payload.mapId,expectedMapIndex:index,invoked:'CampaignMissionsView.OnStageButtonClicked'};
  }
  const live=current(),info=live.public;
  if(['campaign-sweep-rewards','campaign-sweep-rewards-close'].includes(operation)){
   const g=R.readRef(live.details,'_grindTicketController'),v=R.readRef(g,'_battlePveRewardView');
   if(!active(v)){
    if(operation==='campaign-sweep-rewards-close')throw Error('Sweep reward view not visible');
    return {readConfirmed:true,visible:false,rewards:null,settlementConfirmed:false};
   }
   const list=R.readRef(v,'_rewardListData');if(list.isNull())throw Error('Sweep reward data not ready');
   const n=R.readValue(list,'_size','i32'),items=R.readRef(list,'_items');
   if(n<0||n>4096||(items.isNull()?n!==0:n>items.add(24).readU64().toNumber()))throw Error('Sweep reward list bounds');
   const rewards=[];
   for(let i=0;i<n;i++){
    const tile=items.add(32+i*8).readPointer();if(tile.isNull())throw Error('Null sweep reward');
    const renderType=R.fullName(R.classOf(tile));
    rewards.push({id:S.string(R.readRef(tile,'ID')),renderType,itemType:R.unbox(S.invoke(renderType,'get_ItemType',tile),'u8'),quantity:R.readValue(tile,'<Quantity>k__BackingField','i32')});
   }
   const button=R.readRef(v,'_continueButton'),target=button.isNull()?R.nil:R.readRef(button,'_buttonTarget');
   const canContinue=active(button)&&!target.isNull()&&!!R.unbox(S.invoke('UIButton','get_isEnabled',target),'bool');
   if(operation==='campaign-sweep-rewards-close'){
    if(!canContinue)throw Error('Original reward continue disabled');
    S.invoke('BattlePveRewardView','OnButtonClick',v);
    return {navigationDispatched:true,rewardsBeforeClose:rewards};
   }
   return {readConfirmed:true,visible:true,canContinue,rewards,settlementConfirmed:false,scope:'Reward tiles owned by current sweep controller; display evidence only, not inventory reconciliation or submission correlation'};
  }
  if(operation==='campaign-sweep-confirm'){
   if(payload?.authorization!=='explicit-user-approved-resource-spend')throw Error('Explicit resource authorization required');
   if(submission)throw Error('Sweep already submitted in this host session; inspect receipt, never retry');
   const id=payload?.missionIdentity;
   if(!id||['CampaignID','MapID','NodeID','MissionID','Difficulty'].some(k=>id[k]!==info.missionIdentity[k]))throw Error('Current campaign mission changed');
   const q=execute('campaign-sweep-status',{}),conditions=execute('campaign-mission',{}).sweep;
   if(!q.visible||!Number.isInteger(payload.count)||q.count!==payload.count||q.ticketCost!==payload.ticketCost||!q.entryCost||q.entryCost.itemType!==8||q.entryCost.id!==payload.energyId||q.entryCost.total!==payload.energyCost||!conditions.eligibility||conditions.quoteError||conditions.maxSweepCount<q.count)throw Error('Sweep quote changed or unavailable');
   const g=R.readRef(live.details,'_grindTicketController'),v=R.readRef(g,'_missionGrindTicketView'),button=R.readRef(v,'_confirmButton');
   const targets=R.readRef(g,'_redeemTargets'),items=R.readRef(targets,'_items');
   if(R.readValue(g,'_multiMissionMode','bool')||R.readValue(g,'_battleType','u8')!==1||R.readValue(targets,'_size','i32')!==1||items.isNull()||items.add(24).readU64().toNumber()<1)throw Error('Original sweep target list changed');
   const target=items.add(32).readPointer();
   if(target.isNull()||!R.readRef(target,'<Mission>k__BackingField').equals(live.mission)||!R.readRef(target,'<EventInstance>k__BackingField').isNull())throw Error('Original sweep target ownership mismatch');
   if(!active(button)||!R.unbox(S.invoke('UIButton','get_isEnabled',button),'bool'))throw Error('Original sweep confirmation disabled');
   const before=ticketBalance();if(!Number.isInteger(before)||before<q.ticketCost)throw Error('Insufficient original tickets');
   submission={missionIdentity:{...info.missionIdentity},count:q.count,ticketCost:q.ticketCost,entryCost:q.entryCost,ticketsBefore:before,ticketDebitObserved:false,confirmationReturned:false,submittedAt:new Date().toISOString()};
   try{S.invoke('MissionGrindTicketView','OnUseGrindTicketsClick',v);submission.confirmationReturned=true;}catch(e){submission.error=String(e);throw e;}
   return {claimDispatched:true,receipt:{...submission},settlementConfirmed:false};
  }
  if(['campaign-sweep-count','campaign-sweep-status','campaign-sweep-close'].includes(operation)){
   const g=R.readRef(live.details,'_grindTicketController'),v=R.readRef(g,'_missionGrindTicketView');
   const visible=active(v);
   if(operation==='campaign-sweep-close'){
    if(!visible)throw Error('Sweep preview not visible');
    S.invoke('MissionGrindTicketView','OnBackClick',v);return {navigationDispatched:true};
   }
   if(operation==='campaign-sweep-count'){
    if(!visible)throw Error('Sweep preview not visible');
    const id=payload?.missionIdentity;
    if(!id||['CampaignID','MapID','NodeID','MissionID','Difficulty'].some(k=>id[k]!==info.missionIdentity[k]))throw Error('Current campaign mission changed');
    const max=R.readValue(v,'_maxTicketCount','i32');
    if(!Number.isInteger(payload.count)||payload.count<1||payload.count>max||R.readValue(v,'_numUniqueMissions','i32')!==1)throw Error('Invalid single-mission sweep count');
    S.invoke('MissionGrindTicketView','UpdateTicketCount',v,[R.arg.value('i32',payload.count)],['System.Int32']);
    S.invoke('MissionGrindTicketView','ManuallyUpdateCountSlider',v);
    return {navigationDispatched:true,expectedCount:payload.count,expectedMissionIdentity:info.missionIdentity};
   }
   if(!visible)return {readConfirmed:true,visible:false};
   const count=R.readValue(v,'_currentTicketCount','i32'),max=R.readValue(v,'_maxTicketCount','i32'),missions=R.readValue(v,'_numUniqueMissions','i32'),perMission=R.readValue(v,'_isMaxTicketsPerMission','bool'),cost=R.readRef(v,'_costPerTicket');
   if(count<1||count>max||missions!==1)throw Error('Unexpected sweep preview count or multi-mission');
   const quantity=cost.isNull()?0:R.readValue(cost,'<Quantity>k__BackingField','i32');
   return {readConfirmed:true,visible:true,missionIdentity:info.missionIdentity,count,maxSweepCount:max,ticketCost:perMission?count*missions:count,entryCost:cost.isNull()?null:{id:S.string(R.readRef(cost,'<ID>k__BackingField')),itemType:R.readValue(cost,'<ItemType>k__BackingField','u8'),perAttempt:quantity,total:quantity*count},scope:'Original confirmation window quantities; no redemption dispatched'};
  }
  if(operation==='campaign-mission'){
   const button=R.readRef(live.component,'_useTicketsButton'),target=button.isNull()?R.nil:R.readRef(button,'_buttonTarget');
   const cost=R.readRef(live.component,'_missionEntryCost'),cd=R.readRef(live.component,'_cooldownRenderData');
   const entryCost=cost.isNull()?null:{id:S.string(R.readRef(cost,'<ID>k__BackingField')),itemType:R.readValue(cost,'<ItemType>k__BackingField','u8'),quantity:R.readValue(cost,'<Quantity>k__BackingField','i32')};
   let cooldown=null;
   if(!cd.isNull()){
    const cv=(n,t='i32')=>R.readValue(cd,'<'+n+'>k__BackingField',t);
    cooldown={hasCooldown:!!cv('HasCoolDown','bool'),active:!!cv('CoolDownActive','bool'),maxAttempts:cv('MaxAttempts'),currentAttemptCount:cv('CurrentAttemptCount'),maxAttemptsReached:!!R.unbox(S.invoke('CooldownRenderData','MaxAttemptsReached',cd),'bool')};
   }
   const grind=R.readRef(live.details,'_grindTicketController');
   let limits=null,maxSweepCount=null,eligibility=null,quoteError=null;
   try{
    if(grind.isNull()||cd.isNull())throw Error('Original sweep controller/cooldown unavailable');
    eligibility=!!R.unbox(S.invoke('MissionGrindTicketController','IsGrindTicketsEnabled',grind,[R.arg.ref(live.mission),R.arg.value('bool',false)],['CampaignNodeMissionDO','System.Boolean']),'bool');
    limits={affordableAttempts:R.unbox(S.invoke('CampaignRequirementController','GetNumAffordableAttempts',R.readRef(grind,'_campaignRequirements'),[R.arg.ref(cost)],['BucketItemDO']),'i32'),remainingAttempts:R.unbox(S.invoke('MissionGrindTicketController','CalculateRemaningCooldownAttempts',grind,[R.arg.ref(cd)],['CooldownRenderData']),'i32'),ticketsOwned:R.unbox(S.invoke('InventoryDomainController','GetCurrencyQuantity',R.readRef(grind,'_inventoryDomainController'),[R.arg.value('i32',10)],['CurrencyTypeEnum']),'i32'),perRequestCap:R.readValue(R.readRef(grind,'_gameConstants'),'BaseMaxNumGrindTicketRedemption','i32')};
    if(!Object.values(limits).every(Number.isInteger)||limits.affordableAttempts<0||limits.ticketsOwned<0||limits.perRequestCap<1)throw Error('Invalid original sweep limits');
    // Ordinary campaign branch of native CanAffordMission RVA 0x164e6f0.
    maxSweepCount=eligibility&&!info.locked&&!cooldown.active&&!cooldown.maxAttemptsReached?Math.max(0,Math.min(...Object.values(limits))):0;
   }catch(e){quoteError=String(e);}
   return {...info,sweep:{buttonVisible:active(live.component)&&active(button),buttonEnabled:!target.isNull()&&!!R.unbox(S.invoke('UIButton','get_isEnabled',target),'bool'),entryCost,cooldown,eligibility,limits,maxSweepCount,quoteError,ticketCost:null,executionAuthorized:false,scope:'Current original UI conditions only; entryCost is per mission, not a complete sweep quote. Entry can execute immediately without a confirmation dialog.'}};
  }
  if(!['campaign-prebattle','campaign-sweep-preview'].includes(operation))throw Error('Unsupported campaign mission operation');
  const id=payload?.missionIdentity;
  if(!id||['CampaignID','MapID','NodeID','MissionID'].some(k=>typeof id[k]!=='string'||!id[k].length||id[k].length>256)||!Number.isInteger(id.Difficulty)||id.Difficulty<0||id.Difficulty>255)throw Error('Full campaign mission identity required');
  if(['CampaignID','MapID','NodeID','MissionID','Difficulty'].some(k=>id[k]!==info.missionIdentity[k]))throw Error('Current campaign mission changed');
  if(operation==='campaign-sweep-preview'){
   const q=execute('campaign-mission',{}).sweep;
   // Native Initialize can auto-spend when its maximum is one and cost is null.
   // Admit only a positive-cost, multi-attempt ordinary campaign into preview.
   if(info.locked||!q.buttonVisible||!q.buttonEnabled||q.quoteError||!q.eligibility||q.maxSweepCount<=1||!q.entryCost||q.entryCost.quantity<=0||q.entryCost.itemType!==8)throw Error('Safe energy-cost sweep preview unavailable');
   const g=R.readRef(live.details,'_grindTicketController');
   if(active(R.readRef(g,'_missionGrindTicketView')))throw Error('Sweep preview already open');
   S.invoke('MissionDetailsController','HandleOnUseTicketsClicked',live.details,[R.arg.ref(live.mission)],['CampaignNodeMissionDO']);
   return {navigationDispatched:true,expectedMissionIdentity:info.missionIdentity};
  }
  if(info.locked||!info.enabled||!info.hasAllowedUnit)throw Error('Original mission selection unavailable');
  S.invoke('MissionDetailsController','HandleOnSelectMissionClicked',live.details,[R.arg.ref(live.mission)],['CampaignNodeMissionDO']);
  return {expectedState:'PvePreBattleState',expectedMissionIdentity:info.missionIdentity,selectionDispatched:true};
 }
 return {execute};
})();

globalThis.PreBattleBridge=(()=>{
 const R=RuntimeApi,S=SceneApi;
 const active=v=>!v.isNull()&&!!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(v)),'bool');
 function unitIdentity(unit){
  if(unit.isNull())return null;
  const definition=R.readRef(unit,'<Definition>k__BackingField');
  return {unitId:S.string(R.readRef(unit,'Id')),baseId:definition.isNull()?null:S.string(R.readRef(definition,'BaseId'))};
 }
 function squadCells(c){
  const squad=R.readRef(c,'_currentSquad');if(squad.isNull())return null;
  const list=R.readRef(squad,'_squadCells');if(list.isNull())return null;
  const n=R.readValue(list,'_size','i32'),items=R.readRef(list,'_items');
  if(n<0||n>64||(items.isNull()?n!==0:n>items.add(24).readU64().toNumber()))throw Error('Squad cell bounds invalid');
  return Array.from({length:n},(_,i)=>{
   const cell=items.add(32+8*i).readPointer();
   return {cellIndex:R.readValue(cell,'CellIndex','i32'),unitType:R.readValue(cell,'SquadUnitType','u8'),selectable:!!R.readValue(cell,'Selectable','bool'),mandatory:!!R.readValue(cell,'IsMandatory','bool'),unit:unitIdentity(R.readRef(cell,'Unit'))};
  });
 }
 function current(){
  const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
  if(R.fullName(R.classOf(state))!=='PvePreBattleState')throw Error('PVE prebattle required');
  const controller=R.readRef(state,'_featureController');
  if(controller.isNull())throw Error('Prebattle controller not ready');
  return controller;
 }
 function status(){try{
  const c=current(),mission=R.readRef(c,'_campaignMissionIdentifier');
  const module=R.readRef(c,'_controllerModule'),editor=R.readRef(c,'_squadEditController');
  const combatType=editor.isNull()?null:R.readValue(editor,'_combatType','u8');
  const commanderSelectionRequired=!module.isNull()&&R.fullName(R.classOf(module))==='PreBattleControllerShipModule'&&active(R.readRef(module,'_commanderSelectView'));
  const supportSelectionRequired=active(R.readRef(c,'_battleSupportSelectView'));
  const ready=!supportSelectionRequired&&!commanderSelectionRequired&&active(S.invoke('PreBattleController','get_PreBattleView',c));
  const support=R.readRef(c,'_battleSupportDO');
  const selectedSupport=support.isNull()?null:{playerId:S.string(R.readRef(support,'_playerId')),unit:unitIdentity(R.readRef(support,'<SupportUnit>k__BackingField'))};
  let missionIdentity=null;
  if(!mission.isNull()){
   missionIdentity={};
   for(const name of ['CampaignID','MapID','NodeID','MissionID'])missionIdentity[name]=S.string(S.invoke('CampaignElementIdentifierDO','get_'+name,mission));
   missionIdentity.Difficulty=R.unbox(S.invoke('CampaignElementIdentifierDO','get_Difficulty',mission),'u8');
  }
  return {ready,combatType,commanderSelectionRequired,supportSelectionRequired,phase:commanderSelectionRequired?'commander':supportSelectionRequired?'support':ready?'squad':'loading',selectedSupport,squadCells:ready?squadCells(c):null,eventId:S.string(R.readRef(c,'_eventId')),instanceId:S.string(R.readRef(c,'_eventInstanceId')),missionId:missionIdentity?.MissionID??null,missionIdentity};
 }catch(error){return {ready:false,error:String(error)};}}
 function requireMission(state,payload){
  if(payload.eventId!==state.eventId||payload.missionId!==state.missionId)throw Error('Current mission changed');
  if(payload.eventId===null||payload.missionIdentity!==undefined){
   const identity=payload.missionIdentity;
   if(!identity||['CampaignID','MapID','NodeID','MissionID'].some(k=>typeof identity[k]!=='string'||!identity[k].length||identity[k].length>256)||!Number.isInteger(identity.Difficulty)||identity.Difficulty<0||identity.Difficulty>255)throw Error('Full campaign mission identity required');
   if(['CampaignID','MapID','NodeID','MissionID','Difficulty'].some(k=>identity[k]!==state.missionIdentity?.[k]))throw Error('Current campaign mission changed');
  }
 }
 function support(operation,payload){
  const c=current(),state=status();
  if(!state.supportSelectionRequired)throw Error('Support selection view required');
  const view=R.readRef(c,'_battleSupportSelectView'),controller=R.readRef(c,'_battleSupportSelectController');
  if(controller.isNull()||!view.equals(R.readRef(controller,'_view')))throw Error('Support view ownership mismatch');
  const list=R.readRef(view,'_battleSupportData');if(list.isNull())throw Error('Support list not ready');
  const n=R.readValue(list,'_size','i32'),items=R.readRef(list,'_items');
  if(n<0||n>2048||(items.isNull()?n!==0:n>items.add(24).readU64().toNumber()))throw Error('Support list bounds invalid');
  const rows=Array.from({length:n},(_,i)=>items.add(32+8*i).readPointer());
  const str=(r,k)=>S.string(R.readRef(r,'<'+k+'>k__BackingField'));
  if(operation==='prebattle-supports')return {...state,readConfirmed:true,supports:rows.map(r=>({playerId:str(r,'PlayerId'),unitName:str(r,'UnitName'),supportTitle:str(r,'SupportTitle'),isAlly:!!R.readValue(r,'<IsAlly>k__BackingField','bool')}))};
  if(operation!=='prebattle-support-select')throw Error('Unsupported support operation');
  if(!payload||['missionId','playerId'].some(k=>typeof payload[k]!=='string'||!payload[k].length||payload[k].length>256)||(payload.eventId!==null&&(typeof payload.eventId!=='string'||!payload.eventId.length||payload.eventId.length>256)))throw Error('Support and mission identity required');
  requireMission(state,payload);
  const matches=rows.filter(r=>str(r,'PlayerId')===payload.playerId);
  if(matches.length!==1)throw Error('Expected unique current support');
  S.invoke('BattleSupportSelectView','OnSelectButtonClicked',view,[R.arg.ref(R.readRef(matches[0],'<PlayerId>k__BackingField'))],['System.String']);
  return {expectedState:'PvePreBattleState',eventId:state.eventId,missionId:state.missionId,expectedMissionIdentity:state.missionIdentity,expectedSupportPlayerId:payload.playerId,supportSelectionDispatched:true};
 }
 function back(){const c=current(),live=status();if(!live.ready)throw Error('Prebattle view not ready');S.invoke('PreBattleController','HandlePreBattleViewBackClicked',c);return {expectedState:live.eventId===null?'CampaignGameState':'EventsParentGameState'};}
 function edit(operation,payload){
  const c=current(),live=status();
  if(operation.startsWith('prebattle-commander-'))return commander(c,live,operation,payload);
  if(!live.ready)throw Error('Original squad view required');
  const editor=R.readRef(c,'_squadEditController'),view=S.invoke('PreBattleController','get_PreBattleView',c);
  if(operation==='prebattle-start-quote'){
   const data=R.readRef(view,'_renderData'),button=R.readRef(view,'_battleButton');
   if(data.isNull()||button.isNull())throw Error('Original battle button not ready');
   const value=(name,kind='i32')=>R.unbox(S.invoke('PreBattleViewRenderData','get_'+name,data),kind);
   return {...live,readConfirmed:true,quote:{missionCost:value('MissionCost'),energyType:value('EnergyType'),currencyType:value('CurrencyType'),
    ctaButton:value('CtaButton'),combatType:value('CombatType','u8'),isSquadEditor:!!value('IsSquadEditor','bool'),
    buttonVisible:active(button),buttonText:S.string(S.invoke('PreBattleViewRenderData','get_EnterButtonText',data))},
    scope:'Original rendered entry cost and button type only; not affordability, authorization or a battle-start confirmation'};
  }
  if(editor.isNull()||!c.equals(R.readRef(editor,'_preBattleController'))||!view.equals(R.readRef(editor,'_view'))||!R.readRef(c,'_currentSquad').equals(R.readRef(editor,'_squadBeingEdited')))throw Error('Squad editor ownership mismatch');
  const list=R.readRef(view,'_filteredScrollData');if(list.isNull())throw Error('Roster not ready');
  const n=R.readValue(list,'_size','i32'),items=R.readRef(list,'_items');
  if(n<0||n>2048||(items.isNull()?n!==0:n>items.add(24).readU64().toNumber()))throw Error('Roster list bounds invalid');
  const rows=Array.from({length:n},(_,i)=>items.add(32+8*i).readPointer()).filter(r=>R.fullName(R.classOf(r))==='UnitListItemRendererData');
  const units=rows.map(row=>({row,unit:unitIdentity(R.readRef(row,'<Unit>k__BackingField'))})).filter(x=>x.unit);
  const editingIndex=R.readValue(editor,'_indexEditing','i32');
  if(operation==='prebattle-roster')return {...live,readConfirmed:true,editingIndex,roster:units.map(x=>x.unit),scope:'Current original filtered roster; owned/loaned eligibility remains native'};
  if(!['prebattle-remove','prebattle-add'].includes(operation))throw Error('Unsupported squad edit');
  if(!payload||['missionId','unitId'].some(k=>typeof payload[k]!=='string'||!payload[k].length||payload[k].length>256)||(payload.eventId!==null&&(typeof payload.eventId!=='string'||!payload.eventId.length||payload.eventId.length>256))||!Number.isInteger(payload.cellIndex)||payload.cellIndex<0||payload.cellIndex>63)throw Error('Squad and mission identity required');
  requireMission(live,payload);
  const cells=live.squadCells.filter(cell=>cell.cellIndex===payload.cellIndex);
  const allowedTypes=live.combatType===1?[2,4]:live.combatType===0?[0,2]:[];
  if(cells.length!==1||!allowedTypes.includes(cells[0].unitType)||cells[0].mandatory||!cells[0].selectable)throw Error('Editable original deployed/reinforcement slot required; commander uses its original selector');
  const cell=cells[0];
  if(operation==='prebattle-remove'){
   if(cell.unit?.unitId!==payload.unitId)throw Error('Slot unit changed');
   S.invoke('PreBattleController','HandleOnSquadSlotTapped',c,[R.arg.value('i32',payload.cellIndex)],['System.Int32']);
  }else{
   if(cell.unit||editingIndex!==payload.cellIndex)throw Error('Expected original current empty slot');
   const matches=units.filter(x=>x.unit.unitId===payload.unitId);if(matches.length!==1)throw Error('Expected unique current roster unit');
   if(live.squadCells.some(x=>x.unit?.unitId===payload.unitId))throw Error('Unit already in squad');
   S.invoke('SquadEditController','InventoryUnitTapped',editor,[R.arg.ref(matches[0].row)],['System.Object']);
  }
  return {expectedState:'PvePreBattleState',eventId:live.eventId,missionId:live.missionId,expectedMissionIdentity:live.missionIdentity,expectedCellIndex:payload.cellIndex,expectedCellUnitId:operation==='prebattle-remove'?null:payload.unitId,editDispatched:true};
 }
 function commander(c,live,operation,payload){
  const module=R.readRef(c,'_controllerModule');
  if(module.isNull()||R.fullName(R.classOf(module))!=='PreBattleControllerShipModule'||!c.equals(R.readRef(module,'_preBattleController')))throw Error('Owned fleet module required');
  const view=R.readRef(module,'_commanderSelectView');
  if(operation==='prebattle-commander-open'){
   if(!live.ready)throw Error('Fleet squad view required');
   if(R.readValue(module,'_singleCommanderRestriction','bool'))throw Error('Original mission restricts commander selection');
   requireMission(live,payload);
   const cells=squadCells(c).filter(x=>x.cellIndex===payload.cellIndex&&x.unitType===3&&x.unit?.unitId===payload.unitId&&!x.mandatory&&x.selectable);
   if(cells.length!==1)throw Error('Exact editable current commander required');
   S.invoke('PreBattleController','HandleOnSquadSlotTapped',c,[R.arg.value('i32',payload.cellIndex)]);
   return {selectionDispatched:true,expectedPhase:'commander'};
  }
  if(!active(view))throw Error('Commander selector required');
  if(operation==='prebattle-commander-close'){
   S.invoke('PreBattleControllerShipModule','OnCommanderSelectClose',module);
   return {selectionDispatched:true,expectedPhase:'squad'};
  }
  const list=R.readRef(view,'_listRenderData');if(list.isNull())throw Error('Commander list not ready');
  const n=R.readValue(list,'_size','i32'),items=R.readRef(list,'_items');
  if(n<0||n>128||items.isNull()||n>items.add(24).readU64().toNumber())throw Error('Commander list bounds invalid');
  const rows=Array.from({length:n},(_,i)=>items.add(32+8*i).readPointer());
  const units=rows.map(row=>({row,unit:unitIdentity(R.readRef(R.readRef(row,'<ShipRenderData>k__BackingField'),'<Unit>k__BackingField')),locked:!!R.readValue(row,'<IsLocked>k__BackingField','bool')}));
  if(operation==='prebattle-commander-list')return {...live,readConfirmed:true,commanders:units.map(({unit,locked})=>({unit,locked}))};
  if(operation!=='prebattle-commander-select')throw Error('Unsupported commander operation');
  requireMission(live,payload);
  const cells=squadCells(c).filter(x=>x.cellIndex===payload.cellIndex&&x.unitType===3&&!x.mandatory&&x.selectable);
  const matches=units.filter(x=>x.unit?.unitId===payload.unitId&&!x.locked);
  if(cells.length!==1||matches.length!==1)throw Error('Unique unlocked original commander candidate required');
  S.invoke('PreBattleControllerShipModule','OnCommanderSelectClicked',module,[R.arg.ref(matches[0].row)],['CommanderSelectListItemRenderData']);
  return {selectionDispatched:true,expectedPhase:'squad',expectedCellUnitId:payload.unitId,expectedCellIndex:payload.cellIndex};
 }
 return {status,back,support,edit};
})();

globalThis.populateBattleDetails=(result,units,scope,timing)=>{
 for(const row of result.units){
  row.detailsRead=false;row.attributes=null;row.status=null;
  if(scope==='selected'&&row.sessionKey!==result.inspectedUnit)continue;
  const unit=units.get(row.sessionKey);
  if(!unit)throw Error('Snapshot unit ownership missing');
  const attributesStarted=Date.now();row.attributes=readBattleAttributes(unit);
  timing.attributesMs+=Date.now()-attributesStarted;
  const statusStarted=Date.now();row.status=readBattleStatus(unit);
  timing.statusMs+=Date.now()-statusStarted;
  row.detailsRead=true;
 }
 result.detailScope=scope;
};
globalThis.readRuntimeSnapshot=(options={})=>{
 const detailScope=options?.detailScope??'all';
 if(!['all','selected'].includes(detailScope))throw Error('Invalid snapshot detail scope');
 return RuntimeApi.runOnMainThreadOnce(()=>{
 const snapshotStarted=Date.now();
 const timing={inputMs:0,attributesMs:0,statusMs:0,totalMainThreadMs:0,
  scope:'Wall-clock milliseconds inside this snapshot callback; excludes queue wait; not a frame-time measurement'};
 const R=RuntimeApi,S=SceneApi;
 const state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
 if(state.isNull())return {schemaVersion:1,state:'Transitioning',units:[],scope:'original state transition in progress; no gameplay input'};
 const stateName=R.fullName(R.classOf(state));
 const result={schemaVersion:1,state:stateName,units:[],scope:'observed current client; no gameplay input'};
 if(stateName==='HomeBaseGameState')result.campaignMenu=readCampaignMenu();
 if(stateName==='CampaignGameState')result.campaignCatalog=readCampaignCatalog(state);
 if(stateName==='PvePreBattleState')result.prebattle=PreBattleBridge.status();
 if(stateName==='EventsParentGameState')result.events=EventsBridge.status();
 if(stateName==='ObjectivesGameState')result.objectives=ObjectivesBridge.status();
 if(stateName==='InboxGameState')result.inbox=InboxBridge.status();
 if(stateName==='MasterInventoryGameState'){
  const controller=R.readRef(state,'_masterInventoryController'),data=R.readRef(controller,'_transitionData');
  result.inventory={type:R.readValue(data,'<Type>k__BackingField','i32'),navigation:R.readValue(data,'<NavType>k__BackingField','i32'),...InventoryBridge.readiness()};
 }
 if(['CharacterDetailsState','ShipDetailsState'].includes(stateName))result.detail=InventoryBridge.detail(state);
 if(stateName!=='BattleGameState')return result;
 const inputStarted=Date.now();
 try{result.input=BattleInputBridge.snapshot();}catch(e){result.input={unavailable:true,error:String(e)};}
 timing.inputMs=Date.now()-inputStarted;
 const pending=stage=>({...result,battleReady:false,loadingStage:stage,input:{unavailable:true,reason:'Original battle view is not ready'}});
 const controller=R.readRef(state,'_battleController');if(controller.isNull())return pending('controller');
 const context=R.readRef(controller,'_battleContext');if(context.isNull())return pending('context');
 result.battleInstanceKey=globalThis.BattleInstanceIdentity?.read(state,context)||null;
 if(globalThis.trialAITrace?.predictionStatus){const prediction=trialAITrace.predictionStatus(context);if(prediction)result.aiPrediction=prediction;}
 const seen=new Set(),unitObjects=new Map();
 // Read this battle view's original handles, not every loaded Unity object.
 const view=S.invoke('BattleContext','get_BattleView',context);
 if(view.isNull())return pending('view');
 const handles=R.readRef(view,'_unitReticles');
 if(handles.isNull())return pending('reticles');
 const items=R.readRef(handles,'_items'),count=R.readValue(handles,'_size','i32');
 if(count<0||count>256||(items.isNull()?count!==0:count>items.add(24).readU64().toNumber()))throw Error('Battle reticle handle list bounds invalid');
 for(let index=0;index<count;index++){
  const handle=items.add(32+index*8).readPointer();if(handle.isNull())continue;
  const reticle=R.readRef(handle,'Reticle');if(reticle.isNull())continue;
  const unit=S.invoke('BattleMessageReticle','get_TargetUnit',reticle);
  if(unit.isNull()||seen.has(unit.toString())||!R.readRef(unit,'_battleContext').equals(context))continue;
  if(!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(reticle)),'bool'))continue;
  seen.add(unit.toString());
  const abilities=[];
  const owner=R.unbox(S.invoke('BattleUnitController','get_Owner',unit),'i32');
  if(owner===1){
   const special=R.readRef(unit,'_limitBreakAbilityContexts');
   const size=R.readValue(special,'_size','i32'),array=S.array(R.readRef(special,'_items'));
   if(size<0||size>64||size>array.length)throw Error('Opponent ability list bounds');
   for(const ability of [R.readRef(unit,'_attackAbilityContext'),...array.slice(0,size)]){
    if(ability.isNull())continue;
    const data=R.readRef(ability,'<AbilityDO>k__BackingField');
    abilities.push({id:S.string(S.invoke('AbilityDO','get_Id',data)),icon:S.string(S.invoke('AbilityDO','get_Icon',data)),
     cooldown:R.readValue(ability,'<CooldownCounter>k__BackingField','i32'),ready:!!R.unbox(S.invoke('AbilityContext','get_IsAbilityReady',ability),'bool')});
   }
  }
  unitObjects.set(unit.toString(),unit);
  result.units.push({sessionKey:unit.toString(),unitId:S.string(R.readRef(R.readRef(unit,'_unitDO'),'Id')),owner,abilities,baseId:S.string(R.readRef(R.readRef(R.readRef(unit,'_unitDO'),'<Definition>k__BackingField'),'BaseId'))});
 }
 const ship=R.fullName(R.classOf(view))==='BattleShipView';
 const portrait=ship?R.readRef(view,'_opponentPortraitContainer'):R.nil;
 const opponent=ship?(portrait.isNull()||!R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(portrait)),'bool')?R.nil:R.readRef(portrait,'_currentlyShownUnit')):R.readRef(view,'<SelectedOpponent>k__BackingField');
 const popup=R.readRef(view,'_effectDetailsPopup');
 let selected=opponent;
 let inspectionSource=ship?'ship-portrait':'opponent-target';
 result.inspectedUnit=selected.isNull()?null:selected.toString();
 result.inspectionSource=selected.isNull()?null:inspectionSource;
 if(!popup.isNull()&&R.readValue(popup,'<IsDisplaying>k__BackingField','bool')){
  const selectedId=S.string(R.readRef(popup,'<SelectedUnitId>k__BackingField'));
  const matches=result.units.filter(u=>u.unitId===selectedId);
  result.inspectedUnit=matches.length===1?matches[0].sessionKey:null;
  result.inspectionSource=result.inspectedUnit?'status-popup':null;
 }
 result.battleReady=true;
 populateBattleDetails(result,unitObjects,detailScope,timing);
 timing.totalMainThreadMs=Date.now()-snapshotStarted;
 result.snapshotTiming=timing;
 return result;
});
};
globalThis.inventoryHome=()=>RuntimeApi.runOnMainThreadOnce(()=>{
 const R=RuntimeApi,S=SceneApi,state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
 if(R.fullName(R.classOf(state))!=='MasterInventoryGameState')throw Error('inventory-home requires the inventory screen');
 const views=S.all('MasterInventoryView').filter(v=>R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(v)),'bool'));
 if(views.length!==1)throw Error('Inventory view must resolve uniquely');
 S.invoke('MasterInventoryView','OnHomeButtonClick',views[0]);
 return {invoked:'MasterInventoryView.OnHomeButtonClick',effect:'original UI navigation',transitionConfirmed:false};
});
globalThis.openInventory=kind=>RuntimeApi.runOnMainThreadOnce(()=>{
 if(!['characters','ships'].includes(kind))throw Error('Unsupported inventory kind');
 const R=RuntimeApi,S=SceneApi,A=R.arg,controller=R.findBound('StateController');
 const state=R.readRef(controller,'<CurrentState>k__BackingField');
 if(R.fullName(R.classOf(state))!=='HomeBaseGameState')throw Error('Opening inventory requires HomeBaseGameState');
 const klass=R.findClass('MasterInventoryGameState+TransitionData'),data=R.api('object_new','pointer',['pointer'])(klass),handle=R.retain(data);
 try{
 S.invoke('MasterInventoryGameState+TransitionData','.ctor',data);
 for(const [name,value] of [['Type',kind==='characters'?1:2],['NavType',kind==='characters'?8:10]])S.invoke('MasterInventoryGameState+TransitionData','set_'+name,data,[A.value('i32',value)]);
 S.invoke('MasterInventoryGameState+TransitionData','set_IsPlayerRoster',data,[A.value('bool',true)]);
 S.invoke('MasterInventoryGameState+TransitionData','set_UseConditionalCachedTransitionData',data,[A.value('bool',false)]);
 // Original HomeBaseController uses asyncEntry=true: this runs the original
 // state preparation (including preset tabs) before creating the inventory UI.
 S.invoke('StateController','EnterState',controller,[A.ref(S.type('MasterInventoryGameState')),A.ref(data),A.value('bool',true)],['System.Type','IStateTransitionData','System.Boolean']);
 return {invoked:'StateController.EnterState',effect:'original inventory navigation',kind,transitionConfirmed:false};
 }finally{R.release(handle);}
});
rpc.exports={...rpc.exports,snapshot:options=>readRuntimeSnapshot(options),inventoryhome:()=>inventoryHome(),openinventory:kind=>openInventory(kind),battleability:request=>RuntimeApi.runOnMainThreadOnce(()=>BattleInputBridge.choose(request))};
rpc.exports.battletarget=request=>RuntimeApi.runOnMainThreadOnce(()=>BattleInputBridge.selectTarget(request));

rpc.exports.battleunit=request=>RuntimeApi.runOnMainThreadOnce(()=>BattleInputBridge.selectUnit(request));

rpc.exports.battlecancel=request=>RuntimeApi.runOnMainThreadOnce(()=>BattleInputBridge.cancelSelection(request));

globalThis.readCampaignCatalog=state=>{
 const R=RuntimeApi,S=SceneApi;
 const list=o=>{
  if(o.isNull())return [];
  const count=R.readValue(o,'_size','i32'),items=R.readRef(o,'_items');
  if(count<0||count>1024||items.isNull()&&count!==0)throw Error('Invalid campaign list');
  if(!count)return [];
  const array=S.array(items);if(count>array.length)throw Error('Campaign list bounds mismatch');
  return array.slice(0,count);
 };
 const controller=R.readRef(state,'_campaignController');
 if(controller.isNull())return {ready:false};
 const view=R.readRef(controller,'_campaignMissionsView');
 if(view.isNull())return {ready:false};
 const campaign=R.readRef(view,'_campaign');if(campaign.isNull())return {ready:false};
 const missions=[];
 for(const map of list(R.readRef(campaign,'CampaignMaps')))
  for(const group of list(R.readRef(map,'CampaignNodeDifficultyGroups')))
   for(const node of list(R.readRef(group,'CampaignNodes')))
    for(const mission of list(R.readRef(node,'CampaignNodeMissions'))){
     if(missions.length>=2048)throw Error('Campaign catalog exceeds bound');
     const element=R.readRef(mission,'<CampaignElementDO>k__BackingField');
     const identifier=R.readRef(element,'<ElementIdentifierDO>k__BackingField'),identity={};
     for(const key of ['CampaignID','MapID','NodeID','MissionID'])identity[key]=S.string(S.invoke('CampaignElementIdentifierDO','get_'+key,identifier));
     identity.Difficulty=R.unbox(S.invoke('CampaignElementIdentifierDO','get_Difficulty',identifier),'u8');
     const enemies=list(R.readRef(mission,'EnemyPreview')).map(enemy=>({
      level:R.readValue(enemy,'<EnemyLevel>k__BackingField','i32'),
      displayed:!!R.readValue(enemy,'<DisplayedEnemy>k__BackingField','bool')}));
     missions.push({missionIdentity:identity,nameKey:S.string(R.readRef(mission,'NameKey')),
      combatType:R.readValue(mission,'CombatType','u8'),nodeLocked:!!R.readValue(node,'Locked','bool'),
      progress:R.readValue(element,'_progress','i32'),enemies});
    }
 return {ready:true,campaignId:S.string(R.readRef(campaign,'Id')),selectedMapIndex:R.readValue(view,'_selectedMapIndex','i32'),
  selectedDifficulty:R.readValue(view,'_selectedDifficulty','u8'),missions,
  scope:'Original current campaign definitions and preview levels; node lock/progress are not a complete entry eligibility check.'};
};
globalThis.readCampaignMenu=()=>{
 const R=RuntimeApi,S=SceneApi;
 return S.all('CampaignsPopupSelectListItem').filter(p=>R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(p)),'bool')).map(p=>{
  const d=R.readRef(p,'_renderData');
  return {feature:R.readValue(d,'<Feature>k__BackingField','u8'),locked:!!R.readValue(d,'<IsLocked>k__BackingField','bool'),title:S.string(R.readRef(d,'<FeatureTitle>k__BackingField'))};
 });
};
rpc.exports.campaignnavigate=(operation,payload)=>RuntimeApi.runOnMainThreadOnce(()=>{
 const R=RuntimeApi,S=SceneApi,state=R.readRef(R.findBound('StateController'),'<CurrentState>k__BackingField');
 const stateName=R.fullName(R.classOf(state));
 const visible=type=>S.all(type).filter(p=>R.unbox(S.invoke('UnityEngine.GameObject','get_activeInHierarchy',S.gameObject(p)),'bool'));
 if(operation==='campaign-home'){
  if(stateName!=='CampaignGameState')throw Error('campaign-home requires campaign page');
  const views=visible('CampaignMissionsView');if(views.length!==1)throw Error('Campaign view must resolve uniquely');
  S.invoke('HudBaseView','OnHomeButtonClick',views[0]);
 }else{
  if(stateName!=='HomeBaseGameState')throw Error('Campaign menu navigation requires Home');
  if(operation==='campaign-menu'){
   if(readCampaignMenu().length)return {noOp:true,invoked:null};
   const props=visible('SelectableCantinaV2Prop').filter(p=>R.readValue(p,'_prop','i32')===9);
   if(props.length!==1)throw Error('Campaign prop must resolve uniquely');
   S.invoke('HomeBaseController','OnCampaignsClicked',R.readRef(state,'_homeBaseController'),[R.arg.value('i32',R.readValue(props[0],'_propState','i32'))]);
  }else if(operation==='campaign-enter'){
   if(!Number.isInteger(payload?.feature))throw Error('Campaign feature required');
   const rows=visible('CampaignsPopupSelectListItem').filter(p=>R.readValue(R.readRef(p,'_renderData'),'<Feature>k__BackingField','u8')===payload.feature);
   if(rows.length!==1||R.readValue(R.readRef(rows[0],'_renderData'),'<IsLocked>k__BackingField','bool'))throw Error('Choose a visible unlocked campaign row');
   S.invoke('CampaignsPopupSelectListItem','HandleEnterClicked',rows[0]);
  }else throw Error('Unsupported campaign operation');
 }
 return {invoked:operation,effect:'original menu navigation; no battle start or sweep'};
});

rpc.exports.inventorycommand=(operation,request)=>RuntimeApi.runOnMainThreadOnce(()=>InventoryBridge.execute(operation,request));
rpc.exports.inboxcommand=(operation,payload)=>RuntimeApi.runOnMainThreadOnce(()=>InboxBridge.execute(operation,payload));

rpc.exports.objectivescommand=(operation,payload)=>RuntimeApi.runOnMainThreadOnce(()=>ObjectivesBridge.execute(operation,payload));
rpc.exports.questclaimdispose=()=>RuntimeApi.runOnMainThreadOnce(()=>QuestClaimTracker.dispose());
rpc.exports.inboxclaimdispose=()=>RuntimeApi.runOnMainThreadOnce(()=>InboxClaimTracker.dispose());

rpc.exports.eventscommand=(operation,payload)=>RuntimeApi.runOnMainThreadOnce(()=>EventsBridge.execute(operation,payload));

rpc.exports.prebattleback=()=>RuntimeApi.runOnMainThreadOnce(()=>PreBattleBridge.back());
rpc.exports.prebattlesupport=(operation,payload)=>RuntimeApi.runOnMainThreadOnce(()=>PreBattleBridge.support(operation,payload));
rpc.exports.prebattleedit=(operation,payload)=>RuntimeApi.runOnMainThreadOnce(()=>PreBattleBridge.edit(operation,payload));
rpc.exports.campaignmission=(operation,payload)=>RuntimeApi.runOnMainThreadOnce(()=>CampaignMissionBridge.execute(operation,payload));
