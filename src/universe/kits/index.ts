/**
 * Architecture kits: the corridor's vocabulary, expressed as DATA.
 *
 * There is exactly one corridor generator and it never learns which universe it is drawing.
 * It asks a kit for modules, places them on rings, and instances whatever geometry a module
 * builds. Shipping a new universe is therefore a data file in this folder, never a branch in
 * the generator - the same contract UniverseTheme.ts makes for colour.
 *
 * WHAT COUNTS AS A BUDGET. core/Quality.ts owns how MANY rings a tier draws and how finely
 * they tessellate; `kitDetailFor` reads the tier's own corridor budget rather than adding a
 * second tier table, so a tier is still described in exactly one file. A kit owns how BIG a
 * ring is - metres of clearance, ring spacing, the proportions of a column. Those are content
 * dimensions, they change when the art changes, and they belong with the art.
 *
 * CYCLE DISCIPLINE. Kit modules import helpers from here while this file imports the kits
 * back. That resolves only because every binding a kit touches during its own evaluation is
 * either an erased type or a hoisted `function` declaration. NEVER export a `const` from this
 * file for a kit to consume at module scope: it is in the temporal dead zone while the kit
 * evaluates and will throw on first import.
 */

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  LatheGeometry,
  Quaternion,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';

import type { QualityBudget } from '../../core/Quality';
import type { ArchitectureKitId } from '../UniverseTheme';
import { ARCHITECTURE_KIT_IDS } from '../UniverseTheme';

import { ASHFALL_SHRINE_APPROACH } from './ashfallShrineApproach';
import { CURTAINWALL_SPAN } from './curtainwallSpan';
import { KIT_FOLDWORKS } from './foldworks';
import { OLYMPUS_COLONNADE } from './olympusColonnade';
import { RAGNAROK_BIFROST_SPAN } from './ragnarokBifrostSpan';
import { KIT_RECTILINEAR_VOID } from './rectilinearVoid';
import { SALTGLASS_RIGGING } from './saltglassRigging';

/* ------------------------------------------------------------------ contract */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * Where the generator is allowed to put a module. `wall` modules are authored for the +X
 * side only and mirrored onto -X by the generator; `gate` modules straddle the whole
 * corridor and are placed once per ring.
 */
export type MountSlot = 'floor' | 'wall' | 'ceiling' | 'gate' | 'suspended';

/** Structural job. The generator picks by role, never by module id, so kits stay swappable. */
export type ModuleRole = 'pylon' | 'span' | 'panel' | 'lintel' | 'plinth' | 'baffle' | 'fixture';

/**
 * Which theme colour and which material this surface reads from. Names map one-to-one onto
 * UniverseTheme fields so the corridor renderer needs no translation table.
 */
export type KitSurface = 'stone' | 'metal' | 'glass' | 'emissive-primary' | 'emissive-secondary';

/** Rapier primitives we are willing to build. Trimesh is deliberately absent: a corridor
 * made of trimeshes cannot be swept against at the speed the player travels. */
export type ColliderShape =
  | { readonly kind: 'box'; readonly halfExtents: Vec3 }
  | { readonly kind: 'cylinder'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'capsule'; readonly halfHeight: number; readonly radius: number };

/** `breakable` is the only class the shatter system will accept a fracture request for. */
export type ColliderBehaviour = 'static' | 'breakable' | 'sensor';

/**
 * Everything src/physics/Colliders.ts needs to build a body without ever touching geometry.
 * Poses are module-local; the generator composes the ring transform on top.
 */
export interface ColliderHint {
  readonly shape: ColliderShape;
  readonly center: Vec3;
  /** Euler XYZ in radians. */
  readonly rotation: Vec3;
  readonly behaviour: ColliderBehaviour;
  readonly surface: KitSurface;
}

/** Tessellation the tier can afford. Supplied by the caller so kits hold no tier knowledge. */
export interface KitDetail {
  /** Divisions around any surface of revolution. */
  readonly radial: number;
  /** Divisions along a swept or repeated run. */
  readonly sweep: number;
  /** Whether optional detail sub-meshes are emitted at all. */
  readonly greeble: boolean;
}

export interface KitModule {
  readonly id: string;
  readonly role: ModuleRole;
  readonly slot: MountSlot;
  readonly surface: KitSurface;
  /** Local bounds in metres. The generator packs rings from this without building geometry. */
  readonly bounds: Aabb;
  readonly colliders: readonly ColliderHint[];
  build: (detail: KitDetail) => BufferGeometry;
}

export interface ArchitectureKit {
  readonly id: ArchitectureKitId;
  readonly displayName: string;
  /** Half the clear interior width, metres. Content dimension - see the header. */
  readonly halfWidth: number;
  readonly height: number;
  /** Distance between consecutive rings along -Z, metres. */
  readonly ringSpacing: number;
  readonly modules: readonly KitModule[];
}

/** Authoring laws, not performance budgets: fewer than five modules and a corridor repeats
 * visibly within one run; more than eight and no player ever notices the extra. */
export const MIN_KIT_MODULES = 5;
export const MAX_KIT_MODULES = 8;

/* ------------------------------------------------- authoring helpers (hoisted) */

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function aabb(min: Vec3, max: Vec3): Aabb {
  return { min, max };
}

export function boxCollider(
  halfExtents: Vec3,
  center: Vec3,
  behaviour: ColliderBehaviour,
  surface: KitSurface,
  rotation: Vec3 = { x: 0, y: 0, z: 0 },
): ColliderHint {
  return { shape: { kind: 'box', halfExtents }, center, rotation, behaviour, surface };
}

export function cylinderCollider(
  radius: number,
  halfHeight: number,
  center: Vec3,
  behaviour: ColliderBehaviour,
  surface: KitSurface,
  rotation: Vec3 = { x: 0, y: 0, z: 0 },
): ColliderHint {
  return { shape: { kind: 'cylinder', halfHeight, radius }, center, rotation, behaviour, surface };
}

export function capsuleCollider(
  radius: number,
  halfHeight: number,
  center: Vec3,
  behaviour: ColliderBehaviour,
  surface: KitSurface,
  rotation: Vec3 = { x: 0, y: 0, z: 0 },
): ColliderHint {
  return { shape: { kind: 'capsule', halfHeight, radius }, center, rotation, behaviour, surface };
}

export function boxPart(
  width: number,
  height: number,
  depth: number,
  x = 0,
  y = 0,
  z = 0,
): BufferGeometry {
  return new BoxGeometry(width, height, depth).translate(x, y, z);
}

export function cylinderPart(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  detail: KitDetail,
  x = 0,
  y = 0,
  z = 0,
): BufferGeometry {
  return new CylinderGeometry(radiusTop, radiusBottom, height, detail.radial, 1, false).translate(x, y, z);
}

/** Profile points are `[radius, height]` pairs, bottom to top - the shape of the silhouette. */
export function lathePart(
  profile: readonly (readonly [number, number])[],
  detail: KitDetail,
  x = 0,
  y = 0,
  z = 0,
): BufferGeometry {
  const points = profile.map(([radius, height]) => new Vector2(radius, height));
  return new LatheGeometry(points, detail.radial).translate(x, y, z);
}

/** A torus arc standing in the XY plane, swept symmetrically about +Y so it reads as an arch. */
export function archPart(
  radius: number,
  tube: number,
  arc: number,
  detail: KitDetail,
  x = 0,
  y = 0,
  z = 0,
): BufferGeometry {
  const tubeSegments = Math.max(3, Math.round(detail.radial / 2));
  const arcSegments = Math.max(detail.radial, Math.round(detail.radial * arc));
  const geometry = new TorusGeometry(radius, tube, tubeSegments, arcSegments, arc);
  geometry.rotateZ((Math.PI - arc) / 2);
  return geometry.translate(x, y, z);
}

/** An arbitrary rod between two local points - cables, stays, rigging, diagonal bracing. */
export function strutPart(from: Vec3, to: Vec3, radius: number, detail: KitDetail): BufferGeometry {
  const delta = new Vector3(to.x - from.x, to.y - from.y, to.z - from.z);
  const length = delta.length();
  if (length === 0) throw new RangeError('strutPart: zero-length strut has no orientation');
  const geometry = new CylinderGeometry(radius, radius, length, detail.radial, 1, false);
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), delta.divideScalar(length)));
  return geometry.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
}

/** `make` receives the index and its angle in radians, so callers place their own radius. */
export function repeatAround(
  count: number,
  make: (index: number, angle: number) => BufferGeometry,
): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  for (let index = 0; index < count; index += 1) parts.push(make(index, (index / count) * Math.PI * 2));
  return parts;
}

/**
 * One module is one draw call, so every module collapses to a single geometry. The parts are
 * disposed on the way out: they are CPU-side scratch that must never reach the GPU.
 */
export function mergeParts(parts: readonly BufferGeometry[]): BufferGeometry {
  const first = parts[0];
  if (first === undefined) throw new RangeError('mergeParts: a module must build at least one part');
  if (parts.length === 1) return first;

  // mergeGeometries refuses a mix of indexed and non-indexed inputs, so flatten if any part
  // arrived without an index rather than losing the module to a silent null return.
  const mixed = parts.some((part) => part.index === null);
  const flattened = parts.map((part) => (mixed && part.index !== null ? part.toNonIndexed() : part));
  const merged = mergeGeometries(flattened, false);

  for (const part of flattened) if (!parts.includes(part)) part.dispose();
  for (const part of parts) part.dispose();
  return merged;
}

/* --------------------------------------------------------------- tier detail */

/**
 * Tessellation rides the tier's existing corridor budget instead of a table of its own: the
 * ring count IS that tier's statement of how much corridor geometry it can afford, so the two
 * can never drift apart. Six is the floor because a hexagonal prism is the coarsest solid that
 * still reads as a round column at corridor scale.
 */
export function kitDetailFor(budget: QualityBudget): KitDetail {
  const floor = 6;
  const radial = Math.max(floor, Math.round(budget.corridorRings / 2));
  return {
    radial,
    sweep: Math.max(1, Math.round(radial / 3)),
    // The coarsest tier is coarse everywhere; anything above it can afford ornament.
    greeble: radial > floor,
  };
}

function detailKey(detail: KitDetail): string {
  return `${detail.radial}:${detail.sweep}:${detail.greeble ? 'g' : 'p'}`;
}

const GEOMETRY_CACHE = new WeakMap<KitModule, Map<string, BufferGeometry>>();

/**
 * Modules are shared by every ring that uses them, so geometry is built once per detail level
 * and handed out by reference. Callers must not dispose what they get back - use
 * `disposeKitGeometry` when a universe is unloaded.
 */
export function geometryFor(module: KitModule, detail: KitDetail): BufferGeometry {
  let byDetail = GEOMETRY_CACHE.get(module);
  if (byDetail === undefined) {
    byDetail = new Map<string, BufferGeometry>();
    GEOMETRY_CACHE.set(module, byDetail);
  }
  const key = detailKey(detail);
  const cached = byDetail.get(key);
  if (cached !== undefined) return cached;
  const built = module.build(detail);
  byDetail.set(key, built);
  return built;
}

/** Build every module up front. Kit geometry is procedural, so the cost is paid on load. */
export function prewarmKit(kit: ArchitectureKit, detail: KitDetail): void {
  for (const module of kit.modules) geometryFor(module, detail);
}

export function disposeKitGeometry(kit: ArchitectureKit): void {
  for (const module of kit.modules) {
    const byDetail = GEOMETRY_CACHE.get(module);
    if (byDetail === undefined) continue;
    for (const geometry of byDetail.values()) geometry.dispose();
    byDetail.clear();
    GEOMETRY_CACHE.delete(module);
  }
}

/* -------------------------------------------------------------- the registry */

export const KITS: Readonly<Record<ArchitectureKitId, ArchitectureKit>> = Object.freeze({
  'kit-rectilinear-void': KIT_RECTILINEAR_VOID,
  'olympus-colonnade': OLYMPUS_COLONNADE,
  'ragnarok-bifrost-span': RAGNAROK_BIFROST_SPAN,
  'curtainwall-span': CURTAINWALL_SPAN,
  'saltglass-rigging': SALTGLASS_RIGGING,
  'kit-foldworks': KIT_FOLDWORKS,
  'ashfall-shrine-approach': ASHFALL_SHRINE_APPROACH,
});

export function getKit(id: ArchitectureKitId): ArchitectureKit {
  return KITS[id];
}

export function modulesForSlot(kit: ArchitectureKit, slot: MountSlot): readonly KitModule[] {
  return kit.modules.filter((module) => module.slot === slot);
}

export function modulesForRole(kit: ArchitectureKit, role: ModuleRole): readonly KitModule[] {
  return kit.modules.filter((module) => module.role === role);
}

/* -------------------------------------------------------------- validation */

function halfSpan(shape: ColliderShape): Vec3 {
  if (shape.kind === 'box') return shape.halfExtents;
  const reach = shape.halfHeight + (shape.kind === 'capsule' ? shape.radius : 0);
  return v3(shape.radius, reach, shape.radius);
}

/** Returns every violation found; empty means the kit is legal. Never throws. */
export function validateKit(kit: ArchitectureKit): string[] {
  const violations: string[] = [];
  const where = `kit "${kit.id}"`;

  if (kit.modules.length < MIN_KIT_MODULES || kit.modules.length > MAX_KIT_MODULES) {
    violations.push(
      `law: ${where} has ${kit.modules.length} modules, must have ${MIN_KIT_MODULES}-${MAX_KIT_MODULES}`,
    );
  }
  // A corridor with no panel has no glass, and a corridor with no glass is not this game.
  if (!kit.modules.some((module) => module.surface === 'glass')) {
    violations.push(`law: ${where} has no glass-surfaced module - nothing in it can be shattered`);
  }
  if (!kit.modules.some((module) => module.role === 'pylon')) {
    violations.push(`law: ${where} has no pylon - rings need something to stand on`);
  }
  if (!(kit.halfWidth > 0 && kit.height > 0 && kit.ringSpacing > 0)) {
    violations.push(`sanity: ${where} halfWidth/height/ringSpacing must all be > 0`);
  }

  const seen = new Set<string>();
  for (const module of kit.modules) {
    if (seen.has(module.id)) violations.push(`sanity: ${where} duplicate module id "${module.id}"`);
    seen.add(module.id);

    const { min, max } = module.bounds;
    if (!(max.x > min.x && max.y > min.y && max.z > min.z)) {
      violations.push(`sanity: ${where} module "${module.id}" has inverted or flat bounds`);
    }
    if (module.colliders.length === 0 && module.role !== 'fixture') {
      violations.push(`sanity: ${where} module "${module.id}" is structural but has no collider hint`);
    }
    if (module.surface === 'glass' && !module.colliders.some((hint) => hint.behaviour === 'breakable')) {
      violations.push(`sanity: ${where} glass module "${module.id}" has no breakable collider`);
    }
    for (const hint of module.colliders) {
      // A collider poking out of the declared bounds means the generator's packing is a lie
      // and the player collides with something that was culled.
      const half = halfSpan(hint.shape);
      const outside =
        hint.center.x - half.x < min.x - 1e-3 || hint.center.x + half.x > max.x + 1e-3 ||
        hint.center.y - half.y < min.y - 1e-3 || hint.center.y + half.y > max.y + 1e-3 ||
        hint.center.z - half.z < min.z - 1e-3 || hint.center.z + half.z > max.z + 1e-3;
      if (outside && hint.rotation.x === 0 && hint.rotation.y === 0 && hint.rotation.z === 0) {
        violations.push(`sanity: ${where} module "${module.id}" has an axis-aligned collider outside its bounds`);
      }
    }
  }

  return violations;
}

/** Registry-wide check: every declared kit id is built, and every built kit is legal. */
export function validateKitRegistry(): string[] {
  const violations: string[] = [];
  for (const id of ARCHITECTURE_KIT_IDS) {
    const kit = KITS[id];
    if (kit.id !== id) violations.push(`registry: KITS["${id}"] holds a kit labelled "${kit.id}"`);
    violations.push(...validateKit(kit));
  }
  return violations;
}

// Guarded rather than a bare `import.meta.env.DEV` so kits can also be imported by build
// tooling that is not running through Vite and has no env injected.
const IS_DEV: boolean = typeof import.meta.env === 'object' && import.meta.env.DEV === true;

if (IS_DEV) {
  const violations = validateKitRegistry();
  if (violations.length > 0) {
    throw new Error(`universe/kits is internally inconsistent:\n  ${violations.join('\n  ')}`);
  }
}
