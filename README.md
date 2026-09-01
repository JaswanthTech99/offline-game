# SHATTERPOINT

A premium first-person on-rails glass-corridor runner. You fly forward down a receding
corridor of glass, throw steel balls, and shatter everything in front of you. Crystals refill
your throws; hitting glass costs you a ball; at zero balls the run ends.

Balls are both ammunition and health. There is one number, and it is always visible.

Offline-first (PWA, IndexedDB saves), WebGPU-first with a real WebGL fallback, and built to a
declared millisecond budget on four hardware tiers.

## Stack — pinned, and not to be changed casually

| | |
|---|---|
| Renderer | **three.js 0.185.1**, WebGPU + TSL (`three/webgpu`, `three/tsl`, `three/addons/*`) |
| Physics | **@dimforge/rapier3d-compat 0.20.0** (WASM, fixed 60 Hz) |
| Language | **TypeScript 5.9.3**, strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` |
| Build | **Vite 8.2.2** (Rolldown) + `vite-plugin-wasm` + `vite-plugin-pwa` 1.3.0 |
| Styles | **Tailwind 4.3.3** via `@tailwindcss/vite` — configured in CSS with `@theme`, no `tailwind.config.js` |
| Motion | **gsap 3.15.0**, **motion 13.1.1** — for easing curves and DOM choreography, never for their tickers |
| Storage | **idb 8.0.3** |
| Lint | **eslint 9.39.0** + **typescript-eslint 8.46.0** |

Node ≥ 20.19. Dependencies are installed and pinned exactly; **do not run `npm install`.**

Three import rules the lint config enforces, because each one is load-bearing:

* Import from `three/webgpu`, `three/tsl` or `three/addons/*`. **Bare `three` is an error** — it
  silently drags in the WebGL renderer and every TSL node stops resolving.
* **One `requestAnimationFrame` exists**, in `src/core/Engine.ts`. The global is banned
  everywhere else; subscribe to the loop instead.
* No `any`, no `@ts-ignore`, no `@ts-expect-error`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 59593 (`0.0.0.0`, strict). WebGPU needs a secure context — localhost qualifies. |
| `npm run build` | `tsc -b --noEmit` then `vite build` |
| `npm run preview` | Serve the production build on the same port |
| `npm run typecheck` | `tsc -b --noEmit` — the gate that matters most while the layers are landing |
| `npm run lint` | `eslint src tools --max-warnings=0` |
| `npm run budget` | `node tools/budget.mjs` — checks the frame budget tables |
| `npm run silhouettes` | `node tools/silhouettes.mjs` — renders backdrop silhouette proofs to `docs/silhouettes/` |

`tools/` is populated by the steps that own each generator, so a script may be declared before
its tool exists. `typecheck` and `lint` are the gates that are always live.

## The architecture in five lines

1. **`core/Engine.ts` owns the only `requestAnimationFrame`.** `await renderer.init()` happens
   once inside `Engine.create`; everything after it is synchronous, and everything that needs
   per-frame time implements `Tickable` and subscribes.
2. **Simulation is a fixed 60 Hz step interpolated by `alpha`** on every tier. No timestep is
   ever scaled — slow motion is a frames-to-skip counter, so a shard's trajectory is identical
   at full speed and in replay.
3. **`core/Quality.ts` is the single source of truth for every number.** Four tiers on the
   graphics axis, an independent motion axis driven by `prefers-reduced-motion`, and a
   millisecond budget per subsystem that the file asserts against itself at load.
4. **A universe is data.** One corridor renderer, one glass material, one mote system; a theme,
   a kit and a roster swap the numbers they read. A universe that needs new code means the
   record is wrong.
5. **The battle writes the light bus; materials read it — and the exposure histogram is
   enforced at four points**, so distant lightning genuinely lights near geometry and the
   corridor never goes milky. Contrast, not more glow.

## Documentation

| Document | Read it when |
|---|---|
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | Before writing any code. The module map, boot sequence, the one-rAF and fixed-step contracts, the LightBus flow, the exposure histogram's four sites, and the "universes are data" build rule. |
| **[docs/BUDGET.md](docs/BUDGET.md)** | Before adding work to a frame. The per-tier CPU/GPU millisecond table, the count budgets, and what happens when a subsystem runs over for 30 frames. |
| **[docs/IP-POLICY.md](docs/IP-POLICY.md)** | Before adding any character, name, silhouette, palette or roster. Original or public-domain-mythological content only, from primary sources. Governs every roster addition. |
| **[docs/GIT-ACCOUNT-SETUP.md](docs/GIT-ACCOUNT-SETUP.md)** | Setting up or debugging this folder's isolated git identity. |

## Git account

This folder is intentionally isolated from every other repo on this machine.
It commits and pushes as **JaswanthTech99 <jaswanthkumartech@gmail.com>** only.

- Identity is set in `.git/config` (local) — there is no global git identity on this box.
- HTTPS credentials come from `.git/credentials-jaswanthtech99` (mode 600, inside `.git`, never committed).
- The inherited credential helper chain is reset for this repo, so the VS Code
  `JaswanthTilli` GitHub session is never consulted here.
- All other repos (e.g. `~/nudge`, `~/UIonly/nudge-1`) use SSH + their own local
  identity and are completely unaffected.

## Using gh in this folder

    source ./use-tech99.sh
    gh auth status     # -> JaswanthTech99

That points `GH_CONFIG_DIR` at this folder's own `.gh-config`, so `gh` elsewhere
is unaffected.
