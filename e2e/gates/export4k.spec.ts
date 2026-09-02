import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '../fixtures/game';

/**
 * STAGE 4b. A genuine 3840x2160 still per tier.
 *
 * This does NOT need a GPU. Interactive sharpness on this host is capped by the absence of
 * one, but a still is just a slow frame, and a slow frame is free. Rendered at device scale
 * 4 with render scale forced to 2.0, then captured at the full 4K viewport.
 */
const OUT = 'exports';

test.describe('@export4k', () => {
  // Once per tier, on the 4x project only.
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 4, 'scale-4 project only');
  });

  test('exports a 3840x2160 still', async ({ game }, info) => {
    // Projects hold device pixels constant so the gates stay tractable; this one wants the
    // opposite, so it sets its own viewport: 960x540 at deviceScaleFactor 4 is 3840x2160.
    await game.page.setViewportSize({ width: 960, height: 540 });
    await game.boot({ scale: 2.0, seed: 20260902 });
    await game.freeze();

    await mkdir(OUT, { recursive: true });
    const file = join(OUT, `shatterpoint-${game.tier}-4k.png`);
    const png = await game.page.screenshot({ scale: 'device' });
    await writeFile(file, png);

    const s = await game.snapshot();
    await info.attach(`export-${game.tier}`, {
      body: JSON.stringify({ file, buffer: `${s.bufferWidth}x${s.bufferHeight}`, ...s }, null, 2),
      contentType: 'application/json',
    });
  });
});
