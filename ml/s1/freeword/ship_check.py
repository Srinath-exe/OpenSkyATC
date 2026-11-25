#!/usr/bin/env python3
"""The ship rule on free3.verdict.json: more right in total, no more wrong on any exam, no more refusals-that-should-stand sent."""
import json, sys
v = json.load(open('ml/s1/freeword/free3.verdict.json')); old, new = '2m-free-v1', '2m-free-v3'
ok, tr = True, [0, 0]
for t in ('steps', 'skywest', 'indep', 'stress', 'held', 'rows'):
    a, b = v[f'{t}|{old}'], v[f'{t}|{new}']; tr[0] += a['right']; tr[1] += b['right']
    bad = b['wrong'] > a['wrong'] or b['neg_sent'] > a['neg_sent']; ok &= not bad
    print(f"{t:8} right {a['right']}->{b['right']} of {a['cmd']}  wrong {a['wrong']}->{b['wrong']}  negatives sent {a['neg_sent']}->{b['neg_sent']} of {a['neg']}{'   FAIL' if bad else ''}")
ok &= tr[1] > tr[0]; print('total right', tr, 'SHIP' if ok else 'DO NOT SHIP'); sys.exit(0 if ok else 1)
