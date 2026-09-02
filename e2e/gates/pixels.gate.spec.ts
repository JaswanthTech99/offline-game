import { expect, test } from '../fixtures/game';

/**
 * STAGE 1 gate. The scale chain, end to end, per tier at two output sizes.
 *
 * Render scale was being applied TWICE - once in Engine.applySize's pixel ratio and again
 * in PostChain's setResolutionScale - so the scene rendered at renderScale squared: 13% of
 * native pixels at the 0.6 rung. This gate exists so that can never come back silently.
 */
const OUTPUTS = [
  { label: '1920x1080', width: 1920, height: 1080 },
  { label: '3840x2160', width: 3840, height: 2160 },
] as const;

test.describe('@pixels', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
    // SHOWCASE renders at 2.0 by design - a 3840x2160 scene pass for a 1080p output. On a
    // CPU rasteriser that cannot present a first frame inside any sane timeout, and the
    // tier exists for stills and real GPUs. It is exercised by export:4k, not here.
    test.skip(
      (info.project.metadata as { tier?: string }).tier === 'SHOWCASE',
      'SHOWCASE is exercised by export:4k; it cannot present interactively without a GPU',
    );
  });

  for (const out of OUTPUTS) {
    test(`scale chain is coherent at ${out.label}`, async ({ game }, info) => {
      // deviceScaleFactor is fixed per project, so drive output size via the viewport.
      await game.page.setViewportSize({ width: out.width / 2, height: out.height / 2 });
      await game.boot({ seed: 7 });
      const s = await game.snapshot();

      const outPx = s.bufferWidth * s.bufferHeight;
      const scenePx = s.scenePassWidth * s.scenePassHeight;
      const ratio = scenePx / outPx;

      const line =
        `${game.tier.padEnd(13)} ${out.label}\n` +
        `    requested rung     ${s.renderScale.toFixed(2)}\n` +
        `    hardwareCeiling    ${s.hardwareCeiling.toFixed(3)}  (maxTextureSize ${s.maxTextureSize})\n` +
        `    output buffer      ${s.bufferWidth}x${s.bufferHeight}\n` +
        `    scene pass         ${s.scenePassWidth}x${s.scenePassHeight}\n` +
        `    scenePx / outPx    ${ratio.toFixed(3)}\n` +
        `    AA + upscaler      ${s.liveAA.join(', ') || '(none)'}\n` +
        `    pipelines          ${s.pipelines}`;
      console.log(line);
      await info.attach(`pixels-${game.tier}-${out.label}`, { body: line, contentType: 'text/plain' });

      // The squared-scale bug showed as ratio == rung^2. Assert against the rung itself.
      const rung = Math.min(1, s.renderScale);
      expect(ratio, 'scene-pass pixels fell below the requested rung').toBeGreaterThanOrEqual(
        rung * rung - 0.02,
      );

      // A sub-native buffer must have something reconstructing it.
      if (s.renderScale < 1) {
        expect(
          s.liveAA.some((a) => a === 'taau' || a === 'fsr1'),
          `renderScale ${s.renderScale} with no upscaler: ${s.liveAA.join(',')}`,
        ).toBe(true);
      }
      expect(s.liveAA).not.toContain('fxaa');
    });
  }

  test('shader graph is warm before the first frame', async ({ game }, info) => {
    await game.boot({ seed: 7 });
    const first = await game.snapshot();
    for (let i = 0; i < 40; i++) await game.step();
    const later = await game.snapshot();
    const grew = later.pipelines - first.pipelines;
    const msg = `pipelines after first present: ${first.pipelines} -> ${later.pipelines} (grew ${grew})`;
    console.log(msg);
    await info.attach('warmup', { body: msg, contentType: 'text/plain' });
    expect(grew, 'pipelines still compiling after the first presented frame').toBe(0);
  });

  test('render scale is stable across the first ten seconds', async ({ game }, info) => {
    await game.boot({ seed: 7 });
    const at: string[] = [];
    for (const ms of [500, 1000, 2000, 5000, 10_000]) {
      await game.page.waitForTimeout(ms - (at.length > 0 ? [500, 1000, 2000, 5000][at.length - 1]! : 0));
      const s = await game.snapshot();
      at.push(`${ms}ms scale=${s.renderScale.toFixed(2)} buffer=${s.bufferWidth}x${s.bufferHeight}`);
    }
    console.log(at.join('\n'));
    await info.attach('scale-stability', { body: at.join('\n'), contentType: 'text/plain' });
    const scales = new Set(at.map((a) => a.split('scale=')[1]?.split(' ')[0]));
    expect(scales.size, `render scale moved during warmup: ${at.join(' | ')}`).toBe(1);
  });
});
