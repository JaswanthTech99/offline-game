import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import {
  EXPORT_DIR,
  TARGET,
  exportRequested,
  formatLumaStats,
  hideHudRequested,
  lumaStats,
} from '../fixtures/export';
import { expect, test } from '../fixtures/game';

/**
 * STAGE 4b. A genuine 3840x2160 still per tier, supersampled 2x.
 *
 * NOT A GATE. It is collected by `playwright test` like everything else under e2e/, so it
 * refuses to run unless SP_EXPORT_4K=1 is set - see `exportRequested`. `tools/export4k.sh`
 * sets it; a gate run does not.
 *
 * WHY IT DOES NOT NEED A GPU
 * A still is just a slow frame, and slow is free here. Interactive sharpness on this host
 * is capped by SwiftShader's throughput, not by its correctness: the rasteriser produces
 * the same pixels the hardware would, it simply takes minutes to produce 33 million of
 * them. That is the whole trade this path makes.
 *
 * THE ARITHMETIC
 * playwright.config.ts holds DEVICE pixels constant across the scale axis (viewport =
 * 960x540 / scale), so the scale-4 project's own viewport is 240x135 and captures a
 * 960x540 image. This spec overrides the viewport to TARGET / deviceScaleFactor and
 * asserts, in the page, that dpr x innerWidth really is 3840 before it renders anything.
 * The written file is then decoded off disk and its real dimensions asserted, because the
 * only trustworthy statement about a PNG's size is the PNG's own header.
 *
 * WHY BOOT SMALL AND RESIZE
 * Booting straight into 4K would have to compile every shader while each warm-up frame
 * costs minutes, and the game fixture's readiness wait is 150s. Booting at the project's
 * own tiny viewport, freezing, composing the shot, and only then growing the surface
 * spends the expensive frames on the frames that are actually exported. A paused Loop
 * still dispatches `frame(alpha)`, so the post chain keeps presenting after the freeze -
 * which is what makes the grown surface get drawn at all.
 */

/** Fixed steps of composition before the capture, at the cheap viewport. ~2s of run. */
const COMPOSE_STEPS = 120;

/** Frames to let the grown surface present before capturing. */
const SETTLE_FRAMES = 3;

/** One 33-megapixel software frame is minutes. The whole test gets a generous ceiling. */
const TEST_TIMEOUT_MS = 30 * 60_000;
const SETTLE_TIMEOUT_MS = 12 * 60_000;

/** The render scale the export forces. 2.0 is the top rung of RENDER_SCALE_LADDER. */
const EXPORT_RENDER_SCALE = 2.0;

const SEED = 20260902;

/**
 * main.ts publishes this handle for the console and for e2e. The debug bridge deliberately
 * exposes no resolution control - nothing in the game should have one - but an export has
 * to be able to re-assert its render scale, because the dynamic-resolution governor reads
 * real frame time and a 4K software frame is thousands of times over budget.
 */
interface AppHandle {
  readonly engine: {
    setRenderScale(scale: number): boolean;
    readonly loop: { readonly stats: { readonly frame: number } };
  };
}

/** Erased at runtime, so the browser callbacks below still serialise. */
type AppWindow = { __shatterpoint__?: AppHandle };

const framesPresented = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const app = (window as unknown as AppWindow).__shatterpoint__;
    return app?.engine.loop.stats.frame ?? 0;
  });

const forceRenderScale = (page: Page, scale: number): Promise<boolean> =>
  page.evaluate((s) => {
    const app = (window as unknown as AppWindow).__shatterpoint__;
    return app?.engine.setRenderScale(s) ?? false;
  }, scale);

/**
 * The histogram is the only thing this path reports, so it is checked against an image
 * whose answers are arithmetic rather than opinion. Grey pixels are used throughout: the
 * Rec.709 coefficients sum to 1, so a neutral byte v has luma exactly v/255 and every
 * expected value below can be derived by hand. Costs microseconds and requires no browser.
 */
test.describe('@export4k-selfcheck', () => {
  test.beforeEach(({}) => {
    test.skip(!exportRequested(), 'runs with the export it validates');
  });

  test('lumaStats reports what a known image contains', () => {
    const W = 100;
    const H = 100;
    const png = new PNG({ width: W, height: H });
    const put = (x: number, y: number, v: number): void => {
      const i = (y * W + x) * 4;
      png.data[i] = v;
      png.data[i + 1] = v;
      png.data[i + 2] = v;
      png.data[i + 3] = 255;
    };

    const BG = 64; // luma 0.250980
    const MID = 90; // luma 0.352941 - inside the 28-45% band
    const HOT = 255; // luma 1 - above the 80% threshold
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) put(x, y, BG);
    // 10x10 hot block and 20x20 mid block, both well clear of the 6px edge band and the
    // 8x8 corner boxes, so the edge and corner numbers must stay at the background.
    for (let y = 40; y < 50; y += 1) for (let x = 40; x < 50; x += 1) put(x, y, HOT);
    for (let y = 60; y < 80; y += 1) for (let x = 20; x < 40; x += 1) put(x, y, MID);

    const s = lumaStats(png);
    expect(s.width).toBe(W);
    expect(s.height).toBe(H);
    expect(s.pixels).toBe(W * H);
    expect(s.min).toBeCloseTo(BG / 255, 6);
    expect(s.max).toBeCloseTo(1, 6);
    // Bin centre, not the exact luma: the median comes out of a 1024-bin histogram.
    expect(s.median).toBeCloseTo(BG / 255, 2);
    expect(s.edgeBandMean).toBeCloseTo(BG / 255, 6);
    expect(s.cornerMax).toBeCloseTo(BG / 255, 6);
    expect(s.pctOver80).toBeCloseTo((100 / (W * H)) * 100, 6);
    expect(s.pctIn28to45).toBeCloseTo((400 / (W * H)) * 100, 6);
    expect(s.edgeBandPx).toBe(6);
    expect(s.cornerBoxPx).toEqual({ w: 8, h: 8 });
  });
});

test.describe('@export4k', () => {
  test.beforeEach(({}, info) => {
    test.skip(
      !exportRequested(),
      'export only - run tools/export4k.sh (it sets SP_EXPORT_4K=1)',
    );
    test.skip((info.project.metadata as { scale?: number }).scale !== 4, 'scale-4 project only');
  });

  test('exports a genuine 3840x2160 still', async ({ game }, info) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const page = game.page;

    // The viewport is DERIVED from the target rather than written down, so a change to
    // either the target or the project's deviceScaleFactor cannot silently produce a still
    // that is merely called 4K.
    const dsf = game.scale;
    const css = { width: TARGET.width / dsf, height: TARGET.height / dsf };
    expect(
      Number.isInteger(css.width) && Number.isInteger(css.height),
      `${TARGET.width}x${TARGET.height} is not an integer multiple of deviceScaleFactor ${dsf}`,
    ).toBe(true);

    await game.boot({ scale: EXPORT_RENDER_SCALE, seed: SEED });
    if (hideHudRequested()) await game.hideHud();
    await game.freeze();

    // Compose at the cheap viewport: an empty tutorial corridor is a poor still, and every
    // one of these steps is a fixed update, not a 4K render.
    for (let i = 0; i < COMPOSE_STEPS; i += 1) await game.step();

    await page.setViewportSize(css);

    // The claim, asserted in the page rather than inferred from the config.
    const device = await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));
    expect(device.dpr, 'deviceScaleFactor did not reach the page').toBe(dsf);
    expect(device.innerWidth * device.dpr, 'viewport does not yield 3840 device px').toBe(
      TARGET.width,
    );
    expect(device.innerHeight * device.dpr, 'viewport does not yield 2160 device px').toBe(
      TARGET.height,
    );

    // The ResizeObserver has to have run and the renderer's backing store grown before the
    // capture; polling the drawing buffer is the only statement about that worth making.
    await expect
      .poll(async () => (await game.snapshot()).displayWidth, { timeout: SETTLE_TIMEOUT_MS })
      .toBe(css.width);
    await forceRenderScale(page, EXPORT_RENDER_SCALE);
    await expect
      .poll(async () => (await game.snapshot()).bufferWidth, { timeout: SETTLE_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(TARGET.width);

    const before = await framesPresented(page);
    await expect
      .poll(() => framesPresented(page), { timeout: SETTLE_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(before + SETTLE_FRAMES);

    // Read the state that drew the frame BEFORE capturing it, not after: a 4K encode takes
    // seconds, and a governor drop landing inside that window would condemn a still that was
    // in fact rendered correctly.
    const after = await game.snapshot();
    expect(after.renderScale, 'the governor moved the render scale before the capture').toBe(
      EXPORT_RENDER_SCALE,
    );
    const shot = await page.screenshot({ scale: 'device' });

    await mkdir(EXPORT_DIR, { recursive: true });
    const file = join(EXPORT_DIR, `shatterpoint-${game.tier}-4k.png`);
    await writeFile(file, shot);

    // Decoded off disk. Viewport arithmetic is a prediction; the PNG header is the fact.
    const png = PNG.sync.read(await readFile(file));
    expect(png.width, `${file} is not ${TARGET.width}px wide`).toBe(TARGET.width);
    expect(png.height, `${file} is not ${TARGET.height}px tall`).toBe(TARGET.height);

    // The still must be a downsample of a larger render, never an upscale of a smaller one.
    const supersample = after.bufferWidth / png.width;
    expect(supersample, 'the 4K still was upscaled, not rendered').toBeGreaterThanOrEqual(1);

    const stats = lumaStats(png);
    const report = [
      formatLumaStats(`${game.tier} 4K still`, stats),
      `  file           ${file}`,
      `  render buffer  ${after.bufferWidth}x${after.bufferHeight} ` +
        `(renderScale ${after.renderScale}, effective supersample ${supersample.toFixed(2)}x)`,
      `  hud            ${hideHudRequested() ? 'hidden' : 'composited'}`,
      `  state          approach ${after.approach} panes ${after.paneCount} ` +
        `crystals ${after.crystalCount} shards ${after.liveShards} draws ${after.drawCalls}`,
      `  aa             ${after.liveAA.length > 0 ? after.liveAA.join('+') : 'none'}`,
    ].join('\n');

    console.log(report);
    await info.attach(`export-${game.tier}`, { body: report, contentType: 'text/plain' });
    await writeFile(
      join(EXPORT_DIR, `shatterpoint-${game.tier}-4k.json`),
      `${JSON.stringify({ file, tier: game.tier, seed: SEED, supersample, stats, snapshot: after }, null, 2)}\n`,
    );
  });
});
