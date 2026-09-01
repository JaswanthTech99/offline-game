/**
 * THE RING FIELD.
 *
 * A corridor is a queue of rings receding to the vanishing point. Each ring is a rectangular
 * annulus of glass panes with a hole in the middle, braced by struts and lit by two emitters
 * at the opening's corners. Rings are never created or destroyed at runtime: the field is
 * allocated once at its Quality-tier size, and a ring that falls behind the camera is
 * recycled to the far end with new, seeded, reproducible content.
 *
 * THREE DRAW CALLS, THREE MEANINGS:
 *
 *   glassMesh   \  inside `attenuation`, so SITES 1 and 3 of the exposure histogram apply
 *   frameMesh   /  through one shared opacity graph they cannot opt out of
 *   emitterMesh    a SIBLING of `attenuation`, never a child - SITE 4, the exemption
 *
 * That parentage is the enforcement. An emissive cannot be accidentally attenuated because
 * the attenuation lives in a material that the emitter mesh does not use, and
 * `exposureGraph()` reports what was actually built so the audit checks reality.
 *
 * The per-ring group opacity travels as ONE float per instance (`ringDepth`), written once
 * per fixed step. Per-ring, not per-fragment: the corridor should step down ring by ring,
 * which reads as structure. Per-fragment falloff is fog, and fog is what went milky.
 *
 * NUMBERS: the ring COUNT is a performance budget and comes from core/Quality.ts. Everything
 * below is the corridor's geometric vocabulary - the same shape on a phone and on a 4K
 * desktop - and so lives with the thing it describes, exactly as battle/types.ts keeps its
 * dramaturgy laws and universe/LightBus.ts keeps its channel domains.
 */

import {
  BoxGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import type { BufferGeometry, Material, Node, NodeMaterial, Object3D } from 'three/webgpu';
import { color, float } from 'three/tsl';
// The corridor is explicitly named in the Rng contract as a consumer: one seeded stream for
// the whole game is what makes a run reproducible from its seed alone.
import type { Rng } from '../battle/types';
import { createRng } from '../battle/types';
import type { PostIntensity } from '../core/Quality';
import type { Disposable, Seed, Unit } from '../core/types';
import type { UniverseTheme } from '../universe/UniverseTheme';
import type { EdgeSplit, ExposureChannel, ExposureGraph } from './Exposure';
import {
  RING_DEPTH_ATTRIBUTE,
  attenuatedOpacityNode,
  emissiveGainNode,
} from './Exposure';

/**
 * `openingScale*` bound the hole the player flies through: too tight and the run is a tunnel
 * of near-misses, too loose and there is nothing to smash. `centrePaneChance` is what makes a
 * ring a wall instead of a window, and is the game's core beat.
 */
export const RING_LAYOUT = Object.freeze({
  spacing: 6.0,
  nearDistance: 4.0,
  halfWidth: 3.2,
  halfHeight: 2.3,
  panesPerSide: 3,
  openingScaleMin: 0.38,
  openingScaleMax: 0.62,
  centrePaneChance: 0.45,
  paneGapChance: 0.16,
  paneInsetJitter: 0.06,
  paneZJitter: 0.09,
  paneThickness: 0.05,
  strutThickness: 0.14,
  strutDepth: 0.22,
  emitterSize: 0.19,
  emitterSizeJitter: 0.06,
  /** Metres a ring may drift behind the camera before it is recycled to the far end. */
  recycleBehind: 2.5,
  /** Share of a ring's projected area that is glass, structure and open gap. Sums below 1. */
  glassAreaShare: 0.62,
  frameAreaShare: 0.3,
  gapAreaShare: 0.06,
});

export const PANES_PER_RING = RING_LAYOUT.panesPerSide * 4 + 1;
export const STRUTS_PER_RING = 4;
export const EMITTERS_PER_RING = 2;

/** Index of the pane that blocks the opening. The one the player must break to pass. */
export const CENTRE_PANE_INDEX = PANES_PER_RING - 1;

/**
 * Placeholder look values for the stand-in materials below. Real glass - transmission,
 * fracture-line edge glow, refraction - belongs to the materials agent.
 *
 * TODO(step-2): the materials agent replaces `createStandInRingMaterials` with the hero glass
 * material set and deletes this table; the RingMaterials seam and the exposure wiring in
 * RingField stay exactly as they are.
 */
const STAND_IN_LOOK = Object.freeze({
  glassRoughness: 0.08,
  glassMetalness: 0.0,
  frameRoughness: 0.42,
  frameMetalness: 0.85,
  emitterBase: 1.0,
});

/**
 * One drawable channel of a ring plus the opacity it wants BEFORE exposure. RingField takes
 * `baseOpacity` and decides what happens to it - a material supplier does not get to choose
 * whether the histogram applies to it.
 */
export interface RingChannelMaterial {
  readonly material: NodeMaterial;
  readonly baseOpacity: Node<'float'>;
}

export interface RingMaterials {
  readonly frame: RingChannelMaterial;
  readonly glass: RingChannelMaterial;
  /** Emissive. Exempt from SITES 1 and 3 - see Exposure.ts. */
  readonly emissive: RingChannelMaterial;
}

export interface RingMaterialRequest {
  readonly theme: UniverseTheme;
  readonly post: PostIntensity;
  /** SITE 3's split, already resolved against the tier's post chain. */
  readonly edge: EdgeSplit;
}

export type RingMaterialFactory = (request: RingMaterialRequest) => RingMaterials;

/**
 * Runnable stand-in material set. Real node materials, correct blending, correct exemption -
 * a skeleton that renders, not an empty function.
 */
export function createStandInRingMaterials(request: RingMaterialRequest): RingMaterials {
  const { theme } = request;

  const glass = new MeshStandardNodeMaterial({
    color: theme.glass.tint.clone(),
    roughness: STAND_IN_LOOK.glassRoughness,
    metalness: STAND_IN_LOOK.glassMetalness,
    transparent: true,
    side: DoubleSide,
    // Instances inside one InstancedMesh cannot be depth-sorted, so panes must not write
    // depth or a near ring would reject every ring behind it. Attenuation keeps the error
    // small: by the time blend order could be noticed, the far rings are nearly gone.
    depthWrite: false,
  });

  const frame = new MeshStandardNodeMaterial({
    color: theme.metal.clone(),
    roughness: STAND_IN_LOOK.frameRoughness,
    metalness: STAND_IN_LOOK.frameMetalness,
    transparent: true,
  });

  // Unlit and untone-mapped: emitters are the only surfaces in the corridor permitted to
  // reach full white, and tone mapping would pull them back into the midtones with everything
  // else - which is the milky failure, arriving by a different door.
  const emissive = new MeshBasicNodeMaterial({ color: theme.emissive.primary.clone() });
  emissive.toneMapped = false;
  emissive.colorNode = color(theme.emissive.primary.clone()).mul(
    emissiveGainNode(float(STAND_IN_LOOK.emitterBase)),
  );

  return {
    glass: { material: glass, baseOpacity: float(theme.glass.alpha) },
    frame: { material: frame, baseOpacity: float(1) },
    emissive: { material: emissive, baseOpacity: float(1) },
  };
}

export interface RingFieldOptions {
  /** From core/Quality.ts: QUALITY[tier].corridorRings. Never a literal. */
  readonly ringCount: number;
  readonly seed: Seed;
  readonly theme: UniverseTheme;
  readonly post: PostIntensity;
  readonly edge: EdgeSplit;
  /** Defaults to `createStandInRingMaterials`. */
  readonly materials?: RingMaterialFactory;
}

/**
 * A crystal as the pickup system needs to see it: where it is and how big its trigger is.
 *
 * Both visitor records below are REUSED between visits, which is why they are handed out
 * readonly. Copy anything you intend to keep past the callback.
 */
interface MutableCrystalNode {
  ringIndex: number;
  slot: number;
  emitter: number;
  centre: Vector3;
  radius: number;
}
export type CrystalNode = Readonly<MutableCrystalNode>;

/** A pane as the physics and shatter systems need to see it. Field-local, camera at origin. */
interface MutablePaneQuad {
  ringIndex: number;
  slot: number;
  pane: number;
  centre: Vector3;
  halfWidth: number;
  halfHeight: number;
  /** True for the pane that blocks the opening; false for the panes framing it. */
  blocking: boolean;
}
export type PaneQuad = Readonly<MutablePaneQuad>;

const scratchMatrix = new Matrix4();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const scratchQuaternion = new Quaternion();
const scratchEuler = new Euler();
const IDENTITY_QUATERNION = new Quaternion();
const ZERO_SCALE = new Vector3(0, 0, 0);

/**
 * The pool. Allocated once, never resized, never garbage. A retired pane is a zero-scale
 * instance, not a removed object.
 */
export class RingField implements Disposable {
  readonly root = new Group();
  /** Everything under here is subject to SITES 1 and 3. */
  readonly attenuation = new Group();
  /** Sibling of `attenuation`, and that is the entire point. SITE 4. */
  readonly emitters = new Group();

  readonly ringCount: number;

  readonly glassMesh: InstancedMesh<BufferGeometry, Material>;
  readonly frameMesh: InstancedMesh<BufferGeometry, Material>;
  readonly emitterMesh: InstancedMesh<BufferGeometry, Material>;

  private readonly rng: Rng;
  private readonly materials: RingMaterials;
  private readonly ownsMaterials: boolean;

  private readonly paneGeometry: PlaneGeometry;
  private readonly strutGeometry: BoxGeometry;
  private readonly emitterGeometry: OctahedronGeometry;

  private readonly glassDepth: Float32Array;
  private readonly frameDepth: Float32Array;
  private readonly glassDepthAttribute: InstancedBufferAttribute;
  private readonly frameDepthAttribute: InstancedBufferAttribute;

  /** Absolute ring index per slot. Content is a pure function of this, so recycling is stable. */
  private readonly slotRing: Int32Array;
  private readonly slotLocalZ: Float64Array;
  private readonly paneAlive: Uint8Array;
  /** Half extents and local centre of every pane, kept for collision without matrix decode. */
  private readonly paneBounds: Float32Array;
  /** Local centre and radius of every crystal, for the same reason. */
  private readonly crystalBounds: Float32Array;

  private readonly paneScratch: MutablePaneQuad = {
    ringIndex: 0,
    slot: 0,
    pane: 0,
    centre: new Vector3(),
    halfWidth: 0,
    halfHeight: 0,
    blocking: false,
  };

  private readonly crystalScratch: MutableCrystalNode = {
    ringIndex: 0,
    slot: 0,
    emitter: 0,
    centre: new Vector3(),
    radius: 0,
  };

  private matricesDirty = true;
  private depthDirty = true;

  constructor(options: RingFieldOptions) {
    this.ringCount = Math.max(1, Math.floor(options.ringCount));
    this.rng = createRng(options.seed);

    const factory = options.materials ?? createStandInRingMaterials;
    this.ownsMaterials = options.materials === undefined;
    this.materials = factory({ theme: options.theme, post: options.post, edge: options.edge });

    // SITES 1 + 3, applied here rather than in the factory so that no material supplier can
    // ship a corridor surface that escapes the histogram.
    this.materials.glass.material.opacityNode = attenuatedOpacityNode(
      this.materials.glass.baseOpacity,
      options.edge,
    );
    this.materials.frame.material.opacityNode = attenuatedOpacityNode(
      this.materials.frame.baseOpacity,
      options.edge,
    );
    // SITE 4: the emissive opacity graph is handed through untouched. No depth attenuation,
    // no scene edge term - only the post vignette ever reaches it.
    this.materials.emissive.material.opacityNode = this.materials.emissive.baseOpacity;

    this.paneGeometry = new PlaneGeometry(1, 1);
    this.strutGeometry = new BoxGeometry(1, 1, 1);
    this.emitterGeometry = new OctahedronGeometry(0.5, 0);

    const glassCount = this.ringCount * PANES_PER_RING;
    const frameCount = this.ringCount * STRUTS_PER_RING;
    const emitterCount = this.ringCount * EMITTERS_PER_RING;

    this.glassDepth = new Float32Array(glassCount);
    this.frameDepth = new Float32Array(frameCount);
    this.glassDepthAttribute = new InstancedBufferAttribute(this.glassDepth, 1);
    this.frameDepthAttribute = new InstancedBufferAttribute(this.frameDepth, 1);
    this.glassDepthAttribute.setUsage(DynamicDrawUsage);
    this.frameDepthAttribute.setUsage(DynamicDrawUsage);
    this.paneGeometry.setAttribute(RING_DEPTH_ATTRIBUTE, this.glassDepthAttribute);
    this.strutGeometry.setAttribute(RING_DEPTH_ATTRIBUTE, this.frameDepthAttribute);

    this.glassMesh = new InstancedMesh<BufferGeometry, Material>(
      this.paneGeometry,
      this.materials.glass.material,
      glassCount,
    );
    this.frameMesh = new InstancedMesh<BufferGeometry, Material>(
      this.strutGeometry,
      this.materials.frame.material,
      frameCount,
    );
    this.emitterMesh = new InstancedMesh<BufferGeometry, Material>(
      this.emitterGeometry,
      this.materials.emissive.material,
      emitterCount,
    );

    for (const mesh of [this.glassMesh, this.frameMesh, this.emitterMesh]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // Instances are rewritten in place every recycle, so the cached bounding sphere is
      // always stale. The field is in front of the camera by construction.
      mesh.frustumCulled = false;
    }
    this.frameMesh.castShadow = true;
    this.frameMesh.receiveShadow = true;
    this.glassMesh.receiveShadow = true;
    // Structure first, then glass over it: the only ordering an instanced field can control.
    this.frameMesh.renderOrder = 0;
    this.glassMesh.renderOrder = 1;
    this.emitterMesh.renderOrder = 2;

    this.attenuation.add(this.frameMesh, this.glassMesh);
    this.emitters.add(this.emitterMesh);
    this.root.add(this.attenuation, this.emitters);

    this.slotRing = new Int32Array(this.ringCount);
    this.slotLocalZ = new Float64Array(this.ringCount);
    this.paneAlive = new Uint8Array(glassCount);
    this.paneBounds = new Float32Array(glassCount * 4);
    this.crystalBounds = new Float32Array(emitterCount * 4);

    // Pre-warm: every instance written before frame one, so the first recycle costs the same
    // as the thousandth and nothing allocates mid-run. The layout here is the one the
    // corridor's own placement rule produces at travel 0, so construction settles to a no-op.
    for (let slot = 0; slot < this.ringCount; slot += 1) {
      this.buildRing(slot, slot, -(RING_LAYOUT.nearDistance + slot * RING_LAYOUT.spacing));
    }
    this.commit();
  }

  /** What was actually built, for `Exposure.auditExposureGraph`. Not a claim - a report. */
  exposureGraph(): ExposureGraph {
    const attenuated: ExposureChannel[] = [];
    if (this.frameMesh.parent === this.attenuation) attenuated.push('frame');
    if (this.glassMesh.parent === this.attenuation) attenuated.push('glass');

    const exempt: ExposureChannel[] = [];
    if (this.emitterMesh.parent !== null && !isDescendantOf(this.emitterMesh, this.attenuation)) {
      exempt.push('crystal');
    }
    return { attenuated, exempt };
  }

  /** Local z of the slot's ring. Negative is ahead of the camera. */
  localZ(slot: number): number {
    return this.slotLocalZ[slot] ?? 0;
  }

  ringIndex(slot: number): number {
    return this.slotRing[slot] ?? 0;
  }

  /**
   * Fills a slot with a specific ABSOLUTE ring index at a specific local z. The field does not
   * decide which ring goes where - the corridor does, from travel - which is what lets a seek
   * and a thousand fixed steps to the same distance produce a bit-identical field.
   */
  placeRing(slot: number, ringIndex: number, localZ: number): void {
    this.buildRing(slot, ringIndex, localZ);
  }

  /** SITE 1's payload: one group opacity depth for every instance of the ring. */
  setSlotDepth(slot: number, depth01: Unit): void {
    const clamped = depth01 < 0 ? 0 : depth01 > 1 ? 1 : depth01;
    const glassBase = slot * PANES_PER_RING;
    for (let i = 0; i < PANES_PER_RING; i += 1) this.glassDepth[glassBase + i] = clamped;
    const frameBase = slot * STRUTS_PER_RING;
    for (let i = 0; i < STRUTS_PER_RING; i += 1) this.frameDepth[frameBase + i] = clamped;
    this.depthDirty = true;
  }

  /**
   * Slides every instance along z. Called when the field's local origin is rebased so world
   * coordinates never grow without bound; touches the translation slot of each matrix only.
   */
  rebase(deltaZ: number): void {
    for (let slot = 0; slot < this.ringCount; slot += 1) {
      this.slotLocalZ[slot] = (this.slotLocalZ[slot] ?? 0) + deltaZ;
    }
    for (const mesh of [this.glassMesh, this.frameMesh, this.emitterMesh]) {
      const array = mesh.instanceMatrix.array;
      for (let offset = 14; offset < array.length; offset += 16) {
        array[offset] = (array[offset] ?? 0) + deltaZ;
      }
    }
    // The cached crystal centres are the pickup system's only source of truth for z, so they
    // rebase with the matrices or a pickup trigger ends up a field-length out of position.
    for (let i = 2; i < this.crystalBounds.length; i += 4) {
      this.crystalBounds[i] = (this.crystalBounds[i] ?? 0) + deltaZ;
    }
    this.matricesDirty = true;
  }

  isPaneAlive(slot: number, pane: number): boolean {
    return (this.paneAlive[slot * PANES_PER_RING + pane] ?? 0) === 1;
  }

  /** Shattered. The instance stays in the pool at zero scale; nothing is freed. */
  retirePane(slot: number, pane: number): void {
    const index = slot * PANES_PER_RING + pane;
    if ((this.paneAlive[index] ?? 0) === 0) return;
    this.paneAlive[index] = 0;
    scratchMatrix.compose(scratchPosition.set(0, 0, 0), IDENTITY_QUATERNION, ZERO_SCALE);
    this.glassMesh.setMatrixAt(index, scratchMatrix);
    this.matricesDirty = true;
  }

  /**
   * Every pane still standing, in the field's local space. The caller adds `root.position` to
   * reach world space - the corridor only ever translates along z. The record handed to
   * `visit` is reused on every call: this runs against every pane every step, and allocating
   * three hundred vectors a frame to describe geometry that already exists is not a budget
   * the shatter sim can afford.
   */
  forEachLivePane(visit: (quad: PaneQuad) => void): void {
    const out = this.paneScratch;
    for (let slot = 0; slot < this.ringCount; slot += 1) {
      for (let pane = 0; pane < PANES_PER_RING; pane += 1) {
        const index = slot * PANES_PER_RING + pane;
        if ((this.paneAlive[index] ?? 0) === 0) continue;
        const base = index * 4;
        out.ringIndex = this.slotRing[slot] ?? 0;
        out.slot = slot;
        out.pane = pane;
        out.centre.set(
          this.paneBounds[base] ?? 0,
          this.paneBounds[base + 1] ?? 0,
          this.slotLocalZ[slot] ?? 0,
        );
        out.halfWidth = this.paneBounds[base + 2] ?? 0;
        out.halfHeight = this.paneBounds[base + 3] ?? 0;
        out.blocking = pane === CENTRE_PANE_INDEX;
        visit(out);
      }
    }
  }

  /**
   * Every crystal in the field, in the field's local space. Crystals are emissive and so are
   * never attenuated, but they still move with the corridor - the pickup system needs both.
   */
  forEachCrystal(visit: (crystal: CrystalNode) => void): void {
    const out = this.crystalScratch;
    for (let slot = 0; slot < this.ringCount; slot += 1) {
      for (let emitter = 0; emitter < EMITTERS_PER_RING; emitter += 1) {
        const base = (slot * EMITTERS_PER_RING + emitter) * 4;
        out.ringIndex = this.slotRing[slot] ?? 0;
        out.slot = slot;
        out.emitter = emitter;
        out.centre.set(
          this.crystalBounds[base] ?? 0,
          this.crystalBounds[base + 1] ?? 0,
          this.crystalBounds[base + 2] ?? 0,
        );
        out.radius = this.crystalBounds[base + 3] ?? 0;
        visit(out);
      }
    }
  }

  /** Uploads whatever changed this step. Called once per fixed step, never per pane. */
  commit(): void {
    if (this.matricesDirty) {
      this.glassMesh.instanceMatrix.needsUpdate = true;
      this.frameMesh.instanceMatrix.needsUpdate = true;
      this.emitterMesh.instanceMatrix.needsUpdate = true;
      this.matricesDirty = false;
    }
    if (this.depthDirty) {
      this.glassDepthAttribute.needsUpdate = true;
      this.frameDepthAttribute.needsUpdate = true;
      this.depthDirty = false;
    }
  }

  dispose(): void {
    this.paneGeometry.dispose();
    this.strutGeometry.dispose();
    this.emitterGeometry.dispose();
    this.glassMesh.dispose();
    this.frameMesh.dispose();
    this.emitterMesh.dispose();
    // Only dispose what this field created. An injected material set outlives the corridor.
    if (this.ownsMaterials) {
      this.materials.glass.material.dispose();
      this.materials.frame.material.dispose();
      this.materials.emissive.material.dispose();
    }
    this.root.clear();
    this.attenuation.clear();
    this.emitters.clear();
  }

  /**
   * Content is a pure function of the ABSOLUTE ring index, drawn from a fork of the run seed.
   * Two players on the same seed see the same ring at the same distance no matter how their
   * frame rates or recycle timings differed on the way there.
   */
  private buildRing(slot: number, ringIndex: number, localZ: number): void {
    const rng = this.rng.fork(ringIndex);
    this.slotRing[slot] = ringIndex;
    this.slotLocalZ[slot] = localZ;

    const openHalfWidth =
      RING_LAYOUT.halfWidth * rng.range(RING_LAYOUT.openingScaleMin, RING_LAYOUT.openingScaleMax);
    const openHalfHeight =
      RING_LAYOUT.halfHeight * rng.range(RING_LAYOUT.openingScaleMin, RING_LAYOUT.openingScaleMax);

    const bandHeight = RING_LAYOUT.halfHeight - openHalfHeight;
    const bandWidth = RING_LAYOUT.halfWidth - openHalfWidth;
    const columnWidth = (RING_LAYOUT.halfWidth * 2) / RING_LAYOUT.panesPerSide;
    const rowHeight = (openHalfHeight * 2) / RING_LAYOUT.panesPerSide;

    let pane = 0;
    // Top and bottom bands run the full width so the corner joints are covered by one pane
    // rather than meeting in a seam the player can see through.
    for (const sign of [1, -1]) {
      const centreY = sign * (openHalfHeight + bandHeight * 0.5);
      for (let column = 0; column < RING_LAYOUT.panesPerSide; column += 1) {
        const centreX = -RING_LAYOUT.halfWidth + columnWidth * (column + 0.5);
        this.placePane(slot, pane, rng, localZ, centreX, centreY, columnWidth * 0.5, bandHeight * 0.5);
        pane += 1;
      }
    }
    for (const sign of [-1, 1]) {
      const centreX = sign * (openHalfWidth + bandWidth * 0.5);
      for (let row = 0; row < RING_LAYOUT.panesPerSide; row += 1) {
        const centreY = -openHalfHeight + rowHeight * (row + 0.5);
        this.placePane(slot, pane, rng, localZ, centreX, centreY, bandWidth * 0.5, rowHeight * 0.5);
        pane += 1;
      }
    }

    // The blocking pane. Its absence is a ring you can fly through; its presence is the beat.
    if (rng.bool(RING_LAYOUT.centrePaneChance)) {
      this.placePane(slot, CENTRE_PANE_INDEX, rng, localZ, 0, 0, openHalfWidth, openHalfHeight, true);
    } else {
      this.killPane(slot, CENTRE_PANE_INDEX);
    }

    const strutBase = slot * STRUTS_PER_RING;
    this.placeStrut(strutBase, localZ, 0, openHalfHeight, RING_LAYOUT.halfWidth * 2, RING_LAYOUT.strutThickness);
    this.placeStrut(strutBase + 1, localZ, 0, -openHalfHeight, RING_LAYOUT.halfWidth * 2, RING_LAYOUT.strutThickness);
    this.placeStrut(strutBase + 2, localZ, -openHalfWidth, 0, RING_LAYOUT.strutThickness, openHalfHeight * 2);
    this.placeStrut(strutBase + 3, localZ, openHalfWidth, 0, RING_LAYOUT.strutThickness, openHalfHeight * 2);

    const corners: readonly (readonly [number, number])[] = [
      [-openHalfWidth, -openHalfHeight],
      [openHalfWidth, -openHalfHeight],
      [-openHalfWidth, openHalfHeight],
      [openHalfWidth, openHalfHeight],
    ];
    const first = rng.int(0, corners.length);
    for (let i = 0; i < EMITTERS_PER_RING; i += 1) {
      const corner = corners[(first + i * 2 + 1) % corners.length];
      const size = RING_LAYOUT.emitterSize + rng.range(0, RING_LAYOUT.emitterSizeJitter);
      scratchEuler.set(rng.range(0, Math.PI), rng.range(0, Math.PI), rng.range(0, Math.PI));
      scratchQuaternion.setFromEuler(scratchEuler);
      scratchMatrix.compose(
        scratchPosition.set(corner?.[0] ?? 0, corner?.[1] ?? 0, localZ),
        scratchQuaternion,
        scratchScale.set(size, size, size),
      );
      const emitterIndex = slot * EMITTERS_PER_RING + i;
      this.emitterMesh.setMatrixAt(emitterIndex, scratchMatrix);
      const bounds = emitterIndex * 4;
      this.crystalBounds[bounds] = corner?.[0] ?? 0;
      this.crystalBounds[bounds + 1] = corner?.[1] ?? 0;
      this.crystalBounds[bounds + 2] = localZ;
      this.crystalBounds[bounds + 3] = size * 0.5;
    }

    this.matricesDirty = true;
  }

  private placePane(
    slot: number,
    pane: number,
    rng: Rng,
    localZ: number,
    centreX: number,
    centreY: number,
    halfWidth: number,
    halfHeight: number,
    forceAlive = false,
  ): void {
    const index = slot * PANES_PER_RING + pane;
    if (!forceAlive && rng.bool(RING_LAYOUT.paneGapChance)) {
      this.killPane(slot, pane);
      return;
    }

    const inset = 1 - rng.range(0, RING_LAYOUT.paneInsetJitter);
    const width = Math.max(0, halfWidth * 2 * inset);
    const height = Math.max(0, halfHeight * 2 * inset);
    const z = localZ + rng.range(-RING_LAYOUT.paneZJitter, RING_LAYOUT.paneZJitter);

    scratchMatrix.compose(
      scratchPosition.set(centreX, centreY, z),
      IDENTITY_QUATERNION,
      scratchScale.set(width, height, RING_LAYOUT.paneThickness),
    );
    this.glassMesh.setMatrixAt(index, scratchMatrix);

    this.paneAlive[index] = 1;
    const base = index * 4;
    this.paneBounds[base] = centreX;
    this.paneBounds[base + 1] = centreY;
    this.paneBounds[base + 2] = width * 0.5;
    this.paneBounds[base + 3] = height * 0.5;
  }

  private killPane(slot: number, pane: number): void {
    const index = slot * PANES_PER_RING + pane;
    this.paneAlive[index] = 0;
    scratchMatrix.compose(scratchPosition.set(0, 0, 0), IDENTITY_QUATERNION, ZERO_SCALE);
    this.glassMesh.setMatrixAt(index, scratchMatrix);
    const base = index * 4;
    this.paneBounds[base] = 0;
    this.paneBounds[base + 1] = 0;
    this.paneBounds[base + 2] = 0;
    this.paneBounds[base + 3] = 0;
  }

  private placeStrut(
    index: number,
    localZ: number,
    centreX: number,
    centreY: number,
    width: number,
    height: number,
  ): void {
    scratchMatrix.compose(
      scratchPosition.set(centreX, centreY, localZ),
      IDENTITY_QUATERNION,
      scratchScale.set(Math.max(width, RING_LAYOUT.strutThickness), Math.max(height, RING_LAYOUT.strutThickness), RING_LAYOUT.strutDepth),
    );
    this.frameMesh.setMatrixAt(index, scratchMatrix);
  }
}

/** Cheap ancestry walk; the corridor graph is three levels deep, so this is exact and free. */
function isDescendantOf(child: Object3D, ancestor: Object3D): boolean {
  for (let node: Object3D | null = child; node !== null; node = node.parent) {
    if (node === ancestor) return true;
  }
  return false;
}
