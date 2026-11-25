#!/usr/bin/env bash
# Gate lab: every stand, pushback, taxi instruction and driven path of an airport, checked as plain geometry in seconds
# with the game's own code (no clock, no traffic, no browser). Works for any airport the game has a map for.
#   scripts/gatelab.sh KJFK          check everything (exit 1 when something needs fixing; report in public/reports)
#   scripts/gatelab.sh KJFK push     only gates | push | out | in (comma separated)
#   scripts/gatelab.sh KJFK fix      make the airport's stand plan: drop stands that are not real, size the rest, find a
#                                    clear pushback for each -> src/lib/sim/standplans/KJFK.json (then check again)
#   STANDS=B2,C1 RWYS=28L,01R TYPES=A320 NTYPES=2 ARR=28L FULL=1 JOBS=8 HTML=0 V=1
set -euo pipefail
cd "$(dirname "$0")/.."; mkdir -p .tmp
npx esbuild scripts/gatelab/lab.ts --bundle --platform=node --format=cjs --alias:@=./src --log-level=error --outfile=.tmp/gatelab.cjs
exec node scripts/gatelab/run.cjs "$@"
