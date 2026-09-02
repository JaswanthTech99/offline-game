/**
 * STAGE 2 gate. Reads the manifest the production build actually emitted, confirms every
 * icon it declares exists on disk AT the size it claims, and reports installability.
 *
 * Declaring a size the file does not have is the classic PWA failure: the manifest
 * validates, the install prompt never appears, and nothing tells you why.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const name = readdirSync(DIST).find((f) => f === 'manifest.webmanifest' || f === 'manifest.json');
if (name === undefined) {
  console.error('  no manifest emitted into dist/');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(DIST, name), 'utf8'));
console.log(`  ${name}:`);
console.log(JSON.stringify(manifest, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));

let ok = true;
console.log('\n  declared icons:');
for (const icon of manifest.icons ?? []) {
  const file = join(DIST, icon.src);
  if (!existsSync(file)) {
    console.log(`    MISSING  ${icon.src}`);
    ok = false;
    continue;
  }
  const png = PNG.sync.read(readFileSync(file));
  const [w, h] = icon.sizes.split('x').map(Number);
  const match = png.width === w && png.height === h;
  if (!match) ok = false;
  console.log(
    `    ${match ? 'ok     ' : 'WRONG  '} ${icon.src.padEnd(34)} declared ${icon.sizes.padEnd(9)} actual ${png.width}x${png.height}  purpose=${icon.purpose}`,
  );
}

// Chrome's installability floor: name, start_url, display, and both a 192 and a 512.
const sizes = new Set((manifest.icons ?? []).map((i) => i.sizes));
const checks = [
  ['name or short_name', Boolean(manifest.name || manifest.short_name)],
  ['start_url', Boolean(manifest.start_url)],
  ['display is standalone-like', ['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)],
  ['has 192x192', sizes.has('192x192')],
  ['has 512x512', sizes.has('512x512')],
  ['has a maskable icon', (manifest.icons ?? []).some((i) => String(i.purpose).includes('maskable'))],
  ['theme_color', Boolean(manifest.theme_color)],
  ['background_color', Boolean(manifest.background_color)],
];
console.log('\n  installability:');
for (const [label, pass] of checks) {
  if (!pass) ok = false;
  console.log(`    ${pass ? 'PASS' : 'FAIL'}  ${label}`);
}
console.log(`\n  GATE ${ok ? 'PASS' : 'FAIL'}`);
process.exitCode = ok ? 0 : 1;
