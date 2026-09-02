/**
 * THE SINGLE SOURCE OF TRUTH FOR EVERY NUMBER.
 *
 * No other file in SHATTERPOINT may contain a budget literal. If you are about to type a
 * count, a resolution, a cap, a millisecond allowance or an effect strength anywhere else,
 * add it here and import it. The reason is not tidiness: quality tiers are the only lever
 * that keeps a 4K desktop and a three-year-old phone running the same code, and a literal
 * hidden in a corridor generator is a tier that silently does not exist.
 *
 * TWO INDEPENDENT AXES, MODELLED SEPARATELY:
 *
 *   GRAPHICS (`Tier`)  - what the hardware can afford to draw. Detected from device caps.
 *   MOTION   (`MotionRules`) - how much movement the PLAYER is willing to be subjected to.
 *                              Driven by prefers-reduced-motion, never by the GPU.
 *
 * They are not the same question and must never be collapsed into one number. An ULTRA_4K
 * machine whose owner has set prefers-reduced-motion gets ULTRA_4K pixels and MOBILE_LOW
 * motion: full resolution, full post, but no camera shake, no fov kick, no motion blur.
 * `resolveTier()` is the only place that combination is decided.
 */

import type { ParallaxTier } from '../battle/types';
import type { Frames, Millis } from './types';

/**
 * SHOWCASE sits ABOVE the budgeted tiers and is exempt from msBudget by design. It is for
 * stills and for machines with a real GPU: maximum render scale, every stage that builds,
 * full density, every detail layer. 10 fps there is acceptable.
 *
 * The four tiers below it are unchanged and remain smooth. No single setting is both - a
 * host with no GPU cannot be premium and fluid at once, and pretending otherwise is how
 * this project shipped a 2x supersample to a machine that could not draw it.
 */
export type Tier = 'SHOWCASE' | 'ULTRA_4K' | 'DESKTOP_HIGH' | 'MOBILE_HIGH' | 'MOBILE_LOW';

export const TIERS: readonly Tier[] = Object.freeze([
  'SHOWCASE',
  'ULTRA_4K',
  'DESKTOP_HIGH',
  'MOBILE_HIGH',
  'MOBILE_LOW',
]);

/**
 * Rungs the dynamic-resolution controller may step between. Never leaves 0.6-1.0: below 0.6
 * the upscaler cannot reconstruct glass edges and the game's one hero material falls apart.
 */
/**
 * Rungs above 1.0 are SUPERSAMPLING, not upscaling: the frame is rendered larger than the
 * display and downsampled, which is the only anti-aliasing that works on every edge in the
 * scene rather than only the ones a post pass can find. Without these rungs the renderer
 * had no way to spend surplus GPU on image quality at all.
 */
export const RENDER_SCALE_LADDER: readonly number[] = Object.freeze([
  0.6, 0.67, 0.75, 0.8, 0.9, 1.0, 1.25, 1.5, 2.0,
]);

/** The simulation rate. Fixed, forever, on every tier - only presentation rate varies. */
export const FIXED_STEP_HZ = 60;
export const FIXED_STEP_MS: Millis = 1000 / FIXED_STEP_HZ;

/**
 * Headroom every tier must leave unclaimed by real work. Nothing in this codebase schedules
 * major GC, the compositor, input plumbing or the frame the OS simply takes back, so a table
 * that sums to exactly `frame` misses frames while every subsystem reports itself in budget.
 * tools/budget.mjs parses this constant out of this file rather than carrying its own copy.
 */
export const MIN_FRAME_SLACK_MS: Millis = 2.0;

export interface PostToggles {
  readonly gtao: boolean;
  readonly ssr: boolean;
  readonly ssgi: boolean;
  readonly godrays: boolean;
  readonly bloom: boolean;
  readonly dof: boolean;
  readonly motionBlur: boolean;
  readonly traa: boolean;
  readonly taau: boolean;
  readonly fsr1: boolean;
  readonly smaa: boolean;
  readonly fxaa: boolean;
  readonly chromaticAberration: boolean;
  readonly film: boolean;
  readonly vignette: boolean;
  readonly lut: boolean;
  readonly sharpen: boolean;
}

export type PostEffect = keyof PostToggles;

export const POST_EFFECTS: readonly PostEffect[] = Object.freeze([
  'gtao',
  'ssr',
  'ssgi',
  'godrays',
  'bloom',
  'dof',
  'motionBlur',
  'traa',
  'taau',
  'fsr1',
  'smaa',
  'fxaa',
  'chromaticAberration',
  'film',
  'vignette',
  'lut',
  'sharpen',
]);

export interface PostIntensity {
  readonly bloomStrength: number;
  readonly bloomRadius: number;
  readonly bloomThreshold: number;
  readonly gtaoRadius: number;
  readonly gtaoIntensity: number;
  readonly gtaoScale: number;
  readonly ssrMaxDistance: number;
  readonly ssrThickness: number;
  readonly ssrScale: number;
  readonly ssgiIntensity: number;
  readonly ssgiScale: number;
  readonly godraysDensity: number;
  readonly godraysWeight: number;
  readonly godraysExposure: number;
  readonly godraysSamples: number;
  readonly dofFocusRange: number;
  readonly dofBokehScale: number;
  readonly motionBlurSamples: number;
  readonly motionBlurIntensity: number;
  readonly chromaticAberrationStrength: number;
  readonly filmIntensity: number;
  readonly vignetteStrength: number;
  readonly vignetteRadius: number;
  readonly lutIntensity: number;
  readonly sharpenStrength: number;
  readonly fsr1Sharpness: number;
  /** How much of the previous frame TRAA/TAAU keep. Higher is smoother and more ghosty. */
  readonly temporalFeedback: number;
}

/**
 * Per-frame time allowance, milliseconds. These are contracts the profiler asserts against,
 * not estimates: overrunning `shatter` steals from `render` and drops the frame that the
 * player is watching a pane of glass explode in, which is the worst possible frame to drop.
 */
export interface MsBudget {
  /** 1000 / targetFps. Everything below must sum to at most this. */
  readonly frame: number;
  readonly physics: number;
  readonly shatter: number;
  readonly culling: number;
  readonly corridor: number;
  readonly battle: number;
  readonly render: number;
  readonly post: number;
  readonly audio: number;
  readonly ui: number;
  /** Deliberate headroom for GC, browser work and the frame the OS steals back. */
  readonly spare: number;
}

/** Objects allocated up front. Pooling only helps if the pool is full before frame one. */
export interface PrewarmCounts {
  readonly shards: number;
  readonly motes: number;
  readonly particles: number;
  readonly balls: number;
  readonly decals: number;
}

export interface QualityBudget {
  readonly tier: Tier;
  readonly targetFps: number;
  /**
   * Fallback rung, used only when the display size is not yet known. The real scale comes
   * from `deriveRenderScale`, because a tier name says how much GPU is available, not how
   * many pixels the display has - and those are independent facts. ULTRA_4K on a 1080p
   * monitor should SUPERSAMPLE, not upscale from 0.67.
   */
  readonly renderScale: number;
  /**
   * How many internal pixels this tier can afford per frame. This, not the tier name, is
   * what decides render scale once the display is measured.
   */
  readonly pixelBudget: number;
  readonly renderScaleMin: number;
  readonly renderScaleMax: number;
  readonly maxShardsLive: number;
  /** Additive dust sprites per break. Lower tiers cut COUNT, never alpha or sharpness. */
  readonly dustSprites: number;
  readonly shardLifetimeMs: Millis;
  readonly moteBudget: number;
  readonly particleBudget: number;
  readonly prewarm: PrewarmCounts;
  readonly shadowCascades: number;
  readonly shadowMapSize: number;
  readonly shadowDistance: number;
  readonly maxDynamicLights: number;
  readonly post: PostToggles;
  readonly postIntensity: PostIntensity;
  /** Hard ceiling on physics substeps per frame; past this the sim sheds load, never dt. */
  readonly physicsSubstepCap: number;
  readonly drawCallCeiling: number;
  readonly textureAnisotropy: number;
  readonly corridorRings: number;
  readonly battleInstanceCaps: Readonly<Record<ParallaxTier, number>>;
  readonly msBudget: MsBudget;
}

/**
 * The motion axis. Every one of these is a multiplier or a switch on MOVEMENT, never on
 * image quality - that is what keeps the two axes genuinely independent.
 */
export interface MotionRules {
  readonly cameraShakeScale: number;
  readonly cameraRollScale: number;
  readonly fovKickScale: number;
  readonly parallaxScale: number;
  readonly moteDriftScale: number;
  readonly hudPulseScale: number;
  readonly battleAnimationScale: number;
  /** Slow-motion is a frames-to-SKIP counter. Never a scaled timestep. */
  readonly slowMoFrameSkip: Frames;
  readonly uiTransitionMs: Millis;
  readonly allowMotionBlur: boolean;
  readonly allowScreenFlash: boolean;
  readonly allowChromaticPulse: boolean;
}

const QUALITY_TABLE: Readonly<Record<Tier, QualityBudget>> = {
  /**
   * SHOWCASE. Exempt from msBudget on purpose - targetFps 10 is a statement of intent, not
   * a target to hit. Maximum render scale, every stage that builds, full density. It exists
   * so a still, or a machine with a real GPU, is not held back by a budget written for a
   * phone. The four tiers below it are untouched.
   */
  SHOWCASE: {
    tier: 'SHOWCASE',
    targetFps: 10,
    // 4K native is a trap: it spends the entire frame on pixels nobody can resolve while
    // starving the shatter sim. Render at 0.67 and let TAAU reconstruct, then sharpen.
    renderScale: 2.0,
    // ~4K worth of pixels. On a 1080p panel that lands at 2.0x supersampling.
    pixelBudget: 7680 * 4320,
    renderScaleMin: 1.0,
    renderScaleMax: 2.0,
    maxShardsLive: 4000,
    dustSprites: 64,
    shardLifetimeMs: 6000,
    moteBudget: 6000,
    particleBudget: 12000,
    prewarm: { shards: 4000, motes: 6000, particles: 12000, balls: 32, decals: 256 },
    shadowCascades: 4,
    shadowMapSize: 2048,
    shadowDistance: 120,
    maxDynamicLights: 12,
    post: {
      gtao: true,
      ssr: true,
      ssgi: true,
      godrays: true,
      bloom: true,
      dof: true,
      motionBlur: true,
      traa: true,
      taau: true,
      fsr1: false,
      smaa: true,
      fxaa: false,
      chromaticAberration: true,
      film: true,
      vignette: true,
      lut: true,
      sharpen: true,
    },
    postIntensity: {
      bloomStrength: 0.62,
      bloomRadius: 0.72,
      bloomThreshold: 0.82,
      gtaoRadius: 0.55,
      gtaoIntensity: 1.0,
      gtaoScale: 1.0,
      ssrMaxDistance: 40,
      ssrThickness: 0.06,
      ssrScale: 0.75,
      ssgiIntensity: 0.85,
      ssgiScale: 0.5,
      godraysDensity: 0.92,
      godraysWeight: 0.42,
      godraysExposure: 0.34,
      godraysSamples: 96,
      dofFocusRange: 26,
      dofBokehScale: 2.2,
      motionBlurSamples: 16,
      motionBlurIntensity: 0.55,
      chromaticAberrationStrength: 0.35,
      filmIntensity: 0.16,
      vignetteStrength: 0.95,
      vignetteRadius: 0.42,
      lutIntensity: 1.0,
      sharpenStrength: 0.42,
      fsr1Sharpness: 0.5,
      temporalFeedback: 0.92,
    },
    physicsSubstepCap: 8,
    drawCallCeiling: 4000,
    textureAnisotropy: 16,
    corridorRings: 20,
    battleInstanceCaps: { horizon: 96, mid: 48, fore: 12 },
    msBudget: {
      frame: 100.0,
      physics: 11.4,
      shatter: 12.6,
      culling: 4.2,
      corridor: 10.8,
      battle: 5.4,
      render: 26.4,
      post: 13.2,
      audio: 1.8,
      ui: 1.8,
      spare: 2.0,
    },
  },

  ULTRA_4K: {
    tier: 'ULTRA_4K',
    targetFps: 60,
    // 4K native is a trap: it spends the entire frame on pixels nobody can resolve while
    // starving the shatter sim. Render at 0.67 and let TAAU reconstruct, then sharpen.
    renderScale: 1.0,
    // ~4K worth of pixels. On a 1080p panel that lands at 2.0x supersampling.
    pixelBudget: 3840 * 2160,
    renderScaleMin: 0.6,
    renderScaleMax: 2.0,
    maxShardsLive: 2400,
    dustSprites: 40,
    shardLifetimeMs: 6000,
    moteBudget: 6000,
    particleBudget: 12000,
    prewarm: { shards: 2400, motes: 6000, particles: 12000, balls: 32, decals: 256 },
    shadowCascades: 4,
    shadowMapSize: 2048,
    shadowDistance: 120,
    maxDynamicLights: 12,
    post: {
      gtao: true,
      ssr: true,
      ssgi: true,
      godrays: true,
      bloom: true,
      dof: true,
      motionBlur: true,
      traa: false,
      taau: true,
      fsr1: false,
      smaa: true,
      fxaa: false,
      chromaticAberration: true,
      film: true,
      vignette: true,
      lut: true,
      sharpen: true,
    },
    postIntensity: {
      bloomStrength: 0.62,
      bloomRadius: 0.72,
      bloomThreshold: 0.82,
      gtaoRadius: 0.55,
      gtaoIntensity: 1.0,
      gtaoScale: 1.0,
      ssrMaxDistance: 40,
      ssrThickness: 0.06,
      ssrScale: 0.75,
      ssgiIntensity: 0.85,
      ssgiScale: 0.5,
      godraysDensity: 0.92,
      godraysWeight: 0.42,
      godraysExposure: 0.34,
      godraysSamples: 96,
      dofFocusRange: 26,
      dofBokehScale: 2.2,
      motionBlurSamples: 16,
      motionBlurIntensity: 0.55,
      chromaticAberrationStrength: 0.35,
      filmIntensity: 0.16,
      vignetteStrength: 0.95,
      vignetteRadius: 0.42,
      lutIntensity: 1.0,
      sharpenStrength: 0.42,
      fsr1Sharpness: 0.5,
      temporalFeedback: 0.92,
    },
    physicsSubstepCap: 4,
    drawCallCeiling: 900,
    textureAnisotropy: 16,
    corridorRings: 26,
    battleInstanceCaps: { horizon: 96, mid: 48, fore: 12 },
    msBudget: {
      frame: 16.6,
      physics: 1.9,
      shatter: 2.1,
      culling: 0.7,
      corridor: 1.8,
      battle: 0.9,
      render: 4.4,
      post: 2.2,
      audio: 0.3,
      ui: 0.3,
      spare: 2.0,
    },
  },

  DESKTOP_HIGH: {
    tier: 'DESKTOP_HIGH',
    targetFps: 60,
    renderScale: 1.0,
    pixelBudget: 2560 * 1440,
    renderScaleMin: 0.6,
    renderScaleMax: 2.0,
    maxShardsLive: 1600,
    dustSprites: 30,
    shardLifetimeMs: 5000,
    moteBudget: 4000,
    particleBudget: 8000,
    prewarm: { shards: 1600, motes: 4000, particles: 8000, balls: 32, decals: 192 },
    shadowCascades: 3,
    shadowMapSize: 2048,
    shadowDistance: 100,
    maxDynamicLights: 8,
    post: {
      gtao: true,
      ssr: true,
      ssgi: false,
      godrays: true,
      bloom: true,
      dof: true,
      motionBlur: true,
      // Rendering at native scale, so temporal AA rather than temporal upsampling.
      traa: true,
      taau: false,
      fsr1: false,
      smaa: true,
      fxaa: false,
      chromaticAberration: true,
      film: true,
      vignette: true,
      lut: true,
      // TRAA resolves soft by construction; without this the top budgeted tier looks
      // blurrier than the one below it.
      sharpen: true,
    },
    postIntensity: {
      bloomStrength: 0.58,
      bloomRadius: 0.68,
      bloomThreshold: 0.84,
      gtaoRadius: 0.5,
      gtaoIntensity: 0.9,
      gtaoScale: 0.75,
      ssrMaxDistance: 28,
      ssrThickness: 0.08,
      ssrScale: 0.5,
      ssgiIntensity: 0.0,
      ssgiScale: 0.5,
      godraysDensity: 0.88,
      godraysWeight: 0.38,
      godraysExposure: 0.3,
      godraysSamples: 64,
      dofFocusRange: 24,
      dofBokehScale: 1.8,
      motionBlurSamples: 10,
      motionBlurIntensity: 0.45,
      chromaticAberrationStrength: 0.28,
      filmIntensity: 0.14,
      vignetteStrength: 0.95,
      vignetteRadius: 0.42,
      lutIntensity: 1.0,
      sharpenStrength: 0.25,
      fsr1Sharpness: 0.5,
      temporalFeedback: 0.9,
    },
    physicsSubstepCap: 4,
    drawCallCeiling: 700,
    textureAnisotropy: 8,
    corridorRings: 22,
    battleInstanceCaps: { horizon: 64, mid: 32, fore: 8 },
    msBudget: {
      frame: 16.6,
      physics: 1.9,
      shatter: 2.3,
      culling: 0.6,
      corridor: 1.8,
      battle: 0.8,
      render: 4.6,
      post: 2.0,
      audio: 0.3,
      ui: 0.3,
      spare: 2.0,
    },
  },

  MOBILE_HIGH: {
    tier: 'MOBILE_HIGH',
    targetFps: 60,
    renderScale: 0.8,
    pixelBudget: 1600 * 900,
    renderScaleMin: 0.6,
    renderScaleMax: 2.0,
    maxShardsLive: 800,
    dustSprites: 20,
    shardLifetimeMs: 3500,
    moteBudget: 1800,
    particleBudget: 3200,
    prewarm: { shards: 800, motes: 1800, particles: 3200, balls: 24, decals: 96 },
    shadowCascades: 2,
    shadowMapSize: 1024,
    shadowDistance: 70,
    maxDynamicLights: 4,
    post: {
      gtao: true,
      ssr: false,
      ssgi: false,
      godrays: true,
      bloom: true,
      dof: false,
      motionBlur: false,
      traa: false,
      taau: false,
      // Spatial upsample plus sharpen: no history buffer to pay for, no ghosting on shards.
      fsr1: true,
      smaa: true,
      fxaa: false,
      chromaticAberration: false,
      film: true,
      vignette: true,
      lut: true,
      sharpen: true,
    },
    postIntensity: {
      bloomStrength: 0.5,
      bloomRadius: 0.6,
      bloomThreshold: 0.88,
      gtaoRadius: 0.4,
      gtaoIntensity: 0.75,
      gtaoScale: 0.5,
      ssrMaxDistance: 0,
      ssrThickness: 0.1,
      ssrScale: 0.5,
      ssgiIntensity: 0.0,
      ssgiScale: 0.5,
      godraysDensity: 0.8,
      godraysWeight: 0.32,
      godraysExposure: 0.26,
      godraysSamples: 32,
      dofFocusRange: 0,
      dofBokehScale: 0,
      motionBlurSamples: 0,
      motionBlurIntensity: 0,
      chromaticAberrationStrength: 0,
      filmIntensity: 0.12,
      vignetteStrength: 0.95,
      vignetteRadius: 0.42,
      lutIntensity: 1.0,
      sharpenStrength: 0.35,
      fsr1Sharpness: 0.55,
      temporalFeedback: 0.0,
    },
    physicsSubstepCap: 3,
    drawCallCeiling: 380,
    textureAnisotropy: 4,
    corridorRings: 16,
    battleInstanceCaps: { horizon: 32, mid: 16, fore: 5 },
    msBudget: {
      frame: 16.6,
      physics: 1.7,
      shatter: 1.9,
      culling: 0.5,
      corridor: 1.9,
      battle: 0.7,
      render: 5.4,
      post: 1.9,
      audio: 0.3,
      ui: 0.3,
      spare: 2.0,
    },
  },

  MOBILE_LOW: {
    tier: 'MOBILE_LOW',
    // Presentation drops to 30; the sim stays at 60 and simply runs twice per frame. The
    // two rates are independent, which is exactly why the step is fixed rather than scaled.
    targetFps: 30,
    renderScale: 0.6,
    pixelBudget: 1280 * 720,
    renderScaleMin: 0.6,
    renderScaleMax: 2.0,
    maxShardsLive: 320,
    dustSprites: 12,
    shardLifetimeMs: 2500,
    moteBudget: 600,
    particleBudget: 1200,
    prewarm: { shards: 320, motes: 600, particles: 1200, balls: 16, decals: 48 },
    shadowCascades: 1,
    shadowMapSize: 512,
    shadowDistance: 45,
    maxDynamicLights: 2,
    post: {
      gtao: false,
      ssr: false,
      ssgi: false,
      godrays: false,
      bloom: true,
      dof: false,
      motionBlur: false,
      traa: false,
      taau: false,
      // A 0.6 buffer with no upscaler is bilinearly stretched by the compositor. FSR1 plus
      // a sharpen pass is the cheapest reconstruction that does not look like a blur.
      fsr1: true,
      smaa: true,
      fxaa: false,
      chromaticAberration: false,
      film: false,
      // Vignette and LUT survive everywhere: they cost almost nothing and they are most of
      // what makes the frame look authored rather than default.
      vignette: true,
      lut: true,
      sharpen: true,
    },
    postIntensity: {
      bloomStrength: 0.42,
      bloomRadius: 0.5,
      bloomThreshold: 0.9,
      gtaoRadius: 0,
      gtaoIntensity: 0,
      gtaoScale: 0.5,
      ssrMaxDistance: 0,
      ssrThickness: 0.1,
      ssrScale: 0.5,
      ssgiIntensity: 0,
      ssgiScale: 0.5,
      godraysDensity: 0,
      godraysWeight: 0,
      godraysExposure: 0,
      godraysSamples: 0,
      dofFocusRange: 0,
      dofBokehScale: 0,
      motionBlurSamples: 0,
      motionBlurIntensity: 0,
      chromaticAberrationStrength: 0,
      filmIntensity: 0,
      vignetteStrength: 0.26,
      vignetteRadius: 0.42,
      lutIntensity: 0.85,
      sharpenStrength: 0.30,
      fsr1Sharpness: 0.55,
      temporalFeedback: 0,
    },
    physicsSubstepCap: 3,
    drawCallCeiling: 180,
    textureAnisotropy: 2,
    corridorRings: 11,
    battleInstanceCaps: { horizon: 14, mid: 7, fore: 3 },
    msBudget: {
      frame: 33.3,
      physics: 3.0,
      shatter: 3.0,
      culling: 1.2,
      corridor: 4.0,
      battle: 1.2,
      render: 14.4,
      post: 3.3,
      audio: 0.6,
      ui: 0.6,
      spare: 2.0,
    },
  },
};

/**
 * Motion rules are indexed by tier so that "reduced motion" has somewhere concrete to point:
 * it borrows MOBILE_LOW's row. That is the whole trick - one table, two independent lookups.
 */
const MOTION_TABLE: Readonly<Record<Tier, MotionRules>> = {
  SHOWCASE: {
    cameraShakeScale: 1.0,
    cameraRollScale: 1.0,
    fovKickScale: 1.0,
    parallaxScale: 1.0,
    moteDriftScale: 1.0,
    hudPulseScale: 1.0,
    battleAnimationScale: 1.0,
    slowMoFrameSkip: 2,
    uiTransitionMs: 220,
    allowMotionBlur: true,
    allowScreenFlash: true,
    allowChromaticPulse: true,
  },

  ULTRA_4K: {
    cameraShakeScale: 1.0,
    cameraRollScale: 1.0,
    fovKickScale: 1.0,
    parallaxScale: 1.0,
    moteDriftScale: 1.0,
    hudPulseScale: 1.0,
    battleAnimationScale: 1.0,
    slowMoFrameSkip: 2,
    uiTransitionMs: 220,
    allowMotionBlur: true,
    allowScreenFlash: true,
    allowChromaticPulse: true,
  },
  DESKTOP_HIGH: {
    cameraShakeScale: 1.0,
    cameraRollScale: 1.0,
    fovKickScale: 1.0,
    parallaxScale: 1.0,
    moteDriftScale: 1.0,
    hudPulseScale: 1.0,
    battleAnimationScale: 1.0,
    slowMoFrameSkip: 2,
    uiTransitionMs: 220,
    allowMotionBlur: true,
    allowScreenFlash: true,
    allowChromaticPulse: true,
  },
  MOBILE_HIGH: {
    cameraShakeScale: 0.85,
    cameraRollScale: 0.8,
    fovKickScale: 0.8,
    parallaxScale: 0.9,
    moteDriftScale: 0.9,
    hudPulseScale: 0.9,
    battleAnimationScale: 1.0,
    slowMoFrameSkip: 2,
    uiTransitionMs: 200,
    allowMotionBlur: false,
    allowScreenFlash: true,
    allowChromaticPulse: false,
  },
  MOBILE_LOW: {
    // Doubles as the reduced-motion row. Movement is damped, never removed: a runner with
    // no motion at all stops reading as forward travel, which is worse than nauseating.
    cameraShakeScale: 0.0,
    cameraRollScale: 0.15,
    fovKickScale: 0.0,
    parallaxScale: 0.5,
    moteDriftScale: 0.5,
    hudPulseScale: 0.0,
    battleAnimationScale: 0.6,
    slowMoFrameSkip: 1,
    uiTransitionMs: 120,
    allowMotionBlur: false,
    allowScreenFlash: false,
    allowChromaticPulse: false,
  },
};

/** The tier whose MOTION rules apply when the player has asked for less movement. */
/**
 * Which optical properties of glass each tier pays for. Structurally compatible with
 * GlassMaterial's GlassFeatures; declared here because the degradation table is the one
 * place allowed to decide what a tier gets.
 */
export interface GlassToggles {
  readonly fresnel: boolean;
  readonly bevel: boolean;
  readonly refraction: boolean;
  readonly streak: boolean;
  readonly microNoise: boolean;
  /** Coloured pool cast on the floor under a lit pane. The most expensive of the six. */
  readonly caustics: boolean;
}

export const GLASS: Readonly<Record<Tier, GlassToggles>> = Object.freeze({
  SHOWCASE:     { fresnel: true,  bevel: true,  refraction: true,  streak: true,  microNoise: true,  caustics: true },
  ULTRA_4K:     { fresnel: true,  bevel: true,  refraction: true,  streak: true,  microNoise: true,  caustics: true },
  // Drops caustics and refraction: both need an extra sample of something, and the frame
  // budget at 1080p is already spent on the post chain.
  DESKTOP_HIGH: { fresnel: true,  bevel: true,  refraction: false, streak: true,  microNoise: true,  caustics: false },
  MOBILE_HIGH:  { fresnel: true,  bevel: true,  refraction: false, streak: true,  microNoise: false, caustics: false },
  // Flat fills. A Fresnel term is still cheap enough to keep glass from reading as card.
  MOBILE_LOW:   { fresnel: true,  bevel: false, refraction: false, streak: false, microNoise: false, caustics: false },
});

/**
 * The render scale, derived from what the display actually is rather than from the tier's
 * name. `budget.pixelBudget` says how many pixels the tier can afford; the display says how
 * many it needs. The ratio of those two, square-rooted because scale is per-axis, is the
 * answer - and it is allowed to exceed 1.0, which is the whole point.
 */
export function deriveRenderScale(
  budget: QualityBudget,
  displayWidth: number,
  displayHeight: number,
  devicePixelRatio: number,
): number {
  const displayPixels = Math.max(1, displayWidth * displayHeight * devicePixelRatio * devicePixelRatio);
  const ideal = Math.sqrt(budget.pixelBudget / displayPixels);

  // Boot never starts above native. The budget says what the tier would LIKE to spend; only
  // the dynamic-resolution governor, watching real frame times, is allowed to spend it.
  // Starting at the derived 2.0 shipped a stutter on any host that could not sustain it,
  // and a first impression of lag is not recoverable by climbing back down afterwards.
  const startCeiling = Math.min(budget.renderScaleMax, SUPERSAMPLE_BOOT_CEILING);
  const clamped = Math.min(Math.max(ideal, budget.renderScaleMin), startCeiling);

  // Snap DOWN to a rung: rounding up would put the frame over the budget it was derived from.
  let best = RENDER_SCALE_LADDER[0] ?? 1;
  for (const rung of RENDER_SCALE_LADDER) {
    if (rung <= clamped + 1e-6 && rung >= (budget.renderScaleMin - 1e-6)) best = rung;
  }
  return best;
}

/**
 * Dynamic resolution. Deriving render scale from a pixel BUDGET says what the tier would
 * like to afford; only measured frame time says what the machine can actually deliver. A
 * budget without a feedback loop is an aspiration, and on a weak host it is a stutter.
 */
/** Boot never exceeds native; the governor earns anything above it. */
export const SUPERSAMPLE_BOOT_CEILING = 1.0;

/**
 * How long boot will wait for the shader graph to precompile before giving up and starting
 * anyway. Awaiting compileAsync unbounded is a boot hazard: on a software rasteriser the
 * seventeen-stage TSL graph takes minutes, and a game that never reaches its first frame is
 * strictly worse than one that judders for a second. On real hardware this is never hit.
 */
export const WARMUP_BUDGET_MS = 8000;

export const DYNAMIC_RESOLUTION = Object.freeze({
  /** Frames over budget before dropping a rung. Short: a drop must feel immediate. */
  dropAfterFrames: 24,
  /** Frames comfortably under budget before climbing. Long: climbing must not oscillate. */
  raiseAfterFrames: 240,
  /** Fraction of the frame budget that counts as "over". */
  overBudgetRatio: 1.15,
  /** Fraction below which there is room to climb. */
  underBudgetRatio: 0.62,
  /** Frames to ignore at boot while shaders compile and caches warm. */
  warmupFrames: 90,
});

export const REDUCED_MOTION_TIER: Tier = 'MOBILE_LOW';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as unknown as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const QUALITY: Readonly<Record<Tier, QualityBudget>> = deepFreeze(QUALITY_TABLE);
export const MOTION: Readonly<Record<Tier, MotionRules>> = deepFreeze(MOTION_TABLE);

/**
 * Which post effects need a compute pipeline. Anything true here MUST have a working
 * non-compute path chosen by `resolvePostChain` - the WebGL fallback backend still has to
 * produce a shippable image, not a broken one.
 *
 * TODO(step-2): the render agent confirms each flag against the actual r185 node
 * implementation and corrects this table; the gating mechanism itself is final.
 */
export const POST_REQUIRES_COMPUTE: Readonly<Record<PostEffect, boolean>> = Object.freeze({
  gtao: false,
  ssr: false,
  ssgi: true,
  godrays: false,
  bloom: false,
  dof: false,
  motionBlur: false,
  traa: false,
  taau: true,
  fsr1: false,
  smaa: false,
  fxaa: false,
  chromaticAberration: false,
  film: false,
  vignette: false,
  lut: false,
  sharpen: false,
});

/** Effects that are pure movement and therefore belong to the MOTION axis, not graphics. */
export const POST_BLOCKED_BY_REDUCED_MOTION: Readonly<Record<PostEffect, boolean>> = Object.freeze({
  gtao: false,
  ssr: false,
  ssgi: false,
  godrays: false,
  bloom: false,
  dof: false,
  motionBlur: true,
  traa: false,
  taau: false,
  fsr1: false,
  smaa: false,
  fxaa: false,
  chromaticAberration: true,
  film: false,
  vignette: false,
  lut: false,
  sharpen: false,
});

/** What the tier detector is allowed to look at. Pure data, so detection stays testable. */
export interface DeviceCaps {
  readonly hasWebGPU: boolean;
  readonly hasCompute: boolean;
  readonly hasTimestampQuery: boolean;
  readonly hasFloat32Filterable: boolean;
  readonly maxTextureSize: number;
  readonly maxAnisotropy: number;
  readonly hardwareConcurrency: number;
  /** navigator.deviceMemory in GB, or null where the browser refuses to say. */
  readonly deviceMemoryGb: number | null;
  readonly devicePixelRatio: number;
  /** Backing-store pixels of the drawing surface at dpr 1, i.e. CSS width * height. */
  readonly surfacePixels: number;
  readonly isMobile: boolean;
  readonly prefersReducedMotion: boolean;
}

const ULTRA_SURFACE_PIXELS = 3840 * 2160 * 0.5;
const ULTRA_MIN_CORES = 8;
const ULTRA_MIN_MEMORY_GB = 8;
const MOBILE_HIGH_MIN_CORES = 6;
const MOBILE_HIGH_MIN_TEXTURE = 8192;

/**
 * Pure and total: same caps in, same tier out, on any machine. Nothing here reads a global,
 * which is what lets the tier be forced in tests and in the debug menu.
 */
export function detectTier(caps: DeviceCaps): Tier {
  // No WebGPU means the WebGL fallback backend, which cannot hold the high tiers' post chain.
  if (!caps.hasWebGPU) return 'MOBILE_LOW';

  if (caps.isMobile) {
    const capable =
      caps.hasCompute &&
      caps.hardwareConcurrency >= MOBILE_HIGH_MIN_CORES &&
      caps.maxTextureSize >= MOBILE_HIGH_MIN_TEXTURE;
    return capable ? 'MOBILE_HIGH' : 'MOBILE_LOW';
  }

  const bigScreen = caps.surfacePixels * caps.devicePixelRatio >= ULTRA_SURFACE_PIXELS;
  const bigMachine =
    caps.hasCompute &&
    caps.hardwareConcurrency >= ULTRA_MIN_CORES &&
    (caps.deviceMemoryGb ?? 0) >= ULTRA_MIN_MEMORY_GB;
  if (bigScreen && bigMachine) return 'ULTRA_4K';

  return caps.hasCompute ? 'DESKTOP_HIGH' : 'MOBILE_HIGH';
}

/**
 * The resolved pair of axes plus the two tables they select. Everything downstream reads
 * this object and never re-derives a tier for itself.
 */
export interface QualityResolution {
  readonly graphics: Tier;
  /** Tier whose MOTION_RULES row applies. Equals `graphics` unless motion was reduced. */
  readonly motion: Tier;
  readonly reducedMotion: boolean;
  readonly budget: QualityBudget;
  readonly motionRules: MotionRules;
  /** Post chain after compute-availability and reduced-motion gating have been applied. */
  readonly post: PostToggles;
}

/**
 * Applies both gates in the one place they may be applied. A compute-dependent effect is
 * not merely switched off: its spatial stand-in is switched on, so the fallback path is a
 * real image rather than a degraded one.
 */
export function resolvePostChain(
  budget: QualityBudget,
  reducedMotion: boolean,
  caps: Pick<DeviceCaps, 'hasCompute'>,
  renderScale: number = budget.renderScale,
): PostToggles {
  const gated: Record<PostEffect, boolean> = { ...budget.post };

  for (const effect of POST_EFFECTS) {
    if (!gated[effect]) continue;
    if (!caps.hasCompute && POST_REQUIRES_COMPUTE[effect]) gated[effect] = false;
    if (reducedMotion && POST_BLOCKED_BY_REDUCED_MOTION[effect]) gated[effect] = false;
  }

  // Losing the temporal upsampler cannot mean losing the upscale: the frame is rendered
  // below the display resolution either way, so something must reconstruct it.
  if (budget.post.taau && !gated.taau) {
    gated.fsr1 = true;
    gated.sharpen = true;
  }
  // Likewise, dropping every AA path would ship aliased glass edges. FXAA is always payable.
  if (!gated.traa && !gated.taau && !gated.smaa) gated.fxaa = true;

  /**
   * A sub-native buffer MUST be reconstructed by something. Without this, MOBILE_LOW
   * rendered at 0.6 and was bilinearly stretched to the display by the compositor - the
   * single largest cause of the build looking soft. An upscaler is not a luxury on a tier
   * that renders small; it is the reason rendering small is survivable at all.
   */
  if (renderScale < 1 && !gated.taau && !gated.fsr1) {
    gated.fsr1 = true;
    gated.sharpen = true;
  }

  return gated;
}

/** Reads the OS preference. The only DOM touch in this module, and it is guarded. */
export function readReducedMotionPreference(): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The single entry point. `override` forces the GRAPHICS axis only - a debug menu may not
 * override an accessibility preference, so reduced motion always wins on the motion axis.
 */
export function resolveTier(caps: DeviceCaps, override: Tier | null = null): QualityResolution {
  const graphics = override ?? detectTier(caps);
  const reducedMotion = caps.prefersReducedMotion;
  const motion = reducedMotion ? REDUCED_MOTION_TIER : graphics;
  const budget = QUALITY[graphics];

  return {
    graphics,
    motion,
    reducedMotion,
    budget,
    motionRules: MOTION[motion],
    post: resolvePostChain(budget, reducedMotion, caps),
  };
}

/**
 * Self-check for the tables above. The ms budget is a promise the profiler holds this file
 * to, so an edit that makes the promise unkeepable should be caught by tooling, not by a
 * player's dropped frame.
 */
export function validateQualityTable(): string[] {
  const violations: string[] = [];

  for (const tier of TIERS) {
    const budget = QUALITY[tier];
    const ms = budget.msBudget;
    const expectedFrame = 1000 / budget.targetFps;
    if (Math.abs(ms.frame - expectedFrame) > 0.1) {
      violations.push(`${tier}: msBudget.frame ${ms.frame} does not match ${budget.targetFps}fps (${expectedFrame.toFixed(2)}ms)`);
    }
    const parts =
      ms.physics + ms.shatter + ms.culling + ms.corridor + ms.battle + ms.render + ms.post + ms.audio + ms.ui + ms.spare;
    if (parts - ms.frame > 0.05) {
      violations.push(`${tier}: msBudget parts sum to ${parts.toFixed(2)}ms, over the ${ms.frame}ms frame`);
    }
    // `spare` is a promise, not work, so slack is measured against everything else.
    const slack = ms.frame - (parts - ms.spare);
    if (slack < MIN_FRAME_SLACK_MS - 0.05) {
      violations.push(`${tier}: only ${slack.toFixed(2)}ms of the ${ms.frame}ms frame is unclaimed by work, below the ${MIN_FRAME_SLACK_MS.toFixed(2)}ms minimum`);
    }
    if (!RENDER_SCALE_LADDER.includes(budget.renderScale)) {
      violations.push(`${tier}: renderScale ${budget.renderScale} is not a rung on RENDER_SCALE_LADDER`);
    }
    if (budget.renderScaleMin > budget.renderScale || budget.renderScale > budget.renderScaleMax) {
      violations.push(`${tier}: renderScale ${budget.renderScale} outside its own min/max window`);
    }
    if (budget.prewarm.shards < budget.maxShardsLive) {
      violations.push(`${tier}: prewarm.shards ${budget.prewarm.shards} below maxShardsLive ${budget.maxShardsLive}`);
    }
    if (budget.prewarm.motes < budget.moteBudget) {
      violations.push(`${tier}: prewarm.motes ${budget.prewarm.motes} below moteBudget ${budget.moteBudget}`);
    }
    if (budget.prewarm.particles < budget.particleBudget) {
      violations.push(`${tier}: prewarm.particles ${budget.prewarm.particles} below particleBudget ${budget.particleBudget}`);
    }
    if (budget.physicsSubstepCap < Math.ceil(FIXED_STEP_HZ / budget.targetFps)) {
      violations.push(`${tier}: physicsSubstepCap ${budget.physicsSubstepCap} cannot cover ${FIXED_STEP_HZ}Hz at ${budget.targetFps}fps`);
    }
  }

  return violations;
}

// Guarded rather than a bare `import.meta.env.DEV` so the tables can also be imported by
// build tooling that is not running through Vite and has no env injected.
const IS_DEV: boolean = typeof import.meta.env === 'object' && import.meta.env.DEV === true;

if (IS_DEV) {
  const violations = validateQualityTable();
  if (violations.length > 0) {
    // LOUD, but never a throw. This runs at module scope, so throwing kills the import of
    // main.ts itself and the player stares at a boot veil forever. Balance.ts made exactly
    // this mistake and it cost a debugging session; a tuning error must shout, not brick.
    console.error(`core/Quality.ts is internally inconsistent:\n  ${violations.join('\n  ')}`);
  }
}
