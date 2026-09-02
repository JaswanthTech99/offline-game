import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/game';

/**
 * THE CRYSTAL BLOOM GATE.
 *
 * The complaint this answers is "crystals emit but do not BLOOM", and the difference
 * between those two words is measurable: a bright object's light stops at its own
 * silhouette, a glowing one's does not. So the gate compares two radii at every distance:
 *
 *   hull radius   computed ANALYTICALLY from the crystal's metres, the camera's fov and the
 *                 viewport, with the same on-screen size floor the field applies. Never
 *                 measured from pixels - a pixel-measured hull is exactly the mistake that
 *                 made two earlier passes measure the aperture instead of the subject.
 *   footprint     measured: the radius at which the radial luminance profile falls back to
 *                 the local background.
 *
 * footprint > hull radius is the whole claim. A crystal that is merely bright measures
 * footprint == hull radius, because there is nothing outside the silhouette to find.
 *
 * The subject is placed OFF the corridor axis. Dead centre puts the vanishing point
 * directly behind it, and every luminance read then answers a question about the corridor.
 *
 * The control row at the end re-measures the same screen position with the field cleared.
 * It must find no footprint at all: without it, this gate could be satisfied by whatever
 * the corridor happens to put behind the crystal.
 *
 * The table carries BOTH hull radii - `hull r` with the on-screen size floor applied, which
 * is the size the field promises, and `raw r` without it. When a row fails with the
 * footprint sitting between the two, the glow is not the fault: the size floor is not
 * reaching that crystal. That is a different bug in a different file, and a gate that
 * printed one number would send the reader to the wrong one.
 */

/** Metres off the corridor axis. Inside the corridor's 5m half-width at every distance. */
const OFFSET_X = 2.2;
const DISTANCES = [10, 20, 30, 45, 60, 80, 100] as const;
/** The distance whose frame is re-measured with the field emptied. */
const CONTROL_DISTANCE = 30;

/** Mirrors CAMERA.fovDeg in src/main.ts. */
const FOV_DEG = 68;
/** Mirrors TUNING.crystalRadius in src/gameplay/Playfield.ts - the girdle radius, in metres. */
const HULL_RADIUS_M = 0.72;
/** Mirrors CRYSTAL_MIN_SCREEN_PX / CRYSTAL_MAX_SCALE_BOOST in src/gameplay/Balance.ts. */
const MIN_SCREEN_PX = 26;
const MAX_SCALE_BOOST = 3.2;

/**
 * How far above the local background a ring still counts as lit. 0.01 is 2.5/255: above
 * 8-bit quantisation, and every ring is a mean over dozens of samples, so film grain
 * averages out well below it.
 */
const LIT_DELTA = 0.01;
/** Distinguishable facet luminances a solid must show. Fewer than three is a flat card. */
const MIN_FACET_VALUES = 3;
/** Luminance bucket width for "distinguishable". ~10/255, comfortably above banding. */
const FACET_BUCKET = 1 / 24;
/** A bucket must hold this share of the hull's pixels to count as a facet value. */
const FACET_SHARE = 0.04;

interface Row {
  distanceM: number;
  centre: { x: number; y: number } | null;
  hullRadiusPx: number;
  rawRadiusPx: number;
  peakLuma: number;
  backgroundLuma: number;
  footprintPx: number;
  facetValues: number;
}

/**
 * Seven agents share one dev server, and an unrelated edit triggers a vite HMR reload that
 * destroys the execution context mid-measurement. The page opens no socket of its own, so
 * silencing WebSocket silences the HMR client and nothing else.
 */
async function pinPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class Silent extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly readyState = 3;
      send(): void {}
      close(): void {}
    }
    Object.defineProperty(window, 'WebSocket', { value: Silent, writable: true, configurable: true });
  });
}

/** Rec.709 luma of one pixel, 0..1. */
function lumaAt(png: PNG, x: number, y: number): number | null {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return null;
  const i = (y * png.width + x) * 4;
  return (0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!) / 255;
}

/** Mean luminance on the ring of radius r. Null when too much of it is off-frame to trust. */
function ringMean(png: PNG, cx: number, cy: number, r: number): number | null {
  const steps = Math.max(24, Math.round(r * 2));
  let sum = 0;
  let n = 0;
  for (let s = 0; s < steps; s += 1) {
    const a = (s / steps) * Math.PI * 2;
    const L = lumaAt(png, Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r));
    if (L !== null) {
      sum += L;
      n += 1;
    }
  }
  if (n < steps * 0.5) return null;
  return sum / n;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Walks the radial profile outward and returns the first radius that has fallen back to the
 * local background. Outward-from-the-centre, not max-over-a-window: a window maximum finds
 * any bright thing that happens to share the neighbourhood and calls it the subject's glow.
 */
function measureFootprint(
  png: PNG,
  cx: number,
  cy: number,
  searchPx: number,
): { footprintPx: number; background: number } {
  const profile: number[] = [];
  for (let r = 0; r <= searchPx; r += 1) {
    const mean = ringMean(png, cx, cy, r);
    if (mean === null) break;
    profile.push(mean);
  }
  if (profile.length < 8) return { footprintPx: 0, background: 0 };

  // Background is the median of the outermost fifth of the profile: a median rather than a
  // mean so one bright ring out there cannot raise the bar the subject is measured against.
  const outerFrom = Math.floor(profile.length * 0.8);
  const background = median(profile.slice(outerFrom));

  let footprintPx = 0;
  for (let r = 1; r < profile.length; r += 1) {
    if (profile[r]! < background + LIT_DELTA) break;
    footprintPx = r;
  }
  return { footprintPx, background };
}

/** How many distinguishable luminance values the hull's own disc shows. */
function countFacetValues(png: PNG, cx: number, cy: number, radiusPx: number): number {
  const buckets = new Map<number, number>();
  let total = 0;
  const r = Math.max(2, Math.round(radiusPx));
  for (let y = -r; y <= r; y += 1) {
    for (let x = -r; x <= r; x += 1) {
      if (x * x + y * y > r * r) continue;
      const L = lumaAt(png, Math.round(cx) + x, Math.round(cy) + y);
      if (L === null) continue;
      const key = Math.floor(L / FACET_BUCKET);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  if (total === 0) return 0;
  let values = 0;
  for (const count of buckets.values()) {
    if (count >= Math.max(3, total * FACET_SHARE)) values += 1;
  }
  return values;
}

test.describe('@crystal', () => {
  // PRESENCE and SPREAD, not sharpness. One scale is the whole measurement.
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
  });

  test('a crystal glows wider than it is, at every distance', async ({ game }, info) => {
    await pinPage(game.page);
    await game.boot({ seed: 4242 });
    await game.hideHud();
    await game.freeze();

    const dpr = game.scale;
    const snap = await game.snapshot();
    // The size floor is a DEVICE-pixel promise the field makes against the drawing buffer;
    // the screenshot is in display device pixels. They are usually the same number and the
    // gate must not assume it, so the boost and the projection are computed separately.
    const bufferPx = snap.bufferHeight;
    const screenPx = snap.displayHeight * dpr;
    const tanHalfFov = Math.tan((FOV_DEG * Math.PI) / 360);

    const projectedPx = (sizeM: number, distanceM: number, viewportPx: number): number =>
      (sizeM / distanceM / (2 * tanHalfFov)) * viewportPx;

    const rows: Row[] = [];

    for (const distanceM of DISTANCES) {
      await game.clearField();
      await game.place('crystal', distanceM, OFFSET_X);
      // One step so the field poses the crystal - spin, size floor, halo billboard - and
      // renders it. `place` freezes the world, so this is the only frame there will be.
      await game.step();

      const boost = Math.min(
        Math.max(1, MIN_SCREEN_PX / Math.max(projectedPx(HULL_RADIUS_M * 2, distanceM, bufferPx), 0.5)),
        MAX_SCALE_BOOST,
      );
      const rawRadiusPx = projectedPx(HULL_RADIUS_M, distanceM, screenPx);
      const hullRadiusPx = rawRadiusPx * boost;

      const centre = await game.page.evaluate(
        ([x, z]) => window.__sp!.project(x as number, 0, z as number),
        [OFFSET_X, -distanceM] as const,
      );
      const png = PNG.sync.read(await game.page.screenshot());

      let peakLuma = 0;
      let footprintPx = 0;
      let backgroundLuma = 0;
      let facetValues = 0;
      if (centre !== null) {
        const cx = centre.x * dpr;
        const cy = centre.y * dpr;
        const searchPx = Math.min(Math.max(hullRadiusPx * 6, 60), 220);
        const measured = measureFootprint(png, cx, cy, searchPx);
        footprintPx = measured.footprintPx;
        backgroundLuma = measured.background;
        facetValues = countFacetValues(png, cx, cy, hullRadiusPx);
        for (let y = -hullRadiusPx; y <= hullRadiusPx; y += 1) {
          for (let x = -hullRadiusPx; x <= hullRadiusPx; x += 1) {
            const L = lumaAt(png, Math.round(cx + x), Math.round(cy + y));
            if (L !== null && L > peakLuma) peakLuma = L;
          }
        }
      }

      rows.push({
        distanceM,
        centre,
        hullRadiusPx,
        rawRadiusPx,
        peakLuma,
        backgroundLuma,
        footprintPx,
        facetValues,
      });
    }

    // ---- control: the same screen position, with nothing in the field --------------------
    await game.clearField();
    await game.step();
    const controlCentre = await game.page.evaluate(
      ([x, z]) => window.__sp!.project(x as number, 0, z as number),
      [OFFSET_X, -CONTROL_DISTANCE] as const,
    );
    const controlPng = PNG.sync.read(await game.page.screenshot());
    const controlHullPx = projectedPx(HULL_RADIUS_M, CONTROL_DISTANCE, screenPx);
    const control =
      controlCentre === null
        ? { footprintPx: 0, background: 0 }
        : measureFootprint(
            controlPng,
            controlCentre.x * dpr,
            controlCentre.y * dpr,
            Math.min(Math.max(controlHullPx * 6, 60), 220),
          );

    const table = [
      `   dist   hull r    raw r    peak    bg      footprint  ratio   facet values`,
      ...rows.map(
        (r) =>
          `  ${String(r.distanceM).padStart(4)}m  ` +
          `${r.hullRadiusPx.toFixed(1).padStart(6)}px  ` +
          `${r.rawRadiusPx.toFixed(1).padStart(6)}px  ` +
          `${(r.peakLuma * 100).toFixed(1).padStart(5)}%  ` +
          `${(r.backgroundLuma * 100).toFixed(1).padStart(5)}%  ` +
          `${r.footprintPx.toFixed(0).padStart(6)}px   ` +
          `${(r.footprintPx / Math.max(r.hullRadiusPx, 0.001)).toFixed(2).padStart(5)}x  ` +
          `${String(r.facetValues).padStart(6)}`,
      ),
      `  control at ${CONTROL_DISTANCE}m, field empty: footprint ${control.footprintPx.toFixed(0)}px` +
        ` (bg ${(control.background * 100).toFixed(1)}%)`,
    ].join('\n');

    console.log(`crystal bloom (${game.tier}, buffer ${snap.bufferWidth}x${snap.bufferHeight}):\n${table}`);
    await info.attach('crystal-bloom', { body: table, contentType: 'text/plain' });

    for (const r of rows) {
      expect(r.centre, `crystal at ${r.distanceM}m did not project`).not.toBeNull();
      expect(
        r.footprintPx,
        `bloom footprint at ${r.distanceM}m must exceed the hull's ${r.hullRadiusPx.toFixed(1)}px`,
      ).toBeGreaterThan(r.hullRadiusPx);
      expect(
        r.facetValues,
        `distinguishable facet luminances at ${r.distanceM}m`,
      ).toBeGreaterThanOrEqual(MIN_FACET_VALUES);
    }
    expect(control.footprintPx, 'an empty field must show no glow where the crystal was').toBe(0);
  });
});
