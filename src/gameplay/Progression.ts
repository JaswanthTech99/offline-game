/**
 * WHAT THE PLAYER KEEPS.
 *
 * Two earned currencies and nothing else, ever:
 *
 *   SHARDS - the fast loop. Every classic or endless run pays some. They buy ball skins,
 *            which are cosmetic and say so in their own type (`affectsGameplay: false`).
 *   PRISMS - the slow loop. Only COMPLETION pays them: clearing a zone, clearing it clean,
 *            clearing a universe. They unlock universes. A player cannot grind prisms by
 *            replaying room one, because prisms are paid per zone finished, not per minute.
 *
 * Neither is purchasable with money and there is no code path in this file that could make
 * one so: nothing here accepts an external credit, only a RunSummary.
 *
 * Every function is a pure reducer returning a NEW state. The save layer owns persistence;
 * this module owns the rules. That split is what lets the whole economy be tested without a
 * database and migrated without a game loop.
 *
 * Unlock costs are NOT defined here. They live on the universe theme records, because the
 * cost of a universe is part of that universe's authored identity. This module reads them.
 */

import type { RunSummary } from './Run';
import type { ScoreBreakdown } from './Score';
import {
  BALL_SKINS,
  BALL_SKIN_IDS,
  CURRENCY_AWARDING_MODES,
  DEFAULT_BALL_SKIN,
  ENDLESS_PRISM_CAP_PER_RUN,
  PRISMS_FIRST_ZONE_CLEAR,
  PRISMS_PER_ENDLESS_BLOCK,
  PRISMS_PER_NO_HIT_ZONE,
  PRISMS_PER_UNIVERSE_CLEAR,
  PRISMS_PER_ZONE_CLEAR,
  RANKS,
  ROOMS_PER_ZONE,
  SHARDS_PER_ROOM,
  SHARDS_RANK_BONUS,
  SHARD_POINTS_DIVISOR,
  STARTER_UNIVERSE,
  ZONES_PER_UNIVERSE,
  type BallSkinId,
  type Rank,
} from './Balance';
import { UNIVERSE_IDS, type UniverseId, type UniverseTheme } from '../universe/UniverseTheme';

/** Bump when a field's MEANING changes; `normalizeProgression` is what handles the shape. */
export const PROGRESSION_VERSION = 1;

/**
 * The unlock-cost dependency, structurally typed so this module never imports the theme
 * table itself. Any `Record<UniverseId, UniverseTheme>` satisfies it, and so does a stub in
 * a test. Partial because a universe whose theme has not shipped yet is simply unbuyable.
 */
export type UnlockCostSource = Readonly<Partial<Record<UniverseId, Pick<UniverseTheme, 'unlockCostPrisms'>>>>;

export interface ZoneProgress {
  /** Index-aligned to authored zones, length ZONES_PER_UNIVERSE. */
  readonly cleared: readonly boolean[];
  /** Cleared without a single impact anywhere inside the zone. */
  readonly noHit: readonly boolean[];
}

export interface UniverseBest {
  readonly bestScore: number;
  readonly bestRank: Rank;
  readonly bestRooms: number;
  readonly bestDistance: number;
  readonly deepestZone: number;
  readonly runs: number;
  readonly panesShattered: number;
  /** True once any run in this universe finished with zero impacts. */
  readonly flawlessRun: boolean;
}

export interface ProgressionState {
  readonly version: number;
  readonly prisms: number;
  readonly shards: number;
  readonly unlocked: readonly UniverseId[];
  readonly ownedSkins: readonly BallSkinId[];
  readonly equippedSkin: BallSkinId;
  readonly bests: Readonly<Partial<Record<UniverseId, UniverseBest>>>;
  readonly zones: Readonly<Partial<Record<UniverseId, ZoneProgress>>>;
}

const LOWEST_RANK: Rank = RANKS[0] ?? 'D';

const rankIndex = (rank: Rank): number => RANKS.indexOf(rank);

const betterRank = (a: Rank, b: Rank): Rank => (rankIndex(a) >= rankIndex(b) ? a : b);

const emptyZoneProgress = (): ZoneProgress => ({
  cleared: new Array<boolean>(ZONES_PER_UNIVERSE).fill(false),
  noHit: new Array<boolean>(ZONES_PER_UNIVERSE).fill(false),
});

const emptyBest = (): UniverseBest => ({
  bestScore: 0,
  bestRank: LOWEST_RANK,
  bestRooms: 0,
  bestDistance: 0,
  deepestZone: 0,
  runs: 0,
  panesShattered: 0,
  flawlessRun: false,
});

/** A fresh save. The starter universe and the free skin are owned so the game is playable. */
export function createProgression(): ProgressionState {
  return {
    version: PROGRESSION_VERSION,
    prisms: 0,
    shards: 0,
    unlocked: [STARTER_UNIVERSE],
    ownedSkins: [DEFAULT_BALL_SKIN],
    equippedSkin: DEFAULT_BALL_SKIN,
    bests: {},
    zones: {},
  };
}

/* --------------------------------------------------------------------------- read helpers */

export const isUnlocked = (state: ProgressionState, universe: UniverseId): boolean =>
  universe === STARTER_UNIVERSE || state.unlocked.includes(universe);

export const ownsSkin = (state: ProgressionState, skin: BallSkinId): boolean =>
  skin === DEFAULT_BALL_SKIN || state.ownedSkins.includes(skin);

export const bestFor = (state: ProgressionState, universe: UniverseId): UniverseBest =>
  state.bests[universe] ?? emptyBest();

export const zonesFor = (state: ProgressionState, universe: UniverseId): ZoneProgress =>
  state.zones[universe] ?? emptyZoneProgress();

/** Null means the universe has no theme registered, which is different from "too expensive". */
export function unlockCost(costs: UnlockCostSource, universe: UniverseId): number | null {
  const theme = costs[universe];
  return theme === undefined ? null : theme.unlockCostPrisms;
}

/**
 * The highest zone the player may enter in this universe: one past the deepest they cleared,
 * capped at the last authored zone. Zone selection is a gate, not a menu of everything.
 */
export function highestSelectableZone(state: ProgressionState, universe: UniverseId): number {
  const cleared = zonesFor(state, universe).cleared;
  let deepest = 0;
  for (let zone = 0; zone < cleared.length; zone += 1) {
    if (cleared[zone] === true) deepest = zone + 1;
  }
  return Math.min(deepest, ZONES_PER_UNIVERSE - 1);
}

export const universeIsComplete = (state: ProgressionState, universe: UniverseId): boolean =>
  zonesFor(state, universe).cleared.every((done) => done);

export const universeIsFlawless = (state: ProgressionState, universe: UniverseId): boolean =>
  zonesFor(state, universe).noHit.every((clean) => clean);

/* ------------------------------------------------------------------------------- unlocks */

export type UnlockFailure = 'already-unlocked' | 'unknown-theme' | 'insufficient-prisms';

export type UnlockResult =
  | { readonly ok: true; readonly state: ProgressionState; readonly spent: number }
  | { readonly ok: false; readonly reason: UnlockFailure; readonly shortfall: number };

export function canUnlock(state: ProgressionState, universe: UniverseId, costs: UnlockCostSource): boolean {
  if (isUnlocked(state, universe)) return false;
  const cost = unlockCost(costs, universe);
  return cost !== null && state.prisms >= cost;
}

export function unlockUniverse(
  state: ProgressionState,
  universe: UniverseId,
  costs: UnlockCostSource,
): UnlockResult {
  if (isUnlocked(state, universe)) return { ok: false, reason: 'already-unlocked', shortfall: 0 };

  const cost = unlockCost(costs, universe);
  if (cost === null) return { ok: false, reason: 'unknown-theme', shortfall: 0 };
  if (state.prisms < cost) return { ok: false, reason: 'insufficient-prisms', shortfall: cost - state.prisms };

  return {
    ok: true,
    spent: cost,
    state: { ...state, prisms: state.prisms - cost, unlocked: [...state.unlocked, universe] },
  };
}

/** Every universe the player could unlock right now, in the order they were declared. */
export const affordableUnlocks = (state: ProgressionState, costs: UnlockCostSource): readonly UniverseId[] =>
  UNIVERSE_IDS.filter((id) => canUnlock(state, id, costs));

/* --------------------------------------------------------------------------- ball skins */

export type SkinFailure = 'already-owned' | 'insufficient-shards';

export type SkinPurchase =
  | { readonly ok: true; readonly state: ProgressionState; readonly spent: number }
  | { readonly ok: false; readonly reason: SkinFailure; readonly shortfall: number };

export function buyBallSkin(state: ProgressionState, skin: BallSkinId): SkinPurchase {
  if (ownsSkin(state, skin)) return { ok: false, reason: 'already-owned', shortfall: 0 };

  const cost = BALL_SKINS[skin].shardCost;
  if (state.shards < cost) return { ok: false, reason: 'insufficient-shards', shortfall: cost - state.shards };

  return {
    ok: true,
    spent: cost,
    state: { ...state, shards: state.shards - cost, ownedSkins: [...state.ownedSkins, skin] },
  };
}

/** Equipping something unowned is silently ignored rather than thrown: it is a UI race. */
export const equipBallSkin = (state: ProgressionState, skin: BallSkinId): ProgressionState =>
  ownsSkin(state, skin) ? { ...state, equippedSkin: skin } : state;

/* ------------------------------------------------------------------------- run settlement */

export interface RunAward {
  readonly prisms: number;
  readonly shards: number;
  readonly rank: Rank;
  readonly score: number;
  /** Zone indices cleared for the very first time this run. */
  readonly firstZoneClears: readonly number[];
  /** Zone indices whose first-ever impact-free clear happened this run. */
  readonly firstNoHitZones: readonly number[];
  readonly universeFirstClear: boolean;
  readonly newBestScore: boolean;
}

export interface SettledRun {
  readonly state: ProgressionState;
  readonly award: RunAward;
}

const modeAwardsCurrency = (mode: string): boolean => CURRENCY_AWARDING_MODES.includes(mode);

function shardsFor(summary: RunSummary, breakdown: ScoreBreakdown): number {
  if (!modeAwardsCurrency(summary.mode)) return 0;
  return (
    Math.floor(breakdown.total / SHARD_POINTS_DIVISOR) +
    summary.roomsCleared * SHARDS_PER_ROOM +
    SHARDS_RANK_BONUS[breakdown.rank]
  );
}

/**
 * The whole settlement in one pass: currencies, zone flags, no-hit flags and bests. It is a
 * single function because the awards depend on what was ALREADY recorded - splitting it would
 * mean a caller could pay a first-clear bonus twice by calling the parts out of order.
 */
export function settleRun(
  state: ProgressionState,
  summary: RunSummary,
  breakdown: ScoreBreakdown,
): SettledRun {
  const universe = summary.universe;
  const previousZones = zonesFor(state, universe);
  const cleared = previousZones.cleared.slice();
  const noHit = previousZones.noHit.slice();
  const noHitThisRun = new Set(summary.noHitZones);

  const firstZoneClears: number[] = [];
  const firstNoHitZones: number[] = [];
  let prisms = 0;

  if (modeAwardsCurrency(summary.mode)) {
    if (summary.mode === 'endless') {
      // Endless has no zones to complete, so it pays for raw depth instead - capped, because
      // an uncapped endless payout would make the authored universes pointless to finish.
      prisms = Math.min(
        ENDLESS_PRISM_CAP_PER_RUN,
        Math.floor(summary.roomsCleared / ROOMS_PER_ZONE) * PRISMS_PER_ENDLESS_BLOCK,
      );
    } else {
      // Cleared zones are contiguous from the zone the run started in.
      for (let offset = 0; offset < summary.zonesCleared; offset += 1) {
        const zone = summary.startZone + offset;
        if (zone < 0 || zone >= ZONES_PER_UNIVERSE) continue;

        prisms += PRISMS_PER_ZONE_CLEAR;
        if (cleared[zone] !== true) {
          cleared[zone] = true;
          firstZoneClears.push(zone);
          prisms += PRISMS_FIRST_ZONE_CLEAR;
        }
        if (noHitThisRun.has(zone) && noHit[zone] !== true) {
          noHit[zone] = true;
          firstNoHitZones.push(zone);
          prisms += PRISMS_PER_NO_HIT_ZONE;
        }
      }
    }
  }

  const wasComplete = previousZones.cleared.every((done) => done);
  const nowComplete = cleared.every((done) => done);
  const universeFirstClear = !wasComplete && nowComplete;
  if (universeFirstClear && modeAwardsCurrency(summary.mode)) prisms += PRISMS_PER_UNIVERSE_CLEAR;

  const shards = shardsFor(summary, breakdown);

  const previousBest = bestFor(state, universe);
  const newBestScore = breakdown.total > previousBest.bestScore;
  const nextBest: UniverseBest = {
    bestScore: Math.max(previousBest.bestScore, breakdown.total),
    bestRank: betterRank(previousBest.bestRank, breakdown.rank),
    bestRooms: Math.max(previousBest.bestRooms, summary.roomsCleared),
    bestDistance: Math.max(previousBest.bestDistance, Math.floor(summary.distance)),
    deepestZone: Math.max(previousBest.deepestZone, summary.deepestZone),
    runs: previousBest.runs + 1,
    panesShattered: previousBest.panesShattered + summary.panesShattered,
    flawlessRun: previousBest.flawlessRun || breakdown.flawless,
  };

  const bests: Partial<Record<UniverseId, UniverseBest>> = { ...state.bests };
  bests[universe] = nextBest;
  const zones: Partial<Record<UniverseId, ZoneProgress>> = { ...state.zones };
  zones[universe] = { cleared, noHit };

  return {
    state: { ...state, prisms: state.prisms + prisms, shards: state.shards + shards, bests, zones },
    award: {
      prisms,
      shards,
      rank: breakdown.rank,
      score: breakdown.total,
      firstZoneClears,
      firstNoHitZones,
      universeFirstClear,
      newBestScore,
    },
  };
}

/* -------------------------------------------------------------------------- save hygiene */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

const readFlags = (value: unknown): boolean[] => {
  const flags = new Array<boolean>(ZONES_PER_UNIVERSE).fill(false);
  if (!Array.isArray(value)) return flags;
  for (let zone = 0; zone < ZONES_PER_UNIVERSE; zone += 1) {
    flags[zone] = value[zone] === true;
  }
  return flags;
};

const readRank = (value: unknown): Rank => {
  const found = RANKS.find((rank) => rank === value);
  return found ?? LOWEST_RANK;
};

/**
 * Rebuilds a valid state from anything at all. A save file is untrusted input - it survives
 * version skew, hand-editing and half-finished writes - so the loader's job is to produce a
 * playable save, never to throw a player back to a fresh one over a single bad field.
 */
export function normalizeProgression(raw: unknown): ProgressionState {
  const base = createProgression();
  if (!isRecord(raw)) return base;

  const unlocked = UNIVERSE_IDS.filter(
    (id) => id === STARTER_UNIVERSE || (Array.isArray(raw['unlocked']) && raw['unlocked'].includes(id)),
  );
  const ownedSkins = BALL_SKIN_IDS.filter(
    (id) => id === DEFAULT_BALL_SKIN || (Array.isArray(raw['ownedSkins']) && raw['ownedSkins'].includes(id)),
  );
  const equippedRaw = raw['equippedSkin'];
  const equippedSkin = ownedSkins.find((id) => id === equippedRaw) ?? DEFAULT_BALL_SKIN;

  const bests: Partial<Record<UniverseId, UniverseBest>> = {};
  const zones: Partial<Record<UniverseId, ZoneProgress>> = {};
  const rawBests = raw['bests'];
  const rawZones = raw['zones'];

  for (const id of UNIVERSE_IDS) {
    if (isRecord(rawBests)) {
      const entry = rawBests[id];
      if (isRecord(entry)) {
        bests[id] = {
          bestScore: readCount(entry['bestScore']),
          bestRank: readRank(entry['bestRank']),
          bestRooms: readCount(entry['bestRooms']),
          bestDistance: readCount(entry['bestDistance']),
          deepestZone: Math.min(readCount(entry['deepestZone']), ZONES_PER_UNIVERSE - 1),
          runs: readCount(entry['runs']),
          panesShattered: readCount(entry['panesShattered']),
          flawlessRun: entry['flawlessRun'] === true,
        };
      }
    }
    if (isRecord(rawZones)) {
      const entry = rawZones[id];
      if (isRecord(entry)) {
        zones[id] = { cleared: readFlags(entry['cleared']), noHit: readFlags(entry['noHit']) };
      }
    }
  }

  return {
    version: PROGRESSION_VERSION,
    prisms: readCount(raw['prisms']),
    shards: readCount(raw['shards']),
    unlocked,
    ownedSkins,
    equippedSkin,
    bests,
    zones,
  };
}
