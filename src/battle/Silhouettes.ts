/**
 * THE SILHOUETTE REGISTRY.
 *
 * Every combatant on the battle backdrop is a flat, near-black, alpha-cut shape. There is no
 * skinning, no rig, no model file and no face - the entire cast is generated here from 2D
 * paths at load time and packed into a single alpha atlas so that a whole tier of figures
 * costs one draw call.
 *
 * THE 40-PIXEL TEST is the law this file exists to enforce. A silhouette that cannot be told
 * apart from the rest of the cast when it is 40 pixels tall and filled with pure black has
 * failed, because that is exactly how the player sees it: small, dark, behind haze, for a
 * fraction of a second. "Identifiable" is therefore modelled as four measurable properties -
 * enough ink to register, the declared number of parts, an articulated outline, and low
 * overlap with every other figure in the registry - and `validateSilhouettes()` measures all
 * four on real rasterisations rather than trusting the author's eye.
 *
 * The pose a figure is authored in is its place in a COMPOSED TABLEAU: the cast is drawn
 * mid-blow, arranged so the whole backdrop reads as one picture. Beat keyframes deviate from
 * that pose; they never define it. This is why `battleAnimationScale = 0` (reduced motion)
 * leaves a war frozen at the height of its action instead of an arbitrary rest frame.
 *
 * IP: every shape is a generic archetype - mass, stance and gait only. Nothing here is, or
 * may become, a reference to any existing character, costume, insignia or trade dress.
 */

import type { ParallaxTier, SilhouetteId } from './types';

/** A point in the authoring space: x right, y UP. Units are arbitrary and normalised away. */
export interface Pt {
  readonly x: number;
  readonly y: number;
}

/**
 * One closed polygon. Rings are UNIONED, never subtracted: a silhouette is a single mass of
 * ink, so overlapping a limb onto a torso must fill, not punch a hole. That rules out the
 * usual even-odd fill across the whole figure and is why the rasteriser ORs ring by ring.
 */
export type Ring = readonly Pt[];

/** Where the figure stands in the composed tableau. Beat deviations are added on top. */
export interface TableauPose {
  /** Radians of hold-lean, baked into the base pose. Not an animation channel. */
  readonly lean: number;
  /** Lift above the roster anchor, in fractions of the figure's own height. */
  readonly rise: number;
  /** Multiplier on the roster's size box. Lets one roster entry stage a giant and a scout. */
  readonly scale: number;
  /**
   * How far the figure is pushed past the aperture edge, in fractions of its own size.
   * Deliberate: an uncropped body reads as a toy on a shelf, a cropped one reads as enormous.
   */
  readonly crop: number;
}

export interface SilhouetteDef {
  readonly id: SilhouetteId;
  /** Normalised into the unit box [0,1]x[0,1], y up. */
  readonly rings: readonly Ring[];
  /** Natural width/height before normalisation. The layer fits this box, never stretches it. */
  readonly aspect: number;
  /**
   * Radians, 0 = +x. The direction the blow travels. The ONLY illumination a silhouette gets
   * is a thin rim on this side, so it doubles as the figure's read of where the light is.
   */
  readonly leadingAngle: number;
  readonly tableau: TableauPose;
  /** Tiers this shape is allowed to be staged on. */
  readonly tiers: readonly ParallaxTier[];
  /** Connected components expected at 40px. Everything is 1 except a deliberate swarm. */
  readonly parts: number;
}

/**
 * Silhouette design laws and the atlas they are baked into. These are legibility rules and a
 * fixed load-time artefact, NOT per-tier performance budgets - the tier budget for this layer
 * is `QualityBudget.battleInstanceCaps`, which lives in core/Quality.ts where it belongs. The
 * same split is already used by `battle/types.ts` (dramaturgy laws) and `universe/LightBus.ts`
 * (semantic channel domains).
 */
export const SILHOUETTE_LAWS = Object.freeze({
  /** The test size. A figure is judged at the size the player actually resolves it at. */
  legibilityPx: 40,
  /** Below this the shape is a wisp and vanishes into haze. */
  minInkRatio: 0.06,
  /** Above this the shape is a blob and every figure reads the same. */
  maxInkRatio: 0.68,
  /** Sign changes in the column-height profile. A rectangle scores 0 and must fail. */
  minProfileFeatures: 3,
  /**
   * Pixels below which a connected blob is fringe, not a part. A sharp tip whose coverage
   * only just crosses the binary threshold shows up as a lone pixel here but never reaches
   * the player: the shader ramps alpha rather than thresholding it, and haze eats the rest.
   */
  minPartPx: 3,
  /** Two figures overlapping more than this are the same figure to the player. */
  maxPairwiseIou: 0.62,
  /** Square atlas cell. One fixed 512x512 R8 texture for the whole cast, on every tier. */
  cellPx: 128,
  /** Transparent margin inside each cell. Must exceed the rim offset AND the mip blur reach. */
  gutterPx: 12,
  /** Rasteriser subsamples per axis. 3 gives clean diagonals without a distance transform. */
  supersample: 3,
  atlasColumns: 4,
} as const);

const TAU = Math.PI * 2;

/** Rings are stored normalised, so this is every figure's sampling box. */
const UNIT_BOX: Bounds = Object.freeze({ minX: 0, minY: 0, maxX: 1, maxY: 1 });

const pt = (x: number, y: number): Pt => ({ x, y });

/** Convex quad, wound consistently by the caller. */
const quad = (a: Pt, b: Pt, c: Pt, d: Pt): Ring => [a, b, c, d];

const tri = (a: Pt, b: Pt, c: Pt): Ring => [a, b, c];

/** Rotated ellipse. The workhorse for heads, torsos, shields and mounts. */
function plate(cx: number, cy: number, rx: number, ry: number, rot = 0, segs = 14): Ring {
  const out: Pt[] = [];
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU;
    const px = Math.cos(a) * rx;
    const py = Math.sin(a) * ry;
    out.push(pt(cx + px * cr - py * sr, cy + px * sr + py * cr));
  }
  return out;
}

/**
 * A bowed, tapered strip: the single primitive every limb, weapon shaft, neck, tail and
 * banner pole is built from. `bow` displaces the spine's control point along its normal, so
 * one call produces a straight lance or a curved tusk without a second code path.
 */
function limb(a: Pt, b: Pt, bow: number, wA: number, wB: number, segs = 8): Ring {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const cx = (a.x + b.x) * 0.5 + nx * bow;
  const cy = (a.y + b.y) * 0.5 + ny * bow;

  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const u = 1 - t;
    const sx = u * u * a.x + 2 * u * t * cx + t * t * b.x;
    const sy = u * u * a.y + 2 * u * t * cy + t * t * b.y;
    // Bezier derivative, not a finite difference: the endpoints need an exact tangent or the
    // strip pinches at the tip, which at 40px looks like a broken limb.
    const tx = 2 * u * (cx - a.x) + 2 * t * (b.x - cx);
    const ty = 2 * u * (cy - a.y) + 2 * t * (b.y - cy);
    const tl = Math.sqrt(tx * tx + ty * ty) || 1;
    const px = -ty / tl;
    const py = tx / tl;
    const hw = (wA + (wB - wA) * t) * 0.5;
    left.push(pt(sx + px * hw, sy + py * hw));
    right.push(pt(sx - px * hw, sy - py * hw));
  }
  right.reverse();
  return [...left, ...right];
}

/**
 * A blunt solid arrowhead. Built as ONE concave ring rather than two limbs meeting at a
 * point, because a limb join is the first thing to snap when the figure is rasterised at
 * 40px and a swarm that shatters into twice as many specks stops reading as a formation.
 */
function chevron(cx: number, cy: number, span: number, sweep: number, rot: number): Ring {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const at = (x: number, y: number): Pt => pt(cx + x * c - y * s, cy + x * s + y * c);
  return [
    at(span * 0.5, 0),
    at(-span * 0.5, sweep),
    at(-span * 0.32, sweep * 0.68),
    at(-span * 0.2, 0),
    at(-span * 0.32, -sweep * 0.68),
    at(-span * 0.5, -sweep),
  ];
}

interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function boundsOf(rings: readonly Ring[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Authoring happens in whatever coordinates the shape wanted; the registry stores everything
 * in [0,1]^2 with the true aspect kept alongside. That keeps the atlas cells square (one quad
 * geometry for the whole layer) without ever stretching a figure to fill one.
 */
function normalise(rings: readonly Ring[]): { rings: readonly Ring[]; aspect: number } {
  const b = boundsOf(rings);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (!(w > 0 && h > 0)) throw new Error('Silhouette has a degenerate bounding box');
  // Stretched to fill the unit box rather than letterboxed into it: the true proportions
  // live in `aspect`, so any consumer that honours it gets an exact figure, and the atlas
  // packer can letterbox on its own terms without the registry guessing a cell shape.
  const moved = rings.map((ring) => ring.map((p) => pt((p.x - b.minX) / w, (p.y - b.minY) / h)));
  return { rings: moved, aspect: w / h };
}

interface SilhouetteSpec {
  readonly rings: readonly Ring[];
  readonly leadingAngle: number;
  readonly tableau: TableauPose;
  readonly tiers: readonly ParallaxTier[];
  readonly parts: number;
}

function define(id: SilhouetteId, spec: SilhouetteSpec): SilhouetteDef {
  const { rings, aspect } = normalise(spec.rings);
  return { id, rings, aspect, leadingAngle: spec.leadingAngle, tableau: spec.tableau, tiers: spec.tiers, parts: spec.parts };
}

const ALL_TIERS: readonly ParallaxTier[] = Object.freeze(['horizon', 'mid', 'fore']);
const BACK_TIERS: readonly ParallaxTier[] = Object.freeze(['horizon', 'mid']);
const CLOSE_TIERS: readonly ParallaxTier[] = Object.freeze(['mid', 'fore']);

/**
 * THE CAST. Each entry is caught at the top or the middle of one action, never at rest, and
 * each was chosen for an outline signature no other entry owns: a bar across the top, a lone
 * diagonal, a drawn arc, a convex slab, an S, a spread membrane, a horizontal mass under a
 * vertical one, a trailing line, an inverted V, a scatter, a braced lattice, a mast.
 */
export const SILHOUETTES: Readonly<Record<SilhouetteId, SilhouetteDef>> = Object.freeze({
  // Signature: a broad trapezoid capped by a slab held clear of the shoulders.
  colossus: define('colossus', {
    rings: [
      limb(pt(36, 0), pt(28, 44), -3, 22, 18),
      limb(pt(64, 0), pt(74, 44), 3, 22, 18),
      quad(pt(24, 38), pt(76, 38), pt(84, 76), pt(16, 76)),
      plate(50, 78, 36, 12),
      plate(50, 90, 9, 10),
      limb(pt(20, 78), pt(10, 108), -8, 18, 14),
      limb(pt(80, 78), pt(92, 108), 8, 18, 14),
      quad(pt(2, 102), pt(98, 114), pt(96, 132), pt(0, 120)),
    ],
    leadingAngle: -0.95,
    tableau: { lean: 0.04, rise: 0.0, scale: 1.15, crop: 0.18 },
    tiers: ALL_TIERS,
    parts: 1,
  }),

  // Signature: one uninterrupted diagonal crossing the whole box, flaring at the far end.
  lancer: define('lancer', {
    rings: [
      limb(pt(4, 4), pt(46, 36), -5, 15, 12),
      limb(pt(80, 2), pt(54, 40), 6, 16, 13),
      limb(pt(50, 34), pt(64, 68), 5, 24, 17),
      plate(70, 76, 9, 10, 0.2),
      plate(56, 70, 14, 9, 0.4),
      limb(pt(58, 64), pt(28, 54), -5, 11, 8),
      plate(24, 54, 13, 15),
      limb(pt(8, 26), pt(116, 74), 0, 9, 7, 3),
      [pt(112, 70), pt(146, 92), pt(132, 74), pt(140, 62), pt(118, 62)],
    ],
    leadingAngle: 0.42,
    tableau: { lean: -0.06, rise: 0.0, scale: 1.0, crop: 0.1 },
    tiers: ALL_TIERS,
    parts: 1,
  }),

  // Signature: a drawn arc held clear of a kneeling mass, with air between the two.
  archer: define('archer', {
    rings: [
      limb(pt(2, 8), pt(40, 22), -4, 14, 12),
      limb(pt(52, 6), pt(44, 34), 5, 16, 13),
      limb(pt(44, 30), pt(30, 12), 4, 14, 12),
      limb(pt(42, 28), pt(44, 64), 2, 22, 16),
      plate(46, 72, 9, 10),
      limb(pt(42, 58), pt(14, 66), -6, 12, 9),
      limb(pt(48, 56), pt(86, 52), 3, 12, 9),
      limb(pt(80, 4), pt(80, 100), -20, 9, 9, 16),
      limb(pt(80, 6), pt(22, 62), 0, 6, 6, 2),
      limb(pt(22, 62), pt(80, 98), 0, 6, 6, 2),
    ],
    leadingAngle: 0.0,
    tableau: { lean: 0.0, rise: 0.0, scale: 0.95, crop: 0.06 },
    tiers: ALL_TIERS,
    parts: 1,
  }),

  // Signature: a convex slab held OUT at arm's length. The gap under the arm is the read.
  shieldbearer: define('shieldbearer', {
    rings: [
      limb(pt(18, 2), pt(34, 44), -4, 17, 14),
      limb(pt(58, 2), pt(48, 44), 4, 17, 14),
      limb(pt(38, 40), pt(42, 74), 3, 24, 18),
      plate(38, 84, 10, 11),
      limb(pt(48, 64), pt(84, 58), 4, 14, 11),
      plate(96, 54, 22, 46, 0.1, 18),
      limb(pt(30, 58), pt(2, 38), -6, 15, 12),
      [pt(8, 44), pt(-18, 24), pt(-2, 18), pt(2, 32), pt(14, 32)],
    ],
    leadingAngle: 0.0,
    tableau: { lean: -0.05, rise: 0.0, scale: 1.0, crop: 0.12 },
    tiers: ALL_TIERS,
    parts: 1,
  }),

  // Signature: an S with no limbs anywhere on it and open jaws welded to the head.
  serpent: define('serpent', {
    rings: [
      limb(pt(4, 28), pt(52, 54), 22, 28, 23, 12),
      limb(pt(52, 54), pt(100, 30), -22, 23, 16, 12),
      plate(106, 30, 16, 13, 0.15),
      [pt(98, 38), pt(136, 48), pt(118, 30), pt(134, 14), pt(98, 20)],
    ],
    leadingAngle: 0.2,
    tableau: { lean: 0.0, rise: 0.06, scale: 1.1, crop: 0.2 },
    tiers: ALL_TIERS,
    parts: 1,
  }),

  // Signature: two straight-edged membranes thrown wide - the only spread shape in the cast.
  wyrm: define('wyrm', {
    rings: [
      plate(58, 44, 32, 20, 0.1, 16),
      limb(pt(80, 50), pt(112, 74), 10, 20, 12),
      tri(pt(104, 70), pt(142, 78), pt(106, 58)),
      tri(pt(108, 70), pt(138, 54), pt(104, 62)),
      limb(pt(38, 40), pt(2, 14), -14, 18, 5, 8),
      quad(pt(50, 56), pt(18, 116), pt(54, 96), pt(68, 60)),
      quad(pt(68, 56), pt(112, 122), pt(76, 98), pt(60, 60)),
      limb(pt(46, 30), pt(36, 2), -4, 14, 9),
      limb(pt(74, 30), pt(84, 2), 4, 14, 9),
    ],
    leadingAngle: 0.28,
    tableau: { lean: 0.0, rise: 0.1, scale: 1.2, crop: 0.24 },
    tiers: ALL_TIERS,
    parts: 1,
  }),

  // Signature: a horizontal mass with a vertical one standing on it, forelegs off the ground.
  rider: define('rider', {
    rings: [
      plate(56, 46, 38, 18, 0.06, 16),
      limb(pt(86, 52), pt(110, 76), 8, 18, 11),
      tri(pt(104, 74), pt(134, 80), pt(106, 62)),
      limb(pt(30, 40), pt(16, 2), -4, 15, 10),
      limb(pt(44, 38), pt(40, 2), 2, 15, 10),
      limb(pt(78, 46), pt(104, 26), 8, 14, 8),
      limb(pt(82, 44), pt(96, 12), 6, 14, 8),
      limb(pt(24, 52), pt(0, 66), 8, 11, 3),
      limb(pt(54, 56), pt(60, 90), 3, 18, 13),
      plate(62, 96, 8, 9),
      limb(pt(58, 84), pt(96, 116), 6, 12, 7),
      [pt(94, 114), pt(124, 132), pt(106, 114), pt(114, 102), pt(92, 106)],
    ],
    leadingAngle: 0.5,
    tableau: { lean: 0.08, rise: 0.0, scale: 1.05, crop: 0.14 },
    tiers: CLOSE_TIERS,
    parts: 1,
  }),

  // Signature: a shaft through the whole box with a bight of line hanging under it.
  harpooner: define('harpooner', {
    rings: [
      limb(pt(16, 2), pt(38, 42), -4, 16, 12),
      limb(pt(62, 2), pt(46, 42), 4, 16, 12),
      limb(pt(42, 38), pt(50, 74), 4, 24, 17),
      plate(56, 83, 9, 10),
      limb(pt(48, 70), pt(18, 88), -8, 14, 10),
      limb(pt(54, 68), pt(84, 82), 4, 13, 9),
      limb(pt(2, 66), pt(124, 96), 0, 9, 7, 3),
      limb(pt(70, 82), pt(104, 90), -26, 8, 8, 10),
      [pt(118, 100), pt(152, 92), pt(130, 88), pt(136, 76), pt(116, 86)],
    ],
    leadingAngle: 0.24,
    tableau: { lean: -0.04, rise: 0.0, scale: 1.0, crop: 0.08 },
    tiers: ALL_TIERS,
    parts: 1,
  }),

  // Signature: a long hull on splayed legs, one lifted - the gaps under it are the read.
  stonewalker: define('stonewalker', {
    rings: [
      plate(50, 88, 42, 12, 0.03, 16),
      limb(pt(22, 84), pt(2, 2), -10, 14, 6, 10),
      limb(pt(78, 84), pt(98, 4), 10, 14, 6, 10),
      limb(pt(50, 82), pt(58, 34), 6, 12, 6, 8),
      limb(pt(50, 96), pt(56, 126), 0, 8, 6),
      tri(pt(56, 124), pt(84, 114), pt(54, 106)),
    ],
    leadingAngle: 0.0,
    tableau: { lean: 0.03, rise: 0.0, scale: 1.35, crop: 0.3 },
    tiers: ALL_TIERS,
    parts: 1,
  }),

  // Signature: the only entry that is not one mass. Deliberately six.
  flock: define('flock', {
    rings: [
      chevron(20, 14, 32, 13, 0.25),
      chevron(64, 30, 28, 11, -0.18),
      chevron(108, 12, 30, 12, 0.32),
      chevron(34, 58, 26, 11, -0.3),
      chevron(84, 68, 30, 12, 0.14),
      chevron(120, 50, 24, 10, -0.22),
    ],
    leadingAngle: 0.2,
    tableau: { lean: 0.0, rise: 0.2, scale: 1.0, crop: 0.0 },
    tiers: BACK_TIERS,
    parts: 6,
  }),

  // Signature: an orthogonal lattice with one brace through it and a beam out the front.
  'siege-frame': define('siege-frame', {
    rings: [
      limb(pt(14, 6), pt(14, 90), 0, 9, 9, 2),
      limb(pt(86, 6), pt(86, 90), 0, 9, 9, 2),
      limb(pt(8, 88), pt(92, 88), 0, 9, 9, 2),
      limb(pt(8, 46), pt(92, 46), 0, 8, 8, 2),
      limb(pt(16, 10), pt(84, 86), 0, 8, 8, 2),
      limb(pt(40, 62), pt(130, 54), 0, 11, 8, 2),
      quad(pt(126, 60), pt(146, 56), pt(146, 46), pt(126, 48)),
      plate(26, 8, 13, 10),
      plate(74, 8, 13, 10),
    ],
    leadingAngle: -0.09,
    tableau: { lean: 0.0, rise: 0.0, scale: 1.1, crop: 0.16 },
    tiers: ALL_TIERS,
    parts: 1,
  }),

  // Signature: a raked mast with a torn banner off its head and a streamer trailing back.
  'standard-bearer': define('standard-bearer', {
    rings: [
      limb(pt(14, 2), pt(30, 42), -4, 15, 12),
      limb(pt(50, 2), pt(38, 42), 4, 15, 12),
      limb(pt(34, 38), pt(40, 72), 3, 22, 16),
      plate(45, 80, 9, 10),
      limb(pt(38, 68), pt(20, 92), -5, 12, 8),
      limb(pt(4, 44), pt(24, 60), -6, 13, 11),
      limb(pt(22, 6), pt(96, 128), 0, 10, 8, 3),
      [
        pt(92, 124),
        pt(146, 116),
        pt(132, 104),
        pt(144, 96),
        pt(126, 90),
        pt(136, 78),
        pt(112, 76),
        pt(86, 100),
      ],
      limb(pt(100, 100), pt(62, 44), 12, 11, 4, 8),
    ],
    leadingAngle: 0.15,
    tableau: { lean: -0.03, rise: 0.0, scale: 1.25, crop: 0.28 },
    tiers: ALL_TIERS,
    parts: 1,
  }),
});

export const SILHOUETTE_IDS: readonly SilhouetteId[] = Object.freeze(
  Object.keys(SILHOUETTES) as SilhouetteId[],
);

/* ------------------------------------------------------------------ rasteriser ---------- */

/** Coverage bitmap in [0,1], row 0 is the TOP row (texture order, y already flipped). */
export interface Coverage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/**
 * Scanline fill with per-ring union. Cost is O(rows * edges), which matters: the registry is
 * rasterised twice at load (atlas + legibility test) and a naive per-sample point-in-polygon
 * pass over 12 figures is hundreds of millions of edge tests.
 */
export function rasterise(rings: readonly Ring[], width: number, height: number, box: Bounds): Coverage {
  const ss = SILHOUETTE_LAWS.supersample;
  const data = new Float32Array(width * height);
  const subW = width * ss;
  const subH = height * ss;
  const mask = new Uint8Array(subW);
  const xs: number[] = [];

  const spanX = box.maxX - box.minX;
  const spanY = box.maxY - box.minY;

  for (let sy = 0; sy < subH; sy++) {
    mask.fill(0);
    // Texture rows run top-down but the authoring space runs y-up, so flip here once.
    const wy = box.maxY - ((sy + 0.5) / subH) * spanY;

    for (const ring of rings) {
      xs.length = 0;
      for (let i = 0, n = ring.length; i < n; i++) {
        const a = ring[i] as Pt;
        const b = ring[(i + 1) % n] as Pt;
        // Half-open edge test: a vertex exactly on the scanline must be counted once, not twice.
        if (a.y <= wy === b.y <= wy) continue;
        xs.push(a.x + ((wy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      if (xs.length < 2) continue;
      xs.sort((l, r) => l - r);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = ((xs[k] as number) - box.minX) / spanX;
        const x1 = ((xs[k + 1] as number) - box.minX) / spanX;
        let px0 = Math.max(0, Math.ceil(x0 * subW - 0.5));
        const px1 = Math.min(subW - 1, Math.floor(x1 * subW - 0.5));
        for (; px0 <= px1; px0++) mask[px0] = 1;
      }
    }

    const row = (sy / ss) | 0;
    const base = row * width;
    for (let x = 0; x < width; x++) {
      let hits = 0;
      const from = x * ss;
      for (let k = 0; k < ss; k++) hits += mask[from + k] as number;
      if (hits !== 0) data[base + x] = (data[base + x] as number) + hits / (ss * ss);
    }
  }

  return { width, height, data };
}

/**
 * How much of a square atlas cell the figure actually covers, as fractions of the cell.
 * The layer needs this to size its quad: the quad is square because the cell is square, so
 * the figure's real proportions have to come from here rather than from the quad.
 */
export function cellFit(def: SilhouetteDef): { readonly fw: number; readonly fh: number } {
  const inner = 1 - (SILHOUETTE_LAWS.gutterPx * 2) / SILHOUETTE_LAWS.cellPx;
  return def.aspect >= 1
    ? { fw: inner, fh: inner / def.aspect }
    : { fw: inner * def.aspect, fh: inner };
}

/**
 * Rasterise into a box that preserves aspect and leaves a transparent margin. The margin is
 * not decoration: the rim pass samples one step ALONG the leading direction and the horizon
 * tier samples a mip, so without a gutter both read a neighbouring figure's ink.
 */
function rasteriseFitted(def: SilhouetteDef, size: number, gutterPx: number): Coverage {
  const inner = size - gutterPx * 2;
  const drawW = def.aspect >= 1 ? inner : inner * def.aspect;
  const drawH = def.aspect >= 1 ? inner / def.aspect : inner;
  // Expand the sampled box instead of the geometry: same result, no second copy of the rings.
  const padX = ((size - drawW) * 0.5) / drawW;
  const padY = ((size - drawH) * 0.5) / drawH;
  return rasterise(def.rings, size, size, {
    minX: -padX,
    maxX: 1 + padX,
    minY: -padY,
    maxY: 1 + padY,
  });
}

/* ------------------------------------------------------------------ atlas --------------- */

/** Sub-rectangle of the atlas, in UV. Handed straight to the shader as a per-instance vec4. */
export interface AtlasCell {
  readonly u0: number;
  readonly v0: number;
  readonly du: number;
  readonly dv: number;
}

export interface SilhouetteAtlas {
  readonly width: number;
  readonly height: number;
  /** Single channel coverage. The layer needs an alpha cut and nothing else. */
  readonly data: Uint8Array;
  readonly cells: Readonly<Record<SilhouetteId, AtlasCell>>;
}

/**
 * One texture for the whole cast, built at load. This is what lets a tier be a single
 * InstancedMesh: every figure differs only by the sub-rectangle it samples.
 */
export function buildSilhouetteAtlas(): SilhouetteAtlas {
  const { cellPx, gutterPx, atlasColumns } = SILHOUETTE_LAWS;
  const rows = Math.ceil(SILHOUETTE_IDS.length / atlasColumns);
  const width = atlasColumns * cellPx;
  // Square and power-of-two: mipmaps are required by the horizon tier's blur.
  const height = Math.max(width, nextPowerOfTwo(rows * cellPx));
  const data = new Uint8Array(width * height);
  const cells: Partial<Record<SilhouetteId, AtlasCell>> = {};

  SILHOUETTE_IDS.forEach((id, index) => {
    const def = SILHOUETTES[id];
    const col = index % atlasColumns;
    const row = (index / atlasColumns) | 0;
    const ox = col * cellPx;
    const oy = row * cellPx;
    const cov = rasteriseFitted(def, cellPx, gutterPx);
    for (let y = 0; y < cellPx; y++) {
      const src = y * cellPx;
      const dst = (oy + y) * width + ox;
      for (let x = 0; x < cellPx; x++) {
        const v = cov.data[src + x] as number;
        data[dst + x] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
      }
    }
    cells[id] = { u0: ox / width, v0: oy / height, du: cellPx / width, dv: cellPx / height };
  });

  return { width, height, data, cells: cells as Record<SilhouetteId, AtlasCell> };
}

function nextPowerOfTwo(value: number): number {
  let n = 1;
  while (n < value) n *= 2;
  return n;
}

/* ------------------------------------------------------------------ 40-pixel test -------- */

interface LegibilityMetrics {
  readonly inkRatio: number;
  readonly parts: number;
  readonly profileFeatures: number;
  /** Square contain-fit at the test size. Only used for cross-figure comparison. */
  readonly mask: Uint8Array;
}

const BINARY_THRESHOLD = 0.5;

function threshold(cov: Coverage): Uint8Array {
  const mask = new Uint8Array(cov.data.length);
  for (let i = 0; i < mask.length; i++) mask[i] = (cov.data[i] as number) >= BINARY_THRESHOLD ? 1 : 0;
  return mask;
}

/**
 * "40 pixels" means forty pixels TALL, which is how a backdrop figure is actually framed -
 * squeezing a wide shape into a 40x40 box would measure the letterboxing, not the figure.
 * The square fit is still built, but only so two figures can be compared on one grid.
 */
function measure(def: SilhouetteDef, heightPx: number): LegibilityMetrics {
  const width = Math.max(1, Math.round(heightPx * def.aspect));
  const tall = threshold(rasterise(def.rings, width, heightPx, UNIT_BOX));
  let ink = 0;
  for (let i = 0; i < tall.length; i++) ink += tall[i] as number;

  return {
    inkRatio: ink / tall.length,
    parts: countComponents(tall, width, heightPx, SILHOUETTE_LAWS.minPartPx),
    profileFeatures: countProfileFeatures(tall, width, heightPx),
    mask: threshold(rasteriseFitted(def, heightPx, 1)),
  };
}

/** 4-connected flood fill, iterative - a 40x40 recursion is fine until it is not. */
function countComponents(mask: Uint8Array, width: number, height: number, minPx: number): number {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  let components = 0;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    seen[start] = 1;
    stack.push(start);
    let area = 0;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      area++;
      const x = i % width;
      const y = (i / width) | 0;
      if (x > 0) pushIf(mask, seen, stack, i - 1);
      if (x < width - 1) pushIf(mask, seen, stack, i + 1);
      if (y > 0) pushIf(mask, seen, stack, i - width);
      if (y < height - 1) pushIf(mask, seen, stack, i + width);
    }
    if (area >= minPx) components++;
  }
  return components;
}

function pushIf(mask: Uint8Array, seen: Uint8Array, stack: number[], i: number): void {
  if (mask[i] === 1 && seen[i] === 0) {
    seen[i] = 1;
    stack.push(i);
  }
}

/**
 * Articulation proxy: how many times the figure's vertical extent reverses direction as the
 * eye sweeps across it. A rectangle scores 0, a blob scores 1, a figure with a raised arm and
 * a planted stance scores several. This is the cheapest measurable stand-in for "reads as a
 * shape rather than a smudge" that does not need a human in the loop.
 */
function countProfileFeatures(mask: Uint8Array, width: number, height: number): number {
  const profile = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
      if (mask[y * width + x] === 1) {
        if (top < 0) top = y;
        bottom = y;
      }
    }
    profile[x] = top < 0 ? 0 : bottom - top + 1;
  }

  const smooth = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    const l = profile[Math.max(0, x - 1)] as number;
    const c = profile[x] as number;
    const r = profile[Math.min(width - 1, x + 1)] as number;
    smooth[x] = Math.round((l + c + r) / 3);
  }

  let features = 0;
  let direction = 0;
  for (let x = 1; x < width; x++) {
    const delta = (smooth[x] as number) - (smooth[x - 1] as number);
    // One pixel of noise is not a feature; two is a step the eye can see at 40px.
    if (Math.abs(delta) < 2) continue;
    const sign = delta > 0 ? 1 : -1;
    if (direction !== 0 && sign !== direction) features++;
    direction = sign;
  }
  return features;
}

function intersectionOverUnion(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = a[i] === 1;
    const inB = b[i] === 1;
    if (inA && inB) intersection++;
    if (inA || inB) union++;
  }
  return union === 0 ? 1 : intersection / union;
}

/**
 * Runs the 40-pixel test over the whole registry and returns every violation. Never throws,
 * so `tools/silhouettes.mjs` and the dev boot path can both report the full list at once.
 */
export function validateSilhouettes(): string[] {
  const violations: string[] = [];
  const laws = SILHOUETTE_LAWS;
  const metrics = new Map<SilhouetteId, LegibilityMetrics>();

  for (const id of SILHOUETTE_IDS) {
    const def = SILHOUETTES[id];
    const m = measure(def, laws.legibilityPx);
    metrics.set(id, m);
    const where = `silhouette "${id}"`;

    if (m.inkRatio < laws.minInkRatio) {
      violations.push(
        `40px test: ${where} covers ${(m.inkRatio * 100).toFixed(1)}% of its box, under ${(laws.minInkRatio * 100).toFixed(0)}% - it is a wisp and dies in haze`,
      );
    }
    if (m.inkRatio > laws.maxInkRatio) {
      violations.push(
        `40px test: ${where} covers ${(m.inkRatio * 100).toFixed(1)}% of its box, over ${(laws.maxInkRatio * 100).toFixed(0)}% - it is a blob and reads as every other figure`,
      );
    }
    if (m.parts !== def.parts) {
      violations.push(
        `40px test: ${where} breaks into ${m.parts} pieces at ${laws.legibilityPx}px but declares ${def.parts}`,
      );
    }
    if (m.profileFeatures < laws.minProfileFeatures) {
      violations.push(
        `40px test: ${where} has ${m.profileFeatures} profile features, under ${laws.minProfileFeatures} - its outline has nothing to recognise`,
      );
    }
    if (def.tiers.length === 0) {
      violations.push(`sanity: ${where} is staged on no tier`);
    }
    if (!Number.isFinite(def.leadingAngle)) {
      violations.push(`sanity: ${where} leadingAngle is not finite - the rim has no side to sit on`);
    }
    if (!(def.tableau.scale > 0)) {
      violations.push(`sanity: ${where} tableau.scale must be > 0`);
    }
  }

  for (let i = 0; i < SILHOUETTE_IDS.length; i++) {
    for (let j = i + 1; j < SILHOUETTE_IDS.length; j++) {
      const a = SILHOUETTE_IDS[i] as SilhouetteId;
      const b = SILHOUETTE_IDS[j] as SilhouetteId;
      const ma = metrics.get(a);
      const mb = metrics.get(b);
      if (ma === undefined || mb === undefined) continue;
      const iou = intersectionOverUnion(ma.mask, mb.mask);
      if (iou > laws.maxPairwiseIou) {
        violations.push(
          `40px test: "${a}" and "${b}" overlap ${(iou * 100).toFixed(0)}% at ${laws.legibilityPx}px - the player cannot tell them apart`,
        );
      }
    }
  }

  return violations;
}

/** Load-time gate. Kept separate from the validator so tooling can report instead of crash. */
export function assertSilhouettesLegible(): void {
  const violations = validateSilhouettes();
  if (violations.length > 0) {
    throw new Error(`Silhouette registry fails the 40-pixel test:\n  ${violations.join('\n  ')}`);
  }
}

/** Diagnostic dump for `tools/silhouettes.mjs`. Not used on any runtime path. */
export function describeSilhouette(id: SilhouetteId): string {
  const def = SILHOUETTES[id];
  const m = measure(def, SILHOUETTE_LAWS.legibilityPx);
  return [
    id.padEnd(18),
    `aspect ${def.aspect.toFixed(2)}`,
    `ink ${(m.inkRatio * 100).toFixed(1)}%`,
    `parts ${m.parts}/${def.parts}`,
    `features ${m.profileFeatures}`,
  ].join('  ');
}
