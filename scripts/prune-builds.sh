#!/usr/bin/env bash
# Keep only the newest old builds of the site (.next/standalone-before-*, 1.7 GB each; a deploy puts the live one aside
# under that name before it swaps the new one in). Run it after every deploy:  scripts/prune-builds.sh
# KEEP=2 is how many stay for rollback; DRY=1 only says what would go. The live build, builds being prepared
# (standalone-HHMM) and any build a program is running from are never touched.
set -euo pipefail
cd "$(dirname "$0")/../.next"
KEEP=${KEEP:-2}
[[ $KEEP =~ ^[1-9][0-9]*$ ]] || { echo "prune-builds: KEEP must be 1 or more"; exit 1; }
# newest first, by when it was put aside (a rename sets the change time)
mapfile -t old < <(find . -mindepth 1 -maxdepth 1 -type d -name 'standalone-before-*' -printf '%C@ %f\n' | sort -rn | cut -d' ' -f2-)
for d in "${old[@]:$KEEP}"; do
  busy=
  for l in /proc/[0-9]*/cwd; do case "$(readlink "$l" 2>/dev/null || true)" in "$PWD/$d"|"$PWD/$d"/*) busy=1;; esac; done
  if [ -n "$busy" ]; then echo "prune-builds: $d is in use, kept"; continue; fi
  if [ -n "${DRY:-}" ]; then echo "prune-builds: would delete $d"; continue; fi
  rm -rf -- "./$d" && echo "prune-builds: deleted $d"
done
echo "prune-builds: kept ${old[*]:0:$KEEP}"
