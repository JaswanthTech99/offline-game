/**
 * THE SAVE SHAPE.
 *
 * SHATTERPOINT is fully offline. There is no account, no cloud slot, no telemetry endpoint
 * and no code path in this directory that could create one: nothing here imports fetch,
 * XMLHttpRequest, WebSocket or any network primitive, and nothing ever should. The player's
 * entire history lives in one IndexedDB database on their own machine, and the only way it
 * leaves is `SaveDb.exportSave()`, which hands them a JSON string they carry themselves.
 *
 * WHY SEVEN STORES AND NOT ONE BLOB
 *
 * `gameplay/Progression.ts` models what the player keeps as a single immutable
 * `ProgressionState`, because a reducer wants one value. Storage wants the opposite: a run
 * that finishes touches ONE universe, ONE best and appends ONE run row, and rewriting a
 * monolithic blob for that guarantees the whole save is in flight during the frame after
 * the run-end screen appears - which is exactly when a browser is most likely to be killed
 * on mobile. Normalised stores mean a settlement writes a handful of small records.
 *
 * `Db.ts` owns the bridge: it composes these rows into a `ProgressionState` on load and
 * decomposes one back into rows on save. Neither side knows the other's layout.
 *
 * VERSIONING
 *
 * `DB_VERSION` is the STRUCTURAL version - stores and indexes. `PROGRESSION_VERSION` (in
 * gameplay) is the SEMANTIC version of what the rows mean. They move independently: adding
 * an index is structural and does not touch gameplay; changing what `prisms` counts is
 * semantic and does not touch the schema. `runUpgrade` steps one structural version at a
 * time, so a save from any past version reaches the present by replaying the same ladder a
 * fresh install skips entirely.
 */

import type { DBSchema, IDBPDatabase, IDBPTransaction, StoreNames, StoreValue } from 'idb';

import type { RunId, Seed } from '../core/types';
import type { BallSkinId, Rank } from '../gameplay/Balance';
import type { RunMode, RunSummary } from '../gameplay/Run';
import type { UniverseId } from '../universe/UniverseTheme';
import type { SettingsState } from './Settings';

/**
 * Wall-clock milliseconds since the Unix epoch. Deliberately NOT `core/types.Millis`: that
 * alias means "a duration in the simulation", and an epoch stamp is not a duration. Mixing
 * them is how a save ends up sorting runs by how long they lasted.
 */
export type EpochMs = number;

export const DB_NAME = 'shatterpoint';

/** Structural schema version. Bump ONLY alongside a new case in `runUpgrade`. */
export const DB_VERSION = 1;

/**
 * Storage-retention policy and record identity - NOT performance budgets. core/Quality.ts
 * owns every number the profiler holds the game to; these decide how much disk a player's
 * history is allowed to occupy, which is the same class of decision as ui/Overlay.ts's
 * breakpoints and ui/Nav.ts's repeat rates and belongs with the thing it governs.
 */
export const SAVE_TOKENS = Object.freeze({
  /** Runs kept before the oldest are pruned. Enough for a meaningful history graph. */
  runHistoryLimit: 200,
  /** Rows a single `recentRuns` query will walk before giving up on the cursor. */
  runQueryLimit: 50,
  /** Sentinel expiry for a challenge that never lapses - see `ChallengeRecord.expiresAtMs`. */
  neverExpires: Number.MAX_SAFE_INTEGER,
});

/** Singleton row keys. Both stores hold exactly one record; the key names it. */
export const PROFILE_KEY = 'local';
export const SETTINGS_KEY = 'local';

export type ProfileKey = typeof PROFILE_KEY;
export type SettingsKey = typeof SETTINGS_KEY;

/* ------------------------------------------------------------------------------- records */

/**
 * The one-row header. Holds the currencies and the pointers that are true of the SAVE
 * rather than of any universe - everything per-universe lives in its own row so a
 * settlement never rewrites unrelated state.
 */
export interface ProfileRecord {
  readonly id: ProfileKey;
  /** Semantic version of the progression rules that wrote this row. */
  readonly progressionVersion: number;
  readonly createdAtMs: EpochMs;
  readonly lastPlayedAtMs: EpochMs;
  readonly prisms: number;
  readonly shards: number;
  readonly equippedSkin: BallSkinId;
  readonly totalRuns: number;
  /** Lifetime play time, summed from run summaries. */
  readonly totalPlayMs: number;
}

export interface SettingsRecord {
  readonly id: SettingsKey;
  readonly updatedAtMs: EpochMs;
  /**
   * Declared as the live shape for writers, but every READ goes through
   * `normalizeSettings`: a save file is untrusted input - it survives hand editing, version
   * skew and half-finished writes - so the loader's job is to produce a usable settings
   * object, never to throw a player at a broken options screen.
   */
  readonly state: SettingsState;
}

/**
 * One finished run. The full `RunSummary` is embedded rather than flattened because the
 * summary is the reducer's input: replaying settlement (after a rules fix, say) needs the
 * whole thing, and a run row that cannot be re-settled is a row that cannot be repaired.
 */
export interface RunRecord {
  readonly runId: RunId;
  readonly endedAtMs: EpochMs;
  readonly universe: UniverseId;
  readonly mode: RunMode;
  readonly seed: Seed;
  readonly score: number;
  readonly rank: Rank;
  readonly summary: RunSummary;
}

/** Per-universe unlock state and zone flags. Index-aligned to authored zones. */
export interface UniverseRecord {
  readonly universe: UniverseId;
  readonly unlocked: boolean;
  readonly unlockedAtMs: EpochMs | null;
  readonly zonesCleared: readonly boolean[];
  readonly zonesNoHit: readonly boolean[];
}

export interface SkinRecord {
  readonly skin: BallSkinId;
  readonly owned: boolean;
  readonly acquiredAtMs: EpochMs | null;
}

/** Per-universe personal records. Mirrors `Progression.UniverseBest` plus a write stamp. */
export interface BestRecord {
  readonly universe: UniverseId;
  readonly bestScore: number;
  readonly bestRank: Rank;
  readonly bestRooms: number;
  readonly bestDistance: number;
  readonly deepestZone: number;
  readonly runs: number;
  readonly panesShattered: number;
  readonly flawlessRun: boolean;
  readonly updatedAtMs: EpochMs;
}

/**
 * Challenges are GENERATED LOCALLY from a date-derived seed - there is no server handing
 * them out, and a player with no connection gets the same daily as everyone else because
 * the seed is the date, not a download.
 */
export type ChallengeKind = 'daily' | 'weekly' | 'authored';

export type ChallengeGoal =
  | { readonly kind: 'score'; readonly target: number }
  | { readonly kind: 'rooms'; readonly target: number }
  | { readonly kind: 'panes'; readonly target: number }
  | { readonly kind: 'flawless-zones'; readonly target: number };

export interface ChallengeRecord {
  readonly id: string;
  readonly kind: ChallengeKind;
  readonly universe: UniverseId;
  readonly mode: RunMode;
  readonly seed: Seed;
  readonly goal: ChallengeGoal;
  /**
   * `SAVE_TOKENS.neverExpires` rather than null for an authored challenge: a null keypath
   * value is silently ABSENT from an IndexedDB index, so a nullable expiry would quietly
   * hide every permanent challenge from the by-expiry cursor.
   */
  readonly expiresAtMs: EpochMs;
  readonly completed: boolean;
  readonly bestScore: number;
  readonly attempts: number;
  readonly lastAttemptAtMs: EpochMs | null;
}

/* -------------------------------------------------------------------------------- schema */

export interface ShatterpointDb extends DBSchema {
  profile: { key: ProfileKey; value: ProfileRecord };
  settings: { key: SettingsKey; value: SettingsRecord };
  runs: {
    key: RunId;
    value: RunRecord;
    indexes: {
      /** Recency cursor. Drives both the history screen and retention pruning. */
      'by-ended': EpochMs;
      'by-universe': UniverseId;
      'by-score': number;
    };
  };
  universes: { key: UniverseId; value: UniverseRecord };
  skins: { key: BallSkinId; value: SkinRecord };
  challenges: {
    key: string;
    value: ChallengeRecord;
    indexes: { 'by-expiry': EpochMs; 'by-kind': ChallengeKind };
  };
  bests: { key: UniverseId; value: BestRecord; indexes: { 'by-score': number } };
}

export type SaveStoreName = StoreNames<ShatterpointDb>;

/**
 * Ordered tuple rather than a bare array so a multi-store transaction always opens the same
 * scope - IndexedDB deadlocks are a function of scope ORDER, and one constant removes the
 * whole class of them.
 */
export const STORE_NAMES = Object.freeze([
  'profile',
  'settings',
  'runs',
  'universes',
  'skins',
  'challenges',
  'bests',
] as const satisfies readonly SaveStoreName[]);

/**
 * Every store is in-line keyed. That is what lets `SaveBackend.putAll` take a heterogeneous
 * batch of records with no key argument, and it is why the in-memory fallback backend can
 * derive a key from a value without knowing which store it came from.
 */
export const STORE_KEY_PATH: Readonly<Record<SaveStoreName, string>> = Object.freeze({
  profile: 'id',
  settings: 'id',
  runs: 'runId',
  universes: 'universe',
  skins: 'skin',
  challenges: 'id',
  bests: 'universe',
});

/**
 * A single typed write, discriminated by store. Distributing over the store union is what
 * keeps a batch write heterogeneous AND type-safe: the value type is pinned to the store
 * name in the same union member, so a `BestRecord` cannot be filed under `runs`.
 */
export type StoreWrite = {
  [S in SaveStoreName]: { readonly store: S; readonly value: StoreValue<ShatterpointDb, S> };
}[SaveStoreName];

/* ---------------------------------------------------------------------------- migrations */

export type UpgradeTransaction = IDBPTransaction<
  ShatterpointDb,
  StoreNames<ShatterpointDb>[],
  'versionchange'
>;

export interface UpgradeContext {
  readonly db: IDBPDatabase<ShatterpointDb>;
  /** In scope for the whole upgrade. A backfill migration reads old rows through this. */
  readonly tx: UpgradeTransaction;
  readonly oldVersion: number;
  readonly newVersion: number | null;
}

/** v0 -> v1. A fresh install: create every store and every index it will ever be read by. */
function installV1(ctx: UpgradeContext): void {
  const runs = ctx.db.createObjectStore('runs', { keyPath: STORE_KEY_PATH.runs });
  runs.createIndex('by-ended', 'endedAtMs');
  runs.createIndex('by-universe', 'universe');
  runs.createIndex('by-score', 'score');

  ctx.db.createObjectStore('profile', { keyPath: STORE_KEY_PATH.profile });
  ctx.db.createObjectStore('settings', { keyPath: STORE_KEY_PATH.settings });
  ctx.db.createObjectStore('universes', { keyPath: STORE_KEY_PATH.universes });
  ctx.db.createObjectStore('skins', { keyPath: STORE_KEY_PATH.skins });

  const challenges = ctx.db.createObjectStore('challenges', { keyPath: STORE_KEY_PATH.challenges });
  challenges.createIndex('by-expiry', 'expiresAtMs');
  challenges.createIndex('by-kind', 'kind');

  const bests = ctx.db.createObjectStore('bests', { keyPath: STORE_KEY_PATH.bests });
  bests.createIndex('by-score', 'bestScore');
}

/**
 * The upgrade ladder. One case per version boundary, each one stepping EXACTLY one version,
 * and the loop below climbing them in order. The usual IndexedDB idiom - a switch on
 * `oldVersion` with deliberate case fall-through - is not available here: `tsconfig` sets
 * `noFallthroughCasesInSwitch`, and the loop expresses the same ladder without relying on a
 * language feature the project has (correctly) banned.
 *
 * There is only one boundary today. The shape is the point: v2 is a new `case 1`, nothing
 * else moves, and a save written by any earlier build still arrives at the present.
 */
export function runUpgrade(ctx: UpgradeContext): void {
  const target = ctx.newVersion ?? DB_VERSION;

  for (let from = ctx.oldVersion; from < target; from += 1) {
    switch (from) {
      case 0:
        installV1(ctx);
        break;
      default:
        // Reached only by a database written by a FUTURE build - a player who rolled back.
        // Throwing aborts the version-change transaction, leaving their data untouched for
        // the newer build to find, which is strictly better than migrating it downward.
        throw new Error(`save/Schema: no upgrade path from schema v${String(from)} to v${String(target)}`);
    }
  }
}
