import { expect, test } from '../fixtures/game';

/**
 * STAGE 0 gate. Proves the harness itself is sound before any gate built on it is trusted:
 * the game boots on every tier at every device scale, the bridge answers, and the reported
 * buffer actually matches the device scale the project asked for.
 */
test('boots and reports a coherent surface', async ({ game }, info) => {
  await game.boot();
  const s = await game.snapshot();

  expect(s.ready).toBe(true);
  expect(s.tier).toBe(game.tier);
  expect(s.tierSource).toBe('override');

  // The buffer must track deviceScaleFactor x renderScale, or every pixel measurement in
  // every other gate is being taken at a resolution nobody declared.
  const expected = Math.round(s.displayWidth * game.scale * s.renderScale);
  expect(Math.abs(s.bufferWidth - expected)).toBeLessThanOrEqual(2);

  // FXAA is a last-resort path; a tier resolving to it means the AA table regressed.
  expect(s.liveAA.length).toBeGreaterThan(0);
  expect(s.liveAA).not.toContain('fxaa');

  expect(s.drawCalls).toBeGreaterThan(0);
  expect(s.elementCount).toBeGreaterThan(0);

  await info.attach(`surface-${game.tier}-${game.scale}x`, {
    body: JSON.stringify(s, null, 2),
    contentType: 'application/json',
  });

  await game.freeze();
  await info.attach(`frame-${game.tier}-${game.scale}x.png`, {
    body: await game.page.screenshot(),
    contentType: 'image/png',
  });
});

test('draw calls stay inside the tier ceiling', async ({ game }) => {
  await game.boot();
  const s = await game.snapshot();
  const CEILING: Record<string, number> = {
    ULTRA_4K: 900,
    DESKTOP_HIGH: 700,
    MOBILE_HIGH: 380,
    MOBILE_LOW: 180,
  };
  expect(s.drawCalls).toBeLessThanOrEqual(CEILING[game.tier] ?? 900);
  expect(s.elementCount).toBeGreaterThanOrEqual(400);
});
