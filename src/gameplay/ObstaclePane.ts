/**
 * OBSTACLE PANE - the dressing that turns a rim into a pane.
 *
 * `GlassMaterial` already answers the optical question: Fresnel, a pixel-constant rim via
 * fwidth(), a bevel, backbuffer refraction, a key-tracking streak and micro-noise. What it
 * cannot answer is the ARCHITECTURAL one. A sheet of glass in a building is never a floating
 * quad: it is carried in a frame, bolted at the corners, divided by mullions, laminated in
 * layers you can see at the border, and it fails from the corners inward. Without those, a
 * bright border around an empty middle reads exactly as what it geometrically is - a
 * selection box - and no amount of extra rim gain fixes that, because the rim is the problem.
 *
 * This module is composed ON TOP of `glassMaterial()`, never instead of it. It adds:
 *
 *   1 metal frame with CORNER BRACKETS   real boxes, so the corner has mass in silhouette
 *   2 mullion grid                       real bars across the face, which give the middle
 *                                        of the pane something to occlude and catch light
 *   3 stress fractures                   seeded polylines spidering in from each corner
 *   4 laminate edge                      the pane is a slab: side walls of real thickness
 *                                        plus the interlayer line showing at the border
 *   5 interference sheen                 thin-film hue shift with view angle, on the face
 *
 * plus the two terms that make the surface read as a SURFACE rather than a wireframe:
 *
 *   6 interior fill                      a faint additive floor across the whole face
 *   7 facet catch                        one broad specular band, sliding with the view
 *
 * Everything geometric is built ONCE per kit and shared by every pane it creates - a pane
 * costs three draw calls (face, frame, fractures) and no per-pane allocation. Every
 * proportion below is a fraction of the pane's own smaller dimension, so a 3 m pane and a
 * 0.8 m pane dress identically instead of one of them wearing a frame sized for the other.
 *
 * Colour is never invented here. Every value comes from the `UniverseTheme` the caller hands
 * in, which is what keeps a universe data rather than code.
 */

import type { Node } from 'three/webgpu';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Uint32BufferAttribute,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  attribute,
  dot,
  float,
  mx_noise_float,
  normalize,
  normalView,
  positionView,
  positionWorld,
  smoothstep,
  uv,
  vec2,
  vec3,
} from 'three/tsl';

import { createRng } from '../battle/Rng';
import type { Rng } from '../battle/types';
import type { Disposable, Seed } from '../core/types';
import type { UniverseTheme } from '../universe/UniverseTheme';
import { glassMaterial } from './GlassMaterial';
import type { GlassFeatures, GlassRole } from './GlassMaterial';

/** Name the dressing group carries, so a gate can prove a pane is dressed without pixels. */
export const DRESSING_NAME = 'obstacle-pane-dressing';

/**
 * How much of the pane the detail costs. This is a BUDGET - a faster GPU wants more bars and
 * more cracks - so the shipped per-tier table belongs in core/Quality.ts and is handed in.
 * These two presets exist so the module is usable, and testable, before that wiring lands.
 */
export interface ObstaclePaneDetail {
  readonly mullionColumns: number;
  readonly mullionRows: number;
  /** 0..4. Cracks spider from this many corners, always in the same corner order. */
  readonly fractureCorners: number;
  readonly branchesPerCorner: number;
  readonly segmentsPerBranch: number;
  /** Distinct crack patterns the kit bakes. Panes cycle them so no two neighbours match. */
  readonly variants: number;
}

export const PANE_DETAIL_FULL: ObstaclePaneDetail = Object.freeze({
  mullionColumns: 3,
  mullionRows: 3,
  fractureCorners: 4,
  branchesPerCorner: 3,
  segmentsPerBranch: 5,
  variants: 4,
});

export const PANE_DETAIL_LEAN: ObstaclePaneDetail = Object.freeze({
  mullionColumns: 2,
  mullionRows: 2,
  fractureCorners: 2,
  branchesPerCorner: 2,
  segmentsPerBranch: 4,
  variants: 2,
});

/** Every colour the dressing can use, all of them derived from the theme by the caller. */
export interface ObstaclePaneStyle {
  readonly tint: Color;
  readonly edge: Color;
  /** The reserved hue. Only a breakable pane may carry it. */
  readonly rim: Color;
  readonly metal: Color;
  /** The bonding layer seen at the border - warmer and darker than the glass around it. */
  readonly interlayer: Color;
}

/**
 * The interlayer is a derived colour rather than an authored one on purpose: a theme that
 * had to author it would be a theme that can get it wrong, and every universe wants the same
 * relationship - the bonding layer is the glass edge, dimmed and pulled toward the tint.
 */
export function paneStyleFromTheme(theme: UniverseTheme): ObstaclePaneStyle {
  return {
    tint: theme.glass.tint,
    edge: theme.glass.edge,
    rim: theme.emissive.primary,
    metal: theme.metal,
    interlayer: new Color().copy(theme.glass.edge).lerp(theme.glass.tint, 0.55).multiplyScalar(0.8),
  };
}

export interface ObstaclePaneOptions {
  readonly width: number;
  readonly height: number;
  /** Real metres of slab. The side walls are built at this depth, so it is visible. */
  readonly thickness: number;
  readonly seed: Seed;
  readonly style: ObstaclePaneStyle;
  readonly detail: ObstaclePaneDetail;
  readonly features: GlassFeatures;
  readonly keyDirection: readonly [number, number, number];
  readonly baseOpacity: number;
  readonly role: GlassRole;
}

/** What the kit actually built. Structural proof, so a gate never has to hunt for pixels. */
export interface PaneInventory {
  readonly seed: number;
  readonly bracketPieces: number;
  readonly railPieces: number;
  readonly mullionBars: number;
  readonly laminateQuads: number;
  readonly frameTriangles: number;
  readonly crackSegments: readonly number[];
  readonly crackTriangles: readonly number[];
  readonly drawCallsPerPane: number;
}

/**
 * Proportions of `min(width, height)`. Architectural, not perceptual: these are what a
 * curtain-wall pane's ironmongery measures relative to the glass it carries.
 */
const PROPORTION = Object.freeze({
  /** Frame rail width. Below ~0.04 the frame stops reading as structure and reads as a line. */
  rail: 0.05,
  /** Bracket arm length. Long enough that the corner is a SHAPE at 60 m, not a dot. */
  bracketArm: 0.19,
  /** Bracket bar width and depth, as multiples of the rail. Deeper than the rail on purpose:
   *  the bracket has to break the frame's silhouette or it is just a thicker rail. */
  bracketWidth: 1.6,
  bracketDepth: 1.5,
  /** The fixing boss at the very corner. A cube, because a cube catches three values of key. */
  boss: 1.9,
  /** Mullion bar width, as a fraction of the rail. */
  mullion: 0.55,
  /** Laminate band on the face, inboard of the rail. */
  laminateBand: 0.028,
  /** Fraction of that band the bright interlayer line occupies. */
  interlayer: 0.34,
  /** Crack half-width at the corner, before taper. */
  crack: 0.006,
});

const CRACK = Object.freeze({
  /** Angular spread around the corner-to-centre direction, radians. */
  spread: 0.62,
  /** Per-segment wander. Higher reads as a lightning bolt, lower as a straight scratch. */
  wander: 0.34,
  /** First segment length as a fraction of min(width, height). */
  firstSegment: 0.15,
  /** Each segment is shorter than the last - energy is spent as the crack runs. */
  shrink: 0.84,
  taper: 0.78,
  forkChance: 0.55,
  forkAngle: 0.85,
  /** Brightness at the corner. Falls to zero at the tip, so the crack fades out rather than
   *  ending in a hard stub that reads as a dash. */
  gain: 0.85,
});

const EMISSION = Object.freeze({
  /** Multiplier on the frame mesh's per-vertex emissive tint. Metal carries zero of it. */
  frame: 1.0,
  /** The glass layers either side of the interlayer, seen edge-on at the border. */
  laminateGlass: 0.3,
  laminateCore: 0.95,
  /** Decorative panes get the same geometry at a fraction of the light: the reserved hue and
   *  the brightness both belong to things you can hit. */
  decorativeScale: 0.3,
});

/**
 * Face terms. These are LEGIBILITY numbers in the same sense as GlassMaterial's: the gate
 * asserts rim <= 6x interior, and an interior that only carries physically-correct
 * transmission cannot reach a sixth of a 1.15-gain rim at any distance.
 */
const FACE = Object.freeze({
  /** Additive floor across the whole face. Faint by design - a sixth of the rim, not a wash. */
  interiorGain: 0.15,
  /** How far in from the border the fill ramps up, in UV. Keeps the fill off the rim itself. */
  interiorRamp: 0.06,
  /** How much of the fill also arrives as opacity, so the face occludes as well as glows. */
  interiorOpacity: 0.34,
  /** One broad facet, not a tight streak: half-width in the diagonal face coordinate. */
  facetHalfWidth: 0.44,
  facetGain: 0.22,
  /** Where the band sits, and how far the view angle slides it across the pane. */
  facetCentre: 0.55,
  facetSlide: 0.35,
  /** Thin film. `cycles` is optical path in half-wavelengths at normal incidence; the 1/cos
   *  term is what makes the hue walk as the pane turns, which is the whole tell. */
  filmCycles: 5.4,
  filmNoiseScale: 3.1,
  filmWobble: 1.7,
  filmGain: 0.07,
  /** Below this the 1/cos term explodes and the sheen aliases into rainbow confetti. */
  filmMinCos: 0.1,
});

/** Zero, not a colour: these vertices are metal and carry no emissive of their own. */
const NO_EMISSION = new Color().multiplyScalar(0);

interface MeshArrays {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

function emptyArrays(): MeshArrays {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] };
}

function geometryFrom(arrays: MeshArrays): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(arrays.positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(arrays.normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(arrays.uvs, 2));
  geometry.setAttribute('color', new Float32BufferAttribute(arrays.colors, 3));
  geometry.setIndex(new Uint32BufferAttribute(arrays.indices, 1));
  return geometry;
}

/** A box part carrying one flat emissive tint. The merge needs every part to agree on its
 *  attribute set, which is why the colour is written even where it is zero. */
function boxPart(
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  tint: Color,
): BufferGeometry {
  const geometry = new BoxGeometry(sx, sy, sz);
  geometry.translate(x, y, z);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** One flat quad in the pane plane, used for the laminate band and every crack segment. */
function pushQuad(
  out: MeshArrays,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  z: number,
  tint: Color,
  intensity: number,
): void {
  const base = out.positions.length / 3;
  const xs = [ax, bx, cx, dx];
  const ys = [ay, by, cy, dy];
  const us = [0, 1, 1, 0];
  const vs = [0, 0, 1, 1];
  for (let i = 0; i < 4; i += 1) {
    out.positions.push(xs[i] ?? 0, ys[i] ?? 0, z);
    out.normals.push(0, 0, 1);
    out.uvs.push(us[i] ?? 0, vs[i] ?? 0);
    out.colors.push(tint.r * intensity, tint.g * intensity, tint.b * intensity);
  }
  out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** An axis-aligned band, as a quad. Used for the four sides of the laminate edge. */
function pushBand(
  out: MeshArrays,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  z: number,
  tint: Color,
  intensity: number,
): void {
  pushQuad(
    out,
    cx - halfW, cy - halfH,
    cx + halfW, cy - halfH,
    cx + halfW, cy + halfH,
    cx - halfW, cy + halfH,
    z,
    tint,
    intensity,
  );
}

/**
 * One crack segment as a tapered quad. Both ends are extended by their own half-width so
 * consecutive segments overlap at the joint - without that, every direction change opens a
 * gap and the crack reads as a dashed line.
 */
function pushCrackSegment(
  out: MeshArrays,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
  z: number,
  tint: Color,
  i0: number,
  i1: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const ex0 = x0 - ux * w0;
  const ey0 = y0 - uy * w0;
  const ex1 = x1 + ux * w1;
  const ey1 = y1 + uy * w1;

  const base = out.positions.length / 3;
  const corners: readonly [number, number, number][] = [
    [ex0 + px * w0, ey0 + py * w0, i0],
    [ex1 + px * w1, ey1 + py * w1, i1],
    [ex1 - px * w1, ey1 - py * w1, i1],
    [ex0 - px * w0, ey0 - py * w0, i0],
  ];
  const us = [0, 1, 1, 0];
  const vs = [0, 0, 1, 1];
  for (let i = 0; i < 4; i += 1) {
    const corner = corners[i];
    if (corner === undefined) continue;
    out.positions.push(corner[0], corner[1], z);
    out.normals.push(0, 0, 1);
    out.uvs.push(us[i] ?? 0, vs[i] ?? 0);
    out.colors.push(tint.r * corner[2], tint.g * corner[2], tint.b * corner[2]);
  }
  out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** The four corners, always visited in this order so `fractureCorners < 4` is deterministic. */
const CORNER_SIGNS: readonly (readonly [number, number])[] = Object.freeze([
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1],
]);

/**
 * Glass fails from a stress riser, and on a framed pane the risers are the corner fixings -
 * which is exactly where this module bolts brackets on. The crack pattern therefore starts
 * where the load does, rather than at a random point that would read as damage from nowhere.
 */
function spiderFromCorner(
  out: MeshArrays,
  rng: Rng,
  startX: number,
  startY: number,
  limitX: number,
  limitY: number,
  unit: number,
  detail: ObstaclePaneDetail,
  tint: Color,
  z: number,
): number {
  let segments = 0;
  const inward = Math.atan2(-startY, -startX);

  for (let branch = 0; branch < detail.branchesPerCorner; branch += 1) {
    let x = startX;
    let y = startY;
    let angle = inward + rng.range(-CRACK.spread, CRACK.spread);
    let length = unit * CRACK.firstSegment * rng.range(0.8, 1.25);
    let width = unit * PROPORTION.crack;

    for (let step = 0; step < detail.segmentsPerBranch; step += 1) {
      const nx = x + Math.cos(angle) * length;
      const ny = y + Math.sin(angle) * length;
      // A crack that reaches the frame stops at the frame. Running one under the rail would
      // put emissive geometry inside opaque metal and read as a z-fighting seam.
      if (Math.abs(nx) > limitX || Math.abs(ny) > limitY) break;

      const from = CRACK.gain * (1 - step / detail.segmentsPerBranch);
      const to = CRACK.gain * (1 - (step + 1) / detail.segmentsPerBranch);
      pushCrackSegment(out, x, y, nx, ny, width, width * CRACK.taper, z, tint, from, to);
      segments += 1;

      // One hairline offshoot part-way along. This is the difference between a spider and a
      // starburst: a starburst is n straight rays from a point, and reads as a decal.
      if (step === 1 && rng.bool(CRACK.forkChance)) {
        const forkAngle = angle + (rng.bool() ? CRACK.forkAngle : -CRACK.forkAngle);
        const fx = nx + Math.cos(forkAngle) * length * 0.7;
        const fy = ny + Math.sin(forkAngle) * length * 0.7;
        if (Math.abs(fx) <= limitX && Math.abs(fy) <= limitY) {
          pushCrackSegment(out, nx, ny, fx, fy, width * 0.7, width * 0.3, z, tint, to, 0);
          segments += 1;
        }
      }

      x = nx;
      y = ny;
      angle += rng.range(-CRACK.wander, CRACK.wander);
      length *= CRACK.shrink;
      width *= CRACK.taper;
    }
  }

  return segments;
}

/**
 * The face material: `glassMaterial()` plus the three terms that make the middle of the pane
 * carry a value. Composed by READING the nodes the glass material set and adding to them, so
 * every optical property it owns keeps working and the tier gate over them still applies.
 */
export function obstaclePaneFaceMaterial(options: ObstaclePaneOptions): MeshStandardNodeMaterial {
  const material = glassMaterial({
    role: options.role,
    tint: options.style.tint,
    edge: options.style.edge,
    rimColour: options.style.rim,
    keyDirection: options.keyDirection,
    features: options.features,
    baseOpacity: options.baseOpacity,
  });

  const breakable = options.role === 'breakable';
  const scale = breakable ? 1 : EMISSION.decorativeScale;

  const centred = uv().sub(vec2(0.5, 0.5)).abs();
  const borderDistance = float(0.5).sub(centred.x.max(centred.y));
  const normal = normalize(normalView);
  const viewDir = normalize(positionView.negate());
  const facing = abs(dot(normal, viewDir)).clamp(0, 1);

  // ---- 6. interior fill ---------------------------------------------------------------
  // Additive, and deliberately flat: a gradient here reads as a vignette on the pane, and
  // the thing being fixed is that the interior has NO value at all, not that it has a boring
  // one. The mullions, cracks and facet band supply the variation on top of it.
  const inside = smoothstep(float(0), float(FACE.interiorRamp), borderDistance);
  const fillColour = vec3(options.style.edge.r, options.style.edge.g, options.style.edge.b)
    .mul(float(0.5))
    .add(vec3(options.style.rim.r, options.style.rim.g, options.style.rim.b).mul(float(0.5)));
  const fill = inside.mul(float(FACE.interiorGain * scale));

  // ---- 7. facet catch -----------------------------------------------------------------
  // One broad band along the diagonal, whose centre slides with the view direction. Broad is
  // the point: a tight lobe is the streak GlassMaterial already has, and a second tight lobe
  // would just be a brighter rim. This one is wide enough to be a facet of a real surface.
  const diagonal = uv().x.mul(float(0.62)).add(uv().y.mul(float(0.78)));
  const key = normalize(vec3(...options.keyDirection));
  const centre = float(FACE.facetCentre).add(dot(normal, key).mul(float(FACE.facetSlide)));
  const facet = smoothstep(float(FACE.facetHalfWidth), float(0), diagonal.sub(centre).abs())
    .mul(facing.mul(float(0.55)).add(float(0.45)))
    .mul(inside)
    .mul(float(FACE.facetGain * scale));

  // ---- 5. interference sheen ----------------------------------------------------------
  // Thin-film: the optical path through a film of fixed thickness grows as 1/cos(theta), so
  // the interference order - and therefore the hue - walks as the pane turns away from you.
  // The noise term stands in for thickness variation across a real laminate; without it the
  // whole pane shifts hue as one flat card, which is the opposite of the effect.
  const cosTheta = facing.max(float(FACE.filmMinCos));
  const wobble = mx_noise_float(positionWorld.mul(float(FACE.filmNoiseScale))).mul(
    float(FACE.filmWobble),
  );
  const phase = float(FACE.filmCycles).div(cosTheta).add(wobble);
  const sheen = vec3(
    phase.cos(),
    phase.add(float(2.0944)).cos(),
    phase.add(float(4.1888)).cos(),
  )
    .mul(float(0.5))
    .add(float(0.5))
    .mul(float(FACE.filmGain * scale))
    .mul(inside);

  const added: Node<'vec3'> = fillColour.mul(fill).add(fillColour.mul(facet)).add(sheen);
  const baseEmissive = material.emissiveNode as Node<'vec3'> | null;
  material.emissiveNode = baseEmissive === null ? added : baseEmissive.add(added);

  // A decorative pane is opaque by contract in GlassMaterial - adding opacity there would
  // either be a no-op or would quietly undo that decision.
  if (breakable) {
    const baseOpacity = material.opacityNode as Node<'float'> | null;
    const extra = fill.mul(float(FACE.interiorOpacity));
    material.opacityNode = baseOpacity === null ? extra : baseOpacity.add(extra).clamp(0, 1);
  }

  return material;
}

/**
 * Shared geometry, shared materials, one pane's worth of dressing per call.
 *
 * A kit is built once per (theme, role, detail) and every pane on the field reuses it. The
 * crack variants are the only per-pane variation, and they are picked by index rather than
 * drawn at spawn time, so spawning stays allocation-free.
 */
export class ObstaclePaneKit implements Disposable {
  readonly faceMaterial: MeshStandardNodeMaterial;
  readonly inventory: PaneInventory;

  private readonly faceGeometry: PlaneGeometry;
  private readonly frameGeometry: BufferGeometry;
  private readonly crackGeometries: readonly BufferGeometry[];
  private readonly frameMaterial: MeshStandardNodeMaterial;
  private readonly crackMaterial: MeshBasicNodeMaterial;
  private readonly variants: number;

  constructor(options: ObstaclePaneOptions) {
    const { width: w, height: h, thickness, detail, style } = options;
    const breakable = options.role === 'breakable';
    const scale = breakable ? 1 : EMISSION.decorativeScale;
    const unit = Math.min(w, h);

    this.faceMaterial = obstaclePaneFaceMaterial(options);
    this.faceGeometry = new PlaneGeometry(w, h);
    this.variants = Math.max(1, Math.round(detail.variants));

    const rail = unit * PROPORTION.rail;
    const frameDepth = Math.max(thickness * 3, unit * 0.012);
    const halfW = w / 2;
    const halfH = h / 2;
    const glassLimitX = halfW - rail;
    const glassLimitY = halfH - rail;
    const faceZ = thickness / 2;

    const parts: BufferGeometry[] = [];
    let railPieces = 0;
    let bracketPieces = 0;
    let mullionBars = 0;

    // ---- 1a. frame rails ---------------------------------------------------------------
    parts.push(boxPart(w, rail, frameDepth, 0, halfH - rail / 2, 0, NO_EMISSION));
    parts.push(boxPart(w, rail, frameDepth, 0, -halfH + rail / 2, 0, NO_EMISSION));
    parts.push(boxPart(rail, h - rail * 2, frameDepth, -halfW + rail / 2, 0, 0, NO_EMISSION));
    parts.push(boxPart(rail, h - rail * 2, frameDepth, halfW - rail / 2, 0, 0, NO_EMISSION));
    railPieces += 4;

    // ---- 1b. corner brackets -----------------------------------------------------------
    // Three pieces per corner: two arms and the fixing boss. The boss is deeper than both
    // arms, so a corner still reads as a corner when the pane is edge-on and the arms have
    // collapsed to a line.
    const arm = unit * PROPORTION.bracketArm;
    const barW = rail * PROPORTION.bracketWidth;
    const barD = frameDepth * PROPORTION.bracketDepth;
    const boss = rail * PROPORTION.boss;
    for (const signs of CORNER_SIGNS) {
      const sx = signs[0];
      const sy = signs[1];
      const cx = sx * (halfW - barW / 2);
      const cy = sy * (halfH - barW / 2);
      parts.push(boxPart(arm, barW, barD, sx * (halfW - arm / 2), cy, 0, NO_EMISSION));
      parts.push(boxPart(barW, arm, barD, cx, sy * (halfH - arm / 2), 0, NO_EMISSION));
      parts.push(boxPart(boss, boss, barD * 1.25, cx, cy, 0, NO_EMISSION));
      bracketPieces += 3;
    }

    // ---- 2. mullion grid ---------------------------------------------------------------
    // Real bars, not a stroke: they occlude the face, they take a different value of key on
    // each side, and they give the middle of the pane a scale to be read against.
    const mullionW = rail * PROPORTION.mullion;
    const mullionD = Math.max(thickness * 1.6, mullionW * 0.6);
    for (let c = 1; c < detail.mullionColumns; c += 1) {
      const x = (c / detail.mullionColumns - 0.5) * (w - rail * 2);
      parts.push(boxPart(mullionW, h - rail * 2, mullionD, x, 0, 0, NO_EMISSION));
      mullionBars += 1;
    }
    for (let r = 1; r < detail.mullionRows; r += 1) {
      const y = (r / detail.mullionRows - 0.5) * (h - rail * 2);
      parts.push(boxPart(w - rail * 2, mullionW, mullionD, 0, y, 0, NO_EMISSION));
      mullionBars += 1;
    }

    // ---- 4. laminate edge --------------------------------------------------------------
    // Two halves of one feature. The side walls give the pane genuine thickness - at any
    // angle off dead-on you see the slab, not a card. The face band is what survives at dead
    // on, which is the angle this game is always played at: glass, interlayer, glass.
    const laminate = emptyArrays();
    const bandTotal = unit * PROPORTION.laminateBand;
    const core = bandTotal * PROPORTION.interlayer;
    const skin = (bandTotal - core) / 2;
    let laminateQuads = 0;

    const stack: readonly (readonly [number, Color, number])[] = [
      [skin, style.tint, EMISSION.laminateGlass * scale],
      [core, style.interlayer, EMISSION.laminateCore * scale],
      [skin, style.tint, EMISSION.laminateGlass * scale],
    ];

    // Face band, inboard of the rail, on both faces of the slab.
    for (const faceSign of [1, -1] as const) {
      let offset = 0;
      for (const layer of stack) {
        const thick = layer[0];
        const mid = offset + thick / 2;
        offset += thick;
        const bandZ = faceSign * (faceZ + unit * 0.0004);
        const innerX = glassLimitX - mid;
        const innerY = glassLimitY - mid;
        pushBand(laminate, 0, innerY, innerX, thick / 2, bandZ, layer[1], layer[2]);
        pushBand(laminate, 0, -innerY, innerX, thick / 2, bandZ, layer[1], layer[2]);
        pushBand(laminate, -innerX, 0, thick / 2, innerY, bandZ, layer[1], layer[2]);
        pushBand(laminate, innerX, 0, thick / 2, innerY, bandZ, layer[1], layer[2]);
        laminateQuads += 4;
      }
    }
    if (laminate.positions.length > 0) parts.push(geometryFrom(laminate));

    // Side walls: the slab's own edge, three layers deep, sitting under the rail so it shows
    // in the gap between frame and glass and at every grazing angle.
    let wallOffset = -thickness / 2;
    for (const layer of stack) {
      const thick = layer[0] * (thickness / bandTotal) * 3;
      const mid = wallOffset + thick / 2;
      wallOffset += thick;
      const inset = rail * 0.35;
      parts.push(boxPart(w - inset, inset, thick, 0, halfH - rail - inset / 2, mid, layer[1]));
      parts.push(boxPart(w - inset, inset, thick, 0, -halfH + rail + inset / 2, mid, layer[1]));
      parts.push(boxPart(inset, h - rail * 2, thick, -halfW + rail + inset / 2, 0, mid, layer[1]));
      parts.push(boxPart(inset, h - rail * 2, thick, halfW - rail - inset / 2, 0, mid, layer[1]));
      laminateQuads += 4;
    }

    const merged: BufferGeometry | null = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (merged === null) {
      throw new Error('gameplay/ObstaclePane.ts: frame parts disagree on their attributes');
    }
    this.frameGeometry = merged;

    // ---- 3. stress fractures -----------------------------------------------------------
    // One RNG, seeded from the pane's own seed: a seed reproduces a pane exactly, which is
    // what makes a capture comparable between two runs and what keeps Math.random out.
    const rng = createRng(options.seed);
    const crackGeometries: BufferGeometry[] = [];
    const crackSegments: number[] = [];
    const crackTriangles: number[] = [];
    const crackZ = faceZ + unit * 0.0012;
    const corners = Math.max(0, Math.min(4, Math.round(detail.fractureCorners)));

    for (let variant = 0; variant < this.variants; variant += 1) {
      const arrays = emptyArrays();
      let segments = 0;
      for (let c = 0; c < corners; c += 1) {
        const signs = CORNER_SIGNS[c];
        if (signs === undefined) continue;
        segments += spiderFromCorner(
          arrays,
          rng,
          signs[0] * (glassLimitX - rail * 0.2),
          signs[1] * (glassLimitY - rail * 0.2),
          glassLimitX,
          glassLimitY,
          unit,
          detail,
          style.edge,
          crackZ,
        );
      }
      crackGeometries.push(geometryFrom(arrays));
      crackSegments.push(segments);
      crackTriangles.push(arrays.indices.length / 3);
    }
    this.crackGeometries = crackGeometries;

    // Emissive tint rides on the vertex colour, so metal, glass skin and interlayer share one
    // draw call and still return three different values. The albedo stays the theme's metal:
    // the laminate parts are emissive-dominated, so their albedo never gets a vote.
    this.frameMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(style.metal),
      roughness: 0.38,
      metalness: 0.9,
    });
    this.frameMaterial.emissiveNode = attribute<'vec3'>('color', 'vec3').mul(float(EMISSION.frame));

    // Additive and unlit: a crack is light leaking along a fracture surface, and per-vertex
    // intensity is what tapers it to nothing at the tip instead of ending in a stub.
    this.crackMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.crackMaterial.colorNode = attribute<'vec3'>('color', 'vec3');

    this.inventory = Object.freeze({
      seed: options.seed,
      bracketPieces,
      railPieces,
      mullionBars,
      laminateQuads,
      frameTriangles: (merged.getIndex()?.count ?? 0) / 3,
      crackSegments: Object.freeze(crackSegments),
      crackTriangles: Object.freeze(crackTriangles),
      drawCallsPerPane: 3,
    });
  }

  /**
   * The dressing alone, ready to be added as a child of an existing pane mesh. Returned as a
   * Group so the caller can hide the whole thing with one flag when a pane is pooled out.
   */
  createDressing(variant = 0): Group {
    const group = new Group();
    group.name = DRESSING_NAME;

    const frame = new Mesh(this.frameGeometry, this.frameMaterial);
    frame.name = `${DRESSING_NAME}-frame`;
    group.add(frame);

    const index = ((variant % this.variants) + this.variants) % this.variants;
    const crackGeometry = this.crackGeometries[index];
    if (crackGeometry !== undefined) {
      const cracks = new Mesh(crackGeometry, this.crackMaterial);
      cracks.name = `${DRESSING_NAME}-fractures`;
      // Additive glass detail has to land AFTER the transparent face or it is composited
      // under it and the taper disappears into the pane's own opacity.
      cracks.renderOrder = 2;
      group.add(cracks);
    }
    return group;
  }

  /** A complete standalone pane - face plus dressing. Used by tooling and by the gate. */
  createPane(variant = 0): Mesh {
    const face = new Mesh(this.faceGeometry, this.faceMaterial);
    face.name = 'obstacle-pane';
    face.add(this.createDressing(variant));
    return face;
  }

  dispose(): void {
    this.faceGeometry.dispose();
    this.frameGeometry.dispose();
    for (const geometry of this.crackGeometries) geometry.dispose();
    this.faceMaterial.dispose();
    this.frameMaterial.dispose();
    this.crackMaterial.dispose();
  }
}

/** Every feature this module adds, in the order the header describes them. */
export const OBSTACLE_PANE_FEATURES: readonly string[] = Object.freeze([
  'metal frame with corner brackets',
  'mullion grid',
  'seeded stress fractures',
  'laminate edge',
  'interference sheen',
  'interior fill',
  'facet catch',
]);
