/**
 * Builds the static download page that sits next to the APK.
 *
 * Generated rather than hand-written for the same reason as the icon variants: it stamps
 * the real byte size, the real SHA-256 and the real build date, and a hand-maintained page
 * says whatever it said the last time someone remembered to edit it.
 *
 *   node tools/apk-page.mjs
 */
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'exports/apk');
const APK = join(DIR, 'shatterpoint-debug.apk');

if (!existsSync(APK)) {
  console.error('  no APK at exports/apk/ - run `npm run mobile:apk` first');
  process.exit(1);
}

const bytes = statSync(APK).size;
const mb = (bytes / 1048576).toFixed(1);
const sha = createHash('sha256').update(readFileSync(APK)).digest('hex');
const built = statSync(APK).mtime.toISOString().slice(0, 16).replace('T', ' ');

// The boot variant: grain and bloom already stripped, ids already namespaced.
const icon = readFileSync(join(ROOT, 'src/assets/icon/icon-boot.svg'), 'utf8')
  .replace('class="boot__icon"', 'class="dl__icon"')
  .replace('width="96" height="96"', 'width="128" height="128"');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#04040c" />
<title>SHATTERPOINT &mdash; Android test build</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg" />
<style>
  /* Same four accents and the same dark-based glass as the game, so the download page and
     the thing it hands you look like one product. */
  :root {
    --ground: #04040c;
    --ink: #e8f4fb;
    --ink-faint: #7f95a5;
    --ice: #6ee7ff;
    --glass: rgb(12 18 28 / 0.62);
    --hair: rgb(110 231 255 / 0.18);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-block-size: 100%; }
  body {
    background:
      radial-gradient(120% 90% at 50% -10%, #12283c 0%, transparent 60%),
      var(--ground);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: grid;
    place-items: center;
    padding: 32px 20px 56px;
  }
  main { inline-size: min(560px, 100%); text-align: center; }
  .dl__icon { inline-size: clamp(96px, 26vw, 128px); block-size: auto; }
  h1 {
    margin: 18px 0 2px;
    font-size: clamp(20px, 6vw, 30px);
    letter-spacing: 0.34em;
    text-indent: 0.34em;
    font-weight: 700;
  }
  .sub { margin: 0 0 26px; color: var(--ink-faint); font-size: 13px; letter-spacing: 0.16em; text-transform: uppercase; }
  .card {
    background: var(--glass);
    border: 1px solid var(--hair);
    border-radius: 2px;
    padding: 22px 20px;
    text-align: start;
    backdrop-filter: blur(8px);
  }
  .card + .card { margin-block-start: 14px; }
  a.btn {
    display: block;
    margin: 0 0 16px;
    padding: 18px 20px;
    background: var(--ice);
    color: #04121a;
    text-decoration: none;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    text-align: center;
    border-radius: 2px;
    box-shadow: 0 0 0 1px rgb(110 231 255 / 0.5), 0 0 24px rgb(110 231 255 / 0.28), 0 0 64px rgb(110 231 255 / 0.14);
    /* 48px minimum touch target, like every control in the game. */
    min-block-size: 48px;
  }
  a.btn:active { transform: translateY(1px); }
  .meta { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 12.5px; }
  .meta dt { color: var(--ink-faint); letter-spacing: 0.1em; text-transform: uppercase; }
  .meta dd { margin: 0; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; overflow-wrap: anywhere; }
  h2 { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ice); margin: 0 0 10px; }
  ol { margin: 0; padding-inline-start: 20px; font-size: 14px; line-height: 1.65; }
  li + li { margin-block-start: 6px; }
  .note { color: var(--ink-faint); font-size: 12.5px; line-height: 1.6; margin: 14px 0 0; }
  code { font-family: ui-monospace, Menlo, monospace; color: var(--ice); }
</style>
</head>
<body>
<main>
  ${icon}
  <h1>SHATTERPOINT</h1>
  <p class="sub">Android test build</p>

  <div class="card">
    <!-- download attribute: same-origin, so the browser saves it rather than trying to
         navigate to it and rendering a binary. -->
    <a class="btn" href="./shatterpoint-debug.apk" download="shatterpoint-debug.apk">
      Download APK &middot; ${mb} MB
    </a>
    <dl class="meta">
      <dt>File</dt><dd>shatterpoint-debug.apk</dd>
      <dt>Size</dt><dd>${bytes.toLocaleString('en-US')} bytes</dd>
      <dt>Package</dt><dd>com.jaswanthtech.shatterpoint</dd>
      <dt>Min / target</dt><dd>Android 5.1 (API 22) / API 34</dd>
      <dt>Built</dt><dd>${built} UTC</dd>
      <dt>SHA-256</dt><dd>${sha}</dd>
    </dl>
  </div>

  <div class="card">
    <h2>Installing</h2>
    <ol>
      <li>Tap <strong>Download APK</strong> above. Chrome will warn that this file type can harm your device &mdash; that warning appears for every APK, signed or not. Choose <strong>Download anyway</strong>.</li>
      <li>Open the file from your notification shade or from <strong>Files &rarr; Downloads</strong>.</li>
      <li>Android will ask to allow installs from this app. Enable it, then come back and tap <strong>Install</strong>.</li>
      <li>Launch <strong>SHATTERPOINT</strong>. It locks to landscape and goes fullscreen.</li>
    </ol>
    <p class="note">Tap to throw. Approaches 1&ndash;2 are free while the tutorial is up. Break the glass, grab the crystals, and hitting a pane you did not break costs you ten balls.</p>
  </div>

  <div class="card">
    <h2>What this build is</h2>
    <p class="note">
      A <strong>debug</strong> build, signed with the standard Android debug key &mdash; fine for
      testing, not for distribution. It picks its own quality tier from what your device
      reports; in a WebView without WebGPU that is <code>MOBILE_LOW</code>, rendering at 0.6
      scale and reconstructing with FSR1. If your device advertises WebGPU but cannot sustain
      it you will see one automatic reload into the WebGL path on first launch &mdash; that is
      the fallback working, not a crash.
    </p>
  </div>
</main>
</body>
</html>
`;

writeFileSync(join(DIR, 'index.html'), html);
console.log(`  wrote exports/apk/index.html`);
console.log(`    apk    ${bytes.toLocaleString('en-US')} bytes (${mb} MB)`);
console.log(`    sha256 ${sha}`);
