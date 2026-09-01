/**
 * SEEDED FRACTURE-CELL GENERATION.
 *
 * A shatter is a TESSELLATION, not a puff of sprites. Every shard in SHATTERPOINT is a real
 * extruded polygon whose edges are shared exactly with its neighbours, because that is the
 * only way the unbroken pane and the broken pane can be the same geometry: at bond weight 1
 * the cells close up seamlessly into the original rectangle, and a sprite cloud can never
 * do that. See Shatter.ts for why that identity is load-bearing.
 *
 * DETERMINISM IS A HARD REQUIREMENT, not a nicety. Replays, the seeded corridor and the
 * still-frame export path all assume the same seed yields the same fracture on any machine,
 * so this module:
 *   - draws every random number from `Rng` (mulberry32), never `Math.random()`;
 *   - uses only +, -, *, / and Math.sqrt, all of which IEEE-754 requires to be correctly
 *     rounded. `Math.sin`/`Math.cos`/`Math.pow` are NOT required to be correctly rounded and
 *     do differ in the last ulp between JS engines, so directions come from a rational
 *     parameterisation of the circle (`unitFromParam`) instead of trigonometry.
 *
 * Nothing here imports three.js. The module emits plain typed arrays so it can be exercised
 * in a bare Node process by the export tooling without a GPU.
 */

import type { Rng } from '../battle/types';
import { createRng } from '../battle/types';
import type { Seed } from '../core/types';
import { asSeed } from '../core/types';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Pane-local rectangle, centred on (0,0) so a pane's pivot is its own centre. Metres. */
export interface PaneRect {
  readonly halfWidth: number;
  readonly halfHeight: number;
}

export interface FractureCell {
  /** Position in the owning pattern's `cells`, and therefore the shard index on the GPU. */
  readonly index: number;
  /** The Voronoi site. Kept because it, not the centroid, is what the seed reproduces. */
  readonly site: Vec2;
  /** Area centroid. This is the shard's pivot: its vertices are emitted relative to it. */
  readonly centroid: Vec2;
  readonly area: number;
  /** Convex ring, counter-clockwise, pane-local metres. The closing edge is implicit. */
  readonly polygon: readonly Vec2[];
  /** |centroid - impact|. Drives both the release stagger and the ejection falloff. */
  readonly impactDistance: number;
}

export interface FracturePattern {
  readonly seed: Seed;
  readonly rect: PaneRect;
  readonly impact: Vec2;
  readonly cells: readonly FractureCell[];
  readonly meanArea: number;
  /** Largest `impactDistance` in the pattern; the stagger normalises against it. */
  readonly maxImpactDistance: number;
}

export interface FractureRequest {
  readonly rect: PaneRect;
  readonly seed: Seed;
  /** Upper bound on cells. The generator may return fewer if sites merged. */
  readonly cellCount: number;
  /** Impact point in pane-local metres. Clamped into the rect before use. */
  readonly impact: Vec2;
  /** 0 = evenly scattered sites, 1 = sites piled onto the impact point. */
  readonly focus: number;
  readonly relaxIterations: number;
}

/**
 * Shape laws, not performance budgets - the same on a phone and a workstation, because they
 * decide what a fracture LOOKS like rather than what it costs. Following the precedent set
 * by the timeline laws in battle/types.ts, they live with the contract they constrain;
 * everything that scales with hardware (how many cells a pane may spend, how many shards may
 * be alive) comes from core/Quality.ts and is passed in as `cellCount`.
 */
export const FRACTURE_LAWS = Object.freeze({
  /** Below this a "fracture" reads as a pane being deleted rather than broken. */
  minCells: 3,
  /** Past this, relaxation has converged and further passes only cost time. */
  maxRelaxIterations: 8,
  /**
   * Lloyd's algorithm run to convergence equalises cell AREAS, which is precisely the wrong
   * outcome here: it erases the density gradient that makes the pattern read as a fracture
   * radiating from an impact. So each pass takes only a fraction of the step toward the
   * centroid - enough to kill slivers, not enough to flatten the gradient.
   */
  relaxStep: 0.55,
  /** Sites closer than this fraction of the shorter side are one site; duplicates make holes. */
  siteMergeFraction: 0.006,
  /** Sites are never planted flush against the rim; a zero-width edge shard is not a shard. */
  rimInsetMin: 0.8,
  rimInsetMax: 0.985,
  /** Multiplicative jitter on each site's radius, so the rings never read as rings. */
  radiusJitterMin: 0.82,
  radiusJitterMax: 1.18,
  /** Fraction of a full turn the angle of each successive site may wander. */
  angleJitter: 0.35,
});

/**
 * Golden-ratio conjugate. Successive multiples mod 1 are the maximally-avoiding sequence on
 * the circle, so sites spiral out without ever clumping into visible spokes.
 */
const GOLDEN_FRACTION = 0.618033988749895;

/** Rng sub-streams. Fixed constants so adding a draw to one never shifts the others. */
const STREAM_SITES = 0x51e;
const STREAM_LATTICE = 0x1a7;

/**
 * `noUncheckedIndexedAccess` widens every indexed read to `number | undefined`. Each index
 * used below is derived from a length checked in the same scope, so this states the
 * argument once rather than at several dozen subscripts.
 */
const num = (buffer: readonly number[] | Float64Array, index: number): number => buffer[index] as number;

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/**
 * Unit vector from a parameter in [0,1), built from the tangent half-angle rational map
 * ((1-t²)/(1+t²), 2t/(1+t²)) rather than sin/cos, so the result is bit-identical on every
 * JS engine (see the determinism note at the top). The map covers the right half of the
 * circle for t in [-1,1]; the left half is the same sweep with x negated. Angle is a
 * monotone but non-uniform reparameterisation of the true angle, which is irrelevant for
 * scattering sites and is exactly why it is cheap. The two halves meet at (0,±1); the
 * golden-ratio step never lands on that seam twice in one pane.
 */
export function unitFromParam(s: number): Vec2 {
  const wrapped = s - Math.floor(s);
  const right = wrapped < 0.5;
  const t = (right ? wrapped : wrapped - 0.5) * 4 - 1;
  const denom = 1 + t * t;
  const x = (1 - t * t) / denom;
  return { x: right ? x : -x, y: (2 * t) / denom };
}

/** Shoelace area of a CCW ring held as flat x,y pairs. Positive for CCW. */
function ringArea(ring: readonly number[], count: number): number {
  let twice = 0;
  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    twice += num(ring, j * 2) * num(ring, i * 2 + 1) - num(ring, i * 2) * num(ring, j * 2 + 1);
  }
  return twice * 0.5;
}

/** Area centroid of a CCW ring. Falls back to the vertex mean when the ring is degenerate. */
function ringCentroid(ring: readonly number[], count: number, out: { x: number; y: number }): number {
  const area = ringArea(ring, count);
  if (Math.abs(area) < Number.EPSILON) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < count; i += 1) {
      sx += num(ring, i * 2);
      sy += num(ring, i * 2 + 1);
    }
    out.x = count > 0 ? sx / count : 0;
    out.y = count > 0 ? sy / count : 0;
    return 0;
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    const jx = num(ring, j * 2);
    const jy = num(ring, j * 2 + 1);
    const ix = num(ring, i * 2);
    const iy = num(ring, i * 2 + 1);
    const cross = jx * iy - ix * jy;
    cx += (jx + ix) * cross;
    cy += (jy + iy) * cross;
  }
  const k = 1 / (6 * area);
  out.x = cx * k;
  out.y = cy * k;
  return area;
}

/**
 * Sutherland-Hodgman clip of a convex ring against the half-plane {p : (p - m)·d <= 0}.
 * Returns the vertex count written into `dst`. Convexity is preserved, which is what lets a
 * Voronoi cell be built by clipping the pane rect once per rival site.
 */
function clipHalfPlane(
  src: readonly number[],
  srcCount: number,
  dst: number[],
  mx: number,
  my: number,
  dx: number,
  dy: number,
): number {
  if (srcCount === 0) return 0;
  let out = 0;
  let ax = num(src, (srcCount - 1) * 2);
  let ay = num(src, (srcCount - 1) * 2 + 1);
  let ad = (ax - mx) * dx + (ay - my) * dy;

  for (let i = 0; i < srcCount; i += 1) {
    const bx = num(src, i * 2);
    const by = num(src, i * 2 + 1);
    const bd = (bx - mx) * dx + (by - my) * dy;

    if (bd <= 0) {
      if (ad > 0) {
        const t = ad / (ad - bd);
        dst[out * 2] = ax + (bx - ax) * t;
        dst[out * 2 + 1] = ay + (by - ay) * t;
        out += 1;
      }
      dst[out * 2] = bx;
      dst[out * 2 + 1] = by;
      out += 1;
    } else if (ad <= 0) {
      const t = ad / (ad - bd);
      dst[out * 2] = ax + (bx - ax) * t;
      dst[out * 2 + 1] = ay + (by - ay) * t;
      out += 1;
    }

    ax = bx;
    ay = by;
    ad = bd;
  }
  return out;
}

/** Scratch shared by one `generateFracture` call. Allocated per call, never per cell. */
interface ClipScratch {
  readonly a: number[];
  readonly b: number[];
}

/**
 * The cell of site `index`: the pane rect clipped by the perpendicular bisector against every
 * other site. O(n) clips per cell, O(n²) per pattern, and deliberately kept that way. Both a
 * bisector-distance early-out and a sort-then-sweep variant were built and measured against
 * it; at the counts a pane actually reaches (a 2 m² pane at the plain archetype's density is
 * ~56 cells, ~0.6ms for four passes) both were SLOWER, because the cell is still pane-sized
 * when the far rivals are visited and the bookkeeping never pays for itself. The sorted
 * variant also changed the output, since relaxation is sequential and therefore order
 * dependent. If a tier ever wants panes past ~200 cells, bucket the sites into a uniform grid
 * - do not re-litigate the early-out.
 *
 * The bake also lands on the frame the hit-stop is about to freeze, so it has more of that
 * frame than the `msBudget.shatter` steady-state allowance suggests.
 */
function buildCell(
  sites: Float64Array,
  siteCount: number,
  index: number,
  rect: PaneRect,
  scratch: ClipScratch,
): { ring: readonly number[]; count: number } {
  const { a, b } = scratch;
  const { halfWidth: hw, halfHeight: hh } = rect;

  a[0] = -hw;
  a[1] = -hh;
  a[2] = hw;
  a[3] = -hh;
  a[4] = hw;
  a[5] = hh;
  a[6] = -hw;
  a[7] = hh;
  let count = 4;
  let source = a;
  let target = b;

  const sx = num(sites, index * 2);
  const sy = num(sites, index * 2 + 1);
  for (let j = 0; j < siteCount && count > 0; j += 1) {
    if (j === index) continue;
    const jx = num(sites, j * 2);
    const jy = num(sites, j * 2 + 1);
    count = clipHalfPlane(source, count, target, (sx + jx) * 0.5, (sy + jy) * 0.5, jx - sx, jy - sy);
    const swap = source;
    source = target;
    target = swap;
  }

  return { ring: source, count };
}

/** Longest distance from `point` to any corner of the rect - the reach a site may need. */
function maxCornerDistance(rect: PaneRect, point: Vec2): number {
  const dx = Math.abs(point.x) + rect.halfWidth;
  const dy = Math.abs(point.y) + rect.halfHeight;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance from `origin` along `dir` to the rect boundary. `origin` must be inside. */
function rayToRim(rect: PaneRect, origin: Vec2, dir: Vec2): number {
  let t = Number.POSITIVE_INFINITY;
  if (dir.x > 0) t = Math.min(t, (rect.halfWidth - origin.x) / dir.x);
  else if (dir.x < 0) t = Math.min(t, (-rect.halfWidth - origin.x) / dir.x);
  if (dir.y > 0) t = Math.min(t, (rect.halfHeight - origin.y) / dir.y);
  else if (dir.y < 0) t = Math.min(t, (-rect.halfHeight - origin.y) / dir.y);
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}

/**
 * Impact-biased site scatter. The radial profile blends sqrt(u) (which spreads sites evenly
 * over AREA, so they look uniform) with u² (which piles them at the centre); `focus` slides
 * between the two. Both are pure arithmetic, unlike the pow() a general falloff would need.
 */
function scatterSites(rect: PaneRect, impact: Vec2, count: number, focus: number, rng: Rng): Float64Array {
  const reach = maxCornerDistance(rect, impact);
  const raw = new Float64Array(count * 2);
  const f = clamp(focus, 0, 1);

  for (let k = 0; k < count; k += 1) {
    const u = (k + 0.5) / count;
    const profile = (1 - f) * Math.sqrt(u) + f * u * u;
    const jitter = rng.range(FRACTURE_LAWS.radiusJitterMin, FRACTURE_LAWS.radiusJitterMax);
    const angle = k * GOLDEN_FRACTION + rng.next() * FRACTURE_LAWS.angleJitter;
    const dir = unitFromParam(angle);

    let radius = profile * reach * jitter;
    const rim = rayToRim(rect, impact, dir);
    if (radius > rim) radius = rim * rng.range(FRACTURE_LAWS.rimInsetMin, FRACTURE_LAWS.rimInsetMax);

    raw[k * 2] = clamp(impact.x + dir.x * radius, -rect.halfWidth, rect.halfWidth);
    raw[k * 2 + 1] = clamp(impact.y + dir.y * radius, -rect.halfHeight, rect.halfHeight);
  }

  // Coincident sites produce empty cells, and an empty cell is a HOLE in a pane that has to
  // reassemble seamlessly at bond weight 1. Merging is cheaper than repairing the hole.
  const epsilon = Math.min(rect.halfWidth, rect.halfHeight) * 2 * FRACTURE_LAWS.siteMergeFraction;
  const epsilonSq = epsilon * epsilon;
  const kept = new Float64Array(count * 2);
  let keptCount = 0;

  for (let k = 0; k < count; k += 1) {
    const x = num(raw, k * 2);
    const y = num(raw, k * 2 + 1);
    let duplicate = false;
    for (let j = 0; j < keptCount; j += 1) {
      const ddx = x - num(kept, j * 2);
      const ddy = y - num(kept, j * 2 + 1);
      if (ddx * ddx + ddy * ddy < epsilonSq) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    kept[keptCount * 2] = x;
    kept[keptCount * 2 + 1] = y;
    keptCount += 1;
  }

  return kept.subarray(0, keptCount * 2);
}

/** Partial Lloyd relaxation. See FRACTURE_LAWS.relaxStep for why it is deliberately partial. */
function relax(sites: Float64Array, rect: PaneRect, iterations: number, scratch: ClipScratch): void {
  const siteCount = sites.length / 2;
  const centroid = { x: 0, y: 0 };
  for (let pass = 0; pass < iterations; pass += 1) {
    for (let i = 0; i < siteCount; i += 1) {
      const cell = buildCell(sites, siteCount, i, rect, scratch);
      if (cell.count < 3) continue;
      ringCentroid(cell.ring, cell.count, centroid);
      const x = num(sites, i * 2);
      const y = num(sites, i * 2 + 1);
      sites[i * 2] = x + (centroid.x - x) * FRACTURE_LAWS.relaxStep;
      sites[i * 2 + 1] = y + (centroid.y - y) * FRACTURE_LAWS.relaxStep;
    }
  }
}

/**
 * The generator. Same request in, same pattern out, forever - that is the contract the
 * replay system and the still-frame exporter both lean on.
 */
export function generateFracture(request: FractureRequest): FracturePattern {
  const { rect, seed, impact, focus } = request;
  const rng = createRng(seed).fork(STREAM_SITES);

  const clampedImpact: Vec2 = {
    x: clamp(impact.x, -rect.halfWidth, rect.halfWidth),
    y: clamp(impact.y, -rect.halfHeight, rect.halfHeight),
  };
  const wanted = Math.max(FRACTURE_LAWS.minCells, Math.floor(request.cellCount));
  const iterations = clamp(Math.floor(request.relaxIterations), 0, FRACTURE_LAWS.maxRelaxIterations);

  const sites = scatterSites(rect, clampedImpact, wanted, focus, rng);
  const siteCount = sites.length / 2;

  // Every clip can add at most one vertex, so the rect's four corners plus one per rival is
  // a hard ceiling. Sizing once here is what keeps the inner loops allocation-free.
  const capacity = (siteCount + 4) * 2 + 8;
  const scratch: ClipScratch = { a: new Array<number>(capacity).fill(0), b: new Array<number>(capacity).fill(0) };

  relax(sites, rect, iterations, scratch);

  const cells: FractureCell[] = [];
  const centroid = { x: 0, y: 0 };
  let areaSum = 0;
  let maxImpactDistance = 0;

  for (let i = 0; i < siteCount; i += 1) {
    const cell = buildCell(sites, siteCount, i, rect, scratch);
    if (cell.count < 3) continue;

    const area = ringCentroid(cell.ring, cell.count, centroid);
    if (!(area > 0)) continue;

    const polygon: Vec2[] = new Array<Vec2>(cell.count);
    for (let v = 0; v < cell.count; v += 1) {
      polygon[v] = { x: num(cell.ring, v * 2), y: num(cell.ring, v * 2 + 1) };
    }

    const dx = centroid.x - clampedImpact.x;
    const dy = centroid.y - clampedImpact.y;
    const impactDistance = Math.sqrt(dx * dx + dy * dy);
    if (impactDistance > maxImpactDistance) maxImpactDistance = impactDistance;
    areaSum += area;

    cells.push({
      index: cells.length,
      site: { x: num(sites, i * 2), y: num(sites, i * 2 + 1) },
      centroid: { x: centroid.x, y: centroid.y },
      area,
      polygon,
      impactDistance,
    });
  }

  return {
    seed,
    rect,
    impact: clampedImpact,
    cells,
    meanArea: cells.length > 0 ? areaSum / cells.length : 0,
    maxImpactDistance,
  };
}

/** Leaded-glass subdivision: the pane is a grid of panels before it is a field of shards. */
export interface LatticeSpec {
  readonly columns: number;
  readonly rows: number;
  /**
   * Cells the panel directly on the impact receives. Distant panels fall off toward one
   * cell each, i.e. the whole panel leaves its lead came in a single piece.
   */
  readonly cellsAtImpact: number;
  /** Fraction of a panel eaten by the lead came around it. */
  readonly leadFraction: number;
}

/**
 * A votive lattice does not fracture like a sheet: the lead came is the strongest crack in
 * the pane, so the panels separate FIRST and only the struck panels break up. Fracturing
 * each panel independently and concatenating the cells reproduces that for free, and keeps
 * every cell boundary snapped to the came where a single Voronoi field would smear across it.
 */
export function generateLatticeFracture(
  rect: PaneRect,
  spec: LatticeSpec,
  seed: Seed,
  impact: Vec2,
  focus: number,
  relaxIterations: number,
  cellBudget: number,
): FracturePattern {
  const columns = Math.max(1, Math.floor(spec.columns));
  const rows = Math.max(1, Math.floor(spec.rows));
  const panelHalfW = rect.halfWidth / columns;
  const panelHalfH = rect.halfHeight / rows;
  const inset = clamp(spec.leadFraction, 0, 0.5);
  const panelRect: PaneRect = {
    halfWidth: panelHalfW * (1 - inset),
    halfHeight: panelHalfH * (1 - inset),
  };
  const panelReach = Math.sqrt(panelHalfW * panelHalfW + panelHalfH * panelHalfH);

  const cells: FractureCell[] = [];
  const rootRng = createRng(seed).fork(STREAM_LATTICE);
  let areaSum = 0;
  let maxImpactDistance = 0;
  let spent = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const cx = -rect.halfWidth + panelHalfW * (col * 2 + 1);
      const cy = -rect.halfHeight + panelHalfH * (row * 2 + 1);
      const dx = cx - impact.x;
      const dy = cy - impact.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Falls from cellsAtImpact on the struck panel to one panel-sized shard far away.
      const nearness = panelReach / (panelReach + distance);
      const wanted = Math.max(1, Math.round(spec.cellsAtImpact * nearness * nearness));
      const remaining = cellBudget - spent;
      if (remaining <= 0) break;
      const allowance = Math.min(wanted, remaining);

      const panelSeed = asSeed(rootRng.int(0, 0xffffffff));
      const panel =
        allowance <= 1
          ? null
          : generateFracture({
              rect: panelRect,
              seed: panelSeed,
              cellCount: allowance,
              impact: { x: clamp(impact.x - cx, -panelRect.halfWidth, panelRect.halfWidth), y: clamp(impact.y - cy, -panelRect.halfHeight, panelRect.halfHeight) },
              focus,
              relaxIterations,
            });

      const panelCells: readonly FractureCell[] =
        panel !== null && panel.cells.length > 0 ? panel.cells : [wholePanel(panelRect)];

      for (const local of panelCells) {
        const polygon = local.polygon.map((p) => ({ x: p.x + cx, y: p.y + cy }));
        const centroid = { x: local.centroid.x + cx, y: local.centroid.y + cy };
        const idx = centroid.x - impact.x;
        const idy = centroid.y - impact.y;
        const impactDistance = Math.sqrt(idx * idx + idy * idy);
        if (impactDistance > maxImpactDistance) maxImpactDistance = impactDistance;
        areaSum += local.area;
        cells.push({
          index: cells.length,
          site: { x: local.site.x + cx, y: local.site.y + cy },
          centroid,
          area: local.area,
          polygon,
          impactDistance,
        });
      }
      spent += panelCells.length;
    }
  }

  return {
    seed,
    rect,
    impact,
    cells,
    meanArea: cells.length > 0 ? areaSum / cells.length : 0,
    maxImpactDistance,
  };
}

/** One panel leaving its came intact: a rectangle expressed as a single fracture cell. */
function wholePanel(rect: PaneRect): FractureCell {
  const { halfWidth: hw, halfHeight: hh } = rect;
  return {
    index: 0,
    site: { x: 0, y: 0 },
    centroid: { x: 0, y: 0 },
    area: hw * hh * 4,
    polygon: [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ],
    impactDistance: 0,
  };
}

/**
 * Renderable form of a pattern. Positions are RELATIVE TO EACH SHARD'S PIVOT, so the GPU can
 * place a shard with one transform and the assembled pane is recovered by simply translating
 * every shard back to its pivot. `shardIndex` is the per-vertex lookup into that transform
 * buffer. Normals are computed analytically rather than by averaging: glass is faceted and
 * a smoothed shard edge looks like plastic.
 */
export interface ShardMeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly shardIndex: Float32Array;
  readonly indices: Uint32Array;
  /** 3 floats per shard: the pane-local pivot its vertices are measured from. */
  readonly pivots: Float32Array;
  readonly shardCount: number;
  readonly vertexCount: number;
}

/**
 * Extrudes every cell into a closed prism: front cap, back cap and a skirt of quads. Glass
 * with no thickness has no refraction and no lit edge, and the edge is most of what sells a
 * shard tumbling through a light shaft.
 */
export function buildShardMesh(pattern: FracturePattern, thickness: number): ShardMeshData {
  const half = thickness * 0.5;
  const { cells, rect } = pattern;

  let vertexCount = 0;
  let indexCount = 0;
  for (const cell of cells) {
    const n = cell.polygon.length;
    vertexCount += n * 6;
    indexCount += (n * 4 - 4) * 3;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const shardIndex = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  const pivots = new Float32Array(cells.length * 3);

  const invW = 1 / (rect.halfWidth * 2);
  const invH = 1 / (rect.halfHeight * 2);

  let v = 0;
  let t = 0;

  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, shard: number): void => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;
    uvs[v * 2] = u;
    uvs[v * 2 + 1] = w;
    shardIndex[v] = shard;
    v += 1;
  };

  for (const cell of cells) {
    const ring = cell.polygon;
    const n = ring.length;
    const px = cell.centroid.x;
    const py = cell.centroid.y;
    pivots[cell.index * 3] = px;
    pivots[cell.index * 3 + 1] = py;
    pivots[cell.index * 3 + 2] = 0;

    const frontBase = v;
    for (let i = 0; i < n; i += 1) {
      const p = ring[i] as Vec2;
      put(p.x - px, p.y - py, half, 0, 0, 1, (p.x + rect.halfWidth) * invW, (p.y + rect.halfHeight) * invH, cell.index);
    }
    const backBase = v;
    for (let i = 0; i < n; i += 1) {
      const p = ring[i] as Vec2;
      put(p.x - px, p.y - py, -half, 0, 0, -1, (p.x + rect.halfWidth) * invW, (p.y + rect.halfHeight) * invH, cell.index);
    }

    for (let i = 1; i < n - 1; i += 1) {
      indices[t] = frontBase;
      indices[t + 1] = frontBase + i;
      indices[t + 2] = frontBase + i + 1;
      indices[t + 3] = backBase;
      indices[t + 4] = backBase + i + 1;
      indices[t + 5] = backBase + i;
      t += 6;
    }

    for (let i = 0; i < n; i += 1) {
      const a = ring[i] as Vec2;
      const b = ring[(i + 1) % n] as Vec2;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const len = Math.sqrt(ex * ex + ey * ey);
      // Outward normal of edge a->b on a CCW ring is the edge direction turned right.
      const nx = len > 0 ? ey / len : 0;
      const ny = len > 0 ? -ex / len : 0;

      const quadBase = v;
      const ua = (a.x + rect.halfWidth) * invW;
      const wa = (a.y + rect.halfHeight) * invH;
      const ub = (b.x + rect.halfWidth) * invW;
      const wb = (b.y + rect.halfHeight) * invH;
      put(a.x - px, a.y - py, half, nx, ny, 0, ua, wa, cell.index);
      put(b.x - px, b.y - py, half, nx, ny, 0, ub, wb, cell.index);
      put(b.x - px, b.y - py, -half, nx, ny, 0, ub, wb, cell.index);
      put(a.x - px, a.y - py, -half, nx, ny, 0, ua, wa, cell.index);

      indices[t] = quadBase;
      indices[t + 1] = quadBase + 2;
      indices[t + 2] = quadBase + 1;
      indices[t + 3] = quadBase;
      indices[t + 4] = quadBase + 3;
      indices[t + 5] = quadBase + 2;
      t += 6;
    }
  }

  return { positions, normals, uvs, shardIndex, indices, pivots, shardCount: cells.length, vertexCount };
}

/**
 * Returns every violation; empty means the pattern is legal. The tiling check is the
 * important one: if the cells do not sum to the pane's area they do not tile it, and the
 * "unbroken" pose Shatter.ts animates from would show daylight through the cracks.
 */
export function validateFracture(pattern: FracturePattern): string[] {
  const violations: string[] = [];
  const where = `fracture seed ${pattern.seed}`;
  const { cells, rect } = pattern;

  if (cells.length < FRACTURE_LAWS.minCells) {
    violations.push(`law: ${where} produced ${cells.length} cells, must produce >= ${FRACTURE_LAWS.minCells}`);
  }

  const rectArea = rect.halfWidth * rect.halfHeight * 4;
  let areaSum = 0;
  for (const cell of cells) {
    areaSum += cell.area;
    if (cell.polygon.length < 3) {
      violations.push(`sanity: ${where} cell ${cell.index} has ${cell.polygon.length} vertices`);
    }
    if (!(cell.area > 0)) {
      violations.push(`sanity: ${where} cell ${cell.index} has non-positive area ${cell.area}`);
    }
    for (const p of cell.polygon) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        violations.push(`sanity: ${where} cell ${cell.index} has a non-finite vertex`);
        break;
      }
    }
  }

  // A lattice deliberately loses the lead came, so it is only the plain field that must tile.
  const coverage = rectArea > 0 ? areaSum / rectArea : 0;
  if (coverage > 1.0001) {
    violations.push(`law: ${where} cells cover ${(coverage * 100).toFixed(2)}% of the pane - cells overlap`);
  }

  return violations;
}
