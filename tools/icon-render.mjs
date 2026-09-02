/**
 * Rasterises the icon SVGs at every size the app ships.
 *
 * Uses the Playwright Chromium already installed for the e2e gates rather than adding an
 * image library: the browser is the renderer these SVGs are authored against, so its output
 * is what a user will actually see - a second rasteriser would be a second opinion on
 * filters, blend modes and gradients, and the two would disagree.
 *
 *   node tools/icon-render.mjs
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src/assets/icon');
const OUT_PUBLIC = join(ROOT, 'public/icons');
const OUT_EXPORT = join(ROOT, 'exports/icon-masters');

/** What each target actually needs. */
/**
 * Only what something actually references goes into public/. The 1024s are masters for
 * Tauri and store listings, not runtime assets, and shipping them cost 1.8 MB inside the
 * APK for files nothing loads.
 */
const JOBS = [
  { svg: 'icon.svg', name: 'icon', sizes: [512, 256, 192, 180, 128, 96, 64, 48, 32, 16], out: 'public' },
  { svg: 'icon-maskable.svg', name: 'icon-maskable', sizes: [512, 192], out: 'public' },
  { svg: 'icon-square.svg', name: 'icon-square', sizes: [512, 256, 128], out: 'public' },
  // Distribution masters. Not served, not bundled.
  { svg: 'icon.svg', name: 'icon', sizes: [1024], out: 'exports' },
  { svg: 'icon-square.svg', name: 'icon-square', sizes: [1024], out: 'exports' },
];

mkdirSync(OUT_PUBLIC, { recursive: true });
mkdirSync(OUT_EXPORT, { recursive: true });
const browser = await chromium.launch();
const written = [];

for (const job of JOBS) {
  const svg = readFileSync(join(SRC, job.svg), 'utf8');
  for (const size of job.sizes) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    // Transparent background so icon-square keeps its alpha; the plated variants paint
    // their own opaque ground anyway.
    await page.setContent(
      `<!doctype html><meta charset="utf-8">
       <style>html,body{margin:0;padding:0;background:transparent}
              svg{display:block;width:${size}px;height:${size}px}</style>
       ${svg}`,
      { waitUntil: 'load' },
    );
    const buf = await page.screenshot({ omitBackground: true });
    const dir = job.out === 'public' ? OUT_PUBLIC : OUT_EXPORT;
    const file = join(dir, `${job.name}-${size}.png`);
    writeFileSync(file, buf);
    written.push({ file: `${job.out === 'public' ? 'public/icons' : 'exports/icon-masters'}/${job.name}-${size}.png`, size });
    await page.close();
  }
}
await browser.close();
console.log(`  rendered ${written.length} PNGs`);
for (const w of written) console.log(`    ${w.file}`);
