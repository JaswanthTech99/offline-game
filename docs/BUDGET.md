# SHATTERPOINT — Frame Budget

**Source of truth: `src/core/Quality.ts`. This document describes that file; it does not
extend it.** Every number below is read out of `QUALITY[tier]`. If a number here disagrees
with that file, this file is wrong — fix the doc, not the code, and if the code is what is
wrong, fix `Quality.ts` and then re-derive the tables here.

No numeric budget literal may appear anywhere else in `src/`. That rule is about source, not
prose: this document is allowed to quote the numbers precisely because it cannot be imported.

---

## 1. The frame

The simulation runs at a **fixed 60 Hz on every tier, forever** (`FIXED_STEP_HZ = 60`,
`FIXED_STEP_MS = 16.666…`). Only the *presentation* rate varies:

| Tier | `targetFps` | `msBudget.frame` | Meaning |
|---|---|---|---|
| `ULTRA_4K` | 60 | 16.6 ms | one physics step per frame |
| `DESKTOP_HIGH` | 60 | 16.6 ms | one physics step per frame |
| `MOBILE_HIGH` | 60 | 16.6 ms | one physics step per frame |
| `MOBILE_LOW` | 30 | 33.3 ms | **two** physics steps per frame; the sim never slows down |

`validateQualityTable()` asserts `msBudget.frame === 1000 / targetFps` (±0.1 ms) and that the
subsystem rows plus `spare` do not exceed `frame`. In DEV it throws at module load, so a tier
that cannot keep its own promise never reaches a player.

---

## 2. The one table

Milliseconds per presented frame. `Where` is the side of the fence the row is measured on —
`MsBudget` declares one number per subsystem, so a `both` row is charged the **larger** of its
CPU wall-clock span and its GPU timestamp span, never their sum.

| # | Subsystem | Where | ULTRA_4K | DESKTOP_HIGH | MOBILE_HIGH | MOBILE_LOW | What is charged to it |
|---|---|---|---|---|---|---|---|
| 1 | `physics` | CPU | **2.0** | 2.0 | 1.8 | 3.0 | `PhysicsWorld.fixedUpdate` — Rapier step, contact events, pooled body enable/disable |
| 2 | `shatter` | CPU | **2.2** | 2.4 | 2.0 | 3.0 | Voronoi cell lookup, shard spawn from pool, impulse assignment, shard retirement |
| 3 | `culling` | CPU | **0.8** | 0.7 | 0.6 | 1.2 | Ring recycling decisions, instance visibility, draw-list assembly against `drawCallCeiling` |
| 4 | `corridor` | both | **2.0** | 2.0 | 2.2 | 4.0 | Ring field instance writes (`ringDepth`), kit module placement, motes, glass material updates |
| 5 | `battle` | both | **1.0** | 0.9 | 0.8 | 1.2 | Backdrop silhouette instances, beat timeline advance, LightBus writes |
| 6 | `render` | GPU | **5.0** | 5.2 | 6.0 | 15.0 | Scene pass, shadow cascades, MRT — everything before the first post node |
| 7 | `post` | GPU | **2.6** | 2.4 | 2.2 | 3.5 | The whole `PostChain`, AO through LUT, at the tier's own render scale |
| 8 | `audio` | CPU | **0.3** | 0.3 | 0.3 | 0.6 | Mixer bookkeeping on the main thread only; synthesis and decode are off-thread |
| 9 | `ui` | CPU | **0.3** | 0.3 | 0.3 | 0.6 | DOM overlay writes inside `frame()`; `transform`/`opacity` only, no layout |
| | **subsystem subtotal** | | **16.2** | 16.2 | 16.2 | 32.1 | |
| 10 | `spare` | — | **0.4** | 0.4 | 0.4 | 1.2 | Declared slack: GC, browser work, the frame the OS takes back |
| | **`frame`** | | **16.6** | 16.6 | 16.6 | 33.3 | `1000 / targetFps` |

Rows 1–3 and 8–9 are pure CPU and can overrun while the GPU is idle; rows 6–7 are pure GPU and
can overrun while the CPU is idle. **A tier is over budget when any single row is over, not
when the total is** — a 60 fps frame that hits 16.6 ms because `shatter` took 6 ms is a
different bug from one that hits 16.6 ms because `render` did, and the profiler must name which.

### Conformance note — declared slack is 0.4 ms, not 2.0 ms

The design target for this table was an ULTRA_4K column of **≤ 14.0 ms of subsystem time with
≥ 2.0 ms of declared slack** (≤ 16.0 ms booked, inside a 16.6 ms frame). What
`QUALITY.ULTRA_4K.msBudget` actually declares today is **16.2 ms of subsystem time and 0.4 ms
of `spare`**, which fills the frame exactly. That is a real 2.2 ms gap and this document does
not round it away.

Closing it is an edit to `src/core/Quality.ts`, which this document does not own. The
redistribution below hits the target, keeps every row proportional to its current share, and
still satisfies `validateQualityTable()` (parts sum to 16.6 = `frame`):

| Row | now | proposed |
|---|---|---|
| `physics` | 2.0 | 1.8 |
| `shatter` | 2.2 | 2.0 |
| `culling` | 0.8 | 0.6 |
| `corridor` | 2.0 | 1.6 |
| `battle` | 1.0 | 0.8 |
| `render` | 5.0 | 4.4 |
| `post` | 2.6 | 2.2 |
| `audio` | 0.3 | 0.3 |
| `ui` | 0.3 | 0.3 |
| **subtotal** | **16.2** | **14.0** |
| `spare` | 0.4 | **2.6** |
| `frame` | 16.6 | 16.6 |

Until that lands, the shipped numbers are the ones in the main table, and a 4K machine has
0.4 ms of headroom rather than 2.0 ms.

---

## 3. Over budget for 30 frames → dev assert

A single overrun is noise: a shader compile, a GC pause, the compositor picking up a new
layer. A *sustained* overrun is a regression. The rule is therefore a counter, not a threshold.

Per subsystem, per frame:

```
if (measuredMs > budget[row])  overrunFrames[row] += 1
else                           overrunFrames[row]  = 0

if (overrunFrames[row] >= 30)  ->  ASSERT
```

**30 consecutive frames** is half a second at 60 fps and one second at 30 fps: long enough to
survive every legitimate spike listed above, short enough that the offending change is still
the last thing you touched.

What ASSERT means, by build:

* **DEV** — throw, naming the row, its budget, the measured value, the resolved tier and the
  frame index. It throws rather than warns for the same reason `validateQualityTable()` and
  `assertExposureSane()` throw: a budget nobody is stopped by is a comment. The throw lands in
  `Engine.tick`, which re-arms `requestAnimationFrame` *before* any game work, so the assert
  costs one frame and reaches the console unswallowed instead of killing the session.
* **PROD** — never throws. The counter feeds the dynamic-resolution controller, which steps one
  rung down `RENDER_SCALE_LADDER` inside the tier's own `[renderScaleMin, renderScaleMax]`
  window (`Engine.stepRenderScale(-1)`), and the event is counted for telemetry. A player gets
  a slightly softer frame; they never get a stack trace.

Measurement: GPU rows use timestamp queries where `caps.hasTimestampQuery` is true and fall
back to CPU submit-span timing where it is false — a tier without timestamps still gets an
assert, just a coarser one. `Loop` already smooths the whole-frame time
(`LoopStats.smoothedFrameMs`); per-subsystem counters use **raw** values, because smoothing a
number whose job is to catch a sustained overrun would only delay the catch.

The constant belongs in `core/Quality.ts` — it is a budget number — as
`OVER_BUDGET_FRAMES = 30`, added with the profiler that reads it.

> `spare` has no counter of its own. Overrunning `spare` *is* overrunning `frame`, which the
> loop already reports as `LoopStats.droppedMs > 0`.

---

## 4. Count budgets, per tier

Everything the frame budget above is paid *for*. All from `QUALITY[tier]`.

| Field | ULTRA_4K | DESKTOP_HIGH | MOBILE_HIGH | MOBILE_LOW |
|---|---|---|---|---|
| `renderScale` (start) | 0.67 | 1.0 | 0.8 | 0.6 |
| `renderScaleMin`–`Max` | 0.60–0.80 | 0.75–1.00 | 0.67–0.90 | 0.60–0.75 |
| `maxShardsLive` | 2400 | 1600 | 800 | 320 |
| `shardLifetimeMs` | 6000 | 5000 | 3500 | 2500 |
| `moteBudget` | 6000 | 4000 | 1800 | 600 |
| `particleBudget` | 12000 | 8000 | 3200 | 1200 |
| `prewarm.balls` | 32 | 32 | 24 | 16 |
| `prewarm.decals` | 256 | 192 | 96 | 48 |
| `shadowCascades` | 4 | 3 | 2 | 1 |
| `shadowMapSize` | 2048 | 2048 | 1024 | 512 |
| `shadowDistance` | 120 | 100 | 70 | 45 |
| `maxDynamicLights` | 12 | 8 | 4 | 2 |
| `physicsSubstepCap` | 4 | 4 | 3 | 3 |
| `drawCallCeiling` | 900 | 700 | 380 | 180 |
| `textureAnisotropy` | 16 | 8 | 4 | 2 |
| `corridorRings` | 26 | 22 | 16 | 11 |
| `battleInstanceCaps` h/m/f | 96/48/12 | 64/32/8 | 32/16/5 | 14/7/3 |

Two invariants the validator enforces, worth knowing before you edit a row:

* `prewarm.shards ≥ maxShardsLive`, `prewarm.motes ≥ moteBudget`,
  `prewarm.particles ≥ particleBudget`. **Pooling only helps if the pool is full before frame
  one** — a pool that grows at play time allocates during the exact frame it exists to protect.
* `physicsSubstepCap ≥ ceil(60 / targetFps)`. `MOBILE_LOW` needs at least 2 and declares 3.

`renderScale` is why ULTRA_4K is affordable at all: 4K native spends the whole frame on pixels
nobody can resolve, so the tier renders at 0.67 and TAAU reconstructs. Its ladder maxes at
**0.8** — ULTRA_4K is *never* rendered native, by design.

---

## 5. Post chain, per tier

The `post` row above buys this. `resolvePostChain()` gates it twice more at runtime — once on
`caps.hasCompute`, once on reduced motion — and every drop has a declared stand-in.

| Effect | ULTRA_4K | DESKTOP_HIGH | MOBILE_HIGH | MOBILE_LOW | Needs compute |
|---|---|---|---|---|---|
| `gtao` | ✓ | ✓ | ✓ | — | no |
| `ssr` | ✓ | ✓ | — | — | no |
| `ssgi` | ✓ | — | — | — | **yes** |
| `godrays` | ✓ | ✓ | ✓ | — | no |
| `bloom` | ✓ | ✓ | ✓ | ✓ | no |
| `dof` | ✓ | ✓ | — | — | no |
| `motionBlur` | ✓ | ✓ | — | — | no |
| `traa` | — | ✓ | — | — | no |
| `taau` | ✓ | — | — | — | **yes** |
| `fsr1` | — | — | ✓ | — | no |
| `smaa` | — | ✓ | — | — | no |
| `fxaa` | — | — | ✓ | ✓ | no |
| `chromaticAberration` | ✓ | ✓ | — | — | no |
| `film` | ✓ | ✓ | ✓ | — | no |
| `vignette` | ✓ | ✓ | ✓ | ✓ | no |
| `lut` | ✓ | ✓ | ✓ | ✓ | no |
| `sharpen` | ✓ | — | ✓ | — | no |

Three fallback rules are structural, not optional:

1. **No compute → no TAAU, but the upscale survives.** The frame is rendered below display
   resolution either way, so `resolvePostChain` turns on `fsr1` + `sharpen`. Something must
   reconstruct it.
2. **No temporal AA → FXAA.** Losing every AA path would ship aliased glass edges, and glass
   edges are the game. FXAA is payable on anything.
3. **Reduced motion drops `motionBlur` and `chromaticAberration`** on any tier. Those live on
   the motion axis, not the graphics axis — see `POST_BLOCKED_BY_REDUCED_MOTION`.

`vignette` and `lut` are on at every tier including `MOBILE_LOW`: they cost almost nothing and
they are most of what makes the frame look authored rather than default. The vignette is also
load-bearing for exposure — it is half of SITE 3 (`docs/ARCHITECTURE.md` §6), so a tier that
switches the *post* half off gives the whole authored strength to the in-scene half rather than
losing the black point.

---

## 6. Editing a budget

1. Change the number in `src/core/Quality.ts`. Only there.
2. Run `npm run typecheck`, then load in DEV — `validateQualityTable()` runs at import and will
   reject an internally inconsistent table before anything renders.
3. Re-derive the affected table in this file.
4. If your change needed a literal somewhere outside `Quality.ts`, the change is wrong.
