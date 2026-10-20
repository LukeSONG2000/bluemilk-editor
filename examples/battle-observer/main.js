module.exports=sdk=>{
  sdk.battle.information.install();
  const events=sdk.battle.events.install({capacity:256});
  return sdk.lifecycle.compose({
    command(name,payload){
      if(name==='read')return events.command(name,payload);
      if(name==='snapshot')return sdk.battle.snapshot(payload);
      throw Error('Unknown observer command');
    }
  });
};
