/**
 * CRYSTAL CLUSTERS, THE STREAK, AND THE MULTIPLIER LADDER.
 *
 * Crystals are the only thing in the corridor that pays the player back, and they are paid
 * out in the one currency there is: balls. They must be SHOT - flying through a cluster does
 * nothing. That single rule is what makes the ladder mean something, because it forces the
 * player to spend the resource they are trying to earn, on a target that is moving toward
 * them, while the run gets faster.
 *
 * THE LADDER PAYS IN SCORE, THE CLUSTER PAYS IN LIFE.
 * A cluster always grants AMMO_BALANCE.clusterGrant balls, flat, at every rung. Scaling the
 * ball grant with the multiplier was tried on paper and it breaks the game in both
 * directions: a hot run becomes unkillable and a cold run cannot recover, because the thing
 * you need to climb the ladder is the thing the ladder is withholding. Score scales; life
 * does not.
 *
 * A MISS RESETS TO x1. No decay, no partial rung, no grace. The reset has to be brutal or
 * the streak is not a tension mechanic, it is a progress bar.
 */

import { FIXED_STEP_MS, QUALITY, type Tier } from '../core/Quality';
import type { Alpha, Brand, Millis, Tickable, Unit } from '../core/types';
import { Ammo, Emitter, type Listener, type Unsubscribe } from './Ammo';
import { BALL_PHYSICS, type BallId, type BallProbe } from './Ball';

export type CrystalId = Brand<number, 'CrystalId'>;

const ID_SLOT_STRIDE = 1024;

/** The rungs. Non-linear on purpose: x5 and x10 must feel like they were earned, not counted. */
export const MULTIPLIER_LADDER = Object.freeze([1, 2, 3, 5, 10] as const);

export type Multiplier = (typeof MULTIPLIER_LADDER)[number];

export const CRYSTAL_BALANCE = Object.freeze({
  /** Crystals drawn per cluster. Purely how the cluster reads; the grant is per cluster. */
  crystalsPerCluster: 3,
  /**
   * Consecutive clusters needed to reach each rung of MULTIPLIER_LADDER. Index-aligned with
   * it, so the two arrays are one table split across two names.
   */
  streakForRung: Object.freeze([0, 3, 8, 15, 25] as const),
  /** Shot radius of a cluster. Generous: this is a reward, not a marksmanship test. */
  pickupRadius: 0.42,
  /** Metres past the player before an uncollected cluster counts as missed. */
  missBehindM: 1.5,
  scorePerCrystal: 10,
  /** How long the HUD's multiplier badge animates a rung change. */
  rungPulseMs: 320,
});

export type CrystalMissReason = 'passed' | 'obstacle-strike' | 'manual';

export type CrystalEvent =
  | {
      readonly kind: 'collect';
      readonly id: CrystalId;
      /** Where it popped, so the VFX layer can burst without querying back. */
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly crystals: number;
      readonly ballsGranted: number;
      readonly scoreGained: number;
      readonly streak: number;
      readonly multiplier: Multiplier;
    }
  | {
      readonly kind: 'miss';
      readonly reason: CrystalMissReason;
      readonly streakLost: number;
      readonly multiplierLost: Multiplier;
    }
  | {
      readonly kind: 'multiplier';
      readonly from: Multiplier;
      readonly to: Multiplier;
      readonly streak: number;
    };

/** Read-only face of a cluster. The renderer instances from these; nothing else may write. */
export interface CrystalClusterView {
  readonly id: CrystalId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly crystals: number;
  readonly radius: number;
  /** Stable 0..1 offset so a corridor of clusters does not spin in lockstep. */
  readonly phase: Unit;
}

class CrystalCluster implements CrystalClusterView {
  readonly index: number;
  id: CrystalId;
  x = 0;
  y = 0;
  z = 0;
  crystals: number = CRYSTAL_BALANCE.crystalsPerCluster;
  radius: number = CRYSTAL_BALANCE.pickupRadius;
  phase: Unit = 0;
  active = false;
  generation = 0;

  constructor(index: number) {
    this.index = index;
    this.id = index as CrystalId;
  }
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Deterministic per-cluster phase. A seeded Rng would also work but the field must not need
 * one injected just to stop its crystals rotating in unison - this is a hash, not a random.
 */
function hashPhase(serial: number): Unit {
  let h = (serial + 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

function rungForStreak(streak: number): number {
  let rung = 0;
  for (let i = 0; i < CRYSTAL_BALANCE.streakForRung.length; i += 1) {
    const threshold = CRYSTAL_BALANCE.streakForRung[i];
    if (threshold === undefined || streak < threshold) break;
    rung = i;
  }
  return rung;
}

function multiplierForRung(rung: number): Multiplier {
  return MULTIPLIER_LADDER[rung] ?? MULTIPLIER_LADDER[0];
}

export interface CrystalFieldOptions {
  readonly tier: Tier;
  readonly ammo: Ammo;
  /** Supplies live ball positions. BallPool implements it; a test can hand over a stub. */
  readonly balls: BallProbe;
}

export class CrystalField implements Tickable {
  readonly capacity: number;

  private readonly events = new Emitter<CrystalEvent>();
  private readonly ammo: Ammo;
  private readonly balls: BallProbe;
  private readonly clusters: CrystalCluster[] = [];
  private readonly liveClusters: CrystalCluster[] = [];
  private streakCount = 0;
  private rung = 0;
  private scoreTotal = 0;
  private serialCounter = 0;
  private playerZ = 0;
  /** Time since the last rung change, advanced on the fixed step so the pulse is stable. */
  private rungAgeMs: Millis = CRYSTAL_BALANCE.rungPulseMs;
  private rungPulseValue: Unit = 0;

  constructor(options: CrystalFieldOptions) {
    // At most one cluster per resident corridor ring: a cluster that is not in a ring the
    // generator is holding cannot be reached, so a larger pool would only be dead memory.
    this.capacity = QUALITY[options.tier].corridorRings;
    this.ammo = options.ammo;
    this.balls = options.balls;
    for (let i = 0; i < this.capacity; i += 1) this.clusters.push(new CrystalCluster(i));
  }

  get live(): readonly CrystalClusterView[] {
    return this.liveClusters;
  }

  get streak(): number {
    return this.streakCount;
  }

  get multiplier(): Multiplier {
    return multiplierForRung(this.rung);
  }

  /** Clusters still needed for the next rung, or null when already at the top. */
  get toNextRung(): number | null {
    const next = CRYSTAL_BALANCE.streakForRung[this.rung + 1];
    if (next === undefined) return null;
    return Math.max(0, next - this.streakCount);
  }

  get score(): number {
    return this.scoreTotal;
  }

  /** 1 immediately after a rung change, easing to 0. Presentation only - HUD reads it. */
  get rungPulse(): Unit {
    return this.rungPulseValue;
  }

  on(listener: Listener<CrystalEvent>): Unsubscribe {
    return this.events.on(listener);
  }

  setPlayerZ(z: number): void {
    this.playerZ = z;
  }

  /** Places a cluster. Returns null when the field is already holding `capacity` of them. */
  spawn(x: number, y: number, z: number, crystals = CRYSTAL_BALANCE.crystalsPerCluster): CrystalId | null {
    if (this.liveClusters.length >= this.capacity) return null;
    let cluster: CrystalCluster | null = null;
    for (const candidate of this.clusters) {
      if (!candidate.active) {
        cluster = candidate;
        break;
      }
    }
    if (cluster === null) return null;

    cluster.active = true;
    cluster.x = x;
    cluster.y = y;
    cluster.z = z;
    cluster.crystals = Math.max(1, Math.trunc(crystals));
    cluster.radius = CRYSTAL_BALANCE.pickupRadius;
    cluster.phase = hashPhase(++this.serialCounter);
    cluster.id = (cluster.generation * ID_SLOT_STRIDE + cluster.index) as CrystalId;
    this.liveClusters.push(cluster);
    return cluster.id;
  }

  /**
   * Collects a cluster that something already decided was hit. The field's own fixedUpdate
   * uses this too; it is public so a physics-driven sensor can drive collection instead.
   */
  collect(id: CrystalId): boolean {
    const index = this.indexOfLive(id);
    if (index < 0) return false;
    const cluster = this.liveClusters[index];
    if (cluster === undefined) return false;

    const ballsGranted = this.ammo.grantCluster();
    const scoreGained = cluster.crystals * CRYSTAL_BALANCE.scorePerCrystal * this.multiplier;
    this.scoreTotal += scoreGained;
    this.streakCount += 1;

    const before = this.multiplier;
    this.retune();
    const after = this.multiplier;

    this.events.emit({
      kind: 'collect',
      id: cluster.id,
      x: cluster.x,
      y: cluster.y,
      z: cluster.z,
      crystals: cluster.crystals,
      ballsGranted,
      scoreGained,
      streak: this.streakCount,
      multiplier: after,
    });
    if (after !== before) {
      this.events.emit({ kind: 'multiplier', from: before, to: after, streak: this.streakCount });
    }

    this.releaseAt(index);
    return true;
  }

  /**
   * Breaks the streak. Called by the field itself when a cluster escapes, and by the glass
   * layer when the player strikes an obstacle - both are misses and both cost the ladder.
   */
  registerMiss(reason: CrystalMissReason = 'manual'): void {
    // Always emitted, even at x1 with nothing to lose: an escaped cluster is a gameplay
    // event the HUD and the audio layer both react to, and swallowing it at the bottom rung
    // is exactly when the player most needs to be told they are missing.
    const streakLost = this.streakCount;
    const multiplierLost = this.multiplier;
    this.streakCount = 0;
    this.retune();
    this.events.emit({ kind: 'miss', reason, streakLost, multiplierLost });
    if (multiplierLost !== this.multiplier) {
      this.events.emit({
        kind: 'multiplier',
        from: multiplierLost,
        to: this.multiplier,
        streak: 0,
      });
    }
  }

  fixedUpdate(dt: Millis): void {
    this.rungAgeMs += dt;

    for (let i = this.liveClusters.length - 1; i >= 0; i -= 1) {
      const cluster = this.liveClusters[i];
      if (cluster === undefined) continue;

      const hitBy: BallId | null = this.balls.overlapSphere(
        cluster.x,
        cluster.y,
        cluster.z,
        cluster.radius,
      );
      if (hitBy !== null) {
        this.collect(cluster.id);
        continue;
      }

      // Forward is -Z, so a cluster with a greater Z than the player is behind them. The
      // ball radius is in the test because a cluster clipped by a ball on the way past was
      // hit, not missed.
      if (cluster.z - BALL_PHYSICS.radius > this.playerZ + CRYSTAL_BALANCE.missBehindM) {
        this.releaseAt(i);
        this.registerMiss('passed');
      }
    }
  }

  frame(alpha: Alpha): void {
    // Interpolating the age by alpha keeps the badge's pulse smooth at any presentation rate
    // while the value it animates still only changes on the fixed step.
    const age = this.rungAgeMs + clamp01(alpha) * FIXED_STEP_MS;
    const t = clamp01(age / CRYSTAL_BALANCE.rungPulseMs);
    // Cubic ease-out: the badge snaps and settles rather than fading linearly.
    const eased = 1 - t;
    this.rungPulseValue = eased * eased * eased;
  }

  /** Clears the field and the ladder. Run restart, not disposal. */
  reset(): void {
    for (let i = this.liveClusters.length - 1; i >= 0; i -= 1) this.releaseAt(i);
    this.streakCount = 0;
    this.rung = 0;
    this.scoreTotal = 0;
    this.serialCounter = 0;
    this.rungAgeMs = CRYSTAL_BALANCE.rungPulseMs;
    this.rungPulseValue = 0;
  }

  dispose(): void {
    this.reset();
    this.events.clear();
    this.clusters.length = 0;
  }

  private retune(): void {
    const next = rungForStreak(this.streakCount);
    if (next === this.rung) return;
    this.rung = next;
    this.rungAgeMs = 0;
  }

  private indexOfLive(id: CrystalId): number {
    for (let i = 0; i < this.liveClusters.length; i += 1) {
      const cluster = this.liveClusters[i];
      if (cluster !== undefined && cluster.id === id) return i;
    }
    return -1;
  }

  private releaseAt(index: number): void {
    const cluster = this.liveClusters[index];
    if (cluster === undefined) return;
    const last = this.liveClusters.pop();
    if (last !== undefined && last !== cluster) this.liveClusters[index] = last;
    cluster.active = false;
    cluster.generation += 1;
  }
}
