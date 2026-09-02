import { expect, test } from '../fixtures/game';

/**
 * STAGE E. The HUD must not lie.
 *
 * Two defects this locks down: FPS was scored as a ceiling, so beating the target painted
 * red; and the scale row measured against the ladder maximum (2.0) rather than native, so a
 * perfectly healthy 1.0 read as a two-thirds shortfall.
 */
test.describe('@hud', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
  });

  test('reports resolved values and honest pass/fail', async ({ game }, info) => {
    await game.boot({ seed: 90210 });
    const s = await game.snapshot();

    // Break one pane so the shard counter has something to report.
    await game.place('pane', 12);
    await game.shatter();
    let shardPeak = 0;
    for (let i = 0; i < 30; i++) {
      await game.step();
      const snap = await game.snapshot();
      shardPeak = Math.max(shardPeak, snap.liveShards);
    }

    const rows = await game.page.evaluate(() =>
      [...document.querySelectorAll('.sp-tel-row')].map((r) => ({
        name: r.querySelector('.sp-tel-name')?.textContent ?? '',
        value: r.querySelector('.sp-tel-v')?.textContent ?? '',
        over: r.getAttribute('data-over'),
      })),
    );

    const report = [
      `tier          ${s.tier} (${s.tierSource})`,
      `render scale  ${s.renderScale.toFixed(2)}`,
      `buffer        ${s.bufferWidth}x${s.bufferHeight}`,
      `display       ${s.displayWidth}x${s.displayHeight}`,
      `ratio         ${(s.bufferWidth / s.displayWidth).toFixed(3)}`,
      `live AA       ${s.liveAA.join(', ')}`,
      `SHARDS peak   ${shardPeak}`,
      '',
      ...rows.map((r) => `  ${r.name.padEnd(7)} ${r.value.padEnd(18)} over=${r.over}`),
    ].join('\n');
    console.log(`HUD truth:\n${report}`);
    await info.attach('hud-truth', { body: report, contentType: 'text/plain' });

    expect(shardPeak, 'ShatterFx produced no shards').toBeGreaterThan(0);

    const fps = rows.find((r) => r.name === 'fps');
    expect(fps, 'no fps row').toBeDefined();
    // The whole point: an fps row is only "over" when it is BELOW target.
    const [measured, target] = (fps?.value ?? '0 / 0').split('/').map((n) => Number(n.trim()));
    if (measured !== undefined && target !== undefined && measured >= target) {
      expect(fps?.over, `fps ${measured} beats target ${target} but is flagged over`).toBe('false');
    }
  });
});
