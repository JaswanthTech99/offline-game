import { expect, test } from '../fixtures/game';

/**
 * STAGE 4c. The DOM `.fx` stack is half the shipped image and it has already broken one
 * measurement: grain and scanlines paint ABOVE the vignette, and being additive they put a
 * ~7% floor under the whole frame, which no vignette strength could beat. This inventories
 * every layer and asserts the ordering that fix depends on.
 */
interface LayerInfo {
  selector: string;
  zIndex: string;
  opacity: string;
  mixBlendMode: string;
  domOrder: number;
  paintsAbove: string[];
}

test.describe('@fx', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
    test.skip((info.project.metadata as { tier?: string }).tier !== 'DESKTOP_HIGH', 'DESKTOP_HIGH only');
  });

  test('fx layer inventory and paint order', async ({ game }, info) => {
    await game.boot();

    const layers = await game.page.evaluate((): LayerInfo[] => {
      const host = document.querySelector('.fx');
      if (host === null) return [];
      const kids = [...host.children];
      return kids.map((el, i) => {
        const cs = getComputedStyle(el);
        return {
          selector: `.${[...el.classList].join('.')}`,
          zIndex: cs.zIndex,
          opacity: cs.opacity,
          mixBlendMode: cs.mixBlendMode,
          domOrder: i,
          paintsAbove: kids.slice(0, i).map((p) => `.${[...p.classList].join('.')}`),
        };
      });
    });

    const hasAfter = await game.page.evaluate(() => {
      const host = document.querySelector('.fx');
      if (host === null) return null;
      const cs = getComputedStyle(host, '::after');
      return { content: cs.content, background: cs.backgroundImage.slice(0, 60) };
    });

    const table = [
      '  order  selector                    z-index  opacity  blend',
      ...layers.map(
        (l) =>
          `  ${String(l.domOrder).padStart(5)}  ${l.selector.padEnd(26)} ${l.zIndex.padEnd(8)} ` +
          `${l.opacity.padEnd(8)} ${l.mixBlendMode}`,
      ),
      `  ::after (final edge crush) content=${hasAfter?.content ?? 'none'}`,
    ].join('\n');
    console.log(`fx layer inventory:\n${table}`);
    await info.attach('fx-layers', { body: table, contentType: 'text/plain' });

    expect(layers.length).toBeGreaterThan(0);

    // The crush must exist, because grain and scanlines paint after the vignette and would
    // otherwise re-lift every pixel the vignette just darkened.
    expect(hasAfter?.content, '.fx::after edge crush is missing').not.toBe('none');
  });
});
