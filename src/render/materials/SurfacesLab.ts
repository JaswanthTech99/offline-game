/**
 * A/B BENCH for src/render/materials/Surfaces.ts.
 *
 * WHY THIS EXISTS AND WHY IT IS IN src/
 * The surface factories cannot be wired into Playfield by the agent that wrote them —
 * Playfield is a shared file and six other agents are editing around it — so the only way
 * to PROVE the claim "these materials put more distinct luminance levels in every region of
 * the frame" is to render the same corridor twice, once with today's materials and once
 * with the new ones, and measure both. That needs a renderer, a scene and the theme
 * records, i.e. engine code, and e2e is forbidden from importing engine code. So the bench
 * lives here and the gate drives it over a URL.
 *
 * NOTHING IN THE APP IMPORTS THIS FILE. It is therefore absent from the production bundle —
 * Rollup only walks the graph rooted at index.html — while the dev server still serves it on
 * demand, which is all the gate needs.
 *
 * It deliberately does NOT import Playfield. The bench has to be able to build the BASELINE
 * materials as they exist today, side by side with the new ones, in one process; importing
 * the real corridor would give it exactly one of the two.
 *
 * ONE-rAF RULE: this renders exactly once per call, synchronously, from the caller's await.
 * There is no loop here and there must never be one.
 */

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Euler,
  Fog,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import type { Material } from 'three/webgpu';

import { createRng } from '../../battle/Rng';
import { asSeed } from '../../core/types';
import { getTheme } from '../../universe/registry';
import type { UniverseId, UniverseTheme } from '../../universe/UniverseTheme';
import type { ContactGeometry, StripGrid, SurfaceFeatures, SurfaceSky } from './Surfaces';
import { SURFACES_ALL, anisotropicMetal, reflectiveFloor, wallSurface } from './Surfaces';

/** Mirrors the corridor half of Playfield's TUNING. Copied, not imported: Playfield is shared. */
const SHELL = Object.freeze({
  halfWidth: 5,
  halfHeight: 3.4,
  ringSpacing: 10.5,
  rings: 10,
  panesPerFace: 5,
  fovDeg: 68,
  nearM: 0.08,
  farMarginM: 12,
});

export type LabVariant = 'baseline' | 'surfaces';

export interface LabOptions {
  readonly variant: LabVariant;
  readonly universe?: UniverseId;
  readonly seed?: number;
  readonly forceWebGL?: boolean;
  /** Drop terms, to measure what a lower tier actually loses. Defaults to everything on. */
  readonly features?: SurfaceFeatures;
}

interface Mounted {
  readonly renderer: WebGPURenderer;
  readonly canvas: HTMLCanvasElement;
  readonly geometries: BufferGeometry[];
  readonly materials: Material[];
}

let mounted: Mounted | null = null;

/** The strip grid, derived from the same numbers that place the strip instances below. */
function stripGrid(theme: UniverseTheme): StripGrid {
  const paneW = (SHELL.halfWidth * 2) / SHELL.panesPerFace;
  return {
    y: SHELL.halfHeight - 0.15,
    // Strips sit in every other bay, so they repeat at twice the bay width.
    pitchX: paneW * 2,
    phaseX: paneW,
    halfWidthX: paneW * 0.1,
    pitchZ: SHELL.ringSpacing,
    phaseZ: -SHELL.ringSpacing / 2,
    halfLengthZ: SHELL.ringSpacing * 0.34,
    colour: new Color().copy(theme.metal).multiplyScalar(0.42),
  };
}

function skyOf(theme: UniverseTheme): SurfaceSky {
  return { top: theme.sky.top, horizon: theme.sky.horizon, low: theme.sky.low };
}

const CONTACT: ContactGeometry = Object.freeze({
  floorY: -SHELL.halfHeight,
  wallX: SHELL.halfWidth,
});

/** Playfield's wallBand() ramp, reproduced exactly so the A/B changes materials and nothing else. */
function bandColour(theme: UniverseTheme, band: number): Color {
  const factor = 1 - (band / 8) * 0.42;
  const tint = new Color().copy(theme.stone).multiplyScalar(0.92 * factor + 0.66);
  const hazed = new Color().copy(theme.haze.color).multiplyScalar(0.06);
  tint.lerp(hazed, (band / 8) * 0.65);
  return tint;
}

function bandRoughness(band: number): number {
  return 0.72 + (band / 8) * 0.22;
}

interface Palette {
  readonly plate: MeshStandardNodeMaterial;
  readonly ringMullion: MeshStandardNodeMaterial;
  readonly postMullion: MeshStandardNodeMaterial;
  readonly walls: readonly MeshStandardNodeMaterial[];
  readonly strip: MeshBasicNodeMaterial;
  readonly seam: MeshBasicNodeMaterial;
}

/** Today's Playfield materials, verbatim. This is the thing the new ones have to beat. */
function baselinePalette(theme: UniverseTheme, strips: StripGrid): Palette {
  const mullion = new MeshStandardNodeMaterial({
    color: new Color().copy(theme.metal).multiplyScalar(0.62),
    roughness: 0.42,
    metalness: 0.95,
  });
  return {
    plate: new MeshStandardNodeMaterial({
      color: new Color().copy(theme.stone).multiplyScalar(1.28),
      roughness: 0.62,
      metalness: 0.3,
    }),
    ringMullion: mullion,
    postMullion: mullion,
    walls: Array.from({ length: 8 }, (_, band) =>
      new MeshStandardNodeMaterial({
        color: bandColour(theme, band),
        roughness: bandRoughness(band),
        metalness: 0.06,
      }),
    ),
    strip: new MeshBasicNodeMaterial({ color: new Color().copy(strips.colour) }),
    seam: new MeshBasicNodeMaterial({
      color: new Color().copy(theme.metal).multiplyScalar(0.66),
      transparent: true,
      opacity: 0.7,
    }),
  };
}

function surfacesPalette(
  theme: UniverseTheme,
  strips: StripGrid,
  features: SurfaceFeatures,
): Palette {
  const sky = skyOf(theme);
  const contact = { geometry: CONTACT };
  const metalColour = new Color().copy(theme.metal).multiplyScalar(0.62);
  // Two grains, not one: the ring bars run across the corridor and the pilasters run up it,
  // and a brushed highlight that ignores which way the bar points reads as a decal. This
  // costs no extra draw call - each family is already its own InstancedMesh.
  const brushed = (brushDirection: readonly [number, number, number]): MeshStandardNodeMaterial =>
    anisotropicMetal({
      colour: metalColour,
      sky,
      keyDirection: [0.15, 0.35, 1],
      brushDirection,
      roughness: 0.42,
      features,
      contact,
    });

  return {
    plate: reflectiveFloor({
      colour: new Color().copy(theme.stone).multiplyScalar(1.28),
      sky,
      strips,
      // Lower than the baseline 0.62 on purpose: a plate that reflects is a plate that is
      // smooth, and the reflection term is only honest if the specular agrees with it.
      roughness: 0.52,
      // Matches the baseline plate. See the note on ReflectiveFloorOptions.metalness.
      metalness: 0.3,
      features,
      contact,
    }),
    ringMullion: brushed([1, 0, 0]),
    postMullion: brushed([0, 1, 0]),
    walls: Array.from({ length: 8 }, (_, band) =>
      wallSurface({
        colour: bandColour(theme, band),
        sky,
        roughness: bandRoughness(band),
        features,
        contact,
      }),
    ),
    strip: new MeshBasicNodeMaterial({ color: new Color().copy(strips.colour) }),
    seam: new MeshBasicNodeMaterial({
      color: new Color().copy(theme.metal).multiplyScalar(0.66),
      transparent: true,
      opacity: 0.7,
    }),
  };
}

/**
 * Builds one corridor. Geometry, instance placement, lights and fog are identical between
 * the two variants and are driven by the same seeded stream, so the ONLY difference between
 * the two frames the gate compares is which palette was handed in.
 */
function buildCorridor(
  theme: UniverseTheme,
  palette: Palette,
  seed: number,
  geometries: BufferGeometry[],
): { scene: Scene; camera: PerspectiveCamera } {
  const rng = createRng(asSeed(seed));
  const hw = SHELL.halfWidth;
  const hh = SHELL.halfHeight;
  const spacing = SHELL.ringSpacing;
  const n = SHELL.panesPerFace;
  const paneW = (hw * 2) / n;
  const paneH = (hh * 2) / n;

  const plateGeom = new PlaneGeometry(paneW * 0.94, spacing * 0.9);
  const wallGeom = new PlaneGeometry(spacing * 0.9, paneH * 0.94);
  const mullionRing = new BoxGeometry(hw * 2 + 0.2, 0.1, 0.1);
  const mullionPost = new BoxGeometry(0.1, hh * 2, 0.1);
  const subMullion = new BoxGeometry(0.05, paneH * 0.9, 0.05);
  const stripGeom = new BoxGeometry(paneW * 0.2, 0.04, spacing * 0.68);
  const seamGeom = new BoxGeometry(0.05, 0.04, spacing * 0.88);
  const cofferGeom = new BoxGeometry(paneW * 0.82, 0.14, spacing * 0.72);
  const bandGeom = new BoxGeometry(0.12, 0.34, spacing * 0.5);
  geometries.push(
    plateGeom, wallGeom, mullionRing, mullionPost, subMullion,
    stripGeom, seamGeom, cofferGeom, bandGeom,
  );

  const plates: Matrix4[] = [];
  const wallsByBand = new Map<number, Matrix4[]>();
  const rings: Matrix4[] = [];
  const pilasters: Matrix4[] = [];
  const subs: Matrix4[] = [];
  const strips: Matrix4[] = [];
  const seams: Matrix4[] = [];
  const coffers: Matrix4[] = [];
  const bands: Matrix4[] = [];

  const m = new Matrix4();
  const q = new Quaternion();
  const e = new Euler();
  const pos = new Vector3();
  const one = new Vector3(1, 1, 1);
  const make = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Matrix4 => {
    e.set(rx, ry, rz);
    q.setFromEuler(e);
    pos.set(x, y, z);
    return m.compose(pos, q, one).clone();
  };
  const push = (into: Matrix4[], x: number, y: number, z: number): void => {
    into.push(make(x, y, z));
  };

  for (let r = 0; r < SHELL.rings; r++) {
    const z = -r * spacing - spacing / 2;
    const band = Math.min(7, Math.floor((r / SHELL.rings) * 8));

    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * paneW;
      if (rng.next() > 0.06) plates.push(make(x, -hh, z, -Math.PI / 2));
      if (rng.next() > 0.06) plates.push(make(x, hh, z, Math.PI / 2));
      if (i % 2 === 1) {
        push(coffers, x, hh - 0.07, z);
        push(strips, x, hh - 0.15, z);
      }
    }

    for (let side = -1; side <= 1; side += 2) {
      for (let j = 0; j < n; j++) {
        const y = (j - (n - 1) / 2) * paneH;
        if (rng.next() < 0.05) continue;
        const tilt = (rng.next() - 0.5) * 0.05;
        const list = wallsByBand.get(band) ?? [];
        list.push(make(hw * side, y, z, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2, tilt));
        wallsByBand.set(band, list);
        push(subs, hw * side * 0.99, y, z);
      }
      push(pilasters, hw * side * 0.98, 0, z - spacing / 2);
      push(seams, hw * side * 0.9, -hh + 0.03, z);
      push(bands, hw * side * 0.97, hh * 0.62, z);
    }

    for (const y of [hh, -hh]) push(rings, 0, y, z - spacing / 2);
  }

  const scene = new Scene();
  const shell = new Group();
  const mount = (geom: BufferGeometry, mat: Material, list: readonly Matrix4[]): void => {
    if (list.length === 0) return;
    const mesh = new InstancedMesh(geom, mat, list.length);
    for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i] as Matrix4);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    shell.add(mesh);
  };

  mount(plateGeom, palette.plate, plates);
  mount(mullionRing, palette.ringMullion, rings);
  mount(mullionPost, palette.postMullion, pilasters);
  mount(subMullion, palette.postMullion, subs);
  mount(cofferGeom, palette.ringMullion, coffers);
  mount(bandGeom, palette.postMullion, bands);
  mount(stripGeom, palette.strip, strips);
  mount(seamGeom, palette.seam, seams);
  for (const [band, list] of wallsByBand) {
    mount(wallGeom, palette.walls[band] ?? palette.walls[0] as MeshStandardNodeMaterial, list);
  }
  scene.add(shell);

  // Playfield's four light contributions, minus the crystal-layer key, which lights nothing
  // architectural and would only add a term the A/B cannot attribute.
  const key = new PointLight(new Color(0.72, 0.84, 1.0), 13, 48, 2.0);
  key.position.set(0, 0.8, -22);
  scene.add(key);
  const bounce = new PointLight(new Color(1.0, 0.86, 0.68), 9, 34, 1.5);
  bounce.position.set(0, -hh + 1.6, -11);
  scene.add(bounce);
  const fill = new PointLight(new Color(0.8, 0.86, 0.96), 7.0, 64, 1.5);
  fill.position.set(0, 1.2, -3);
  scene.add(fill);

  const depth = SHELL.rings * spacing;
  scene.fog = new Fog(new Color().copy(theme.sky.low).multiplyScalar(0.45), depth * 0.12, depth * 0.95);
  scene.background = new Color().copy(theme.sky.low).multiplyScalar(0.35);

  const camera = new PerspectiveCamera(
    SHELL.fovDeg,
    1,
    SHELL.nearM,
    depth + SHELL.farMarginM,
  );
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  scene.add(camera);

  return { scene, camera };
}

/** Tears down whatever the previous call mounted. Idempotent, like every dispose here. */
export function disposeSurfaceLab(): void {
  if (mounted === null) return;
  for (const g of mounted.geometries) g.dispose();
  for (const mat of mounted.materials) mat.dispose();
  mounted.renderer.dispose();
  mounted.canvas.remove();
  mounted = null;
}

/**
 * Mounts an opaque full-viewport canvas over whatever is on screen and renders ONE frame of
 * the corridor with the requested palette. Resolves after the frame has been submitted, so
 * the caller may screenshot immediately.
 */
export async function mountSurfaceLab(options: LabOptions): Promise<void> {
  disposeSurfaceLab();

  const theme = getTheme(options.universe ?? 'void-cathedral');
  const strips = stripGrid(theme);
  const features = options.features ?? SURFACES_ALL;
  const palette =
    options.variant === 'baseline'
      ? baselinePalette(theme, strips)
      : surfacesPalette(theme, strips, features);

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;display:block';
  document.body.appendChild(canvas);

  const renderer = new WebGPURenderer({
    canvas,
    antialias: false,
    alpha: false,
    depth: true,
    stencil: false,
    forceWebGL: options.forceWebGL ?? true,
  });
  await renderer.init();

  const geometries: BufferGeometry[] = [];
  const { scene, camera } = buildCorridor(theme, palette, options.seed ?? 20260902, geometries);

  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h, false);

  const materials: Material[] = [
    palette.plate, palette.ringMullion, palette.postMullion, palette.strip, palette.seam,
    ...palette.walls,
  ];
  mounted = { renderer, canvas, geometries, materials };

  renderer.render(scene, camera);
}
