#!/usr/bin/env bash
# Second half of fast4.sh: the v4 exams on the frozen build with the fitted gate, then the verdict (same rule, run_free4.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."; BK=ml/verify/out/free4
cp .tmp/gold3-v4/new/verify-model.new.js .tmp/gold3-v4/src/lib/voice/verify-model.js
V=(); for x in steps skywest indep stress held rows talk; do node .tmp/gold3-v4/ml/stt/gold_chain.js chain ml/s1/freeword/$x.json public/models/s1/2m-free-v4 > $BK/v4.$x.json & V+=($!); done
for p in "${V[@]}"; do wait $p; done
while pgrep -f '^node .tmp/gold3-live/ml/stt/gold_chain.js' > /dev/null; do sleep 2; done
for x in steps skywest indep stress held rows talk; do for c in live v4; do test -s $BK/$c.$x.json || { echo "missing $c $x"; exit 1; }; done; done
python3 <(sed -n "/^python3 - <<'PY'/,/^PY\$/p" ml/rl/run_free4.sh | sed '1d;$d')
