/**
 * THE CORRIDOR.
 *
 * One seeded, reproducible queue of glass rings receding to a vanishing point, advancing past
 * a camera that never actually moves. Two jobs, and they are deliberately separate:
 *
 *   fixedUpdate  commits travel, recycles rings that fell behind, republishes SITE 1's per-ring
 *                depth, and rebases the field so world coordinates never grow without bound.
 *                Runs at exactly 60 Hz. This is the only place corridor STATE changes.
 *   frame        moves the root by an interpolated travel distance and nothing else. Never
 *                mutates the field. This is the only place `alpha` is allowed to appear.
 *
 * Reproducibility rests on one property: ring CONTENT is a pure function of the ABSOLUTE ring
 * index and the run seed, never of the slot it landed in or the order recycling happened in.
 * Two players on one seed fly through identical glass even if one of them dropped forty frames.
 *
 * Exposure: the histogram in Exposure.ts is enforced structurally by how the ring field is
 * built - the four sites are wired at construction and there is no code path around them. The
 * validator here is the DIAGNOSTIC half: it measures the frame this theme will actually produce
 * and reports every law it breaks. It reports loudly in dev rather than throwing, because a
 * screen-area model is an estimate and a theme still being tuned by another author must not
 * take the whole game down; `assertExposureSane` is exported from Exposure.ts for tooling and
 * tests that do want a hard gate.
 */

import { Group } from 'three/webgpu';
import type { QualityResolution } from '../core/Quality';
import type { Alpha, Disposable, Millis, Seed, Tickable, Unit } from '../core/types';
import type { UniverseTheme } from '../universe/UniverseTheme';
import type {
  CorridorExposureModel,
  EdgeSplit,
  ExposureSample,
  ExposureStats,
  VignetteRequest,
} from './Exposure';
import {
  corridorExposureSamples,
  measureExposure,
  postVignetteRequest,
  splitEdgeDarkening,
  validateExposure,
} from './Exposure';
import type { CrystalNode, PaneQuad, RingMaterialFactory } from './Rings';
import { RING_LAYOUT, RingField } from './Rings';

// Guarded the same way core/Quality.ts guards its self-check, so this module can also be
// imported by build tooling that never runs through Vite.
const IS_DEV: boolean = typeof import.meta.env === 'object' && import.meta.env.DEV === true;

export interface CorridorOptions {
  readonly seed: Seed;
  readonly theme: UniverseTheme;
  /** Supplies the ring count and the vignette numbers. The corridor invents neither. */
  readonly quality: QualityResolution;
  /** Injected by the materials agent. Defaults to the runnable stand-in set in Rings.ts. */
  readonly materials?: RingMaterialFactory;
}

export class CorridorGenerator implements Tickable, Disposable {
  /** Add this to the scene. The corridor only ever translates along z. */
  readonly root = new Group();
  readonly field: RingField;
  readonly edge: EdgeSplit;

  private readonly fieldLength: number;
  private readonly theme: UniverseTheme;

  /** Metres travelled since the run began. Committed only in `fixedUpdate`. */
  private travel = 0;
  private previousTravel = 0;
  private speed = 0;
  /** Whole field-lengths already subtracted from the root, to keep coordinates small. */
  private rebaseOffset = 0;

  constructor(options: CorridorOptions) {
    const budget = options.quality.budget;
    this.theme = options.theme;
    this.edge = splitEdgeDarkening(budget.postIntensity, options.quality.post.vignette);

    const fieldOptions = {
      ringCount: budget.corridorRings,
      seed: options.seed,
      theme: options.theme,
      post: budget.postIntensity,
      edge: this.edge,
      ...(options.materials === undefined ? {} : { materials: options.materials }),
    };
    this.field = new RingField(fieldOptions);
    this.root.add(this.field.root);

    this.fieldLength = this.field.ringCount * RING_LAYOUT.spacing;
    this.settle();

    if (IS_DEV) {
      const violations = this.validate();
      if (violations.length > 0) {
        console.error(
          `Corridor exposure histogram violated for theme "${options.theme.id}":\n  ${violations.join('\n  ')}`,
        );
      }
    }
  }

  /** Metres per second the camera flies down the corridor. Set by the run controller. */
  setSpeed(metresPerSecond: number): void {
    this.speed = Number.isFinite(metresPerSecond) ? Math.max(0, metresPerSecond) : 0;
  }

  get travelMetres(): number {
    return this.travel;
  }

  /**
   * Seek. Used by the run start and by the debug menu; the intervening rings are never
   * simulated, and because content is keyed to the absolute ring index they do not need to be.
   */
  advanceTo(metres: number): void {
    if (!Number.isFinite(metres)) return;
    this.travel = Math.max(0, metres);
    this.previousTravel = this.travel;
    this.settle();
  }

  fixedUpdate(dt: Millis): void {
    this.previousTravel = this.travel;
    this.travel += (this.speed * dt) / 1000;
    this.settle();
  }

  frame(alpha: Alpha): void {
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const interpolated = this.previousTravel + (this.travel - this.previousTravel) * t;
    // Rebasing shifted the field's local z by the same amount it shifted this offset, so the
    // interpolated position stays continuous across the step a rebase happened on.
    this.root.position.z = interpolated - this.rebaseOffset;
  }

  /** Where the field's local origin currently sits relative to the camera. */
  get rootZ(): number {
    return this.travel - this.rebaseOffset;
  }

  /** 0 at the camera, 1 at the far end of the field. SITE 1's input. */
  depthOf(slot: number): Unit {
    const worldZ = this.rootZ + this.field.localZ(slot);
    const depth = -worldZ / this.fieldLength;
    return depth < 0 ? 0 : depth > 1 ? 1 : depth;
  }

  forEachLivePane(visit: (quad: PaneQuad) => void): void {
    this.field.forEachLivePane(visit);
  }

  forEachCrystal(visit: (crystal: CrystalNode) => void): void {
    this.field.forEachCrystal(visit);
  }

  /** A pane the player smashed. Idempotent; the instance stays pooled at zero scale. */
  retirePane(slot: number, pane: number): void {
    this.field.retirePane(slot, pane);
    this.field.commit();
  }

  /** The frame this corridor will actually produce, as measurable samples. */
  exposureSamples(): ExposureSample[] {
    return corridorExposureSamples(this.theme, this.exposureModel(), this.edge);
  }

  histogram(): ExposureStats {
    return measureExposure(this.exposureSamples());
  }

  /** Every exposure law this corridor breaks. Empty array means the histogram holds. */
  validate(): string[] {
    return validateExposure(this.exposureSamples(), this.edge, this.field.exposureGraph());
  }

  /** SITE 3's post half, for the render agent's hand-rolled vignette node. */
  vignetteRequest(): VignetteRequest {
    return postVignetteRequest(this.edge);
  }

  dispose(): void {
    this.root.clear();
    this.field.dispose();
  }

  private exposureModel(): CorridorExposureModel {
    return {
      ringCount: this.field.ringCount,
      ringSpacing: RING_LAYOUT.spacing,
      nearPlaneDistance: RING_LAYOUT.nearDistance,
      glassAreaShare: RING_LAYOUT.glassAreaShare,
      frameAreaShare: RING_LAYOUT.frameAreaShare,
      gapAreaShare: RING_LAYOUT.gapAreaShare,
    };
  }

  /**
   * Where ring `index` lives, as a pure function of the index and the current rebase. Nothing
   * accumulates, so a ring is in the same place whether it was walked to or seeked to.
   */
  private localZOf(ringIndex: number): number {
    return this.rebaseOffset - (RING_LAYOUT.nearDistance + ringIndex * RING_LAYOUT.spacing);
  }

  /**
   * Rebase, re-window, republish. Split out of `fixedUpdate` so `advanceTo` reaches the same
   * state without pretending time passed - a seek and a walk MUST leave the field identical,
   * which is why the window below is derived from travel rather than accumulated per step.
   */
  private settle(): void {
    // Rebase first: local z is measured against this offset. Done in one jump so a seek
    // across a kilometre costs the same as a step across a centimetre.
    if (this.rootZ > this.fieldLength) {
      const jumps = Math.floor(this.rootZ / this.fieldLength);
      const delta = jumps * this.fieldLength;
      this.rebaseOffset += delta;
      this.field.rebase(delta);
    }

    // The window of ring indices the camera can see. Slot assignment is `index % ringCount`,
    // so advancing one ring rewrites exactly one slot and a seek rewrites at most all of them.
    const ringCount = this.field.ringCount;
    const firstVisible = Math.max(
      0,
      Math.ceil((this.travel - RING_LAYOUT.nearDistance - RING_LAYOUT.recycleBehind) / RING_LAYOUT.spacing),
    );
    for (let i = 0; i < ringCount; i += 1) {
      const ringIndex = firstVisible + i;
      const slot = ringIndex % ringCount;
      if (this.field.ringIndex(slot) === ringIndex) continue;
      this.field.placeRing(slot, ringIndex, this.localZOf(ringIndex));
    }

    this.publishDepths();
    this.field.commit();
  }

  private publishDepths(): void {
    for (let slot = 0; slot < this.field.ringCount; slot += 1) {
      this.field.setSlotDepth(slot, this.depthOf(slot));
    }
  }
}
