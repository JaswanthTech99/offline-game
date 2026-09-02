import { expect, test } from '../fixtures/game';

/**
 * STAGE 1. NOTHING IN THE HUD MAY LEAVE THE VISIBLE BOX, AND NO GLYPH MAY BE CUT.
 *
 * Two independent defects produce the same symptom - a ball count sliced off mid-digit -
 * and fixing either one alone leaves the other shipping. This gate measures both.
 *
 * DEFECT ONE, THE CONTAINER. On a OnePlus 12 the landscape CSS viewport is 851x393.
 *   1. `classifySize` looked at WIDTH only, so a phone in landscape classified as `tablet`
 *      and was handed 40px gutters and an 84px ball numeral.
 *   2. `.sp-clusters` sized its middle row `1fr`, which is `minmax(auto, 1fr)`. The pickup
 *      rail's 117px min-content height therefore acted as a FLOOR on a row with no room,
 *      and the bottom row was pushed past the padding edge.
 *   3. `.sp-overlay { overflow: hidden }` clipped what was pushed out.
 *
 * DEFECT TWO, THE GLYPH. This one reproduces on a 1280x720 desktop, where none of the
 * above applies, and it is why a container-only fix is not enough. `.sp-bc-stack` runs
 * `line-height: .8` because the crop is what makes the numeral read as machined. A line
 * box of 0.8em cannot contain a 800-weight display face whose own ascent-plus-descent is
 * nearer 1.2em, so the digits overflow their own line box by roughly (1.2 - 0.8) / 2 em
 * at the top AND at the bottom. The LAYOUT box can therefore sit comfortably inside the
 * padding while the INK hangs out below it. Every box-based gate passes; the screenshot
 * still shows half a digit.
 *
 * So the assertion here is on the ink box, computed from the font's own metrics rather
 * than from the element's geometry:
 *
 *   baseline  = lineBoxTop + (lineHeight - (fontAscent + fontDescent)) / 2 + fontAscent
 *   inkTop    = baseline - actualBoundingBoxAscent
 *   inkBottom = baseline + actualBoundingBoxDescent
 *
 * `actualBoundingBox*` is the real inked extent of THESE glyphs at THIS size, which is the
 * only number that answers "is a digit being cut". `fontBoundingBox*` is the font's design
 * extent and is what the line box is laid out against; both are needed, and confusing them
 * is how this class of bug survives a gate.
 *
 * The three stacked glow radii are deliberately NOT part of the assertion. The widest
 * reaches 92px by design and is supposed to spill off the edge; a clipped glow is a glow,
 * a clipped glyph is a bug. The hard bevel is a middle case - it is zero-blur and reads as
 * part of the letterform - so it is reported but assessed separately.
 */

/**
 * Gate parameters, not game tunables: this is the shape of the test matrix, the same way
 * hud.gate.spec.ts owns its own seed. Nothing here is read by the running game.
 */
const ASPECTS = [
  { name: '16-9', long: 16, short: 9 },
  { name: '19.5-9', long: 19.5, short: 9 },
  { name: '20-9', long: 20, short: 9 },
  { name: '4-3', long: 4, short: 3 },
  { name: '1-1', long: 1, short: 1 },
] as const;

/** Long edge held constant so every aspect is compared at one scale. */
const LONG_EDGE_PX = 880;

/**
 * The real device box, kept alongside the synthetic matrix because it is the case that
 * actually failed. deviceScaleFactor is fixed per Playwright project and does not need to
 * change: DPR scales device pixels per CSS pixel and every number here is a CSS pixel.
 * 851x393 IS the OnePlus 12's landscape CSS viewport at its native dpr 2.75.
 */
const DEVICE_VIEWPORTS = [
  { name: 'device-oneplus12-landscape', width: 851, height: 393 },
  { name: 'device-oneplus12-portrait', width: 393, height: 851 },
] as const;

/**
 * Headless Chromium resolves every env(safe-area-inset-*) to 0px and always will: there is
 * no notch to report. The device does NOT, and the inset is precisely what turns a small
 * overflow into a slice through the digits rather than through the label underneath them.
 * A gate that only measures the zero-inset case has not measured the device.
 *
 * Overlay declares --sp-safe-* as `var(--safe-b, env(safe-area-inset-bottom, 0px))`, so
 * setting --safe-* on :root is the supported override path rather than a test-only hack.
 * These four numbers are a OnePlus 12 in landscape with gesture navigation: the punch-hole
 * eats the leading edge, the gesture bar eats the bottom.
 */
const SIMULATED_INSETS = { top: 0, right: 0, bottom: 24, left: 48 } as const;

/**
 * Every cluster, the centre overlays, and the ball count BY SELECTOR down to the glyph
 * span. `.sp-bc-face` is listed separately from `.sp-bc` on purpose: the cluster box can
 * sit inside the viewport while the numeral's own line box still hangs out the bottom.
 */
const TRACKED = [
  '.sp-c--tl',
  '.sp-c--tr',
  '.sp-c--rail',
  '.sp-c--bl',
  '.sp-c--br',
  '.sp-danger',
  '.sp-target',
  '.sp-bc',
  '.sp-bc-stack',
  '.sp-bc-face',
  '.sp-bc-foot',
] as const;

/** Text elements whose INK box is measured, not just their layout box. */
const INKED = ['.sp-bc-face'] as const;

/** Sub-pixel layout rounding, and nothing else. */
const EPSILON_PX = 0.5;

interface Box {
  readonly sel: string;
  readonly x: number;
  readonly y: number;
  readonly right: number;
  readonly bottom: number;
}

interface Ink {
  readonly sel: string;
  readonly text: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly layoutTop: number;
  readonly layoutBottom: number;
  readonly fontAscent: number;
  readonly fontDescent: number;
  readonly inkAscent: number;
  readonly inkDescent: number;
  readonly baseline: number;
  readonly inkTop: number;
  readonly inkBottom: number;
  readonly inkLeft: number;
  readonly inkRight: number;
  /** Hard zero-blur bevel reach below the ink, in px. Reported, not asserted. */
  readonly bevelBelow: number;
  readonly transform: string;
}

interface Probe {
  readonly clientHeight: number;
  readonly innerHeight: number;
  readonly visualHeight: number;
  readonly visualWidth: number;
  readonly visualOffsetTop: number;
  readonly dataSize: string;
  readonly safeTop: string;
  readonly safeRight: string;
  readonly safeBottom: string;
  readonly safeLeft: string;
  readonly edge: string;
  readonly padTop: number;
  readonly padRight: number;
  readonly padBottom: number;
  readonly padLeft: number;
  readonly gridScrollHeight: number;
  readonly gridClientHeight: number;
  readonly boxes: readonly Box[];
  readonly inks: readonly Ink[];
}

/** The synthetic matrix, both orientations, plus the two real device boxes. */
function viewportMatrix(): readonly { name: string; width: number; height: number }[] {
  const out: { name: string; width: number; height: number }[] = [];
  for (const aspect of ASPECTS) {
    const shortEdge = Math.round((LONG_EDGE_PX * aspect.short) / aspect.long);
    out.push({ name: `${aspect.name}-landscape`, width: LONG_EDGE_PX, height: shortEdge });
    // A 1:1 viewport is the same box in both orientations; running it twice measures
    // nothing new and doubles the attachments.
    if (aspect.long !== aspect.short) {
      out.push({ name: `${aspect.name}-portrait`, width: shortEdge, height: LONG_EDGE_PX });
    }
  }
  return [...out, ...DEVICE_VIEWPORTS];
}

test.describe('@hud-safe', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
  });

  for (const insets of [null, SIMULATED_INSETS] as const) {
    const suffix = insets === null ? 'no safe-area insets' : 'simulated device insets';
    const tag = insets === null ? '' : '-inset';

    test(`every HUD element and glyph stays inside the visible box - ${suffix}`, async ({
      game,
    }, info) => {
      await game.boot({ seed: 90210 });

      // The springs are integrated on the fixed step and settle to identity at rest, but
      // "at rest" is an assumption and this gate does not get to make assumptions. Pinning
      // the two transform inputs with !important beats NumVar's inline writes (an author
      // !important declaration outranks a normal inline one) so the measured box is the
      // resting layout rather than whatever frame the screenshot happened to catch.
      await game.page.addStyleTag({
        content: '.sp-bc{--bc-scale:1 !important;--bc-kick:0 !important}',
      });

      if (insets !== null) {
        await game.page.addStyleTag({
          content:
            `:root{--safe-t:${String(insets.top)}px;--safe-r:${String(insets.right)}px;` +
            `--safe-b:${String(insets.bottom)}px;--safe-l:${String(insets.left)}px}`,
        });
      }

      const report: string[] = [];
      const failures: string[] = [];

      for (const viewport of viewportMatrix()) {
        await game.page.setViewportSize({ width: viewport.width, height: viewport.height });
        // ResizeObserver reports, Overlay.frame() stamps data-size and --sp-vvh, layout
        // settles. Three frames is plenty; 250ms is not a race, it is slack.
        await game.page.waitForTimeout(250);

        const probe = await game.page.evaluate(
          async ({ selectors, inked }): Promise<Probe> => {
            // measureText only reports the real face once it is loaded; before that it
            // silently measures a fallback and every ink number is wrong by a hair.
            await document.fonts.ready;

            const overlay = document.querySelector<HTMLElement>('.sp-overlay');
            if (overlay === null) throw new Error('no .sp-overlay');
            const style = getComputedStyle(overlay);
            const read = (name: string): string => style.getPropertyValue(name).trim();

            const grid = document.querySelector<HTMLElement>('.sp-clusters');
            const gridStyle = grid === null ? null : getComputedStyle(grid);
            const px = (value: string | undefined): number =>
              value === undefined ? 0 : Number.parseFloat(value) || 0;

            const boxes: Box[] = [];
            for (const sel of selectors) {
              const node = document.querySelector(sel);
              if (node === null) continue;
              const rect = node.getBoundingClientRect();
              const round = (v: number): number => Math.round(v * 10) / 10;
              boxes.push({
                sel,
                x: round(rect.x),
                y: round(rect.y),
                right: round(rect.right),
                bottom: round(rect.bottom),
              });
            }

            const inks: Ink[] = [];
            for (const sel of inked) {
              const node = document.querySelector<HTMLElement>(sel);
              if (node === null) continue;
              const cs = getComputedStyle(node);
              const text = node.textContent ?? '';
              if (text.length === 0) continue;

              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              if (ctx === null) continue;
              // The shorthand must not carry line-height: canvas ignores it and a bad
              // shorthand makes the whole assignment a no-op, silently measuring 10px
              // sans-serif instead of the display face.
              ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
              // Horizontal ink only; vertical extents are unaffected by tracking.
              const tracking = cs.letterSpacing;
              if (tracking !== 'normal') ctx.letterSpacing = tracking;

              const m = ctx.measureText(text);
              const rect = node.getBoundingClientRect();
              const fontAscent = m.fontBoundingBoxAscent;
              const fontDescent = m.fontBoundingBoxDescent;
              // node is display:block holding a single line, so its border box height IS
              // the used line-height and half-leading is symmetric about the content box.
              const halfLeading = (rect.height - (fontAscent + fontDescent)) / 2;
              const baseline = rect.top + halfLeading + fontAscent;

              // Largest zero-blur downward text-shadow offset plus its blur: the machined
              // cut on the underside of the stroke, which reads as part of the letterform.
              let bevelBelow = 0;
              for (const match of cs.textShadow.matchAll(
                /(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?/g,
              )) {
                const dy = Number.parseFloat(match[2] ?? '0');
                const blur = Number.parseFloat(match[3] ?? '0');
                if (blur <= 2) bevelBelow = Math.max(bevelBelow, dy + blur);
              }

              const round = (v: number): number => Math.round(v * 10) / 10;
              inks.push({
                sel,
                text,
                fontSize: round(Number.parseFloat(cs.fontSize)),
                lineHeight: round(rect.height),
                layoutTop: round(rect.top),
                layoutBottom: round(rect.bottom),
                fontAscent: round(fontAscent),
                fontDescent: round(fontDescent),
                inkAscent: round(m.actualBoundingBoxAscent),
                inkDescent: round(m.actualBoundingBoxDescent),
                baseline: round(baseline),
                inkTop: round(baseline - m.actualBoundingBoxAscent),
                inkBottom: round(baseline + m.actualBoundingBoxDescent),
                inkLeft: round(rect.left - m.actualBoundingBoxLeft),
                inkRight: round(rect.left + m.actualBoundingBoxRight),
                bevelBelow: round(bevelBelow),
                transform: getComputedStyle(
                  node.closest('.sp-bc-stack') ?? node,
                ).transform,
              });
            }

            const visual = window.visualViewport;
            return {
              clientHeight: document.documentElement.clientHeight,
              innerHeight: window.innerHeight,
              visualHeight: visual === null ? window.innerHeight : Math.round(visual.height),
              visualWidth: visual === null ? window.innerWidth : Math.round(visual.width),
              visualOffsetTop: visual === null ? 0 : Math.round(visual.offsetTop),
              dataSize: overlay.dataset['size'] ?? '(unset)',
              safeTop: read('--sp-safe-t'),
              safeRight: read('--sp-safe-r'),
              safeBottom: read('--sp-safe-b'),
              safeLeft: read('--sp-safe-l'),
              edge: getComputedStyle(document.documentElement)
                .getPropertyValue('--sp-edge')
                .trim(),
              padTop: px(gridStyle?.paddingTop),
              padRight: px(gridStyle?.paddingRight),
              padBottom: px(gridStyle?.paddingBottom),
              padLeft: px(gridStyle?.paddingLeft),
              gridScrollHeight: grid === null ? 0 : grid.scrollHeight,
              gridClientHeight: grid === null ? 0 : grid.clientHeight,
              boxes,
              inks,
            };
          },
          { selectors: TRACKED, inked: INKED },
        );

        const limitBottom = probe.visualHeight + probe.visualOffsetTop;
        const limitRight = probe.visualWidth;

        report.push(
          `--- ${viewport.name}  ${String(viewport.width)}x${String(viewport.height)} CSS ---`,
          `  documentElement.clientHeight ${String(probe.clientHeight)}`,
          `  window.innerHeight           ${String(probe.innerHeight)}`,
          `  visualViewport               ${String(probe.visualWidth)}x${String(probe.visualHeight)} (offsetTop ${String(probe.visualOffsetTop)})`,
          `  data-size                    ${probe.dataSize}`,
          `  env(safe-area-inset-*)       t=${probe.safeTop} r=${probe.safeRight} b=${probe.safeBottom} l=${probe.safeLeft}`,
          `  --sp-edge                    ${probe.edge === '' ? '(unset)' : probe.edge}`,
          `  .sp-clusters padding         t=${String(probe.padTop)} r=${String(probe.padRight)} b=${String(probe.padBottom)} l=${String(probe.padLeft)}`,
          `  .sp-clusters scroll/client H ${String(probe.gridScrollHeight)} / ${String(probe.gridClientHeight)}`,
        );

        for (const box of probe.boxes) {
          const over: string[] = [];
          if (box.bottom > limitBottom + EPSILON_PX) {
            over.push(`bottom +${(box.bottom - limitBottom).toFixed(1)}`);
          }
          if (box.y < -EPSILON_PX) over.push(`top ${box.y.toFixed(1)}`);
          if (box.right > limitRight + EPSILON_PX) {
            over.push(`right +${(box.right - limitRight).toFixed(1)}`);
          }
          if (box.x < -EPSILON_PX) over.push(`left ${box.x.toFixed(1)}`);
          const verdict = over.length === 0 ? 'ok' : `OUTSIDE ${over.join(', ')}`;
          report.push(
            `   ${box.sel.padEnd(15)} x=${String(box.x).padStart(7)} y=${String(box.y).padStart(7)}` +
              ` right=${String(box.right).padStart(7)} bottom=${String(box.bottom).padStart(7)}  ${verdict}`,
          );
          if (over.length > 0) failures.push(`${viewport.name} ${box.sel}: ${over.join(', ')}`);
        }

        for (const ink of probe.inks) {
          const overflowBelow = ink.inkBottom - ink.layoutBottom;
          const overflowAbove = ink.layoutTop - ink.inkTop;
          report.push(
            `   INK ${ink.sel} "${ink.text}" ${String(ink.fontSize)}px, line box ${String(ink.lineHeight)}px`,
            `       transform            ${ink.transform}`,
            `       font asc/desc        ${String(ink.fontAscent)} / ${String(ink.fontDescent)}  (sum ${(ink.fontAscent + ink.fontDescent).toFixed(1)} vs line box ${String(ink.lineHeight)})`,
            `       ink  asc/desc        ${String(ink.inkAscent)} / ${String(ink.inkDescent)}`,
            `       layout box y         ${String(ink.layoutTop)} .. ${String(ink.layoutBottom)}`,
            `       INK box y            ${String(ink.inkTop)} .. ${String(ink.inkBottom)}   (overflows its own line box by ${overflowAbove.toFixed(1)} above, ${overflowBelow.toFixed(1)} below)`,
            `       hard bevel reaches   ${(ink.inkBottom + ink.bevelBelow).toFixed(1)}  (+${String(ink.bevelBelow)})`,
            `       viewport bottom      ${String(limitBottom)}`,
          );

          const inkOver: string[] = [];
          if (ink.inkBottom > limitBottom + EPSILON_PX) {
            inkOver.push(`ink cut at bottom by ${(ink.inkBottom - limitBottom).toFixed(1)}px`);
          }
          if (ink.inkTop < -EPSILON_PX) {
            inkOver.push(`ink cut at top by ${(-ink.inkTop).toFixed(1)}px`);
          }
          if (ink.inkRight > limitRight + EPSILON_PX) {
            inkOver.push(`ink cut at right by ${(ink.inkRight - limitRight).toFixed(1)}px`);
          }
          if (ink.inkLeft < -EPSILON_PX) {
            inkOver.push(`ink cut at left by ${(-ink.inkLeft).toFixed(1)}px`);
          }
          report.push(
            `       VERDICT              ${inkOver.length === 0 ? 'ok' : `GLYPH CLIPPED - ${inkOver.join(', ')}`}`,
          );
          if (inkOver.length > 0) {
            failures.push(`${viewport.name} ${ink.sel}: ${inkOver.join(', ')}`);
          }
        }
        report.push('');

        await info.attach(`viewport-${viewport.name}${tag}`, {
          body: await game.page.screenshot(),
          contentType: 'image/png',
        });
      }

      const text = report.join('\n');
      console.log(`HUD safe area:\n${text}`);
      await info.attach(`hud-safe${tag}`, { body: text, contentType: 'text/plain' });

      expect(
        failures,
        `HUD elements or glyphs outside the visible box:\n${failures.join('\n')}`,
      ).toEqual([]);
    });
  }
});
