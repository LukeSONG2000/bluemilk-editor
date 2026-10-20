'use strict';
// Project-maintained provider. The presentation labels do not restrict commands.
BlueMilkMods.register({
 id:'bluemilk.information',name:'信息拓展',version:'0.1.0',sdkVersion:1,
 gameProfile:'swgoh-0.40.7',publisher:'Blue Milk project',
 capabilities:['battle.information.read','battle.information.ui'],
 presentations:['desktop','cli'],dependencies:[],conflicts:[],
 validation:'Legacy UI verified; Mod battle lifecycle and full cross-mode acceptance pending'
},()=>installBattleInfo());
