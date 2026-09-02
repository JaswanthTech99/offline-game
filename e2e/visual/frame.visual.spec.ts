import { expect, test } from '../fixtures/game';

/**
 * Visual regression. Frozen and seeded, so a diff means the renderer changed rather than
 * that time passed. The HUD stays IN this shot on purpose: the DOM overlay composites into
 * the shipped image and a regression there is a regression.
 */
test('gameplay frame is stable', async ({ game }) => {
  await game.boot({ seed: 20260902, universe: 'void-cathedral' });
  await game.freeze();
  await expect(game.page).toHaveScreenshot(`gameplay-${game.tier}-${game.scale}x.png`, {
    maxDiffPixelRatio: 0.02,
    animations: 'disabled',
  });
});
