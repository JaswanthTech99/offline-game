/**
 * THE STEEL BALL - pool, bodies, and the two-layer look.
 *
 * Everything the player throws comes from here and nothing here is ever allocated after
 * load: the bodies, the colliders, the slots and both instanced meshes are built once at
 * pre-warm, and spawning is a state flip. Allocating a rigid body mid-run costs a wasm
 * table growth on the exact frame the player is watching a pane explode.
 *
 * TWO RENDER LAYERS, AND THE REASON THERE ARE TWO
 * The corridor attenuates everything in it - haze, fog, distance falloff - which is what
 * gives the tunnel its depth. But the ball's specular hotspot must NOT attenuate: it is the
 * player's read on where the ball is and how fast it is going, and a hotspot that fades into
 * the haze at 20 metres makes long throws unreadable. So the body renders as an ordinary
 * fogged physical material, and the hotspot plus the LightBus rim render as a second,
 * additively-blended instanced shell with `fog = false`. That shell is a separate material
 * the corridor's attenuation never touches, which is what makes the exemption structural
 * rather than a promise. Faking it by turning fog off on the body would unfog the steel too
 * and the ball would stop belonging to the corridor.
 *
 * Ordering contract: register this pool with the engine AFTER the physics stepper. It reads
 * body transforms in fixedUpdate and would otherwise sample the pre-step pose every frame.
 */

import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import {
  AdditiveBlending,
  Color,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import {
  cameraPosition,
  dot,
  normalize,
  normalWorld,
  oneMinus,
  positionWorld,
  pow,
  saturate,
  uniform,
} from 'three/tsl';
import { QUALITY, type Tier } from '../core/Quality';
import type { Alpha, Brand, Disposable, Millis, Tickable } from '../core/types';
import { lightBus, type LightBusUniforms } from '../universe/LightBus';
import { BALL_PALETTE } from '../universe/themes/palette';
import type { HexColor } from '../universe/themes/palette';

/**
 * A live ball. Encodes slot and generation together so a handle held across a despawn can
 * never address the ball that reused its slot - the silent version of that bug moves the
 * wrong projectile and is close to undebuggable.
 */
export type BallId = Brand<number, 'BallId'>;

/** Slots per generation in the packed handle. Must exceed any tier's pool capacity. */
const ID_SLOT_STRIDE = 1024;

export const BALL_PHYSICS = Object.freeze({
  /** Reads as a heavy shot put in the corridor's scale, not a marble. */
  radius: 0.085,
  massKg: 1.15,
  /** Low: steel that pings off glass like a superball reads as plastic. */
  restitution: 0.24,
  friction: 0.45,
  linearDamping: 0.015,
  angularDamping: 0.05,
  gravityScale: 1.0,
  /** A ball still alive after this has missed everything; it is only costing frames. */
  lifetimeMs: 7000,
  /** Metres behind the player before a ball is reclaimed. */
  cullBehindM: 5,
  /** Below this the ball has left the corridor entirely. */
  cullBelowY: -60,
  /** Reclaimed early once asleep and behind: a settled ball is scenery, not gameplay. */
  cullSleepingBehind: true,
});

export const BALL_LOOK = Object.freeze({
  roughness: 0.17,
  metalness: 1.0,
  /** Tight lobe. Wider than this and the hotspot smears into a glow blob under bloom. */
  hotspotPower: 46,
  hotspotGain: 2.6,
  /** Broad falloff so the rim wraps the silhouette instead of drawing a hard ring. */
  rimPower: 2.4,
  rimGain: 0.85,
  /** Shell sits proud of the body so the additive pass never z-fights the steel. */
  shellScale: 1.035,
  /** Default key direction if nothing drives it: over the player's left shoulder, down-corridor. */
  keyDirection: Object.freeze({ x: -0.42, y: 0.78, z: -0.46 }),
});

/**
 * Icosahedron subdivision per tier. The one perf-shaped number in this file.
 * TODO(step-2): move to core/Quality.ts as `QualityBudget.ballMeshDetail` when the render
 * agent adds a mesh-detail field; this agent does not own core/Quality.ts.
 */
const BALL_MESH_DETAIL: Readonly<Record<Tier, number>> = Object.freeze({
  SHOWCASE: 4,
  ULTRA_4K: 3,
  DESKTOP_HIGH: 3,
  MOBILE_ULTRA: 3,
  MOBILE_HIGH: 2,
  MOBILE_LOW: 1,
});

/**
 * The slice of the Rapier module the pool constructs with. Typed as a structural port rather
 * than an import so this module never pulls the wasm bundle into its own chunk, and so tests
 * can build a pool against a fake without touching physics.
 */
export type RapierBodyFactory = Pick<
  typeof import('@dimforge/rapier3d-compat'),
  'RigidBodyDesc' | 'ColliderDesc'
>;

/** What the crystal field needs from the pool. Kept narrow so neither module owns the other. */
export interface BallProbe {
  /**
   * Handle of the first live ball whose surface intersects the given sphere, or null.
   * Single call per query so the caller allocates no closure and no array per cluster.
   */
  overlapSphere(x: number, y: number, z: number, radius: number): BallId | null;
}

export interface BallPoolOptions {
  readonly rapier: RapierBodyFactory;
  readonly world: World;
  readonly tier: Tier;
  /** Defaults to the process-wide bus; injectable so a test can drive the rim in isolation. */
  readonly light?: LightBusUniforms;
}

/**
 * One pooled ball. Holds both the previous and current physics poses because the renderer
 * runs between fixed steps and must interpolate, never extrapolate - extrapolation puts the
 * ball through the glass a frame before the sim says it got there.
 */
class BallSlot {
  readonly index: number;
  readonly body: RigidBody;
  readonly collider: Collider;
  readonly prevPos = new Vector3();
  readonly currPos = new Vector3();
  readonly prevQuat = new Quaternion();
  readonly currQuat = new Quaternion();
  active = false;
  /** Bumped on every despawn so stale handles decode to a mismatch. */
  generation = 0;
  ageMs: Millis = 0;
  /** Spawn order, used to pick a victim when a throw arrives at a full pool. */
  serial = 0;

  constructor(index: number, body: RigidBody, collider: Collider) {
    this.index = index;
    this.body = body;
    this.collider = collider;
  }
}

const scratchVec = new Vector3();
const scratchQuat = new Quaternion();
const scratchMatrix = new Matrix4();
const scratchScale = new Vector3(1, 1, 1);
/** Rapier writes into this before the pose is copied into the slot; never escapes the module. */
const scratchRapierVec = { x: 0, y: 0, z: 0 };
const scratchRapierRot = { x: 0, y: 0, z: 0, w: 1 };

export class BallPool implements Tickable, Disposable, BallProbe {
  /** Add this to the scene. Both render layers live under it so they cannot be separated. */
  readonly group = new Group();
  readonly capacity: number;
  /** Signed world gravity on Y after the ball's own scale, for the trajectory preview. */
  readonly gravityY: number;

  private readonly world: World;
  private readonly slots: BallSlot[] = [];
  private readonly liveSlots: BallSlot[] = [];
  private readonly slotByCollider = new Map<number, number>();
  private readonly bodyMesh: InstancedMesh;
  private readonly shellMesh: InstancedMesh;
  private readonly shellMaterial: MeshBasicNodeMaterial;
  private readonly bodyMaterial: MeshPhysicalNodeMaterial;
  private readonly keyDirection = uniform(
    new Vector3(BALL_LOOK.keyDirection.x, BALL_LOOK.keyDirection.y, BALL_LOOK.keyDirection.z).normalize(),
  ).setName('ballKeyDirection');
  private readonly hotspotTint = uniform(new Vector3()).setName('ballHotspotTint');
  private readonly rimTint = uniform(new Vector3()).setName('ballRimTint');
  private serialCounter = 0;
  /** Player's position down the corridor; balls behind it are reclaimed. */
  private playerZ = 0;

  constructor(options: BallPoolOptions) {
    const budget = QUALITY[options.tier];
    // The pool size IS the live cap: pre-warming fewer bodies than the game may have in
    // flight is the same bug as no pool at all, just later.
    this.capacity = budget.prewarm.balls;
    this.world = options.world;
    this.gravityY = options.world.gravity.y * BALL_PHYSICS.gravityScale;

    const light = options.light ?? lightBus.uniforms;
    const detail = BALL_MESH_DETAIL[options.tier];

    this.hotspotTint.value.set(...colorToLinearTriple(BALL_PALETTE.hotspot));
    this.rimTint.value.set(...colorToLinearTriple(BALL_PALETTE.rim));

    this.bodyMaterial = new MeshPhysicalNodeMaterial({
      color: new Color(BALL_PALETTE.steel),
      metalness: BALL_LOOK.metalness,
      roughness: BALL_LOOK.roughness,
    });
    this.bodyMaterial.name = 'ball-steel';

    this.shellMaterial = this.buildHotspotShellMaterial(light);

    const bodyGeometry = new IcosahedronGeometry(BALL_PHYSICS.radius, detail);
    const shellGeometry = new IcosahedronGeometry(BALL_PHYSICS.radius * BALL_LOOK.shellScale, detail);

    this.bodyMesh = new InstancedMesh(bodyGeometry, this.bodyMaterial, this.capacity);
    this.shellMesh = new InstancedMesh(shellGeometry, this.shellMaterial, this.capacity);
    for (const mesh of [this.bodyMesh, this.shellMesh]) {
      // Instance bounds are not maintained per frame; culling against a stale sphere would
      // pop the whole pool out of frame mid-throw.
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
    }
    // Only the steel casts. The shell is a light contribution, not an occluder; letting it
    // cast would double every ball's shadow and thicken it by the shell scale.
    this.bodyMesh.castShadow = true;
    this.shellMesh.castShadow = false;
    this.bodyMesh.name = 'ball-bodies';
    this.shellMesh.name = 'ball-hotspots';
    // Drawn after the steel so the additive term lands on top of the shaded surface.
    this.shellMesh.renderOrder = 1;
    this.group.name = 'ball-pool';

    this.prewarm(options.rapier);
  }

  get liveCount(): number {
    return this.liveSlots.length;
  }

  get isFull(): boolean {
    return this.liveSlots.length >= this.capacity;
  }

  /** The corridor tells the pool where the player is; everything behind it is reclaimable. */
  setPlayerZ(z: number): void {
    this.playerZ = z;
  }

  /**
   * Drives the specular hotspot. Expects a WORLD-space direction pointing from the surface
   * toward the key light, so the corridor can hand over its own key without a basis change.
   */
  setKeyDirection(x: number, y: number, z: number): void {
    this.keyDirection.value.set(x, y, z).normalize();
  }

  /**
   * Launches a ball. `muzzleVelocity` is metres/second: the impulse applied is that velocity
   * times the body's mass, so the throw feels identical no matter what BALL_PHYSICS.massKg
   * is tuned to. Returns null only when the pool is exhausted AND recycling was declined.
   */
  spawn(origin: Vector3, muzzleVelocity: Vector3, recycleOldest = true): BallId | null {
    let slot = this.takeFreeSlot();
    if (slot === null) {
      if (!recycleOldest) return null;
      // A refused throw reads to the player as a dropped input, which is worse than the
      // oldest ball vanishing somewhere behind them.
      slot = this.oldestLiveSlot();
      if (slot === null) return null;
      this.release(slot);
      slot = this.takeFreeSlot();
      if (slot === null) return null;
    }

    const { body } = slot;
    scratchRapierVec.x = origin.x;
    scratchRapierVec.y = origin.y;
    scratchRapierVec.z = origin.z;
    body.setEnabled(true);
    body.setTranslation(scratchRapierVec, true);
    scratchRapierRot.x = 0;
    scratchRapierRot.y = 0;
    scratchRapierRot.z = 0;
    scratchRapierRot.w = 1;
    body.setRotation(scratchRapierRot, false);
    scratchRapierVec.x = 0;
    scratchRapierVec.y = 0;
    scratchRapierVec.z = 0;
    body.setLinvel(scratchRapierVec, false);
    body.setAngvel(scratchRapierVec, false);
    body.resetForces(false);
    body.resetTorques(false);

    const mass = body.mass();
    scratchRapierVec.x = muzzleVelocity.x * mass;
    scratchRapierVec.y = muzzleVelocity.y * mass;
    scratchRapierVec.z = muzzleVelocity.z * mass;
    body.applyImpulse(scratchRapierVec, true);

    slot.active = true;
    slot.ageMs = 0;
    slot.serial = ++this.serialCounter;
    slot.prevPos.copy(origin);
    slot.currPos.copy(origin);
    slot.prevQuat.identity();
    slot.currQuat.identity();
    this.liveSlots.push(slot);

    return this.encode(slot);
  }

  despawn(id: BallId): boolean {
    const slot = this.resolve(id);
    if (slot === null) return false;
    this.release(slot);
    return true;
  }

  /** Resolves a collision report back to the ball that caused it. Null for anything else. */
  ballForCollider(colliderHandle: number): BallId | null {
    const index = this.slotByCollider.get(colliderHandle);
    if (index === undefined) return null;
    const slot = this.slots[index];
    if (slot === undefined || !slot.active) return null;
    return this.encode(slot);
  }

  overlapSphere(x: number, y: number, z: number, radius: number): BallId | null {
    const reach = radius + BALL_PHYSICS.radius;
    const reachSq = reach * reach;
    for (const slot of this.liveSlots) {
      const dx = slot.currPos.x - x;
      const dy = slot.currPos.y - y;
      const dz = slot.currPos.z - z;
      if (dx * dx + dy * dy + dz * dz <= reachSq) return this.encode(slot);
    }
    return null;
  }

  /** Simulation pose of a live ball, written into `out`. False if the handle is stale. */
  positionOf(id: BallId, out: Vector3): boolean {
    const slot = this.resolve(id);
    if (slot === null) return false;
    out.copy(slot.currPos);
    return true;
  }

  fixedUpdate(dt: Millis): void {
    for (let i = this.liveSlots.length - 1; i >= 0; i -= 1) {
      const slot = this.liveSlots[i];
      if (slot === undefined) continue;

      slot.prevPos.copy(slot.currPos);
      slot.prevQuat.copy(slot.currQuat);
      readBodyPose(slot);
      slot.ageMs += dt;

      if (this.shouldReclaim(slot)) this.releaseAt(i);
    }
  }

  frame(alpha: Alpha): void {
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    let written = 0;
    for (const slot of this.liveSlots) {
      scratchVec.lerpVectors(slot.prevPos, slot.currPos, t);
      scratchQuat.slerpQuaternions(slot.prevQuat, slot.currQuat, t);
      scratchMatrix.compose(scratchVec, scratchQuat, scratchScale);
      this.bodyMesh.setMatrixAt(written, scratchMatrix);
      this.shellMesh.setMatrixAt(written, scratchMatrix);
      written += 1;
    }
    this.bodyMesh.count = written;
    this.shellMesh.count = written;
    if (written > 0) {
      this.bodyMesh.instanceMatrix.needsUpdate = true;
      this.shellMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Reclaims every live ball without disposing the pool. Used on run restart. */
  reclaimAll(): void {
    for (let i = this.liveSlots.length - 1; i >= 0; i -= 1) this.releaseAt(i);
    this.serialCounter = 0;
  }

  dispose(): void {
    this.reclaimAll();
    for (const slot of this.slots) this.world.removeRigidBody(slot.body);
    this.slots.length = 0;
    this.slotByCollider.clear();
    this.bodyMesh.geometry.dispose();
    this.shellMesh.geometry.dispose();
    this.bodyMaterial.dispose();
    this.shellMaterial.dispose();
    this.bodyMesh.dispose();
    this.shellMesh.dispose();
    this.group.clear();
  }

  /**
   * The attenuation-exempt layer. Both terms are computed in world space so the corridor can
   * drive the key direction directly, and both are additive so the shell contributes light
   * without ever darkening the steel underneath it.
   */
  private buildHotspotShellMaterial(light: LightBusUniforms): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial();
    material.name = 'ball-hotspot-shell';

    const surfaceToEye = normalize(cameraPosition.sub(positionWorld));
    const halfVector = normalize(this.keyDirection.add(surfaceToEye));
    const hotspot = pow(saturate(dot(normalWorld, halfVector)), BALL_LOOK.hotspotPower).mul(
      BALL_LOOK.hotspotGain,
    );
    // The rim is the battle's only handhold on the ball: when a distant strike fires, this
    // is what puts its colour on the thing in the player's hand.
    const rim = pow(oneMinus(saturate(dot(normalWorld, surfaceToEye))), BALL_LOOK.rimPower)
      .mul(BALL_LOOK.rimGain)
      .mul(light.rimBoost);

    material.colorNode = this.hotspotTint.mul(hotspot).add(this.rimTint.mul(rim));
    material.transparent = true;
    material.blending = AdditiveBlending;
    material.depthWrite = false;
    // THE EXEMPTION. Everything above is immune to corridor attenuation because this
    // material is never fogged and the corridor's haze pass does not own it.
    material.fog = false;

    return material;
  }

  private prewarm(rapier: RapierBodyFactory): void {
    for (let i = 0; i < this.capacity; i += 1) {
      const bodyDesc = rapier.RigidBodyDesc.dynamic()
        .setTranslation(0, BALL_PHYSICS.cullBelowY, 0)
        .setLinearDamping(BALL_PHYSICS.linearDamping)
        .setAngularDamping(BALL_PHYSICS.angularDamping)
        .setGravityScale(BALL_PHYSICS.gravityScale)
        // Without CCD a ball thrown at 30 m/s tunnels straight through a pane at 60 Hz.
        .setCcdEnabled(true)
        .setCanSleep(true)
        .setEnabled(false);
      const body = this.world.createRigidBody(bodyDesc);

      const colliderDesc = rapier.ColliderDesc.ball(BALL_PHYSICS.radius)
        .setMass(BALL_PHYSICS.massKg)
        .setRestitution(BALL_PHYSICS.restitution)
        .setFriction(BALL_PHYSICS.friction);
      const collider = this.world.createCollider(colliderDesc, body);

      const slot = new BallSlot(i, body, collider);
      this.slots.push(slot);
      this.slotByCollider.set(collider.handle, i);
    }
  }

  private shouldReclaim(slot: BallSlot): boolean {
    if (slot.ageMs >= BALL_PHYSICS.lifetimeMs) return true;
    if (slot.currPos.y <= BALL_PHYSICS.cullBelowY) return true;
    // Forward is -Z, so a greater Z than the player's means the ball is behind them.
    const behind = slot.currPos.z > this.playerZ + BALL_PHYSICS.cullBehindM;
    if (!behind) return false;
    return BALL_PHYSICS.cullSleepingBehind || slot.body.isSleeping();
  }

  private takeFreeSlot(): BallSlot | null {
    if (this.liveSlots.length >= this.capacity) return null;
    for (const slot of this.slots) {
      if (!slot.active) return slot;
    }
    return null;
  }

  private oldestLiveSlot(): BallSlot | null {
    let oldest: BallSlot | null = null;
    for (const slot of this.liveSlots) {
      if (oldest === null || slot.serial < oldest.serial) oldest = slot;
    }
    return oldest;
  }

  private release(slot: BallSlot): void {
    const index = this.liveSlots.indexOf(slot);
    if (index < 0) return;
    this.releaseAt(index);
  }

  private releaseAt(index: number): void {
    const slot = this.liveSlots[index];
    if (slot === undefined) return;
    const last = this.liveSlots.pop();
    if (last !== undefined && last !== slot) this.liveSlots[index] = last;

    slot.active = false;
    slot.generation += 1;
    slot.ageMs = 0;
    slot.body.setEnabled(false);
    scratchRapierVec.x = 0;
    scratchRapierVec.y = BALL_PHYSICS.cullBelowY;
    scratchRapierVec.z = 0;
    slot.body.setTranslation(scratchRapierVec, false);
  }

  private encode(slot: BallSlot): BallId {
    return (slot.generation * ID_SLOT_STRIDE + slot.index) as BallId;
  }

  private resolve(id: BallId): BallSlot | null {
    const index = id % ID_SLOT_STRIDE;
    const generation = (id - index) / ID_SLOT_STRIDE;
    const slot = this.slots[index];
    if (slot === undefined || !slot.active || slot.generation !== generation) return null;
    return slot;
  }
}

function readBodyPose(slot: BallSlot): void {
  slot.body.translation(scratchRapierVec);
  slot.currPos.set(scratchRapierVec.x, scratchRapierVec.y, scratchRapierVec.z);
  slot.body.rotation(scratchRapierRot);
  slot.currQuat.set(scratchRapierRot.x, scratchRapierRot.y, scratchRapierRot.z, scratchRapierRot.w);
}

/**
 * Colour uniforms are vec3, not `color`: the current TSL typings expose the arithmetic
 * operator chain on vec3 nodes but not on colour nodes, and the hotspot term is arithmetic.
 * Color does the sRGB->linear decode, so the authored hex still means what it looks like.
 */
function colorToLinearTriple(hex: HexColor): [number, number, number] {
  const color = new Color(hex);
  return [color.r, color.g, color.b];
}
