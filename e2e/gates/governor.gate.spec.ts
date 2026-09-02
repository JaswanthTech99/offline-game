import { expect, test } from '../fixtures/game';

/**
 * THE GOVERNOR GATE.
 *
 * The defect this exists to prevent: a OnePlus 12 booted MOBILE_ULTRA, rode the render
 * scale down to that tier's 0.8 floor, ran out of rungs, and then held a 33.2ms frame
 * against a 16.6ms budget for the rest of the session. FPS 41-52, FRAME 33.2/16.6 in red,
 * SCALE 1.00/1.00, nothing ever recovered - because scale was the only axis the governor
 * had and scale was already spent.
 *
 * WHY THIS GATE FEEDS SYNTHETIC NUMBERS RATHER THAN WAITING FOR SLOWNESS
 * The behaviour under test is measured in tens of thousands of frames: half a minute of
 * clean headroom before the first promotion, more after a demotion. Waiting for a real
 * device to throttle is neither deterministic nor runnable in CI, and a governor tuned by
 * whatever frame times a software rasteriser happened to post that afternoon is not tuned
 * at all. So the policy is driven directly:
 *
 *   1. `governorStep` in src/core/Quality.ts is a PURE reducer - state, frame time, limits
 *      in; next state and one action out. The first test feeds it a scripted thermal
 *      history and prints the whole trajectory.
 *   2. `Engine.feedGovernorFrames(frameMs, count)` is a TEST SEAM added to the engine for
 *      this gate (and for reproducing a phone's behaviour from a bug report). It pushes
 *      synthetic frame times through the real actuator, so the second test proves the
 *      reducer is actually WIRED - that a demotion moves the live tier and resizes the
 *      real backing store, not just a number in a struct.
 */

/** The device's own numbers, from the OnePlus 12 screenshots. */
const DEVICE_FRAME_MS = 33.2;
/** A frame time no tier can hold - proves the floor is a floor. */
const CLIFF_FRAME_MS = 200;
/** Comfortably inside MOBILE_ULTRA's budget, which is what a cooled phone posts. */
const COOL_FRAME_MS = 8;

interface GovState {
  readonly tier: string;
  readonly renderScale: number;
  readonly frames: number;
  readonly settle: number;
  readonly demotions: number;
  readonly tierOverFrames: number;
  readonly tierUnderFrames: number;
}

interface GovAction {
  readonly kind: string;
  readonly direction?: number;
  readonly to?: string | number;
}

interface QualityModule {
  newGovernorState(tier: string, renderScale: number): GovState;
  governorStep(
    state: GovState,
    frameMs: number,
    limits: { ceiling: string; floor: string },
  ): { state: GovState; action: GovAction };
  promoteThresholdFrames(demotions: number): number;
  TIER_LADDER: readonly string[];
  QUALITY: Record<string, { renderScale: number; renderScaleMin: number; targetFps: number }>;
}

interface Row {
  readonly phase: string;
  /** Frame number counted from the moment the governor was armed. */
  readonly at: number;
  readonly frameMs: number;
  readonly kind: string;
  readonly tierBefore: string;
  readonly scaleBefore: number;
  readonly tierAfter: string;
  readonly scaleAfter: number;
  readonly demotions: number;
  /** The tier's own scale floor at the moment of the action. Demotes must sit on it. */
  readonly floorScale: number;
}

interface Phase {
  readonly label: string;
  readonly frameMs: number;
  readonly frames: number;
}

const PHASES: readonly Phase[] = [
  // Hot phone, exactly what the device reported.
  { label: 'hot 33.2ms', frameMs: DEVICE_FRAME_MS, frames: 1500 },
  // Nothing can hold this. The governor must stop at MOBILE_LOW rather than invent a tier.
  { label: 'cliff 200ms', frameMs: CLIFF_FRAME_MS, frames: 1000 },
  // Cooled off. Recovery, and it must be slow.
  { label: 'cool 8.0ms', frameMs: COOL_FRAME_MS, frames: 14_000 },
];

function tableOf(rows: readonly Row[]): string {
  const head = 'phase        frame#  ms      action        tier                 scale       dem';
  const body = rows.map((r) => {
    const move =
      r.kind === 'tier'
        ? `${r.tierBefore} -> ${r.tierAfter}`
        : `${r.tierAfter}`;
    return [
      r.phase.padEnd(12),
      String(r.at).padStart(6),
      r.frameMs.toFixed(1).padStart(6),
      r.kind.padEnd(13),
      move.padEnd(20),
      `${r.scaleBefore.toFixed(2)}->${r.scaleAfter.toFixed(2)}`.padEnd(11),
      String(r.demotions).padStart(3),
    ].join(' ');
  });
  return [head, ...body].join('\n');
}

test('the policy drops scale first, then the tier, and climbs back far more slowly', async ({ game }) => {
  await game.boot({ seed: 1 });

  const rows = await game.page.evaluate(
    async ([phases, startTier, ceiling]): Promise<Row[]> => {
      // Assembled at runtime: Quality.ts reads import.meta.env, so it only resolves through
      // Vite. A literal specifier would be resolved by tsc, which has no dev server.
      const m = (await import(['', 'src', 'core', 'Quality.ts'].join('/'))) as unknown as QualityModule;

      const limits = { ceiling: ceiling as string, floor: 'MOBILE_LOW' };
      let state = m.newGovernorState(startTier as string, m.QUALITY[startTier as string]!.renderScale);
      const out: Row[] = [];
      let at = 0;

      for (const phase of phases as readonly Phase[]) {
        for (let i = 0; i < phase.frames; i += 1) {
          at += 1;
          const before = state;
          const step = m.governorStep(state, phase.frameMs, limits);
          state = step.state;
          if (step.action.kind === 'hold') continue;
          out.push({
            phase: phase.label,
            at,
            frameMs: phase.frameMs,
            kind: step.action.kind === 'tier' ? (step.action.direction === -1 ? 'tier DOWN' : 'tier UP') : (step.action.direction === -1 ? 'scale down' : 'scale up'),
            tierBefore: before.tier,
            scaleBefore: before.renderScale,
            tierAfter: state.tier,
            scaleAfter: state.renderScale,
            demotions: state.demotions,
            floorScale: m.QUALITY[before.tier]!.renderScaleMin,
          });
        }
        // A marker row at the end of every phase, so the table shows where it settled even
        // when the phase produced no action at all - which is itself the assertion for the
        // cliff phase.
        out.push({
          phase: phase.label,
          at,
          frameMs: phase.frameMs,
          kind: 'end of phase',
          tierBefore: state.tier,
          scaleBefore: state.renderScale,
          tierAfter: state.tier,
          scaleAfter: state.renderScale,
          demotions: state.demotions,
          floorScale: m.QUALITY[state.tier]!.renderScaleMin,
        });
      }
      return out;
    },
    [PHASES, 'MOBILE_ULTRA', 'MOBILE_ULTRA'] as const,
  );

  console.log(`governor trajectory (start MOBILE_ULTRA, ceiling MOBILE_ULTRA):\n${tableOf(rows)}`);

  const moves = rows.filter((r) => r.kind !== 'end of phase');
  expect(moves.length, 'the governor never moved at all').toBeGreaterThan(0);

  // ---- 1. the fine axis is tried first ----------------------------------------------
  const firstMove = moves[0]!;
  expect(firstMove.kind, 'the first move must be a scale drop, not a tier demotion').toBe('scale down');

  // ---- 2. a tier only ever drops from that tier's scale FLOOR ------------------------
  for (const r of moves.filter((m) => m.kind === 'tier DOWN')) {
    expect(
      r.scaleBefore,
      `demoted ${r.tierBefore} at scale ${r.scaleBefore}, which is not that tier's floor ${r.floorScale}`,
    ).toBeCloseTo(r.floorScale, 5);
  }

  // ---- 3. the hot phase reaches the floor tier and the cliff cannot push past it -----
  const hotEnd = rows.find((r) => r.kind === 'end of phase' && r.phase === 'hot 33.2ms')!;
  expect(hotEnd.tierAfter, '33.2ms frames must walk MOBILE_ULTRA down to the floor tier').toBe('MOBILE_LOW');
  const cliffEnd = rows.find((r) => r.kind === 'end of phase' && r.phase === 'cliff 200ms')!;
  expect(cliffEnd.tierAfter, 'the governor demoted below MOBILE_LOW').toBe('MOBILE_LOW');
  expect(
    rows.every((r) => r.tierAfter !== 'MOBILE_LOW' || r.scaleAfter >= r.floorScale - 1e-6),
    'render scale fell below the floor tier window',
  ).toBe(true);

  // ---- 4. recovery happens, stops at the ceiling, and is far slower than the fall ----
  const coolEnd = rows.find((r) => r.kind === 'end of phase' && r.phase === 'cool 8.0ms')!;
  expect(coolEnd.tierAfter, 'a cooled device never climbed back').toBe('MOBILE_ULTRA');
  expect(
    rows.every((r) => r.tierAfter !== 'DESKTOP_HIGH' && r.tierAfter !== 'ULTRA_4K' && r.tierAfter !== 'SHOWCASE'),
    'the governor promoted past its ceiling',
  ).toBe(true);

  const firstDemote = moves.find((r) => r.kind === 'tier DOWN')!;
  const firstPromote = moves.find((r) => r.kind === 'tier UP')!;
  const coolStart = PHASES[0]!.frames + PHASES[1]!.frames;
  const fallFrames = firstDemote.at;
  const climbFrames = firstPromote.at - coolStart;
  console.log(
    `asymmetry: first demotion after ${String(fallFrames)} frames, ` +
      `first promotion after ${String(climbFrames)} clean frames (${(climbFrames / fallFrames).toFixed(1)}x slower)`,
  );
  expect(
    climbFrames / fallFrames,
    'promotion is not markedly slower than demotion - a throttling phone will thrash',
  ).toBeGreaterThan(10);

  // ---- 5. every demotion makes the next promotion harder -----------------------------
  const thresholds = await game.page.evaluate(async () => {
    const m = (await import(['', 'src', 'core', 'Quality.ts'].join('/'))) as unknown as QualityModule;
    return [0, 1, 2, 3, 4, 5].map((d) => m.promoteThresholdFrames(d));
  });
  console.log(`promotion threshold by demotion count: ${thresholds.join(', ')} frames`);
  expect(thresholds[1]!, 'a demotion did not make the next promotion harder').toBeGreaterThan(thresholds[0]!);
  expect(thresholds[2]!).toBeGreaterThan(thresholds[1]!);
  // ...but not infinitely harder, or a device that cooled down can never recover.
  expect(thresholds[5]!).toBe(thresholds[4]!);
});

interface EngineLike {
  stop(): void;
  start(): void;
  setTierOverride(tier: string): void;
  feedGovernorFrames(frameMs: number, count: number): void;
  readonly renderScale: number;
  readonly governorCeiling: string;
  readonly governorActive: boolean;
  readonly quality: { readonly graphics: string };
  readonly governor: { readonly demotions: number; readonly tierOverFrames: number };
}

interface LiveRow {
  readonly fedFrames: number;
  readonly tier: string;
  readonly scale: number;
  readonly demotions: number;
  /**
   * Width of the SCENE PASS, not of the canvas. Engine only sizes the drawing buffer for
   * the supersampling part of the scale; everything at or below 1.0 is applied by the post
   * chain, which learns it from `engine:resize`. So this is the number that proves a drop
   * reached the GPU rather than just a field on the Engine.
   */
  readonly scenePassWidth: number;
}

/**
 * The wiring half. The reducer above can be perfect and the phone still stuck, if nothing
 * applies its verdict - which is precisely the shape of the original bug.
 */
test('the live engine applies the demotion: real tier, real backing store', async ({ game }) => {
  await game.boot({ tier: 'MOBILE_ULTRA', seed: 1 });

  const result = await game.page.evaluate(
    ([frameMs, chunk, chunks]) => {
      const app = (window as unknown as { __shatterpoint__?: { engine: EngineLike } }).__shatterpoint__;
      if (app === undefined) {
        return { error: 'no __shatterpoint__ on window', rows: [] as LiveRow[], pinned: {} };
      }
      const engine = app.engine;

      // rAF would keep feeding real frame times into the same governor and interleave with
      // ours. Stopping is the whole reason the seam is safe to use.
      engine.stop();

      // FIRST: the page was booted with ?tier=, which pins both axes so a tier-named e2e
      // project keeps capturing the tier it is named after. Prove the pin holds under the
      // same frame times that will shortly walk an unpinned engine to the floor.
      const pinnedBefore = {
        active: engine.governorActive,
        tier: engine.quality.graphics,
        scale: engine.renderScale,
      };
      engine.feedGovernorFrames(frameMs, chunk * chunks);
      const pinned = {
        ...pinnedBefore,
        afterTier: engine.quality.graphics,
        afterScale: engine.renderScale,
      };

      // Two explicit sets: a runtime choice unpins the governor, and the second re-arms it
      // from zero regardless of whatever the real frames before this test accumulated.
      engine.setTierOverride('MOBILE_HIGH');
      engine.setTierOverride('MOBILE_ULTRA');

      const scenePass = (): number =>
        (window.__sp?.snapshot() as { scenePassWidth?: number } | undefined)?.scenePassWidth ?? 0;
      const sample = (fedFrames: number): LiveRow => ({
        fedFrames,
        tier: engine.quality.graphics,
        scale: engine.renderScale,
        demotions: engine.governor.demotions,
        scenePassWidth: scenePass(),
      });

      const rows: LiveRow[] = [];
      let fed = 0;
      rows.push(sample(fed));
      for (let i = 0; i < chunks; i += 1) {
        engine.feedGovernorFrames(frameMs, chunk);
        fed += chunk;
        rows.push(sample(fed));
      }
      const ceiling = engine.governorCeiling;
      engine.start();
      return { error: '', rows, ceiling, pinned };
    },
    [DEVICE_FRAME_MS, 40, 24] as const,
  );

  expect(result.error).toBe('');

  const pinned = result.pinned as {
    active: boolean; tier: string; scale: number; afterTier: string; afterScale: number;
  };
  expect(pinned.active, 'a boot-time ?tier= must pin the governor').toBe(false);
  expect(pinned.afterTier, 'the governor overruled a pinned tier').toBe(pinned.tier);
  expect(pinned.afterScale, 'the governor overruled a pinned scale').toBe(pinned.scale);

  const rows = result.rows;
  const table = [
    'fed#   tier          scale  dem  scene pass',
    ...rows.map(
      (r) =>
        `${String(r.fedFrames).padStart(5)}  ${r.tier.padEnd(13)}${r.scale.toFixed(2)}   ${String(r.demotions).padStart(3)}  ${String(r.scenePassWidth)}px`,
    ),
  ].join('\n');
  console.log(`live engine at ${String(DEVICE_FRAME_MS)}ms/frame:\n${table}`);

  const tiers = rows.map((r) => r.tier);
  expect(tiers[0], 'the engine did not start on the tier the gate pinned').toBe('MOBILE_ULTRA');
  expect(tiers.includes('MOBILE_HIGH'), 'the live engine never demoted the tier').toBe(true);
  expect(tiers.at(-1), 'the live engine did not walk all the way down under a 33.2ms frame').toBe('MOBILE_LOW');
  expect(rows.at(-1)!.demotions, 'demotions were not counted').toBeGreaterThanOrEqual(2);

  // The demotion has to be real all the way through to the swap chain, or it bought nothing.
  const first = rows[0]!;
  const last = rows.at(-1)!;
  expect(last.scale, 'the scale never left the MOBILE_ULTRA floor').toBeLessThan(first.scale);
  expect(
    last.scenePassWidth,
    'the scene pass never actually shrank - the scale drop reached the Engine and stopped there',
  ).toBeLessThan(first.scenePassWidth);
  /**
   * The ceiling is allowed to sit ABOVE the tier that was asked for - the device class is a
   * floor on it, so an unlucky boot measurement cannot lock a machine out of its own tier -
   * but it may never sit below, or a cooled device could never recover the tier it lost.
   */
  const LADDER = ['MOBILE_LOW', 'MOBILE_HIGH', 'MOBILE_ULTRA', 'DESKTOP_HIGH', 'ULTRA_4K', 'SHOWCASE'];
  expect(
    LADDER.indexOf(result.ceiling ?? ''),
    `the governor's ceiling ${String(result.ceiling)} sits below the tier that was asked for`,
  ).toBeGreaterThanOrEqual(LADDER.indexOf('MOBILE_ULTRA'));
  // Nothing above the ceiling was ever entered - the run only ever fed over-budget frames.
  expect(rows.every((r) => LADDER.indexOf(r.tier) <= LADDER.indexOf(result.ceiling ?? '')), 'promoted past the ceiling').toBe(true);
});
