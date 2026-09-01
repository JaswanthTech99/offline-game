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
