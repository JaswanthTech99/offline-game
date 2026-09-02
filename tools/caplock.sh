#!/usr/bin/env bash
# Serialises frame-capturing test runs to at most 2 at a time.
#
# This host rasterises on the CPU (SwiftShader), so concurrent captures do not run in
# parallel - they queue on the same cores and every one of them gets slower. Logic tests can
# run wide; anything that reads pixels takes a slot here first.
#
#   tools/caplock.sh npx playwright test e2e/gates/foo.spec.ts --project="DESKTOP_HIGH@1x"
set -euo pipefail
LOCKDIR="${TMPDIR:-/tmp}/sp-capture-slots"
mkdir -p "$LOCKDIR"
for slot in 1 2; do
  exec {fd}>"$LOCKDIR/slot$slot"
  if flock -n "$fd"; then exec "$@"; fi
  exec {fd}>&-
done
# Both slots busy: block on slot 1 rather than failing.
exec {fd}>"$LOCKDIR/slot1"
flock "$fd"
exec "$@"
