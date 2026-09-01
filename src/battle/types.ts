/**
 * The battle layer contract.
 *
 * A battle is a silent, looping, three-plane silhouette performance on the backdrop behind
 * the corridor. It never spawns geometry the player can hit and it never takes input. Its
 * ONLY channel into the playable space is the light bus (see universe/LightBus.ts): a beat
 * fires a LightEvent, the bus moves, and the corridor the player is inside changes colour.
 *
 * Timelines are authored data, validated on load, and driven by a seeded Rng so two players
 * on the same seed see the same performance. `Math.random()` and `Date.now()` are forbidden
 * anywhere on a runtime path - reproducibility is the whole reason this file exists.
 */

import type { Millis, Seed, Unit } from '../core/types';
import { asSeed } from '../core/types';
import type { LightBusState } from '../universe/LightBus';
import type { BattleRosterId } from '../universe/UniverseTheme';

/** Depth plane. `horizon` is furthest and slowest, `fore` is nearest and largest. */
export type ParallaxTier = 'horizon' | 'mid' | 'fore';

export const PARALLAX_TIERS: readonly ParallaxTier[] = Object.freeze(['horizon', 'mid', 'fore']);

/**
 * Shape vocabulary for the backdrop cast. Archetypes only - a silhouette is a mass and a
 * gait, never a recognisable design from anything that exists.
 */
export type SilhouetteId =
  | 'colossus'
  | 'lancer'
  | 'archer'
  | 'shieldbearer'
  | 'serpent'
  | 'wyrm'
  | 'rider'
  | 'harpooner'
  | 'stonewalker'
  | 'flock'
  | 'siege-frame'
  | 'standard-bearer';

/** Documentation aliases. Not branded: these ids only ever travel inside one roster. */
export type CombatantId = string;
export type BeatId = string;

/** Placement on the backdrop plane, in fractions so it survives any aspect ratio. */
export interface BackdropAnchor {
  /** -1 = far left of the backdrop, 0 = dead ahead down the corridor, +1 = far right. */
  readonly xFrac: number;
  /** 0 sits the figure's feet on the horizon line, +1 lifts them to the top of frame. */
  readonly yFrac: number;
}

export interface Combatant {
  readonly id: CombatantId;
  readonly tier: ParallaxTier;
  readonly silhouette: SilhouetteId;
  /** Fraction of backdrop width the figure occupies. */
  readonly widthFrac: Unit;
  /** Fraction of backdrop height the figure occupies. */
  readonly heightFrac: Unit;
  readonly anchor: BackdropAnchor;
  readonly opacity: Unit;
}

/** How a light event rises and falls. The shape is the drama; the peak is the amount. */
export type LightEventShape = 'strike' | 'swell' | 'pulse' | 'smother';

export interface LightEvent {
  readonly shape: LightEventShape;
  readonly attackMs: Millis;
  readonly holdMs: Millis;
  readonly releaseMs: Millis;
  /**
   * Light bus pose at the peak of the envelope. Channels left out are not touched, so two
   * overlapping events can own different channels without fighting.
   */
  readonly peak: Partial<LightBusState>;
}

export interface Beat {
  readonly id: BeatId;
  /** Human label for tooling and debug overlays; never shown to the player. */
  readonly title: string;
  readonly atMs: Millis;
  readonly durationMs: Millis;
  readonly light: LightEvent | null;
  /**
   * Delay between the flash and the pressure wave that follows it (dust shake, low rumble,
   * haze surge). Deliberately NOT zero: light and pressure arriving together read as a
   * screen effect, arriving apart they read as distance. See the 700-800ms law below.
   */
  readonly pressureDelayMs: Millis;
  /** A beat that deliberately does nothing, so the loud ones land. Every loop needs one. */
  readonly quiet: boolean;
}

export interface BeatTimeline {
  readonly rosterId: BattleRosterId;
  readonly loopMs: Millis;
  readonly beats: readonly Beat[];
}

export interface BattleRoster {
  readonly id: BattleRosterId;
  readonly displayName: string;
  readonly combatants: readonly Combatant[];
  readonly timeline: BeatTimeline;
}

/**
 * Timeline laws. These are dramaturgy invariants, not performance budgets, so they live
 * with the contract they constrain rather than in core/Quality.ts.
 */
export const BEATS_PER_TIMELINE = 10;
export const FINAL_HOLD_MIN_MS = 2800;
export const PRESSURE_DELAY_MIN_MS = 700;
export const PRESSURE_DELAY_MAX_MS = 800;

/**
 * Authoring aid: a tuple that only accepts exactly ten beats, so the count law is caught by
 * the compiler instead of at load. `BeatTimeline.beats` stays a plain readonly array because
 * everything downstream just iterates it.
 */
export type BeatDecad = readonly [Beat, Beat, Beat, Beat, Beat, Beat, Beat, Beat, Beat, Beat];

/** Returns every violation found; empty array means the timeline is legal. Never throws. */
export function validateTimeline(timeline: BeatTimeline): string[] {
  const violations: string[] = [];
  const where = `timeline "${timeline.rosterId}"`;
  const { beats } = timeline;

  if (beats.length !== BEATS_PER_TIMELINE) {
    violations.push(`law: ${where} has ${beats.length} beats, must have exactly ${BEATS_PER_TIMELINE}`);
  }

  const last = beats[beats.length - 1];
  if (last === undefined) {
    violations.push(`law: ${where} has no final hold beat`);
  } else if (last.durationMs < FINAL_HOLD_MIN_MS) {
    // The loop has to breathe before it repeats or the repetition becomes visible.
    violations.push(
      `law: ${where} final beat "${last.id}" holds ${last.durationMs}ms, must hold >= ${FINAL_HOLD_MIN_MS}ms`,
    );
  }

  if (!beats.some((beat) => beat.quiet)) {
    violations.push(`law: ${where} has no quiet beat - loud everywhere reads as flat`);
  }

  for (const beat of beats) {
    if (beat.light === null) continue;
    if (beat.pressureDelayMs < PRESSURE_DELAY_MIN_MS || beat.pressureDelayMs > PRESSURE_DELAY_MAX_MS) {
      violations.push(
        `law: ${where} beat "${beat.id}" has a light event with pressureDelayMs ${beat.pressureDelayMs}, ` +
          `must be ${PRESSURE_DELAY_MIN_MS}-${PRESSURE_DELAY_MAX_MS} so light and pressure stay desynced`,
      );
    }
  }

  if (!(Number.isFinite(timeline.loopMs) && timeline.loopMs > 0)) {
    violations.push(`sanity: ${where} loopMs must be finite and > 0`);
  }

  const seenIds = new Set<BeatId>();
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const beat of beats) {
    if (seenIds.has(beat.id)) violations.push(`sanity: ${where} duplicate beat id "${beat.id}"`);
    seenIds.add(beat.id);
    if (!(beat.atMs >= 0)) violations.push(`sanity: ${where} beat "${beat.id}" atMs must be >= 0`);
    if (!(beat.durationMs > 0)) violations.push(`sanity: ${where} beat "${beat.id}" durationMs must be > 0`);
    if (beat.atMs < previousEnd) {
      violations.push(`sanity: ${where} beat "${beat.id}" starts before the previous beat ends`);
    }
    if (beat.pressureDelayMs < 0) {
      violations.push(`sanity: ${where} beat "${beat.id}" pressureDelayMs must be >= 0`);
    }
    if (beat.light !== null && beat.quiet) {
      violations.push(`sanity: ${where} beat "${beat.id}" is quiet but carries a light event`);
    }
    previousEnd = beat.atMs + beat.durationMs;
  }
  if (previousEnd > timeline.loopMs) {
    violations.push(`sanity: ${where} beats run ${previousEnd}ms past a ${timeline.loopMs}ms loop`);
  }

  return violations;
}

/** Roster-level checks. Delegates to validateTimeline so callers need one entry point. */
export function validateRoster(roster: BattleRoster): string[] {
  const violations = validateTimeline(roster.timeline);
  const where = `roster "${roster.id}"`;

  if (roster.timeline.rosterId !== roster.id) {
    violations.push(`sanity: ${where} owns a timeline labelled "${roster.timeline.rosterId}"`);
  }
  if (roster.combatants.length === 0) {
    violations.push(`sanity: ${where} has no combatants`);
  }

  const seen = new Set<CombatantId>();
  const populatedTiers = new Set<ParallaxTier>();
  for (const combatant of roster.combatants) {
    if (seen.has(combatant.id)) violations.push(`sanity: ${where} duplicate combatant id "${combatant.id}"`);
    seen.add(combatant.id);
    populatedTiers.add(combatant.tier);
    if (!(combatant.widthFrac > 0 && combatant.widthFrac <= 1)) {
      violations.push(`sanity: ${where} combatant "${combatant.id}" widthFrac must be in (0,1]`);
    }
    if (!(combatant.heightFrac > 0 && combatant.heightFrac <= 1)) {
      violations.push(`sanity: ${where} combatant "${combatant.id}" heightFrac must be in (0,1]`);
    }
    if (!(combatant.opacity >= 0 && combatant.opacity <= 1)) {
      violations.push(`sanity: ${where} combatant "${combatant.id}" opacity must be in [0,1]`);
    }
  }
  if (!populatedTiers.has('horizon')) {
    violations.push(`sanity: ${where} has no horizon-tier figures - the backdrop loses its depth`);
  }

  return violations;
}

/**
 * Build a timeline from exactly ten beats and refuse to return an illegal one. This is the
 * intended authoring entry point: rosters call it at module scope, so a bad timeline fails
 * the build's first import rather than the player's tenth minute.
 */
export function defineTimeline(rosterId: BattleRosterId, loopMs: Millis, beats: BeatDecad): BeatTimeline {
  const timeline: BeatTimeline = { rosterId, loopMs, beats };
  const violations = validateTimeline(timeline);
  if (violations.length > 0) {
    throw new Error(`Invalid BeatTimeline:\n  ${violations.join('\n  ')}`);
  }
  return timeline;
}

/**
 * Deterministic random source. Every stochastic decision in the game - beat jitter, mote
 * placement, shard scatter, corridor variation - draws from one of these, never from
 * `Math.random()`, so a seed reproduces a run exactly.
 */
export interface Rng {
  readonly seed: Seed;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  bool(probability?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /**
   * Independent sub-stream. Systems fork rather than share so that adding a draw in one
   * system cannot shift the sequence every other system sees.
   */
  fork(stream: number): Rng;
}

/** Golden-ratio odd constant; standard mulberry32 mixing, chosen for speed and small state. */
const MULBERRY_INCREMENT = 0x6d2b79f5;
const FORK_MIX = 0x9e3779b9;

export function createRng(seed: Seed): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    seed,
    next,
    int: (minInclusive, maxExclusive) =>
      minInclusive + Math.floor(next() * Math.max(0, maxExclusive - minInclusive)),
    range: (min, max) => min + next() * (max - min),
    bool: (probability = 0.5) => next() < probability,
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError('Rng.pick called on an empty array');
      // Length is checked above, so the index is always in bounds despite the index signature.
      return items[Math.floor(next() * items.length)] as T;
    },
    fork: (stream) => createRng(asSeed(Math.imul(seed ^ stream, FORK_MIX))),
  };

  return rng;
}
