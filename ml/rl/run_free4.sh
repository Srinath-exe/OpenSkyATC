#!/usr/bin/env bash
# Command model round 4 (corrections, questions, cut-off calls): waits for run_gate4, trains from the v3 weights on CPU, exports,
# fits the gate (with trainP) and scores seven exams against the live model. Nothing is shipped: ml/s1/freeword/free4.verdict.json.
#   setsid nohup ml/rl/run_free4.sh > ml/rl/runs/plain-v4.log 2>&1 < /dev/null &
set -euo pipefail
cd "$(dirname "$0")/../.."; ROOT=$PWD; export OMP_NUM_THREADS=2
NAME=2m-free-v4; RUN=ml/rl/runs/plain-v4; VM=src/lib/voice/verify-model.ts; VJ=public/models/verifier/roundtrip-v1/verifier.json; BK=ml/verify/out/free4
while pgrep -f "^bash ml/verify/run_gate4.s[h]" > /dev/null; do sleep 30; done
if [ ! -f $RUN/done.json ]; then
  mkdir -p $RUN
  ( cd ml/rl && ../.venv/bin/python sft.py --out runs/plain-v4 --pool ../data/out8/ds/pool.jsonl --lr 7e-5 --start runs/plain-v3c --budget 7500 --est-steps 1350 --eval-every 400 --threads 2 --seed 4 )
fi
[ -f $RUN/config.json ] || cp ml/rl/runs/plain-v2-s2000/config.json $RUN/
ml/.venv/bin/python ml/edge/export_web.py --run $RUN --name s1/$NAME --int8 --check 300 --data ml/data/out4/ds/val.jsonl | tail -3
for s in val syd stt noisy trainA trainB trainP; do MODEL=public/models/s1/$NAME ml/verify/run_gen.sh $s; done
LIVE=$(sed -n "s#.*S1_MODEL_URL = '/models/s1/\([^']*\)'.*#\1#p" src/lib/voice/l1.ts)
mkdir -p $BK; cp $VM $BK/verify-model.live.ts; cp $VJ $BK/verifier.live.json
trap 'cd $ROOT; cp $BK/verify-model.live.ts $VM; cp $BK/verifier.live.json $VJ' EXIT
score() { npx tsc -p .tmp/tsconfig.gold3.json || return 1; mkdir -p .tmp/gold3/node_modules; ln -sfn ../src .tmp/gold3/node_modules/@
  for t in steps skywest indep stress held rows talk; do node .tmp/gold3/ml/stt/gold_chain.js chain ml/s1/freeword/$t.json public/models/s1/$2 > $BK/$1.$t.json; done; }
score live $LIVE
ml/verify/build.sh; node ml/verify/post.cjs $NAME val syd stt noisy trainA trainB trainP hardneg
ml/.venv/bin/python ml/verify/fit.py --s1-model public/models/s1/$NAME
cp $VM $BK/verify-model.new.ts; cp $VJ $BK/verifier.new.json
score v4 $NAME
python3 - <<'PY'
import json
B='ml/verify/out/free4'; T=('steps','skywest','indep','stress','held','rows','talk'); R={}
for c in ('live','v4'):
    for t in T:
        rows={r['key']:r for r in json.load(open(f'ml/s1/freeword/{t}.json'))}; x=dict(cmd=0,right=0,wrong=0,model_right=0,neg=0,neg_sent=0)
        for y in json.load(open(f'{B}/{c}.{t}.json')):
            r=rows[y['key']]; ch=y['chain']
            if r['line']=='SAY AGAIN': x['neg']+=1; x['neg_sent']+=ch['decision']=='sent' and ch.get('line') not in r.get('accept',[])
            else:
                x['cmd']+=1; x['model_right']+=bool(y['model']['same'])
                if ch['decision']=='sent': x['right' if ch['same'] else 'wrong']+=1
        R[f'{c}|{t}']=x
ok=True
for t in T:
    a,b=R[f'live|{t}'],R[f'v4|{t}']; bad=b['wrong']>a['wrong'] or b['neg_sent']>a['neg_sent']; ok&=not bad
    print(f"{t:8} right {a['right']}->{b['right']} of {a['cmd']}  wrong {a['wrong']}->{b['wrong']}  negatives sent {a['neg_sent']}->{b['neg_sent']}{'   FAIL' if bad else ''}")
tot=[sum(R[f'{c}|{t}']['right'] for t in T) for c in ('live','v4')]; ok&=tot[1]>tot[0]; print('total',tot,'SHIP' if ok else 'DO NOT SHIP')
json.dump({'scores':R,'total':tot,'ship':bool(ok)},open('ml/s1/freeword/free4.verdict.json','w'),indent=1)
PY
