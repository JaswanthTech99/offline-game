import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/game';

/**
 * STAGE 4c. AUDIT OF THE DOM `.fx` STACK.
 *
 * The `.fx` stack is half the shipped image, and it is the half no scene measurement can
 * see: a gate that screenshots the canvas element measures a frame the player never looks
 * at. Everything here screenshots the PAGE, so the composited result is what is graded.
 *
 * Three claims are under test.
 *
 * 1. THE ORDERING LAW. Every layer that can only ADD light must paint below the vignette,
 *    and the vignette must be the last layer that can subtract it. The stack shipped with
 *    a screen-blended aberration painting ABOVE the vignette, which re-lifted exactly the
 *    corners the vignette was authored to reach zero at, and a `.fx::after` pseudo-element
 *    was bolted on top to crush the result back down. `paintsAbove` below is derived from
 *    computed z-index and tree order, not asserted from the markup, so the law is checked
 *    against what the browser will actually paint.
 *
 * 2. THE BLACK POINT SURVIVES COMPOSITING. edge / corner / dark-share are measured on the
 *    composited page with the HUD hidden -- the HUD is real shipped pixels but it is a
 *    readout, not the image, and it sits precisely in the band this gate measures.
 *
 * 3. THE STACK IS RESOLVED, NOT RESAMPLED. Every project renders the same device-pixel
 *    count, so a 1x capture and a 4x capture are directly comparable. A layer rasterised
 *    at CSS resolution and upscaled shows up two ways: its gradient profile drifts from
 *    the 1x profile, and its texture quantises into DPR-sized constant blocks. Both are
 *    measured rather than argued.
 */

/* ------------------------------------------------------------------ measurement law */

/** Outermost fraction of the SHORTER side that counts as the frame edge. */
const EDGE_BAND = 0.06;
/** Side of each corner probe, as a fraction of the frame. */
const CORNER_BOX = 0.08;
/** Luminance at or below which a pixel counts as genuinely black. */
const DARK_CEIL = 0.02;

/**
 * The shipped budget this pass may not regress. The two ceilings are the authored budget;
 * the dark-share floor is the measured pre-fix baseline of this exact scene and metric
 * (57.4% of the 6% edge band at or below 2% luminance), pinned here so the gate fails if a
 * later change gives any of it back. `bandSweep` in the report prints the same statistic
 * over seven band widths, because "over 80% under 2%" is only a number once the population
 * it is taken over is written down, and this file writes it down.
 */
const MAX_EDGE_PCT = 6;
const MAX_CORNER_PCT = 6;
const MIN_EDGE_DARK_PCT = 57;

interface Metrics {
  /** Mean luminance of the outer EDGE_BAND ring, in percent. */
  edgePct: number;
  /** Mean luminance of the four CORNER_BOX probes, in percent. */
  cornerPct: number;
  /** Share of edge-band pixels at or below DARK_CEIL, in percent. */
  edgeDarkPct: number;
  /** Share of ALL pixels at or below DARK_CEIL, in percent. Reported so the number can be
   *  reconciled with whichever population an earlier pass meant by ">80% under 2%". */
  frameDarkPct: number;
  /** Whole-frame median luminance, in percent. HISTOGRAM_LAW wants <= 22. */
  medianPct: number;
  width: number;
  height: number;
}

function luma(d: Buffer, i: number): number {
  return (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255;
}

function measure(png: PNG): Metrics {
  const { width: W, height: H, data } = png;
  const band = Math.max(1, Math.round(EDGE_BAND * Math.min(W, H)));
  const cw = Math.max(1, Math.round(CORNER_BOX * W));
  const ch = Math.max(1, Math.round(CORNER_BOX * H));

  let edgeSum = 0;
  let edgeN = 0;
  let edgeDark = 0;
  let frameDark = 0;
  const all = new Float64Array(W * H);

  for (let y = 0; y < H; y++) {
    const onEdge = y < band || y >= H - band;
    for (let x = 0; x < W; x++) {
      const L = luma(data, (y * W + x) * 4);
      all[y * W + x] = L;
      if (L <= DARK_CEIL) frameDark++;
      if (onEdge || x < band || x >= W - band) {
        edgeSum += L;
        edgeN++;
        if (L <= DARK_CEIL) edgeDark++;
      }
    }
  }

  let cornerSum = 0;
  let cornerN = 0;
  for (const [ox, oy] of [
    [0, 0],
    [W - cw, 0],
    [0, H - ch],
    [W - cw, H - ch],
  ] as const) {
    for (let y = oy; y < oy + ch; y++) {
      for (let x = ox; x < ox + cw; x++) {
        cornerSum += all[y * W + x]!;
        cornerN++;
      }
    }
  }

  const sorted = Float64Array.from(all).sort();
  return {
    edgePct: (edgeSum / edgeN) * 100,
    cornerPct: (cornerSum / cornerN) * 100,
    edgeDarkPct: (edgeDark / edgeN) * 100,
    frameDarkPct: (frameDark / (W * H)) * 100,
    medianPct: sorted[Math.floor(sorted.length / 2)]! * 100,
    width: W,
    height: H,
  };
}

const SWEEP_BANDS = [0.01, 0.02, 0.03, 0.04, 0.06, 0.08, 0.12] as const;

/** Mean luminance and dark share over the outer `frac` ring, for each of several rings. */
function bandSweep(png: PNG): string {
  const { width: W, height: H, data } = png;
  const out = ['  band    mean luma   share <= 2%'];
  for (const frac of SWEEP_BANDS) {
    const b = Math.max(1, Math.round(frac * Math.min(W, H)));
    let sum = 0;
    let n = 0;
    let dark = 0;
    for (let y = 0; y < H; y++) {
      const edgeRow = y < b || y >= H - b;
      for (let x = 0; x < W; x++) {
        if (!edgeRow && x >= b && x < W - b) continue;
        const L = luma(data, (y * W + x) * 4);
        sum += L;
        n++;
        if (L <= DARK_CEIL) dark++;
      }
    }
    out.push(
      `  ${(frac * 100).toFixed(0).padStart(3)}%  ${((sum / n) * 100).toFixed(2).padStart(9)}%  ` +
        `${((dark / n) * 100).toFixed(1).padStart(11)}%`,
    );
  }
  return out.join('\n');
}

function row(label: string, m: Metrics): string {
  return (
    `  ${label.padEnd(30)} edge ${m.edgePct.toFixed(2).padStart(6)}%` +
    `  corner ${m.cornerPct.toFixed(2).padStart(6)}%` +
    `  edge<=2% ${m.edgeDarkPct.toFixed(1).padStart(5)}%` +
    `  frame<=2% ${m.frameDarkPct.toFixed(1).padStart(5)}%` +
    `  median ${m.medianPct.toFixed(2).padStart(6)}%`
  );
}

/* ------------------------------------------------------------------- page utilities */

const OVERRIDE_ID = 'sp-fx-audit';

/** One style element, rewritten in place. addStyleTag would accumulate sheets and make
 *  the Nth capture depend on the order of the N-1 before it. */
async function override(page: Page, css: string): Promise<void> {
  await page.evaluate(
    ([id, text]) => {
      const doc = document;
      let el = doc.getElementById(id) as HTMLStyleElement | null;
      if (el === null) {
        el = doc.createElement('style');
        el.id = id;
        doc.head.append(el);
      }
      el.textContent = text;
    },
    [OVERRIDE_ID, css] as const,
  );
  await page.waitForTimeout(90);
}

async function capture(page: Page): Promise<PNG> {
  return PNG.sync.read(await page.screenshot({ scale: 'device' }));
}

/* ------------------------------------------------------------------ layer inventory */

interface LayerInfo {
  selector: string;
  domOrder: number;
  zIndex: string;
  paintIndex: number;
  opacity: string;
  mixBlendMode: string;
  /** The blend the compositor applies to the group this box lands in. A pseudo-element
   *  reports `normal` for itself while being composited inside a blended parent, so this
   *  is the field the ordering law has to be judged on. */
  groupBlend: string;
  isPseudo: boolean;
  /** Computed background-image, truncated -- enough to see gradient vs raster. */
  background: string;
  backgroundSize: string;
  transform: string;
  filter: string;
  display: string;
  paintsAbove: string[];
}

/** Reads the stack the way the compositor will: z-index first, tree order to break ties. */
function readStack(): LayerInfo[] {
  const host = document.querySelector('.fx');
  if (host === null) return [];

  type Probe = { el: Element; pseudo: string | null; selector: string; domOrder: number };
  const probes: Probe[] = [];
  let n = 0;
  for (const el of host.children) {
    const base = `.${[...el.classList].join('.')}`;
    probes.push({ el, pseudo: null, selector: base, domOrder: n++ });
    for (const p of ['::before', '::after'] as const) {
      if (getComputedStyle(el, p).content !== 'none') {
        probes.push({ el, pseudo: p, selector: `${base}${p}`, domOrder: n++ });
      }
    }
  }
  if (getComputedStyle(host, '::after').content !== 'none') {
    probes.push({ el: host, pseudo: '::after', selector: '.fx::after', domOrder: n++ });
  }

  const rows = probes.map((p) => {
    const cs = getComputedStyle(p.el, p.pseudo);
    // A pseudo-element paints inside its originating element's box, so it inherits that
    // element's place in the stack; only its own tree position separates siblings.
    const owner = p.pseudo === null ? cs : getComputedStyle(p.el);
    const z = owner.zIndex === 'auto' ? 0 : Number.parseInt(owner.zIndex, 10);
    return {
      selector: p.selector,
      domOrder: p.domOrder,
      zIndex: owner.zIndex,
      zNum: Number.isNaN(z) ? 0 : z,
      paintIndex: 0,
      opacity: cs.opacity,
      mixBlendMode: cs.mixBlendMode,
      groupBlend: cs.mixBlendMode === 'normal' ? owner.mixBlendMode : cs.mixBlendMode,
      isPseudo: p.pseudo !== null,
      background: cs.backgroundImage.replace(/\s+/g, ' ').slice(0, 240),
      backgroundSize: cs.backgroundSize,
      transform: cs.transform,
      filter: cs.filter,
      display: cs.display,
      paintsAbove: [] as string[],
    };
  });

  rows.sort((a, b) => (a.zNum === b.zNum ? a.domOrder - b.domOrder : a.zNum - b.zNum));
  rows.forEach((r, i) => {
    r.paintIndex = i;
    r.paintsAbove = rows.slice(0, i).map((q) => q.selector);
  });
  // zNum is a sort key, not part of the report.
  return rows.map((r) => {
    const copy: Record<string, unknown> = { ...r };
    delete copy['zNum'];
    return copy as unknown as (typeof rows)[number];
  });
}

/* ------------------------------------------------------------------------- the gates */

const DESKTOP = 'DESKTOP_HIGH';
const meta = (info: { project: { metadata: unknown } }): { tier?: string; scale?: number } =>
  info.project.metadata as { tier?: string; scale?: number };

test.describe('@fx', () => {
  test('layer inventory and the ordering law', async ({ game }, info) => {
    test.skip(meta(info).tier !== DESKTOP || meta(info).scale !== 1, 'DESKTOP_HIGH@1x only');
    await game.boot();

    const layers = await game.page.evaluate(readStack);

    const table = [
      '  paint  dom  selector                        z-index  opacity  blend      bg-size  transform',
      ...layers.map(
        (l) =>
          `  ${String(l.paintIndex).padStart(5)}  ${String(l.domOrder).padStart(3)}  ` +
          `${l.selector.padEnd(30)} ${l.zIndex.padEnd(8)} ${l.opacity.padEnd(8)} ` +
          `${l.mixBlendMode.padEnd(10)} ${l.backgroundSize.padEnd(8)} ${l.transform}`,
      ),
      '',
      'paints above:',
      ...layers.map(
        (l) => `  ${l.selector.padEnd(30)} ${l.paintsAbove.join(', ') || '(the canvas only)'}`,
      ),
      '',
      'background source:',
      ...layers.map((l) => `  ${l.selector.padEnd(30)} ${l.background.slice(0, 64)}`),
    ].join('\n');
    console.log(`\nfx layer inventory:\n${table}\n`);
    await info.attach('fx-layer-inventory', { body: table, contentType: 'text/plain' });

    expect(layers.length, 'the .fx stack is empty').toBeGreaterThan(0);

    const vignette = layers.find((l) => l.selector.includes('fx__vignette'));
    expect(vignette, '.fx__vignette is not in the stack').toBeDefined();

    // THE ORDERING LAW. `screen`, `lighten`, `color-dodge` and `plus-lighter` can only ever
    // raise a pixel; a layer using one of them above the vignette makes the black point
    // unreachable at any vignette strength. `overlay` and `multiply` map 0 to 0 whatever
    // the source is, and a black-only gradient at normal blend can only subtract, so those
    // are the two kinds of layer allowed to paint after the frame has been crushed.
    const ADDITIVE = new Set(['screen', 'lighten', 'color-dodge', 'plus-lighter', 'hard-light']);
    for (const l of layers) {
      if (l.display === 'none' || !ADDITIVE.has(l.groupBlend)) continue;
      expect(
        l.paintIndex,
        `${l.selector} blends '${l.groupBlend}' and paints ABOVE .fx__vignette; ` +
          'it re-lifts every pixel the vignette darkened and no vignette strength can beat it',
      ).toBeLessThan(vignette!.paintIndex);
    }

    // One authored vignette, not two. A second edge darkening that the preset knob does not
    // scale is a second, untierable black point -- exactly what ARCHITECTURE section 6 site 3
    // forbids ("ONE authored vignette strength from Quality.ts"). Pseudo-elements of a
    // blended layer are excluded: they are the aberration's two rings, and they reach the
    // frame through their parent's `screen`, not as darkenings of their own.
    const crushes = layers.filter(
      (l) =>
        l.display !== 'none' &&
        l.groupBlend === 'normal' &&
        /radial-gradient/.test(l.background),
    );
    expect(
      crushes.map((c) => c.selector),
      'more than one normal-blend radial darkening: the edge black point is authored twice',
    ).toEqual([vignette!.selector]);

    // The vignette must be the LAST thing that can move a pixel towards black. Everything
    // above it is allowed only because it cannot lift one: a normal-blend layer whose only
    // colour is black can subtract and nothing else, and `overlay`/`multiply` both evaluate
    // to 0 against a backdrop of 0 whatever the source is.
    const CANNOT_LIFT_BLACK = new Set(['overlay', 'multiply', 'darken', 'color-burn']);
    for (const l of layers) {
      if (l.display === 'none' || l.paintIndex <= vignette!.paintIndex) continue;
      const blackOnly = l.groupBlend === 'normal' && !/rgba?\((?!0, 0, 0)/.test(l.background);
      expect(
        CANNOT_LIFT_BLACK.has(l.groupBlend) || blackOnly,
        `${l.selector} paints above the vignette blending '${l.groupBlend}' with a source ` +
          'that is not black-only; it can raise the black point the vignette just set',
      ).toBe(true);
    }

    // Nothing above the vignette may be promoted out of the stack by a filter, which would
    // rasterise into its own surface and re-blend against a backdrop that no longer has the
    // vignette in it.
    for (const l of layers) {
      expect(l.filter, `${l.selector} runs a filter inside the fx stack`).toBe('none');
    }
  });

  test('the composited frame holds its black point', async ({ game }, info) => {
    test.skip(meta(info).tier !== DESKTOP || meta(info).scale !== 1, 'DESKTOP_HIGH@1x only');
    await game.boot({ seed: 20260902, universe: 'void-cathedral' });
    await game.hideHud();
    await game.freeze();

    const shipped = await capture(game.page);
    const full = measure(shipped);

    // Per-layer contribution: hide one layer, remeasure, and the delta IS that layer's
    // effect on the black point. This is the audit the ordering claim rests on -- the
    // original diagnosis blamed grain and scanlines, and a delta is the only way to know.
    const probes: ReadonlyArray<readonly [string, string]> = [
      ['no .fx at all', '.fx{display:none!important}'],
      ['no .fx__vignette', '.fx__vignette{display:none!important}'],
      ['no .fx__aberration', '.fx__aberration{display:none!important}'],
      ['no .fx__scanlines', '.fx__scanlines{display:none!important}'],
      ['no .fx__grain', '.fx__grain{display:none!important}'],
      ['no .fx::after crush', '.fx::after{display:none!important}'],
    ];

    const lines = [`frame ${full.width}x${full.height} (device px), HUD hidden, frozen`, row('composited (shipped)', full)];
    for (const [label, css] of probes) {
      await override(game.page, css);
      const m = measure(await capture(game.page));
      lines.push(
        `${row(label, m)}   d-edge ${(m.edgePct - full.edgePct >= 0 ? '+' : '')}` +
          `${(m.edgePct - full.edgePct).toFixed(2)}  d-corner ` +
          `${(m.cornerPct - full.cornerPct >= 0 ? '+' : '')}${(m.cornerPct - full.cornerPct).toFixed(2)}`,
      );
    }
    await override(game.page, '');

    lines.push('', 'the same statistic over seven edge bands, composited:', bandSweep(shipped));

    const report = lines.join('\n');
    console.log(`\nfx black-point audit:\n${report}\n`);
    await info.attach('fx-black-point', { body: report, contentType: 'text/plain' });

    await mkdir('exports', { recursive: true });
    await writeFile(join('exports', 'fx-black-point.json'), JSON.stringify(full, null, 2));

    expect(full.edgePct, 'edge band luminance').toBeLessThan(MAX_EDGE_PCT);
    expect(full.cornerPct, 'corner luminance').toBeLessThan(MAX_CORNER_PCT);
    expect(full.edgeDarkPct, 'share of edge-band pixels at or below 2%').toBeGreaterThan(
      MIN_EDGE_DARK_PCT,
    );
    // HISTOGRAM_LAW, cross-checked on the composited image rather than on the render target.
    expect(full.medianPct, 'whole-frame median luminance').toBeLessThan(22);
  });

  /*
   * RESAMPLING. Isolated on a flat mid grey so the measurement is of the LAYER, not of the
   * corridor behind it. `overlay` against exactly 50% grey returns the source unchanged,
   * which is what makes the grain field directly readable here.
   */
  const ISOLATE =
    '#stage,#overlay,#boot{display:none!important}' +
    '#app{background:rgb(128 128 128)!important}';

  test('the fx stack is resolved at device scale, not resampled', async ({ game }, info) => {
    test.skip(meta(info).tier !== DESKTOP, 'DESKTOP_HIGH only');
    const scale = meta(info).scale ?? 1;
    await game.boot();
    await game.freeze();

    // Static audit first: the three things that force a resample are a background-size in
    // fixed pixels, a raster background, and a filter. A vector data: URI is not a raster --
    // Chromium rasterises an SVG background at the composited device scale.
    const statics = await game.page.evaluate(readStack);
    for (const l of statics) {
      expect(l.backgroundSize, `${l.selector} pins background-size`).toBe('auto');
      expect(
        /url\(["']?data:image\/(png|jpeg|webp|gif)|\.(png|jpe?g|webp|gif)/i.test(l.background),
        `${l.selector} paints a raster image and will resample at DPR > 1`,
      ).toBe(false);
    }

    // 1. The vignette gradient. Authored in percentages, so its profile along the centre
    //    row must be identical at every DPR. A layer rasterised at CSS resolution and
    //    upscaled loses the fine part of the falloff and the profiles diverge.
    await override(
      game.page,
      `${ISOLATE}.fx__aberration,.fx__scanlines,.fx__grain{display:none!important}` +
        '.fx__vignette{opacity:1!important}.fx::after{display:none!important}',
    );
    const vig = await capture(game.page);
    const SAMPLES = 96;
    const midY = Math.floor(vig.height / 2);
    const profile: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const x = Math.min(vig.width - 1, Math.round((i / (SAMPLES - 1)) * (vig.width - 1)));
      profile.push(luma(vig.data, (midY * vig.width + x) * 4));
    }

    // 2. The scanline layer. One CSS pixel on, two off. Crisp means every device row lands
    //    on one of two levels; a bilinear upscale from 1x turns the step into a ramp.
    await override(
      game.page,
      `${ISOLATE}.fx__vignette,.fx__aberration,.fx__grain{display:none!important}` +
        '.fx__scanlines{opacity:1!important}.fx::after{display:none!important}',
    );
    const scan = await capture(game.page);
    const colX = Math.floor(scan.width / 2);
    const rows: number[] = [];
    for (let y = 0; y < scan.height; y++) rows.push(luma(scan.data, (y * scan.width + colX) * 4));
    const lo = Math.min(...rows);
    const hi = Math.max(...rows);
    const tol = 3 / 255;
    const onStep = rows.filter((v) => v - lo <= tol || hi - v <= tol).length / rows.length;

    // 3. The grain tile. An SVG rasterised at CSS resolution and upscaled quantises into
    //    DPR x DPR constant blocks; one rasterised at device scale does not.
    await override(
      game.page,
      `${ISOLATE}.fx__vignette,.fx__aberration,.fx__scanlines{display:none!important}` +
        '.fx__grain{opacity:1!important}.fx::after{display:none!important}',
    );
    const grain = await capture(game.page);
    const s = Math.max(1, Math.round(scale));
    let blocks = 0;
    let flat = 0;
    for (let by = 0; by + s <= grain.height; by += s) {
      for (let bx = 0; bx + s <= grain.width; bx += s) {
        const first = luma(grain.data, (by * grain.width + bx) * 4);
        let same = true;
        for (let y = by; y < by + s && same; y++) {
          for (let x = bx; x < bx + s; x++) {
            if (luma(grain.data, (y * grain.width + x) * 4) !== first) {
              same = false;
              break;
            }
          }
        }
        blocks++;
        if (same) flat++;
      }
    }
    const flatShare = flat / blocks;
    await override(game.page, '');

    await mkdir('exports', { recursive: true });
    const artefact = { scale, profile, onStep, flatShare, width: vig.width, height: vig.height };
    await writeFile(
      join('exports', `fx-resample-${scale}x.json`),
      JSON.stringify(artefact, null, 2),
    );

    const summary = [
      `scale ${scale}x, capture ${vig.width}x${vig.height} device px`,
      `  scanline rows on one of two levels : ${(onStep * 100).toFixed(1)}%`,
      `  grain ${s}x${s} blocks that are flat : ${(flatShare * 100).toFixed(1)}%`,
      `  vignette profile min/max            : ${Math.min(...profile).toFixed(4)} / ${Math.max(...profile).toFixed(4)}`,
    ];

    // Cross-scale: the 1x run writes its profile, the 4x run grades itself against it.
    let cross = '  (no 1x profile on disk to compare against)';
    if (scale !== 1) {
      const raw = await readFile(join('exports', 'fx-resample-1x.json'), 'utf8').catch(() => null);
      if (raw !== null) {
        const base = JSON.parse(raw) as { profile: number[] };
        let maxD = 0;
        for (const [i, v] of profile.entries()) maxD = Math.max(maxD, Math.abs(v - (base.profile[i] ?? v)));
        cross = `  max |profile(${scale}x) - profile(1x)|      : ${maxD.toFixed(4)}`;
        summary.push(cross);
        expect(maxD, 'the vignette profile moved between 1x and 4x: it is being resampled').toBeLessThan(0.02);
      } else {
        summary.push(cross);
      }
    }
    const report = summary.join('\n');
    console.log(`\nfx resampling audit:\n${report}\n`);
    await info.attach(`fx-resample-${scale}x`, { body: report, contentType: 'text/plain' });

    expect(onStep, 'scanline rows are a ramp, not a step: the layer is being resampled').toBeGreaterThan(0.9);
    if (s > 1) {
      expect(
        flatShare,
        `grain quantised into ${s}x${s} constant blocks: the SVG tile is rasterised at CSS resolution and upscaled`,
      ).toBeLessThan(0.5);
    }
  });
});
