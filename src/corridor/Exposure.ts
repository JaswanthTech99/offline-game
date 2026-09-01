/**
 * THE EXPOSURE HISTOGRAM.
 *
 * The first build of the corridor blew out to milky white. The cause was not one bad number,
 * it was the absence of a floor: every layer added light, nothing took light away, and a
 * hundred faint translucent surfaces summed to fog. The fix is a histogram - an explicit,
 * measurable claim about how much of the frame is allowed to be bright - enforced at FOUR
 * places, because a histogram enforced at three of them is a histogram that leaks.
 *
 *   SITE 1  per-ring depth attenuation. Each further ring is drawn at LOWER group opacity,
 *           so the corridor DARKENS with distance. Fog that brightens is the failure mode.
 *   SITE 2  a clamped aperture. The vanishing point is a fixed opacity (APERTURE.op, the
 *           same number the DOM overlay knows as `--aperture-op`) with a pool of darkness
 *           composited on top of it, and the whole composite is hard-clamped.
 *   SITE 3  a black point at the frame edge. Half in-scene (before bloom can eat it) and
 *           half in the post vignette, split from ONE authored strength in core/Quality.ts.
 *   SITE 4  emissives are EXEMPT. Crystals, braziers, runes and the ball specular hotspot
 *           are pushed OUTSIDE the attenuation groups. They are the only things in the game
 *           allowed to reach full white, and they are small.
 *
 * THE RULE THAT FALLS OUT, AND IS BINDING EVERYWHERE:
 *
 *                          CONTRAST, NOT MORE GLOW.
 *
 * If something needs to read brighter, darken what is around it. Raising an emissive is the
 * last resort, never the first, because glow is additive and additive is how you get milk.
 *
 * WHY THE NUMBERS LIVE HERE AND NOT IN core/Quality.ts: they are art-direction law, not a
 * performance budget - the same on a phone and on a 4K desktop, because the histogram is the
 * LOOK. This follows the precedent already set by battle/types.ts (dramaturgy invariants) and
 * universe/LightBus.ts (semantic channel domains). Everything in this file that IS a budget -
 * ring count, vignette strength, vignette radius - is imported from core/Quality.ts and never
 * re-typed.
 */

import {
  attribute,
  clamp,
  float,
  length,
  mix,
  oneMinus,
  pow,
  saturate,
  screenUV,
  smoothstep,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { PostIntensity } from '../core/Quality';
import type { Unit } from '../core/types';
import { lightBus } from '../universe/LightBus';
import type { UniverseTheme } from '../universe/UniverseTheme';
import { luminance } from '../universe/UniverseTheme';

// ---------------------------------------------------------------------------------------
// SITE 1 - per-ring depth attenuation
// ---------------------------------------------------------------------------------------

/**
 * `curve` above 1 spends most of the fall in the first few rings, which is what makes the
 * far half of the corridor sit flat and dark instead of forming a bright grey wall. `far` is
 * deliberately not 0: a ring that vanishes entirely takes its silhouette with it and the
 * corridor loses the receding rectangle that reads as depth.
 */
export const DEPTH_ATTENUATION = Object.freeze({
  nearOpacity: 1.0,
  farOpacity: 0.14,
  curve: 1.35,
});

/** Name of the per-instance float the ring field writes its group opacity depth into. */
export const RING_DEPTH_ATTRIBUTE = 'ringDepth';

/** 0 at the camera, 1 at the far end of the ring field. */
export function ringDepth01(index: number, ringCount: number): Unit {
  if (ringCount <= 1) return 0;
  return clamp01(index / (ringCount - 1));
}

/** SITE 1, CPU side. The histogram and the GPU node below must never disagree. */
export function ringOpacity(depth01: Unit): Unit {
  const shaped = Math.pow(clamp01(depth01), DEPTH_ATTENUATION.curve);
  return DEPTH_ATTENUATION.nearOpacity + (DEPTH_ATTENUATION.farOpacity - DEPTH_ATTENUATION.nearOpacity) * shaped;
}

/** SITE 1, GPU side. Same curve as `ringOpacity`, expressed once in TSL. */
export function depthAttenuationNode(depth01: Node<'float'>): Node<'float'> {
  const shaped = pow(saturate(depth01), DEPTH_ATTENUATION.curve);
  return mix(DEPTH_ATTENUATION.nearOpacity, DEPTH_ATTENUATION.farOpacity, shaped);
}

/** The per-instance depth the ring field publishes. One value per ring, not per fragment. */
export function ringDepthAttributeNode(): Node<'float'> {
  return attribute(RING_DEPTH_ATTRIBUTE, 'float');
}

// ---------------------------------------------------------------------------------------
// SITE 2 - the clamped aperture
// ---------------------------------------------------------------------------------------

/**
 * The vanishing point. `op` is the one opacity the glow is permitted; `poolOpacity` is the
 * pool of darkness composited ON TOP of it, which turns a white blob into a thin bright rim
 * around a dark throat - the single most legible depth cue the corridor has. `ceiling` is a
 * hard clamp applied after every multiplier including the light bus, so no battle beat and
 * no theme can raise the vanishing point past it.
 *
 * Radii are in normalised frame units: 0 at frame centre, 1 at the edge midpoint,
 * sqrt(2) in the corner.
 */
export const APERTURE = Object.freeze({
  op: 0.34,
  ceiling: 0.4,
  glowInnerR: 0.0,
  glowOuterR: 0.2,
  poolOpacity: 0.62,
  poolCoreR: 0.0,
  poolEdgeR: 0.06,
  /** A point of light that covers this much of the frame has stopped being a point. */
  maxAreaShare: 0.06,
});

/** Frame corner distance in the normalised radial units used by SITES 2 and 3. */
export const CORNER_RADIAL = Math.SQRT2;

/** SITE 2, CPU side. */
export function apertureAlphaAt(radial01: number): Unit {
  const glow = 1 - smooth01(APERTURE.glowInnerR, APERTURE.glowOuterR, radial01);
  const pool = APERTURE.poolOpacity * (1 - smooth01(APERTURE.poolCoreR, APERTURE.poolEdgeR, radial01));
  return Math.min(APERTURE.ceiling, Math.max(0, glow * APERTURE.op * (1 - pool)));
}

/**
 * SITE 2, GPU side. The light bus may only ever DARKEN the aperture (`skyDim` subtracts), so
 * the peak measured by the histogram stays an upper bound no matter what the battle does.
 */
export function apertureAlphaNode(radial01: Node<'float'>): Node<'float'> {
  const glow = oneMinus(smoothstep(APERTURE.glowInnerR, APERTURE.glowOuterR, radial01));
  const pool = float(APERTURE.poolOpacity).mul(
    oneMinus(smoothstep(APERTURE.poolCoreR, APERTURE.poolEdgeR, radial01)),
  );
  const composited = glow.mul(APERTURE.op).mul(oneMinus(pool)).mul(oneMinus(lightBus.uniforms.skyDim));
  return clamp(composited, 0, APERTURE.ceiling);
}

/** Peak of the aperture composite anywhere in frame. Scanned, so it cannot drift from the curve. */
export function aperturePeak(): Unit {
  const steps = 128;
  let peak = 0;
  for (let i = 0; i <= steps; i += 1) {
    const alpha = apertureAlphaAt((i / steps) * CORNER_RADIAL);
    if (alpha > peak) peak = alpha;
  }
  return peak;
}

/**
 * The DOM overlay draws its own aperture bloom, and it must use THIS number rather than a
 * hand-tuned CSS value that drifts. One aperture opacity, two renderers.
 */
export function apertureCssVariables(): Readonly<Record<string, string>> {
  return Object.freeze({
    '--aperture-op': APERTURE.op.toFixed(4),
    '--aperture-ceiling': APERTURE.ceiling.toFixed(4),
  });
}

// ---------------------------------------------------------------------------------------
// SITE 3 - the black point at the frame edge
// ---------------------------------------------------------------------------------------

/**
 * `sceneShare` splits ONE authored vignette strength (core/Quality.ts owns the number) into
 * an in-scene term and a post term. The in-scene half matters more than it looks: it darkens
 * geometry BEFORE bloom samples it, so a glass edge in the corner cannot bloom back through
 * a vignette that is applied after it. Applying the whole vignette in post is exactly how
 * the corners went milky the first time.
 *
 * `floor` is the darkest the scene term may drive a surface. Not zero - a corner at true
 * zero reads as a rendering bug rather than as darkness.
 */
export const BLACK_POINT = Object.freeze({
  sceneShare: 0.5,
  floor: 0.06,
});

/** Radial distance from frame centre, 0..sqrt(2), in a material's fragment shader. */
export function screenRadial01Node(): Node<'float'> {
  return length(screenUV.sub(0.5).mul(2));
}

/**
 * How the one authored vignette strength is divided between the scene and the post chain.
 * Computed once, in `splitEdgeDarkening`, and threaded everywhere - so the two halves cannot
 * drift apart and cannot both claim the same darkening.
 */
export interface EdgeSplit {
  readonly sceneStrength: number;
  readonly postStrength: number;
  /** Normalised radius at which the edge term starts. From core/Quality.ts. */
  readonly radius: number;
}

/**
 * MOBILE_LOW may switch the post vignette off. When it does the in-scene term takes the whole
 * authored strength rather than half: a tier is allowed to be cheaper, it is not allowed to
 * lose the black point - that is the difference between a budget and a law.
 */
export function splitEdgeDarkening(post: PostIntensity, postVignetteEnabled: boolean): EdgeSplit {
  const share = postVignetteEnabled ? BLACK_POINT.sceneShare : 1;
  return {
    sceneStrength: post.vignetteStrength * share,
    postStrength: post.vignetteStrength * (1 - share),
    radius: post.vignetteRadius,
  };
}

/** SITE 3, CPU side. */
export function sceneEdgeFactorAt(radial01: number, edge: EdgeSplit): Unit {
  const falloff = smooth01(edge.radius, CORNER_RADIAL, radial01);
  return Math.max(BLACK_POINT.floor, 1 - edge.sceneStrength * falloff);
}

/** SITE 3, GPU side, in-scene half. Multiplied into every ATTENUATED channel's opacity. */
export function sceneEdgeNode(edge: EdgeSplit): Node<'float'> {
  const falloff = smoothstep(edge.radius, CORNER_RADIAL, screenRadial01Node());
  const darkened = oneMinus(falloff.mul(edge.sceneStrength));
  return clamp(darkened, BLACK_POINT.floor, 1);
}

/**
 * What the post agent must build its hand-rolled vignette from - r185 ships no VignetteNode.
 * The strength here is the complement of the in-scene half, so the two sum to exactly the
 * strength authored in core/Quality.ts and the edge is never darkened twice over.
 */
export interface VignetteRequest {
  readonly strength: number;
  readonly radius: number;
  readonly cornerRadial: number;
  readonly floor: number;
}

export function postVignetteRequest(edge: EdgeSplit): VignetteRequest {
  return {
    strength: edge.postStrength,
    radius: edge.radius,
    cornerRadial: CORNER_RADIAL,
    floor: BLACK_POINT.floor,
  };
}

/** CPU mirror of the post half, so the histogram can measure the frame the player sees. */
export function postVignetteFactorAt(radial01: number, edge: EdgeSplit): Unit {
  const request = postVignetteRequest(edge);
  return Math.max(request.floor, 1 - request.strength * smooth01(request.radius, request.cornerRadial, radial01));
}

// ---------------------------------------------------------------------------------------
// SITE 4 - the emissive exemption
// ---------------------------------------------------------------------------------------

/**
 * Every surface the corridor can draw, and whether it is exempt from SITES 1-3. The table is
 * the contract: `auditExposureGraph` compares it against what the ring field ACTUALLY built,
 * so an emissive that quietly ends up parented inside an attenuation group is a load-time
 * failure rather than a look nobody can explain.
 */
export type ExposureChannel =
  | 'frame'
  | 'glass'
  | 'gap'
  | 'aperture'
  | 'crystal'
  | 'brazier'
  | 'rune'
  | 'ballSpecular';

export const EXPOSURE_CHANNELS: readonly ExposureChannel[] = Object.freeze([
  'frame',
  'glass',
  'gap',
  'aperture',
  'crystal',
  'brazier',
  'rune',
  'ballSpecular',
]);

export const EMISSIVE_EXEMPT: Readonly<Record<ExposureChannel, boolean>> = Object.freeze({
  frame: false,
  glass: false,
  gap: false,
  // The aperture is not exempt in spirit - SITE 2 clamps it harder than attenuation would.
  aperture: false,
  crystal: true,
  brazier: true,
  rune: true,
  ballSpecular: true,
});

export function isEmissiveExempt(channel: ExposureChannel): boolean {
  return EMISSIVE_EXEMPT[channel];
}

/**
 * Small and bright beats big and bright. `maxAreaShare` is the whole reason the exemption is
 * safe: emissives may reach full white precisely because they occupy almost none of the frame.
 */
export const EMISSIVE = Object.freeze({
  perRingAreaShare: 0.02,
  maxAreaShare: 0.08,
  minContrastRatio: 3.0,
});

/**
 * SITE 4, GPU side. Note what is NOT here: no depth attenuation, no scene edge term. An
 * emissive channel that wants dimming with distance is asking for the wrong thing - let it
 * get small instead. The light bus is the one thing allowed to move it.
 */
export function emissiveGainNode(base: Node<'float'>): Node<'float'> {
  return base.mul(lightBus.uniforms.emisIntensity);
}

/**
 * SITES 1 and 3 composed. This is the ONLY opacity graph an attenuated corridor surface may
 * use, and the only place `ringDepthAttributeNode` is read - which is what makes "emissives
 * are outside the attenuation groups" structural rather than a matter of discipline.
 */
export function attenuatedOpacityNode(base: Node<'float'>, edge: EdgeSplit): Node<'float'> {
  const attenuated = base.mul(depthAttenuationNode(ringDepthAttributeNode()));
  return saturate(attenuated.mul(sceneEdgeNode(edge)));
}

/** What a builder claims it wired up. Compared against EMISSIVE_EXEMPT by the audit. */
export interface ExposureGraph {
  /** Channels whose materials went through `attenuatedOpacityNode`. */
  readonly attenuated: readonly ExposureChannel[];
  /** Channels parented outside every attenuation group. */
  readonly exempt: readonly ExposureChannel[];
}

/** SITE 4, enforcement. Returns every violation; empty means the graph honours the table. */
export function auditExposureGraph(graph: ExposureGraph): string[] {
  const violations: string[] = [];
  const attenuated = new Set(graph.attenuated);
  const exempt = new Set(graph.exempt);

  for (const channel of graph.attenuated) {
    if (isEmissiveExempt(channel)) {
      violations.push(`site 4: channel "${channel}" is emissive but was put inside an attenuation group`);
    }
  }
  for (const channel of graph.exempt) {
    if (!isEmissiveExempt(channel)) {
      violations.push(`site 4: channel "${channel}" is not emissive but escaped attenuation`);
    }
  }
  for (const channel of attenuated) {
    if (exempt.has(channel)) {
      violations.push(`site 4: channel "${channel}" was declared both attenuated and exempt`);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------------------
// The histogram itself
// ---------------------------------------------------------------------------------------

/**
 * 32 bins is enough to resolve a black point and a highlight shoulder and coarse enough that
 * a single sample cannot dominate a bin. The two lowest bins together are "black" - anything
 * under 1/16 luminance is indistinguishable from black on a phone in daylight.
 */
export const HISTOGRAM_BINS = 32;
export const BLACK_BINS = 2;

/**
 * The bounds the histogram is checked against. These are what "not milky" means numerically:
 * most of the frame dark, a real black end, highlights rare, and emissives at least three
 * times brighter than the brightest attenuated surface - CONTRAST, NOT MORE GLOW.
 */
export const HISTOGRAM_LAW = Object.freeze({
  maxMedianLuminance: 0.22,
  highlightThreshold: 0.7,
  maxHighlightFraction: 0.06,
  minBlackFraction: 0.15,
  maxEdgeLuminance: 0.12,
});

/** One measurable patch of the frame: how bright, how much of the screen, which channel. */
export interface ExposureSample {
  readonly channel: ExposureChannel;
  readonly luminance: number;
  /** Fraction of the frame this patch covers. All samples together should approach 1. */
  readonly screenFraction: number;
}

export interface ExposureHistogram {
  /** Weight per bin, indexed low luminance to high. Sums to `totalWeight`. */
  readonly bins: readonly number[];
  readonly totalWeight: number;
}

export interface ExposureStats {
  readonly histogram: ExposureHistogram;
  readonly medianLuminance: number;
  readonly highlightFraction: number;
  readonly blackFraction: number;
  readonly emissiveFraction: number;
  readonly peakAttenuated: number;
  readonly peakEmissive: number;
  /** peakEmissive / peakAttenuated. The number the CONTRAST rule is actually about. */
  readonly contrastRatio: number;
}

export function buildHistogram(samples: readonly ExposureSample[]): ExposureHistogram {
  const bins = new Array<number>(HISTOGRAM_BINS).fill(0);
  let totalWeight = 0;

  for (const sample of samples) {
    const weight = Math.max(0, sample.screenFraction);
    if (weight === 0) continue;
    const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor(clamp01(sample.luminance) * HISTOGRAM_BINS));
    bins[bin] = (bins[bin] ?? 0) + weight;
    totalWeight += weight;
  }

  return { bins, totalWeight };
}

export function measureExposure(samples: readonly ExposureSample[]): ExposureStats {
  const histogram = buildHistogram(samples);
  const total = histogram.totalWeight;

  let blackWeight = 0;
  for (let bin = 0; bin < BLACK_BINS; bin += 1) blackWeight += histogram.bins[bin] ?? 0;

  let highlightWeight = 0;
  let emissiveWeight = 0;
  let peakAttenuated = 0;
  let peakEmissive = 0;

  for (const sample of samples) {
    const weight = Math.max(0, sample.screenFraction);
    if (isEmissiveExempt(sample.channel)) {
      emissiveWeight += weight;
      if (sample.luminance > peakEmissive) peakEmissive = sample.luminance;
      continue;
    }
    // The milky-white test deliberately ignores emissives: they are allowed to be white, and
    // counting them would let a corridor pass by being bright in the one place it may be.
    if (sample.luminance >= HISTOGRAM_LAW.highlightThreshold) highlightWeight += weight;
    if (sample.luminance > peakAttenuated) peakAttenuated = sample.luminance;
  }

  return {
    histogram,
    medianLuminance: histogramMedian(histogram),
    highlightFraction: total > 0 ? highlightWeight / total : 0,
    blackFraction: total > 0 ? blackWeight / total : 0,
    emissiveFraction: total > 0 ? emissiveWeight / total : 0,
    peakAttenuated,
    peakEmissive,
    contrastRatio: peakAttenuated > 0 ? peakEmissive / peakAttenuated : Number.POSITIVE_INFINITY,
  };
}

/** Geometry the sample builder needs. Passed in so Exposure never imports the ring field. */
export interface CorridorExposureModel {
  readonly ringCount: number;
  readonly ringSpacing: number;
  /** Distance from the camera to the nearest ring. Sets the perspective foreshortening. */
  readonly nearPlaneDistance: number;
  /** Fraction of a ring's projected area that is glass, structure and open gap. */
  readonly glassAreaShare: number;
  readonly frameAreaShare: number;
  readonly gapAreaShare: number;
}

/**
 * Models the frame as nested projected rectangles: a ring at distance z covers a screen
 * radius proportional to 1/z, so the visible annulus of ring i is the area it owns after the
 * rings in front of it have occluded their share. First order, but it is the right first
 * order - it puts most of the frame's weight on the near rings, which is where a milky
 * corridor actually goes wrong.
 */
export function corridorExposureSamples(
  theme: UniverseTheme,
  model: CorridorExposureModel,
  edge: EdgeSplit,
): ExposureSample[] {
  const samples: ExposureSample[] = [];
  const ringCount = Math.max(1, Math.floor(model.ringCount));

  const hazeLum = luminance(theme.haze.color);
  const glassLum = luminance(theme.glass.tint);
  const frameLum = (luminance(theme.metal) + luminance(theme.stone)) * 0.5;
  const emissiveLum = Math.max(luminance(theme.emissive.primary), luminance(theme.emissive.secondary));
  const apertureLum = luminance(theme.sky.horizon);

  // Projected radius of each ring, normalised so the nearest ring reaches the frame corner.
  const radial = new Array<number>(ringCount + 1);
  for (let i = 0; i <= ringCount; i += 1) {
    const z = model.nearPlaneDistance + i * model.ringSpacing;
    radial[i] = (CORNER_RADIAL * (model.nearPlaneDistance / z));
  }
  const outerR = radial[0] ?? CORNER_RADIAL;
  const totalArea = outerR * outerR;

  for (let i = 0; i < ringCount; i += 1) {
    const rOuter = radial[i] ?? 0;
    const rInner = radial[i + 1] ?? 0;
    const ringArea = (rOuter * rOuter - rInner * rInner) / totalArea;
    if (ringArea <= 0) continue;

    const depth = ringDepth01(i, ringCount);
    const opacity = ringOpacity(depth);

    // A ring's area splits at the vignette radius: the part of the annulus outside it is
    // where SITE 3 bites, and on the near rings that is most of the frame.
    const edgeR = Math.max(edge.radius, rInner);
    const edgeArea = rOuter > edgeR ? (rOuter * rOuter - Math.max(edgeR, rInner) ** 2) / totalArea : 0;
    const centreArea = Math.max(0, ringArea - edgeArea);
    const edgeMid = (Math.max(edgeR, rInner) + rOuter) * 0.5;
    const centreMid = (rInner + Math.min(rOuter, edgeR)) * 0.5;

    const zones: readonly { readonly area: number; readonly radial: number }[] = [
      { area: centreArea, radial: centreMid },
      { area: edgeArea, radial: edgeMid },
    ];

    for (const zone of zones) {
      if (zone.area <= 0) continue;
      const edgeFactor = sceneEdgeFactorAt(zone.radial, edge) * postVignetteFactorAt(zone.radial, edge);
      const push = (channel: ExposureChannel, surfaceLum: number, alpha: number, share: number): void => {
        samples.push({
          channel,
          luminance: composite(surfaceLum, alpha, hazeLum * opacity) * edgeFactor,
          screenFraction: zone.area * share,
        });
      };
      push('glass', glassLum, theme.glass.alpha * opacity, model.glassAreaShare);
      push('frame', frameLum, opacity, model.frameAreaShare);
      push('gap', hazeLum, opacity, model.gapAreaShare);
    }

    // SITE 4: emissives take their area off the top and are never touched by opacity, by the
    // edge factor, or by the haze composite. Full theme luminance, tiny slice of the frame.
    samples.push({
      channel: 'crystal',
      luminance: emissiveLum,
      screenFraction: ringArea * EMISSIVE.perRingAreaShare,
    });
  }

  // SITE 2: whatever the innermost ring does not cover is the aperture, at its clamped peak.
  const innerR = radial[ringCount] ?? 0;
  samples.push({
    channel: 'aperture',
    luminance: composite(apertureLum, aperturePeak(), hazeLum * ringOpacity(1)),
    screenFraction: (innerR * innerR) / totalArea,
  });

  return samples;
}

/**
 * The whole histogram, checked. Returns every violation so an artist retuning a theme gets
 * the full list rather than one at a time. Never throws.
 */
export function validateExposure(
  samples: readonly ExposureSample[],
  edge: EdgeSplit,
  graph: ExposureGraph,
): string[] {
  const violations = auditExposureGraph(graph);
  const stats = measureExposure(samples);

  // SITE 1: monotone. Opacity must fall with depth, and so must the COMPOSITED luminance -
  // fading a surface into a bright haze is the exact way "attenuation" ends up brightening.
  let previousOpacity = Number.POSITIVE_INFINITY;
  for (let i = 0; i < HISTOGRAM_BINS; i += 1) {
    const opacity = ringOpacity(i / (HISTOGRAM_BINS - 1));
    if (opacity > previousOpacity + 1e-6) {
      violations.push(`site 1: ring opacity rose with depth at t=${(i / (HISTOGRAM_BINS - 1)).toFixed(3)}`);
      break;
    }
    previousOpacity = opacity;
  }
  if (DEPTH_ATTENUATION.farOpacity >= DEPTH_ATTENUATION.nearOpacity) {
    violations.push('site 1: farOpacity must be below nearOpacity or the corridor brightens with distance');
  }
  if (DEPTH_ATTENUATION.farOpacity <= 0) {
    violations.push('site 1: farOpacity must stay above 0 or the far rings lose their silhouette');
  }

  // SITE 2: the aperture is clamped and it is small.
  const peak = aperturePeak();
  if (peak > APERTURE.ceiling + 1e-6) {
    violations.push(`site 2: aperture peak ${peak.toFixed(3)} exceeds its ceiling ${APERTURE.ceiling}`);
  }
  if (APERTURE.poolOpacity <= 0) {
    violations.push('site 2: the aperture has no pool of darkness composited over it');
  }
  const apertureWeight = samples
    .filter((sample) => sample.channel === 'aperture')
    .reduce((sum, sample) => sum + sample.screenFraction, 0);
  if (apertureWeight > APERTURE.maxAreaShare) {
    violations.push(
      `site 2: the aperture covers ${(apertureWeight * 100).toFixed(1)}% of frame, over the ` +
        `${(APERTURE.maxAreaShare * 100).toFixed(1)}% a vanishing point may occupy`,
    );
  }

  // SITE 3: there is a genuine black point, and the corner reaches it.
  const cornerFactor = sceneEdgeFactorAt(CORNER_RADIAL, edge) * postVignetteFactorAt(CORNER_RADIAL, edge);
  const cornerLuminance = stats.peakAttenuated * cornerFactor;
  if (cornerLuminance > HISTOGRAM_LAW.maxEdgeLuminance) {
    violations.push(
      `site 3: frame corner sits at ${cornerLuminance.toFixed(3)} luminance, over the ` +
        `${HISTOGRAM_LAW.maxEdgeLuminance} black point`,
    );
  }
  if (stats.blackFraction < HISTOGRAM_LAW.minBlackFraction) {
    violations.push(
      `site 3: only ${(stats.blackFraction * 100).toFixed(1)}% of the frame is black, needs ` +
        `${(HISTOGRAM_LAW.minBlackFraction * 100).toFixed(1)}% - the histogram never reaches the floor`,
    );
  }

  // SITE 4: emissives are rare and they win on contrast rather than on being turned up.
  if (stats.emissiveFraction > EMISSIVE.maxAreaShare) {
    violations.push(
      `site 4: emissives cover ${(stats.emissiveFraction * 100).toFixed(1)}% of frame, over ` +
        `${(EMISSIVE.maxAreaShare * 100).toFixed(1)}% - bright everywhere is bright nowhere`,
    );
  }
  if (stats.contrastRatio < EMISSIVE.minContrastRatio) {
    violations.push(
      `site 4: emissive peak is only ${stats.contrastRatio.toFixed(2)}x the brightest attenuated ` +
        `surface, needs ${EMISSIVE.minContrastRatio}x - CONTRAST, NOT MORE GLOW`,
    );
  }

  // The milky-white guard the first build failed.
  if (stats.medianLuminance > HISTOGRAM_LAW.maxMedianLuminance) {
    violations.push(
      `histogram: median luminance ${stats.medianLuminance.toFixed(3)} over ` +
        `${HISTOGRAM_LAW.maxMedianLuminance} - the corridor is milky`,
    );
  }
  if (stats.highlightFraction > HISTOGRAM_LAW.maxHighlightFraction) {
    violations.push(
      `histogram: ${(stats.highlightFraction * 100).toFixed(1)}% of the frame is above the highlight ` +
        `threshold, over ${(HISTOGRAM_LAW.maxHighlightFraction * 100).toFixed(1)}%`,
    );
  }

  return violations;
}

/** Load-time gate. Use where a bad corridor must not reach the renderer at all. */
export function assertExposureSane(
  samples: readonly ExposureSample[],
  edge: EdgeSplit,
  graph: ExposureGraph,
): void {
  const violations = validateExposure(samples, edge, graph);
  if (violations.length > 0) {
    throw new Error(`Corridor exposure histogram violated:\n  ${violations.join('\n  ')}`);
  }
}

// ---------------------------------------------------------------------------------------

function clamp01(value: number): Unit {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** GLSL smoothstep on the CPU, so every SITE has an exact scalar mirror to be measured by. */
function smooth01(edge0: number, edge1: number, x: number): Unit {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Source-over of a surface at `alpha` onto a backdrop. How a translucent ring actually reads. */
function composite(surfaceLuminance: number, alpha: number, backdropLuminance: number): number {
  const a = clamp01(alpha);
  return surfaceLuminance * a + backdropLuminance * (1 - a);
}

function histogramMedian(histogram: ExposureHistogram): number {
  if (histogram.totalWeight <= 0) return 0;
  const half = histogram.totalWeight * 0.5;
  let running = 0;
  for (let bin = 0; bin < HISTOGRAM_BINS; bin += 1) {
    running += histogram.bins[bin] ?? 0;
    if (running >= half) return (bin + 0.5) / HISTOGRAM_BINS;
  }
  return 1;
}
