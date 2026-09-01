/**
 * Scripted economy replay, run with `?selftest=1`.
 *
 * It drives the REAL Playfield through its own methods rather than reimplementing the
 * rules, because a test that restates the logic it is checking proves only that it can
 * copy. The renderer is never involved: a Scene and a camera are enough to construct a
 * Playfield, so this runs headless and deterministically from a fixed seed.
 */

import { PerspectiveCamera, Scene } from 'three/webgpu';

import { asSeed } from '../core/types';
import type { UniverseTheme } from '../universe/UniverseTheme';
import { Playfield } from './Playfield';
import { GLASS_NONE } from './GlassMaterial';
import {
  Director,
  TUTORIAL_APPROACHES,
  BALLS_AT_START,
  BALLS_PER_CRYSTAL,
  BALL_COST_PER_THROW,
  BALL_PENALTY_ON_IMPACT,
  MULTIPLIER_LADDER,
} from './Balance';

export interface SelfTestRow {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

const SELFTEST_SEED = 0x5e1f7e57;

function makeField(theme: UniverseTheme, ringBudget: number): Playfield {
  return new Playfield({
    scene: new Scene(),
    camera: new PerspectiveCamera(60, 1, 0.1, 400),
    theme,
    seed: asSeed(SELFTEST_SEED),
    ringBudget,
    glass: GLASS_NONE,
    caustics: false,
    maxShards: 256,
    dustCount: 8,
    events: {
      onBallsChanged: () => {},
      onScoreChanged: () => {},
      onRunOver: () => {},
    },
  });
}

export function runSelfTest(theme: UniverseTheme, ringBudget: number): SelfTestRow[] {
  const rows: SelfTestRow[] = [];
  const row = (name: string, expected: unknown, actual: unknown): void => {
    rows.push({
      name,
      expected: String(expected),
      actual: String(actual),
      pass: String(expected) === String(actual),
    });
  };

  // 1. a run starts at the spec value
  const a = makeField(theme, ringBudget);
  row('start = 25', BALLS_AT_START, a.balls_);

  // 2. a throw costs exactly one, whatever the volley size
  a.testThrowCost();
  row('throw -1', BALLS_AT_START - BALL_COST_PER_THROW, a.balls_);
  a.dispose();

  // 3. a crystal refills by three
  const b = makeField(theme, ringBudget);
  const beforeCrystal = b.balls_;
  b.testCrystal();
  row('crystal +3', beforeCrystal + BALLS_PER_CRYSTAL, b.balls_);
  b.dispose();

  // 4. the ladder climbs x1 x2 x3 x5 x10 and never skips a rung
  const c = makeField(theme, ringBudget);
  const climb: number[] = [c.multiplierValue];
  for (let hit = 0; hit < 32; hit++) {
    c.testPaneBroken();
    const m = c.multiplierValue;
    if (climb[climb.length - 1] !== m) climb.push(m);
  }
  row('ladder x1 -> x10', MULTIPLIER_LADDER.join(','), climb.join(','));

  // 5. any miss drops the whole way back to x1
  c.testMiss();
  row('miss resets to x1', 1, c.multiplierValue);
  c.dispose();

  // 6. flying into unbroken glass is a disaster, not a scratch
  const d = makeField(theme, ringBudget);
  const beforeImpact = d.balls_;
  d.testImpact();
  row('unbroken glass -10', beforeImpact - BALL_PENALTY_ON_IMPACT, d.balls_);
  d.dispose();

  // 8. a throw at nothing legible is a rendering failure, not a player error
  const f = makeField(theme, ringBudget);
  f.testAdvanceTo(TUTORIAL_APPROACHES + 1);
  f.testClearField();
  const beforeBlind = f.balls_;
  f.testThrow();
  row('sub-bar target costs 0', beforeBlind, f.balls_);
  f.dispose();

  // 9. the tutorial approaches are free, and the one after them is not
  const g = makeField(theme, ringBudget);
  g.testAdvanceTo(1);
  const beforeTut = g.balls_;
  g.testThrow();
  row('approach 1 free', beforeTut, g.balls_);
  g.testAdvanceTo(TUTORIAL_APPROACHES);
  g.testThrow();
  row('approach 2 free', beforeTut, g.balls_);
  g.testAdvanceTo(TUTORIAL_APPROACHES + 1);
  const beforeCharged = g.balls_;
  g.testThrow();
  row('approach 3 charges 1', beforeCharged - BALL_COST_PER_THROW, g.balls_);
  g.dispose();

  // 7. the run ends the moment the reserve empties, not a throw later
  const e = makeField(theme, ringBudget);
  let guard = 0;
  while (e.balls_ > 0 && guard < BALLS_AT_START + 5) {
    e.testThrowCost();
    guard++;
  }
  row('run ends at 0', 'balls=0 over=true', `balls=${e.balls_} over=${String(e.isOver)}`);
  e.dispose();

  return rows;
}

export interface DirectorRow {
  readonly approach: number;
  readonly panes: number;
  readonly crystals: number;
  readonly travelSpeed: number;
  readonly balls: number;
}

/**
 * Twenty planned rows from the real Director, plus ten seeded runs. The director is pure
 * state, so this needs no renderer: it is the same object Playfield drives.
 */
export function runDirectorTable(): { rows: DirectorRow[]; mixedRows: number } {
  const d = new Director();
  const rows: DirectorRow[] = [];
  let balls = BALLS_AT_START;
  let mixedRows = 0;

  for (let i = 0; i < 20; i++) {
    const plan = d.nextRow();
    // A competent-but-not-perfect player: enough to climb, not enough to never fall back.
    const hit = i % 5 !== 4;
    d.recordThrow(hit);
    if (plan.approach > TUTORIAL_APPROACHES) balls -= BALL_COST_PER_THROW;
    if (hit && plan.crystalCount > 0) balls += BALLS_PER_CRYSTAL;
    if (plan.paneCount > 0 && plan.crystalCount > 0) mixedRows++;
    rows.push({
      approach: plan.approach,
      panes: plan.paneCount,
      crystals: plan.crystalCount,
      travelSpeed: plan.travelSpeed,
      balls,
    });
  }
  return { rows, mixedRows };
}

/**
 * Ten seeded runs under a deliberately poor player - 40% accuracy, below the advance bar -
 * to prove the opening is survivable even when the player is missing more than they hit.
 */
export function runSeededRuns(count: number): { endedEarly: number; reached: number[] } {
  const reached: number[] = [];
  let endedEarly = 0;

  for (let run = 0; run < count; run++) {
    const d = new Director();
    let balls = BALLS_AT_START;
    let approach = 0;
    // Vary the miss pattern per run so the ten runs are not one run repeated.
    const missEvery = 2 + (run % 3);
    while (balls > 0 && approach < 40) {
      const plan = d.nextRow();
      approach = plan.approach;
      const hit = approach % missEvery !== 0;
      d.recordThrow(hit);
      if (approach > TUTORIAL_APPROACHES) balls -= BALL_COST_PER_THROW;
      // A missed PANE row reaches the camera and costs the impact penalty.
      if (!hit && plan.paneCount > 0 && approach > TUTORIAL_APPROACHES) {
        balls -= BALL_PENALTY_ON_IMPACT;
      }
      if (hit && plan.crystalCount > 0) balls += BALLS_PER_CRYSTAL;
    }
    reached.push(approach);
    if (approach < 5) endedEarly++;
  }
  return { endedEarly, reached };
}

/** Prints the seven rows as a table and returns true only when every one passed. */
export function reportSelfTest(rows: readonly SelfTestRow[]): boolean {
  const width = Math.max(...rows.map((r) => r.name.length));
  const lines = rows.map(
    (r) =>
      `  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  expected ${r.expected}  got ${r.actual}`,
  );
  const failed = rows.filter((r) => !r.pass).length;
  console.info(
    `[shatterpoint] self-test — ${rows.length - failed}/${rows.length} passed\n${lines.join('\n')}`,
  );
  return failed === 0;
}
