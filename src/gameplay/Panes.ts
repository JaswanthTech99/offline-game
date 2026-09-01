/**
 * PANE ARCHETYPES.
 *
 * A pane is the game's only obstacle and therefore its only vocabulary. Five archetypes
 * carry the whole difficulty curve, and they differ in what they DO to the player's ball
 * count rather than in how they are drawn:
 *
 *   plain          - one hit, one ball. The baseline the other four are read against.
 *   laminated      - two hits. The first crazes it and leaves the shards bonded in place,
 *                    so the player can see they spent a ball and bought only a warning.
 *   armoured       - refuses low-energy hits outright; a lobbed ball bounces off.
 *   votive-lattice - leaded panels. The came is the strongest crack in the pane, so panels
 *                    leave whole and only the struck one breaks up.
 *   concealed      - opaque until the light bus lifts. Unlit it reads as wall; the corridor
 *                    lighting, not the pane, decides whether the player ever saw it coming.
 *
 * The numbers below are CONTENT, the same way a UniverseTheme's colours and a BattleRoster's
 * beats are content: they describe what a pane is, not what the hardware can afford. Every
 * number that scales with the machine - how many shards may exist, how long they live, how
 * many frames the hit-stop holds - comes from core/Quality.ts and is passed in.
 */

import { BufferGeometry, Float32BufferAttribute, Sphere, Uint32BufferAttribute, Vector3 } from 'three/webgpu';

import type { Seed } from '../core/types';
import { LIGHT_BUS_NEUTRAL } from '../universe/LightBus';
import type { FracturePattern, LatticeSpec, PaneRect, Vec2 } from './Voronoi';
import { buildShardMesh, FRACTURE_LAWS, generateFracture, generateLatticeFracture } from './Voronoi';

export type PaneArchetypeId = 'plain' | 'laminated' | 'armoured' | 'votive-lattice' | 'concealed';

export const PANE_ARCHETYPE_IDS: readonly PaneArchetypeId[] = Object.freeze([
  'plain',
  'laminated',
  'armoured',
  'votive-lattice',
  'concealed',
]);

export interface PaneArchetype {
  readonly id: PaneArchetypeId;
  readonly displayName: string;
  /** Hits the pane absorbs before the last one releases it. Always >= 1. */
  readonly hitsToBreak: number;
  /** Impact energy under which a hit does not even count. Armour is a threshold, not a counter. */
  readonly minBreakEnergy: number;
  /** Glass thickness in metres. Drives the extrusion depth and therefore the lit edge. */
  readonly thickness: number;
  /** Fracture cells per square metre at full budget. Scaled down when headroom is short. */
  readonly cellDensity: number;
  /** 0 = cells spread evenly, 1 = cells pile onto the impact point. */
  readonly focus: number;
  readonly relaxIterations: number;
  readonly lattice: LatticeSpec | null;
  /**
   * Whole-number multiplier on the hit-stop frames Quality's motion rules allow. Integer
   * because the hit-stop is a frames-to-SKIP counter, and a fractional frame is not a thing.
   */
  readonly hitStopWeight: number;
  /** Ejection speed along the pane normal, metres per second, before per-cell falloff. */
  readonly ejectSpeed: number;
  /** Peak tumble rate in radians per second at the impact point. */
  readonly spinRate: number;
  /**
   * Bond weight a non-final hit leaves behind. 1 is an untouched pane and 0 is fully
   * released, so 0.94 is a pane whose shards have parted by six percent: visibly crazed,
   * still standing. Ignored when hitsToBreak is 1.
   */
  readonly crazedBond: number;
  /**
   * Light-bus `emisIntensity` above which a concealed pane becomes visible. null means the
   * pane is always visible, which is every archetype but one.
   */
  readonly revealAbove: number | null;
}

const ARCHETYPE_TABLE: Readonly<Record<PaneArchetypeId, PaneArchetype>> = {
  plain: {
    id: 'plain',
    displayName: 'Plain sheet',
    hitsToBreak: 1,
    minBreakEnergy: 0,
    thickness: 0.02,
    cellDensity: 26,
    focus: 0.55,
    relaxIterations: 3,
    lattice: null,
    hitStopWeight: 1,
    ejectSpeed: 3.4,
    spinRate: 7.5,
    crazedBond: 1,
    revealAbove: null,
  },
  laminated: {
    id: 'laminated',
    displayName: 'Laminated sheet',
    hitsToBreak: 2,
    minBreakEnergy: 0,
    // Thicker, and relaxed harder: laminate holds together, so its cells are chunkier and
    // more even than the radiating splinters of a plain sheet.
    thickness: 0.034,
    cellDensity: 18,
    focus: 0.72,
    relaxIterations: 5,
    lattice: null,
    hitStopWeight: 2,
    ejectSpeed: 2.6,
    spinRate: 5.5,
    crazedBond: 0.94,
    revealAbove: null,
  },
  armoured: {
    id: 'armoured',
    displayName: 'Armoured pane',
    hitsToBreak: 3,
    minBreakEnergy: 0.55,
    thickness: 0.055,
    cellDensity: 12,
    focus: 0.85,
    relaxIterations: 6,
    lattice: null,
    hitStopWeight: 3,
    ejectSpeed: 2.1,
    spinRate: 4.0,
    crazedBond: 0.9,
    revealAbove: null,
  },
  'votive-lattice': {
    id: 'votive-lattice',
    displayName: 'Votive lattice',
    hitsToBreak: 1,
    minBreakEnergy: 0,
    thickness: 0.016,
    cellDensity: 34,
    focus: 0.6,
    relaxIterations: 2,
    lattice: { columns: 4, rows: 6, cellsAtImpact: 14, leadFraction: 0.12 },
    hitStopWeight: 1,
    ejectSpeed: 3.9,
    spinRate: 9.0,
    crazedBond: 1,
    revealAbove: null,
  },
  concealed: {
    id: 'concealed',
    displayName: 'Concealed pane',
    hitsToBreak: 1,
    minBreakEnergy: 0,
    thickness: 0.024,
    cellDensity: 30,
    focus: 0.5,
    relaxIterations: 3,
    lattice: null,
    hitStopWeight: 2,
    ejectSpeed: 3.6,
    spinRate: 8.0,
    crazedBond: 1,
    // Neutral on the bus is 1.0, so this pane is invisible until a battle beat brightens
    // the corridor past neutral. It is lit by the world, never by itself.
    revealAbove: 1.15,
  },
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as unknown as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const PANE_ARCHETYPES: Readonly<Record<PaneArchetypeId, PaneArchetype>> = deepFreeze(ARCHETYPE_TABLE);

/**
 * Where a pane sits in the corridor, as a plain orthonormal frame rather than a Matrix4.
 * The shatter runtime pushes shard poses into a flat transform buffer and never builds an
 * Object3D per shard, so a matrix here would only ever be decomposed again.
 */
export interface PaneFrame {
  readonly origin: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  /** Unit normal. Shards are ejected along it, toward the side the player is flying from. */
  readonly normal: readonly [number, number, number];
}

const IDENTITY_FRAME: PaneFrame = {
  origin: [0, 0, 0],
  right: [1, 0, 0],
  up: [0, 1, 0],
  normal: [0, 0, 1],
};

export const PANE_FRAME_IDENTITY: PaneFrame = deepFreeze(IDENTITY_FRAME);

export type PaneState = 'intact' | 'crazed' | 'shattering' | 'gone';

export type PaneHitOutcome =
  /** Under the archetype's energy threshold. The ball bounces, the pane is untouched. */
  | 'absorbed'
  /** Counted, not fatal. The pane bakes its fracture and holds the shards bonded. */
  | 'crazed'
  /** Fatal. The shards are handed to the shatter runtime. */
  | 'shattered';

/**
 * A baked pane: the fracture, the geometry that renders it, and the pivot each shard's
 * vertices are measured from. Baking is deliberately lazy - a corridor holds far more panes
 * than will ever be struck, and baking them all at stream-in would spend the shatter budget
 * on panes the player flies straight past.
 */
export interface PaneBake {
  readonly geometry: BufferGeometry;
  readonly pattern: FracturePattern;
  /** 3 floats per shard, pane-local. */
  readonly pivots: Float32Array;
  readonly shardCount: number;
  dispose(): void;
}

/**
 * The intact pane. Its UVs match the fracture geometry's exactly, which is the whole point:
 * swapping quad -> fracture at bond weight 1 must be invisible, and a UV that shifts by a
 * texel during the swap is a visible pop on the frame the player is looking hardest at.
 */
export function buildPaneQuad(rect: PaneRect): BufferGeometry {
  const { halfWidth: hw, halfHeight: hh } = rect;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0], 3),
  );
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex(new Uint32BufferAttribute([0, 1, 2, 0, 2, 3], 1));
  return geometry;
}

/**
 * A concealed pane starts emerging the moment the corridor is brighter than its own theme
 * alone would make it, and is fully out by its archetype's threshold. Anchoring the low end
 * to the bus's NEUTRAL rather than to a fraction of the threshold is what makes "opaque
 * until lit" literally true: at neutral the reveal is exactly zero.
 */
const REVEAL_FADE_START = LIGHT_BUS_NEUTRAL.emisIntensity;

export interface PaneOptions {
  readonly id: string;
  readonly archetype: PaneArchetypeId;
  readonly rect: PaneRect;
  readonly frame: PaneFrame;
  readonly seed: Seed;
}

export class Pane {
  readonly id: string;
  readonly archetype: PaneArchetype;
  readonly rect: PaneRect;
  readonly frame: PaneFrame;
  readonly seed: Seed;

  private hitCount = 0;
  private paneState: PaneState = 'intact';
  private baked: PaneBake | null = null;

  constructor(options: PaneOptions) {
    this.id = options.id;
    this.archetype = PANE_ARCHETYPES[options.archetype];
    this.rect = options.rect;
    this.frame = options.frame;
    this.seed = options.seed;
  }

  get state(): PaneState {
    return this.paneState;
  }

  get hitsTaken(): number {
    return this.hitCount;
  }

  get hitsRemaining(): number {
    return Math.max(0, this.archetype.hitsToBreak - this.hitCount);
  }

  /** The cached fracture, or null until something bakes one. Named apart from
   * `bakeFracture` on purpose: one reads, one may do a millisecond of work. */
  get fracture(): PaneBake | null {
    return this.baked;
  }

  get area(): number {
    return this.rect.halfWidth * this.rect.halfHeight * 4;
  }

  /**
   * 0 = fully concealed, 1 = fully revealed. Takes the bus value as an argument instead of
   * reaching for the `lightBus` singleton so a pane can be reasoned about, and tested, with
   * no global state - and so the export tooling can freeze a reveal at any value it likes.
   */
  reveal01(busEmisIntensity: number): number {
    const threshold = this.archetype.revealAbove;
    if (threshold === null) return 1;
    // A hard cut reads as a bug, so the pane fades up across the gap instead of popping.
    if (busEmisIntensity <= REVEAL_FADE_START) return 0;
    if (busEmisIntensity >= threshold) return 1;
    return (busEmisIntensity - REVEAL_FADE_START) / (threshold - REVEAL_FADE_START);
  }

  /** Registers one impact and reports what it did. Does NOT bake; the runtime decides that. */
  hit(energy: number): PaneHitOutcome {
    if (this.paneState === 'gone' || this.paneState === 'shattering') return 'absorbed';
    if (energy < this.archetype.minBreakEnergy) return 'absorbed';

    this.hitCount += 1;
    if (this.hitCount >= this.archetype.hitsToBreak) {
      this.paneState = 'shattering';
      return 'shattered';
    }
    this.paneState = 'crazed';
    return 'crazed';
  }

  /**
   * Bond weight the pane holds at after its current number of hits. A crazed pane sits just
   * below 1 so the fracture is visible and the pane still reads as standing; a released pane
   * is driven to 0 by the shatter runtime.
   */
  get bondFloor(): number {
    if (this.paneState === 'crazed') return this.archetype.crazedBond;
    return this.paneState === 'intact' ? 1 : 0;
  }

  /**
   * Generates and uploads the fracture. `cellBudget` is the runtime's remaining shard
   * headroom from Quality and is a hard ceiling; `dispersalRadius` is how far a shard may
   * travel in its lifetime, which only the runtime knows because both terms come from
   * Quality. Idempotent: a laminated pane bakes on its first hit and reuses that bake when
   * the second one releases it, so the crazing the player already saw is the crack it breaks
   * along.
   */
  bakeFracture(impact: Vec2, cellBudget: number, dispersalRadius: number): PaneBake | null {
    if (this.baked !== null) return this.baked;
    if (cellBudget < FRACTURE_LAWS.minCells) return null;

    const wanted = Math.max(FRACTURE_LAWS.minCells, Math.round(this.area * this.archetype.cellDensity));
    const cellCount = Math.min(wanted, cellBudget);
    const lattice = this.archetype.lattice;

    const pattern =
      lattice !== null
        ? generateLatticeFracture(
            this.rect,
            lattice,
            this.seed,
            impact,
            this.archetype.focus,
            this.archetype.relaxIterations,
            cellCount,
          )
        : generateFracture({
            rect: this.rect,
            seed: this.seed,
            cellCount,
            impact,
            focus: this.archetype.focus,
            relaxIterations: this.archetype.relaxIterations,
          });

    if (pattern.cells.length === 0) return null;

    const mesh = buildShardMesh(pattern, this.archetype.thickness);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(mesh.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(mesh.normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(mesh.uvs, 2));
    // Per-vertex lookup into the shatter runtime's shard transform buffer. The vertex stage
    // reads it; nothing on the CPU touches it again.
    geometry.setAttribute('shardIndex', new Float32BufferAttribute(mesh.shardIndex, 1));
    geometry.setIndex(new Uint32BufferAttribute(mesh.indices, 1));

    // Vertices are stored relative to their shard pivot and are moved entirely by the
    // transform buffer, so an automatically computed bounding sphere would hug the origin
    // and cull the pane the instant it starts flying apart.
    geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), dispersalRadius);

    const bake: PaneBake = {
      geometry,
      pattern,
      pivots: mesh.pivots,
      shardCount: mesh.shardCount,
      dispose: () => {
        geometry.dispose();
      },
    };
    this.baked = bake;
    return bake;
  }

  /** Called by the runtime once every shard has retired. */
  markGone(): void {
    this.paneState = 'gone';
  }

  /** Returns the pane to its unbroken state and drops the bake. Used by the run restart. */
  reset(): void {
    this.hitCount = 0;
    this.paneState = 'intact';
    this.baked?.dispose();
    this.baked = null;
  }

  dispose(): void {
    this.baked?.dispose();
    this.baked = null;
  }
}

/** Transforms a pane-local point into world space through the pane's frame. */
export function paneLocalToWorld(
  frame: PaneFrame,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  offset: number,
): void {
  const [ox, oy, oz] = frame.origin;
  const [rx, ry, rz] = frame.right;
  const [ux, uy, uz] = frame.up;
  const [nx, ny, nz] = frame.normal;
  out[offset] = ox + rx * x + ux * y + nx * z;
  out[offset + 1] = oy + ry * x + uy * y + ny * z;
  out[offset + 2] = oz + rz * x + uz * y + nz * z;
}

/** Returns every violation; empty means the archetype table is legal. Never throws. */
export function validatePaneArchetypes(): string[] {
  const violations: string[] = [];

  for (const id of PANE_ARCHETYPE_IDS) {
    const a = PANE_ARCHETYPES[id];
    const where = `pane archetype "${id}"`;

    if (!Number.isInteger(a.hitsToBreak) || a.hitsToBreak < 1) {
      violations.push(`sanity: ${where} hitsToBreak ${a.hitsToBreak} must be an integer >= 1`);
    }
    if (!Number.isInteger(a.hitStopWeight) || a.hitStopWeight < 1) {
      // Fractional hit-stop weight would produce a fractional frames-to-skip count.
      violations.push(`law: ${where} hitStopWeight ${a.hitStopWeight} must be an integer >= 1`);
    }
    if (!(a.thickness > 0)) violations.push(`sanity: ${where} thickness must be > 0`);
    if (!(a.cellDensity > 0)) violations.push(`sanity: ${where} cellDensity must be > 0`);
    if (!(a.focus >= 0 && a.focus <= 1)) violations.push(`sanity: ${where} focus must be in [0,1]`);
    if (a.relaxIterations < 0 || a.relaxIterations > FRACTURE_LAWS.maxRelaxIterations) {
      violations.push(
        `sanity: ${where} relaxIterations ${a.relaxIterations} outside 0..${FRACTURE_LAWS.maxRelaxIterations}`,
      );
    }
    if (!(a.crazedBond > 0 && a.crazedBond <= 1)) {
      violations.push(`sanity: ${where} crazedBond must be in (0,1]`);
    }
    if (a.hitsToBreak > 1 && a.crazedBond >= 1) {
      violations.push(
        `law: ${where} takes ${a.hitsToBreak} hits but crazedBond is 1 - the player pays a ball and sees nothing`,
      );
    }
    if (a.revealAbove !== null && !(a.revealAbove > REVEAL_FADE_START)) {
      // At or below neutral the pane would already be visible with no battle beat at all,
      // which is the one thing a concealed pane must never be.
      violations.push(
        `law: ${where} revealAbove ${a.revealAbove} must sit above the light bus neutral ${REVEAL_FADE_START}`,
      );
    }
    if (a.lattice !== null) {
      const l = a.lattice;
      if (!Number.isInteger(l.columns) || l.columns < 1) violations.push(`sanity: ${where} lattice.columns must be an integer >= 1`);
      if (!Number.isInteger(l.rows) || l.rows < 1) violations.push(`sanity: ${where} lattice.rows must be an integer >= 1`);
      if (!(l.leadFraction >= 0 && l.leadFraction < 0.5)) {
        violations.push(`sanity: ${where} lattice.leadFraction must be in [0,0.5)`);
      }
      if (l.cellsAtImpact < 1) violations.push(`sanity: ${where} lattice.cellsAtImpact must be >= 1`);
    }
  }

  return violations;
}

const IS_DEV: boolean = typeof import.meta.env === 'object' && import.meta.env.DEV === true;

if (IS_DEV) {
  const violations = validatePaneArchetypes();
  if (violations.length > 0) {
    throw new Error(`gameplay/Panes.ts archetype table is inconsistent:\n  ${violations.join('\n  ')}`);
  }
}
