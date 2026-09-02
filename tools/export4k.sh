#!/usr/bin/env bash
#
# The 4K still export. One 3840x2160 PNG per tier into exports/, supersampled 2x.
#
#   tools/export4k.sh                       # all four tiers
#   tools/export4k.sh --project=DESKTOP_HIGH@4x   # one tier
#
# WHY THIS EXISTS RATHER THAN A BARE `playwright test`
#   * SP_EXPORT_4K=1 is the only opt-in the spec can see. A worker cannot read the command
#     line - testInfo.config.grep reports the config default whatever --grep was passed -
#     so the export gates itself on env, and this script is what sets it. Without it the
#     spec skips, which is exactly what a normal gate run wants.
#   * --workers=1. The four tiers each render 33 megapixels on a CPU rasteriser. Run four
#     at once and they queue on the same cores while each holds a ~500MB set of render
#     targets; serial is both faster in wall clock and the only version that does not risk
#     an out-of-memory kill.
#   * caplock. Frame-capturing runs take one of two shared slots across every agent on this
#     host, and this is the most expensive capture in the repo.
#
# SP_EXPORT_HIDE_HUD=1 exports a clean plate instead of the shipped composite.
set -euo pipefail
cd "$(dirname "$0")/.."
export SP_EXPORT_4K=1
exec tools/caplock.sh npx playwright test e2e/gates/export4k.spec.ts \
  --grep @export4k --workers=1 --reporter=list "$@"
