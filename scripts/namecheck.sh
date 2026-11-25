#!/usr/bin/env bash
# Are the simple taxiway and stand names understood as well as the real ones? (scripts/namecheck/namecheck.ts)
#   scripts/namecheck.sh KSFO 300
set -euo pipefail
cd "$(dirname "$0")/.."; mkdir -p .tmp
npx esbuild scripts/namecheck/namecheck.ts --bundle --platform=node --format=cjs --alias:@=./src --log-level=error --outfile=.tmp/namecheck.cjs
exec node .tmp/namecheck.cjs "$@"
