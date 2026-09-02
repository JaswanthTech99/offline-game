import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { expect, test } from '../fixtures/game';

/**
 * STAGE 2. THE ARCHITECTURE IS NEUTRAL; ONE HUE IS RESERVED.
 *
 * The rule this build is supposed to follow is that a single saturated hue belongs to
 * things the player can hit, and everything else is separated by VALUE. On the device the
 * corridor walls came back beige and the floor pool orange, so the architecture was
 * competing with the targets for the same attention the targets are supposed to own.
 *
 * WHY THE MASKS ARE PROJECTED RATHER THAN DRAWN. A screen-space rectangle labelled "wall"
 * is an assertion about where the wall is, and it silently becomes false the first time
 * the camera or the corridor changes. Instead this gate asks the running game for its own
 * corridor dimensions, generates sample points ON the wall/floor/ceiling planes in world
 * space, projects them through the live camera, and samples those pixels. If the geometry
 * moves, the samples move with it. The sample points are drawn into the attached capture
 * so the mask can be looked at rather than trusted.
 *
 * WHY THE FIELD IS CLEARED. Panes and crystals carry the reserved hue by design. Leaving
 * them in the frame while measuring "is the architecture neutral" is how a gate ends up
 * measuring the thing it was supposed to exclude. `clearField()` removes the targets and
 * leaves the shell, so the architecture pass sees architecture. The pane pass then places
 * exactly one breakable and measures inside its projected rectangle.
 *
 * THE METRIC. Hue is unstable at low saturation and wraps at 360, so the primary number
 * is a warm-cool index rather than an angle:
 *
 *     warmIndex = (R - B) / (R + G + B)
 *
 * Positive is warm, negative is cool, zero is neutral, and it degrades gracefully towards
 * zero as a pixel darkens instead of spinning. HSV saturation and hue are reported next to
 * it because they are what a human reads, but the assertion is on the index.
 */

/**
 * Gate parameters. Stated up front rather than fitted to the measurement afterwards.
 *
 * `maxArchitectureWarmIndex` is 0: the architecture may be neutral or cool, and any net
 * warmth at all is the defect. The epsilon below it is 8-bit quantisation on a dark pixel,
 * not a tolerance for a visible tint.
 */
const BUDGET = Object.freeze({
  /** Warm-cool index. <= this is "not warm". */
  maxArchitectureWarmIndex: 0.0,
  /** 8-bit rounding slack on the index, in index units. */
  warmIndexEpsilon: 0.008,
  /**
   * Scale-invariant chroma, (max - min) / (R + G + B), NOT HSV saturation.
   *
   * HSV saturation divides by the max channel, so it rises as a surface darkens even when
   * the surface has not become one bit more colourful - darkening the stone albedo by 18%
   * moved the architecture from 0.108 to 0.135 on an unchanged hue. That makes it unfit for
   * comparing a dark wall against a lit pane, which is the entire comparison this gate
   * exists to make. Dividing by the SUM cancels any scalar multiply, so the vignette, the
   * exposure and the albedo all drop out and only the chromaticity is left.
   */
  maxArchitectureChroma: 0.03,
  /** The reserved hue has to actually be chromatic to be reserved. */
  minPaneChroma: 0.05,
  /** And it has to be clearly separated from the architecture, not merely above it. */
  minPaneToArchitectureRatio: 3,
  /** Fraction of the frame that must land in the mid-tone band. */
  minMidBandFraction: 0.25,
});

/** The mid-tone band, matching e2e/fixtures/export.ts so the numbers are comparable. */
const MID_BAND = Object.freeze({ lo: 0.28, hi: 0.45 });

/**
 * Samples outside this window are dropped from the chromaticity statistics and counted.
 * Below the floor an 8-bit pixel has too few levels left to carry a meaningful ratio;
 * above the ceiling the sample is an emitter - a light strip is a LIGHT, and the theme's
 * whole premise is that light may be coloured while surfaces may not.
 */
const SAMPLE_WINDOW = Object.freeze({ minLuma: 0.02, maxLuma: 0.9 });

/**
 * Fixed steps run after restart() so the histogram frame is the same picture every run:
 * far enough in that the corridor is populated and the first row has closed to a readable
 * distance, short enough that nothing has been thrown at yet.
 */
const COMPOSITION_STEPS = 90;
const FIXED_STEP_MS = 16;

/** Inset from the corridor surface so a sample sits ON the plane, not inside it. */
const SURFACE_INSET_M = 0.05;

interface Sample {
  readonly x: number;
  readonly y: number;
}

interface RegionStats {
  readonly name: string;
  readonly requested: number;
  readonly onScreen: number;
  readonly used: number;
  readonly tooDark: number;
  readonly tooBright: number;
  readonly warmIndex: number;
  readonly saturation: number;
  readonly chroma: number;
  /** Mean of PER-PIXEL chroma. Inflated by the grain layer; reported, never asserted. */
  readonly pixelChroma: number;
  readonly hueDeg: number;
  readonly luma: number;
  readonly meanRgb: readonly [number, number, number];
}

function luma8(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Circular mean over hue angles, weighted by each sample's saturation. */
function meanHueDeg(hues: readonly number[], weights: readonly number[]): number {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < hues.length; i += 1) {
    const rad = ((hues[i] ?? 0) * Math.PI) / 180;
    const w = weights[i] ?? 0;
    sx += Math.cos(rad) * w;
    sy += Math.sin(rad) * w;
  }
  if (sx === 0 && sy === 0) return Number.NaN;
  const deg = (Math.atan2(sy, sx) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

function statsFor(name: string, png: PNG, points: readonly Sample[]): RegionStats {
  const { width: W, height: H, data } = png;
  let onScreen = 0;
  let used = 0;
  let tooDark = 0;
  let tooBright = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumWarm = 0;
  let sumSat = 0;
  let sumChroma = 0;
  let sumLuma = 0;
  const hues: number[] = [];
  const sats: number[] = [];

  for (const p of points) {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    onScreen += 1;
    const i = (y * W + x) * 4;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const L = luma8(r, g, b);
    if (L < SAMPLE_WINDOW.minLuma) {
      tooDark += 1;
      continue;
    }
    if (L > SAMPLE_WINDOW.maxLuma) {
      tooBright += 1;
      continue;
    }
    used += 1;
    sumR += r;
    sumG += g;
    sumB += b;
    sumLuma += L;

    const total = r + g + b;
    sumWarm += total === 0 ? 0 : (r - b) / total;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    sumSat += sat;
    sumChroma += total === 0 ? 0 : (max - min) / total;
    sats.push(sat);

    let hue = 0;
    const d = max - min;
    if (d !== 0) {
      if (max === r) hue = 60 * (((g - b) / d) % 6);
      else if (max === g) hue = 60 * ((b - r) / d + 2);
      else hue = 60 * ((r - g) / d + 4);
      if (hue < 0) hue += 360;
    }
    hues.push(hue);
  }

  const n = Math.max(1, used);
  return {
    name,
    requested: points.length,
    onScreen,
    used,
    tooDark,
    tooBright,
    warmIndex: sumWarm / n,
    saturation: sumSat / n,
    // Chroma OF THE MEAN, not the mean of the chromas. `.fx__grain` puts independent noise
    // on every channel, so a per-pixel chroma averages the NOISE in as colour and reads
    // 0.046 on a wall whose actual mean rgb is (45,45,48) - a chroma of 0.022. Grain is a
    // sensor artefact; it is not the surface being coloured, so it must not count here.
    chroma:
      sumR + sumG + sumB === 0
        ? 0
        : (Math.max(sumR, sumG, sumB) - Math.min(sumR, sumG, sumB)) / (sumR + sumG + sumB),
    pixelChroma: sumChroma / n,
    hueDeg: meanHueDeg(hues, sats),
    luma: sumLuma / n,
    meanRgb: [sumR / n, sumG / n, sumB / n],
  };
}

/** Marks each sample point in the attached capture so the mask is visible, not implied. */
function drawMarks(png: PNG, points: readonly Sample[], rgb: readonly [number, number, number]): void {
  const { width: W, height: H, data } = png;
  for (const p of points) {
    const cx = Math.round(p.x);
    const cy = Math.round(p.y);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx !== 0 && dy !== 0) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
      }
    }
  }
}

function histogram(png: PNG): { bins: number[]; midFraction: number; mean: number } {
  const BINS = 20;
  const bins = new Array<number>(BINS).fill(0);
  const { width: W, height: H, data } = png;
  let mid = 0;
  let sum = 0;
  for (let i = 0; i < W * H * 4; i += 4) {
    const L = luma8(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    const b = L >= 1 ? BINS - 1 : Math.floor(L * BINS);
    bins[b] = (bins[b] ?? 0) + 1;
    if (L >= MID_BAND.lo && L <= MID_BAND.hi) mid += 1;
    sum += L;
  }
  return { bins, midFraction: mid / (W * H), mean: sum / (W * H) };
}

function line(s: RegionStats): string {
  const rgb = s.meanRgb.map((v) => Math.round(v)).join(',');
  return (
    `  ${s.name.padEnd(11)} warm ${s.warmIndex >= 0 ? '+' : ''}${s.warmIndex.toFixed(4)}` +
    `  chroma ${s.chroma.toFixed(4)}` +
    `  px-chroma ${s.pixelChroma.toFixed(4)}` +
    `  sat ${s.saturation.toFixed(3)}` +
    `  hue ${Number.isNaN(s.hueDeg) ? '  n/a' : `${s.hueDeg.toFixed(0).padStart(3)}°`}` +
    `  luma ${s.luma.toFixed(3)}  rgb(${rgb})` +
    `  [${String(s.used)}/${String(s.requested)} used, ${String(s.tooDark)} dark, ${String(s.tooBright)} bright, ${String(s.requested - s.onScreen)} offscreen]`
  );
}

test.describe('@palette', () => {
  test.beforeEach(({}, info) => {
    const meta = info.project.metadata as { scale?: number; tier?: string };
    test.skip(meta.scale !== 1, 'scale-1 project only');
    test.skip(meta.tier !== 'DESKTOP_HIGH', 'one tier is enough for a colour law');
  });

  test('architecture is neutral cool and the reserved hue belongs to glass', async ({
    game,
  }, info) => {
    await game.boot({ seed: 0x51a77e40, hideHud: true });
    await game.freeze();

    const dims = (await game.snapshot()).corridor;
    expect(dims, 'the game did not report its corridor dimensions').toBeTruthy();

    // --- full-frame pass: the composition the player actually sees ----------------------
    // The luma histogram MUST come from this frame and not from the cleared one. Panes,
    // crystals and shards are a large share of the frame's mid-tones, so measuring the
    // band on an emptied corridor measures a picture that never ships.
    //
    // restart() before stepping is what makes it REPRODUCIBLE. Booting takes a variable
    // number of real frames, so the corridor has travelled a different distance by the time
    // freeze() lands and the same seed yields a different composition run to run - which
    // showed up as the band moving 16.3%-18.3% across runs that changed nothing relevant.
    // One evaluate, not ninety: a per-step CDP round-trip costs more than the frame does
    // and pushed this past the 300s test timeout.
    await game.page.evaluate(
      ({ steps, dt }) => {
        const sp = window.__sp!;
        sp.restart();
        for (let i = 0; i < steps; i += 1) sp.step(dt);
      },
      { steps: COMPOSITION_STEPS, dt: FIXED_STEP_MS },
    );
    await game.page.waitForTimeout(120);
    const fullShot = await game.page.screenshot();
    const hist = histogram(PNG.sync.read(fullShot));

    // --- architecture pass: shell only -------------------------------------------------
    await game.clearField();
    await game.step(16);
    await game.page.waitForTimeout(120);

    const projected = await game.page.evaluate(
      ({ hw, hh, inset }) => {
        const sp = window.__sp;
        if (sp === undefined) throw new Error('no __sp');
        const project = (x: number, y: number, z: number): { x: number; y: number } | null =>
          sp.project(x, y, z) as { x: number; y: number } | null;

        const grid = (
          make: (u: number, v: number) => readonly [number, number, number],
          nu: number,
          nv: number,
        ): { x: number; y: number }[] => {
          const out: { x: number; y: number }[] = [];
          for (let iu = 0; iu < nu; iu += 1) {
            for (let iv = 0; iv < nv; iv += 1) {
              const u = nu === 1 ? 0.5 : iu / (nu - 1);
              const v = nv === 1 ? 0.5 : iv / (nv - 1);
              const [x, y, z] = make(u, v);
              const p = project(x, y, z);
              if (p !== null) out.push(p);
            }
          }
          return out;
        };

        // z sweep stays inside the lit half of the corridor: past the fog's full density
        // every surface is the fog colour and measures nothing about the surface.
        const zNear = -7;
        const zFar = -42;
        const zOf = (v: number): number => zNear + (zFar - zNear) * v;

        return {
          wallLeft: grid((u, v) => [-(hw - inset), -2 + 4 * u, zOf(v)], 5, 9),
          wallRight: grid((u, v) => [hw - inset, -2 + 4 * u, zOf(v)], 5, 9),
          floor: grid((u, v) => [-3.5 + 7 * u, -(hh - inset), zOf(v)], 5, 9),
          ceiling: grid((u, v) => [-3.5 + 7 * u, hh - inset, zOf(v)], 5, 9),
        };
      },
      { hw: dims.halfWidth, hh: dims.halfHeight, inset: SURFACE_INSET_M },
    );

    const archShot = await game.page.screenshot();
    const archPng = PNG.sync.read(archShot);
    expect(
      archPng.width,
      'this gate assumes 1 CSS px = 1 PNG px, which holds only at deviceScaleFactor 1',
    ).toBe(game.page.viewportSize()?.width);

    const walls = statsFor('walls', archPng, [...projected.wallLeft, ...projected.wallRight]);
    const floor = statsFor('floor', archPng, projected.floor);
    const ceiling = statsFor('ceiling', archPng, projected.ceiling);
    const architecture = statsFor('ALL-ARCH', archPng, [
      ...projected.wallLeft,
      ...projected.wallRight,
      ...projected.floor,
      ...projected.ceiling,
    ]);


    // --- pane pass: exactly one breakable ----------------------------------------------
    const paneDistanceM = 12;
    await game.place('pane', paneDistanceM);
    await game.step(16);
    await game.page.waitForTimeout(120);

    const paneSamples = await game.page.evaluate(
      ({ d, pw, ph }) => {
        const sp = window.__sp;
        if (sp === undefined) throw new Error('no __sp');
        const out: { x: number; y: number }[] = [];
        // Inside the pane's rectangle, inset from the rim: the rim is a separate signal
        // and Stage 3 measures it. This measures the FACE.
        for (let iu = 0; iu < 7; iu += 1) {
          for (let iv = 0; iv < 7; iv += 1) {
            const fx = (iu / 6 - 0.5) * pw * 0.6;
            const fy = (iv / 6 - 0.5) * ph * 0.6;
            const p = sp.project(fx, fy, -d) as { x: number; y: number } | null;
            if (p !== null) out.push(p);
          }
        }
        return out;
      },
      { d: paneDistanceM, pw: dims.paneWidth, ph: dims.paneHeight },
    );

    const panePng = PNG.sync.read(await game.page.screenshot());
    const pane = statsFor('pane-face', panePng, paneSamples);

    // --- report -------------------------------------------------------------------------
    const report: string[] = [
      `corridor  halfWidth ${String(dims.halfWidth)}m  halfHeight ${String(dims.halfHeight)}m` +
        `  pane ${String(dims.paneWidth)}x${String(dims.paneHeight)}m`,
      '',
      'REGION CHROMATICITY  (warm = (R-B)/(R+G+B); positive is warm, negative is cool)',
      line(walls),
      line(floor),
      line(ceiling),
      line(architecture),
      line(pane),
      '',
      `LUMA HISTOGRAM, full frame as shipped  (mean ${hist.mean.toFixed(3)})`,
    ];
    const peak = Math.max(...hist.bins);
    for (let i = 0; i < hist.bins.length; i += 1) {
      const lo = i / hist.bins.length;
      const hi = (i + 1) / hist.bins.length;
      const count = hist.bins[i] ?? 0;
      const frac = count / (archPng.width * archPng.height);
      const inBand = lo >= MID_BAND.lo - 1e-9 && hi <= MID_BAND.hi + 1e-9;
      report.push(
        `  ${lo.toFixed(2)}-${hi.toFixed(2)} ${inBand ? '*' : ' '} ` +
          `${(frac * 100).toFixed(2).padStart(6)}%  ${'#'.repeat(Math.round((count / peak) * 40))}`,
      );
    }
    report.push(
      '',
      `mid-tone band ${MID_BAND.lo.toFixed(2)}-${MID_BAND.hi.toFixed(2)}: ` +
        `${(hist.midFraction * 100).toFixed(2)}%  (budget ${(BUDGET.minMidBandFraction * 100).toFixed(0)}%)`,
    );

    const text = report.join('\n');
    console.log(`\nPALETTE\n${text}\n`);
    await info.attach('palette', { body: text, contentType: 'text/plain' });

    drawMarks(archPng, [...projected.wallLeft, ...projected.wallRight], [255, 0, 255]);
    drawMarks(archPng, projected.floor, [0, 255, 0]);
    drawMarks(archPng, projected.ceiling, [255, 255, 0]);
    await info.attach('architecture-masked', {
      body: PNG.sync.write(archPng),
      contentType: 'image/png',
    });
    await info.attach('architecture', { body: archShot, contentType: 'image/png' });
    await info.attach('full-frame', { body: fullShot, contentType: 'image/png' });

    // Written to disk as well as attached: a before/after pair has to survive the run that
    // produced it, and a trace.zip is not somewhere a comparison can be made from.
    const label = process.env['SP_PALETTE_LABEL'] ?? 'after';
    await writeFile(join('exports', `palette-${label}-full.png`), fullShot);
    await writeFile(join('exports', `palette-${label}-arch.png`), archShot);
    drawMarks(panePng, paneSamples, [255, 0, 255]);
    await info.attach('pane-masked', {
      body: PNG.sync.write(panePng),
      contentType: 'image/png',
    });

    // --- assertions ---------------------------------------------------------------------
    const limit = BUDGET.maxArchitectureWarmIndex + BUDGET.warmIndexEpsilon;
    for (const region of [walls, floor, ceiling]) {
      expect(
        region.used,
        `${region.name}: no sample survived the luma window - the mask missed the surface`,
      ).toBeGreaterThan(0);
      expect(
        region.warmIndex,
        `${region.name} is WARM: index ${region.warmIndex.toFixed(4)} > ${limit.toFixed(4)}` +
          ` (mean rgb ${region.meanRgb.map((v) => Math.round(v)).join(',')}, hue ${region.hueDeg.toFixed(0)}°)`,
      ).toBeLessThanOrEqual(limit);
    }

    expect(
      architecture.chroma,
      `architecture.chroma ${architecture.chroma.toFixed(4)} exceeds ${String(BUDGET.maxArchitectureChroma)}`,
    ).toBeLessThanOrEqual(BUDGET.maxArchitectureChroma);

    expect(
      pane.used,
      'no pane sample survived - the pane was not placed or not projected where expected',
    ).toBeGreaterThan(0);
    expect(
      pane.chroma,
      `pane face chroma ${pane.chroma.toFixed(4)} below ${String(BUDGET.minPaneChroma)} - the reserved hue is not being spent on glass`,
    ).toBeGreaterThanOrEqual(BUDGET.minPaneChroma);
    expect(
      pane.chroma / Math.max(1e-6, architecture.chroma),
      `pane is only ${(pane.chroma / Math.max(1e-6, architecture.chroma)).toFixed(1)}x the architecture's chroma`,
    ).toBeGreaterThanOrEqual(BUDGET.minPaneToArchitectureRatio);

    expect(
      hist.midFraction,
      `mid-tone band ${(hist.midFraction * 100).toFixed(2)}% below ${(BUDGET.minMidBandFraction * 100).toFixed(0)}%`,
    ).toBeGreaterThanOrEqual(BUDGET.minMidBandFraction);
  });
});
