import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/game';

/**
 * STAGE 1 gate - CAN THE PLAYER SEE WHAT THEY THREW?
 *
 * One ball, six samples across its flight, each one taken by stepping the frozen sim so the
 * times on the table are the times the rows claim. At each sample the gate reports where the
 * ball is, how big it is and how bright it is.
 *
 * THE BALL'S POSITION COMES FROM THE BRIDGE, NEVER FROM A PIXEL SEARCH. Two earlier
 * measurement passes on this project were wrong because they hunted for the brightest thing
 * in the frame; the brightest thing in this frame is the aperture at the vanishing point,
 * which is exactly where a centred throw is heading. `game.ballScreen()` projects the real
 * simulation position, so every number below is measured AT the subject.
 *
 * WHAT THE MEASUREMENT IS.
 *   coreR - the half-maximum radius. Walk outward from the projected centre along 16 rays
 *           until luminance falls below background + half the peak-above-background, and
 *           take the median ray. Half-maximum lands on the ball's own limb rather than on
 *           the outer edge of its halo, and the median stops one bright neighbour - a strip
 *           light, a pane rim - from inflating the answer.
 *   glowR - the same walk against a low absolute threshold: the full extent of the ball's
 *           light, halo included. This is the number that says whether the eye has anything
 *           to catch at all.
 *
 * WHY A CLEARED FIELD. The first pane row stands 26 m down the corridor and the ball closes
 * on it at 78 m/s, so an un-cleared field kills the ball at 283 ms - measured, in the
 * diagnosis run that produced this gate. The corridor is 6.8 m tall and 10 m wide, so there
 * is no aim that threads a row and still survives 600 ms. An empty field is the only rig in
 * which a six-hundred-millisecond flight exists to be measured.
 */

/**
 * Device pixels of radius the ball may never fall below. BallVisual's floor is stated as a
 * projected DIAMETER (BALL_VISUAL.minScreenPx = 14), so the geometric radius floor is 7 px;
 * the assertion sits at 6 because a shaded sphere's limb falls under half-maximum a pixel
 * before the silhouette ends, and SMAA spreads that last pixel further still.
 */
const MIN_CORE_RADIUS_PX = 6;
/** The halo is 3.4x the ball's diameter, so its light must reach well past the core. */
const MIN_GLOW_RADIUS_PX = 9;

const SAMPLES_MS = [100, 200, 300, 400, 500, 600] as const;
const STEP_MS = 1000 / 60;

interface Sample {
  atMs: number;
  screen: { x: number; y: number } | null;
  coreR: number;
  glowR: number;
  peak: number;
  background: number;
  liveBalls: number;
}

/**
 * Seven agents share one dev server. A hot reload triggered by an unrelated edit calls
 * location.reload() and destroys the execution context mid-flight, which is what the first
 * two runs of this gate actually failed on. The page opens no socket of its own, so
 * silencing WebSocket silences vite's HMR client and nothing else.
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

function luminanceAt(png: PNG, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return -1;
  const i = (y * png.width + x) * 4;
  return (0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!) / 255;
}

/** Median ray length from (cx,cy) before luminance drops under `limit`. */
function medianRadius(png: PNG, cx: number, cy: number, limit: number): number {
  const rays: number[] = [];
  for (let a = 0; a < 16; a++) {
    const theta = (a / 16) * Math.PI * 2;
    let r = 0;
    for (; r < 48; r++) {
      if (luminanceAt(png, Math.round(cx + Math.cos(theta) * r), Math.round(cy + Math.sin(theta) * r)) < limit) {
        break;
      }
    }
    rays.push(r);
  }
  rays.sort((p, q) => p - q);
  return rays[8] ?? 0;
}

function probe(png: PNG, cx: number, cy: number): Omit<Sample, 'atMs' | 'screen' | 'liveBalls'> {
  // Local background from an annulus well outside the halo, so "bright" means bright
  // relative to the corridor the ball is actually in front of.
  let sum = 0;
  let n = 0;
  for (let a = 0; a < 64; a++) {
    const theta = (a / 64) * Math.PI * 2;
    for (let r = 34; r <= 46; r += 2) {
      const v = luminanceAt(png, Math.round(cx + Math.cos(theta) * r), Math.round(cy + Math.sin(theta) * r));
      if (v >= 0) {
        sum += v;
        n++;
      }
    }
  }
  const background = n > 0 ? sum / n : 0;

  let peak = 0;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const v = luminanceAt(png, cx + dx, cy + dy);
      if (v > peak) peak = v;
    }
  }

  return {
    coreR: medianRadius(png, cx, cy, background + 0.5 * (peak - background)),
    glowR: medianRadius(png, cx, cy, background + 0.04),
    peak,
    background,
  };
}

test.describe('@ball', () => {
  // One scale is enough: this gate measures PRESENCE, not sharpness.
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
  });

  test('a thrown ball is locatable across its whole flight', async ({ game }, info) => {
    await pinPage(game.page);
    await game.boot({ seed: 4242 });
    await game.hideHud();
    await game.freeze();

    await game.clearField();
    await game.throwAt(0, 0);

    // Precondition, stated separately because its failure has one specific cause and a
    // generic "radius too small" would send the next reader hunting for a shader bug:
    // Playfield.fixedUpdate returns before advanceBalls while the field is held, so a
    // cleared field parks the ball on the camera for ever and every row below reads null.
    await game.step();
    expect(
      await game.ballScreen(),
      'the ball never left the muzzle - a held field must still advance thrown balls',
    ).not.toBeNull();

    const dpr = game.scale;
    const samples: Sample[] = [];
    let elapsed = STEP_MS;

    for (const at of SAMPLES_MS) {
      // Step the sim deterministically rather than sleeping: a frozen clock is the only way
      // six samples land at the times they claim.
      while (elapsed < at) {
        await game.step();
        elapsed += STEP_MS;
      }

      const screen = await game.ballScreen();
      const snap = await game.snapshot();
      const png = PNG.sync.read(await game.page.screenshot());
      const measured =
        screen === null
          ? { coreR: 0, glowR: 0, peak: 0, background: 0 }
          : probe(png, Math.round(screen.x * dpr), Math.round(screen.y * dpr));

      samples.push({ atMs: at, screen, ...measured, liveBalls: snap.liveBalls });
    }

    const rows = samples
      .map(
        (s) =>
          `  ${String(s.atMs).padStart(4)}ms  ` +
          `screen ${s.screen === null ? 'null     ' : `${s.screen.x.toFixed(0)},${s.screen.y.toFixed(0)}`.padEnd(9)}  ` +
          `coreR ${s.coreR.toFixed(1).padStart(5)}px  ` +
          `glowR ${s.glowR.toFixed(1).padStart(5)}px  ` +
          `peak ${(s.peak * 100).toFixed(1).padStart(5)}%  ` +
          `bg ${(s.background * 100).toFixed(1).padStart(5)}%  ` +
          `balls ${s.liveBalls}`,
      )
      .join('\n');
    console.log(`ball flight (${game.tier}@${String(dpr)}x):\n${rows}`);
    await info.attach('ball-flight', { body: rows, contentType: 'text/plain' });

    for (const s of samples) {
      expect(s.liveBalls, `the ball was gone at ${String(s.atMs)}ms`).toBe(1);
      expect(s.screen, `ball had no position at ${String(s.atMs)}ms`).not.toBeNull();
      expect(s.coreR, `ball core radius at ${String(s.atMs)}ms`).toBeGreaterThanOrEqual(
        MIN_CORE_RADIUS_PX,
      );
      expect(s.glowR, `ball glow radius at ${String(s.atMs)}ms`).toBeGreaterThanOrEqual(
        MIN_GLOW_RADIUS_PX,
      );
    }
  });
});
