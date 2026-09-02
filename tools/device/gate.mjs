/**
 * The Android device pass, as one repeatable command.
 *
 *   node tools/device/gate.mjs               all attached devices
 *   node tools/device/gate.mjs <serial>      one device
 *
 * Runs every gate that needs hardware, on every attached phone, and writes screenshots and
 * a JSON report to exports/device/<model>-<serial>/. It attaches Playwright to the LIVE
 * on-device WebView over CDP, so DOM and HUD assertions come from the real renderer on the
 * real GPU rather than a desktop approximation.
 *
 * It ALWAYS disables the cutout overlays it enables, including on failure - leaving a phone
 * with a fake notch after a test run is a nasty thing to hand back.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  CUTOUTS, describe, devices, disableAllCutouts, enableCutout,
  forceStop, forwardWebview, framestats, launch, resetGfx, screencap, shell, unforward,
} from './adb.mjs';

const OUT_ROOT = 'exports/device';
const only = process.argv[2];

/** Frame-time percentiles from gfxinfo's histogram. Real present timing, not a JS timer. */
function parseFrameStats(text) {
  const total = Number(/Total frames rendered: (\d+)/.exec(text)?.[1] ?? 0);
  const janky = Number(/Janky frames: (\d+)/.exec(text)?.[1] ?? 0);
  const pct = (label) => Number(new RegExp(`${label}: (\\d+)ms`).exec(text)?.[1] ?? NaN);
  return {
    total,
    janky,
    jankyPct: total > 0 ? (janky / total) * 100 : NaN,
    p50: pct('50th percentile'),
    p90: pct('90th percentile'),
    p95: pct('95th percentile'),
    p99: pct('99th percentile'),
  };
}

async function attachCdp(serial) {
  const port = await forwardWebview(serial);
  if (port === null) return null;
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = browser.contexts()[0];
    const page = ctx?.pages()[0] ?? (await ctx?.waitForEvent('page', { timeout: 15_000 }));
    return { browser, page };
  } catch {
    await unforward(serial, port);
    return null;
  }
}

/** Every HUD box against the visual viewport, plus the four resolved safe-area insets. */
const HUD_PROBE = () => {
  const read = (n) =>
    Number(
      getComputedStyle(document.documentElement).getPropertyValue(n).replace('px', '').trim(),
    ) || 0;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;' +
    'padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);' +
    'padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const safe = {
    top: parseFloat(cs.paddingTop),
    right: parseFloat(cs.paddingRight),
    bottom: parseFloat(cs.paddingBottom),
    left: parseFloat(cs.paddingLeft),
  };
  probe.remove();

  const vw = window.visualViewport?.width ?? window.innerWidth;
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const boxes = [...document.querySelectorAll('.sp-c, .sp-centre, .boot__icon, .boot__word')].map(
    (el) => {
      const r = el.getBoundingClientRect();
      return {
        sel: `.${String(el.className).split(' ')[0]}`,
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        outside:
          r.left < safe.left - 0.5 || r.top < safe.top - 0.5 ||
          r.right > vw - safe.right + 0.5 || r.bottom > vh - safe.bottom + 0.5,
      };
    },
  );
  return {
    viewport: { w: Math.round(vw), h: Math.round(vh), dpr: window.devicePixelRatio },
    safe,
    edgePx: read('--sp-edge'),
    boxes,
    snapshot: window.__sp ? window.__sp.snapshot() : null,
    probe: window.__spProbe ?? null,
    glRenderer: (() => {
      try {
        const gl = document.createElement('canvas').getContext('webgl2');
        const d = gl?.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : null;
      } catch { return null; }
    })(),
    cores: navigator.hardwareConcurrency,
    memoryGb: navigator.deviceMemory ?? null,
  };
};

async function runDevice(dev) {
  const info = await describe(dev.serial);
  const dir = join(OUT_ROOT, `${info.model.replace(/\W+/g, '-')}-${dev.serial}`);
  await mkdir(dir, { recursive: true });
  const report = { device: info, stages: {} };
  console.log(`\n=== ${info.brand} ${info.model}  (${dev.serial})  Android ${info.release} / API ${info.sdk}`);
  console.log(`    ${info.size}  ${info.density}`);

  try {
    // ---- STAGE 1: insets, with and without an emulated cutout ---------------------------
    const stage1 = [];
    for (const cutout of ['none', ...CUTOUTS]) {
      if (cutout !== 'none') await enableCutout(dev.serial, cutout);
      await forceStop(dev.serial);
      await launch(dev.serial);
      await new Promise((r) => setTimeout(r, 6000));

      const cdp = await attachCdp(dev.serial);
      let probe = null;
      if (cdp) {
        probe = await cdp.page.evaluate(HUD_PROBE).catch(() => null);
        await cdp.browser.close();
        await unforward(dev.serial);
      }
      await writeFile(join(dir, `stage1-${cutout}.png`), await screencap(dev.serial));
      const bad = probe?.boxes.filter((b) => b.outside) ?? [];
      stage1.push({ cutout, safe: probe?.safe ?? null, edgePx: probe?.edgePx ?? null, offscreen: bad });
      console.log(
        `    cutout ${cutout.padEnd(7)} safe T/R/B/L ${
          probe ? [probe.safe.top, probe.safe.right, probe.safe.bottom, probe.safe.left].map((n) => n.toFixed(0)).join('/') : 'n/a'
        }  offscreen ${bad.length}`,
      );
    }
    report.stages.insets = stage1;

    // ---- STAGE 2: capability, tier and sustained frame time -----------------------------
    await disableAllCutouts(dev.serial);
    await forceStop(dev.serial);
    await launch(dev.serial);
    await new Promise((r) => setTimeout(r, 8000));
    const cdp = await attachCdp(dev.serial);
    const caps = cdp ? await cdp.page.evaluate(HUD_PROBE).catch(() => null) : null;
    if (cdp) { await cdp.browser.close(); await unforward(dev.serial); }
    if (caps) {
      console.log(`    renderer  ${caps.glRenderer ?? '(withheld)'}`);
      console.log(`    cores ${caps.cores}  memory ${caps.memoryGb ?? '?'}GB`);
      console.log(`    tier ${caps.snapshot?.tier} scale ${caps.snapshot?.renderScale}  probe ${caps.probe?.reason ?? 'n/a'}`);
    }
    report.stages.capability = caps;

    await resetGfx(dev.serial);
    console.log('    sustained run: 3 minutes...');
    await new Promise((r) => setTimeout(r, 180_000));
    const stats = parseFrameStats(await framestats(dev.serial));
    const after = await attachCdp(dev.serial);
    const tierAfter = after ? await after.page.evaluate(() => window.__sp?.snapshot().tier).catch(() => null) : null;
    if (after) { await after.browser.close(); await unforward(dev.serial); }
    report.stages.sustained = { ...stats, tierAtStart: caps?.snapshot?.tier ?? null, tierAt3min: tierAfter };
    console.log(`    p50 ${stats.p50}ms p95 ${stats.p95}ms p99 ${stats.p99}ms  janky ${stats.jankyPct.toFixed(1)}%`);
    console.log(`    tier ${caps?.snapshot?.tier} -> ${tierAfter}`);

    // ---- STAGE 3: cold start ------------------------------------------------------------
    await forceStop(dev.serial);
    const amOut = await launch(dev.serial);
    report.stages.coldStart = {
      totalTimeMs: Number(/TotalTime: (\d+)/.exec(amOut)?.[1] ?? NaN),
      waitTimeMs: Number(/WaitTime: (\d+)/.exec(amOut)?.[1] ?? NaN),
    };
    console.log(`    cold start TotalTime ${report.stages.coldStart.totalTimeMs}ms`);

    // ---- STAGE 4: launcher --------------------------------------------------------------
    await shell(dev.serial, 'input keyevent KEYCODE_HOME');
    await new Promise((r) => setTimeout(r, 2500));
    await writeFile(join(dir, 'stage4-launcher.png'), await screencap(dev.serial));
    await shell(dev.serial, 'input keyevent KEYCODE_APP_SWITCH');
    await new Promise((r) => setTimeout(r, 2000));
    await writeFile(join(dir, 'stage4-recents.png'), await screencap(dev.serial));
  } finally {
    // Never hand a phone back with a fake notch on it.
    await disableAllCutouts(dev.serial);
    await unforward(dev.serial).catch(() => undefined);
  }

  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`    wrote ${dir}/`);
  return report;
}

const attached = (await devices()).filter((d) => !only || d.serial === only);
if (attached.length === 0) {
  console.error('  no devices attached. Connect over USB with debugging enabled, or `adb tcpip 5555`.');
  process.exit(2);
}
for (const d of attached) await runDevice(d);
