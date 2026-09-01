/**
 * THE THREE PARALLAX TIERS AND THE GPU RIG THAT DRAWS THEM.
 *
 * WHERE THE LAYER LIVES. The battle sits in the slot BETWEEN the near corridor band and the
 * mid band. That placement is the whole design:
 *
 *   camera -> [ near band ] -> [ BATTLE ] -> [ mid band ] -> [ far band ] -> sky
 *
 * Near geometry is therefore in front of the figures and occludes them through the ordinary
 * depth test, and the near glass panes are between the player and a light source that moves -
 * which is the only reason a distant strike reads on the pane in the player's face. Nothing
 * here is composited on top of the frame. `depthTest` stays ON and `depthWrite` stays off:
 * the layer is transparent scene geometry, not an overlay.
 *
 * THE APERTURE MASK IS NOT OPTIONAL. A corridor is a tube with holes in it, and the far end
 * of it is the only window the backdrop is meant to be seen through. Without a mask, figures
 * bleed out past the tube through every gap, ring join and missing pane, they float over near
 * walls wherever the depth buffer has nothing to say, and the composition collapses: three
 * planes of enormous dark shapes with no frame around them turn the image to mush. The mask
 * is a screen-space falloff clamped to the corridor aperture, pushed in by the corridor
 * renderer every frame, and it multiplies alpha to zero outside the window.
 *
 * DEPTH IS NOT WHAT MAKES THE PARALLAX. All three tiers live inside that one thin slot, so
 * they are within metres of each other. The tier hierarchy is a hierarchy of RATES, not of
 * distances - horizon barely moves, fore moves fastest - which is what lets the layer read as
 * kilometres deep while still fitting between two corridor bands.
 *
 * There is no compute path in this file and there is not meant to be one: the whole layer is
 * three instanced quads and a CPU-side pose write, so it costs the same on a machine with no
 * compute support as on one with it.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  FrontSide,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshBasicNodeMaterial,
  NoColorSpace,
  PlaneGeometry,
  RedFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three/webgpu';
import {
  abs,
  clamp,
  cos,
  float,
  instancedBufferAttribute,
  instancedDynamicBufferAttribute,
  length,
  max,
  mix,
  oneMinus,
  saturate,
  screenUV,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
} from 'three/tsl';
import type { Color } from 'three/webgpu';
import type { Disposable } from '../core/types';
import type { LightBusUniforms } from '../universe/LightBus';
import { SILHOUETTE_LAWS } from './Silhouettes';
import type { AtlasCell, SilhouetteAtlas } from './Silhouettes';
import type { ParallaxTier } from './types';
import { PARALLAX_TIERS } from './types';

/**
 * The layer's own art laws. These are composition rules, not per-tier performance budgets -
 * the budget for this layer is `QualityBudget.battleInstanceCaps` and it lives in
 * core/Quality.ts. `battle/types.ts` and `universe/LightBus.ts` split their constants the
 * same way, for the same reason.
 */

/**
 * Combatants are never opaque. At 1.0 they read as cut paper stuck to the sky; at 0.82 the
 * haze in front of them still has a job to do and the figure sits IN the world.
 */
export const SILHOUETTE_OPACITY = 0.82;

/**
 * The rim is the only light a silhouette gets, and it only ever touches the leading edge -
 * the side the blow is travelling towards. Lighting the whole outline would turn every
 * figure into a glowing sticker and destroy the read that these are shapes cut out of the sky.
 */
export const RIM_RESPONSE = Object.freeze({
  /** Present even with the light bus at neutral: an edgeless silhouette reads as a hole. */
  floor: 0.3,
  /** How hard the rim follows a strike. This is the tell that a blow landed. */
  boostGain: 0.42,
  /** Slow component, so the rim breathes with the corridor's own emissive trim. */
  emissiveGain: 0.14,
  /** Step along the leading direction, in cell UV. MUST stay inside the atlas gutter. */
  width: 0.028,
});

export interface TierStaging {
  /** 0 = hard against the near band, 1 = hard against the mid band. Descends horizon->fore. */
  readonly slotFraction: number;
  /** Multiplier on camera-derived parallax. Ascends horizon->fore. */
  readonly driftGain: number;
  /** Autonomous sway, so a tier still lives when the camera flies dead straight. */
  readonly swayHz: number;
  readonly swayFrac: number;
  /** Ceiling on accumulated drift, in backdrop widths. A tableau sways; it never scrolls off. */
  readonly maxDriftFrac: number;
  readonly sizeGain: number;
  readonly opacityScale: number;
  /** Mip bias handed to texture().blur(). Distance is soft. */
  readonly blur: number;
  /** Aerial perspective: how far the ink is lifted towards the haze colour. */
  readonly aerial: number;
  readonly rimGain: number;
  /** Beat deviation amplitude. Clashes and thrown bodies belong on `fore`. */
  readonly deviationGain: number;
  /** False forbids a complete figure on this tier - only ever a crop. */
  readonly wholeBodies: boolean;
  /** Outward shove past the aperture edge, in backdrop widths. Enforces the crop. */
  readonly edgePush: number;
  /** Downward shove, in backdrop heights. Cuts the legs off below frame. */
  readonly footDrop: number;
}

export const TIER_STAGING: Readonly<Record<ParallaxTier, TierStaging>> = Object.freeze({
  // Never a whole body: pushed out to the aperture edge and dropped below the frame line, so
  // what the player sees is a shoulder, a raised arm, a hull - mass implying a body, not one.
  horizon: Object.freeze({
    slotFraction: 0.95,
    driftGain: 0.05,
    swayHz: 0.035,
    swayFrac: 0.012,
    maxDriftFrac: 0.05,
    sizeGain: 0.62,
    opacityScale: 0.55,
    blur: 0.34,
    aerial: 0.62,
    rimGain: 0.3,
    deviationGain: 0.15,
    wholeBodies: false,
    edgePush: 0.62,
    footDrop: 0.24,
  }),
  mid: Object.freeze({
    slotFraction: 0.58,
    driftGain: 0.34,
    swayHz: 0.07,
    swayFrac: 0.02,
    maxDriftFrac: 0.12,
    sizeGain: 1.0,
    opacityScale: 0.92,
    blur: 0.06,
    aerial: 0.18,
    rimGain: 1.0,
    deviationGain: 0.55,
    wholeBodies: true,
    edgePush: 0,
    footDrop: 0,
  }),
  // The loud tier: biggest, fastest, biggest beat deviation, so this is where clashes and
  // thrown bodies read. TODO(step-2): projectile lines want their own SilhouetteId - the
  // union is owned by battle/types.ts, so the shape vocabulary has to grow there first.
  fore: Object.freeze({
    slotFraction: 0.14,
    driftGain: 1.0,
    swayHz: 0.13,
    swayFrac: 0.03,
    maxDriftFrac: 0.22,
    sizeGain: 1.85,
    opacityScale: 1.0,
    blur: 0.0,
    aerial: 0.0,
    rimGain: 1.35,
    deviationGain: 1.0,
    wholeBodies: true,
    edgePush: 0,
    footDrop: 0,
  }),
});

/** The slot the corridor leaves for the layer, in world units ahead of the camera. */
export interface CorridorSlot {
  readonly nearBandEnd: number;
  readonly midBandStart: number;
}

/**
 * Used until the corridor renderer calls `setSlot`. It exists so the layer boots and renders
 * standalone in a test harness; it is not an authority on where the bands actually are.
 */
export const FALLBACK_CORRIDOR_SLOT: CorridorSlot = Object.freeze({
  nearBandEnd: 16,
  midBandStart: 44,
});

/** Fraction of the slot kept clear at each end so a tier never z-fights a band plane. */
const SLOT_MARGIN = 0.06;

/**
 * Distance from the camera for one tier, guaranteed to land strictly inside the slot. Feeding
 * a collapsed or inverted slot produces the slot's midpoint rather than geometry behind the
 * mid band, because a battle that pops in front of the near wall is worse than a flat one.
 */
export function resolveSlotDistance(tier: ParallaxTier, slot: CorridorSlot): number {
  const span = slot.midBandStart - slot.nearBandEnd;
  if (!(span > 0)) return (slot.nearBandEnd + slot.midBandStart) * 0.5;
  const lo = slot.nearBandEnd + span * SLOT_MARGIN;
  const hi = slot.midBandStart - span * SLOT_MARGIN;
  return lo + (hi - lo) * TIER_STAGING[tier].slotFraction;
}

/** Returns every violation found; empty array means the staging table is legal. */
export function validateTierStaging(): string[] {
  const violations: string[] = [];
  let previous: TierStaging | null = null;

  for (const tier of PARALLAX_TIERS) {
    const s = TIER_STAGING[tier];
    const where = `tier "${tier}"`;

    if (!(s.slotFraction >= 0 && s.slotFraction <= 1)) {
      violations.push(`sanity: ${where} slotFraction ${s.slotFraction} must be in [0,1]`);
    }
    if (SILHOUETTE_OPACITY * s.opacityScale > 1) {
      violations.push(`law: ${where} would render above full opacity - silhouettes are never solid`);
    }
    if (!s.wholeBodies && !(s.edgePush > 0 || s.footDrop > 0)) {
      violations.push(
        `law: ${where} forbids whole bodies but pushes nothing past the frame, so it will show one`,
      );
    }
    if (s.wholeBodies && (s.edgePush !== 0 || s.footDrop !== 0)) {
      violations.push(`sanity: ${where} allows whole bodies yet crops them anyway`);
    }

    if (previous !== null) {
      // The rate hierarchy IS the depth illusion. Break the ordering and the backdrop reads
      // as one flat plane sliding about, which is exactly the failure this layer exists to avoid.
      if (!(s.driftGain > previous.driftGain)) {
        violations.push(`law: ${where} driftGain ${s.driftGain} must exceed the tier behind it`);
      }
      if (!(s.slotFraction < previous.slotFraction)) {
        violations.push(`law: ${where} must sit nearer the camera than the tier behind it`);
      }
      if (!(s.sizeGain > previous.sizeGain)) {
        violations.push(`law: ${where} sizeGain ${s.sizeGain} must exceed the tier behind it`);
      }
      if (s.blur > previous.blur) {
        violations.push(`law: ${where} blur ${s.blur} must not exceed the tier behind it`);
      }
      if (s.aerial > previous.aerial) {
        violations.push(`law: ${where} aerial ${s.aerial} must not exceed the tier behind it`);
      }
    }
    previous = s;
  }

  if (RIM_RESPONSE.width <= 0) {
    violations.push('sanity: RIM_RESPONSE.width must be > 0 or no figure has a lit edge');
  }
  // The rim fetch steps outside the figure by design. If that step can clear the atlas gutter
  // it lands in the next cell and every figure grows a rim made of its neighbour's shoulder.
  const rimReachPx = RIM_RESPONSE.width * SILHOUETTE_LAWS.cellPx;
  if (rimReachPx >= SILHOUETTE_LAWS.gutterPx) {
    violations.push(
      `law: RIM_RESPONSE.width reaches ${rimReachPx.toFixed(1)}px, past the ` +
        `${SILHOUETTE_LAWS.gutterPx}px atlas gutter - the rim would sample the next figure`,
    );
  }
  return violations;
}

/* ------------------------------------------------------------------ shared uniforms ----- */

const buildUniforms = () => ({
  /** Aperture centre in screen UV. Pushed in by the corridor renderer. */
  apertureCenter: uniform(new Vector2(0.5, 0.5)).setName('battleApertureCenter'),
  apertureHalf: uniform(new Vector2(0.5, 0.5)).setName('battleApertureHalf'),
  /** Width of the falloff at the aperture edge, as a fraction of the half extent. */
  apertureFeather: uniform(0.22).setName('battleApertureFeather'),
  /** 0 = rectangular aperture, 1 = elliptical. Corridors are somewhere between. */
  apertureRound: uniform(0.45).setName('battleApertureRound'),
  /** Near-black. Not pure black: a true 0 kills the tone curve's shadow roll-off. */
  inkColor: uniform(new Vector3(0.012, 0.013, 0.018)).setName('battleInk'),
  rimColor: uniform(new Vector3(1, 0.86, 0.62)).setName('battleRim'),
  /** What distance lifts the ink towards. Normally the theme's haze colour. */
  hazeColor: uniform(new Vector3(0.06, 0.07, 0.09)).setName('battleHaze'),
});

/**
 * Unlike `LightBusUniforms` - which is deliberately typed read-only so materials cannot write
 * to the bus - these are the battle layer's OWN material inputs. The layer writes them; the
 * only other writer is the corridor renderer pushing an aperture, through `setAperture`.
 */
export type BattleUniforms = Readonly<ReturnType<typeof buildUniforms>>;

export const createBattleUniforms = (): BattleUniforms => buildUniforms();

const copyColor = (target: Vector3, source: Color): void => {
  target.set(source.r, source.g, source.b);
};

export function applyBattlePalette(
  uniforms: BattleUniforms,
  palette: { readonly ink: Color; readonly rim: Color; readonly haze: Color },
): void {
  copyColor(uniforms.inkColor.value, palette.ink);
  copyColor(uniforms.rimColor.value, palette.rim);
  copyColor(uniforms.hazeColor.value, palette.haze);
}

/**
 * Kept out of Silhouettes.ts on purpose: that module is pure geometry and maths with no
 * three.js import at all, which is what lets `tools/silhouettes.mjs` run the 40-pixel test
 * in plain node without a GPU or a renderer.
 */
export function createAtlasTexture(atlas: SilhouetteAtlas): DataTexture {
  const texture2d = new DataTexture(
    atlas.data,
    atlas.width,
    atlas.height,
    RedFormat,
    UnsignedByteType,
  );
  // Coverage is a mask, not a colour: decoding it through sRGB would eat the soft edge the
  // supersampled rasteriser worked to produce.
  texture2d.colorSpace = NoColorSpace;
  texture2d.wrapS = ClampToEdgeWrapping;
  texture2d.wrapT = ClampToEdgeWrapping;
  texture2d.magFilter = LinearFilter;
  // Mipmaps exist for one reason: texture().blur() on the horizon tier needs levels to read.
  texture2d.minFilter = LinearMipmapLinearFilter;
  texture2d.generateMipmaps = true;
  texture2d.needsUpdate = true;
  return texture2d;
}

/* ------------------------------------------------------------------ the rig ------------- */

export interface TierRigOptions {
  readonly tier: ParallaxTier;
  /** From `QualityBudget.battleInstanceCaps`. The pool is allocated full at construction. */
  readonly capacity: number;
  readonly atlas: DataTexture;
  readonly uniforms: BattleUniforms;
  /** Read, never written. The rim brightens with the same strike the corridor feels. */
  readonly light: LightBusUniforms;
  readonly renderOrder: number;
}

/** Per-instance floats. Two vec4s is the whole per-figure state the shader needs. */
const CELL_STRIDE = 4;
const STATE_STRIDE = 4;

/**
 * ONE InstancedMesh per tier, and nothing else in the tier's subtree. That is what holds the
 * whole layer to three draw calls; `BattleLayer.assertDrawCallBudget()` checks it rather than
 * trusting this comment.
 */
export class ParallaxTierRig implements Disposable {
  readonly tier: ParallaxTier;
  readonly mesh: InstancedMesh;

  private readonly geometry: PlaneGeometry;
  private readonly material: MeshBasicNodeMaterial;
  private readonly cellData: Float32Array;
  private readonly stateData: Float32Array;
  private readonly cellAttribute: InstancedBufferAttribute;
  private readonly stateAttribute: InstancedBufferAttribute;
  private readonly scratch = new Matrix4();
  private live = 0;

  constructor(options: TierRigOptions) {
    const staging = TIER_STAGING[options.tier];
    this.tier = options.tier;

    this.cellData = new Float32Array(options.capacity * CELL_STRIDE);
    this.stateData = new Float32Array(options.capacity * STATE_STRIDE);
    this.cellAttribute = new InstancedBufferAttribute(this.cellData, CELL_STRIDE);
    this.stateAttribute = new InstancedBufferAttribute(this.stateData, STATE_STRIDE);

    const cell = instancedBufferAttribute<'vec4'>(this.cellAttribute, 'vec4');
    const state = instancedDynamicBufferAttribute<'vec4'>(this.stateAttribute, 'vec4');

    const cellUv = uv().mul(cell.zw).add(cell.xy);
    // Only the tiers that actually want distance-softening pay for a mip bias node.
    const sharp = texture(options.atlas, cellUv);
    const coverage = (staging.blur > 0 ? sharp.blur(float(staging.blur)) : sharp).r;

    // Leading-edge rim. Sampling one step ALONG the blow direction and keeping the pixels that
    // are inside now but outside there leaves exactly the strip facing the blow - no normals,
    // no second texture, and it costs one extra fetch. Clamped to the cell because the step
    // would otherwise walk into the neighbouring figure's ink.
    const lead = vec2(cos(state.y), sin(state.y)).mul(float(RIM_RESPONSE.width)).mul(cell.zw);
    const ahead = texture(options.atlas, clamp(cellUv.add(lead), cell.xy, cell.xy.add(cell.zw))).r;
    const rimStrength = float(RIM_RESPONSE.floor)
      .add(options.light.rimBoost.mul(float(RIM_RESPONSE.boostGain)))
      .add(options.light.emisIntensity.mul(float(RIM_RESPONSE.emissiveGain)));
    const rim = saturate(coverage.mul(oneMinus(ahead)).mul(state.z).mul(rimStrength));

    // Aperture mask. The single most load-bearing term in this shader - see the file header.
    const p = screenUV.sub(options.uniforms.apertureCenter).div(options.uniforms.apertureHalf);
    const q = abs(p);
    const distance = mix(max(q.x, q.y), length(q), options.uniforms.apertureRound);
    const aperture = oneMinus(
      smoothstep(oneMinus(options.uniforms.apertureFeather), float(1), distance),
    );

    const ink = mix(options.uniforms.inkColor, options.uniforms.hazeColor, float(staging.aerial));

    this.material = new MeshBasicNodeMaterial();
    this.material.colorNode = mix(ink, options.uniforms.rimColor, rim);
    this.material.opacityNode = coverage
      .mul(float(SILHOUETTE_OPACITY * staging.opacityScale))
      .mul(state.x)
      .mul(aperture);
    this.material.transparent = true;
    // Depth TEST on: the near band must be able to hide a figure, and that occlusion is the
    // reason the layer sits in the slot at all. Depth WRITE off: it is transparent, and a
    // silhouette must never punch a hole in anything drawn after it.
    this.material.depthTest = true;
    this.material.depthWrite = false;
    this.material.side = FrontSide;
    // It is scene geometry standing in the corridor's atmosphere, so it takes the fog. A
    // backdrop exempt from fog is the classic tell that something is pasted over the frame.
    this.material.fog = true;

    this.geometry = new PlaneGeometry(1, 1);
    this.mesh = new InstancedMesh(this.geometry, this.material, options.capacity);
    this.mesh.name = `battle-tier-${options.tier}`;
    this.mesh.renderOrder = options.renderOrder;
    // The rig is re-anchored to the camera every frame, so a culler working from a stale
    // bounding sphere would drop the whole tier. Skipping the test also guarantees one draw.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  get capacity(): number {
    return this.cellData.length / CELL_STRIDE;
  }

  /** Assigned once when the cast is staged; the atlas cell never changes for a figure. */
  setFigure(index: number, cell: AtlasCell): void {
    const o = index * CELL_STRIDE;
    this.cellData[o] = cell.u0;
    this.cellData[o + 1] = cell.v0;
    this.cellData[o + 2] = cell.du;
    this.cellData[o + 3] = cell.dv;
    this.cellAttribute.needsUpdate = true;
  }

  setAppearance(index: number, opacity: number, leadingAngle: number, rimGain: number): void {
    const o = index * STATE_STRIDE;
    this.stateData[o] = opacity;
    this.stateData[o + 1] = leadingAngle;
    this.stateData[o + 2] = rimGain;
  }

  /**
   * Position is rig-local: x/y across the backdrop plane, z always 0 because the whole tier
   * is one plane. `size` is the side of the square quad in world units.
   */
  setPose(index: number, x: number, y: number, size: number, roll: number): void {
    const c = Math.cos(roll) * size;
    const s = Math.sin(roll) * size;
    // Written straight into the matrix rather than through compose(): a Z-roll with a uniform
    // scale has a closed form, and this runs for every figure on every frame.
    this.scratch.set(c, -s, 0, x, s, c, 0, y, 0, 0, size, 0, 0, 0, 0, 1);
    this.mesh.setMatrixAt(index, this.scratch);
  }

  /** Publishes the frame's writes. `count` may be below capacity; the pool stays allocated. */
  commit(count: number): void {
    this.live = Math.min(count, this.capacity);
    this.mesh.count = this.live;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.stateAttribute.needsUpdate = true;
  }

  get liveCount(): number {
    return this.live;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
