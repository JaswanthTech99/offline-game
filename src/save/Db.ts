/**
 * THE SAVE. Local, offline, and the player's own property.
 *
 * One IndexedDB database, opened once, wrapped in a facade that speaks in GAME nouns -
 * progression, runs, bests, challenges, settings - so no caller ever writes a transaction.
 * That boundary is the point of the file: the moment a gameplay module knows a store name,
 * the save schema can no longer be migrated without reading the whole codebase.
 *
 * TWO BACKENDS, ONE INTERFACE
 *
 * IndexedDB is not always there. Private windows in some browsers expose it and then throw
 * on open; a locked-down enterprise profile hides it entirely; a headless test has no
 * origin. A game that is 100% offline cannot answer any of those with "please go online" -
 * it has to keep running. So `SaveBackend` has a real in-memory implementation that
 * satisfies every call, and `SaveDb.persistent` tells the UI the truth so it can say
 * "progress will not be kept" once, quietly, instead of failing later.
 *
 * WRITES ARE BATCHED, NOT CHATTY
 *
 * `saveProgression` is ~23 small records. They go through `putAll` as ONE transaction over
 * a scope filtered from `STORE_NAMES` in its canonical order, which is what keeps two
 * concurrent saves from deadlocking on opposite lock orders.
 *
 * NOTHING IN THIS FILE TOUCHES THE NETWORK, and nothing in it ever may.
 */

import { openDB } from 'idb';
import type { IDBPDatabase, StoreKey, StoreValue } from 'idb';

import { assertNever } from '../core/types';
import { BALL_SKIN_IDS, DEFAULT_BALL_SKIN } from '../gameplay/Balance';
import {
  PROGRESSION_VERSION,
  normalizeProgression,
  settleRun,
  type ProgressionState,
  type SettledRun,
} from '../gameplay/Progression';
import type { RunSummary } from '../gameplay/Run';
import { systemClock, type WallClock } from './WallClock';
import type { ScoreBreakdown } from '../gameplay/Score';
import { UNIVERSE_IDS, type UniverseId } from '../universe/UniverseTheme';
import {
  DB_NAME,
  DB_VERSION,
  PROFILE_KEY,
  SAVE_TOKENS,
  SETTINGS_KEY,
  STORE_NAMES,
  runUpgrade,
  type BestRecord,
  type ChallengeRecord,
  type EpochMs,
  type ProfileRecord,
  type RunRecord,
  type SaveStoreName,
  type SettingsRecord,
  type ShatterpointDb,
  type SkinRecord,
  type StoreWrite,
  type UniverseRecord,
} from './Schema';
import type { SettingsState } from './Settings';

/* ------------------------------------------------------------------------------- backend */

type StoreKeyOf<S extends SaveStoreName> = StoreKey<ShatterpointDb, S>;
type StoreValueOf<S extends SaveStoreName> = StoreValue<ShatterpointDb, S>;

/**
 * The storage primitives the facade needs and nothing more. Kept deliberately small: every
 * method added here must be implemented twice, and the second implementation is the one
 * that keeps the game playable when the first is unavailable.
 */
export interface SaveBackend {
  /** False for the in-memory fallback. The UI is entitled to tell the player. */
  readonly persistent: boolean;
  get<S extends SaveStoreName>(store: S, key: StoreKeyOf<S>): Promise<StoreValueOf<S> | undefined>;
  getAll<S extends SaveStoreName>(store: S): Promise<readonly StoreValueOf<S>[]>;
  putAll(writes: readonly StoreWrite[]): Promise<void>;
  delete<S extends SaveStoreName>(store: S, key: StoreKeyOf<S>): Promise<void>;
  clearAll(): Promise<void>;
  /** Newest first. Index-backed, because run history is the one store that grows. */
  recentRuns(limit: number): Promise<readonly RunRecord[]>;
  runsForUniverse(universe: UniverseId, limit: number): Promise<readonly RunRecord[]>;
  /** Drops the oldest runs beyond `keep`. Returns how many were removed. */
  pruneRuns(keep: number): Promise<number>;
  close(): void;
}

/**
 * The store key of a write, without a keyPath lookup. A switch rather than an index access
 * because the union is discriminated: the compiler proves every store is handled, and a
 * new store added to the schema is a compile error here rather than a silent dropped write.
 */
function keyOfWrite(write: StoreWrite): string {
  switch (write.store) {
    case 'profile':
      return write.value.id;
    case 'settings':
      return write.value.id;
    case 'runs':
      return write.value.runId;
    case 'universes':
      return write.value.universe;
    case 'skins':
      return write.value.skin;
    case 'challenges':
      return write.value.id;
    case 'bests':
      return write.value.universe;
    default:
      return assertNever(write, 'save/Db: keyOfWrite');
  }
}

const byEndedDesc = (a: RunRecord, b: RunRecord): number => b.endedAtMs - a.endedAtMs;

class IdbBackend implements SaveBackend {
  readonly persistent = true;

  constructor(private readonly db: IDBPDatabase<ShatterpointDb>) {}

  async get<S extends SaveStoreName>(store: S, key: StoreKeyOf<S>): Promise<StoreValueOf<S> | undefined> {
    return this.db.get(store, key);
  }

  async getAll<S extends SaveStoreName>(store: S): Promise<readonly StoreValueOf<S>[]> {
    return this.db.getAll(store);
  }

  async putAll(writes: readonly StoreWrite[]): Promise<void> {
    if (writes.length === 0) return;
    // Filtered from the canonical tuple so the lock scope is always acquired in one order.
    const scope = STORE_NAMES.filter((name) => writes.some((write) => write.store === name));
    const tx = this.db.transaction(scope, 'readwrite');
    // Requests are collected and settled WITH `tx.done` rather than awaited one at a time:
    // awaiting inside a transaction hands control back to the event loop, and a transaction
    // that finds no pending request when it gets there auto-commits underneath the rest of
    // the batch. Settling them together also means no request promise rejects unobserved.
    const ops = writes.map((write) => tx.objectStore(write.store).put(write.value));
    await Promise.all([...ops, tx.done]);
  }

  async delete<S extends SaveStoreName>(store: S, key: StoreKeyOf<S>): Promise<void> {
    await this.db.delete(store, key);
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction(STORE_NAMES, 'readwrite');
    const ops = STORE_NAMES.map((name) => tx.objectStore(name).clear());
    await Promise.all([...ops, tx.done]);
  }

  async recentRuns(limit: number): Promise<readonly RunRecord[]> {
    const out: RunRecord[] = [];
    const tx = this.db.transaction('runs', 'readonly');
    let cursor = await tx.store.index('by-ended').openCursor(null, 'prev');
    while (cursor !== null && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    await tx.done;
    return out;
  }

  async runsForUniverse(universe: UniverseId, limit: number): Promise<readonly RunRecord[]> {
    const rows = await this.db.getAllFromIndex('runs', 'by-universe', universe);
    return rows.sort(byEndedDesc).slice(0, limit);
  }

  async pruneRuns(keep: number): Promise<number> {
    const tx = this.db.transaction('runs', 'readwrite');
    const total = await tx.store.count();
    let excess = total - keep;
    if (excess <= 0) {
      await tx.done;
      return 0;
    }
    const ops: Promise<void>[] = [];
    // Ascending on the recency index: the first record the cursor sees is the oldest one.
    let cursor = await tx.store.index('by-ended').openCursor(null, 'next');
    while (cursor !== null && excess > 0) {
      ops.push(cursor.delete());
      excess -= 1;
      cursor = await cursor.continue();
    }
    await Promise.all([...ops, tx.done]);
    return ops.length;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The fallback. Same semantics, no durability - and it says so, so the facade above never
 * has to branch on which backend it got.
 */
class MemoryBackend implements SaveBackend {
  readonly persistent = false;

  private readonly stores = new Map<SaveStoreName, Map<string, unknown>>();

  constructor() {
    for (const name of STORE_NAMES) this.stores.set(name, new Map<string, unknown>());
  }

  async get<S extends SaveStoreName>(store: S, key: StoreKeyOf<S>): Promise<StoreValueOf<S> | undefined> {
    // Every store in the schema is keyed by a string subtype, so String() is lossless here.
    const found = this.bucket(store).get(String(key));
    return found === undefined ? undefined : (found as StoreValueOf<S>);
  }

  async getAll<S extends SaveStoreName>(store: S): Promise<readonly StoreValueOf<S>[]> {
    return [...this.bucket(store).values()] as StoreValueOf<S>[];
  }

  async putAll(writes: readonly StoreWrite[]): Promise<void> {
    for (const write of writes) this.bucket(write.store).set(keyOfWrite(write), write.value);
  }

  async delete<S extends SaveStoreName>(store: S, key: StoreKeyOf<S>): Promise<void> {
    this.bucket(store).delete(String(key));
  }

  async clearAll(): Promise<void> {
    for (const bucket of this.stores.values()) bucket.clear();
  }

  async recentRuns(limit: number): Promise<readonly RunRecord[]> {
    return (await this.allRuns()).sort(byEndedDesc).slice(0, limit);
  }

  async runsForUniverse(universe: UniverseId, limit: number): Promise<readonly RunRecord[]> {
    return (await this.allRuns())
      .filter((run) => run.universe === universe)
      .sort(byEndedDesc)
      .slice(0, limit);
  }

  async pruneRuns(keep: number): Promise<number> {
    const runs = (await this.allRuns()).sort(byEndedDesc);
    const doomed = runs.slice(keep);
    const bucket = this.bucket('runs');
    for (const run of doomed) bucket.delete(run.runId);
    return doomed.length;
  }

  close(): void {
    this.stores.clear();
  }

  private async allRuns(): Promise<RunRecord[]> {
    return [...this.bucket('runs').values()] as RunRecord[];
  }

  private bucket(name: SaveStoreName): Map<string, unknown> {
    const found = this.stores.get(name);
    if (found === undefined) throw new Error(`save/Db: no in-memory bucket for "${name}"`);
    return found;
  }
}

/* --------------------------------------------------------------------------------- open */

export interface SaveOptions {
  /** Database name. Overridden only by tests, which want an isolated origin-local db. */
  readonly name?: string | undefined;
  /** Skips IndexedDB entirely. The honest way for a test to exercise the fallback path. */
  readonly forceMemory?: boolean | undefined;
  /**
   * Ask the browser not to evict us. A fully offline game has nowhere to re-download a save
   * from, so it is worth asking even though most browsers will refuse without engagement.
   */
  readonly requestPersistence?: boolean | undefined;
  /** Another tab is holding an upgrade open. The UI should ask the player to close it. */
  readonly onBlocked?: (() => void) | undefined;
  /** A newer build in another tab wants to upgrade; this connection has been closed. */
  readonly onSuperseded?: (() => void) | undefined;
}

async function askForPersistence(): Promise<boolean> {
  const storage = globalThis.navigator?.storage;
  if (storage === undefined || typeof storage.persist !== 'function') return false;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}

/**
 * Opens the save. Never rejects: a machine that cannot give us a database still has to be
 * able to play, so every failure path lands on the in-memory backend.
 */
export async function openSave(options: SaveOptions = {}): Promise<SaveDb> {
  if (options.forceMemory === true || typeof globalThis.indexedDB === 'undefined') {
    return new SaveDb(new MemoryBackend());
  }

  try {
    const db = await openDB<ShatterpointDb>(options.name ?? DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion, newVersion, transaction) {
        runUpgrade({ db: database, tx: transaction, oldVersion, newVersion });
      },
      blocked() {
        options.onBlocked?.();
      },
      blocking() {
        // Holding the old version open would stall the new build forever. Close first, tell
        // the UI second: the connection is dead either way and pretending otherwise means
        // the next write throws InvalidStateError instead of reporting a stale tab.
        db.close();
        options.onSuperseded?.();
      },
      terminated() {
        options.onSuperseded?.();
      },
    });

    if (options.requestPersistence === true) await askForPersistence();
    return new SaveDb(new IdbBackend(db));
  } catch {
    return new SaveDb(new MemoryBackend());
  }
}

/* -------------------------------------------------------------------------------- export */

/** The offline backup envelope. This is the ONLY way a save leaves the machine. */
export interface SaveExport {
  readonly format: 'shatterpoint-save';
  readonly schemaVersion: number;
  readonly exportedAtMs: EpochMs;
  readonly profile: readonly ProfileRecord[];
  readonly settings: readonly SettingsRecord[];
  readonly runs: readonly RunRecord[];
  readonly universes: readonly UniverseRecord[];
  readonly skins: readonly SkinRecord[];
  readonly challenges: readonly ChallengeRecord[];
  readonly bests: readonly BestRecord[];
}

export interface ImportResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly progressionRestored: boolean;
}

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/* ------------------------------------------------------------------------------- facade */

export class SaveDb {
  /**
   * The clock is a constructor dependency rather than a wall-clock read at each call site: it
   * is the only nondeterminism in the save layer, and a test that wants to assert on a stored
   * timestamp has to be able to pin it. See save/WallClock.ts.
   */
  constructor(
    private readonly backend: SaveBackend,
    private readonly clock: WallClock = systemClock,
  ) {}

  /** False means the in-memory fallback: this session's progress dies with the tab. */
  get persistent(): boolean {
    return this.backend.persistent;
  }

  close(): void {
    this.backend.close();
  }

  /* ------------------------------------------------------------------------- progression */

  /**
   * Composes the normalised rows back into the single immutable value the gameplay reducers
   * want, then runs it through `normalizeProgression` - the same total function that guards
   * a hand-edited save - so a torn write can never produce an unplayable state.
   */
  async loadProgression(): Promise<ProgressionState> {
    const [profile, universes, skins, bests] = await Promise.all([
      this.backend.get('profile', PROFILE_KEY),
      this.backend.getAll('universes'),
      this.backend.getAll('skins'),
      this.backend.getAll('bests'),
    ]);

    return normalizeProgression({
      version: profile?.progressionVersion ?? PROGRESSION_VERSION,
      prisms: profile?.prisms ?? 0,
      shards: profile?.shards ?? 0,
      equippedSkin: profile?.equippedSkin ?? DEFAULT_BALL_SKIN,
      unlocked: universes.filter((row) => row.unlocked).map((row) => row.universe),
      ownedSkins: skins.filter((row) => row.owned).map((row) => row.skin),
      bests: Object.fromEntries(bests.map((row) => [row.universe, row])),
      zones: Object.fromEntries(
        universes.map((row) => [row.universe, { cleared: row.zonesCleared, noHit: row.zonesNoHit }]),
      ),
    });
  }

  /**
   * Writes a row for EVERY universe and EVERY skin, not just the owned ones. Totality is
   * what removes the delete path: progression only ever grows, and a row that says
   * `unlocked: false` is cheaper to overwrite than a missing row is to reason about.
   */
  async saveProgression(state: ProgressionState, nowMs: EpochMs = this.clock()): Promise<void> {
    const [existingProfile, existingUniverses, existingSkins] = await Promise.all([
      this.backend.get('profile', PROFILE_KEY),
      this.backend.getAll('universes'),
      this.backend.getAll('skins'),
    ]);

    const unlockedAt = new Map(existingUniverses.map((row) => [row.universe, row.unlockedAtMs]));
    const acquiredAt = new Map(existingSkins.map((row) => [row.skin, row.acquiredAtMs]));

    const profile: ProfileRecord = {
      id: PROFILE_KEY,
      progressionVersion: state.version,
      createdAtMs: existingProfile?.createdAtMs ?? nowMs,
      lastPlayedAtMs: nowMs,
      prisms: state.prisms,
      shards: state.shards,
      equippedSkin: state.equippedSkin,
      totalRuns: existingProfile?.totalRuns ?? 0,
      totalPlayMs: existingProfile?.totalPlayMs ?? 0,
    };

    const writes: StoreWrite[] = [{ store: 'profile', value: profile }];

    for (const universe of UNIVERSE_IDS) {
      const unlocked = state.unlocked.includes(universe);
      const zones = state.zones[universe];
      writes.push({
        store: 'universes',
        value: {
          universe,
          unlocked,
          // First unlock stamps the clock; later saves must not keep resetting it.
          unlockedAtMs: unlocked ? (unlockedAt.get(universe) ?? nowMs) : null,
          zonesCleared: zones?.cleared ?? [],
          zonesNoHit: zones?.noHit ?? [],
        },
      });

      const best = state.bests[universe];
      if (best !== undefined) {
        writes.push({ store: 'bests', value: { universe, ...best, updatedAtMs: nowMs } });
      }
    }

    for (const skin of BALL_SKIN_IDS) {
      const owned = state.ownedSkins.includes(skin);
      writes.push({
        store: 'skins',
        value: { skin, owned, acquiredAtMs: owned ? (acquiredAt.get(skin) ?? nowMs) : null },
      });
    }

    await this.backend.putAll(writes);
  }

  /* --------------------------------------------------------------------------------- runs */

  /**
   * The whole end-of-run commit in one call: settle the economy, persist the new state and
   * append the history row. It is one method because the three steps have an order - the
   * award depends on what was already recorded - and a caller that ran them out of order
   * would pay a first-clear bonus twice.
   */
  async commitRun(
    state: ProgressionState,
    summary: RunSummary,
    breakdown: ScoreBreakdown,
    nowMs: EpochMs = this.clock(),
  ): Promise<SettledRun> {
    const settled = settleRun(state, summary, breakdown);
    await this.saveProgression(settled.state, nowMs);
    await this.recordRun(summary, breakdown, nowMs);
    return settled;
  }

  /** Appends a history row and keeps the store inside its retention budget. */
  async recordRun(
    summary: RunSummary,
    breakdown: ScoreBreakdown,
    nowMs: EpochMs = this.clock(),
  ): Promise<RunRecord> {
    const record: RunRecord = {
      runId: summary.runId,
      endedAtMs: nowMs,
      universe: summary.universe,
      mode: summary.mode,
      seed: summary.seed,
      score: breakdown.total,
      rank: breakdown.rank,
      summary,
    };

    const profile = await this.backend.get('profile', PROFILE_KEY);
    const writes: StoreWrite[] = [{ store: 'runs', value: record }];
    if (profile !== undefined) {
      writes.push({
        store: 'profile',
        value: {
          ...profile,
          lastPlayedAtMs: nowMs,
          totalRuns: profile.totalRuns + 1,
          totalPlayMs: profile.totalPlayMs + summary.elapsedMs,
        },
      });
    }

    await this.backend.putAll(writes);
    await this.backend.pruneRuns(SAVE_TOKENS.runHistoryLimit);
    return record;
  }

  recentRuns(limit: number = SAVE_TOKENS.runQueryLimit): Promise<readonly RunRecord[]> {
    return this.backend.recentRuns(limit);
  }

  runsForUniverse(
    universe: UniverseId,
    limit: number = SAVE_TOKENS.runQueryLimit,
  ): Promise<readonly RunRecord[]> {
    return this.backend.runsForUniverse(universe, limit);
  }

  /* -------------------------------------------------------------------------------- bests */

  bests(): Promise<readonly BestRecord[]> {
    return this.backend.getAll('bests');
  }

  bestFor(universe: UniverseId): Promise<BestRecord | undefined> {
    return this.backend.get('bests', universe);
  }

  /* ----------------------------------------------------------------------------- settings */

  /**
   * Returns the raw row. Normalisation lives in `save/Settings.ts` with the defaults it
   * validates against - splitting the two would let one drift from the other.
   */
  loadSettingsRecord(): Promise<SettingsRecord | undefined> {
    return this.backend.get('settings', SETTINGS_KEY);
  }

  async saveSettings(state: SettingsState, nowMs: EpochMs = this.clock()): Promise<void> {
    await this.backend.putAll([
      { store: 'settings', value: { id: SETTINGS_KEY, updatedAtMs: nowMs, state } },
    ]);
  }

  /* --------------------------------------------------------------------------- challenges */

  challenges(): Promise<readonly ChallengeRecord[]> {
    return this.backend.getAll('challenges');
  }

  async putChallenges(records: readonly ChallengeRecord[]): Promise<void> {
    await this.backend.putAll(records.map((value) => ({ store: 'challenges', value }) as const));
  }

  /** Daily and weekly rows accumulate forever otherwise; authored ones never expire. */
  async dropExpiredChallenges(nowMs: EpochMs = this.clock()): Promise<number> {
    const rows = await this.backend.getAll('challenges');
    const doomed = rows.filter((row) => row.expiresAtMs <= nowMs);
    for (const row of doomed) await this.backend.delete('challenges', row.id);
    return doomed.length;
  }

  /* ------------------------------------------------------------------- backup and erasure */

  async exportSave(nowMs: EpochMs = this.clock()): Promise<SaveExport> {
    const [profile, settings, runs, universes, skins, challenges, bests] = await Promise.all([
      this.backend.getAll('profile'),
      this.backend.getAll('settings'),
      this.backend.getAll('runs'),
      this.backend.getAll('universes'),
      this.backend.getAll('skins'),
      this.backend.getAll('challenges'),
      this.backend.getAll('bests'),
    ]);

    return {
      format: 'shatterpoint-save',
      schemaVersion: DB_VERSION,
      exportedAtMs: nowMs,
      profile,
      settings,
      runs,
      universes,
      skins,
      challenges,
      bests,
    };
  }

  /**
   * Restores what can be restored SAFELY. An imported file is the most hostile input the
   * game will ever read - it arrives by clipboard from anywhere - so this path only accepts
   * rows it can put through a total normaliser, which today means the progression columns.
   *
   * TODO(step-2): per-record validators for `runs`, `challenges` and `settings` (a RunRecord
   * carries a whole RunSummary and cannot be trusted field-by-field without one), after
   * which those three stores join the restore.
   */
  async importSave(json: string): Promise<ImportResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, reason: 'not valid JSON', progressionRestored: false };
    }

    if (!isRecordLike(parsed) || parsed['format'] !== 'shatterpoint-save') {
      return { ok: false, reason: 'not a SHATTERPOINT save file', progressionRestored: false };
    }
    if (parsed['schemaVersion'] !== DB_VERSION) {
      return {
        ok: false,
        reason: `save is schema v${String(parsed['schemaVersion'])}, this build reads v${String(DB_VERSION)}`,
        progressionRestored: false,
      };
    }

    const profileRow = arrayOf(parsed['profile']).find(isRecordLike);
    const universeRows = arrayOf(parsed['universes']).filter(isRecordLike);
    const skinRows = arrayOf(parsed['skins']).filter(isRecordLike);
    const bestRows = arrayOf(parsed['bests']).filter(isRecordLike);

    const state = normalizeProgression({
      prisms: profileRow?.['prisms'],
      shards: profileRow?.['shards'],
      equippedSkin: profileRow?.['equippedSkin'],
      unlocked: universeRows.filter((row) => row['unlocked'] === true).map((row) => row['universe']),
      ownedSkins: skinRows.filter((row) => row['owned'] === true).map((row) => row['skin']),
      bests: Object.fromEntries(bestRows.map((row) => [String(row['universe']), row])),
      zones: Object.fromEntries(
        universeRows.map((row) => [
          String(row['universe']),
          { cleared: row['zonesCleared'], noHit: row['zonesNoHit'] },
        ]),
      ),
    });

    await this.saveProgression(state);
    return { ok: true, reason: null, progressionRestored: true };
  }

  /** Erases everything. The player asked; there is no copy anywhere else to fall back on. */
  async wipe(): Promise<void> {
    await this.backend.clearAll();
  }
}

/** Test seam: a SaveDb with no browser behind it, for pure logic tests of the facade. */
export const createMemorySave = (): SaveDb => new SaveDb(new MemoryBackend());
