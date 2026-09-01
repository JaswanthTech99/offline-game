/**
 * THE BATTLE LAYER.
 *
 * A silent war fought on three parallax planes wedged into the slot between the near and mid
 * corridor bands. It has exactly two outputs and no others:
 *
 *   1. THREE INSTANCED QUADS of near-black alpha silhouettes, behind the near band so that
 *      near geometry cuts them, and masked to the corridor aperture so they can only be seen
 *      through the window the corridor leaves. See ParallaxTiers.ts for why that mask is
 *      structural rather than cosmetic.
 *   2. THE LIGHT BUS. Beats write `emisIntensity`, `shaftOpacity`, `brazierGlow`, `skyDim` and
 *      `rimBoost`, and the corridor's own materials do the rest. A distant strike lighting the
 *      pane of glass in the player's face is a bus write, never a flash quad. If a change here
 *      does not move a value on the bus, it has not changed the level's lighting - it has
 *      painted on the picture, which is the one failure mode this whole subsystem is shaped
 *      around avoiding.
 *
 * TIMING. `fixedUpdate` owns the loop clock, the light envelopes and the poses; `frame` only
 * interpolates between the last two fixed steps and re-anchors the rig to the camera. Slow
 * motion therefore needs nothing here: the engine simply calls `fixedUpdate` fewer times.
 *
 * THE TABLEAU. Every figure's base pose is its place in a composed picture, authored mid-blow
 * in Silhouettes.ts. Beats add DEVIATION on top of that pose and never replace it, so when
 * `motionRules.battleAnimationScale` is 0 the deviation term vanishes and what is left is not
 * an arbitrary rest frame - it is a war caught at the height of its action.
 */

import { Group, MathUtils, Vector3 } from 'three/webgpu';
import type { Color, DataTexture, Object3D, PerspectiveCamera } from 'three/webgpu';
import type { QualityResolution } from '../core/Quality';
import type { Alpha, Disposable, Millis, Seed, Tickable } from '../core/types';
import type { LightBus, LightChannel } from '../universe/LightBus';
import { LIGHT_BUS_NEUTRAL, LIGHT_CHANNELS, LIGHT_CHANNEL_RANGE } from '../universe/LightBus';
import {
  applyBattlePalette,
  createAtlasTexture,
  createBattleUniforms,
  FALLBACK_CORRIDOR_SLOT,
  ParallaxTierRig,
  resolveSlotDistance,
  TIER_STAGING,
  validateTierStaging,
} from './ParallaxTiers';
import type { BattleUniforms, CorridorSlot } from './ParallaxTiers';
import { cellFit, SILHOUETTES, buildSilhouetteAtlas, validateSilhouettes } from './Silhouettes';
import type { AtlasCell } from './Silhouettes';
import type { Beat, BeatTimeline, LightEvent, LightEventShape, ParallaxTier, SilhouetteId } from './types';
import { PARALLAX_TIERS, createRng, validateRoster } from './types';
import type { BattleRoster } from './types';

/**
 * Dramaturgy constants for the performance itself. Like the timeline laws in `battle/types.ts`
 * these shape what the battle MEANS, not what it costs; every count, cap and millisecond
 * allowance this file obeys is imported from core/Quality.ts.
 */

const TAU = Math.PI * 2;

/** Attack and release curve exponents per light-event shape. The shape is the drama. */
const ENVELOPE_CURVE: Readonly<Record<LightEventShape, { readonly rise: number; readonly fall: number }>> =
  Object.freeze({
    /** Almost instant on, hard off. A blow landing. */
    strike: Object.freeze({ rise: 0.18, fall: 3.0 }),
    /** Eased both ways. Something enormous passing. */
    swell: Object.freeze({ rise: 1.6, fall: 1.6 }),
    /** Eased, then shivered by the throb below. A working forge, a beating engine. */
    pulse: Object.freeze({ rise: 1.0, fall: 1.4 }),
    /** Slow to arrive, very slow to leave. Smoke or a shadow crossing the light. */
    smother: Object.freeze({ rise: 2.2, fall: 0.55 }),
  });

const PULSE_CYCLES = 3;
/** A throb that reaches zero reads as a strobe; this keeps a pulse continuous. */
const PULSE_FLOOR = 0.55;
/** Guards a zero-length phase without letting an author's typo divide by zero. */
const MIN_PHASE_MS: Millis = 1;

/** How a beat's pressure wave moves a figure, before tier and accessibility gains. */
const BEAT_MOTION = Object.freeze({
  attackFrac: 0.22,
  holdFrac: 0.3,
  /** Lateral shove, in backdrop widths. */
  translate: 0.045,
  /** Vertical shove, in backdrop heights. */
  rise: 0.03,
  /** Radians of roll. */
  roll: 0.16,
  /** Fractional swell of the figure's own size. */
  swell: 0.12,
  /** Stagger across the cast, so the tier does not move as a single animal. */
  phaseSpreadMs: 420,
});

/**
 * Rate ceiling on the light bus, as a fraction of each channel's own domain per millisecond,
 * applied only when `motionRules.allowScreenFlash` is off. The bus is rate-limited rather
 * than turned down on purpose: a photosensitive player still gets the full strength of a
 * swell to arrive at full strength, and a strike to arrive at a fraction of it, instead of
 * every event snapping on inside four frames. Scaling the peaks down instead would quietly
 * flatten the battle for exactly the players who asked only for less MOVEMENT.
 */
const FLASH_SAFE_RATE_PER_MS = 0.0012;

const POSE_STRIDE = 4;
const DEVIATION_STRIDE = 4;

/** Derived, not chosen: one InstancedMesh per tier and nothing else in the subtree. */
export const MAX_BATTLE_DRAW_CALLS = PARALLAX_TIERS.length;

const IS_DEV: boolean = typeof import.meta.env === 'object' && import.meta.env.DEV === true;

export interface BattlePalette {
  /** Near-black body ink. */
  readonly ink: Color;
  /** The thin leading-edge rim. Normally the theme's primary emissive. */
  readonly rim: Color;
  /** What aerial perspective lifts distant ink towards. Normally the theme's haze. */
  readonly haze: Color;
}

/**
 * A figure on a no-whole-bodies tier has to be big enough that the frame genuinely cuts it.
 * Below this it just sits small and complete near the edge, which is the exact read the tier
 * exists to avoid.
 */
const HORIZON_MIN_HEIGHT_FRAC = 0.35;

/**
 * Silhouettes are authored for the scale they are seen at, so a shape is only legal on the
 * tiers it declares. The layer drops an illegal pairing rather than staging it wrong, and
 * this is what tells the author it happened instead of leaving a hole in the tableau.
 */
export function validateCast(roster: BattleRoster): string[] {
  const violations: string[] = [];
  for (const combatant of roster.combatants) {
    const def = SILHOUETTES[combatant.silhouette];
    if (!def.tiers.includes(combatant.tier)) {
      violations.push(
        `staging: roster "${roster.id}" puts "${combatant.silhouette}" on the ${combatant.tier} tier, ` +
          `which it is not authored for (${def.tiers.join(', ')}) - it will be dropped`,
      );
    }
    if (!TIER_STAGING[combatant.tier].wholeBodies && combatant.heightFrac < HORIZON_MIN_HEIGHT_FRAC) {
      violations.push(
        `staging: roster "${roster.id}" combatant "${combatant.id}" is only ${combatant.heightFrac} of ` +
          `frame on a tier that must never show a whole body - it will fit inside the aperture`,
      );
    }
  }
  return violations;
}

export interface BattleLayerOptions {
  readonly roster: BattleRoster;
  readonly quality: QualityResolution;
  /** The one bus. The layer writes it; it never reads back a value it did not write. */
  readonly light: LightBus;
  readonly palette: BattlePalette;
  readonly seed: Seed;
}

/** One combatant, resolved against a tier, a silhouette and an instance slot. */
interface StagedFigure {
  readonly tier: ParallaxTier;
  /** Index into PARALLAX_TIERS. Cached so the frame loop never scans for it. */
  readonly tierOrder: number;
  /** Slot in the tier's InstancedMesh. */
  readonly index: number;
  readonly widthFrac: number;
  readonly heightFrac: number;
  /** Fraction of its square atlas cell the figure actually fills. Drives the contain fit. */
  readonly fitW: number;
  readonly fitH: number;
  readonly baseX: number;
  readonly baseFeetY: number;
  readonly baseRoll: number;
  readonly baseScale: number;
  readonly crop: number;
  readonly rise: number;
  readonly phaseMs: Millis;
  /** Per beat: dx, dFeetY, dRoll, dScale. Drawn once from the seeded Rng, never re-rolled. */
  readonly deviation: Float32Array;
}

/** tanh limiter: drift eases into a wall instead of hitting one. */
const softLimit = (value: number, limit: number): number =>
  limit <= 0 ? 0 : limit * Math.tanh(value / limit);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Value of a light envelope `t` ms after the event began. 0 outside the event entirely. */
function envelopeAt(event: LightEvent, t: Millis): number {
  if (t < 0) return 0;
  const curve = ENVELOPE_CURVE[event.shape];
  const attack = Math.max(event.attackMs, MIN_PHASE_MS);
  const hold = Math.max(event.holdMs, 0);
  const release = Math.max(event.releaseMs, MIN_PHASE_MS);
  const total = attack + hold + release;
  if (t >= total) return 0;

  let value: number;
  if (t < attack) value = Math.pow(t / attack, curve.rise);
  else if (t < attack + hold) value = 1;
  else value = Math.pow(1 - (t - attack - hold) / release, curve.fall);

  if (event.shape === 'pulse') {
    // The throb rides ON the envelope rather than beside it, so it can never outlive the
    // event and leave a bus channel parked off neutral.
    const throb = 0.5 + 0.5 * Math.cos((t / total) * TAU * PULSE_CYCLES);
    value *= PULSE_FLOOR + (1 - PULSE_FLOOR) * throb;
  }
  return value;
}

/**
 * The pressure wave, `t` ms after it was due. Deliberately a different, blunter shape from the
 * light: the flash is a curve, the shove that follows it is a shove.
 */
function pressureAt(beat: Beat, t: Millis): number {
  const duration = beat.durationMs;
  if (t < 0 || t >= duration) return 0;
  const attack = duration * BEAT_MOTION.attackFrac;
  const hold = duration * BEAT_MOTION.holdFrac;
  if (t < attack) {
    const u = t / Math.max(attack, MIN_PHASE_MS);
    return u * u * (3 - 2 * u);
  }
  if (t < attack + hold) return 1;
  const u = (t - attack - hold) / Math.max(duration - attack - hold, MIN_PHASE_MS);
  return 0.5 + 0.5 * Math.cos(Math.min(u, 1) * Math.PI);
}

export class BattleLayer implements Tickable, Disposable {
  /** Add this to the scene. It re-anchors itself to the camera every frame. */
  readonly group = new Group();

  private readonly roster: BattleRoster;
  private readonly quality: QualityResolution;
  private readonly light: LightBus;
  private readonly uniforms: BattleUniforms;
  private readonly atlasTexture: DataTexture;
  private readonly rigs: ReadonlyMap<ParallaxTier, ParallaxTierRig>;
  private readonly cast: readonly StagedFigure[];

  /** Pose channels, pooled at full tier capacity so no frame ever allocates. */
  private readonly posePrev: Float32Array;
  private readonly poseCur: Float32Array;
  /** Unbounded parallax accumulator, then its limited prev/cur pair. Two floats per tier. */
  private readonly driftRaw: Float32Array;
  private readonly driftPrev: Float32Array;
  private readonly driftCur: Float32Array;

  private readonly lightTarget: Record<LightChannel, number> = { ...LIGHT_BUS_NEUTRAL };
  private readonly lightStrength: Float32Array = new Float32Array(LIGHT_CHANNELS.length);

  private readonly cameraWorld = new Vector3();
  private readonly cameraStep = new Vector3();
  private readonly cameraRight = new Vector3();
  private readonly cameraUp = new Vector3();
  private readonly cameraForward = new Vector3();
  private readonly lastCameraWorld = new Vector3();
  private hasCameraOrigin = false;

  /** Per tier: distance, halfWidth, halfHeight of the backdrop plane. Rebuilt each frame. */
  private readonly tierMetrics = new Float32Array(PARALLAX_TIERS.length * 3);
  private readonly tierWritten = new Int32Array(PARALLAX_TIERS.length);

  private camera: PerspectiveCamera | null = null;
  private slot: CorridorSlot = FALLBACK_CORRIDOR_SLOT;
  private clockMs: Millis = 0;
  private disposed = false;

  constructor(options: BattleLayerOptions) {
    this.roster = options.roster;
    this.quality = options.quality;
    this.light = options.light;

    if (IS_DEV) {
      const violations = [
        ...validateRoster(options.roster),
        ...validateCast(options.roster),
        ...validateTierStaging(),
        ...validateSilhouettes(),
      ];
      if (violations.length > 0) {
        throw new Error(`BattleLayer cannot stage this roster:\n  ${violations.join('\n  ')}`);
      }
    }

    const atlas = buildSilhouetteAtlas();
    this.atlasTexture = createAtlasTexture(atlas);
    this.uniforms = createBattleUniforms();
    applyBattlePalette(this.uniforms, options.palette);

    const caps = options.quality.budget.battleInstanceCaps;
    const rigs = new Map<ParallaxTier, ParallaxTierRig>();
    // Back to front. Depth writes are off, so the paint order inside the layer is the only
    // thing deciding which figure is in front of which.
    PARALLAX_TIERS.forEach((tier, order) => {
      const rig = new ParallaxTierRig({
        tier,
        capacity: caps[tier],
        atlas: this.atlasTexture,
        uniforms: this.uniforms,
        light: options.light.uniforms,
        renderOrder: order,
      });
      rigs.set(tier, rig);
      this.group.add(rig.mesh);
    });
    this.rigs = rigs;
    this.group.name = 'battle-layer';

    const totalCapacity = PARALLAX_TIERS.reduce((sum, tier) => sum + caps[tier], 0);
    this.posePrev = new Float32Array(totalCapacity * POSE_STRIDE);
    this.poseCur = new Float32Array(totalCapacity * POSE_STRIDE);
    this.driftRaw = new Float32Array(PARALLAX_TIERS.length * 2);
    this.driftPrev = new Float32Array(PARALLAX_TIERS.length * 2);
    this.driftCur = new Float32Array(PARALLAX_TIERS.length * 2);

    this.cast = this.stageCast(atlas.cells, options.seed);
    this.resetPoses();

    if (IS_DEV) this.assertDrawCallBudget();
  }

  /* ---------------------------------------------------------------- staging ------------- */

  private stageCast(cells: Readonly<Record<SilhouetteId, AtlasCell>>, seed: Seed): StagedFigure[] {
    const staged: StagedFigure[] = [];
    const caps = this.quality.budget.battleInstanceCaps;
    const beats = this.roster.timeline.beats.length;
    const rng = createRng(seed);

    PARALLAX_TIERS.forEach((tier, tierOrder) => {
      const rig = this.rigs.get(tier);
      if (rig === undefined) return;
      const staging = TIER_STAGING[tier];
      let index = 0;

      for (const combatant of this.roster.combatants) {
        if (combatant.tier !== tier) continue;
        // Roster order is composition order, so an over-budget roster loses its background
        // extras rather than the figure the tableau was built around.
        if (index >= caps[tier]) break;

        const def = SILHOUETTES[combatant.silhouette];
        // A shape staged on a tier it was never drawn for reads wrong at that scale, so it is
        // dropped rather than shown - `validateRoster` is where an author is told about it.
        if (!def.tiers.includes(tier)) continue;

        rig.setFigure(index, cells[combatant.silhouette]);
        rig.setAppearance(index, Math.min(Math.max(combatant.opacity, 0), 1), def.leadingAngle, staging.rimGain);

        // Every figure forks its own stream, so adding a draw for one combatant cannot shift
        // the performance every other combatant gives.
        const stream = rng.fork(tierOrder * 1013 + index);
        const deviation = new Float32Array(beats * DEVIATION_STRIDE);
        for (let b = 0; b < beats; b++) {
          const o = b * DEVIATION_STRIDE;
          deviation[o] = stream.range(-BEAT_MOTION.translate, BEAT_MOTION.translate);
          deviation[o + 1] = stream.range(-BEAT_MOTION.rise, BEAT_MOTION.rise);
          deviation[o + 2] = stream.range(-BEAT_MOTION.roll, BEAT_MOTION.roll);
          deviation[o + 3] = stream.range(-BEAT_MOTION.swell, BEAT_MOTION.swell);
        }

        const fit = cellFit(def);
        // A tier that forbids whole bodies gets its cast shoved out to the frame edge and
        // dropped below the floor line, so the aperture always cuts the figure.
        const outward = combatant.anchor.xFrac >= 0 ? 1 : -1;
        const baseX = staging.edgePush > 0
          ? outward * Math.max(Math.abs(combatant.anchor.xFrac), staging.edgePush)
          : combatant.anchor.xFrac;

        staged.push({
          tier,
          tierOrder,
          index,
          widthFrac: combatant.widthFrac,
          heightFrac: combatant.heightFrac,
          fitW: fit.fw,
          fitH: fit.fh,
          baseX,
          baseFeetY: combatant.anchor.yFrac - staging.footDrop * 2,
          baseRoll: def.tableau.lean,
          baseScale: def.tableau.scale * staging.sizeGain,
          crop: def.tableau.crop,
          rise: def.tableau.rise,
          phaseMs: stream.range(0, BEAT_MOTION.phaseSpreadMs),
          deviation,
        });
        index++;
      }
      rig.commit(index);
    });

    return staged;
  }

  private resetPoses(): void {
    for (let i = 0; i < this.cast.length; i++) {
      const figure = this.cast[i];
      if (figure === undefined) continue;
      const o = i * POSE_STRIDE;
      this.poseCur[o] = figure.baseX;
      this.poseCur[o + 1] = figure.baseFeetY;
      this.poseCur[o + 2] = figure.baseRoll;
      this.poseCur[o + 3] = figure.baseScale;
      for (let c = 0; c < POSE_STRIDE; c++) this.posePrev[o + c] = this.poseCur[o + c] as number;
    }
  }

  /* ---------------------------------------------------------------- wiring -------------- */

  setCamera(camera: PerspectiveCamera): void {
    this.camera = camera;
    this.hasCameraOrigin = false;
  }

  /**
   * Pushed in by the corridor renderer. The layer clamps itself strictly inside the slot, so
   * a bad slot degrades to a flat backdrop rather than to figures in front of the near wall.
   */
  setSlot(slot: CorridorSlot): void {
    this.slot = slot;
  }

  /**
   * The corridor's window onto the backdrop, in screen UV. Without this the layer bleeds past
   * every gap in the tube - see the header of ParallaxTiers.ts.
   */
  setAperture(
    centerX: number,
    centerY: number,
    halfWidth: number,
    halfHeight: number,
    feather: number,
    roundness: number,
  ): void {
    this.uniforms.apertureCenter.value.set(centerX, centerY);
    this.uniforms.apertureHalf.value.set(Math.max(halfWidth, 1e-4), Math.max(halfHeight, 1e-4));
    this.uniforms.apertureFeather.value = Math.min(Math.max(feather, 0), 1);
    this.uniforms.apertureRound.value = Math.min(Math.max(roundness, 0), 1);
  }

  setPalette(palette: BattlePalette): void {
    applyBattlePalette(this.uniforms, palette);
  }

  /* ---------------------------------------------------------------- tick ---------------- */

  fixedUpdate(dt: Millis): void {
    if (this.disposed) return;
    const timeline = this.roster.timeline;
    this.clockMs = (this.clockMs + dt) % timeline.loopMs;
    this.writeLightBus(timeline, dt);
    this.advancePoses(timeline);
    this.advanceDrift();
  }

  /**
   * Time since a beat began, wrapped. A negative raw offset means the beat belongs to the
   * previous pass of the loop and is still releasing across the seam - which is exactly what
   * has to keep working, or every loop boundary snaps the corridor's lighting.
   */
  private beatTime(atMs: Millis, loopMs: Millis): Millis {
    const t = this.clockMs - atMs;
    return t >= 0 ? t : t + loopMs;
  }

  private writeLightBus(timeline: BeatTimeline, dt: Millis): void {
    for (let c = 0; c < LIGHT_CHANNELS.length; c++) this.lightStrength[c] = 0;
    for (const channel of LIGHT_CHANNELS) this.lightTarget[channel] = LIGHT_BUS_NEUTRAL[channel];

    for (const beat of timeline.beats) {
      const event = beat.light;
      if (event === null) continue;
      const envelope = envelopeAt(event, this.beatTime(beat.atMs, timeline.loopMs));
      if (envelope <= 0) continue;

      for (let c = 0; c < LIGHT_CHANNELS.length; c++) {
        const channel = LIGHT_CHANNELS[c];
        if (channel === undefined) continue;
        const peak = event.peak[channel];
        if (peak === undefined) continue;
        const neutral = LIGHT_BUS_NEUTRAL[channel];
        const value = neutral + (peak - neutral) * envelope;
        const strength = Math.abs(value - neutral);
        // Overlapping events do not sum: the loudest claim on a channel wins outright, so two
        // beats cannot stack into a white-out the author never asked for.
        if (strength > (this.lightStrength[c] as number)) {
          this.lightStrength[c] = strength;
          this.lightTarget[channel] = value;
        }
      }
    }

    if (!this.quality.motionRules.allowScreenFlash) this.limitFlashRate(dt);
    this.light.set(this.lightTarget);
  }

  /** Caps how far each channel may travel this step. See FLASH_SAFE_RATE_PER_MS. */
  private limitFlashRate(dt: Millis): void {
    for (const channel of LIGHT_CHANNELS) {
      const [min, max] = LIGHT_CHANNEL_RANGE[channel];
      const step = (max - min) * FLASH_SAFE_RATE_PER_MS * dt;
      const from = this.light.get(channel);
      const delta = this.lightTarget[channel] - from;
      if (delta > step) this.lightTarget[channel] = from + step;
      else if (delta < -step) this.lightTarget[channel] = from - step;
    }
  }

  private advancePoses(timeline: BeatTimeline): void {
    const animation = this.quality.motionRules.battleAnimationScale;
    const beats = timeline.beats;

    for (let i = 0; i < this.cast.length; i++) {
      const figure = this.cast[i];
      if (figure === undefined) continue;
      const o = i * POSE_STRIDE;
      // Explicit element copy rather than set(subarray(...)): a subarray is an allocation, and
      // this runs once per figure per fixed step.
      for (let c = 0; c < POSE_STRIDE; c++) this.posePrev[o + c] = this.poseCur[o + c] as number;

      let dx = 0;
      let dy = 0;
      let droll = 0;
      let dscale = 0;

      if (animation > 0) {
        for (let b = 0; b < beats.length; b++) {
          const beat = beats[b];
          if (beat === undefined) continue;
          // Light first, pressure 700-800ms later. That gap is why a strike reads as distance
          // rather than as a screen effect, and it is a law in battle/types.ts.
          const t = this.beatTime(beat.atMs + beat.pressureDelayMs + figure.phaseMs, timeline.loopMs);
          const wave = pressureAt(beat, t);
          if (wave <= 0) continue;
          const d = b * DEVIATION_STRIDE;
          dx += (figure.deviation[d] as number) * wave;
          dy += (figure.deviation[d + 1] as number) * wave;
          droll += (figure.deviation[d + 2] as number) * wave;
          dscale += (figure.deviation[d + 3] as number) * wave;
        }
      }

      const gain = TIER_STAGING[figure.tier].deviationGain * animation;
      this.poseCur[o] = figure.baseX + dx * gain;
      this.poseCur[o + 1] = figure.baseFeetY + dy * gain;
      this.poseCur[o + 2] = figure.baseRoll + droll * gain;
      this.poseCur[o + 3] = figure.baseScale * (1 + dscale * gain);
    }
  }

  private advanceDrift(): void {
    const camera = this.camera;
    // Two axes, two owners. Camera-derived drift is a DEPTH CUE and answers to parallaxScale;
    // the autonomous sway is the battle moving under its own power and answers to
    // battleAnimationScale, which is why animation 0 in front of a still camera leaves the
    // tableau genuinely motionless rather than gently breathing.
    const parallax = this.quality.motionRules.parallaxScale;
    const animation = this.quality.motionRules.battleAnimationScale;

    if (camera !== null) {
      camera.getWorldPosition(this.cameraWorld);
      if (!this.hasCameraOrigin) {
        this.lastCameraWorld.copy(this.cameraWorld);
        this.hasCameraOrigin = true;
      }
      this.cameraStep.subVectors(this.cameraWorld, this.lastCameraWorld);
      this.lastCameraWorld.copy(this.cameraWorld);
      // Only sideways and vertical camera travel may move the backdrop. Forward travel must
      // not, or the layer streams past the player like a wall instead of standing off at a
      // distance - which is the entire illusion.
      camera.matrixWorld.extractBasis(this.cameraRight, this.cameraUp, this.cameraForward);
    } else {
      this.cameraStep.set(0, 0, 0);
      this.cameraRight.set(1, 0, 0);
      this.cameraUp.set(0, 1, 0);
    }

    const lateral = this.cameraStep.dot(this.cameraRight);
    const vertical = this.cameraStep.dot(this.cameraUp);
    const phase = (this.clockMs / 1000) * TAU;

    PARALLAX_TIERS.forEach((tier, order) => {
      const staging = TIER_STAGING[tier];
      const o = order * 2;
      this.driftPrev[o] = this.driftCur[o] as number;
      this.driftPrev[o + 1] = this.driftCur[o + 1] as number;

      const gain = staging.driftGain * parallax;
      this.driftRaw[o] = (this.driftRaw[o] as number) - lateral * gain;
      this.driftRaw[o + 1] = (this.driftRaw[o + 1] as number) - vertical * gain;

      const swayX = Math.sin(phase * staging.swayHz) * staging.swayFrac * animation;
      const swayY = Math.cos(phase * staging.swayHz * 0.5) * staging.swayFrac * 0.4 * animation;
      this.driftCur[o] = softLimit(this.driftRaw[o] as number, staging.maxDriftFrac) + swayX;
      this.driftCur[o + 1] = softLimit(this.driftRaw[o + 1] as number, staging.maxDriftFrac) + swayY;
    });
  }

  frame(alpha: Alpha): void {
    const camera = this.camera;
    if (this.disposed || camera === null) return;

    // The rig rides the camera so the backdrop is never overtaken, and inherits its rotation
    // so all three tiers face the viewer without a per-instance billboard in the shader.
    camera.getWorldPosition(this.cameraWorld);
    this.group.position.copy(this.cameraWorld);
    camera.getWorldQuaternion(this.group.quaternion);

    // Per tier, once: the backdrop's world extent depends only on the tier's distance and the
    // camera, never on the figure standing on it.
    const halfFov = MathUtils.degToRad(camera.fov) * 0.5;
    PARALLAX_TIERS.forEach((tier, order) => {
      const distance = resolveSlotDistance(tier, this.slot);
      const halfH = Math.tan(halfFov) * distance;
      const m = order * 3;
      this.tierMetrics[m] = distance;
      this.tierMetrics[m + 1] = halfH * camera.aspect;
      this.tierMetrics[m + 2] = halfH;
      this.tierWritten[order] = 0;
      const rig = this.rigs.get(tier);
      // Local z only: the group already carries the camera's position and rotation, so this
      // is the tier's stand-off inside the near/mid slot and nothing else.
      if (rig !== undefined) rig.mesh.position.z = -distance;
    });

    for (let i = 0; i < this.cast.length; i++) {
      const figure = this.cast[i];
      if (figure === undefined) continue;
      const rig = this.rigs.get(figure.tier);
      if (rig === undefined) continue;

      const m = figure.tierOrder * 3;
      const halfW = this.tierMetrics[m + 1] as number;
      const halfH = this.tierMetrics[m + 2] as number;

      const o = i * POSE_STRIDE;
      const x = lerp(this.posePrev[o] as number, this.poseCur[o] as number, alpha);
      const feetY = lerp(this.posePrev[o + 1] as number, this.poseCur[o + 1] as number, alpha);
      const roll = lerp(this.posePrev[o + 2] as number, this.poseCur[o + 2] as number, alpha);
      const scale = lerp(this.posePrev[o + 3] as number, this.poseCur[o + 3] as number, alpha);

      const d = figure.tierOrder * 2;
      const driftX = lerp(this.driftPrev[d] as number, this.driftCur[d] as number, alpha);
      const driftY = lerp(this.driftPrev[d + 1] as number, this.driftCur[d + 1] as number, alpha);

      // Contain fit: the quad is square because the atlas cell is, so the figure's real
      // proportions come from how much of that cell it fills, never from the quad.
      const side =
        Math.min(
          (figure.widthFrac * 2 * halfW) / figure.fitW,
          (figure.heightFrac * 2 * halfH) / figure.fitH,
        ) * Math.max(scale, 0);

      // `crop` exaggerates the anchor outwards so the aperture cuts the figure. An uncropped
      // body reads as a toy on a shelf; a cropped one reads as enormous.
      const worldX = (x * (1 + figure.crop) + driftX) * halfW;
      const worldY = (feetY + driftY) * halfH + side * figure.fitH * (0.5 + figure.rise);

      rig.setPose(figure.index, worldX, worldY, side, roll);
      this.tierWritten[figure.tierOrder] = (this.tierWritten[figure.tierOrder] as number) + 1;
    }

    PARALLAX_TIERS.forEach((tier, order) => {
      this.rigs.get(tier)?.commit(this.tierWritten[order] as number);
    });
  }

  /* ---------------------------------------------------------------- diagnostics --------- */

  /** Live instanced meshes in the layer's subtree. One per tier, always. */
  get drawCalls(): number {
    let meshes = 0;
    this.group.traverse((object: Object3D) => {
      if ((object as Partial<{ isMesh: boolean }>).isMesh === true) meshes++;
    });
    return meshes;
  }

  /**
   * The layer's hard structural promise. Three planes of enormous silhouettes is the cheapest
   * possible way to buy that much depth, and it stays cheap only while nobody adds a mesh -
   * so this fails loudly in dev the moment someone does.
   */
  assertDrawCallBudget(): void {
    const calls = this.drawCalls;
    if (calls > MAX_BATTLE_DRAW_CALLS) {
      throw new Error(
        `BattleLayer draws ${calls} meshes, over its ceiling of ${MAX_BATTLE_DRAW_CALLS} ` +
          '(one InstancedMesh per parallax tier). Pack the new geometry into a tier atlas instead.',
      );
    }
  }

  /** Loop position in ms. Exposed for the debug overlay and for deterministic tests. */
  get elapsedMs(): Millis {
    return this.clockMs;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The bus outlives the layer, so hand it back neutral or the corridor keeps the last
    // beat's lighting forever.
    this.light.reset();
    for (const rig of this.rigs.values()) {
      this.group.remove(rig.mesh);
      rig.dispose();
    }
    this.atlasTexture.dispose();
  }
}
