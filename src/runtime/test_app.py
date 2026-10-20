"""Desktop controls: polling must not disable clicks or lose selected targets."""
import unittest
from unittest.mock import patch
import tempfile
from pathlib import Path
import test_paths
from app import Window, attribute_summary, signed_number

class MasteryDisplay(unittest.TestCase):
    def test_negative_mastery_is_not_hidden_by_limit(self):
        attributes={'health':{},'protection':{'permanent':{},'bonus':{}},
                    'mastery':{'initial':25,'current':0,'netBattleDelta':-25,
                               'beforeLimits':-10,'netBeforeLimits':-35,'limitAdjustment':10}}
        text=attribute_summary(attributes)
        self.assertIn('25 → 0（净变化 -25）',text)
        self.assertIn('限制前精通 -10（相对初始 -35）',text)
        self.assertIn('上下限调整 +10',text)

    def test_missing_value_is_not_zero_or_fabricated(self):
        self.assertEqual(signed_number(None),'—')
        self.assertEqual(signed_number(float('nan')),'—')
        self.assertEqual(signed_number(0),'0')
        self.assertEqual(signed_number(12.5),'+12.5')

class Controls(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=test_paths.logs())
        self.addCleanup(temporary.cleanup)
        assets = Path(temporary.name)
        (assets / 'names.json').write_text('{}', encoding='utf-8')
        override = patch('app.ASSETS', assets)
        override.start()
        self.addCleanup(override.stop)
        self.app=Window();self.app.root.withdraw();self.app.connected=True
        self.data={'state':'PvpPreBattleState','arenaReady':True,'roster':[{'unitId':'a','baseId':'HOUNDSTOOTH','owner':0},{'unitId':'b','baseId':'RAZORCREST','owner':0}], 'units':[]}
        self.app.render(self.data)

    def tearDown(self):self.app.root.destroy()

    def test_poll_does_not_lock_buttons(self):
        self.app.polling=True;self.app.sync_controls()
        self.assertNotIn('disabled',self.app.arm.state())
        self.app.busy=True;self.app.sync_controls()
        self.assertIn('disabled',self.app.arm.state())

    def test_selection_preserved_and_dead_unit_removed(self):
        self.app.target_vars['a'].set(True)
        self.app.render(self.data)
        self.assertTrue(self.app.target_vars['a'].get())
        self.app.render({**self.data,'roster':self.data['roster'][1:]})
        self.assertNotIn('a',self.app.target_vars)
        self.assertFalse(self.app.target_vars['b'].get())

    def test_taunt_overrides_manual_controls(self):
        self.app.taunt.set(True);self.app.sync_controls()
        self.assertIn('disabled',self.app.basic_check.state())
        self.assertTrue(all('disabled' in w.state() for w in self.app.targets.winfo_children()))
        self.app.taunt.set(False);self.app.sync_controls()
        self.assertNotIn('disabled',self.app.basic_check.state())

    def test_explicit_all_mode_scope_and_combat_type(self):
        self.app.render({'state':'HomeBaseGameState','units':[]})
        self.app.sync_controls();self.assertIn('disabled',self.app.arm.state())
        self.app.all_modes.set(True);self.app.combat_type.set('舰队')
        self.app.sync_controls();self.assertNotIn('disabled',self.app.arm.state())
        sent=[];self.app.submit=lambda *args:sent.append(args)
        self.app.taunt.set(True);self.app.policy('arm')
        self.assertEqual(sent[0][1]['scope'],'all');self.assertEqual(sent[0][1]['combatType'],1)
        self.app.render({'state':'BattleGameState','units':[]});self.app.sync_controls()
        self.assertIn('disabled',self.app.arm.state())

    def test_no_empty_manual_policy_and_single_match_scope(self):
        sent=[];self.app.submit=lambda *args:sent.append(args)
        self.app.taunt.set(False);self.app.basic.set(True);self.app.policy('arm')
        self.assertEqual(sent,[])
        self.app.target_vars['a'].set(True);self.app.policy('arm')
        self.assertEqual(sent[0][1]['allowedTargets'],['a'])
        self.app.render({**self.data,'arena':{'status':{'armed':True}}});self.app.sync_controls()
        self.assertIn('disabled',self.app.arm.state())
        self.assertNotIn('disabled',self.app.apply.state())

    def test_manual_ui_excludes_policy_and_is_fixed_for_match(self):
        self.app.basic.set(True);self.app.taunt.set(True)
        self.app.manual_ui.set(True);self.app.select_manual()
        self.assertFalse(self.app.taunt.get());self.assertFalse(self.app.basic.get())
        self.assertIn('disabled',self.app.quick.state())
        self.app.target_vars['a'].set(True)
        sent=[];self.app.submit=lambda *args:sent.append(args)
        self.app.policy('arm')
        self.assertEqual(sent[0][1],{'enabled':False,'oneClickTaunt':False,'allowedTargets':[],'manualUI':True})
        self.app.render({**self.data,'arena':{'status':{'armed':True,'manualUI':True}}})
        self.app.sync_controls();self.assertIn('disabled',self.app.manual_check.state())

if __name__=='__main__':unittest.main()
