#!/usr/bin/env bash
# Same steps and same rule as run_free4.sh from "score live" on, run side by side; both models are scored on one frozen build
# (.tmp/gold3-live, compiled 23 Nov 20:16), only the gate constants differ.
set -euo pipefail
cd "$(dirname "$0")/../.."; ROOT=$PWD; export OMP_NUM_THREADS=2
NAME=2m-free-v4; VM=src/lib/voice/verify-model.ts; VJ=public/models/verifier/roundtrip-v1/verifier.json; BK=ml/verify/out/free4
# Put the live gate back; done straight after the fit as well, and only if the fit got as far as touching it
restore() { cd $ROOT; cp $BK/verify-model.live.ts $VM; cp $BK/verifier.live.json $VJ; }
trap restore EXIT
cmp -s $VM $BK/verify-model.live.ts && cmp -s $VJ $BK/verifier.live.json
one() { node $1/ml/stt/gold_chain.js chain ml/s1/freeword/$3.json public/models/s1/$4 > $BK/$2.$3.json; }
waitall() { for p in "$@"; do wait $p; done; }
t() { echo "$(date -u +%T) $*"; }
L=(); for x in stress held rows talk; do one .tmp/gold3-live live $x 2m-free-v1 & L+=($!); done
ml/verify/build.sh
P=(); for s in val syd stt noisy trainA trainB; do node ml/verify/post.cjs $NAME $s & P+=($!); done; waitall "${P[@]}"; t post done
ml/.venv/bin/python ml/verify/fit.py --s1-model public/models/s1/$NAME
cp $VM $BK/verify-model.new.ts; cp $VJ $BK/verifier.new.json; restore; t fit done, live gate restored
rm -rf .tmp/gold3-v4; cp -a .tmp/gold3-live .tmp/gold3-v4
npx tsc $BK/verify-model.new.ts --module commonjs --target es2020 --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0 --outDir .tmp/gold3-v4/new
cp .tmp/gold3-v4/new/verify-model.new.js .tmp/gold3-v4/src/lib/voice/verify-model.js
V=(); for x in steps skywest indep stress held rows talk; do one .tmp/gold3-v4 v4 $x $NAME & V+=($!); done
waitall "${L[@]}"; t live exams done
while kill -0 1624894 2>/dev/null; do sleep 2; done
waitall "${V[@]}"; t v4 exams done
python3 - < <(sed -n "/^python3 - <<'PY'/,/^PY\$/p" ml/rl/run_free4.sh | sed '1d;$d')
