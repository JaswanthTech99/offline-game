import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { expect, test } from '../fixtures/game';
import type { Game } from '../fixtures/game';

/**
 * OBSTACLE PANE gate.
 *
 * A pane that is a bright border around an empty middle is a wireframe. The eye reads it as
 * a selection box, and no rim tuning fixes that, because the rim IS the problem. This gate
 * turns "reads as a pane" into two numbers that can fail:
 *
 *   INTERIOR  >  local BACKGROUND  by at least INTERIOR_MARGIN
 *       the middle of the pane must carry a value of its own. A pane whose interior equals
 *       what is behind it is a hole with a border drawn on it.
 *   RIM       <= MAX_RIM_RATIO x INTERIOR
 *       the border may lead, but it may not be the whole object. Six is generous: at six the
 *       border is still six times the surface it is supposed to be bounding.
 *
 * Both subjects are located through `window.__sp.project()` - the pane's own world position,
 * projected - never by hunting for bright pixels. Two earlier measurement passes on this
 * project were wrong precisely because they searched the image for the brightest thing and
 * found the aperture.
 *
 * Two variants are measured at every distance:
 *   shipped   what `place('pane', d)` builds today, through Playfield.
 *   dressed   the same pane rebuilt by src/gameplay/ObstaclePane.ts and mounted at the same
 *             world position, so the background behind both readings is identical.
 * The dressed rows are the module under test and are always asserted. The shipped rows are
 * asserted too, but only once the shipped pane is actually wearing the dressing - which the
 * gate detects structurally, by looking for the dressing group in the scene graph rather
 * than by guessing. Before the wave-2 wiring lands they are the baseline the module is
 * measured against; after it lands they are the same assertion applied to the real game.
 */

const DISTANCES: readonly number[] = [10, 20, 30, 45, 60, 80, 100];

/** Metres off the corridor axis. Dead centre puts the aperture directly behind the subject,
 *  and the measurement then reports the aperture. */
const OFFSET_X = 1.9;

/** Pane dimensions, mirroring Playfield's TUNING. The gate has to know how big its subject
 *  is to project its corners; it must not be allowed to discover that from the image. */
const PANE_W = 3;
const PANE_H = 3;

/** Luminance, 0..1. Small on purpose: the requirement is that the surface is ABOVE its
 *  background, not that it is bright - brightness is the rim's job and glow is not detail. */
const INTERIOR_MARGIN = 0.02;
const MAX_RIM_RATIO = 6;

const SEED = 20260902;
const CAPTURE_DISTANCE = 20;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Reading {
  rim: number;
  interior: number;
  background: number;
  widthPx: number;
  heightPx: number;
  bandPx: number;
}

interface Row {
  distance: number;
  variant: 'shipped' | 'dressed';
  reading: Reading;
}

interface PaneProbe {
  features: readonly string[];
  inventory: {
    seed: number;
    bracketPieces: number;
    railPieces: number;
    mullionBars: number;
    laminateQuads: number;
    frameTriangles: number;
    crackSegments: readonly number[];
    crackTriangles: readonly number[];
    drawCallsPerPane: number;
  };
  /** Position-buffer checksums of the crack geometry, for the determinism claim. */
  checksumA: number;
  checksumSameSeed: number;
  checksumOtherSeed: number;
}

/** The app handle main.ts parks on window. Declared locally and reached through a cast,
 *  because another spec already augments Window with its own narrower view of it. */
type AppWindow = {
  __shatterpoint__?: {
    playfield: { root: { traverse(cb: (o: { name: string; visible: boolean }) => void): void } };
  };
};

declare global {
  interface Window {
    __spPaneMount?: (distance: number, offsetX: number) => void;
    __spPaneClear?: () => void;
    __spPaneProbe?: PaneProbe;
  }
}

/**
 * Builds the module's own pane inside the running page and parks it in the playfield root,
 * at the same local coordinates `spawnPane` uses. Injected as a module script rather than
 * imported here because e2e is a separate TypeScript program that must never link src/.
 */
const PREVIEW_SCRIPT = `
import { ObstaclePaneKit, paneStyleFromTheme, PANE_DETAIL_FULL, OBSTACLE_PANE_FEATURES }
  from '/src/gameplay/ObstaclePane.ts';
import { GLASS_ALL } from '/src/gameplay/GlassMaterial.ts';
import { getTheme } from '/src/universe/registry.ts';
import { asSeed } from '/src/core/types.ts';

const app = window.__shatterpoint__;
const theme = getTheme('void-cathedral');
const options = (seed) => ({
  width: ${PANE_W},
  height: ${PANE_H},
  thickness: 0.06,
  seed: asSeed(seed),
  style: paneStyleFromTheme(theme),
  detail: PANE_DETAIL_FULL,
  features: GLASS_ALL,
  keyDirection: [0.15, 0.35, 1],
  baseOpacity: theme.glass.alpha,
  role: 'breakable',
});

const checksum = (mesh) => {
  let sum = 0;
  mesh.traverse((o) => {
    if (o.geometry === undefined || !o.name.endsWith('-fractures')) return;
    const a = o.geometry.getAttribute('position').array;
    for (let i = 0; i < a.length; i++) sum = (sum * 31 + a[i]) % 1e12;
  });
  return sum;
};

const kit = new ObstaclePaneKit(options(${SEED}));
const pane = kit.createPane(0);
pane.name = 'pane-preview';

const same = new ObstaclePaneKit(options(${SEED}));
const other = new ObstaclePaneKit(options(${SEED + 1}));
const samePane = same.createPane(0);
const otherPane = other.createPane(0);
const probe = {
  features: OBSTACLE_PANE_FEATURES,
  inventory: kit.inventory,
  checksumA: checksum(pane),
  checksumSameSeed: checksum(samePane),
  checksumOtherSeed: checksum(otherPane),
};
same.dispose();
other.dispose();

window.__spPaneMount = (distance, offsetX) => {
  pane.position.set(offsetX, 0, -distance);
  pane.visible = true;
  if (pane.parent === null) app.playfield.root.add(pane);
};
window.__spPaneClear = () => { pane.visible = false; };
window.__spPaneProbe = probe;
`;

function lumaAt(png: PNG, x: number, y: number): number {
  const i = (y * png.width + x) * 4;
  return (0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!) / 255;
}

/**
 * Three disjoint regions of the SAME image:
 *   rim         a band `bandPx` wide just inside the projected pane rectangle
 *   interior    everything inboard of that band, minus one pixel of separation
 *   background  a 4..12 px annulus outside the rectangle - LOCAL background, because a
 *               frame-wide average would compare the pane against the aperture
 * The band narrows with the subject so the three regions stay disjoint at 100 m, where the
 * whole pane is barely a dozen pixels across.
 */
function measure(png: PNG, rect: Rect): Reading {
  const x0 = Math.max(0, Math.round(rect.x0));
  const x1 = Math.min(png.width - 1, Math.round(rect.x1));
  const y0 = Math.max(0, Math.round(rect.y0));
  const y1 = Math.min(png.height - 1, Math.round(rect.y1));
  const widthPx = x1 - x0;
  const heightPx = y1 - y0;
  const bandPx = Math.max(1, Math.min(3, Math.round(Math.min(widthPx, heightPx) * 0.18)));
  const inset = bandPx + 1;

  let rimSum = 0;
  let rimN = 0;
  let innerSum = 0;
  let innerN = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const edge = Math.min(x - x0, x1 - x, y - y0, y1 - y);
      const l = lumaAt(png, x, y);
      if (edge < bandPx) {
        rimSum += l;
        rimN++;
      } else if (edge >= inset) {
        innerSum += l;
        innerN++;
      }
    }
  }
  // A subject too small to hold a separated interior still has a centre pixel, and a centre
  // pixel is a fair reading - it is inside the pane by construction.
  if (innerN === 0) {
    innerSum = lumaAt(png, Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2));
    innerN = 1;
  }

  let bgSum = 0;
  let bgN = 0;
  for (let y = y0 - 12; y <= y1 + 12; y++) {
    for (let x = x0 - 12; x <= x1 + 12; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const outside = Math.max(x0 - x, x - x1, y0 - y, y - y1);
      if (outside < 4 || outside > 12) continue;
      bgSum += lumaAt(png, x, y);
      bgN++;
    }
  }

  return {
    rim: rimN > 0 ? rimSum / rimN : 0,
    interior: innerSum / innerN,
    background: bgN > 0 ? bgSum / bgN : 0,
    widthPx,
    heightPx,
    bandPx,
  };
}

async function projectPoint(
  game: Game,
  x: number,
  y: number,
  z: number,
): Promise<{ x: number; y: number } | null> {
  return game.page.evaluate(
    ([px, py, pz]) => window.__sp!.project(px as number, py as number, pz as number),
    [x, y, z] as const,
  );
}

/** The pane's projected rectangle in DEVICE pixels. project() answers in CSS pixels. */
async function paneRect(game: Game, distance: number, dpr: number): Promise<Rect> {
  const tl = await projectPoint(game, OFFSET_X - PANE_W / 2, PANE_H / 2, -distance);
  const br = await projectPoint(game, OFFSET_X + PANE_W / 2, -PANE_H / 2, -distance);
  expect(tl, `pane at ${distance}m did not project`).not.toBeNull();
  expect(br, `pane at ${distance}m did not project`).not.toBeNull();
  return {
    x0: tl!.x * dpr,
    y0: tl!.y * dpr,
    x1: br!.x * dpr,
    y1: br!.y * dpr,
  };
}

async function shot(game: Game): Promise<PNG> {
  return PNG.sync.read(await game.page.screenshot());
}

test.describe('@pane-detail', () => {
  // One scale: this gate measures whether a surface has a value, not how sharp its edges are.
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 project only');
  });

  test('a breakable pane reads as a surface from 10m to 100m', async ({ game }, info) => {
    // Vite's HMR socket is answered by a mock that never delivers an update. A gate holds one
    // frozen page for a minute of captures, and any src/ edit anywhere in the repo otherwise
    // triggers a full reload that destroys the execution context mid-measurement.
    await game.page.routeWebSocket('**', () => {});

    await game.boot({ seed: SEED, universe: 'void-cathedral' });
    await game.hideHud();
    await game.freeze();
    await game.page.waitForFunction(
      () => (window as unknown as AppWindow).__shatterpoint__ !== undefined,
    );
    await game.page.addScriptTag({ content: PREVIEW_SCRIPT, type: 'module' });
    await game.page.waitForFunction(() => window.__spPaneProbe !== undefined);

    const probe = await game.page.evaluate(() => window.__spPaneProbe!);
    const dpr = game.scale;
    const rows: Row[] = [];
    await mkdir('exports', { recursive: true });

    for (const distance of DISTANCES) {
      const rect = await paneRect(game, distance, dpr);

      // ---- shipped ---------------------------------------------------------------------
      await game.page.evaluate(() => window.__spPaneClear!());
      await game.place('pane', distance, OFFSET_X);
      await game.step();
      const shippedPng = await shot(game);
      rows.push({ distance, variant: 'shipped', reading: measure(shippedPng, rect) });

      // ---- dressed ---------------------------------------------------------------------
      // clearField() hides every shipped target, so the dressed pane is measured against
      // exactly the corridor the shipped one was measured against.
      await game.clearField();
      await game.page.evaluate(
        ([d, x]) => window.__spPaneMount!(d as number, x as number),
        [distance, OFFSET_X] as const,
      );
      await game.step();
      const dressedPng = await shot(game);
      rows.push({ distance, variant: 'dressed', reading: measure(dressedPng, rect) });

      if (distance === CAPTURE_DISTANCE) {
        await writeFile(join('exports', 'pane-before.png'), PNG.sync.write(shippedPng));
        await writeFile(join('exports', 'pane-after.png'), PNG.sync.write(dressedPng));
      }
    }

    // Is the SHIPPED pane already wearing the dressing? Asked of the scene graph, so the
    // shipped assertions arm themselves the moment the wave-2 wiring lands.
    const shippedIsDressed = await game.page.evaluate(() => {
      const app = (window as unknown as AppWindow).__shatterpoint__;
      const root = app?.playfield.root;
      if (root === undefined) return false;
      let found = false;
      root.traverse((o) => {
        if (o.name === 'obstacle-pane-dressing' && o.visible) found = true;
      });
      return found;
    });

    const header =
      '  dist  variant   px      rim     interior  background  rim/int  int-bg\n' +
      '  ----  --------  ------  ------  --------  ----------  -------  ------';
    const table = rows.map((r) => {
      const { reading: m } = r;
      const ratio = m.interior > 0 ? m.rim / m.interior : Number.POSITIVE_INFINITY;
      return (
        `  ${String(r.distance).padStart(4)}  ${r.variant.padEnd(8)}  ` +
        `${`${m.widthPx}x${m.heightPx}`.padEnd(6)}  ` +
        `${m.rim.toFixed(4)}  ${m.interior.toFixed(4)}    ${m.background.toFixed(4)}      ` +
        `${(Number.isFinite(ratio) ? ratio.toFixed(2) : 'inf').padStart(7)}  ` +
        `${(m.interior - m.background >= 0 ? '+' : '') + (m.interior - m.background).toFixed(4)}`
      );
    });

    const inventory = probe.inventory;
    const pxPerMetre = await (async (): Promise<number> => {
      const a = await projectPoint(game, OFFSET_X, 0, -CAPTURE_DISTANCE);
      const b = await projectPoint(game, OFFSET_X + 1, 0, -CAPTURE_DISTANCE);
      return a === null || b === null ? 0 : Math.abs(b.x - a.x) * dpr;
    })();
    const px = (metres: number): string => `${(metres * pxPerMetre).toFixed(1)}px`;

    const features = [
      `  1 metal frame with corner brackets  ${inventory.bracketPieces} bracket boxes ` +
        `(2 arms + 1 fixing boss per corner) on ${inventory.railPieces} rails; ` +
        `arm ${px(0.57)} long, boss ${px(0.285)} at ${CAPTURE_DISTANCE}m`,
      `  2 mullion grid                      ${inventory.mullionBars} bars across the face, ` +
        `each ${px(0.0825)} wide, standing ${px(0.096)} proud of the glass`,
      `  3 seeded stress fractures           ${inventory.crackSegments.join('/')} segments per ` +
        `variant from seed ${inventory.seed}; identical seed reproduces the buffer exactly`,
      `  4 laminate edge                     ${inventory.laminateQuads} bands: glass/interlayer/` +
        `glass at ${px(0.084)} total, plus a 0.06m side wall carrying the same stack`,
      `  5 interference sheen                thin-film hue walk on the face, 1/cos(theta) ` +
        `phase, broken up by world-space noise`,
      `  6 interior fill                     faint additive floor across the face`,
      `  7 facet catch                       one broad specular band, sliding with view angle`,
    ];

    const report = [
      `obstacle pane, seed ${SEED}, offset ${OFFSET_X}m off axis, ${dpr}x device pixels`,
      `shipped pane is dressed: ${shippedIsDressed}`,
      header,
      ...table,
      '',
      `frame draw calls per pane: ${inventory.drawCallsPerPane} (face + frame + fractures), ` +
        `${inventory.frameTriangles} frame triangles shared by every pane`,
      `crack determinism: same seed ${probe.checksumA === probe.checksumSameSeed ? 'MATCHES' : 'DIFFERS'}, ` +
        `other seed ${probe.checksumOtherSeed === probe.checksumA ? 'MATCHES' : 'DIFFERS'}`,
      '',
      'features present in exports/pane-after.png (absent from exports/pane-before.png):',
      ...features,
    ].join('\n');

    console.log(report);
    await info.attach('pane-detail', { body: report, contentType: 'text/plain' });

    // A seed that does not reproduce its pane is a pane that cannot be captured twice.
    expect(probe.checksumA, 'same seed must rebuild the same fractures').toBe(
      probe.checksumSameSeed,
    );
    expect(probe.checksumOtherSeed, 'a different seed must crack differently').not.toBe(
      probe.checksumA,
    );
    expect(probe.features.length, 'the module must name what it adds').toBeGreaterThanOrEqual(5);

    for (const row of rows) {
      if (row.variant === 'shipped' && !shippedIsDressed) continue;
      const { reading: m } = row;
      const where = `${row.variant} pane at ${row.distance}m (${m.widthPx}x${m.heightPx}px)`;
      expect
        .soft(m.interior - m.background, `${where}: interior does not clear its background`)
        .toBeGreaterThanOrEqual(INTERIOR_MARGIN);
      expect
        .soft(m.rim, `${where}: rim ${m.rim.toFixed(3)} over interior ${m.interior.toFixed(3)} is a wireframe`)
        .toBeLessThanOrEqual(m.interior * MAX_RIM_RATIO);
    }
  });
});
