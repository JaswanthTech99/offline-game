import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { expect, test } from '../fixtures/game';
import type { Game } from '../fixtures/game';

/**
 * BREAKABLE PANE gate - "is it a pane, or is it a wireframe?"
 *
 * A bright border around an empty middle is a wireframe. The eye reads it as a debug
 * selection box, and no amount of rim tuning fixes that, because the rim IS the problem.
 * This gate turns that judgement into two numbers that can fail:
 *
 *   INTERIOR - BACKGROUND  >=  INTERIOR_MARGIN
 *       the middle of the pane must carry a value of its own, measurably above whatever
 *       the corridor puts behind it. A pane whose interior equals its background is a hole.
 *   RIM  <=  MAX_RIM_RATIO x INTERIOR
 *       the border may lead, but it may not BE the object. Six is deliberately generous:
 *       at six the border is still six times the surface it is supposed to be bounding.
 *
 * The subject is the SHIPPED pane - `game.place('pane', d)`, which Playfield builds from
 * `glassMaterial()`. That is the only pane a player ever sees; measuring anything else has
 * already produced one wrong result on this project.
 *
 * Two measurement rules that exist because breaking either produced a wrong answer before:
 *
 *   1 OFF-AXIS. The subject is placed at OFFSET_X metres off the corridor axis. Dead centre
 *     puts the far aperture directly behind the pane, and every reading then reports the
 *     aperture glow rather than the glass.
 *   2 PROJECTED, NEVER SEARCHED. The pane's rectangle comes from `window.__sp.project()` on
 *     its own world-space corners. Hunting the image for the brightest blob finds the
 *     aperture, which is exactly how the earlier wrong result happened.
 */

const DISTANCES: readonly number[] = [10, 20, 30, 45, 60, 80, 100];

/** Metres off the corridor axis - see measurement rule 1. */
const OFFSET_X = 2.2;

/** Pane dimensions, mirroring Playfield's TUNING. The gate has to know how big its subject
 *  is in order to project its corners; it must not discover that from the image. */
const PANE_W = 3;
const PANE_H = 3;

/**
 * Luminance, 0..1. Small on purpose: the requirement is that the surface sits ABOVE its
 * background, not that it is bright. Brightness is the rim's job, and glow is not surface.
 */
const INTERIOR_MARGIN = 0.02;
/** Above six, the border is the object and the middle is decoration. That is a wireframe. */
const MAX_RIM_RATIO = 6;

const SEED = 20260902;
/** 8m is the phone screenshot that started this; 20m is the normal engagement range. */
const CAPTURE_DISTANCES: readonly number[] = [8, 20];

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Reading {
  rim: number;
  interior: number;
  background: number;
  widthPx: number;
  heightPx: number;
  bandPx: number;
}

interface Row {
  distance: number;
  reading: Reading;
}

function lumaAt(png: PNG, x: number, y: number): number {
  const i = (y * png.width + x) * 4;
  return (0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!) / 255;
}

/**
 * Three disjoint regions of the SAME image:
 *   rim         a band `bandPx` wide just inside the projected rectangle
 *   interior    everything inboard of that band, minus one pixel of separation
 *   background  a 4..12px annulus OUTSIDE the rectangle - local, because a frame-wide
 *               average would be comparing the pane against the aperture again
 * The band narrows with the subject so the regions stay disjoint at 100m, where the whole
 * pane is barely a dozen pixels across.
 */
function measure(png: PNG, rect: Rect): Reading {
  const x0 = Math.max(0, Math.round(rect.x0));
  const x1 = Math.min(png.width - 1, Math.round(rect.x1));
  const y0 = Math.max(0, Math.round(rect.y0));
  const y1 = Math.min(png.height - 1, Math.round(rect.y1));
  const widthPx = x1 - x0;
  const heightPx = y1 - y0;
  const bandPx = Math.max(1, Math.min(3, Math.round(Math.min(widthPx, heightPx) * 0.18)));
  const inset = bandPx + 1;

  let rimSum = 0;
  let rimN = 0;
  let innerSum = 0;
  let innerN = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const edge = Math.min(x - x0, x1 - x, y - y0, y1 - y);
      const l = lumaAt(png, x, y);
      if (edge < bandPx) {
        rimSum += l;
        rimN++;
      } else if (edge >= inset) {
        innerSum += l;
        innerN++;
      }
    }
  }
  // A subject too small to hold a separated interior still has a centre pixel, and a centre
  // pixel is a fair reading - it is inside the pane by construction.
  if (innerN === 0) {
    innerSum = lumaAt(png, Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2));
    innerN = 1;
  }

  let bgSum = 0;
  let bgN = 0;
  for (let y = y0 - 12; y <= y1 + 12; y++) {
    for (let x = x0 - 12; x <= x1 + 12; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const outside = Math.max(x0 - x, x - x1, y0 - y, y - y1);
      if (outside < 4 || outside > 12) continue;
      bgSum += lumaAt(png, x, y);
      bgN++;
    }
  }

  return {
    rim: rimN > 0 ? rimSum / rimN : 0,
    interior: innerSum / innerN,
    background: bgN > 0 ? bgSum / bgN : 0,
    widthPx,
    heightPx,
    bandPx,
  };
}

async function projectPoint(
  game: Game,
  x: number,
  y: number,
  z: number,
): Promise<{ x: number; y: number } | null> {
  return game.page.evaluate(
    ([px, py, pz]) => window.__sp!.project(px as number, py as number, pz as number),
    [x, y, z] as const,
  );
}

/**
 * The pane's projected rectangle in DEVICE pixels. project() answers in CSS pixels, and the
 * screenshot is in device pixels; at scale 1 they coincide, but the multiply must be there
 * or this gate silently measures the wrong rectangle on any other project.
 */
async function paneRect(game: Game, distance: number, dpr: number): Promise<Rect> {
  const tl = await projectPoint(game, OFFSET_X - PANE_W / 2, PANE_H / 2, -distance);
  const br = await projectPoint(game, OFFSET_X + PANE_W / 2, -PANE_H / 2, -distance);
  expect(tl, `pane at ${distance}m did not project`).not.toBeNull();
  expect(br, `pane at ${distance}m did not project`).not.toBeNull();
  return { x0: tl!.x * dpr, y0: tl!.y * dpr, x1: br!.x * dpr, y1: br!.y * dpr };
}

/** One frozen frame with exactly one breakable pane on the field, off axis. */
async function shootPaneAt(game: Game, distance: number): Promise<PNG> {
  await game.clearField();
  await game.place('pane', distance, OFFSET_X);
  await game.step();
  return PNG.sync.read(await game.page.screenshot());
}

test.describe('@pane-detail', () => {
  // One scale: this gate measures whether a surface has a value, not how sharp its edges are.
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
  });

  test('a breakable pane reads as a surface from 10m to 100m', async ({ game }, info) => {
    // Vite's HMR socket is answered by a mock that never delivers an update. This gate holds
    // one frozen page for a minute of captures, and any src/ edit anywhere in the repo would
    // otherwise trigger a reload that destroys the execution context mid-measurement.
    await game.page.routeWebSocket('**', () => {});

    await game.boot({ seed: SEED, universe: 'void-cathedral' });
    await game.hideHud();
    await game.freeze();

    const dpr = game.scale;
    const rows: Row[] = [];
    await mkdir('exports', { recursive: true });

    for (const distance of DISTANCES) {
      const rect = await paneRect(game, distance, dpr);
      const png = await shootPaneAt(game, distance);
      rows.push({ distance, reading: measure(png, rect) });
    }

    // The two judgement captures. Written whole - a crop hides whether the pane sits in its
    // corridor convincingly, which is the half of this a human has to rule on.
    for (const distance of CAPTURE_DISTANCES) {
      const png = await shootPaneAt(game, distance);
      await writeFile(join('exports', `pane-glass-${distance}m.png`), PNG.sync.write(png));
    }

    const header =
      '  dist  px        rim     interior  background  rim/int  int-bg\n' +
      '  ----  --------  ------  --------  ----------  -------  ------';
    const table = rows.map(({ distance, reading: m }) => {
      const ratio = m.interior > 0 ? m.rim / m.interior : Number.POSITIVE_INFINITY;
      const lift = m.interior - m.background;
      return (
        `  ${String(distance).padStart(4)}  ${`${m.widthPx}x${m.heightPx}`.padEnd(8)}  ` +
        `${m.rim.toFixed(4)}  ${m.interior.toFixed(4)}    ${m.background.toFixed(4)}      ` +
        `${(Number.isFinite(ratio) ? ratio.toFixed(2) : 'inf').padStart(7)}  ` +
        `${(lift >= 0 ? '+' : '') + lift.toFixed(4)}`
      );
    });

    const report = [
      `breakable pane, seed ${SEED}, ${OFFSET_X}m off axis, ${dpr}x device pixels`,
      `thresholds: interior-background >= ${INTERIOR_MARGIN}, rim <= ${MAX_RIM_RATIO}x interior`,
      header,
      ...table,
      '',
      `captures: ${CAPTURE_DISTANCES.map((d) => `exports/pane-glass-${d}m.png`).join(', ')}`,
    ].join('\n');

    console.log(report);
    await info.attach('pane-detail', { body: report, contentType: 'text/plain' });

    for (const { distance, reading: m } of rows) {
      const where = `pane at ${distance}m (${m.widthPx}x${m.heightPx}px)`;
      expect
        .soft(m.interior - m.background, `${where}: interior does not clear its background`)
        .toBeGreaterThanOrEqual(INTERIOR_MARGIN);
      expect
        .soft(
          m.rim,
          `${where}: rim ${m.rim.toFixed(3)} over interior ${m.interior.toFixed(3)} is a wireframe`,
        )
        .toBeLessThanOrEqual(m.interior * MAX_RIM_RATIO);
    }
  });
});

/**
 * HUE IS NOT A CHANNEL EVERY PLAYER HAS.
 *
 * Roughly one man in twelve cannot separate the reserved cyan from a neutral grey, and the
 * corridor is deliberately near-neutral so that hue can carry meaning - which makes hue the
 * single point of failure for "what may I hit". The value structure has to answer the
 * question on its own, so this measures both panes in the SAME frame with the colour thrown
 * away, and asks whether the breakable one is still obviously the brighter object.
 *
 * Same frame, not two frames: bloom, fog and the vignette all vary with what else is on
 * screen, and a comparison across two captures compares two lighting situations.
 */
const GREYSCALE_DISTANCE = 20;
/** How much brighter a hittable pane must be than a decorative one, in greyscale. */
const MIN_GREYSCALE_RATIO = 1.5;

/** Rec.709 on the sRGB bytes - the same luma the rest of this file uses. */
function greyMean(png: PNG, rect: Rect): number {
  const x0 = Math.max(0, Math.ceil(Math.min(rect.x0, rect.x1)));
  const x1 = Math.min(png.width - 1, Math.floor(Math.max(rect.x0, rect.x1)));
  const y0 = Math.max(0, Math.ceil(Math.min(rect.y0, rect.y1)));
  const y1 = Math.min(png.height - 1, Math.floor(Math.max(rect.y0, rect.y1)));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * png.width + x) * 4;
      sum +=
        (0.2126 * (png.data[i] ?? 0) +
          0.7152 * (png.data[i + 1] ?? 0) +
          0.0722 * (png.data[i + 2] ?? 0)) /
        255;
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

test.describe('@pane-greyscale', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
  });

  test('a breakable pane outreads a decorative one with the hue removed', async ({
    game,
  }, info) => {
    await game.page.routeWebSocket('**', () => {});
    await game.boot({ seed: SEED, universe: 'void-cathedral' });
    await game.hideHud();
    await game.freeze();

    const dpr = game.scale;
    await game.clearField();
    // Mirrored about the corridor axis so neither gets a lighting advantage from the rig.
    await game.place('pane', GREYSCALE_DISTANCE, -OFFSET_X);
    await game.placeAlso('decorative', GREYSCALE_DISTANCE, OFFSET_X);
    await game.step();

    const png = PNG.sync.read(await game.page.screenshot());

    const rectFor = async (offsetX: number): Promise<Rect> => {
      const tl = await projectPoint(
        game,
        offsetX - PANE_W / 2,
        PANE_H / 2,
        -GREYSCALE_DISTANCE,
      );
      const br = await projectPoint(
        game,
        offsetX + PANE_W / 2,
        -PANE_H / 2,
        -GREYSCALE_DISTANCE,
      );
      expect(tl, 'subject did not project').not.toBeNull();
      expect(br, 'subject did not project').not.toBeNull();
      return { x0: tl!.x * dpr, y0: tl!.y * dpr, x1: br!.x * dpr, y1: br!.y * dpr };
    };

    const breakable = greyMean(png, await rectFor(-OFFSET_X));
    const decorative = greyMean(png, await rectFor(OFFSET_X));
    const ratio = decorative > 0 ? breakable / decorative : Number.POSITIVE_INFINITY;

    const report =
      `both panes at ${GREYSCALE_DISTANCE}m, same frame, colour discarded\n` +
      `  breakable   ${breakable.toFixed(4)}\n` +
      `  decorative  ${decorative.toFixed(4)}\n` +
      `  ratio       ${ratio.toFixed(2)}x  (need >= ${MIN_GREYSCALE_RATIO}x)`;
    console.log(`\n${report}\n`);
    await info.attach('pane-greyscale', { body: report, contentType: 'text/plain' });

    // Written out in greyscale so the claim can be checked by eye, not only by ratio.
    const grey = new PNG({ width: png.width, height: png.height });
    for (let i = 0; i < png.data.length; i += 4) {
      const l = Math.round(
        0.2126 * (png.data[i] ?? 0) +
          0.7152 * (png.data[i + 1] ?? 0) +
          0.0722 * (png.data[i + 2] ?? 0),
      );
      grey.data[i] = l;
      grey.data[i + 1] = l;
      grey.data[i + 2] = l;
      grey.data[i + 3] = 255;
    }
    await mkdir('exports', { recursive: true });
    await writeFile(join('exports', 'pane-greyscale.png'), PNG.sync.write(grey));
    await info.attach('greyscale-frame', {
      body: PNG.sync.write(grey),
      contentType: 'image/png',
    });

    expect(
      ratio,
      `a breakable pane is only ${ratio.toFixed(2)}x a decorative one without hue`,
    ).toBeGreaterThanOrEqual(MIN_GREYSCALE_RATIO);
  });
});

/**
 * THE OUTLINE MUST BE CORNERS, NOT A CLOSED STROKE.
 *
 * A rectangle of uniform stroke is what every editor on earth draws around a selected
 * object, and that is the read the device screenshots came back with. Four L-shaped arms
 * say "framed pane" instead. This is measurable without looking at anything: walk the top
 * edge band and compare the two outer thirds against the middle third. A continuous rim is
 * flat across all three. Brackets are bright at the ends and dark in the middle.
 *
 * It also catches the opposite failure - brackets that did not build at all, or a UV mask
 * that inverted - which a mean-luminance gate over the whole pane cannot see.
 */
const BRACKET_DISTANCE = 20;
/** Depth of the sampled band inside the top border, in device pixels. */
const EDGE_BAND_PX = 3;
/** How much brighter the arm ends must be than the span between them. */
const MIN_BRACKET_CONTRAST = 1.8;

function bandMean(png: PNG, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, Math.ceil(y0)); y <= Math.min(png.height - 1, Math.floor(y1)); y += 1) {
    for (let x = Math.max(0, Math.ceil(x0)); x <= Math.min(png.width - 1, Math.floor(x1)); x += 1) {
      const i = (y * png.width + x) * 4;
      sum +=
        (0.2126 * (png.data[i] ?? 0) +
          0.7152 * (png.data[i + 1] ?? 0) +
          0.0722 * (png.data[i + 2] ?? 0)) /
        255;
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

test.describe('@pane-brackets', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
  });

  test('the pane border is corner brackets, not a continuous outline', async ({
    game,
  }, info) => {
    await game.page.routeWebSocket('**', () => {});
    await game.boot({ seed: SEED, universe: 'void-cathedral' });
    await game.hideHud();
    await game.freeze();

    const png = await shootPaneAt(game, BRACKET_DISTANCE);
    const rect = await paneRect(game, BRACKET_DISTANCE, game.scale);

    const left = Math.min(rect.x0, rect.x1);
    const right = Math.max(rect.x0, rect.x1);
    const top = Math.min(rect.y0, rect.y1);
    const width = right - left;
    const yTop = top;
    const yBot = top + EDGE_BAND_PX;

    const thirds = [0, 1, 2].map((i) =>
      bandMean(png, left + (width * i) / 3, left + (width * (i + 1)) / 3, yTop, yBot),
    );
    // The band sits ON the face, so the raw thirds are dominated by whatever the face is
    // doing. A bracket is an ADDITION to the face; the question is whether that addition is
    // localised to the corners, so the face has to come out of both sides of the ratio.
    const faceH = Math.abs(rect.y1 - rect.y0);
    const face = bandMean(
      png,
      left + width * 0.35,
      left + width * 0.65,
      top + faceH * 0.4,
      top + faceH * 0.6,
    );
    const arms = ((thirds[0] ?? 0) + (thirds[2] ?? 0)) / 2 - face;
    const span = (thirds[1] ?? 0) - face;
    const contrast = span > 1e-6 ? arms / span : Number.POSITIVE_INFINITY;

    // Twelve columns across the same band, so the shape is legible and not just the verdict.
    const COLUMNS = 12;
    const profile: string[] = [];
    for (let i = 0; i < COLUMNS; i += 1) {
      const v = bandMean(
        png,
        left + (width * i) / COLUMNS,
        left + (width * (i + 1)) / COLUMNS,
        yTop,
        yBot,
      );
      profile.push(`${'#'.repeat(Math.round(v * 30)).padEnd(30)} ${v.toFixed(3)}`);
    }

    const report =
      `top edge band of a pane at ${BRACKET_DISTANCE}m, ${EDGE_BAND_PX}px deep\n` +
      `  face         ${face.toFixed(4)}\n` +
      `  arm lift     ${arms.toFixed(4)}\n` +
      `  span lift    ${span.toFixed(4)}\n` +
      `  contrast     ${contrast.toFixed(2)}x  (need >= ${MIN_BRACKET_CONTRAST}x)\n\n` +
      `profile left to right:\n  ${profile.join('\n  ')}`;
    console.log(`\n${report}\n`);
    await info.attach('pane-brackets', { body: report, contentType: 'text/plain' });

    expect(
      contrast,
      `the border is ${contrast.toFixed(2)}x brighter at the arms than between them - ` +
        'below 1.8 it is a continuous stroke, which reads as a selection box',
    ).toBeGreaterThanOrEqual(MIN_BRACKET_CONTRAST);
  });
});
