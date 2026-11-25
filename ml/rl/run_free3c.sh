#!/usr/bin/env bash
# Command model round 3 (free wording + step-by-step taxi): train -> export -> refit the gate -> score against the shipped
# model on every exam. Nothing is shipped here; the verdict is ml/s1/freeword/free3.verdict.json.
set -euo pipefail
cd "$(dirname "$0")/../.."; ROOT=$PWD; export OMP_NUM_THREADS=2
NAME=2m-free-v3; RUN=ml/rl/runs/plain-v3c   # continued from the step-1200 weights: the first run was killed at step 1530
if [ ! -f $RUN/done.json ]; then
  mkdir -p $RUN
  ( while [ ! -f $RUN/done.json ]; do sleep 60; if [ -f $RUN/model.pt ]; then s=$(grep -o '"step": [0-9]*, "cpu_s": [0-9]*, "val"' $RUN/metrics.jsonl | tail -1 | grep -o '[0-9]*' | head -1); d=$RUN-s$s; [ -n "$s" ] && [ ! -d $d ] && [ "$s" != 0 ] && sleep 3 && mkdir -p $d && cp $RUN/model.pt $d/ && cp ml/rl/runs/plain-v2-s2000/config.json $d/; fi; done ) &
  ( cd ml/rl && ../.venv/bin/python sft.py --out runs/plain-v3c --pool ../data/out7/ds/pool.jsonl --lr 8.9e-5 --start runs/plain-v3-s1200 --budget 9130 --eval-every 400 --threads 2 --seed 1 )
fi
[ -f $RUN/config.json ] || cp ml/rl/runs/plain-v2-s2000/config.json $RUN/
ml/.venv/bin/python ml/edge/export_web.py --run $RUN --name s1/$NAME --int8 --check 300 --data ml/data/out4/ds/val.jsonl | tail -3
cp src/lib/voice/verify-model.ts /tmp/verify-model.before.ts
ml/verify/refit.sh public/models/s1/$NAME
npx tsc -p .tmp/tsconfig.gold3.json; mkdir -p .tmp/gold3/node_modules; ln -sfn ../src .tmp/gold3/node_modules/@
for t in steps skywest indep stress held rows; do for m in 2m-free-v1 $NAME; do node .tmp/gold3/ml/stt/gold_chain.js chain ml/s1/freeword/$t.json public/models/s1/$m > /tmp/free3_${t}_$m.json; done; done
python3 - <<'PY'
import json
out={}
for t in ("steps","skywest","indep",'stress','held','rows'):
    rows={r['key']:r for r in json.load(open(f'ml/s1/freeword/{t}.json'))}
    for m in ('2m-free-v1','2m-free-v3'):
        c=dict(cmd=0,right=0,wrong=0,model_right=0,neg=0,neg_sent=0)
        for x in json.load(open(f'/tmp/free3_{t}_{m}.json')):
            r=rows[x['key']]; ch=x['chain']
            if r['line']=='SAY AGAIN': c['neg']+=1; c['neg_sent']+=ch['decision']=='sent'
            else:
                c['cmd']+=1; c['model_right']+=bool(x['model']['same'])
                if ch['decision']=='sent': c['right' if ch['same'] else 'wrong']+=1
        out[f'{t}|{m}']=c
json.dump(out,open('ml/s1/freeword/free3.verdict.json','w'),indent=1); print(json.dumps(out,indent=1))
PY
