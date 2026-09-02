import { PNG } from 'pngjs';
import { expect, test } from '../fixtures/game';
import type { Page } from '@playwright/test';

const SAMPLES_MS = [100, 200, 300, 400, 500, 600] as const;
const STEP_MS = 1000 / 60;

interface Probe {
  ms: number;
  screen: { x: number; y: number } | null;
  coreR: number;
  glowR: number;
  peak: number;
  bg: number;
  live: number;
  drawnR: number;
}

interface Advance {
  screen: { x: number; y: number } | null;
  live: number;
  drawnR: number;
}

async function muteHmr(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class Silent extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly readyState = 3;
      send(): void {}
      close(): void {}
    }
    Object.defineProperty(window, 'WebSocket', { value: Silent, writable: true, configurable: true });
  });
}

function measure(png: PNG, cx: number, cy: number): Omit<Probe, 'ms' | 'screen' | 'live' | 'drawnR'> {
  const L = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return -1;
    const i = (y * png.width + x) * 4;
    return (0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!) / 255;
  };
  let bg = 0;
  let n = 0;
  for (let a = 0; a < 64; a++) {
    const th = (a / 64) * Math.PI * 2;
    for (let r = 34; r <= 46; r += 2) {
      const v = L(Math.round(cx + Math.cos(th) * r), Math.round(cy + Math.sin(th) * r));
      if (v >= 0) {
        bg += v;
        n++;
      }
    }
  }
  const background = n > 0 ? bg / n : 0;
  let peak = 0;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const v = L(cx + dx, cy + dy);
      if (v > peak) peak = v;
    }
  }
  const walk = (limit: number): number => {
    const hits: number[] = [];
    for (let a = 0; a < 16; a++) {
      const th = (a / 16) * Math.PI * 2;
      let r = 0;
      for (; r < 48; r += 1) {
        if (L(Math.round(cx + Math.cos(th) * r), Math.round(cy + Math.sin(th) * r)) < limit) break;
      }
      hits.push(r);
    }
    hits.sort((p, q) => p - q);
    return hits[8] ?? 0;
  };
  return {
    coreR: walk(background + 0.5 * (peak - background)),
    glowR: walk(background + 0.04),
    peak,
    bg: background,
  };
}

function table(rows: Probe[]): string {
  return rows
    .map(
      (r) =>
        `  ${String(r.ms).padStart(4)}ms  ` +
        `screen ${r.screen === null ? 'null     ' : `${r.screen.x.toFixed(0)},${r.screen.y.toFixed(0)}`.padEnd(9)}  ` +
        `coreR ${r.coreR.toFixed(1).padStart(5)}px  glowR ${r.glowR.toFixed(1).padStart(5)}px  ` +
        `drawnR ${r.drawnR.toFixed(1).padStart(5)}px  peak ${(r.peak * 100).toFixed(1).padStart(5)}%  ` +
        `bg ${(r.bg * 100).toFixed(1).padStart(5)}%  balls ${r.live}`,
    )
    .join('\n');
}

declare global {
  interface Window {
    __shatterpoint__?: {
      scene: { traverse(cb: (o: unknown) => void): void };
      camera: unknown;
      playfield: unknown;
    };
    __bv?: { advance(steps: number): Advance };
  }
}

test.describe('@diag', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 only');
  });

  test('BallVisual attached', async ({ game }) => {
    const dpr = game.scale;
    await muteHmr(game.page);
    await game.boot({ seed: 4242 });
    await game.hideHud();
    await game.freeze();
    await game.clearField();
    await game.page.evaluate(() => {
      const app = window.__shatterpoint__;
      if (app === undefined) return;
      (app.playfield as unknown as { frozen: boolean }).frozen = false;
    });

    const bufferH = (await game.snapshot()).bufferHeight;
    await game.page.evaluate(async (viewportPx: number) => {
      const app = window.__shatterpoint__!;
      const visualPath = '/src/gameplay/BallVisual.ts';
      const registryPath = '/src/universe/registry.ts';
      const mod = (await import(/* @vite-ignore */ visualPath)) as unknown as {
        BallVisual: new (
          scene: unknown,
          camera: unknown,
          tint: unknown,
          edge: unknown,
          options: { viewportPx: number },
        ) => { track(p: unknown, v: unknown): void; end(): void; screenRadiusPx: number };
      };
      const reg = (await import(/* @vite-ignore */ registryPath)) as unknown as {
        getTheme: (id: string) => { metal: unknown; emissive: { primary: unknown } };
      };
      const theme = reg.getTheme('void-cathedral');
      const rig = new mod.BallVisual(app.scene, app.camera, theme.metal, theme.emissive.primary, {
        viewportPx,
      });
      interface Vec {
        set(x: number, y: number, z: number): Vec;
        clone(): Vec;
      }
      const cam = app.camera as { position: { clone(): Vec } };
      let prev: { x: number; y: number; z: number } | null = null;
      const hideShipped = (): void => {
        app.scene.traverse((raw) => {
          const o = raw as {
            isMesh?: boolean;
            visible?: boolean;
            geometry?: { type?: string; parameters?: { radius?: number } };
          };
          if (o.isMesh !== true || o.geometry?.type !== 'SphereGeometry') return;
          if (Math.abs((o.geometry.parameters?.radius ?? 0) - 0.34) > 1e-6) return;
          o.visible = false;
        });
      };
      window.__bv = {
        advance: (steps: number): Advance => {
          const sp = window.__sp!;
          for (let i = 0; i < steps; i++) {
            sp.step(1000 / 60);
            hideShipped();
            const w = sp.ballWorld();
            if (w !== null) {
              const p = cam.position.clone().set(w.x, w.y, w.z);
              const v = cam.position.clone();
              if (prev === null) v.set(0, 0, -69);
              else v.set((w.x - prev.x) * 60, (w.y - prev.y) * 60, (w.z - prev.z) * 60);
              prev = { x: w.x, y: w.y, z: w.z };
              rig.track(p, v);
            }
            rig.end();
            sp.step(0);
          }
          const w = sp.ballWorld();
          return {
            screen: w === null ? null : sp.project(w.x, w.y, w.z),
            live: (sp.snapshot() as { liveBalls: number }).liveBalls,
            drawnR: rig.screenRadiusPx,
          };
        },
      };
    }, bufferH);

    await game.throwAt(0, 0);

    const rows: Probe[] = [];
    let elapsed = 0;
    for (const at of SAMPLES_MS) {
      let steps = 0;
      while (elapsed < at) {
        steps++;
        elapsed += STEP_MS;
      }
      const a = await game.page.evaluate((n: number) => window.__bv!.advance(n), steps);
      const png = PNG.sync.read(await game.page.screenshot());
      const m =
        a.screen === null
          ? { coreR: 0, glowR: 0, peak: 0, bg: 0 }
          : measure(png, Math.round(a.screen.x * dpr), Math.round(a.screen.y * dpr));
      rows.push({ ms: at, screen: a.screen, ...m, live: a.live, drawnR: a.drawnR * dpr });
    }
    console.log(`WIRED (BallVisual attached):\n${table(rows)}`);
    expect(rows.length).toBe(6);
  });
});
