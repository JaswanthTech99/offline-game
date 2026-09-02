/**
 * THE ENGINE.
 *
 * One renderer, one clock, one requestAnimationFrame, for the whole of SHATTERPOINT.
 *
 * WHY A SINGLE rAF, ENFORCED BY LINT
 * A second animation loop anywhere - a HUD tween, an audio meter, a debug graph - and the
 * frame stops being a frame: two callbacks per vsync means two independent clocks, the
 * physics accumulator sees a fraction of the real delta, and slow-motion drifts against
 * the visuals. Everything that needs per-frame time implements `Tickable` and subscribes.
 * The global is referenced through `globalThis` below so the ESLint ban that protects this
 * rule stays switched on in this file too - it is not an exemption, it is the one call.
 *
 * WHY ORDER MATTERS INSIDE THE FRAME
 *   1. re-arm rAF, before any game work, so a throw in one system costs a single frame
 *      instead of stopping the loop forever - and still reaches the console unswallowed.
 *   2. Loop.advance: N fixed steps, then every subscriber's interpolated `frame(alpha)`.
 *   3. render, once, after every system has posed itself for this alpha.
 *   4. emit `engine:frame`, so the profiler reads draw counts from the frame just drawn.
 *
 * r185 ASYNC RULE
 * `await renderer.init()` happens exactly once, in `Engine.create`. Every render and
 * compute call after that is synchronous; `renderAsync`/`computeAsync` are deprecated and
 * are never called. `create()` resolving IS the ready signal - there is no ready event to
 * miss, because nothing can subscribe before the promise settles.
 *
 * WHAT THE ENGINE DOES NOT OWN
 * No scene, no camera, no post chain. The world layer hands it a `RenderSource` and the
 * render layer hands it an output node; until then it draws nothing rather than inventing
 * a placeholder that another agent would have to delete.
 */

import { PCFShadowMap, RenderPipeline, WebGPURenderer } from 'three/webgpu';
import type { Camera, Node, Scene } from 'three/webgpu';

import type { EngineCaps } from './Caps';
import { installWebGPUCompat } from './WebGPUCompat';
import type { CompatReport } from './WebGPUCompat';
import { observeDevicePixelRatio, observeReducedMotion, probeCaps, refineCaps } from './Caps';
import { Emitter } from './Events';
import type { Unsubscribe } from './Events';
import { Loop } from './Loop';
import type { LoopStats } from './Loop';
import type { GovernorState, QualityResolution, Tier } from './Quality';
import {
  FIXED_STEP_MS,
  GOVERNOR_FLOOR_TIER,
  deriveRenderScale,
  deviceClassCeiling,
  governorStep,
  higherTier,
  newGovernorState,
  resolveTier,
  rungNeighbour,
  snapRenderScale,
} from './Quality';
import type { Frames, Tickable } from './types';

/** What the engine needs in order to draw at all. Supplied by the world layer. */
export interface RenderSource {
  readonly scene: Scene;
  readonly camera: Camera;
}

export interface EngineOptions {
  readonly canvas: HTMLCanvasElement;
  /** Forces the GRAPHICS axis for the debug menu and for e2e determinism. */
  readonly tierOverride?: Tier | null;
  /** Boots the WebGL fallback deliberately, to exercise the no-compute path on a real GPU. */
  readonly forceWebGL?: boolean;
  /** ?scale= override. Bypasses derivation entirely; still snapped to a ladder rung. */
  readonly scaleOverride?: number | undefined;
}

export interface ResizeInfo {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly pixelRatio: number;
  readonly renderScale: number;
  readonly drawingWidth: number;
  readonly drawingHeight: number;
}

export interface DeviceLostInfo {
  readonly api: string;
  readonly message: string;
  readonly reason: string | null;
}

export interface EngineEventMap {
  /** Fired every frame with the loop's REUSED stats object. Read it, never retain it. */
  'engine:frame': LoopStats;
  'engine:resize': ResizeInfo;
  /** The resolved tier changed - by override, or because the motion preference moved. */
  'engine:quality': QualityResolution;
  'engine:visibility': { readonly hidden: boolean };
  'engine:pause': { readonly paused: boolean };
  'engine:devicelost': DeviceLostInfo;
}

/** Smallest sane backing store. A zero-sized swap chain is a device error, not a small one. */
const MIN_SURFACE_PX = 1;

export class Engine {
  readonly renderer: WebGPURenderer;
  readonly events = new Emitter<EngineEventMap>();
  readonly loop: Loop;

  private readonly canvas: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly stopDprWatch: Unsubscribe;
  private readonly stopMotionWatch: Unsubscribe;

  private capsValue: EngineCaps;
  private qualityValue: QualityResolution;
  /** What the PLAYER, the URL or the boot probe asked for. The governor never writes here. */
  private tierOverride: Tier | null;
  /** What the GOVERNOR currently holds. Null means "whatever the override/detection says". */
  private governorTier: Tier | null = null;
  /** The highest tier the governor may climb to. Never raised by the governor itself. */
  private governorCeilingTier: Tier;
  private governorState: GovernorState;
  /**
   * A BOOT-TIME override pins both axes: `?tier=`, or the packaged build's `sp-tier` meta
   * tag, is a promise about what will actually be drawn, and every e2e project is named
   * after the tier it captures at. A governor that quietly walks a "DESKTOP_HIGH@1x" run
   * down to MOBILE_LOW halfway through a capture makes that project name a lie and every
   * pixel gate irreproducible. A device that was never pinned - which is every real player,
   * because a phone has no address bar - gets the full two-axis governor. Calling
   * `setTierOverride` at runtime unpins: that is a live decision, not a boot promise.
   */
  private governorPinned: boolean;

  /** What the browser needed patching for. Surfaced so a bug report can include it. */
  compat: CompatReport | null = null;

  private pipeline: RenderPipeline | null = null;
  private source: RenderSource | null = null;

  private rafHandle: number | null = null;
  private renderScaleValue: number;
  private lastClampReport = 0;
  private disposed = false;

  /** Guards against re-emitting an identical resize on every ResizeObserver notification. */
  private lastResize: ResizeInfo | null = null;

  /**
   * The one place `renderer.init()` is awaited. Probing happens before the renderer is
   * constructed because the probe's answer is what the tier - and therefore the whole
   * budget the renderer is configured against - is derived from.
   */
  static async create(options: EngineOptions): Promise<Engine> {
    // Shims first: they rewrite calls three is about to make, so patching after the
    // renderer exists is already too late.
    const compat = await installWebGPUCompat();

    const probed = await probeCaps(options.canvas);

    const renderer = new WebGPURenderer({
      canvas: options.canvas,
      // MSAA is off on purpose: the post chain owns anti-aliasing, and paying for both
      // means paying twice for the same glass edge.
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      forceWebGL: options.forceWebGL ?? false,
    });

    await renderer.init();

    const engine = new Engine(options, renderer, refineCaps(probed, renderer));
    engine.compat = compat;
    return engine;
  }

  private constructor(options: EngineOptions, renderer: WebGPURenderer, caps: EngineCaps) {
    this.canvas = options.canvas;
    this.renderer = renderer;
    this.capsValue = caps;
    this.tierOverride = options.tierOverride ?? null;
    this.qualityValue = resolveTier(caps, this.tierOverride);
    // Derived from the display, not from the tier name. The override wins when present.
    const budget0 = this.qualityValue.budget;
    this.renderScaleValue =
      options.scaleOverride !== undefined && options.scaleOverride > 0
        ? snapRenderScale(options.scaleOverride, budget0.renderScaleMin, budget0.renderScaleMax)
        : deriveRenderScale(
            budget0,
            options.canvas.clientWidth || globalThis.innerWidth,
            options.canvas.clientHeight || globalThis.innerHeight,
            globalThis.devicePixelRatio,
          );

    this.governorCeilingTier = this.ceilingFor(this.tierOverride);
    this.governorState = newGovernorState(this.qualityValue.graphics, this.renderScaleValue);
    this.governorPinned = this.tierOverride !== null;

    // PCF is the WebGPU-safe filter in r185; PCFSoft is not reliably supported on the
    // backend and silently degrades rather than failing loudly.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;

    this.loop = new Loop({
      fixedStepMs: FIXED_STEP_MS,
      maxCatchUpSteps: this.qualityValue.budget.physicsSubstepCap,
    });

    renderer.onDeviceLost = (info): void => {
      // Overriding this suppresses three's default throw, which would otherwise fire from
      // inside the GPU process callback where nothing can catch it.
      this.stop();
      this.events.emit('engine:devicelost', {
        api: info.api,
        message: info.message,
        reason: info.reason,
      });
    };

    this.resizeObserver =
      typeof globalThis.ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            this.applySize();
          })
        : null;
    this.resizeObserver?.observe(this.canvas);

    this.stopDprWatch = observeDevicePixelRatio(() => {
      this.applySize();
    });
    this.stopMotionWatch = observeReducedMotion((reduced) => {
      this.onReducedMotionChange(reduced);
    });

    globalThis.addEventListener('resize', this.onWindowResize);
    globalThis.document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.applySize();
  }

  get caps(): EngineCaps {
    return this.capsValue;
  }

  get quality(): QualityResolution {
    return this.qualityValue;
  }

  get renderScale(): number {
    return this.renderScaleValue;
  }

  get running(): boolean {
    return this.rafHandle !== null;
  }

  /** The governor's whole mind, for the HUD, a bug report, or the governor gate. */
  get governor(): GovernorState {
    return this.governorState;
  }

  /** The highest tier the governor may promote to. See the constructor for who sets it. */
  get governorCeiling(): Tier {
    return this.governorCeilingTier;
  }

  /** False while a boot-time tier override pins both quality axes. See `governorPinned`. */
  get governorActive(): boolean {
    return !this.governorPinned;
  }

  /**
   * The highest tier the governor is ever allowed to reach, given what was last asked of it.
   *
   * The device class is a FLOOR on this ceiling, not a cap on it. main.ts's boot probe is
   * already bounded by its own `ceilingFor`, so a verdict that came back BELOW the class
   * ceiling is a measurement of a phone at that moment - very often a phone still warm from
   * decompressing the APK - and not a permanent verdict about the hardware. Treating it as
   * a cap would mean one unlucky second at boot locks a flagship out of its own tier for
   * the rest of the session. Anything asked for ABOVE the class ceiling is taken at face
   * value, because only a human or a URL can ask for that and both outrank a heuristic.
   */
  private ceilingFor(tier: Tier | null): Tier {
    const deviceClass = deviceClassCeiling(this.capsValue);
    return tier === null ? deviceClass : higherTier(tier, deviceClass);
  }

  /**
   * Joins the frame. Lower `order` ticks first; physics belongs at the front, and anything
   * that reads a transform physics produced belongs behind it.
   */
  subscribe(tickable: Tickable, order = 0): Unsubscribe {
    return this.loop.add(tickable, order);
  }

  /** The world layer's scene and camera. Used only when no post output node is set. */
  setRenderSource(source: RenderSource | null): void {
    this.source = source;
  }

  /**
   * Installs the post chain's final node. Passing null tears the pipeline down and reverts
   * to the direct scene render, which is what the no-post fallback path uses.
   */
  setOutputNode(node: Node | null): void {
    if (node === null) {
      this.pipeline?.dispose();
      this.pipeline = null;
      return;
    }
    if (this.pipeline === null) {
      this.pipeline = new RenderPipeline(this.renderer, node);
      return;
    }
    this.pipeline.outputNode = node;
    this.pipeline.needsUpdate = true;
  }

  start(): void {
    if (this.disposed || this.rafHandle !== null) return;
    // Nothing should be charged for the time between construction and the first frame.
    this.loop.resetClock();
    this.rafHandle = globalThis.requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.rafHandle === null) return;
    globalThis.cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  setPaused(paused: boolean): void {
    if (paused === this.loop.isPaused) return;
    this.loop.setPaused(paused);
    this.events.emit('engine:pause', { paused });
  }

  /** Slow motion, in physics frames skipped per frame run. See Loop for why it is a count. */
  setSlowMo(framesToSkip: Frames): void {
    this.loop.setSlowMo(framesToSkip);
  }

  /**
   * Forces the graphics axis, or returns to detection with null. Motion is untouched on
   * purpose: an override is a preference and may not overrule an accessibility setting.
   */
  setTierOverride(tier: Tier | null): void {
    if (tier === this.tierOverride && this.governorTier === null) return;
    this.tierOverride = tier;
    // Somebody has overruled the governor. Its accumulated demotion count was evidence about
    // a tier that is no longer the tier we are on, so it is discarded rather than carried.
    this.governorTier = null;
    this.applyQuality(resolveTier(this.capsValue, tier), true);
    this.governorCeilingTier = this.ceilingFor(tier);
    this.governorState = newGovernorState(this.qualityValue.graphics, this.renderScaleValue);
    // A runtime choice is not a boot promise: the governor resumes from here.
    this.governorPinned = false;
  }

  /**
   * Snaps to the nearest rung of the ladder inside the tier's own window. Returns whether
   * the scale actually moved, so a dynamic-resolution controller knows it has hit the end
   * of the ladder and should stop asking.
   */
  setRenderScale(scale: number): boolean {
    const budget = this.qualityValue.budget;
    const snapped = snapRenderScale(scale, budget.renderScaleMin, budget.renderScaleMax);
    if (snapped === this.renderScaleValue) return false;
    this.renderScaleValue = snapped;
    this.applySize();
    return true;
  }

  /** One rung coarser (negative) or finer (positive). The controller's only mutator. */
  stepRenderScale(direction: number): boolean {
    if (direction === 0) return false;
    const budget = this.qualityValue.budget;
    const rung = rungNeighbour(
      this.renderScaleValue,
      direction > 0 ? 1 : -1,
      budget.renderScaleMin,
      budget.renderScaleMax,
    );
    if (rung === null) return false;
    return this.setRenderScale(rung);
  }

  /** Recomputes the backing store from the canvas's current CSS box. Idempotent. */
  resize(): void {
    this.applySize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();

    this.resizeObserver?.disconnect();
    this.stopDprWatch();
    this.stopMotionWatch();
    globalThis.removeEventListener('resize', this.onWindowResize);
    globalThis.document.removeEventListener('visibilitychange', this.onVisibilityChange);

    this.pipeline?.dispose();
    this.pipeline = null;
    this.source = null;

    this.loop.dispose();
    this.renderer.dispose();
    this.events.clear();
  }

  private readonly tick = (nowMs: number): void => {
    // Re-arm before any work: a throw below then costs one frame, not the whole session.
    this.rafHandle = globalThis.requestAnimationFrame(this.tick);

    const stats = this.loop.advance(nowMs);
    this.renderFrame();
    // SMOOTHED, not raw: a single 200ms hitch - a GC, a texture upload, the OS taking the
    // frame back - is not evidence about a tier, and Loop already publishes the EMA that
    // says so. The governor's counters supply the sustain; this supplies the stability.
    this.governResolution(stats.smoothedFrameMs);
    this.events.emit('engine:frame', stats);
  };

  /** Presents one frame on demand. Used by the automation bridge while the loop is paused. */
  renderOnce(): void {
    this.renderFrame();
  }

  /**
   * TWO-AXIS DYNAMIC QUALITY. Render scale is DERIVED from a pixel budget, which is a
   * statement about what the tier would LIKE to afford - not about what this machine can
   * deliver. Without a feedback loop a weak host renders at 2x supersampling and stutters,
   * which is exactly what shipping the derivation alone produced.
   *
   * One axis was not enough. A OnePlus 12 on MOBILE_ULTRA rode the scale ladder down to
   * that tier's 0.8 floor, ran out of rungs, and then held a 33ms frame against a 16.6ms
   * budget for the rest of the session with no move left to make - because the cost was
   * never resolution, it was rings, post stages, lights and shards, all of which are TIER
   * rows. So the coarse axis demotes the tier itself once the fine axis is spent.
   *
   * The POLICY lives in Quality.ts as a pure reducer; this method is only the actuator, and
   * it hands the reducer back the state it actually achieved rather than the one it asked
   * for - `snapRenderScale` and the tier tables have the last word on both axes.
   */
  private governResolution(frameMs: number): void {
    if (this.governorPinned) return;

    const step = governorStep(this.governorState, frameMs, {
      ceiling: this.governorCeilingTier,
      floor: GOVERNOR_FLOOR_TIER,
    });

    const action = step.action;
    if (action.kind === 'scale') {
      if (this.setRenderScale(action.to)) this.events.emit('engine:quality', this.qualityValue);
    } else if (action.kind === 'tier') {
      this.governorTier = action.to;
      // resetScale: the new tier's default, not the scale we were losing at. applyQuality
      // emits engine:quality and re-sizes, so nothing else is needed here.
      this.applyQuality(resolveTier(this.capsValue, action.to), true);
      console.info(
        `[shatterpoint] governor ${action.direction < 0 ? 'demoted' : 'promoted'}: ` +
          `${action.to} at scale ` +
          `${this.renderScaleValue.toFixed(2)} (frame ${frameMs.toFixed(1)}ms, ` +
          `${step.state.demotions} demotion(s) this session)`,
      );
    }

    this.governorState = {
      ...step.state,
      tier: this.qualityValue.graphics,
      renderScale: this.renderScaleValue,
    };
  }

  /**
   * TEST SEAM. Feeds synthetic frame times straight into the governor, bypassing the clock
   * and the renderer entirely.
   *
   * It exists because the alternative is a gate that waits for a real device to get hot,
   * which is neither deterministic nor runnable in CI. Call `stop()` first: rAF keeps
   * feeding the governor real frame times otherwise, and the two would interleave. Shipped
   * rather than dev-gated because a bug report from a real phone wants the same lever.
   */
  feedGovernorFrames(frameMs: number, count: number): void {
    for (let i = 0; i < count; i += 1) this.governResolution(frameMs);
  }

  private renderFrame(): void {
    if (this.pipeline !== null) {
      this.pipeline.render();
      return;
    }
    const source = this.source;
    if (source !== null) this.renderer.render(source.scene, source.camera);
  }

  private readonly onWindowResize = (): void => {
    this.applySize();
  };

  private readonly onVisibilityChange = (): void => {
    const hidden = globalThis.document.visibilityState === 'hidden';
    // Pausing is the game layer's decision, not the engine's - a background tab may still
    // want to finish a load. All the clock does is refuse to be billed for the gap.
    if (!hidden) this.loop.resetClock();
    this.events.emit('engine:visibility', { hidden });
  };

  private onReducedMotionChange(reduced: boolean): void {
    if (reduced === this.capsValue.prefersReducedMotion) return;
    this.capsValue = { ...this.capsValue, prefersReducedMotion: reduced };
    // The governor's tier outranks the override here: it was chosen from measured frames,
    // and a motion-preference change is not evidence that the device got faster.
    this.applyQuality(resolveTier(this.capsValue, this.governorTier ?? this.tierOverride), false);
  }

  /**
   * `resetScale` is true only when the GRAPHICS tier changed: a motion-preference change
   * must not throw away a render scale the dynamic controller has settled on.
   */
  private applyQuality(next: QualityResolution, resetScale: boolean): void {
    this.qualityValue = next;
    this.loop.setMaxCatchUpSteps(next.budget.physicsSubstepCap);

    const budget = next.budget;
    const wanted = resetScale ? budget.renderScale : this.renderScaleValue;
    this.renderScaleValue = snapRenderScale(wanted, budget.renderScaleMin, budget.renderScaleMax);

    this.events.emit('engine:quality', next);
    this.applySize();
  }

  private applySize(): void {
    if (this.disposed) return;

    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(MIN_SURFACE_PX, Math.round(rect.width || globalThis.innerWidth));
    const cssHeight = Math.max(MIN_SURFACE_PX, Math.round(rect.height || globalThis.innerHeight));

    // A hardware ceiling, not a budget: the swap chain cannot exceed the adapter's 2D
    // texture limit, and asking for more is a device error rather than a slow frame. If a
    // tier ever wants a dpr cap of its own, that number belongs in Quality.ts.
    const maxTexture = this.capsValue.maxTextureSize;
    const hardwareCeiling = Math.min(maxTexture / cssWidth, maxTexture / cssHeight);
    /**
     * SPLIT OWNERSHIP OF RENDER SCALE. The Engine applies only the SUPERSAMPLING part -
     * anything at or above 1.0 - because that has to exist in the drawing buffer itself.
     * PostChain applies only the sub-1.0 part, on the scene pass, where an upscaler can
     * reconstruct it.
     *
     * Both used to apply the whole factor, so the scene rendered at renderScale SQUARED:
     * at the 0.6 rung a 1920x1080 output was drawn at 691x389, thirteen percent of native.
     * That single line is most of why this build looked soft.
     */
    const supersample = Math.max(1, this.renderScaleValue);
    const requested = globalThis.devicePixelRatio * supersample;
    const pixelRatio = Math.min(requested, hardwareCeiling);

    // A clamp here silently discards a rung the ladder just granted. Say so, once per change.
    if (requested > hardwareCeiling + 1e-3 && this.lastClampReport !== requested) {
      this.lastClampReport = requested;
      console.warn(
        `[shatterpoint] render scale clamped by hardware: requested pixel ratio ` +
          `${requested.toFixed(3)} exceeds ceiling ${hardwareCeiling.toFixed(3)} ` +
          `(maxTextureSize ${maxTexture}). Supersampling above this is being discarded.`,
      );
    }

    const info: ResizeInfo = {
      cssWidth,
      cssHeight,
      pixelRatio,
      renderScale: this.renderScaleValue,
      drawingWidth: Math.floor(cssWidth * pixelRatio),
      drawingHeight: Math.floor(cssHeight * pixelRatio),
    };

    /**
     * `renderScale` is part of the comparison, and leaving it out was a real bug.
     *
     * Because of the split ownership above, a scale change at or below 1.0 moves NOTHING
     * the Engine itself sizes - the pixel ratio stays exactly 1 and the CSS box never
     * moves - so a guard that compared only those three fields swallowed the event. The
     * post chain learns the sub-1.0 factor from `engine:resize` and from nowhere else, so
     * every drop the governor made from 1.0 downwards was applied to a number in this
     * class and to nothing on the GPU. The frame never got cheaper, which is why the phone
     * kept posting 33ms while the ladder walked all the way to its floor.
     */
    const previous = this.lastResize;
    if (
      previous !== null &&
      previous.cssWidth === info.cssWidth &&
      previous.cssHeight === info.cssHeight &&
      previous.pixelRatio === info.pixelRatio &&
      previous.renderScale === info.renderScale
    ) {
      return;
    }
    this.lastResize = info;

    // Pixel ratio first: setSize multiplies by whatever ratio is current when it runs.
    this.renderer.setPixelRatio(pixelRatio);
    // updateStyle is false because the canvas's CSS box is owned by the DOM overlay's
    // stylesheet; letting three write inline styles would fight it every resize.
    this.renderer.setSize(cssWidth, cssHeight, false);

    // Surface size feeds detectTier, so it has to stay current for a later re-resolve.
    this.capsValue = { ...this.capsValue, surfacePixels: cssWidth * cssHeight, devicePixelRatio: globalThis.devicePixelRatio };

    this.events.emit('engine:resize', info);
  }
}
