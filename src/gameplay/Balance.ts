/**
 * EVERY GAMEPLAY NUMBER IN SHATTERPOINT LIVES HERE.
 *
 * Relationship to core/Quality.ts: Quality owns what the HARDWARE can afford (pixels, shard
 * counts, millisecond budgets). Balance owns what the GAME asks of the player (ball economy,
 * room shape, score weights, currency rates). They are different questions and the boundary
 * between them is load-bearing:
 *
 *   A number that changes how a run SCORES must never depend on the tier.
 *
 * A phone player and a 4K player shatter the same 12 panes in room 7 of seed 0xC0FFEE and
 * earn the same points; only the number of debris shards each pane bursts into differs. That
 * is why `composeRoom` reads nothing from Quality and `presentationBudgetFor` reads nothing
 * but Quality. Blurring the two would make the leaderboard a hardware benchmark.
 *
 * Nothing else in src/gameplay may contain a tuning literal. Add it here and import it.
 */

import { MOTION, QUALITY, type MotionRules, type QualityBudget, type Tier } from '../core/Quality';
import type { Frames, Millis } from '../core/types';
import type { UniverseId } from '../universe/UniverseTheme';

/* ------------------------------------------------------------------ shared numeric helpers */

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const clampInt = (value: number, min: number, max: number): number =>
  Math.round(clamp(value, min, max));

/* ------------------------------------------------------------------------- run structure */

/**
 * Eleven is the checkpoint interval AND the zone length, deliberately fused. Two independent
 * numbers here would eventually drift and produce a checkpoint mid-zone, which reads to the
 * player as the game losing count of itself.
 */
export const ROOMS_PER_ZONE = 11;
export const ZONES_PER_UNIVERSE = 5;
export const ROOMS_PER_UNIVERSE = ROOMS_PER_ZONE * ZONES_PER_UNIVERSE;

/** Endless is deliberately absent from this set: no checkpoints is the entire premise. */
export const CHECKPOINTED_MODES: readonly string[] = Object.freeze(['classic']);

/** How many rooms the corridor generator is kept planned ahead of the player at all times. */
export const ROOM_PLAN_LOOKAHEAD = 3;

/* ---------------------------------------------------------------------------- ball economy */

export const BALLS_AT_START = 25;
/**
 * A THROW COSTS ONE, WHATEVER THE VOLLEY SIZE.
 *
 * The multiplier is how many balls leave the hand per tap, and charging per ball would make a
 * x5 streak cost five times as much to shoot as no streak at all - a reward the player pays
 * for is not a reward, and it would make deliberately dropping the streak the optimal play.
 * The multiplier buys coverage; the reserve counts THROWS. That also makes the HUD honest:
 * "25" means twenty-five taps, not twenty-five projectiles.
 */
export const BALL_COST_PER_THROW = 1;
export const BALLS_PER_CRYSTAL = 3;
/** Flying into glass. Large enough to be a disaster, small enough to survive twice from full. */
export const BALL_PENALTY_ON_IMPACT = 10;
export const BALLS_MAX = 99;
/** A checkpoint tops the reserve UP to this floor; it never takes balls away from a good run. */
export const CHECKPOINT_BALL_FLOOR = 25;
export const CHECKPOINT_BALL_BONUS = 5;

/* ----------------------------------------------------------------------------- multiplier */

/**
 * The ladder is DISCRETE and super-linear: x1 x2 x3 x5 x10. Even steps make the top rung
 * feel like arithmetic; the jump to x10 is what makes a long clean streak worth protecting.
 */
export const MULTIPLIER_LADDER: readonly number[] = Object.freeze([1, 2, 3, 5, 10]);
export const MULTIPLIER_MIN = 1;
export const MULTIPLIER_MAX = 10;
/** Hits needed to climb one rung. */
export const HITS_PER_MULTIPLIER_STEP = 4;
export const CRYSTALS_PER_MULTIPLIER_STEP = HITS_PER_MULTIPLIER_STEP;

/** Consecutive hits -> ladder rung. The only place the streak/multiplier curve is defined. */
export const multiplierForStreak = (streak: number): number => {
  const rung = clampInt(
    Math.floor(Math.max(0, streak) / HITS_PER_MULTIPLIER_STEP),
    0,
    MULTIPLIER_LADDER.length - 1,
  );
  return MULTIPLIER_LADDER[rung] ?? MULTIPLIER_MIN;
};

/**
 * A missed crystal costs the PROGRESS toward the next tier but not the tier already earned.
 * Dropping the whole multiplier on one miss makes late rooms feel arbitrary; keeping the tier
 * and resetting the climb keeps the pressure without the whiplash. Only an impact demotes.
 */
export const streakFloorForMultiplier = (multiplier: number): number => {
  const rung = MULTIPLIER_LADDER.indexOf(multiplier);
  return (rung < 0 ? 0 : rung) * HITS_PER_MULTIPLIER_STEP;
};

/* ---------------------------------------------------------------------------- director */

/**
 * The difficulty director. The run used to open with three panes at speed 17 and end on
 * approach 1; the ramp below is the fix, and every number in it lives here.
 *
 * A step is a difficulty rung, not a room count: the player climbs when they are hitting
 * and falls back when they are not, so the ramp follows ability rather than the clock.
 */
export interface DirectorStep {
  /** Earliest approach this rung may be reached at. */
  readonly minApproach: number;
  readonly paneCount: number;
  readonly travelSpeed: number;
}

export const TRAVEL_SPEED_BASE = 9;
/** Hard ceiling. The old build ran at 17 from the first row and could reach 22. */
export const TRAVEL_SPEED_CEILING = 17;

export const DIRECTOR_STEPS: readonly DirectorStep[] = Object.freeze([
  { minApproach: 1, paneCount: 1, travelSpeed: TRAVEL_SPEED_BASE },
  { minApproach: 5, paneCount: 2, travelSpeed: 12 },
  { minApproach: 11, paneCount: 3, travelSpeed: TRAVEL_SPEED_CEILING },
]);

/** Rolling window the advance decision is made over. */
export const ACCURACY_WINDOW = 5;
export const ACCURACY_TO_ADVANCE = 0.6;
export const MISSES_TO_DROP = 3;

/**
 * Crystals get their OWN rows. A crystal sharing a row with a square pane is the specific
 * thing that made the game unplayable: the two read alike at speed and the player has no
 * way to tell which one they must not hit.
 */
export const CRYSTAL_ROW_PERIOD = 3;
/** No crystals at all while the player is still learning to hit anything. */
export const CRYSTAL_FIRST_APPROACH = 3;
/** Throws are free while these approaches are active. */
export const TUTORIAL_APPROACHES = 2;

/**
 * The legibility bar. A target smaller than this on screen is not something the player
 * failed to hit - it is something the renderer failed to show, and a rendering defect must
 * never be allowed to take a ball. Expressed in device pixels of projected height.
 */
export const LEGIBLE_MIN_SCREEN_PX = 14;

/** Beyond this a target is scenery, whatever its projected size says. */
export const LEGIBLE_MAX_RANGE_M = 120;

/** A crystal never projects smaller than this; below it the facets stop resolving. */
export const CRYSTAL_MIN_SCREEN_PX = 26;
/** Ceiling on the size floor, so a very distant crystal does not become a billboard. */
export const CRYSTAL_MAX_SCALE_BOOST = 3.2;

/**
 * Projected height in device pixels of an object `sizeM` tall at `distanceM`, for a camera
 * of `fovYDeg` on a viewport `viewportPx` tall.
 */
export function projectedHeightPx(
  sizeM: number,
  distanceM: number,
  fovYDeg: number,
  viewportPx: number,
): number {
  if (distanceM <= 0) return viewportPx;
  const tanHalf = Math.tan((fovYDeg * Math.PI) / 360);
  return (sizeM / distanceM / (2 * tanHalf)) * viewportPx;
}

export function isLegible(
  sizeM: number,
  distanceM: number,
  fovYDeg: number,
  viewportPx: number,
): boolean {
  if (distanceM > LEGIBLE_MAX_RANGE_M) return false;
  return projectedHeightPx(sizeM, distanceM, fovYDeg, viewportPx) >= LEGIBLE_MIN_SCREEN_PX;
}

export type RowKind = 'panes' | 'crystal';

export interface RowPlan {
  readonly approach: number;
  readonly kind: RowKind;
  readonly paneCount: number;
  readonly crystalCount: number;
  readonly travelSpeed: number;
}

/**
 * Mutable ramp state. Kept beside its constants rather than in Playfield so the self-test
 * can drive the real director without standing up a renderer.
 */
export class Director {
  private stepIndex = 0;
  /**
   * Rows PLANNED, which runs ahead of the player: the field pre-spawns several rows so the
   * corridor is populated before the run starts.
   */
  private plannedIndex = 0;
  /**
   * The approach the player is actually ON, advanced when a row reaches them. These must be
   * separate: keying the tutorial to planned rows meant it had already expired at row one,
   * because eight rows are spawned before the player has passed any.
   */
  private approachIndex = 0;
  private consecutiveMisses = 0;
  private readonly window: boolean[] = [];

  /** 0 before the player has reached anything; 1 on the first approach. */
  get approach(): number {
    return this.approachIndex;
  }

  get plannedRows(): number {
    return this.plannedIndex;
  }

  /** Called when a planned row reaches the player. */
  arrive(): void {
    this.approachIndex += 1;
  }

  get step(): DirectorStep {
    return DIRECTOR_STEPS[this.stepIndex] ?? (DIRECTOR_STEPS[0] as DirectorStep);
  }

  get travelSpeed(): number {
    return Math.min(this.step.travelSpeed, TRAVEL_SPEED_CEILING);
  }

  /** True while throws are free and the HUD should say so. */
  get isTutorial(): boolean {
    return this.approach <= TUTORIAL_APPROACHES;
  }

  get accuracy(): number {
    if (this.window.length === 0) return 1;
    return this.window.filter(Boolean).length / this.window.length;
  }

  recordThrow(hit: boolean): void {
    this.window.push(hit);
    while (this.window.length > ACCURACY_WINDOW) this.window.shift();
    this.consecutiveMisses = hit ? 0 : this.consecutiveMisses + 1;

    if (this.consecutiveMisses >= MISSES_TO_DROP) {
      this.stepIndex = Math.max(0, this.stepIndex - 1);
      this.consecutiveMisses = 0;
      this.window.length = 0;
    }
  }

  /** Plans the next row and advances the approach counter. */
  nextRow(): RowPlan {
    this.plannedIndex += 1;
    const approach = this.plannedIndex;

    // Climb only on demonstrated accuracy, and never past the rung this approach allows.
    const next = DIRECTOR_STEPS[this.stepIndex + 1];
    if (
      next !== undefined &&
      approach >= next.minApproach &&
      this.window.length >= ACCURACY_WINDOW &&
      this.accuracy >= ACCURACY_TO_ADVANCE
    ) {
      this.stepIndex += 1;
      this.window.length = 0;
    }

    const crystalRow =
      approach >= CRYSTAL_FIRST_APPROACH && approach % CRYSTAL_ROW_PERIOD === 0;

    return crystalRow
      ? { approach, kind: 'crystal', paneCount: 0, crystalCount: 1, travelSpeed: this.travelSpeed }
      : {
          approach,
          kind: 'panes',
          paneCount: this.step.paneCount,
          crystalCount: 0,
          travelSpeed: this.travelSpeed,
        };
  }

  reset(): void {
    this.stepIndex = 0;
    this.plannedIndex = 0;
    this.approachIndex = 0;
    this.consecutiveMisses = 0;
    this.window.length = 0;
  }
}

/* ------------------------------------------------------------------------- forward motion */

export const BASE_SPEED_UNITS_PER_SEC = 22;
export const MAX_SPEED_UNITS_PER_SEC = 42;
export const SPEED_GAIN_PER_ROOM = 0.35;
export const SPEED_GAIN_PER_ZONE = 1.6;
/** Practice exists to learn a zone's layout, so it runs under the pace that zone shipped at. */
export const PRACTICE_SPEED_SCALE = 0.85;

/* --------------------------------------------------------------------------- phase timing */

export const BRIEFING_MS: Millis = 900;
export const CHECKPOINT_HOLD_MS: Millis = 1400;
export const ZONE_CLEAR_HOLD_MS: Millis = 2200;
export const UNIVERSE_CLEAR_HOLD_MS: Millis = 3600;
/** The slow-motion death beat. Long enough to watch the last pane finish falling. */
export const FAIL_SEQUENCE_MS: Millis = 1800;

/* ------------------------------------------------------------------------ room composition */

export type RoomKind = 'approach' | 'gallery' | 'gauntlet' | 'vault' | 'crucible' | 'sanctum';

export const ROOM_KINDS: readonly RoomKind[] = Object.freeze([
  'approach',
  'gallery',
  'gauntlet',
  'vault',
  'crucible',
  'sanctum',
]);

/** Reached only if a weighted draw underflows on floating-point dust. Never a design choice. */
export const FALLBACK_ROOM_KIND: RoomKind = 'gallery';

/** Metres between corridor rings. Room length is rings x this, so both are score-visible. */
export const RING_SPACING_UNITS = 6;

/** Inclusive [min, max] draw ranges. `weight` only matters for kinds in the free pool. */
export interface RoomProfile {
  readonly kind: RoomKind;
  readonly rings: readonly [number, number];
  readonly panes: readonly [number, number];
  readonly crystals: readonly [number, number];
  readonly obstacles: readonly [number, number];
  /** Authored 0..1 knob the corridor generator scales its hazard placement noise by. */
  readonly hazardDensity: number;
  readonly speedScale: number;
  readonly weight: number;
}

/**
 * Pane and crystal ranges are close to equal across every kind on purpose: a room's IDENTITY
 * comes from its obstacles and pace, not from how much score it holds. Rooms that differ in
 * score density would make seed choice, rather than play, decide a rank.
 */
export const ROOM_PROFILES: Readonly<Record<RoomKind, RoomProfile>> = Object.freeze({
  approach: {
    kind: 'approach',
    rings: [18, 22],
    panes: [10, 13],
    crystals: [4, 6],
    obstacles: [0, 1],
    hazardDensity: 0.15,
    speedScale: 0.92,
    weight: 0,
  },
  gallery: {
    kind: 'gallery',
    rings: [22, 28],
    panes: [11, 14],
    crystals: [4, 6],
    obstacles: [2, 4],
    hazardDensity: 0.45,
    speedScale: 1.0,
    weight: 5,
  },
  gauntlet: {
    kind: 'gauntlet',
    rings: [24, 30],
    panes: [11, 14],
    crystals: [4, 6],
    obstacles: [5, 8],
    hazardDensity: 0.85,
    speedScale: 1.06,
    weight: 3,
  },
  vault: {
    kind: 'vault',
    rings: [20, 26],
    panes: [12, 15],
    crystals: [5, 7],
    obstacles: [1, 2],
    hazardDensity: 0.25,
    speedScale: 0.95,
    weight: 2,
  },
  crucible: {
    kind: 'crucible',
    rings: [26, 32],
    panes: [12, 15],
    crystals: [4, 6],
    obstacles: [6, 9],
    hazardDensity: 1.0,
    speedScale: 1.12,
    weight: 0,
  },
  sanctum: {
    kind: 'sanctum',
    rings: [16, 20],
    panes: [10, 13],
    crystals: [5, 7],
    obstacles: [0, 0],
    hazardDensity: 0.0,
    speedScale: 0.88,
    weight: 0,
  },
});

/**
 * The zone skeleton, as offsets from the zone's last slot. Slot 0 is always the approach; the
 * last slot terminates the zone (a sanctum where the mode has checkpoints, a crucible where it
 * does not) and the slot before it is always the crucible, so every zone peaks then releases.
 */
export const ZONE_TERMINATOR_OFFSET_FROM_END = 1;
export const ZONE_CRUCIBLE_OFFSET_FROM_END = 2;
export const ZONE_APPROACH_SLOT = 0;

/** The kinds a mid-zone slot may draw. Fixed-role kinds are placed, never drawn. */
export const FREE_ROOM_POOL: readonly RoomKind[] = Object.freeze(['gallery', 'gauntlet', 'vault']);

/**
 * Depth raises DIFFICULTY, never SCORE DENSITY. Extra obstacles and extra pace, identical
 * panes and crystals - so zone 5 is harder to survive but worth the same per room, and rank
 * measures how well you played rather than how deep the run happened to get.
 */
export const OBSTACLE_RAMP_PER_ZONE = 0.75;
export const OBSTACLE_RAMP_CAP = 4;
export const HAZARD_DENSITY_RAMP_PER_ZONE = 0.04;
export const HAZARD_DENSITY_MAX = 1.0;

/** Endless keeps ramping past the last authored zone by pretending zones continue. */
export const ENDLESS_RAMP_ZONE_CAP = 12;

/* -------------------------------------------------------------------- rng stream separation */

/**
 * Distinct fork streams so adding a draw in one system cannot shift another system's
 * sequence. Room composition multiplies the index by a stride to keep neighbouring rooms
 * from sharing low bits.
 */
export const ROOM_STREAM_STRIDE = 0x2545f491;
export const ROOM_DETAIL_STREAM = 0x9e3779b1;

/* --------------------------------------------------------------------------- score weights */

export const POINTS_PER_PANE = 10;
export const POINTS_PER_CRYSTAL = 25;
export const POINTS_PER_DISTANCE_UNIT = 1;
export const POINTS_PER_ROOM = 100;
/** Awarded per room finished without a single impact. */
export const POINTS_PER_PERFECT_ROOM = 150;
/** Awarded per room, but only if the ENTIRE run took no impact. Scales, so it cannot dominate. */
export const POINTS_PER_FLAWLESS_ROOM = 100;

/**
 * Par is the yardstick every rank is measured against, set just above what one room yields at
 * a sustained x3 volley with the room finished untouched. B is therefore "played it well", and
 * A and S are reserved for players holding the top of the multiplier curve. Ranks are ratios
 * against par x rooms so an 11-room classic clear and a 40-room endless run share one curve.
 */
export const PAR_POINTS_PER_ROOM = 1000;
/** Divide-by-zero guard: a run that died in room one is still graded against one room of par. */
export const PAR_MIN_ROOMS = 1;

export type Rank = 'D' | 'C' | 'B' | 'A' | 'S';

export const RANKS: readonly Rank[] = Object.freeze(['D', 'C', 'B', 'A', 'S']);

export interface RankThreshold {
  readonly rank: Rank;
  /** Minimum score / par ratio. */
  readonly minRatio: number;
  /** S is the only rank that also demands the run took zero impacts. */
  readonly requiresFlawless: boolean;
}

/**
 * Descending, and the last entry MUST be reachable by any finished run (ratio 0, no flawless
 * requirement) or `rankFor` would have no answer.
 *
 * THE S THRESHOLD, STATED: score >= 1.30 x par AND zero impacts for the whole run. At par's
 * x2 baseline that is unreachable by definition - S requires a sustained x3+ volley carried
 * through every room without once touching glass.
 */
export const RANK_THRESHOLDS: readonly RankThreshold[] = Object.freeze([
  { rank: 'S', minRatio: 1.3, requiresFlawless: true },
  { rank: 'A', minRatio: 1.08, requiresFlawless: false },
  { rank: 'B', minRatio: 0.86, requiresFlawless: false },
  { rank: 'C', minRatio: 0.6, requiresFlawless: false },
  { rank: 'D', minRatio: 0, requiresFlawless: false },
]);

/** The stated S bar, exported so UI can show it without re-deriving it from the table. */
export const S_RANK_RATIO: number =
  RANK_THRESHOLDS.find((entry) => entry.rank === 'S')?.minRatio ?? Number.POSITIVE_INFINITY;

/* --------------------------------------------------------------------------- currencies */

/**
 * Two earned currencies, neither purchasable with money, ever. Shards are the fast loop -
 * every run pays some. Prisms are the slow loop - only completion pays them, so a new
 * universe is a thing you finished for, not a thing you ground for.
 */
export const SHARD_POINTS_DIVISOR = 40;
export const SHARDS_PER_ROOM = 2;
export const SHARDS_RANK_BONUS: Readonly<Record<Rank, number>> = Object.freeze({
  D: 0,
  C: 10,
  B: 30,
  A: 70,
  S: 150,
});

/**
 * Practice is deliberately absent: it exists so a player can learn a zone's layout without
 * pressure, and paying for it would turn the safe mode into the optimal grind.
 */
export const CURRENCY_AWARDING_MODES: readonly string[] = Object.freeze(['classic', 'endless']);

export const PRISMS_PER_ZONE_CLEAR = 1;
export const PRISMS_FIRST_ZONE_CLEAR = 2;
export const PRISMS_PER_NO_HIT_ZONE = 1;
export const PRISMS_PER_UNIVERSE_CLEAR = 5;
/** Endless pays prisms per full ROOMS_PER_ZONE block survived, but never a first-clear bonus. */
export const PRISMS_PER_ENDLESS_BLOCK = 1;
export const ENDLESS_PRISM_CAP_PER_RUN = 6;

/* ---------------------------------------------------------------------------- ball skins */

export type BallSkinId =
  | 'polished-steel'
  | 'obsidian-core'
  | 'brass-orrery'
  | 'frostglass'
  | 'meteoric-iron'
  | 'lumen-cell'
  | 'bone-ivory'
  | 'verdigris-bronze';

export const BALL_SKIN_IDS: readonly BallSkinId[] = Object.freeze([
  'polished-steel',
  'obsidian-core',
  'brass-orrery',
  'frostglass',
  'meteoric-iron',
  'lumen-cell',
  'bone-ivory',
  'verdigris-bronze',
]);

export interface BallSkinDef {
  readonly id: BallSkinId;
  readonly displayName: string;
  readonly shardCost: number;
  /** Skins are cosmetic only. This flag exists so the shop can say so and mean it. */
  readonly affectsGameplay: false;
}

export const DEFAULT_BALL_SKIN: BallSkinId = 'polished-steel';

export const BALL_SKINS: Readonly<Record<BallSkinId, BallSkinDef>> = Object.freeze({
  'polished-steel': { id: 'polished-steel', displayName: 'Polished Steel', shardCost: 0, affectsGameplay: false },
  'obsidian-core': { id: 'obsidian-core', displayName: 'Obsidian Core', shardCost: 400, affectsGameplay: false },
  'brass-orrery': { id: 'brass-orrery', displayName: 'Brass Orrery', shardCost: 750, affectsGameplay: false },
  frostglass: { id: 'frostglass', displayName: 'Frostglass', shardCost: 1100, affectsGameplay: false },
  'meteoric-iron': { id: 'meteoric-iron', displayName: 'Meteoric Iron', shardCost: 1600, affectsGameplay: false },
  'lumen-cell': { id: 'lumen-cell', displayName: 'Lumen Cell', shardCost: 2200, affectsGameplay: false },
  'bone-ivory': { id: 'bone-ivory', displayName: 'Bone Ivory', shardCost: 2900, affectsGameplay: false },
  'verdigris-bronze': { id: 'verdigris-bronze', displayName: 'Verdigris Bronze', shardCost: 3600, affectsGameplay: false },
});

/* --------------------------------------------------------------------------- unlock rules */

/** The one universe that is never locked, so a fresh save has somewhere to go. */
export const STARTER_UNIVERSE: UniverseId = 'void-cathedral';

/* -------------------------------------------------------- tier-dependent PRESENTATION only */

/**
 * The only numbers in this file allowed to vary by tier, and none of them can change a score.
 * Every field is derived from Quality rather than restated, so a tier edit lands here for free.
 */
export interface PresentationBudget {
  readonly tier: Tier;
  /** Debris pieces one pane bursts into. Purely visual: pane VALUE is POINTS_PER_PANE always. */
  readonly shardsPerPane: number;
  /** Rings instanced ahead of the player. Rooms are longer than this on every tier. */
  readonly streamAheadRings: number;
  /** Rooms kept resident behind the player before their geometry is recycled. */
  readonly trailingRoomsResident: number;
  /** Physics steps the fail sequence skips per simulated step. Motion axis, never graphics. */
  readonly failSlowMoFrameSkip: Frames;
}

/** Panes assumed to be mid-shatter at once when the shard pool is at its worst moment. */
const CONCURRENT_SHATTERS_ASSUMED = 8;
const SHARDS_PER_PANE_MIN = 24;
const SHARDS_PER_PANE_MAX = 220;
const TRAILING_ROOMS_RESIDENT = 1;

export function presentationBudget(budget: QualityBudget, motion: MotionRules): PresentationBudget {
  return {
    tier: budget.tier,
    shardsPerPane: clampInt(
      Math.floor(budget.maxShardsLive / CONCURRENT_SHATTERS_ASSUMED),
      SHARDS_PER_PANE_MIN,
      SHARDS_PER_PANE_MAX,
    ),
    streamAheadRings: budget.corridorRings,
    trailingRoomsResident: TRAILING_ROOMS_RESIDENT,
    failSlowMoFrameSkip: motion.slowMoFrameSkip,
  };
}

/** Convenience for call sites that hold only a tier (tools, tests, the debug menu). */
export const presentationBudgetFor = (tier: Tier): PresentationBudget =>
  presentationBudget(QUALITY[tier], MOTION[tier]);

/* ----------------------------------------------------------------------------- input feel */

/**
 * THE THREE SCHEMES ARE TUNED SEPARATELY BECAUSE THEY ARE NOT THE SAME GAME.
 *
 * A mouse is an ABSOLUTE pointing device, a stick is a RATE device and a thumb is a
 * RELATIVE one that also covers the thing it is aiming at. Sharing one set of numbers
 * between them is how two of the three end up feeling like a port: an absolute stick is
 * unusable, a rate-based mouse fights the cursor, and a mouse-tuned drag makes a phone
 * player wipe the screen to cross it. So each scheme gets its own block below and none of
 * them derives from another.
 *
 * These are FEEL, not budgets - a faster GPU does not want a wider deadzone - which is why
 * they live here beside the rest of the game's tuning rather than in core/Quality.ts. They
 * are the only numbers src/input is allowed to hold: every file in that folder imports this
 * table and none of them writes a threshold of its own.
 *
 * Touch distances are in THUMB TARGETS, not pixels, and the input layer multiplies them by
 * the 48px accessibility floor that ui/Focus.ts already owns. A gesture that has to cross
 * more than a whole tappable control before it stops being a tap is the same gesture on a
 * 360px phone and a 1200px tablet, which a pixel threshold is not.
 */
export const INPUT_FEEL = Object.freeze({
  pointer: Object.freeze({
    /**
     * One, and deliberately not a knob. The cursor IS the crosshair: any gain but unity
     * puts the reticle somewhere the operating system's own pointer is not, and the player
     * then has two crosshairs disagreeing. Smoothing is banned here for the same reason.
     */
    aimGain: 1,
    /** Aim-assist zoom while the focus button is held, as a fraction of the resting FOV. */
    focusFovScale: 0.72,
    /** How long that zoom takes to arrive. Presentation - the camera owns the easing. */
    focusEaseMs: 120 as Millis,
  }),
  pad: Object.freeze({
    /** Rescaled, not clipped: the reticle must not jump the moment the stick leaves centre. */
    deadzone: 0.16,
    /** Deflection counted as full. Sticks reach their gate long before they reach 1.0. */
    saturation: 0.94,
    /**
     * THE RETICLE CURVE. Above 1 the first half of the stick's travel is finer than the
     * second, which is the whole reason a pad can pick out a small pane at range: slow
     * precision near centre, fast traverse at the edge, one continuous function between.
     */
    responseExponent: 2.1,
    /** Normalised aim units per second at full deflection before the boost ramps in. */
    baseRatePerSec: 1.1,
    /** Extra units per second the boost adds once it is fully engaged. */
    boostRatePerSec: 2.4,
    /** Deflection past which the boost starts charging. Below it the boost bleeds away. */
    boostEngageDeflection: 0.68,
    /** Time at full deflection to reach the whole boost. Long enough to aim through. */
    boostRampMs: 260 as Millis,
    /** Faster than the ramp: the traverse must stop the moment the stick comes back. */
    boostDecayMs: 110 as Millis,
    /** Rate multiplier while the focus trigger is held. The pad's aim-assist is precision. */
    focusRateScale: 0.4,
    /** Analogue trigger pull that counts as a press, with hysteresis so it cannot chatter. */
    triggerThreshold: 0.55,
    triggerRelease: 0.35,
  }),
  touch: Object.freeze({
    /** Travel under this fraction of a thumb target is a tap. Thumbs roll; fingers do not. */
    tapSlopTargets: 0.3,
    /** A press longer than this is a drag even if it never moved. */
    tapMaxMs: 340 as Millis,
    /** Screen fraction to aim units. Above 1 so the thumb travels less than the reticle. */
    dragGain: 2.2,
    /** Downward travel, in thumb targets, that pauses the run. */
    pauseSwipeTargets: 2,
    pauseSwipeMaxMs: 520 as Millis,
    /** How far off vertical a pause swipe may wander, as a fraction of its own length. */
    pauseSwipeAxisRatio: 0.62,
    /** Gap inside which a second finger joins the first gesture instead of starting one. */
    twoFingerWindowMs: 220 as Millis,
    /** Longest a two-finger contact can last and still read as a tap rather than a hold. */
    twoFingerTapMaxMs: 340 as Millis,
  }),
  /**
   * THE ACCESSIBILITY MODE, AND WHY IT REPEATS.
   *
   * `controls.holdToThrow` exists for players who cannot tap repeatedly - an eleven-room
   * zone is several hundred taps. So holding the throw input throws again on an interval
   * instead of once, on every scheme, and the interval is floored by the throw cooldown
   * downstream so it can never out-run the ball economy.
   */
  holdToThrow: Object.freeze({
    /** Grace before the first repeat, so a deliberate single throw stays single. */
    firstRepeatMs: 240 as Millis,
    repeatMs: 150 as Millis,
  }),
});

/* ------------------------------------------------------------------------- self-validation */

/**
 * Balance can be internally wrong in ways TypeScript cannot see - an inverted range, a rank
 * table with no reachable floor, a checkpoint refill below the starting reserve. Tooling
 * should catch those, not a player.
 */
export function validateBalance(): string[] {
  const violations: string[] = [];

  for (const kind of ROOM_KINDS) {
    const profile = ROOM_PROFILES[kind];
    const ranges: readonly (readonly [string, readonly [number, number]])[] = [
      ['rings', profile.rings],
      ['panes', profile.panes],
      ['crystals', profile.crystals],
      ['obstacles', profile.obstacles],
    ];
    for (const [name, [min, max]] of ranges) {
      if (!Number.isInteger(min) || !Number.isInteger(max)) {
        violations.push(`room "${kind}": ${name} range [${min}, ${max}] must be integers`);
      }
      if (min > max) violations.push(`room "${kind}": ${name} range [${min}, ${max}] is inverted`);
      if (min < 0) violations.push(`room "${kind}": ${name} range starts below zero`);
    }
    if (!(profile.hazardDensity >= 0 && profile.hazardDensity <= HAZARD_DENSITY_MAX)) {
      violations.push(`room "${kind}": hazardDensity ${profile.hazardDensity} outside 0..${HAZARD_DENSITY_MAX}`);
    }
  }

  if (FREE_ROOM_POOL.length === 0) violations.push('FREE_ROOM_POOL is empty; mid-zone slots cannot be filled');
  for (const kind of FREE_ROOM_POOL) {
    if (ROOM_PROFILES[kind].weight <= 0) {
      violations.push(`room "${kind}" is in FREE_ROOM_POOL but has weight ${ROOM_PROFILES[kind].weight}`);
    }
  }

  // A zone needs an approach, a crucible and a terminator, so it cannot be shorter than three.
  const MIN_VIABLE_ZONE_ROOMS = ZONE_CRUCIBLE_OFFSET_FROM_END + ZONE_APPROACH_SLOT + 1;
  if (ROOMS_PER_ZONE < MIN_VIABLE_ZONE_ROOMS) {
    violations.push(`ROOMS_PER_ZONE ${ROOMS_PER_ZONE} cannot hold approach + crucible + sanctum`);
  }

  const floorEntry = RANK_THRESHOLDS[RANK_THRESHOLDS.length - 1];
  if (floorEntry === undefined) {
    violations.push('RANK_THRESHOLDS is empty; rankFor would have no answer');
  } else if (floorEntry.minRatio > 0 || floorEntry.requiresFlawless) {
    violations.push(`RANK_THRESHOLDS floor "${floorEntry.rank}" is not reachable by every finished run`);
  }
  for (let i = 1; i < RANK_THRESHOLDS.length; i += 1) {
    const above = RANK_THRESHOLDS[i - 1];
    const below = RANK_THRESHOLDS[i];
    if (above !== undefined && below !== undefined && above.minRatio <= below.minRatio) {
      violations.push(`RANK_THRESHOLDS not strictly descending at "${above.rank}" -> "${below.rank}"`);
    }
  }

  if (CHECKPOINT_BALL_FLOOR < BALL_PENALTY_ON_IMPACT) {
    violations.push(
      `CHECKPOINT_BALL_FLOOR ${CHECKPOINT_BALL_FLOOR} is below one impact (${BALL_PENALTY_ON_IMPACT}); a checkpoint would be a dead end`,
    );
  }
  if (BALLS_AT_START > BALLS_MAX) violations.push('BALLS_AT_START exceeds BALLS_MAX');
  if (BALL_COST_PER_THROW < 1) {
    violations.push(`BALL_COST_PER_THROW ${BALL_COST_PER_THROW} makes the reserve infinite`);
  }
  if (multiplierForStreak(CRYSTALS_PER_MULTIPLIER_STEP * MULTIPLIER_MAX) !== MULTIPLIER_MAX) {
    violations.push('multiplierForStreak does not saturate at MULTIPLIER_MAX');
  }
  if (BALL_SKINS[DEFAULT_BALL_SKIN].shardCost !== 0) {
    violations.push(`DEFAULT_BALL_SKIN "${DEFAULT_BALL_SKIN}" must be free; a fresh save owns it`);
  }
  if (BASE_SPEED_UNITS_PER_SEC > MAX_SPEED_UNITS_PER_SEC) {
    violations.push('BASE_SPEED_UNITS_PER_SEC exceeds MAX_SPEED_UNITS_PER_SEC');
  }

  return violations;
}

// Guarded rather than a bare import.meta.env.DEV so tooling outside Vite can import this file.
const IS_DEV: boolean = typeof import.meta.env === 'object' && import.meta.env.DEV === true;

if (IS_DEV) {
  const violations = validateBalance();
  if (violations.length > 0) {
    // Loud, but NOT a throw. This runs at module scope, so throwing here kills the import
    // of main.ts itself - the boot veil never gets its error handler and the player just
    // stares at "STARTING UP" forever. A tuning mistake must be shouted about, not fatal.
    console.error(
      `gameplay/Balance.ts is internally inconsistent:\n  ${violations.join('\n  ')}`,
    );
  }
}
