/**
 * THE SCORE CASCADE.
 *
 * ONE RULE GOVERNS THIS FILE: the total is the sum of the rows. Not approximately, not after
 * rounding, not "plus a bonus the UI adds later". A results screen that shows seven numbers
 * and an eighth that is not their sum teaches the player that the score is arbitrary, and a
 * player who believes the score is arbitrary stops chasing it. `assertScoreCloses` exists so
 * that belief can never be earned - it is checked in dev on every single run.
 *
 * Every row is `count x unit = points` with integer counts and integer units, so the cascade
 * closes in exact integer arithmetic with no float drift to reconcile.
 *
 * WHERE THE MULTIPLIER LIVES: the run banks each pane and each crystal at the multiplier that
 * was live when it happened (`RunSummary.bankedPoints`). The cascade shows the flat value of
 * those events first, then the multiplier carry - everything the multiplier added on top - as
 * its own row. That way the player sees both what they broke and what their streak was worth,
 * and the two still add up.
 */

import type { RunState, RunSummary } from './Run';
import {
  PAR_MIN_ROOMS,
  PAR_POINTS_PER_ROOM,
  POINTS_PER_CRYSTAL,
  POINTS_PER_DISTANCE_UNIT,
  POINTS_PER_FLAWLESS_ROOM,
  POINTS_PER_PANE,
  POINTS_PER_PERFECT_ROOM,
  POINTS_PER_ROOM,
  RANK_THRESHOLDS,
  S_RANK_RATIO,
  type Rank,
} from './Balance';

export type { Rank } from './Balance';
export { RANKS, S_RANK_RATIO } from './Balance';

export type ScoreRowId =
  | 'panes'
  | 'crystals'
  | 'multiplier-carry'
  | 'distance'
  | 'rooms'
  | 'perfect-rooms'
  | 'flawless-run';

export interface ScoreRow {
  readonly id: ScoreRowId;
  readonly label: string;
  readonly count: number;
  /**
   * Points each `count` is worth. The carry row's unit is 1 because its count is already
   * expressed in points - there is no smaller thing to multiply, and inventing one would
   * mean showing the player a unit the arithmetic does not actually use.
   */
  readonly unit: number;
  readonly points: number;
}

export interface ScoreBreakdown {
  readonly rows: readonly ScoreRow[];
  readonly total: number;
  /** What this many rooms is expected to yield at the x2 baseline. The rank denominator. */
  readonly par: number;
  readonly ratio: number;
  readonly rank: Rank;
  readonly flawless: boolean;
  /** Points still needed for the next rank up, or null at S. */
  readonly toNextRank: number | null;
  readonly nextRank: Rank | null;
}

const row = (id: ScoreRowId, label: string, count: number, unit: number): ScoreRow => ({
  id,
  label,
  count,
  unit,
  points: count * unit,
});

/** The tally the cascade needs. A subset of RunSummary so live HUD state can be scored too. */
export interface ScorableRun {
  readonly panesShattered: number;
  readonly crystalsCollected: number;
  readonly distance: number;
  readonly roomsCleared: number;
  readonly perfectRooms: number;
  readonly impacts: number;
  readonly bankedPoints: number;
}

/**
 * The multiplier carry. Non-negative by construction: `bankedPoints` weights every event by a
 * multiplier that is never below MULTIPLIER_MIN, so it can only ever meet or exceed flat.
 * Clamped anyway - a negative carry row would be a data bug, and showing a negative bonus is
 * a worse failure than showing zero.
 */
function multiplierCarry(run: ScorableRun): number {
  const flat = run.panesShattered * POINTS_PER_PANE + run.crystalsCollected * POINTS_PER_CRYSTAL;
  return Math.max(0, Math.round(run.bankedPoints) - flat);
}

export function scoreRun(run: ScorableRun): ScoreBreakdown {
  const flawless = run.impacts === 0 && run.roomsCleared > 0;

  const rows: readonly ScoreRow[] = [
    row('panes', 'Panes shattered', run.panesShattered, POINTS_PER_PANE),
    row('crystals', 'Crystals collected', run.crystalsCollected, POINTS_PER_CRYSTAL),
    // Unit 1 is an identity, not a weight: the carry count IS points. See ScoreRow.unit.
    row('multiplier-carry', 'Multiplier carry', multiplierCarry(run), 1),
    row('distance', 'Distance', Math.max(0, Math.floor(run.distance)), POINTS_PER_DISTANCE_UNIT),
    row('rooms', 'Rooms cleared', run.roomsCleared, POINTS_PER_ROOM),
    row('perfect-rooms', 'Untouched rooms', run.perfectRooms, POINTS_PER_PERFECT_ROOM),
    row('flawless-run', 'Flawless run', flawless ? run.roomsCleared : 0, POINTS_PER_FLAWLESS_ROOM),
  ];

  let total = 0;
  for (const entry of rows) total += entry.points;

  const par = Math.max(run.roomsCleared, PAR_MIN_ROOMS) * PAR_POINTS_PER_ROOM;
  const ratio = total / par;
  const rank = rankFor(ratio, flawless);
  const next = nextRankAbove(rank);

  return {
    rows,
    total,
    par,
    ratio,
    rank,
    flawless,
    nextRank: next?.rank ?? null,
    toNextRank: next === undefined ? null : Math.max(0, Math.ceil(next.minRatio * par) - total),
  };
}

/** Convenience overload for the results screen, which holds a summary rather than a tally. */
export const scoreSummary = (summary: RunSummary): ScoreBreakdown => scoreRun(summary);

/**
 * The HUD's running total. Same cascade, same weights, no bonuses withheld for the end -
 * a live number that jumps when the results screen opens is a live number nobody trusts.
 * Rows that only exist once a run is over (flawless) are simply zero until they are earned.
 */
export const liveTotal = (state: RunState): number => scoreRun(state).total;

/**
 * Descending walk, so the first satisfied threshold wins. A rank whose `requiresFlawless` is
 * set cannot be reached by a run that touched glass no matter how high the ratio climbed.
 */
export function rankFor(ratio: number, flawless: boolean): Rank {
  for (const entry of RANK_THRESHOLDS) {
    if (entry.requiresFlawless && !flawless) continue;
    if (ratio >= entry.minRatio) return entry.rank;
  }
  // Unreachable: validateBalance() proves the table's floor accepts every finished run.
  const floor = RANK_THRESHOLDS[RANK_THRESHOLDS.length - 1];
  if (floor === undefined) throw new Error('RANK_THRESHOLDS is empty; Balance validation should have caught this');
  return floor.rank;
}

function nextRankAbove(rank: Rank): { readonly rank: Rank; readonly minRatio: number } | undefined {
  const at = RANK_THRESHOLDS.findIndex((entry) => entry.rank === rank);
  if (at <= 0) return undefined;
  const above = RANK_THRESHOLDS[at - 1];
  return above === undefined ? undefined : { rank: above.rank, minRatio: above.minRatio };
}

/** The stated S bar, phrased for the UI so the requirement is never implied, only shown. */
export const S_RANK_REQUIREMENT = `${S_RANK_RATIO.toFixed(2)}x par with zero impacts`;

/**
 * Returns every way the cascade failed to close. Empty means the displayed total is provably
 * the sum of the displayed rows.
 */
export function assertScoreCloses(breakdown: ScoreBreakdown): string[] {
  const violations: string[] = [];

  let sum = 0;
  for (const entry of breakdown.rows) {
    if (!Number.isInteger(entry.count)) violations.push(`row "${entry.id}" count ${entry.count} is not an integer`);
    if (!Number.isInteger(entry.unit)) violations.push(`row "${entry.id}" unit ${entry.unit} is not an integer`);
    if (entry.count < 0) violations.push(`row "${entry.id}" count ${entry.count} is negative`);
    if (entry.points !== entry.count * entry.unit) {
      violations.push(`row "${entry.id}" claims ${entry.points} but ${entry.count} x ${entry.unit} = ${entry.count * entry.unit}`);
    }
    sum += entry.points;
  }

  if (sum !== breakdown.total) {
    violations.push(`rows sum to ${sum} but the total displayed is ${breakdown.total}`);
  }
  if (breakdown.rank === 'S' && !breakdown.flawless) {
    violations.push('rank S awarded to a run that took an impact');
  }

  return violations;
}

const IS_DEV: boolean = typeof import.meta.env === 'object' && import.meta.env.DEV === true;

/**
 * Dev-only gate on the one invariant this file exists to hold. Wrap every scoring call site
 * that produces a number a player will read.
 */
export function checkedScore(run: ScorableRun): ScoreBreakdown {
  const breakdown = scoreRun(run);
  if (IS_DEV) {
    const violations = assertScoreCloses(breakdown);
    if (violations.length > 0) {
      throw new Error(`Score cascade does not close:\n  ${violations.join('\n  ')}`);
    }
  }
  return breakdown;
}
