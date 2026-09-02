/**
 * STAGE 1 gate. Renders all three variants at 512 and tests the maskable one against the
 * circular crop Android will apply.
 *
 * The failure this catches is specific: a maskable icon whose art crosses the central 80%
 * circle gets its corners eaten by the platform mask, and you do not find out until it is
 * on a phone.
 *
 *   node tools/icon-gate.mjs
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/assets/icon');
const OUT = join(ROOT, 'exports/icon');
const SIZE = 512;
/** Android guarantees only the central 80%. Anything outside it may be masked away. */
const SAFE_FRACTION = 0.8;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

async function render(file, transparent) {
  const svg = readFileSync(join(SRC, file), 'utf8');
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;background:transparent}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>
     ${svg}`,
    { waitUntil: 'load' },
  );
  const buf = await page.screenshot({ omitBackground: transparent });
  await page.close();
  writeFileSync(join(OUT, file.replace('.svg', `-${SIZE}.png`)), buf);
  return PNG.sync.read(buf);
}

const plated = await render('icon.svg', false);
const maskable = await render('icon-maskable.svg', false);
const square = await render('icon-square.svg', true);
await browser.close();

/**
 * "Art" is measured by DIFFERENCE against a background-only render of the same variant.
 *
 * The first version of this test compared each pixel to the mean luminance at its own
 * radius, which failed: the plate's gradients are deliberately OFF-CENTRE - a cool key pool
 * at 46%/30% and a violet fill at 78%/86% - so the bright side of a perfectly empty
 * background reads as brighter than the ring average and was reported as art. Diffing
 * against the real background removes all of that by construction.
 */
async function renderBackgroundOnly() {
  const svg = readFileSync(join(SRC, 'icon-maskable.svg'), 'utf8');
  // Keep the defs and the three plate rects; drop the transformed art group entirely.
  const artStart = svg.indexOf('<g transform="translate(');
  const stripped = `${svg.slice(0, artStart)}</svg>`;
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;background:transparent}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>
     ${stripped}`,
    { waitUntil: 'load' },
  );
  const buf = await page.screenshot({ omitBackground: false });
  await b.close();
  writeFileSync(join(OUT, 'icon-maskable-background.png'), buf);
  return PNG.sync.read(buf);
}

const background = await renderBackgroundOnly();

function crossings(png, bg) {
  const { width: W, height: H, data } = png;
  const cx = W / 2;
  const cy = H / 2;
  const rSafe = (W * SAFE_FRACTION) / 2;
  let outside = 0;
  let worst = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = Math.hypot(x - cx, y - cy);
      if (r <= rSafe) continue;
      const i = (y * W + x) * 4;
      // Perceptual-ish channel delta. 10/255 on any channel is visible; below that is
      // rasteriser noise between two renders of the same gradient.
      const d = Math.max(
        Math.abs(data[i] - bg.data[i]),
        Math.abs(data[i + 1] - bg.data[i + 1]),
        Math.abs(data[i + 2] - bg.data[i + 2]),
      );
      if (d > 10) {
        outside += 1;
        worst = Math.max(worst, d / 255);
      }
    }
  }
  return { outside, worst };
}

const m = crossings(maskable, background);
const pxTotal = SIZE * SIZE;
console.log(`  rendered 3 variants at ${SIZE}px into exports/icon/`);
console.log(`    icon.svg           ${plated.width}x${plated.height}  plated, opaque`);
console.log(`    icon-maskable.svg  ${maskable.width}x${maskable.height}  full bleed, square corners`);
console.log(`    icon-square.svg    ${square.width}x${square.height}  transparent`);
console.log('');
console.log(`  maskable safe-zone test, circle at ${SAFE_FRACTION * 100}% diameter:`);
console.log(`    art pixels outside the circle : ${m.outside}  (${((m.outside / pxTotal) * 100).toFixed(4)}% of canvas)`);
console.log(`    worst delta vs background     : ${(m.worst * 255).toFixed(0)} / 255`);
const pass = m.outside === 0;
console.log(`    GATE ${pass ? 'PASS' : 'FAIL'}  - no non-background art may cross the circle`);
process.exitCode = pass ? 0 : 1;
