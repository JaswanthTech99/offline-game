/**
 * COLLIDER CONSTRUCTION.
 *
 * Turns the corridor kit's authored collision data into Rapier descriptors. The kit lives
 * in another layer and must never import Rapier, so the seam between them is the plain
 * data in this file: a module hands over `ModuleColliderSpec` (shapes, roles, local
 * offsets) and gets back `ColliderDesc`s already carrying the right surface, the right
 * interaction groups and the right event flags.
 *
 * ON THE NUMBERS IN THIS FILE. Quality.ts owns every budget - counts, caps, resolutions,
 * millisecond allowances. What lives here instead is the SIMULATION DOMAIN: friction and
 * restitution coefficients, densities in kg/m3, the ball's radius in metres. Those are not
 * tier-scalable knobs; a glass pane that is bouncier on mobile is a different game, not a
 * cheaper one. They are frozen, named, and gathered in one table for the same reason
 * budgets are: so tuning is one edit, not a hunt.
 */

import type { ColliderDesc as RapierColliderDesc, InteractionGroups } from '@dimforge/rapier3d-compat';
import RAPIER from '@dimforge/rapier3d-compat';
import type { BufferGeometry } from 'three/webgpu';
import { Quaternion, Vector3 } from 'three/webgpu';

/** Read-only structural vectors, so callers can pass a three.js Vector3 straight in. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface QuatLike extends Vec3Like {
  readonly w: number;
}

/**
 * What a collider IS, to the game rather than to the solver. One role drives three
 * separate decisions - surface coefficients, interaction groups and whether contacts are
 * reported - which is exactly why they are one enum and not three.
 */
export type PhysicsRole =
  /** Walls, floors, pillars, arches: the corridor shell a ball bounces off. */
  | 'structure'
  /** The breakable panes. The only thing that reports impact force. */
  | 'glass'
  /** Refill pickups. Sensors, never solid. */
  | 'crystal'
  /** A thrown steel ball. */
  | 'ball'
  /** Debris from a broken pane. */
  | 'shard'
  /** Invisible volume the corridor layer uses for gates, checkpoints and kill planes. */
  | 'trigger';

export const PHYSICS_ROLES: readonly PhysicsRole[] = Object.freeze([
  'structure',
  'glass',
  'crystal',
  'ball',
  'shard',
  'trigger',
]);

/**
 * Membership bits. Bit identities, not budgets: each role occupies one of Rapier's 16
 * group bits and the specific bit carries no meaning beyond being distinct.
 */
export const PHYSICS_GROUP: Readonly<Record<PhysicsRole, number>> = Object.freeze({
  structure: 1 << 0,
  glass: 1 << 1,
  crystal: 1 << 2,
  ball: 1 << 3,
  shard: 1 << 4,
  trigger: 1 << 5,
});

/**
 * Who each role is allowed to touch. The two exclusions that matter most:
 *
 *  - shards never collide with shards. A pane breaking into hundreds of pieces inside its
 *    own frame is an O(n^2) contact island that stalls the solver on the exact frame the
 *    player is watching, and the visual difference is nil because the pieces are moving
 *    apart anyway.
 *  - balls never collide with shards. A ball deflected by its own debris feels broken and
 *    ruins the aim the player already committed to.
 */
const PHYSICS_FILTER: Readonly<Record<PhysicsRole, number>> = Object.freeze({
  structure: PHYSICS_GROUP.ball | PHYSICS_GROUP.shard,
  glass: PHYSICS_GROUP.ball,
  crystal: PHYSICS_GROUP.ball,
  ball: PHYSICS_GROUP.structure | PHYSICS_GROUP.glass | PHYSICS_GROUP.crystal | PHYSICS_GROUP.trigger,
  shard: PHYSICS_GROUP.structure,
  trigger: PHYSICS_GROUP.ball,
});

/** Rapier packs membership into the high 16 bits and the filter into the low 16. */
export function interactionGroups(membership: number, filter: number): InteractionGroups {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export function groupsForRole(role: PhysicsRole): InteractionGroups {
  return interactionGroups(PHYSICS_GROUP[role], PHYSICS_FILTER[role]);
}

export interface SurfaceProperties {
  readonly friction: number;
  readonly restitution: number;
  /** kg/m3. Only consulted for colliders attached to a dynamic body. */
  readonly density: number;
}

/**
 * Simulation-domain surfaces. Steel on stone barely bounces; steel on glass must not bounce
 * at all, because a ball that rebounds off a pane it just broke reads as a miss.
 */
export const SURFACE: Readonly<Record<PhysicsRole, SurfaceProperties>> = Object.freeze({
  structure: Object.freeze({ friction: 0.62, restitution: 0.26, density: 2400 }),
  glass: Object.freeze({ friction: 0.2, restitution: 0.02, density: 2500 }),
  crystal: Object.freeze({ friction: 0.1, restitution: 0.0, density: 2600 }),
  ball: Object.freeze({ friction: 0.42, restitution: 0.34, density: 7850 }),
  shard: Object.freeze({ friction: 0.34, restitution: 0.18, density: 2500 }),
  trigger: Object.freeze({ friction: 0.0, restitution: 0.0, density: 1 }),
});

/**
 * Default shapes for the two pooled dynamic bodies. Metres and kilograms. The ball is a
 * thrown fist-sized sphere; the shard is a thin plate whose half-extents are rescaled per
 * spawn so one pooled body covers a whole size distribution of debris.
 */
export const SHAPE_DEFAULTS = Object.freeze({
  ballRadius: 0.075,
  /**
   * Set explicitly instead of derived from steel density, which for this radius would give
   * ~14 kg. Mass is a FEEL number - it decides how far a ball is deflected by a glancing
   * pillar - and tying it to the visual radius means retuning the throw every time the
   * model changes size.
   */
  ballMass: 1.2,
  shardHalfExtents: Object.freeze([0.09, 0.11, 0.005] as const),
  /**
   * Noise gate on contact-force reporting, newtons. Rapier reports impulse-over-timestep,
   * so the value scales with the solver's step and is a RELATIVE strength hint, not a
   * physical force - never gate gameplay on its absolute size. Measured: a 1 m/s tap from
   * the pooled ball reports ~72, a resting contact reports far less.
   */
  impactForceThreshold: 60,
});

export type ColliderShapeSpec =
  | { readonly kind: 'box'; readonly halfExtents: Vec3Like }
  | { readonly kind: 'ball'; readonly radius: number }
  | { readonly kind: 'capsule'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'cylinder'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'trimesh'; readonly vertices: Float32Array; readonly indices: Uint32Array }
  | { readonly kind: 'convexHull'; readonly points: Float32Array };

/** One collider inside a kit module, positioned in the module's own local space. */
export interface ColliderSpec {
  readonly shape: ColliderShapeSpec;
  readonly role: PhysicsRole;
  readonly offset?: Vec3Like;
  readonly rotation?: QuatLike;
  /**
   * Overrides the role default. Present so a single pane can be marked non-solid while a
   * scripted sequence plays without inventing a seventh role.
   */
  readonly sensor?: boolean;
  /**
   * Opaque handle back to whatever the owning layer needs to find on a hit - a pane index,
   * a crystal index, a gate id. Physics never interprets it.
   */
  readonly ref?: number;
}

/**
 * The collision half of one corridor kit module. The kit builds these once at load; the
 * corridor streamer instantiates the same spec at every ring that uses the module.
 */
export interface ModuleColliderSpec {
  readonly id: string;
  readonly colliders: readonly ColliderSpec[];
}

/** Where a module instance sits on the rail. */
export interface ModulePlacement {
  readonly position: Vec3Like;
  readonly rotation: QuatLike;
}

export const IDENTITY_PLACEMENT: ModulePlacement = Object.freeze({
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  rotation: Object.freeze({ x: 0, y: 0, z: 0, w: 1 }),
});

/**
 * Module-level scratch. Composing a placement with a local offset happens once per collider
 * per ring spawn, which is often enough that allocating a Vector3 here would show up in the
 * corridor's ms budget as GC rather than as work.
 */
const scratchOffset = new Vector3();
const scratchPosition = new Vector3();
const scratchPlacementRot = new Quaternion();
const scratchLocalRot = new Quaternion();
const scratchWorldRot = new Quaternion();

/**
 * Builds the raw shape. Returns null for the one case Rapier itself rejects - a convex
 * hull of degenerate or coplanar points - so a bad kit module loses one collider instead
 * of throwing halfway through building a ring.
 */
export function shapeDesc(shape: ColliderShapeSpec): RapierColliderDesc | null {
  switch (shape.kind) {
    case 'box':
      return RAPIER.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
    case 'ball':
      return RAPIER.ColliderDesc.ball(shape.radius);
    case 'capsule':
      return RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
    case 'cylinder':
      return RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
    case 'trimesh':
      return RAPIER.ColliderDesc.trimesh(shape.vertices, shape.indices);
    case 'convexHull':
      return RAPIER.ColliderDesc.convexHull(shape.points);
  }
}

/**
 * Applies role surface, groups, sensor flag and event flags. Split out from `shapeDesc` so
 * the pooled ball and shard bodies - which build their shapes directly rather than from a
 * kit module - go through exactly the same configuration path.
 */
export function configureDesc(desc: RapierColliderDesc, role: PhysicsRole, sensor: boolean): RapierColliderDesc {
  const surface = SURFACE[role];
  desc
    .setFriction(surface.friction)
    .setRestitution(surface.restitution)
    .setDensity(surface.density)
    .setCollisionGroups(groupsForRole(role))
    .setSensor(sensor);

  // Only the roles gameplay reacts to pay for event generation. Structure contacts are
  // audio-only and are read from the ball's own state, not from the event queue. Glass
  // additionally needs the force, because how hard it was hit decides how it breaks.
  if (role === 'glass') {
    desc
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(SHAPE_DEFAULTS.impactForceThreshold)
      // Take the MINIMUM of the two restitutions rather than the default average. A ball
      // that visibly rebounds off a pane reads as a miss even when the pane is breaking,
      // and averaging with the ball's own bounce is enough to produce exactly that.
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
  } else if (role === 'crystal' || role === 'trigger') {
    desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  }
  return desc;
}

/** Crystals and triggers are volumes you pass through, never surfaces you hit. */
export function isSensorRole(role: PhysicsRole): boolean {
  return role === 'crystal' || role === 'trigger';
}

/**
 * Composes a collider's local offset with its module's placement and writes the result
 * into the descriptor. Kept public because the shatter system reuses it to seat a shard's
 * spawn transform in the frame of the pane that produced it.
 */
export function applyPlacement(
  desc: RapierColliderDesc,
  placement: ModulePlacement,
  offset: Vec3Like | undefined,
  rotation: QuatLike | undefined,
): RapierColliderDesc {
  scratchPlacementRot.set(
    placement.rotation.x,
    placement.rotation.y,
    placement.rotation.z,
    placement.rotation.w,
  );

  if (offset === undefined) {
    scratchPosition.set(placement.position.x, placement.position.y, placement.position.z);
  } else {
    scratchOffset.set(offset.x, offset.y, offset.z).applyQuaternion(scratchPlacementRot);
    scratchPosition
      .set(placement.position.x, placement.position.y, placement.position.z)
      .add(scratchOffset);
  }
  desc.setTranslation(scratchPosition.x, scratchPosition.y, scratchPosition.z);

  if (rotation === undefined) {
    desc.setRotation(placement.rotation);
  } else {
    scratchLocalRot.set(rotation.x, rotation.y, rotation.z, rotation.w);
    scratchWorldRot.copy(scratchPlacementRot).multiply(scratchLocalRot);
    desc.setRotation(scratchWorldRot);
  }
  return desc;
}

/** One finished descriptor plus the metadata PhysicsWorld needs to tag the live collider. */
export interface BuiltCollider {
  readonly desc: RapierColliderDesc;
  readonly role: PhysicsRole;
  readonly ref: number;
}

/**
 * The main entry point: a kit module and a placement in, ready-to-create descriptors out.
 * `out` is reused across ring spawns so streaming a corridor allocates one array total.
 */
export function buildModuleColliders(
  module: ModuleColliderSpec,
  placement: ModulePlacement,
  out: BuiltCollider[] = [],
): BuiltCollider[] {
  out.length = 0;
  for (const spec of module.colliders) {
    const desc = shapeDesc(spec.shape);
    if (desc === null) continue;
    configureDesc(desc, spec.role, spec.sensor ?? isSensorRole(spec.role));
    applyPlacement(desc, placement, spec.offset, spec.rotation);
    out.push({ desc, role: spec.role, ref: spec.ref ?? 0 });
  }
  return out;
}

/**
 * Converts a rendered kit mesh into a triangle-mesh collision shape.
 *
 * The attribute is copied component-by-component rather than handed to Rapier by
 * reference: the source may be interleaved, non-float, or a view into a shared buffer that
 * the renderer will later reupload, and Rapier keeps the array alive inside WASM. One copy
 * at load beats a class of impossible-to-reproduce corruption bugs.
 */
export function trimeshFromGeometry(geometry: BufferGeometry): ColliderShapeSpec | null {
  const position = geometry.getAttribute('position');
  if (position === undefined) return null;

  const vertexCount = position.count;
  const vertices = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    vertices[i * 3 + 0] = position.getX(i);
    vertices[i * 3 + 1] = position.getY(i);
    vertices[i * 3 + 2] = position.getZ(i);
  }

  const index = geometry.getIndex();
  let indices: Uint32Array;
  if (index === null) {
    indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i += 1) indices[i] = i;
  } else {
    indices = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i += 1) indices[i] = index.getX(i);
  }

  if (indices.length < 3) return null;
  return { kind: 'trimesh', vertices, indices };
}

/**
 * Convex hull of a rendered mesh. Cheaper to test than a trimesh and, unlike a trimesh, it
 * has an inside - so it is the right shape for anything a ball can be pushed into rather
 * than merely bounced off.
 *
 * A degenerate point cloud is not rejected here. Rapier's hull builder is the only thing
 * that can actually decide, and running it twice - once to validate, once to build - both
 * doubles the load cost and strands a shape inside WASM. `shapeDesc` returns null and
 * `buildModuleColliders` drops the collider instead.
 */
export function convexHullFromGeometry(geometry: BufferGeometry): ColliderShapeSpec | null {
  const position = geometry.getAttribute('position');
  if (position === undefined) return null;
  // Fewer than four points cannot bound a volume, so there is no hull to attempt.
  if (position.count < 4) return null;
  const points = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i += 1) {
    points[i * 3 + 0] = position.getX(i);
    points[i * 3 + 1] = position.getY(i);
    points[i * 3 + 2] = position.getZ(i);
  }
  return { kind: 'convexHull', points };
}

/** Convenience factory so kit authors describe a pane without importing Rapier. */
export function boxCollider(
  role: PhysicsRole,
  halfExtents: Vec3Like,
  offset?: Vec3Like,
  rotation?: QuatLike,
  ref?: number,
): ColliderSpec {
  const spec: {
    shape: ColliderShapeSpec;
    role: PhysicsRole;
    offset?: Vec3Like;
    rotation?: QuatLike;
    ref?: number;
  } = { shape: { kind: 'box', halfExtents }, role };
  if (offset !== undefined) spec.offset = offset;
  if (rotation !== undefined) spec.rotation = rotation;
  if (ref !== undefined) spec.ref = ref;
  return spec;
}
