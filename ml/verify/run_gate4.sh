#!/usr/bin/env bash
# Everyday wording in the gate's fitting data (trainP, make_plain.py): refit v1's and v3's gates and score three candidates on
# the six exams. The rule is fixed before the run: against the live game (v1, its Nov gate, same code) a candidate needs more
# right in total, no more wrong and no more negatives sent on ANY exam. The live gate files are put back at the end.
set -euo pipefail
cd "$(dirname "$0")/../.."; ROOT=$PWD; export OMP_NUM_THREADS=2
VM=src/lib/voice/verify-model.ts; VJ=public/models/verifier/roundtrip-v1/verifier.json; BK=ml/verify/out/gate4; mkdir -p $BK; rm -f $BK/verdict.json
cp $VM $BK/verify-model.live.ts; cp $VJ $BK/verifier.live.json
trap 'cd $ROOT; cp $BK/verify-model.live.ts $VM; cp $BK/verifier.live.json $VJ' EXIT
score() { npx tsc -p .tmp/tsconfig.gold3.json || return 1; mkdir -p .tmp/gold3/node_modules; ln -sfn ../src .tmp/gold3/node_modules/@
  for t in steps skywest indep stress held rows; do node .tmp/gold3/ml/stt/gold_chain.js chain ml/s1/freeword/$t.json public/models/s1/$2 > $BK/$1.$t.json; done; }
score v1-live 2m-free-v1
for m in 2m-free-v1 2m-free-v3; do MODEL=public/models/s1/$m ml/verify/run_gen.sh trainP; done
ml/verify/build.sh
for m in 2m-free-v1 2m-free-v3; do
  node ml/verify/post.cjs $m val syd stt noisy trainA trainB trainP hardneg
  ml/.venv/bin/python ml/verify/fit.py --s1-model public/models/s1/$m
done
cp $VM $BK/verify-model.new.ts; cp $VJ $BK/verifier.new.json
score v1-new 2m-free-v1; score v3-new 2m-free-v3
python3 ml/verify/gate4_verdict.py
