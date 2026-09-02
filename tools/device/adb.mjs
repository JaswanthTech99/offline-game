/**
 * adb helpers. Every command is pinned to a serial.
 *
 * Unpinned adb picks "the only device" and silently picks the wrong one the moment a second
 * phone appears - which is exactly the failure mode that attributes a OnePlus measurement
 * to an iQOO. There is no unpinned path in this module on purpose.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const PKG = 'com.jaswanthtech.shatterpoint';

export async function devices() {
  const { stdout } = await run('adb', ['devices', '-l']);
  return stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('*'))
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const model = /model:(\S+)/.exec(rest.join(' '))?.[1] ?? 'unknown';
      return { serial, state, model };
    })
    .filter((d) => d.state === 'device');
}

export async function sh(serial, args, opts = {}) {
  const { stdout } = await run('adb', ['-s', serial, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return stdout;
}

export const shell = (serial, cmd) => sh(serial, ['shell', cmd]);

/** Raw bytes, for screencap. */
export async function shellBinary(serial, cmd) {
  const { stdout } = await run('adb', ['-s', serial, 'exec-out', cmd], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'buffer',
  });
  return stdout;
}

export const screencap = (serial) => shellBinary(serial, 'screencap -p');

export async function describe(serial) {
  const get = async (prop) => (await shell(serial, `getprop ${prop}`)).trim();
  return {
    serial,
    model: await get('ro.product.model'),
    brand: await get('ro.product.brand'),
    release: await get('ro.build.version.release'),
    sdk: await get('ro.build.version.sdk'),
    density: (await shell(serial, 'wm density')).trim(),
    size: (await shell(serial, 'wm size')).trim(),
  };
}

/**
 * Cutout emulation. This is the single most useful line in the whole device pass: it
 * reproduces the punch-hole clipping on ANY device or emulator, so the bug becomes a
 * regression test rather than something only one phone can prove.
 */
export const CUTOUTS = ['tall', 'corner', 'double', 'hole'];

export const cutoutOverlay = (name) =>
  `com.android.internal.display.cutout.emulation.${name}`;

export async function enableCutout(serial, name) {
  await shell(serial, `cmd overlay enable ${cutoutOverlay(name)}`);
  await new Promise((r) => setTimeout(r, 1500));
}

export async function disableAllCutouts(serial) {
  for (const c of CUTOUTS) {
    await shell(serial, `cmd overlay disable ${cutoutOverlay(c)}`).catch(() => undefined);
  }
}

/** The devtools socket name carries the WebView's pid, which changes on every launch. */
export async function webviewSocket(serial) {
  const out = await shell(serial, 'cat /proc/net/unix');
  const m = /@(webview_devtools_remote_\d+)/.exec(out);
  return m?.[1] ?? null;
}

export async function forwardWebview(serial, port = 9222) {
  const socket = await webviewSocket(serial);
  if (socket === null) return null;
  await sh(serial, ['forward', `tcp:${port}`, `localabstract:${socket}`]);
  return port;
}

export const unforward = (serial, port = 9222) =>
  sh(serial, ['forward', '--remove', `tcp:${port}`]).catch(() => undefined);

export const launch = (serial) =>
  shell(serial, `am start -W -n ${PKG}/.MainActivity`);

export const forceStop = (serial) => shell(serial, `am force-stop ${PKG}`);

export const resetGfx = (serial) => shell(serial, `dumpsys gfxinfo ${PKG} reset`);

export const framestats = (serial) => shell(serial, `dumpsys gfxinfo ${PKG}`);
