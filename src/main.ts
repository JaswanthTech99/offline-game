/**
 * THE COMPOSITION ROOT.
 *
 * Every module in SHATTERPOINT is written so that it can be constructed in a test with no
 * globals, no DOM and no GPU. The price of that discipline is that something, somewhere,
 * has to know the real wiring order and pay for all of it at once. This is that file, and
 * it is the ONLY file allowed to reach for `document`, for the URL, or for a singleton.
 *
 * THE ORDER IS NOT ARBITRARY. Each step below exists because the one after it cannot be
 * done first:
 *
 *   1. DOM handles          - nothing can report a failure until there is somewhere to
 *                             report it, so the boot veil is resolved before anything
 *                             that can fail.
 *   2. Probe + provisional  - the veil is on screen for the whole of steps 3 and 4. It
 *      tier                   should already be wearing the right preset, and a machine
 *                             with no WebGPU and no WebGL2 should be told so now rather
 *                             than after a renderer construction that cannot succeed.
 *   3. Physics              - Rapier is WASM and every constructor in it traps before the
 *                             module instantiates. It is started here and awaited later,
 *                             because it is network- and compile-bound while the renderer
 *                             is GPU-bound: run serially they add, run together they max.
 *   4. Engine               - owns `await renderer.init()`, the caps refinement that
 *                             follows it, and the one requestAnimationFrame in the
 *                             codebase. Its resolved tier supersedes step 2's guess.
 *   5. Post chain           - needs the renderer, the scene, the camera, the refined caps
 *                             and the theme, which is why it cannot be built any earlier.
 *   6. Theme                - loaded before the chain is constructed: the grade's split
 *                             tone and LUT intensity are read at graph-build time.
 *   7. UI                   - motion first (it installs the sheet every widget animates
 *                             against), then the overlay, then the HUD inside it.
 *   8. Start                - the veil comes down and the loop begins, in that order, so
 *                             the first frame the player sees is a rendered one.
 *
 * WHAT IS DELIBERATELY NOT HERE: the corridor, the run, input and audio. Their seams are
 * marked TODO(step-2) at the point they attach. Everything that IS here is real - the
 * physics world steps, the post chain renders, the HUD is mounted and ticked.
 */

import './styles/tokens.css';
import './styles/app.css';

import { Color, PerspectiveCamera, Scene, Vector2 } from 'three/webgpu';

import { probeCaps } from './core/Caps';
import { collectDiagnostics, reportDiagnostics } from './core/Diagnostics';
import { Engine } from './core/Engine';
import type { EngineOptions } from './core/Engine';
import type { Tier } from './core/Quality';
import { GLASS, TIERS, resolveTier, validateQualityTable } from './core/Quality';
import type { Tickable } from './core/types';
import { PhysicsWorld, initPhysics } from './physics/PhysicsWorld';
import { PostChain } from './render/PostChain';
import { enforceTouchTargets } from './ui/Focus';
import { installMotion } from './ui/Motion';
import { Overlay } from './ui/Overlay';
import { Hud } from './ui/hud/Hud';
import type { HudLocation } from './ui/hud/Hud';
import { ROOMS_PER_ZONE } from './gameplay/Balance';
import type { UniverseId } from './universe/UniverseTheme';
import { UNIVERSE_IDS } from './universe/UniverseTheme';
import { getTheme } from './universe/registry';
import { RING_LAYOUT } from './corridor/Rings';
import { Playfield } from './gameplay/Playfield';
import { reportSelfTest, runSelfTest } from './gameplay/SelfTest';
import type { SelfTestRow } from './gameplay/SelfTest';
import { asSeed } from './core/types';
import type { Seed, Unit } from './core/types';

/**
 * Camera framing. NOT a performance budget, which is why it is here and not in
 * core/Quality.ts - the field of view is identical on a phone and on a workstation, and a
 * tier that changed it would be a different game rather than a cheaper one. This is the
 * same split ui/Overlay.ts makes for its breakpoints and universe/LightBus.ts makes for
 * its channel ranges. The far plane is NOT in this table: it is derived from the tier's
 * `corridorRings`, because how far you can see genuinely is a budget.
 */
const CAMERA = Object.freeze({
  /** Wide enough that the corridor walls stay in frame and the speed reads at the edges. */
  fovDeg: 68,
  nearMetres: 0.08,
  /** Slack past the last ring so the furthest geometry is never clipped as it recycles. */
  farMarginMetres: 12,
});

/**
 * Matches the `--dur-scene` fade on `.boot[data-state='done']` in app.css. Not a budget:
 * it is how long a CSS transition takes, and the only reason it is a number here is that
 * `transitionend` does not fire when the element was never composited in the first place.
 */
const VEIL_REMOVE_MS = 600;

/** Tier name -> the `data-preset` value src/styles/app.css collapses on. */
function presetFor(tier: Tier): string {
  return tier.toLowerCase().replaceAll('_', '-');
}

/** `?tier=MOBILE_LOW` forces the GRAPHICS axis only; motion still follows the OS. */
function tierOverrideFrom(params: URLSearchParams): Tier | null {
  const raw = params.get('tier');
  if (raw === null) return null;
  const wanted = raw.toUpperCase().replaceAll('-', '_');
  return TIERS.find((tier) => tier === wanted) ?? null;
}

/**
 * A run's seed. Fixed by default rather than random: every boot must be reproducible, and
 * `Math.random` is banned in src/ for exactly that reason. `?seed=` overrides it so a bug
 * report can name the corridor it happened in.
 */
const DEFAULT_SEED = 0x51a77e40;

function seedFrom(params: URLSearchParams): Seed {
  const raw = params.get('seed');
  if (raw === null) return asSeed(DEFAULT_SEED);
  const parsed = Number.parseInt(raw, 10);
  return asSeed(Number.isFinite(parsed) ? parsed : DEFAULT_SEED);
}

function universeFrom(params: URLSearchParams): UniverseId {
  const raw = params.get('universe');
  const match = UNIVERSE_IDS.find((id) => id === raw);
  // void-cathedral is the zero-cost universe in the registry, so it is the only one that
  // is guaranteed to be unlocked for a player who has never finished a run.
  return match ?? 'void-cathedral';
}

function requireElement<K extends keyof HTMLElementTagNameMap>(
  id: string,
  tag: K,
): HTMLElementTagNameMap[K] {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`main: #${id} is missing from index.html.`);
  if (node.tagName.toLowerCase() !== tag) {
    throw new Error(`main: #${id} is a <${node.tagName.toLowerCase()}>, expected <${tag}>.`);
  }
  return node as HTMLElementTagNameMap[K];
}

interface Shell {
  readonly app: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly overlayHost: HTMLDivElement;
  readonly veil: HTMLDivElement;
  readonly status: HTMLParagraphElement;
}

function resolveShell(): Shell {
  return {
    app: requireElement('app', 'div'),
    canvas: requireElement('stage', 'canvas'),
    overlayHost: requireElement('overlay', 'div'),
    veil: requireElement('boot', 'div'),
    status: requireElement('boot-status', 'p'),
  };
}

function say(shell: Shell, message: string): void {
  shell.status.textContent = message;
}

/**
 * The only way anything in this file reports a problem to the player.
 *
 * The veil is re-attached first because the failures worth reporting are not all boot
 * failures: a lost GPU device arrives minutes into a run, long after the veil was removed
 * from the DOM, and writing a message into a detached node would leave the player staring
 * at a frozen last frame with no explanation at all.
 */
/**
 * A failure whose message was written for the player. Everything else that can be thrown
 * during boot - a null WebGL context, a TSL node that would not compile, a WASM fetch that
 * 404'd - produces a message written for whoever wrote the code, and putting one of those
 * on screen tells the player nothing they can act on while looking like the game crashed.
 * The technical detail always reaches the console; only this class reaches the veil.
 */
class BootFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootFailure';
  }
}

/** What the player is told when the thrown error was not written for them. */
const GENERIC_FAILURE =
  'This device could not start the graphics engine. Try another browser, or turn on hardware acceleration and reload.';

function fail(shell: Shell, message: string, cause: unknown): void {
  // The player gets the sentence; the console gets the object. Rendering a stack into the
  // veil is how a WebGPU error message ends up in a screenshot on a support thread.
  console.error('[shatterpoint]', message, cause);
  if (!shell.veil.isConnected) shell.app.append(shell.veil);
  shell.veil.dataset['state'] = 'failed';
  shell.status.dataset['tone'] = 'fail';
  shell.status.textContent = message;
}

/**
 * Drives PostChain from the one loop that exists.
 *
 * PostChain owns its own RenderPipeline, so `engine.setOutputNode` is deliberately never
 * called: doing both would build a second pipeline around the same output node and render
 * the frame twice. With the engine's own pipeline and render source both left null, its
 * `renderFrame()` is a no-op and this stage is the only thing that draws. It is subscribed
 * last so every system has finished writing transforms before the frame is composed.
 */
class PostStage implements Tickable {
  private readonly chain: PostChain;

  constructor(chain: PostChain) {
    this.chain = chain;
  }

  // Both are declared without parameters on purpose: a method that ignores its arguments
  // still satisfies Tickable structurally, and naming them only to discard them is how a
  // file collects lint suppressions.
  fixedUpdate(): void {
    // Rendering is a presentation concern; it has no business inside the fixed step.
  }

  frame(): void {
    this.chain.render();
  }
}

/** Tick order. Lower runs first: physics produces transforms, the HUD reads them. */
/** Below this the HUD starts shouting. A design number, not a budget. */
const LOW_BALL_WARNING = 5;

const ORDER = Object.freeze({
  physics: 0,
  corridor: 100,
  ui: 500,
  render: 1000,
});

interface App {
  readonly engine: Engine;
  readonly physics: PhysicsWorld;
  readonly post: PostChain;
  readonly overlay: Overlay;
  readonly hud: Hud;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly playfield: Playfield;
}

async function boot(shell: Shell): Promise<App> {
  const params = new URLSearchParams(globalThis.location.search);
  const tierOverride = tierOverrideFrom(params);

  if (import.meta.env.DEV) {
    const violations = validateQualityTable();
    if (violations.length > 0) {
      throw new Error(`core/Quality.ts table is inconsistent:\n${violations.join('\n')}`);
    }
  }

  // ---- 2. Provisional tier ------------------------------------------------------------
  // This probe's answer is used for exactly two things and then thrown away: dressing the
  // veil in the right preset while the device boots, and refusing early on hardware that
  // has neither backend. The tier that configures the renderer comes from Engine, which
  // probes again and then refines against the device it actually received - an adapter can
  // report a healthy WebGPU stack and still hand back a WebGL fallback backend.
  say(shell, 'Reading device');
  const probed = await probeCaps(shell.canvas);
  if (!probed.hasWebGPU && !probed.hasWebGL2) {
    throw new BootFailure('This browser has neither WebGPU nor WebGL2, and the game needs one of them.');
  }
  const root = document.documentElement;
  root.dataset['preset'] = presetFor(resolveTier(probed, tierOverride).graphics);

  // ---- 3. Physics ---------------------------------------------------------------------
  // Started, not awaited. Rapier's WASM fetch and compile overlap the GPU device request
  // below, which is the single largest saving available anywhere in the boot path.
  const physicsReady = initPhysics();

  // ---- 4. Engine ----------------------------------------------------------------------
  say(shell, 'Starting the renderer');
  const forceWebGL = params.get('webgl') === '1';
  // Built conditionally rather than with `forceWebGL: undefined`: exactOptionalPropertyTypes
  // is on, so an explicitly-undefined optional is not the same as an absent one.
  const rawScale = Number.parseFloat(params.get('scale') ?? '');
  const scaleOverride = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : undefined;
  const engineOptions: EngineOptions = forceWebGL
    ? { canvas: shell.canvas, tierOverride, forceWebGL: true, scaleOverride }
    : { canvas: shell.canvas, tierOverride, scaleOverride };
  const engine = await Engine.create(engineOptions);

  const quality = engine.quality;

  root.dataset['preset'] = presetFor(quality.graphics);
  // The preset axis is image quality; this one is movement. core/Quality.ts keeps them
  // independent, and so must the DOM: a workstation whose owner asked for stillness keeps
  // every pixel of the ULTRA_4K look and loses only the animation.
  if (quality.reducedMotion) root.dataset['motion'] = 'reduced';
  else delete root.dataset['motion'];

  say(shell, 'Warming physics');
  await physicsReady;
  const physics = new PhysicsWorld(quality.budget);
  engine.subscribe(physics, ORDER.physics);

  // ---- 5/6. Scene, theme, post chain --------------------------------------------------
  const theme = getTheme(universeFrom(params));

  const scene = new Scene();
  // A real clear colour rather than black, so a frame that renders nothing else still
  // proves the whole chain ran. The corridor replaces this with the sky gradient.
  scene.background = new Color().copy(theme.sky.low);

  const camera = new PerspectiveCamera(
    CAMERA.fovDeg,
    1,
    CAMERA.nearMetres,
    RING_LAYOUT.nearDistance +
      quality.budget.corridorRings * RING_LAYOUT.spacing +
      CAMERA.farMarginMetres,
  );
  scene.add(camera);

  // The corridor is the level. It owns its own ring pool and the exposure histogram, so
  // all this has to do is hand it the theme and let the loop drive it.
  if (params.get('selftest') === '1') {
    const rows = runSelfTest(theme, quality.budget.corridorRings);
    const ok = reportSelfTest(rows);
    window.__spSelfTest = { rows, pass: ok };
  }

  say(shell, 'Raising the corridor');
  // Snapshot state the HUD reads every frame. Mutated by the playfield's callbacks and
  // read in the frame handler below, so the HUD never does work inside a fixed step.
  let ballsNow = 0;
  let scoreNow = 0;
  let multiplierNow = 1;
  let streakNow = 0;
  let runOver = false;

  const playfield = new Playfield({
    scene,
    camera,
    theme,
    seed: seedFrom(params),
    ringBudget: quality.budget.corridorRings,
    maxShards: quality.budget.maxShardsLive,
    dustCount: quality.budget.dustSprites,
    // ?glass=off is the A/B control for the optical pass; anything else takes the tier's row.
    glass: params.get('glass') === 'off'
      ? { fresnel: false, bevel: false, refraction: false, streak: false, microNoise: false }
      : GLASS[quality.graphics],
    caustics: params.get('glass') === 'off' ? false : GLASS[quality.graphics].caustics,
    events: {
      onBallsChanged: (balls) => {
        ballsNow = balls;
      },
      onScoreChanged: (score, multiplier, streak) => {
        scoreNow = score;
        multiplierNow = multiplier;
        streakNow = streak;
      },
      onRunOver: () => {
        runOver = true;
      },
    },
  });
  engine.subscribe(playfield, ORDER.corridor);

  // TODO(step-2): the mote system and the key light. The light is what the godrays stage
  // marches through, so passing null below is not a placeholder: it is the correct value
  // for a scene with no shadow-casting key light yet, and PostChain reports the stage as
  // skipped rather than pretending it built.
  say(shell, 'Building the post chain');
  const post = new PostChain({
    renderer: engine.renderer,
    scene,
    camera,
    quality,
    caps: engine.caps,
    theme,
    keyLight: null,
  });

  // Printed once the post chain exists, because the live AA node list is part of the
  // picture and only the chain knows which stages actually built. `tierOverride` is the
  // authority on the source: resolveTier takes `override ?? detectTier(caps)`, so a
  // non-null override means detectTier never ran.
  {
    const drawing = engine.renderer.getDrawingBufferSize(new Vector2());
    const AA: readonly string[] = ['traa', 'taau', 'fsr1', 'smaa', 'fxaa'];
    reportDiagnostics(
      collectDiagnostics(
        engine.caps,
        quality,
        tierOverride === null ? 'detected' : 'override',
        engine.renderScale,
        {
          bufferWidth: Math.round(drawing.x),
          bufferHeight: Math.round(drawing.y),
          displayWidth: shell.canvas.clientWidth,
          displayHeight: shell.canvas.clientHeight,
          aaNodes: post.stages
            .filter((stage) => stage.built && AA.includes(stage.effect))
            .map((stage) => stage.effect),
        },
      ),
    );
  }

  if (import.meta.env.DEV) {
    console.info('[shatterpoint] tier', quality.graphics, 'post stages', post.stages);
  }

  // The scene pass owns its own resolution scale, so the engine's ladder has to be
  // forwarded rather than inferred - they would otherwise disagree the first time the
  // dynamic-resolution controller moves a rung.
  post.setRenderScale(engine.renderScale);
  engine.events.on('engine:resize', (info) => {
    camera.aspect = info.cssWidth / info.cssHeight;
    camera.updateProjectionMatrix();
    post.setRenderScale(info.renderScale);
  });

  // A lost device is not recoverable in place: the renderer, every buffer and every
  // pipeline are gone. Say so plainly instead of leaving a frozen last frame on screen.
  engine.events.on('engine:devicelost', (info) => {
    // Losing the device before the first frame means this machine's WebGPU stack cannot
    // run the chain at all - a driver, a software adapter, a headless browser. Retrying by
    // hand is not the player's job, so fall back to the WebGL backend once, automatically.
    // The flag makes it once: a second loss is a real fault and gets the honest message.
    const ALREADY_FELL_BACK = 'sp:webgl-fallback';
    // Not gated on __spReady: a device can survive a frame or two and then die, and the
    // player is equally stuck either way. A lost device is unrecoverable in place, so the
    // only useful move is to try the other backend once.
    const canFallBack =
      !forceWebGL && globalThis.sessionStorage.getItem(ALREADY_FELL_BACK) === null;

    if (canFallBack) {
      globalThis.sessionStorage.setItem(ALREADY_FELL_BACK, '1');
      const next = new URL(globalThis.location.href);
      next.searchParams.set('webgl', '1');
      globalThis.location.replace(next.toString());
      return;
    }

    fail(shell, 'The graphics device was lost. Reload to start again.', info);
  });

  // Backgrounding does not pause on its own - Loop only refuses to be billed for the gap.
  // Pausing is policy, and policy lives here.
  engine.events.on('engine:visibility', ({ hidden }) => {
    engine.setPaused(hidden);
  });

  // ---- 7. UI --------------------------------------------------------------------------
  // Motion first: it installs the stylesheet every entrance, exit and loop animates
  // against, and a widget constructed before it would animate with no curves defined.
  say(shell, 'Mounting the interface');
  installMotion(quality.motion);

  const overlay = new Overlay(shell.overlayHost, quality.motionRules);
  engine.subscribe(overlay, ORDER.ui);

  const hud = new Hud(overlay.layer('hud'), quality);
  overlay.add(hud);

  // The guard is retained rather than discarded: it OWNS the invisible padding it applied,
  // and disposing it is the only way to take those hit regions back off the DOM.
  const touchGuard = enforceTouchTargets(overlay.root);

  // Registered only now that `overlay` exists. A tier change re-dresses both DOM axes and
  // re-times every widget, so the handler needs the overlay in hand rather than closing
  // over a binding that is still in its temporal dead zone.
  engine.events.on('engine:quality', (next) => {
    root.dataset['preset'] = presetFor(next.graphics);
    if (next.reducedMotion) root.dataset['motion'] = 'reduced';
    else delete root.dataset['motion'];
    overlay.setMotion(next.motionRules);
  });


  // TODO(step-2): create the Run, wire input, and feed hud.submit() a HudSnapshot from the
  // fixed step. Until then the HUD is mounted, ticked and correctly laid out, and simply
  // has nothing to report.

  // ---- input ---------------------------------------------------------------------------
  // Pointer down rather than click: a throw must fire on press, not on release, or the
  // whole game feels like it is lagging behind the player.
  const throwFromEvent = (clientX: number, clientY: number): void => {
    const rect = shell.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    playfield.throwAt(ndcX, ndcY);
  };

  // A run that has ended must never be a dead end: the same tap that throws also retries.
  const retryIfOver = (): boolean => {
    if (!runOver) return false;
    runOver = false;
    playfield.restart();
    return true;
  };

  shell.canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    event.preventDefault();
    if (retryIfOver()) return;
    throwFromEvent(event.clientX, event.clientY);
  });

  // Keyboard throws at the reticle, which is where a gamepad or keyboard player is aiming.
  globalThis.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.code === 'KeyR' || event.code === 'Enter') {
      event.preventDefault();
      retryIfOver();
      return;
    }
    if (event.code !== 'Space') return;
    event.preventDefault();
    if (retryIfOver()) return;
    playfield.throwAt(0, 0);
  });

  // ---- HUD feed ------------------------------------------------------------------------
  const location: HudLocation = {
    universeName: theme.displayName,
    zoneName: 'Zone 1',
    roomName: 'Approach',
    roomIndex: 0,
    roomCount: ROOMS_PER_ZONE,
    seed: seedFrom(params),
  };

  engine.events.on('engine:frame', (stats) => {
    hud.submit({
      balls: ballsNow,
      location,
      earnings: { score: scoreNow, multiplier: multiplierNow, decay: 1 as Unit, streak: streakNow },
      pickups: [],
      target: runOver
        ? { state: 'idle', label: 'run over', rangeM: 0 }
        : { state: 'tracking', label: 'glass', rangeM: playfield.travelMetres },
      danger: runOver
        ? { level: 'critical', message: 'Out of balls - click, Space or R to retry' }
        : ballsNow <= LOW_BALL_WARNING
          ? { level: 'warn', message: 'Low on balls' }
          : { level: 'none', message: '' },
      telemetry: {
        fps: stats.fps,
        frameMs: stats.frameMs,
        uiMs: 0,
        drawCalls: engine.renderer.info.render.drawCalls,
        liveShards: playfield.liveShards,
        renderScale: engine.renderScale,
      },
    });
  });

  hud.setLegend([
    { keys: 'Click', action: 'throw' },
    { keys: 'Space', action: 'throw at reticle' },
  ]);

  engine.subscribe(new PostStage(post), ORDER.render);

  // ---- 8. Start -----------------------------------------------------------------------
  engine.start();
  shell.veil.dataset['state'] = 'done';
  // Removed rather than left at opacity 0: a full-screen element over the canvas keeps a
  // compositor layer alive for the rest of the session for nothing.
  globalThis.setTimeout(() => {
    shell.veil.remove();
  }, VEIL_REMOVE_MS);

  const app: App = { engine, physics, post, overlay, hud, scene, camera, playfield };

  // Signalled after a frame has actually been presented, not at the end of boot. Boot
  // finishing only proves construction succeeded; this proves the renderer produced an
  // image, which is the thing a test or a bug report actually wants to know.
  const stopReadyWatch = engine.events.on('engine:frame', () => {
    stopReadyWatch();
    window.__spReady = true;
  });

  globalThis.addEventListener('pagehide', () => {
    touchGuard.dispose();
    overlay.dispose();
    playfield.dispose();
    post.dispose();
    physics.dispose();
    engine.dispose();
  });

  return app;
}

declare global {
  interface Window {
    /** Console and e2e handle. Nothing inside src/ reads it; it is not an API. */
    __shatterpoint__?: App;
    /** Set once the first frame has been presented. Read by the e2e harness only. */
    __spReady?: boolean;
    /** Populated by ?selftest=1. Read by the e2e harness only. */
    __spSelfTest?: { rows: readonly SelfTestRow[]; pass: boolean };
  }
}

const shell = resolveShell();

boot(shell).then(
  (app) => {
    window.__shatterpoint__ = app;
  },
  (error: unknown) => {
    fail(shell, error instanceof BootFailure ? error.message : GENERIC_FAILURE, error);
  },
);
