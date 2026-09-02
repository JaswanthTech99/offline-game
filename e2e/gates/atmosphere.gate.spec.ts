import { expect, test } from '../fixtures/game';

/**
 * THE ATMOSPHERE GATE.
 *
 * Two claims, and one of them is deliberately not made here.
 *
 *   1. THE LAYER BUILDS EXACTLY WHAT ITS TIER ROW ASKS FOR. Every count is read back off
 *      the graph the real class built, by the same walk core/DebugBridge.ts uses, so the
 *      number under test is the number the bridge will report once this is wired - not a
 *      restatement of the table. MOBILE_LOW builds nothing at all.
 *   2. IT FITS UNDER THE DRAW CEILING. The layer's own draw calls are MEASURED by rendering
 *      it once on a private renderer, and added to the live game's measured draw calls. A
 *      rendered frame is also the only thing that proves the TSL graphs compile: a count
 *      taken off the scene graph would pass just as happily with a shader the backend
 *      rejects. Any such rejection reaches the console, and the fixture fails on those.
 *
 * WHAT IS NOT PROVEN HERE: that the layer looks right inside the corridor. src/gameplay/
 * Playfield.ts is a shared file this agent may not edit, so the layer is not yet wired into
 * the running game and nothing below reads a pixel of it. Beam density variation, the motes
 * being inside the beams and the parallax reading as depth are all claims about an image,
 * and they can only be gated after the wave-2 integrator applies the wiring patch.
 */

/** The requested QUALITY[tier].atmosphere rows. Quality.ts must match this table exactly. */
interface Row {
  readonly shafts: number;
  readonly shaftSlices: number;
  readonly shaftMotes: number;
  readonly parallax: [number, number, number];
  readonly densityVariation: boolean;
}

const TABLE: Record<string, Row> = {
  ULTRA_4K: { shafts: 5, shaftSlices: 12, shaftMotes: 300, parallax: [220, 380, 560], densityVariation: true },
  DESKTOP_HIGH: { shafts: 4, shaftSlices: 10, shaftMotes: 180, parallax: [150, 260, 380], densityVariation: true },
  MOBILE_HIGH: { shafts: 3, shaftSlices: 4, shaftMotes: 90, parallax: [80, 130, 180], densityVariation: false },
  MOBILE_LOW: { shafts: 0, shaftSlices: 0, shaftMotes: 0, parallax: [0, 0, 0], densityVariation: false },
};

const TIERS = ['ULTRA_4K', 'DESKTOP_HIGH', 'MOBILE_HIGH', 'MOBILE_LOW'] as const;

/** QUALITY[tier].drawCallCeiling. Mirrored the way boot.gate.spec.ts mirrors it. */
const CEILING: Record<string, number> = {
  ULTRA_4K: 900,
  DESKTOP_HIGH: 700,
  MOBILE_HIGH: 380,
  MOBILE_LOW: 180,
};

/** The shipped corridor's extents, from Playfield's TUNING: 14 rings at 10.5m. */
const VOLUME = { halfWidth: 5, halfHeight: 3.4, depth: 147 };

/** One InstancedMesh is one draw call, so this is also the layer's draw-call cost. */
const MAX_MESHES = 5;

interface Probe {
  meshes: number;
  elements: number;
  shaftSlices: number;
  shaftMotes: number;
  parallax: [number, number, number];
  densityVariation: boolean;
  sceneElements: number;
  drawCalls: number;
  afterDispose: number;
}

interface ProbeInput {
  universe: string;
  budget: Row;
  volume: typeof VOLUME;
  seed: number;
  steps: number;
  travelSpeed: number;
  render: boolean;
}

const expected = (row: Row): number =>
  row.shafts * row.shaftSlices + (row.shafts > 0 ? row.shaftMotes : 0) + row.parallax[0] + row.parallax[1] + row.parallax[2];

/**
 * Runs the real class inside the booted page. The specifier is held in a variable so this
 * separate TS program never tries to resolve engine code it is forbidden to import; Vite
 * serves the module to the browser, which is the only place it belongs.
 */
async function probe(page: import('@playwright/test').Page, input: ProbeInput): Promise<Probe> {
  return page.evaluate(async (arg) => {
    const specifier = '/src/gameplay/Atmosphere.ts';
    const mod: { probeAtmosphere(i: unknown): Promise<unknown> } = await import(
      /* @vite-ignore */ specifier
    );
    return (await mod.probeAtmosphere(arg)) as Probe;
  }, input) as Promise<Probe>;
}

test.describe('@atmosphere', () => {
  test('the tier table is a legal degradation ladder', () => {
    const low = TABLE['MOBILE_LOW'] as Row;
    expect(low.shafts, 'MOBILE_LOW pays for no shafts').toBe(0);
    expect(low.shaftMotes, 'MOBILE_LOW pays for no shaft motes').toBe(0);
    expect(low.parallax, 'MOBILE_LOW pays for no ambient particles').toEqual([0, 0, 0]);
    expect(expected(low), 'MOBILE_LOW builds no elements at all').toBe(0);

    // The one feature MOBILE_HIGH gives up, and the two tiers that keep it.
    expect((TABLE['MOBILE_HIGH'] as Row).densityVariation).toBe(false);
    expect((TABLE['DESKTOP_HIGH'] as Row).densityVariation).toBe(true);
    expect((TABLE['ULTRA_4K'] as Row).densityVariation).toBe(true);

    // Monotone down the ladder. A tier that is cheaper in name and dearer in elements is a
    // budget that has stopped meaning anything.
    for (let i = 1; i < TIERS.length; i++) {
      const above = TABLE[TIERS[i - 1] as string] as Row;
      const here = TABLE[TIERS[i] as string] as Row;
      expect(expected(here), `${TIERS[i]} must not cost more than ${TIERS[i - 1]}`).toBeLessThan(
        expected(above),
      );
      expect(here.shafts).toBeLessThanOrEqual(above.shafts);
      expect(here.shaftSlices).toBeLessThanOrEqual(above.shaftSlices);
    }

    // More than one slice IS the density variation along a beam. One slice is a gradient,
    // which is the thing this layer exists to replace.
    for (const tier of TIERS) {
      const row = TABLE[tier] as Row;
      if (row.shafts > 0) expect(row.shaftSlices, `${tier} shafts must be sliced`).toBeGreaterThan(1);
    }
  });

  test('every tier row builds exactly its table, and the live tier fits its ceiling', async ({
    game,
  }, info) => {
    await game.boot();
    const before = await game.snapshot();
    expect(before.ready).toBe(true);

    // Measure every row FIRST and report the whole table. A failure on the first tier that
    // hid the other three would cost a full run to learn what the second one did.
    const results = new Map<string, Probe>();
    for (const tier of TIERS) {
      results.set(
        tier,
        await probe(game.page, {
          universe: 'void-cathedral',
          budget: TABLE[tier] as Row,
          volume: VOLUME,
          seed: 20260902,
          // Ticked before measuring, so a scroll or a wrap that throws fails here rather
          // than three minutes into somebody else's capture.
          steps: 40,
          travelSpeed: 9,
          render: true,
        }),
      );
    }

    const rows = [`corridor baseline: ${before.drawCalls} draw calls, ${before.elementCount} elements`];
    for (const tier of TIERS) {
      const r = results.get(tier) as Probe;
      rows.push(
        `${tier.padEnd(13)} meshes ${r.meshes}  draws ${r.drawCalls}  elements ${r.elements}  ` +
          `slices ${r.shaftSlices}  shaftMotes ${r.shaftMotes}  parallax ${r.parallax.join('/')}`,
      );
    }
    const report = rows.join('\n');
    console.log(report);
    await info.attach('atmosphere-tiers', { body: report, contentType: 'text/plain' });

    // What one rendered frame costs with NOTHING in the scene. The backend charges a call
    // of its own for the frame itself, and measuring it here rather than assuming it is
    // zero is what lets the rows below assert an exact per-mesh cost.
    const floor = (results.get('MOBILE_LOW') as Probe).drawCalls;
    expect(floor, 'an empty scene should cost at most one call').toBeLessThanOrEqual(1);

    for (const tier of TIERS) {
      const row = TABLE[tier] as Row;
      const result = results.get(tier) as Probe;

      expect(result.shaftSlices, `${tier} shaft slices`).toBe(row.shafts * row.shaftSlices);
      expect(result.shaftMotes, `${tier} shaft motes`).toBe(row.shafts > 0 ? row.shaftMotes : 0);
      expect(result.parallax, `${tier} parallax tiers`).toEqual(row.parallax);
      expect(result.elements, `${tier} total elements`).toBe(expected(row));
      // The graph, walked the way the debug bridge walks it, must agree with the getter.
      expect(result.sceneElements, `${tier} scene walk disagrees with report()`).toBe(expected(row));
      expect(result.densityVariation).toBe(row.densityVariation);

      // EXACTLY one instanced draw per family, and never more families than the design has.
      // An extra draw means a material slipped into three's double-sided transparency path,
      // which is silent, doubles the layer and buys nothing under additive blending.
      expect(result.meshes, `${tier} mesh count`).toBeLessThanOrEqual(MAX_MESHES);
      expect(result.drawCalls - floor, `${tier} spent more than one call per mesh`).toBe(
        result.meshes,
      );
      if (expected(row) === 0) {
        expect(result.meshes, 'MOBILE_LOW must build nothing').toBe(0);
      } else {
        expect(result.meshes, `${tier} built no meshes`).toBeGreaterThan(0);
        // A rendered frame is the only proof the TSL graphs compiled and ran at all.
        expect(result.drawCalls, `${tier} rendered nothing - the shaders did not run`).toBeGreaterThan(floor);
      }

      expect(result.afterDispose, `${tier} leaked elements through dispose()`).toBe(0);

      // The ceiling claim is only meaningful against a baseline measured on the same tier.
      if (tier === game.tier) {
        const ceiling = CEILING[tier] ?? 900;
        // The layer's own cost is its measured draws minus the renderer's floor, because
        // the live frame is already paying that floor.
        const added = result.drawCalls - floor;
        expect(
          before.drawCalls + added,
          `${tier}: corridor ${before.drawCalls} + atmosphere ${added} over the ${ceiling} ceiling`,
        ).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});
