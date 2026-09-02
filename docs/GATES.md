# Gate ledger

A gate is re-run only when a file it depends on changes. Everything marked PASS here has
been measured on this host and must not be re-derived.

Host: Azure VM, **no GPU** (`lspci` VGA/3D none, `/dev/dri` has no render node,
`virt=microsoft`). Chromium rasterises through SwiftShader. Correctness is exact; frame
RATE is meaningless and is never asserted on.

Re-run everything with `npm run test:gates`. One project: add
`--project="DESKTOP_HIGH@1x"`.

| Pass | Stage | Gate | Measured | Budget | Status | Depends on |
|---|---|---|---|---|---|---|
| Render | 0 | tier override + diagnostics | ratio 2.000, AA `traa,smaa` | ratio >= 1.0, not FXAA | PASS | `Quality.ts`, `Diagnostics.ts`, `Engine.ts` |
| Render | 1 | glass legibility, 7 distances | rim/bg 2.82-11.48x; greyscale delta 31-64pp | >= 1.25x; > 5pp | PASS | `GlassMaterial.ts` |
| Render | 2 | value structure | edge 3.82%, corner 2.49%, >80% 1.85% | < 6%, < 6%, < 2% | PASS | `app.css`, `Playfield.ts`, `VignetteNode.ts` |
| Render | 2 | mid-tone band | 22.50% | >= 25% | **FAIL** | as above |
| Render | 3 | geometry density | 598 elements / 62 draws | >= 400 / <= 700 | PASS | `Playfield.ts` |
| Render | 5 | three-phase shatter | `flash -> hitstop -> release` | ordered | PASS | `ShatterFx.ts` |
| Play | A | difficulty director | 0 mixed rows; 0/10 runs ended < approach 5 | 0; 0 | PASS | `Balance.ts` |
| Play | B | ball economy | 11/11 self-test rows | all | PASS | `Balance.ts`, `Playfield.ts` |
| Play | C | crystal solidity | rim/bg 2.12-4.76x; facets 3-10 | >= 1.25x; >= 3 | PASS | `Playfield.ts` |
| Play | E | HUD truth | SHARDS peak 25; scale 1.00/1.00; fps floor-scored | > 0; resolved; honest | PASS | `Hud.ts` |
| Detail | 0 | Playwright matrix | 24/24 in 4.3m | all green | PASS | `playwright.config.ts`, `DebugBridge.ts`, `game.ts` |

## Known FAIL

**Render Stage 2, mid-tone band — 22.50% against a 25% budget.** Eight attempts. Brightening
pushes pixels *through* the band rather than into it, and widening the lit area adds
far-corridor darks. The frame does not contain 25% worth of mid-tone *surface*: a large
fraction is intentionally-black vignette border plus the dark vanishing point. Closing it
needs more mid-tone surface area in frame - a wider corridor or nearer walls - which is a
composition change, not a grading one.

## Not asserted, and why

- **Frame rate.** No GPU on this host. `fps` is reported but never gated.
- **Interactive sharpness.** Same reason. 4K stills are produced by `npm run export:4k`,
  which does not need a GPU because a still is just a slow frame.
