# SHATTERPOINT — Architecture

A first-person on-rails glass-corridor runner. You fly forward, throw steel balls, shatter
glass; crystals refill throws; hitting glass costs balls; zero balls ends the run.

This document is the map and the seven rules that hold it together. Budgets live in
`docs/BUDGET.md`; content law lives in `docs/IP-POLICY.md`.

---

## 1. Module map

Dependencies point **inward and downward only**. `core/` imports nothing from the layers
above it — that is what lets the whole simulation be driven from a test with a synthetic
timeline and no renderer, no DOM and no GPU.

```
                       ┌──────────────────────────────────────────┐
                       │  core/                                   │
                       │  Engine · Loop · Quality · Caps ·        │
                       │  Events · types                          │
                       └──────────────────────────────────────────┘
                          ▲          ▲          ▲          ▲
        ┌─────────────────┘          │          │          └─────────────────┐
        │                            │          │                            │
  ┌───────────┐   ┌──────────────┐  ┌───────────────┐  ┌────────────┐  ┌───────────┐
  │ physics/  │   │  gameplay/   │  │  corridor/    │  │ universe/  │  │   ui/     │
  │ World     │◀──│ Run · Ball   │  │ Rings         │  │ registry   │  │ Overlay   │
  │ Colliders │   │ Shatter      │──▶ Exposure      │◀─│ themes/    │  │ hud/      │
  │ Pool      │   │ Throw · Ammo │  │               │  │ kits/      │  │ Nav·Motion│
  └───────────┘   │ Score·Panes  │  └───────────────┘  │ LightBus   │  └───────────┘
                  │ Crystals     │          ▲          └────────────┘        ▲
                  │ Balance      │          │                 ▲              │
                  │ Progression  │          │                 │              │
                  │ Voronoi      │   ┌──────────────┐  ┌────────────┐        │
                  └──────────────┘   │  render/     │  │  battle/   │────────┘
                                     │ PostChain    │  │ BeatTimeline
                                     │ Grade        │  │ Silhouettes
                                     │ VignetteNode │  │ rosters/ · timelines/
                                     └──────────────┘  └────────────┘
```

| Layer | Owns | Never does |
|---|---|---|
| `core/` | The renderer, the clock, the tier tables, device facts, the event bus, shared primitives | Know what a pane, a ball or a universe is |
| `physics/` | One Rapier world at fixed 60 Hz, pooled bodies, colliders | Allocate at play time; step from `frame()` |
| `gameplay/` | Run state machine, ammo=health, throwing, fracture, scoring, progression | Touch the renderer, the DOM or audio |
| `corridor/` | The ring field and the exposure histogram | Import a universe; it is handed one |
| `universe/` | Themes, architecture kits, the light bus, the registry | Contain a branch on universe id |
| `battle/` | The parallax backdrop cast, beat timelines, seeded RNG | Draw anything in the playfield |
| `render/` | The post chain, the grade, hand-rolled TSL nodes | Invent a magnitude |
| `ui/` | The DOM overlay, HUD, focus/nav, choreography | Animate anything but `transform`/`opacity` |
| `audio/`, `save/`, `util/` | Mixer, IndexedDB persistence (`Db` · `Schema`), shared helpers | Reach into the frame loop; they subscribe like everything else |

`audio` carries a `msBudget` row before it carries a module. That is deliberate: a subsystem
lands against a declared allowance instead of negotiating for one afterwards.

### What is allowed to hold a number

`core/Quality.ts` is the single source of truth for every **budget**. Three files legitimately
hold constants that are *not* budgets, and each says so in its own header:

* `corridor/Exposure.ts` — art-direction law. The histogram is the *look*; it is identical on a
  phone and on a 4K desktop, so tiering it would be tiering the game's identity.
* `universe/LightBus.ts` — semantic channel domains. What a value *means*, not what it costs.
* `battle/types.ts` — dramaturgy invariants. Also `gameplay/Balance.ts` for game feel, and each
  `universe/kits/*` for content dimensions in metres.

The test is simple: **if a faster GPU would want a different value, it is a budget and it lives
in `Quality.ts`.** If a faster GPU would want the same value, it lives with the thing it
describes.

---

## 2. Boot sequence

Strictly ordered. Each step exists because the step after it cannot be done without it.

1. **`index.html` → `src/main.ts`.** The document shell seeds its theme attributes itself; the
   entry module does nothing but call `Engine.create({ canvas })`.
2. **`probeCaps(canvas)`** — asks `navigator.gpu` for an adapter and reads its limits. This
   happens *before* the renderer is constructed, because the probe's answer is what the tier —
   and therefore the whole budget the renderer is configured against — is derived from.
3. **`new WebGPURenderer({ antialias: false, … })`.** MSAA is off on purpose: the post chain
   owns anti-aliasing, and paying for both means paying twice for the same glass edge.
4. **`await renderer.init()` — once, here, and nowhere else in the codebase.** In r185 every
   render and compute call after this point is synchronous; `renderAsync`/`computeAsync` are
   deprecated and are never called. **`create()` resolving *is* the ready signal.** There is no
   ready event to miss, because nothing can subscribe before the promise settles.
5. **`refineCaps(probed, renderer)`** — replaces the probe's guesses with what the created
   device actually gave us. `getFallback` can quietly hand back a WebGL backend after a
   perfectly healthy adapter probe, and a game that trusted the probe would then enable compute
   paths that cannot run.
6. **`resolveTier(caps, override)`** — resolves both axes at once and returns the
   `QualityResolution` everything downstream reads. Nothing re-derives a tier for itself.
7. **Pre-warm.** Physics bodies, shard pool, mote pool, particle pool, decals — all allocated to
   `budget.prewarm` sizes and parked disabled. Nothing may allocate after this point.
8. **Build the world.** Ring field at `budget.corridorRings`, theme from `THEMES[id]`, kit
   modules, battle roster. Materials capture `lightBus.uniforms` here, at build time.
9. **`engine.setRenderSource({ scene, camera })`**, then **`engine.setOutputNode(chain)`** once
   the post chain exists. Until an output node is set the engine draws the scene directly —
   which is also the no-post fallback path, not a placeholder.
10. **Subscribe.** Every system implements `Tickable` and joins with `engine.subscribe(t, order)`.
    Lower `order` ticks first; physics at the front, anything reading a physics transform behind it.
11. **`engine.start()`** — resets the clock so nothing is billed for load time, then arms the
    one `requestAnimationFrame`.

Teardown is `engine.dispose()`: it stops the loop, disconnects the observers, disposes the
pipeline and the renderer, and clears the bus. `dispose()` is idempotent everywhere, because
the shutdown walk reaches shared resources more than once.

---

## 3. The one-rAF rule

**There is exactly one `requestAnimationFrame` in SHATTERPOINT, in `src/core/Engine.ts`.**
ESLint bans the global everywhere via `no-restricted-globals`; Engine reaches it through
`globalThis` so the ban stays switched on in that file too. It is not an exemption. It is the
one call.

A second animation loop anywhere — a HUD tween, an audio meter, a debug graph — and the frame
stops being a frame: two callbacks per vsync means two independent clocks, the physics
accumulator sees a fraction of the real delta, and slow-motion drifts against the visuals.

Order inside `Engine.tick`, and why:

1. **Re-arm rAF first**, before any game work. A throw below then costs a single frame instead
   of stopping the loop forever — and still reaches the console unswallowed.
2. **`Loop.advance(now)`** — N fixed steps, then every subscriber's interpolated `frame(alpha)`.
3. **Render once**, after every system has posed itself for this alpha.
4. **Emit `engine:frame`**, so the profiler reads draw counts from the frame just drawn.

Everything else subscribes. `Tickable` is the only update contract there is:

```ts
interface Tickable {
  fixedUpdate(dt: Millis): void;  // exactly 60 Hz, dt constant, 0..N times per frame
  frame(alpha: Alpha): void;      // exactly once per rendered frame, must not mutate sim state
}
```

GSAP and Motion are in the dependency list for easing curves and DOM choreography, **not** for
their tickers. Anything that drives itself gets driven from `Overlay`'s `frame()` instead.

---

## 4. The fixed-step contract

`fixedUpdate` runs at exactly `FIXED_STEP_MS`, always, on every tier and every refresh rate. A
frame runs it zero, one or several times depending on accumulated wall clock, and `frame(alpha)`
draws the fraction of the way to the next step.

**Nothing ever scales a timestep.** A variable `dt` makes shatter impulses frame-rate dependent,
and a pane that explodes differently on a 144 Hz monitor is a different game.

* **Interpolation is the only smoothing.** `alpha ∈ [0,1]` is the sole quantity permitted to make
  presentation smoother than 60 Hz. `frame(alpha)` blends the last two completed steps into the
  buffers the renderer reads; it may not touch simulation state.
* **Slow motion is a frames-to-skip counter.** `setSlowMo(n)` means: run one physics step, then
  skip the next `n` entirely. The accumulator still drains at wall-clock rate, so the world moves
  at `1/(n+1)` speed while every step it *does* take is the same 1/60 s it always was. The
  simulation cannot tell it is in slow motion — which is the entire point: a shard trajectory
  sampled during a slow-mo replay matches the full-speed trajectory exactly. Alpha is stretched
  across the whole `(n+1)`-tick span so the draw glides instead of stepping. `n` is truncated to a
  whole number: a fractional skip could only be expressed as a scaled timestep, which is the thing
  this design bans.
* **The spiral of death is capped, never carried.** If a frame owes more steps than it can run, the
  ceiling is `physicsSubstepCap × (slowMoSkip + 1)` ticks. Time past the ceiling is **discarded**
  and reported as `LoopStats.droppedMs`. The world briefly runs slow, which the player barely
  notices, instead of the tab locking up, which they do. Carrying the debt forward is how the debt
  compounds.
* **Gaps are not charged.** `resetClock()` forgets the previous timestamp without touching the
  accumulator — first frame, tab un-hidden, long load. Pausing is the game layer's decision; the
  clock's only job is to refuse the bill.
* **`LoopStats` is one reused object.** Read it, never retain it, never mutate it. A fresh stats
  object per frame would be an allocation on the hottest path there is.

Determinism falls out of this: room composition is a pure function of `(seed, mode, absolute room
index)` — no wall clock, no `Math.random`, no device tier, no frame count — and each room forks its
own RNG stream from the run seed, so adding a draw to composition later cannot retroactively change
room 40 of every existing seed.

---

## 5. LightBus — the battle WRITES, materials READ

Five floats, one instance (`lightBus`), constructed at module load so it exists before any
material is compiled.

```
   battle/BeatTimeline  ──writes──▶   ┌───────────────────────────┐
   (the only writer)                  │  lightBus                 │
                                      │   emisIntensity  [0,8]    │
   set() · setChannel() · blendTo()   │   shaftOpacity   [0,1]    │
                                      │   brazierGlow    [0,4]    │
                                      │   skyDim         [0,1]    │
                                      │   rimBoost       [0,4]    │
                                      └───────────┬───────────────┘
                                                  │ uniforms: Node<'float'>
                    ┌────────────────┬────────────┼─────────────┬──────────────────┐
                    ▼                ▼            ▼             ▼                  ▼
             corridor rings    glass material   crystals   ball rim light   Exposure SITE 2/4
             (emissive trim)   (edge term)      braziers   shard edges      (skyDim darkens only)
```

The read side is typed as bare `Node<'float'>`. A consumer can compose those in any TSL graph but
**cannot reach `.value`** — so "materials read, battle writes" is enforced by the compiler, not by a
comment. Writes are clamped to the channel's semantic range on the way in, so a runaway beat cannot
blow the corridor to white.

> **Compositing a glow sprite, a flash quad, a screen-space overlay or an extra post pass on top of
> the frame to fake a battle light event is a failed implementation.** Not a shortcut — the wrong
> result. A decal over the image cannot brighten emissive trim on the far side of a pillar, cannot
> thicken a god ray, cannot put a rim on the ball in the player's hand, and cannot survive the glass
> refraction that sells the whole game. The distant lightning must light the near geometry. That only
> happens if these uniforms move. **If your change does not move a value on this bus, the battle is
> wallpaper.**

Interpolation is the caller's job: `blendTo(target, t)` takes an already-eased `t` so beat envelopes
stay reproducible under the fixed step instead of depending on `dt`.

---

## 6. The exposure histogram — four enforcement points

The first build of the corridor blew out to milky white. The cause was not one bad number, it was the
absence of a floor: every layer added light, nothing took light away, and a hundred faint translucent
surfaces summed to fog. The fix is a histogram — an explicit, measurable claim about how much of the
frame may be bright — enforced at **four** places, because a histogram enforced at three of them is a
histogram that leaks.

| | Site | Mechanism | Enforced by |
|---|---|---|---|
| **1** | Per-ring depth attenuation | Each further ring draws at lower group opacity (`nearOpacity 1.0 → farOpacity 0.14`, curve 1.35). The corridor **darkens** with distance. One float per instance (`ringDepth`), written once per fixed step — per-ring, not per-fragment, because per-fragment falloff is fog and fog is what went milky. `farOpacity` is deliberately not 0: a ring that vanishes takes its silhouette with it. | `depthAttenuationNode` / `ringOpacity`, monotonicity checked in `validateExposure` |
| **2** | The clamped aperture | The vanishing point is one authorised opacity (`APERTURE.op = 0.34`) with a pool of darkness composited **on top** of it, hard-clamped at `ceiling = 0.4`. That turns a white blob into a thin bright rim around a dark throat — the most legible depth cue the corridor has. The light bus may only ever *darken* it (`skyDim` subtracts), so the measured peak stays an upper bound whatever the battle does. | `apertureAlphaNode`, `aperturePeak()`; the DOM overlay reads the same number as `--aperture-op` |
| **3** | A black point at the frame edge | ONE authored vignette strength from `Quality.ts`, split by `splitEdgeDarkening` into an in-scene half and a post half. The in-scene half matters most: it darkens geometry **before bloom samples it**, so a glass edge in the corner cannot bloom back through a vignette applied after it. Applying the whole vignette in post is exactly how the corners went milky. A tier that drops the post half gives the in-scene half the *whole* strength — a tier may be cheaper, it may not lose the black point. | `sceneEdgeNode` + `postVignetteRequest` (r185 ships no `VignetteNode`; `render/VignetteNode.ts` is hand-rolled in TSL) |
| **4** | Emissives are exempt | Crystals, braziers, runes and the ball specular hotspot are parented **outside** the attenuation groups and are the only things allowed to reach full white. Safe only because they are small: `maxAreaShare 0.08`, `minContrastRatio 3.0`. The parentage *is* the enforcement — `emitterMesh` is a sibling of `attenuation`, never a child, and `exposureGraph()` reports what was actually built so the audit checks reality rather than intent. | `EMISSIVE_EXEMPT` table vs. `auditExposureGraph`; `attenuatedOpacityNode` is the only opacity graph an attenuated surface may use |

The rule that falls out, binding everywhere:

> ## CONTRAST, NOT MORE GLOW.

If something needs to read brighter, **darken what is around it.** Raising an emissive is the last
resort, never the first, because glow is additive and additive is how you get milk.

`validateExposure()` returns every violation at once (an artist retuning a theme wants the whole list,
not eight reload cycles); `assertExposureSane()` throws, and is the load-time gate a corridor must pass
before it reaches the renderer. `HISTOGRAM_LAW` is what "not milky" means numerically: median luminance
≤ 0.22, highlights above 0.7 covering ≤ 6% of frame, ≥ 15% of frame genuinely black, corner luminance
≤ 0.12.

---

## 7. Universes are data

**There is exactly one corridor renderer, one glass material and one mote system. A universe swaps the
numbers they read and nothing else.**

A universe is three records and no code:

| Record | File | What it declares |
|---|---|---|
| `UniverseTheme` | `universe/themes/<id>.ts` | Sky gradient, glass tint/alpha/edge, haze, fog falloff, mote kind and drift rates, emissives, metal/stone, grade LUT and warmths, unlock cost, and which kit and roster it points at |
| `ArchitectureKit` | `universe/kits/<id>.ts` | The corridor's *vocabulary* — modules, clearances, ring spacing, proportions in metres |
| `BattleRoster` | `battle/rosters/<id>.ts` | The backdrop cast (silhouette archetypes, parallax tier, size, anchor) and its beat timeline |

Registration is one line in `universe/registry.ts`. `THEMES` is keyed by `UniverseId` rather than
declared as an array, so **the compiler — not a test** — is what fails when a universe joins the union
and nobody authors its theme.

Three art-direction laws are asserted at load (`validateTheme`), all returning the full violation list:

1. **Bright horizon.** `sky.horizon` outglows `top`, `mid` and `low`. The horizon is the light source
   the whole corridor reads against; if another stop outglows it, the depth cue inverts and the
   corridor looks like a flat painted tube.
2. **Opposed grade warmth.** `shadowWarmth` and `highlightWarmth` always have opposite signs. A grade
   that warms both ends is just an exposure change; the split is the look.
3. **The roster exists.** A theme naming an unregistered roster shows an empty backdrop, and an empty
   backdrop reads as a bug rather than as calm.

Plus data hygiene the same pass enforces: `glass.edge` must outglow `glass.tint` or fracture lines
vanish, and `motes.driftRates` must descend near-to-far or the parallax inverts.

### The build rule

> **If a universe needs new code, the RECORD is wrong. Fix the record, not the universe.**

Concretely, when a new universe seems to need an `if` in a renderer:

1. **Stop.** Do not add the branch. One branch on universe id is the end of the system: the second one
   is free, the tenth is unmaintainable, and the corridor renderer becomes seven renderers wearing a
   trench coat.
2. **Name the axis.** The universe wants something the existing records cannot say. What *is* that, in
   general terms? Not "ashfall needs opaque air" but "haze density and fog falloff are separable".
3. **Add the field to the record type** — `UniverseTheme`, the kit interface, or the roster interface —
   with a range, a validator clause and a default that reproduces today's behaviour on all seven
   existing universes.
4. **The one renderer reads the new field, unconditionally.** No branch. Every universe now has a value
   for it, including the six that did not ask.
5. **Only then author the new universe's record.**

Adding an eighth universe is a theme file, a kit file, a roster file and one line in the registry. If
your diff touches a renderer's control flow, it is the wrong diff.

The same rule governs the kits: `kitDetailFor` reads the tier's own corridor budget rather than adding
a second tier table, so a tier is still described in exactly one file. And note the cycle discipline in
`kits/index.ts` — kit modules import helpers from it while it imports the kits back, which resolves
only because every binding a kit touches during its own evaluation is an erased type or a hoisted
`function`. **Never export a `const` from that file for a kit to consume at module scope**: it is in
the temporal dead zone while the kit evaluates and will throw on first import.

---

## 8. Cross-cutting rules

* **Two quality axes, never collapsed.** `Tier` is what the hardware can afford to draw, detected from
  caps. `MotionRules` is how much movement the *player* is willing to be subjected to, driven by
  `prefers-reduced-motion` and never by the GPU. An ULTRA_4K machine whose owner has reduced motion
  gets ULTRA_4K pixels and MOBILE_LOW motion. `resolveTier()` is the only place that pair is decided,
  and a debug override may force the graphics axis but **may not overrule the accessibility axis**.
* **Everything is pooled and pre-warmed.** Nothing allocates after boot. Pooling only helps if the pool
  is full before frame one; the validator enforces `prewarm ≥ live cap` for every pool.
* **Every compute path gates on `caps.hasCompute` and has a real non-compute fallback** — a *real*
  image, not a degraded one. `PostChain` re-runs the pure gate against actual device caps rather than
  trusting the caller, so a hand-built `QualityResolution` from a debug menu or a test cannot smuggle a
  compute-only effect onto a device with no compute queue.
* **All UI is a DOM overlay, animating `transform` and `opacity` only.** Browser-rendered text costs
  zero draw calls, zero atlas uploads and zero of the frame budget the shatter sim is fighting for. A
  `width`, `top`, `font-size` or `margin` animation drags layout and paint into the frame the player is
  watching a pane explode in. Every DOM **write** lands inside `frame()` — writing from inside a
  `ResizeObserver` callback is how a project earns a forced synchronous reflow it can never find again.
* **Cross-system messages go through `Emitter`, never a direct reference.** The corridor must be able to
  tell the mixer a pane shattered without holding it, or the two can never be built, torn down or
  profiled independently. Dispatch allocates nothing, honours removal mid-dispatch, ignores additions
  made during the same emit, and rethrows the first listener error *after* dispatch completes — so a
  broken HUD cannot silently eat a physics event, nor silently swallow its own bug.
* **Imports:** `three/webgpu`, `three/tsl`, `three/addons/*`. Bare `three` is a lint error — it silently
  drags in the WebGL renderer and every TSL node stops resolving.
* **No `any`, no `@ts-ignore`, no `@ts-expect-error`.** `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` are on; an indexed read is `T | undefined` and you handle it.
