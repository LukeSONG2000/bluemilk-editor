"""Validate native prebattle identities without inventing eligibility rules."""
ROUTES = {**{op:'prebattleedit' for op in ('prebattle-roster','prebattle-start-quote','prebattle-remove','prebattle-add','prebattle-commander-open','prebattle-commander-list','prebattle-commander-select','prebattle-commander-close')},
          **{op:'prebattlesupport' for op in ('prebattle-supports','prebattle-support-select')},
          'events-mission-select':'eventscommand', 'prebattle-back':'prebattleback'}


def validate(operation, payload):
    p = payload or {}
    def identity(value):
        return isinstance(value,str) and 1 <= len(value) <= 256
    if operation in ('prebattle-roster','prebattle-start-quote','prebattle-supports','prebattle-back','prebattle-commander-list','prebattle-commander-close'):
        if p:raise ValueError('This prebattle operation takes no payload')
        return p
    if operation == 'events-mission-select':
        if set(p) != {'eventId','missionId'} or not all(identity(v) for v in p.values()):
            raise ValueError('Current eventId and missionId required')
        return p
    selection = operation == 'prebattle-support-select'
    required = {'eventId','missionId','playerId'} if selection else {'eventId','missionId','unitId','cellIndex'}
    if set(p)-{'missionIdentity'} != required or not identity(p['missionId']) or (p['eventId'] is not None and not identity(p['eventId'])):
        raise ValueError('Exact current mission and selection identity required')
    if not identity(p['playerId' if selection else 'unitId']):
        raise ValueError('Current unit/player instance ID required')
    if not selection and (type(p['cellIndex']) is not int or not 0 <= p['cellIndex'] <= 63):
        raise ValueError('cellIndex must be an integer in 0..63')
    if p['eventId'] is None or 'missionIdentity' in p:
        m=p.get('missionIdentity')
        keys={'CampaignID','MapID','NodeID','MissionID','Difficulty'}
        if (not isinstance(m,dict) or set(m)!=keys or not all(identity(m[k]) for k in keys-{'Difficulty'})
                or type(m['Difficulty']) is not int or not 0 <= m['Difficulty'] <= 255 or m['MissionID'] != p['missionId']):
            raise ValueError('Exact full campaign mission identity required')
    return p
