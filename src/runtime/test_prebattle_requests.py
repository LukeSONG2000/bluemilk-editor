import unittest
from prebattle_requests import validate


class PrebattleRequests(unittest.TestCase):
    def test_campaign_requires_full_consistent_identity(self):
        p=dict(eventId=None,missionId='m',unitId='u',cellIndex=0)
        with self.assertRaises(ValueError):validate('prebattle-remove',p)
        p['missionIdentity']=dict(CampaignID='c',MapID='a',NodeID='n',MissionID='m',Difficulty=1)
        self.assertEqual(validate('prebattle-remove',p),p)
        p['missionIdentity']['MissionID']='different'
        with self.assertRaises(ValueError):validate('prebattle-remove',p)

    def test_rejects_extra_fields_boolean_indices_and_wrong_identities(self):
        p=dict(eventId='e',missionId='m',unitId='u',cellIndex=0)
        for override in ({'cellIndex':True},{'cellIndex':64},{'unitId':''},{'start':True}):
            with self.assertRaises(ValueError):validate('prebattle-add',dict(p,**override))
        self.assertEqual(validate('prebattle-add',p),p)
        self.assertEqual(validate('prebattle-support-select',dict(eventId='e',missionId='m',playerId='p'))['playerId'],'p')

    def test_read_operations_never_accept_mutation_options(self):
        for op in ('prebattle-roster','prebattle-start-quote','prebattle-supports','prebattle-back','prebattle-commander-list','prebattle-commander-close'):
            self.assertEqual(validate(op,None),{})
            with self.assertRaises(ValueError):validate(op,{'confirm':True})

    def test_commander_selection_requires_exact_current_mission(self):
        p=dict(eventId='ships',missionId='m',unitId='capital',cellIndex=0)
        for op in ('prebattle-commander-open','prebattle-commander-select'):
            self.assertEqual(validate(op,p),p)
            with self.assertRaises(ValueError):validate(op,{'unitId':'capital'})

if __name__=='__main__':unittest.main()
