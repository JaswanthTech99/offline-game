import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { expect, test } from '../fixtures/game';

/**
 * D-MATERIALS gate. Does src/render/materials/Surfaces.ts actually put more information on
 * the screen than the materials Playfield ships today?
 *
 * "More information" is measured, not asserted: the frame is split into a 4x3 grid and each
 * cell's distinct 1/255 luminance levels are counted. A flat surface contributes one level
 * per lighting gradient; break-up, an edge, a reflection and a contact each contribute
 * their own. The same corridor, the same seed, the same instance placement, the same three
 * lights and the same fog are rendered twice - the ONLY difference between the two frames
 * is which palette was handed to the builder.
 *
 * PRE-WIRING, AND HONEST ABOUT IT. These numbers come from the A/B bench in
 * src/render/materials/SurfacesLab.ts, not from the live Playfield, because the agent that
 * wrote the materials may not edit Playfield. The bench reproduces Playfield's shell
 * geometry, baseline materials, lights and fog verbatim; it does not reproduce the glass,
 * the crystals, the post chain or the HUD. So the DELTA is the real measurement and the
 * absolute numbers are not the shipped frame's.
 */

const GRID_X = 4;
const GRID_Y = 3;
const CELLS = GRID_X * GRID_Y;

/** Matches detail.gate.spec.ts. A cell below this is a flat gradient, however it got there. */
const MIN_LEVELS_PER_CELL = 24;
/** How many of the twelve cells must strictly improve. Three may tie; none may collapse. */
const MIN_IMPROVED_CELLS = 9;
/** A cell is allowed to lose this many levels - contact shadow legitimately removes some. */
const MAX_CELL_REGRESSION = 6;

/** What a MOBILE_LOW-shaped subset keeps. Mirrors the SURFACES table requested for Quality.ts. */
const DEGRADED = {
  anisotropy: false,
  edgeWear: true,
  reflection: false,
  detailNormal: false,
  detailRoughness: true,
  contact: true,
} as const;

/** A blank document on the dev-server origin, so `/src/...` module URLs resolve. */
const LAB_URL = '/__surfaces-lab';
const LAB_HTML =
  '<!doctype html><meta charset="utf-8"><title>surfaces lab</title>' +
  '<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}</style><body>';

/**
 * ARCHITECTURE.md section 6 - CONTRAST, NOT MORE GLOW. Detail bought by adding light is not
 * detail, it is the milk this project already went milky once over. Every term in Surfaces.ts
 * is additive emissive or a subtractive contact, so the frame's value structure is checked
 * alongside the level counts and is allowed to move only in the safe direction.
 *
 * The bench carries no vignette and no post chain, so these are NOT the shipped frame's
 * absolute numbers and are never compared against HISTOGRAM_LAW directly. They are compared
 * against the BASELINE frame measured through the identical path.
 */
interface Exposure {
  readonly median: number;
  readonly highlightFraction: number;
  readonly blackFraction: number;
}

/** BLACK_POINT.floor from corridor/Exposure.ts; HISTOGRAM_LAW's highlight threshold. */
const BLACK_AT = 0.06;
const HIGHLIGHT_AT = 0.7;
/** How far the new materials may push each figure the wrong way before it is a regression. */
const MEDIAN_SLACK = 0.03;
const HIGHLIGHT_SLACK = 0.015;
const BLACK_SLACK = 0.02;

interface Frame {
  readonly counts: readonly number[];
  readonly exposure: Exposure;
  readonly png: PNG;
}

/** sRGB -> linear. The PNG is display-encoded; the histogram law is about scene luminance. */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function exposureOf(png: PNG): Exposure {
  const { width: W, height: H, data } = png;
  const values: number[] = [];
  let high = 0;
  let black = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const L =
        0.2126 * toLinear(data[i]!) + 0.7152 * toLinear(data[i + 1]!) + 0.0722 * toLinear(data[i + 2]!);
      values.push(L);
      if (L >= HIGHLIGHT_AT) high += 1;
      if (L <= BLACK_AT) black += 1;
    }
  }
  values.sort((a, b) => a - b);
  return {
    median: values[values.length >> 1] ?? 0,
    highlightFraction: high / values.length,
    blackFraction: black / values.length,
  };
}

function gridCounts(png: PNG): number[] {
  const { width: W, height: H, data } = png;
  const counts: number[] = [];
  for (let gy = 0; gy < GRID_Y; gy++) {
    for (let gx = 0; gx < GRID_X; gx++) {
      const x0 = Math.floor((gx * W) / GRID_X);
      const x1 = Math.floor(((gx + 1) * W) / GRID_X);
      const y0 = Math.floor((gy * H) / GRID_Y);
      const y1 = Math.floor(((gy + 1) * H) / GRID_Y);
      const seen = new Set<number>();
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * W + x) * 4;
          const L = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
          seen.add(Math.round(L));
        }
      }
      counts.push(seen.size);
    }
  }
  return counts;
}

function table(label: string, counts: readonly number[]): string {
  const rows = [`${label}:`];
  for (let gy = 0; gy < GRID_Y; gy++) {
    const cells: string[] = [];
    for (let gx = 0; gx < GRID_X; gx++) cells.push(String(counts[gy * GRID_X + gx]).padStart(5));
    rows.push(`  ${cells.join('')}`);
  }
  return rows.join('\n');
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function exposureRow(label: string, e: Exposure): string {
  return (
    `exposure ${label.padEnd(9)} median=${e.median.toFixed(4)}` +
    `  highlights>${HIGHLIGHT_AT}=${(e.highlightFraction * 100).toFixed(2)}%` +
    `  black<=${BLACK_AT}=${(e.blackFraction * 100).toFixed(2)}%`
  );
}

test.describe('@surfaces', () => {
  test.beforeEach(({}, info) => {
    const meta = info.project.metadata as { scale?: number; tier?: string };
    test.skip(meta.scale !== 1, 'the bench renders one frame per variant; 1x is enough');
    test.skip(meta.tier !== 'DESKTOP_HIGH', 'DESKTOP_HIGH only - the bench is tier-agnostic');
  });

  test('new surface materials raise distinct luma levels in every region', async ({ game }, info) => {
    const { page } = game;
    await page.route(`**${LAB_URL}`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: LAB_HTML }),
    );
    await page.goto(LAB_URL, { waitUntil: 'load' });

    /**
     * The bench is loaded as a module SCRIPT rather than through an import() inside
     * evaluate: the e2e program must not name engine modules, and a script tag's body is a
     * string, so the specifier never enters the TypeScript graph.
     */
    const render = async (variant: string, features: unknown): Promise<Frame> => {
      await page.evaluate(() => {
        delete (window as unknown as Record<string, unknown>)['__labFrame'];
      });
      await page.addScriptTag({
        type: 'module',
        content: `
          import { mountSurfaceLab } from '/src/render/materials/SurfacesLab.ts';
          await mountSurfaceLab({
            variant: ${JSON.stringify(variant)},
            seed: 20260902,
            forceWebGL: true,
            ${features === null ? '' : `features: ${JSON.stringify(features)},`}
          });
          window.__labFrame = ${JSON.stringify(variant)};
        `,
      });
      await page.waitForFunction(
        (v) => (window as unknown as Record<string, unknown>)['__labFrame'] === v,
        variant,
        { timeout: 180_000 },
      );
      // The bench renders once, synchronously. One compositor beat is all the frame needs.
      await page.waitForTimeout(400);
      const png = PNG.sync.read(await page.screenshot({ scale: 'device' }));
      return { counts: gridCounts(png), exposure: exposureOf(png), png };
    };

    const baseline = await render('baseline', null);
    const surfaces = await render('surfaces', null);
    const degraded = await render('surfaces', DEGRADED);

    await mkdir('exports', { recursive: true });
    await writeFile(join('exports', 'surfaces-baseline.png'), PNG.sync.write(baseline.png));
    await writeFile(join('exports', 'surfaces-new.png'), PNG.sync.write(surfaces.png));

    const delta = surfaces.counts.map((c, i) => c - baseline.counts[i]!);
    const improved = delta.filter((d) => d > 0).length;
    const report = [
      `frame ${baseline.png.width}x${baseline.png.height}, ${GRID_X}x${GRID_Y} grid, distinct luma levels`,
      'PRE-WIRING: measured on the Surfaces A/B bench, not on the live Playfield.',
      table('baseline (today\'s Playfield materials)', baseline.counts),
      table('surfaces (SURFACES_ALL)', surfaces.counts),
      table('surfaces (MOBILE_LOW subset)', degraded.counts),
      table('delta (surfaces - baseline)', delta),
      `total  baseline=${sum(baseline.counts)}  surfaces=${sum(surfaces.counts)}` +
        `  degraded=${sum(degraded.counts)}`,
      `cells improved: ${improved}/${CELLS}`,
      exposureRow('baseline', baseline.exposure),
      exposureRow('surfaces', surfaces.exposure),
      exposureRow('degraded', degraded.exposure),
    ].join('\n');
    console.log(report);
    await info.attach('surfaces-grid', { body: report, contentType: 'text/plain' });

    // A black frame counts zero levels everywhere and would sail past a delta test, so the
    // absolute floor is checked first and on BOTH frames.
    for (const [i, c] of baseline.counts.entries()) {
      expect(c, `baseline cell ${i} is empty - the bench did not render`).toBeGreaterThan(1);
    }
    for (const [i, c] of surfaces.counts.entries()) {
      expect(c, `surfaces cell ${i} has only ${c} distinct luminance levels`).toBeGreaterThanOrEqual(
        MIN_LEVELS_PER_CELL,
      );
    }
    for (const [i, d] of delta.entries()) {
      expect(d, `surfaces cell ${i} lost ${-d} levels`).toBeGreaterThan(-MAX_CELL_REGRESSION);
    }
    expect(improved, 'too few regions gained detail').toBeGreaterThanOrEqual(MIN_IMPROVED_CELLS);
    expect(sum(surfaces.counts)).toBeGreaterThan(sum(baseline.counts));
    // Degradation has to be a ladder, not a cliff: the cheap subset must still beat today.
    expect(sum(degraded.counts), 'the MOBILE_LOW subset lost to the baseline').toBeGreaterThan(
      sum(baseline.counts),
    );
    expect(sum(degraded.counts), 'the MOBILE_LOW subset matched SURFACES_ALL - a term is dead')
      .toBeLessThan(sum(surfaces.counts));

    // Detail must be bought with structure, not with light.
    expect(
      surfaces.exposure.median,
      'median luminance rose: the new materials are lifting the whole frame',
    ).toBeLessThanOrEqual(baseline.exposure.median + MEDIAN_SLACK);
    expect(
      surfaces.exposure.highlightFraction,
      'highlight area grew: an emissive term is too hot',
    ).toBeLessThanOrEqual(baseline.exposure.highlightFraction + HIGHLIGHT_SLACK);
    expect(
      surfaces.exposure.blackFraction,
      'the black point was lifted - additive terms are reaching the shadows',
    ).toBeGreaterThanOrEqual(baseline.exposure.blackFraction - BLACK_SLACK);
  });
});
