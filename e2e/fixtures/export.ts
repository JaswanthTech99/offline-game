import type { PNG } from 'pngjs';

/**
 * The still-export measurement kit.
 *
 * Separate from the game fixture because export is not a gate: it renders one enormous
 * frame per tier and is invoked by hand. Everything here is pure - it takes a decoded PNG
 * and returns numbers - so the arithmetic can be reasoned about without a browser.
 */

/** Where stills land. Relative to the repo root, which is playwright's cwd. */
export const EXPORT_DIR = 'exports';

/** The one size this path exists to produce. Device pixels, not CSS pixels. */
export const TARGET = Object.freeze({ width: 3840, height: 2160 });

/**
 * Fraction of the SHORTER axis that counts as the frame edge. The exposure law's black
 * point (docs/ARCHITECTURE.md §6, site 3) is a claim about the border of the image, so the
 * band has to be square in pixels rather than a percentage of each axis independently -
 * a percentage-per-axis band is thicker top-and-bottom on a 16:9 frame and would report a
 * different number for the same vignette at a different aspect.
 */
const EDGE_BAND_FRACTION = 0.06;

/** Half-width and half-height of each corner probe, as a fraction of the frame. */
const CORNER_BOX_FRACTION = 0.08;

/** Luma histogram resolution. 1024 bins over [0,1] resolves the median to ~0.001. */
const BINS = 1024;

/** Bright-pixel threshold, and the mid-band the corridor is supposed to actually live in. */
const OVER_THRESHOLD = 0.8;
const MID_BAND = Object.freeze({ lo: 0.28, hi: 0.45 });

export interface LumaStats {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
  /** Mean luma of the outer band. The vignette's black point, measured. */
  readonly edgeBandMean: number;
  /** Brightest pixel in any of the four corner boxes. HISTOGRAM_LAW caps this at 0.12. */
  readonly cornerMax: number;
  readonly pctOver80: number;
  readonly pctIn28to45: number;
  /** Pixel thickness of the edge band these numbers were measured with. */
  readonly edgeBandPx: number;
  readonly cornerBoxPx: { readonly w: number; readonly h: number };
}

/**
 * Rec.709 luma on the sRGB bytes as composited, normalised to [0,1]. Deliberately NOT
 * linearised: this measures the image a viewer sees, and the same coefficients are what
 * the detail and ball gates already report, so the numbers are comparable across specs.
 */
function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * One full pass over every pixel - no subsampling. Eight megapixels of integer arithmetic
 * costs a fraction of a second, and a still that took minutes to render deserves an honest
 * histogram rather than a sampled estimate of one.
 */
export function lumaStats(png: PNG): LumaStats {
  const { width: W, height: H, data } = png;
  const band = Math.max(1, Math.round(Math.min(W, H) * EDGE_BAND_FRACTION));
  const cornerW = Math.max(1, Math.round(W * CORNER_BOX_FRACTION));
  const cornerH = Math.max(1, Math.round(H * CORNER_BOX_FRACTION));

  const bins = new Float64Array(BINS);
  let min = 1;
  let max = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  let cornerMax = 0;
  let over = 0;
  let mid = 0;

  for (let y = 0; y < H; y += 1) {
    const inTopBottomBand = y < band || y >= H - band;
    const inCornerRow = y < cornerH || y >= H - cornerH;
    const rowBase = y * W * 4;
    for (let x = 0; x < W; x += 1) {
      const i = rowBase + x * 4;
      const L = luma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);

      const binIndex = L >= 1 ? BINS - 1 : Math.floor(L * BINS);
      bins[binIndex] = (bins[binIndex] ?? 0) + 1;

      if (L < min) min = L;
      if (L > max) max = L;
      if (L > OVER_THRESHOLD) over += 1;
      if (L >= MID_BAND.lo && L <= MID_BAND.hi) mid += 1;

      if (inTopBottomBand || x < band || x >= W - band) {
        edgeSum += L;
        edgeCount += 1;
      }
      if (inCornerRow && (x < cornerW || x >= W - cornerW) && L > cornerMax) cornerMax = L;
    }
  }

  const pixels = W * H;
  return {
    width: W,
    height: H,
    pixels,
    min,
    median: medianOf(bins, pixels),
    max,
    edgeBandMean: edgeCount > 0 ? edgeSum / edgeCount : 0,
    cornerMax,
    pctOver80: (over / pixels) * 100,
    pctIn28to45: (mid / pixels) * 100,
    edgeBandPx: band,
    cornerBoxPx: { w: cornerW, h: cornerH },
  };
}

/** Bin centre at the 50% cumulative mark. */
function medianOf(bins: Float64Array, total: number): number {
  let seen = 0;
  const half = total / 2;
  for (let i = 0; i < bins.length; i += 1) {
    seen += bins[i] ?? 0;
    if (seen >= half) return (i + 0.5) / bins.length;
  }
  return 1;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

export function formatLumaStats(label: string, s: LumaStats): string {
  return [
    `${label} - composited-frame luma, ${s.width}x${s.height} (${s.pixels.toLocaleString()} px, full scan)`,
    `  min ${s.min.toFixed(4)}   median ${s.median.toFixed(4)}   max ${s.max.toFixed(4)}`,
    `  edge-band mean ${s.edgeBandMean.toFixed(4)} (outer ${s.edgeBandPx}px)`,
    `  corner max     ${s.cornerMax.toFixed(4)} (${s.cornerBoxPx.w}x${s.cornerBoxPx.h} boxes)`,
    `  over 80%       ${pct(s.pctOver80 / 100)}`,
    `  in 28-45% band ${pct(s.pctIn28to45 / 100)}`,
  ].join('\n');
}

/**
 * Whether this run actually asked for the export.
 *
 * The spec lives under e2e/, so `playwright test` and `test:gates` both collect it, and a
 * 33-megapixel software render inside the ordinary matrix would turn a gate run into an
 * hour. playwright.config.ts is shared and cannot be given a testIgnore, so the spec
 * excludes itself.
 *
 * The signal is an ENVIRONMENT VARIABLE and not `--grep`, because a worker cannot see the
 * command line: `testInfo.config.grep` reports the config's own match-everything default
 * whatever was passed on the CLI, and process.argv in a worker is the worker
 * bootstrap. Env is the only thing that survives the fork. `tools/export4k.sh` sets it.
 */
export function exportRequested(): boolean {
  return process.env['SP_EXPORT_4K'] === '1';
}

/** `SP_EXPORT_HIDE_HUD=1` produces a clean plate instead of the shipped composite. */
export function hideHudRequested(): boolean {
  return process.env['SP_EXPORT_HIDE_HUD'] === '1';
}
