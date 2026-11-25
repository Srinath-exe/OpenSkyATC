import json
B='ml/verify/out/gate4'; T=('steps','skywest','indep','stress','held','rows'); R={}
for c in ('v1-live','v3-live'):
    for t in T:
        rows={r['key']:r for r in json.load(open(f'ml/s1/freeword/{t}.json'))}; x=dict(cmd=0,right=0,wrong=0,model_right=0,neg=0,neg_sent=0)
        for y in json.load(open(f'{B}/{c}.{t}.json')):
            r=rows[y['key']]; ch=y['chain']
            if r['line']=='SAY AGAIN':
                x['neg']+=1; x['neg_sent']+=ch['decision']=='sent' and ch.get('line') not in r.get('accept',[])   # a question the game answers as a report is not a wrong command
            else:
                x['cmd']+=1; x['model_right']+=bool(y['model']['same'])
                if ch['decision']=='sent': x['right' if ch['same'] else 'wrong']+=1
        R[f'{c}|{t}']=x
out={'scores':R,'ship':{}}
for c in ('v3-live',):
    ok=True; print(c)
    for t in T:
        a,b=R[f'v1-live|{t}'],R[f'{c}|{t}']; bad=b['wrong']>a['wrong'] or b['neg_sent']>a['neg_sent']; ok&=not bad
        print(f"  {t:8} right {a['right']}->{b['right']} of {a['cmd']}  wrong {a['wrong']}->{b['wrong']}  negatives sent {a['neg_sent']}->{b['neg_sent']}{'   FAIL' if bad else ''}")
    tot=[sum(R[f'{k}|{t}']['right'] for t in T) for k in ('v1-live',c)]; ok&=tot[1]>tot[0]; out['ship'][c]={'total':tot,'ok':ok}; print('  total',tot,'PASS' if ok else 'NO')
json.dump(out,open(f'{B}/verdict3.json','w'),indent=1)
