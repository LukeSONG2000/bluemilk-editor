"""Offline comparison of observed native stages, never a gameplay calculator."""
from datetime import datetime
import math


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def change(first, last):
    return last - first if finite(first) and finite(last) else None


def compare(before, after, unit_id):
    origin = before.get('observationIdentity')
    if (not isinstance(origin, dict) or any(type(origin.get(k)) is not int or origin[k] <= 0 for k in ('pid', 'hostPid'))
            or not isinstance(origin.get('evidencePath'), str) or not origin['evidencePath']
            or origin != after.get('observationIdentity')):
        raise ValueError('Matching original battle observation identity required; legacy snapshots cannot be paired.')
    if before.get('readConfirmed') is not True or after.get('readConfirmed') is not True:
        raise ValueError('Confirmed native observations required.')
    times = []
    for report in (before, after):
        stamp = datetime.fromisoformat(report['observedAt'].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError('Timezone-qualified observation time required.')
        times.append(stamp)
    if times[1] <= times[0]:
        raise ValueError('After observation must be strictly later than before.')
    units = []
    for report in (before, after):
        matches = [u for u in report.get('units', []) if u.get('id') == unit_id]
        if len(matches) != 1:
            raise ValueError('Exact unique unit instance required in each observation.')
        units.append(matches[0])
    first, last = units
    if (not isinstance(first.get('sessionKey'), str) or not first['sessionKey']
            or not isinstance(first.get('baseId'), str) or not first['baseId']
            or type(first.get('side')) is not int or first['side'] not in (0, 1)
            or any(first.get(k) != last.get(k) for k in ('sessionKey', 'baseId', 'side'))):
        raise ValueError('Unit runtime identity changed or is missing.')
    a, b = first['attributes'], last['attributes']
    def stats(value):
        rows = value.get('stats', [])
        ids = [s.get('id') for s in rows]
        if any(type(i) is not int for i in ids) or len(set(ids)) != len(ids):
            raise ValueError('Unique numeric original stat IDs required.')
        return {s['id']: s for s in rows}
    old, new = stats(a), stats(b)
    rows = []
    def number(row, key):
        value = row.get(key)
        return value if finite(value) else None
    for stat_id in sorted(old.keys() | new.keys()):
        x, y = old.get(stat_id, {}), new.get(stat_id, {})
        flag = x.get('hasMasteryContribution')
        stable = type(flag) is bool and flag == y.get('hasMasteryContribution')
        reason = ('native-no-direct-mastery-term' if stable and not flag else
                  'post-modifiers-rounding-and-limits-not-attributed' if stable else
                  'missing-or-changed-native-mastery-flag')
        rows.append(dict(id=stat_id, name=y.get('name', x.get('name')),
                         observedStatChange=change(x.get('current'), y.get('current')),
                         nativeMasteryFlagBefore=flag, nativeMasteryFlagAfter=y.get('hasMasteryContribution'),
                         coefficientBefore=number(x, 'masteryCoefficient'), coefficientAfter=number(y, 'masteryCoefficient'),
                         preModifierTermBefore=number(x, 'masteryPreModifierTerm'),
                         preModifierTermAfter=number(y, 'masteryPreModifierTerm'),
                         observedPreModifierTermChange=change(x.get('masteryPreModifierTerm'), y.get('masteryPreModifierTerm')) if stable else None,
                         finalMasteryAttributedChange=None, reason=reason))
    return dict(readConfirmed=True, observationIdentity=origin, unitId=unit_id,
                before=before['observedAt'], after=after['observedAt'],
                observedMasteryChange=change(a.get('mastery', {}).get('current'), b.get('mastery', {}).get('current')),
                stats=rows, warningsBefore=a.get('warnings', []), warningsAfter=b.get('warnings', []),
                attributionComplete=False,
                scope='Difference between two observed moments, not battle-start baseline. Native pre-modifier terms include all intervening mastery/coefficient changes. Final stat changes include other effects; no causal or per-skill attribution, counterfactual, or sum of terms is claimed.')
