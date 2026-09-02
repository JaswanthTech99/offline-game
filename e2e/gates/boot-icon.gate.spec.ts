import { expect, test } from '../fixtures/game';

/**
 * STAGE 3 gate. The boot icon must be fully drawn in the FIRST painted frame.
 *
 * That is the whole point of inlining it: a fetched icon flashes an empty box before it
 * lands, at exactly the moment the veil exists to look composed. Sampling at 100ms is how
 * we prove it was never fetched - a network round trip cannot complete that fast even from
 * a warm cache on this host.
 */

interface Frame {
  atMs: number;
  iconBox: { w: number; h: number } | null;
  iconPainted: boolean;
  wordX: number | null;
  wordY: number | null;
  status: string;
}

test.describe('@booticon', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
    test.skip((info.project.metadata as { tier?: string }).tier !== 'DESKTOP_HIGH', 'one tier is enough');
  });

  async function sample(page: import('@playwright/test').Page): Promise<Frame> {
    return page.evaluate(() => {
      const icon = document.querySelector('.boot__icon');
      const word = document.querySelector('.boot__word');
      const status = document.querySelector('#boot-status');
      const ib = icon?.getBoundingClientRect();
      const wb = word?.getBoundingClientRect();
      return {
        atMs: 0,
        iconBox: ib ? { w: Math.round(ib.width), h: Math.round(ib.height) } : null,
        // Inline SVG has real child geometry immediately; a pending <img> would not.
        iconPainted: (icon?.querySelectorAll('polygon, path').length ?? 0) > 20,
        wordX: wb ? Math.round(wb.left) : null,
        wordY: wb ? Math.round(wb.top) : null,
        status: status?.textContent ?? '',
      };
    });
  }

  test('icon is drawn in the first frame and the wordmark never shifts', async ({ game }, info) => {
    const frames: Frame[] = [];
    // Deliberately NOT using the ready-wait: this test is about the veil, which exists long
    // before the renderer does.
    await game.page.goto('/?tier=DESKTOP_HIGH&webgl=1', { waitUntil: 'commit' });
    await game.page.waitForTimeout(100);

    // The veil's whole lifetime can be under 200ms on a warm cache, so fixed sample points
    // measure its absence rather than the icon. Poll finely and keep every frame in which
    // the veil was actually up - that is the window the icon has to be correct in.
    const deadline = Date.now() + 4000;
    let statusSeen = 'Starting up';
    while (Date.now() < deadline) {
      const alive = await game.page.evaluate(() => {
        const boot = document.querySelector('#boot');
        return boot !== null && boot.getAttribute('data-state') !== 'done';
      });
      if (!alive) break;
      const f = await sample(game.page);
      f.atMs = frames.length === 0 ? 100 : Date.now() % 100000;
      frames.push(f);
      if (f.status !== '' && f.status !== statusSeen) {
        statusSeen = f.status;
        await info.attach(`boot-status-${statusSeen.replace(/\W+/g, '-')}.png`, {
          body: await game.page.screenshot(),
          contentType: 'image/png',
        });
      }
      if (frames.length <= 3) {
        await info.attach(`boot-frame-${frames.length}.png`, {
          body: await game.page.screenshot(),
          contentType: 'image/png',
        });
      }
      await game.page.waitForTimeout(25);
    }

    const table = frames
      .map(
        (f) =>
          `  ${(f.atMs === -1 ? 'status' : `${f.atMs}ms`).padStart(7)}  ` +
          `icon ${f.iconBox ? `${f.iconBox.w}x${f.iconBox.h}` : 'ABSENT'}`.padEnd(18) +
          `painted=${String(f.iconPainted).padEnd(5)} wordAt=${f.wordX},${f.wordY}  "${f.status}"`,
      )
      .join('\n');
    console.log(`boot icon:\n${table}`);
    await info.attach('boot-icon-table', { body: table, contentType: 'text/plain' });

    expect(frames.length, 'the veil never appeared at all').toBeGreaterThan(0);
    const first = frames[0]!;
    expect(first.iconBox, 'no boot icon at 100ms - is it inlined?').not.toBeNull();
    expect(first.iconPainted, 'boot icon has no geometry at 100ms - it was fetched').toBe(true);
    expect(first.iconBox!.w, 'icon is not correctly sized at first paint').toBeGreaterThanOrEqual(64);
    // The bug this catches: with sizing left to a JS-imported stylesheet the icon painted at
    // its intrinsic 1024px before app.css arrived.
    expect(first.iconBox!.w, 'icon painted at intrinsic size - app.css had not loaded').toBeLessThanOrEqual(160);

    // No layout shift of the wordmark across the whole sequence.
    const xs = new Set(frames.map((f) => f.wordX));
    const ys = new Set(frames.map((f) => f.wordY));
    expect(xs.size, `wordmark moved horizontally: ${[...xs].join(', ')}`).toBe(1);
    expect(ys.size, `wordmark moved vertically: ${[...ys].join(', ')}`).toBe(1);
  });

  test('reduced motion leaves the icon static and fully composed', async ({ browser }, info) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 960, height: 540 } });
    const page = await ctx.newPage();
    await page.goto('/?tier=DESKTOP_HIGH&webgl=1', { waitUntil: 'commit' });
    await page.waitForTimeout(150);

    const a = await page.evaluate(() => {
      const el = document.querySelector('.boot__icon');
      const cs = el ? getComputedStyle(el) : null;
      const r = el?.getBoundingClientRect();
      return { anim: cs?.animationName ?? 'none', opacity: cs?.opacity ?? '0', w: Math.round(r?.width ?? 0) };
    });
    // Compare only while the veil is still up: it fades to 0 on completion by design, and
    // measuring that would report the veil doing its job as an animation loop.
    await page.waitForTimeout(120);
    const b = await page.evaluate(() => {
      const el = document.querySelector('.boot__icon');
      const cs = el ? getComputedStyle(el) : null;
      const done = document.querySelector('#boot')?.getAttribute('data-state') === 'done';
      return { opacity: done ? 'veil-done' : (cs?.opacity ?? '0') };
    });

    const msg = `reduced motion: animationName=${a.anim} opacity=${a.opacity}->${b.opacity} width=${a.w}px`;
    console.log(msg);
    await info.attach('boot-icon-reduced', { body: msg, contentType: 'text/plain' });
    await page.screenshot({ path: 'exports/icon/boot-reduced.png' });
    await ctx.close();

    expect(a.anim, 'icon still animating under reduced motion').toBe('none');
    expect(Number(a.opacity), 'icon not fully composed under reduced motion').toBe(1);
    if (b.opacity !== 'veil-done') {
      expect(b.opacity, 'icon opacity drifted - a loop is still running').toBe(a.opacity);
    }
  });
});
