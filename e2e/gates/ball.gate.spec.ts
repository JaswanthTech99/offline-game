import { PNG } from 'pngjs';
import { expect, test } from '../fixtures/game';

/**
 * STAGE 1 gate. Throws ONE ball and samples the framebuffer at six points across its
 * flight, reporting measured screen position, pixel radius and peak luminance at each.
 *
 * The ball's position comes from the bridge, not from a pixel search: hunting for a bright
 * blob finds the aperture, the crystal or a pane rim just as happily as it finds the ball,
 * and a gate that can be satisfied by the wrong object proves nothing.
 */

/** Device pixels of radius the ball may never fall below. Mirrors Balance.BALL_MIN_SCREEN_PX. */
const MIN_RADIUS_PX = 4;
const SAMPLES_MS = [100, 200, 300, 400, 500, 600] as const;

interface Sample {
  atMs: number;
  screen: { x: number; y: number } | null;
  radiusPx: number;
  peakLuma: number;
  liveBalls: number;
}

test.describe('@ball', () => {
  // One scale is enough: this gate measures PRESENCE, not sharpness.
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
  });

  test('a thrown ball is locatable across its whole flight', async ({ game }, info) => {
    await game.boot({ seed: 4242 });
    await game.hideHud();
    await game.freeze();

    await game.clearField();
    await game.throwAt(0, 0);

    const dpr = game.scale;
    const samples: Sample[] = [];
    let elapsed = 0;

    for (const at of SAMPLES_MS) {
      // Step the sim deterministically rather than sleeping: a frozen clock is the only way
      // six samples land at the times they claim to.
      while (elapsed < at) {
        await game.step();
        elapsed += 1000 / 60;
      }

      const screen = await game.ballScreen();
      const snap = await game.snapshot();
      const shot = await game.page.screenshot();
      const png = PNG.sync.read(shot);

      let radiusPx = 0;
      let peak = 0;
      if (screen !== null) {
        const cx = Math.round(screen.x * dpr);
        const cy = Math.round(screen.y * dpr);
        const win = 42 * dpr;
        // Local background, so "bright" means bright relative to what surrounds it.
        let bg = 0;
        let bgN = 0;
        for (let y = cy - win; y <= cy + win; y += 3) {
          for (let x = cx - win; x <= cx + win; x += 3) {
            if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
            const d = Math.hypot(x - cx, y - cy);
            if (d < win * 0.55) continue;
            const i = (y * png.width + x) * 4;
            bg += (0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!) / 255;
            bgN++;
          }
        }
        const background = bgN > 0 ? bg / bgN : 0;
        const threshold = Math.max(background * 1.4, background + 0.05);

        for (let y = cy - win; y <= cy + win; y++) {
          for (let x = cx - win; x <= cx + win; x++) {
            if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
            const i = (y * png.width + x) * 4;
            const L = (0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!) / 255;
            if (L > peak) peak = L;
            if (L >= threshold) radiusPx = Math.max(radiusPx, Math.hypot(x - cx, y - cy));
          }
        }
      }
      samples.push({ atMs: at, screen, radiusPx, peakLuma: peak, liveBalls: snap.liveBalls });
    }

    const table = samples
      .map(
        (s) =>
          `  ${String(s.atMs).padStart(4)}ms  ` +
          `screen ${s.screen ? `${s.screen.x.toFixed(0)},${s.screen.y.toFixed(0)}`.padEnd(9) : 'null     '}  ` +
          `radius ${s.radiusPx.toFixed(1).padStart(5)}px  ` +
          `peak ${(s.peakLuma * 100).toFixed(1).padStart(5)}%  balls ${s.liveBalls}`,
      )
      .join('\n');
    console.log(`ball flight (${game.tier}):\n${table}`);
    await info.attach('ball-flight', { body: table, contentType: 'text/plain' });

    for (const s of samples) {
      expect(s.screen, `ball had no position at ${s.atMs}ms`).not.toBeNull();
      expect(s.radiusPx, `ball radius at ${s.atMs}ms`).toBeGreaterThanOrEqual(MIN_RADIUS_PX);
    }
  });
});
