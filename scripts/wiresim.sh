#!/usr/bin/env bash
# Wire simulator: whole sessions of the real game logic (traffic, pilots, radio, AI controllers, a player who follows the
# flight cards), nothing drawn, many seeds at once, every aircraft checked as an outline.
#   scripts/wiresim.sh KSFO            10 sessions of 40 minutes
#   scripts/wiresim.sh KSFO 40 60      40 sessions of an hour
#   SEEDS=3 WATCH=UAL12 scripts/wiresim.sh KSFO replay     one session again, with a trace of an aircraft
#   WHO=card|ai FLOW=0|1 BUSY=low|normal|high TALK=0|1 FROM=<first seed> JOBS=8 SHOW=10 V=1 HTML=0
set -euo pipefail
cd "$(dirname "$0")/.."; mkdir -p .tmp
npx esbuild scripts/wiresim/wire.ts --bundle --platform=node --format=cjs --alias:@=./src --jsx=automatic --loader:.css=empty --log-level=error --outfile=.tmp/wiresim.cjs
if [ "${2:-}" = replay ]; then ICAO="$1" exec node .tmp/wiresim.cjs; fi
exec node scripts/wiresim/run.cjs "$@"
