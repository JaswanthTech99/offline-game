/**
 * Glass that behaves optically instead of reading as tinted card.
 *
 * Six properties, each independently switchable so the A/B gate can name what changed:
 *   1 fresnel     edge brightens hard at grazing, near-invisible face-on
 *   2 bevel       physical thickness - a second, tighter highlight inside the border
 *   3 refraction  backbuffer sampled through a normal-driven offset (ULTRA_4K only)
 *   4 streak      specular smear that tracks the key light across the surface
 *   5 microNoise  low-amplitude surface break-up so no pane is mathematically flat
 *   6 caustic     handled by the caller: a coloured pool projected on the floor below
 *
 * Every one is tier-gated by the caller through GlassFeatures rather than read from a
 * global, so the degradation table stays the single place that decides what a tier gets.
 */

import type { Node } from 'three/webgpu';
import { Color, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  dot,
  float,
  mix,
  mx_noise_float,
  normalize,
  normalView,
  positionView,
  positionWorld,
  pow,
  fwidth,
  smoothstep,
  uv,
  vec2,
  vec3,
  viewportSharedTexture,
  screenUV,
} from 'three/tsl';

export interface GlassFeatures {
  readonly fresnel: boolean;
  readonly bevel: boolean;
  readonly refraction: boolean;
  readonly streak: boolean;
  readonly microNoise: boolean;
}

export const GLASS_ALL: GlassFeatures = Object.freeze({
  fresnel: true, bevel: true, refraction: true, streak: true, microNoise: true,
});
export const GLASS_NONE: GlassFeatures = Object.freeze({
  fresnel: false, bevel: false, refraction: false, streak: false, microNoise: false,
});

/** Breakable glass owns the reserved hue. Decorative glass must never read as a target. */
export type GlassRole = 'breakable' | 'decorative';

export interface GlassOptions {
  readonly role: GlassRole;
  readonly tint: Color;
  readonly edge: Color;
  /** Where the key light sits, so the specular streak knows which way to smear. */
  readonly keyDirection: readonly [number, number, number];
  /** The reserved hue. Distinct from `edge` because a theme's edge may be pure white, and
   *  a white rim reads as an unshaded debug quad rather than as glass. */
  readonly rimColour: Color;
  readonly features: GlassFeatures;
  /** Base opacity face-on. Grazing angles climb from here toward 1. */
  readonly baseOpacity: number;
}

/**
 * Legibility constants. These outrank physical correctness on purpose: a pane the player
 * cannot see is a pane they fly into, and "physically correct Fresnel" was making panes
 * near-invisible at exactly the angle the game is always viewed from - straight on.
 */
const LEGIBILITY = Object.freeze({
  /**
   * Rim width in DEVICE PIXELS, held constant with fwidth() rather than in UV space. A
   * world-space border shrinks with distance and falls under one pixel around 40m, which is
   * where panes were vanishing; a pixel-space one cannot.
   */
  rimPixels: 2.6,
  /** Never let the rim fall below this fraction of a pane, however far away it is. */
  rimMinUv: 0.02,
  /** How far above local background the rim sits. Additive, so it survives any backdrop. */
  rimGain: 1.25,
  /** Inner contact darkening, so a pane still separates when it overlaps a bright strip. */
  shadeWidthPixels: 5.0,
  shadeDepth: 0.55,
  /**
   * Face-on floor opacity. Physically too high for glass; legibly necessary, and 0.16 was
   * not enough of it. Measured against the corridor at 10m the interior sat 0.0011 above
   * its own background - the middle of the pane was, to within a thousandth, the wall
   * behind it. That is what a "hollow cyan rectangle" IS: not a rim that is too bright, but
   * a face that is not there. The rim/interior ratio never caught it because the interior
   * reads bright when the BACKGROUND is bright; interior-minus-background is the number.
   */
  faceFloor: 0.24,
  decorativeDim: 0.12,
  /**
   * Decorative glass is deliberately MORE opaque than breakable. Counter-intuitive until
   * you measure it: a transparent decorative pane lets the bright aperture through and
   * reads as brighter than the target in front of it. Opaque neutral grey reads as wall.
   */
  decorativeOpacity: 0.72,
  /**
   * CORNER BRACKETS, not a continuous outline. A closed rectangle of uniform stroke is the
   * universal visual language for "selected object", and the eye reads it as an annotation
   * laid over the scene rather than as an edge belonging to a surface. Four L-shaped arms
   * say "framed pane" instead. Fraction of the half-extent each arm runs from its corner.
   */
  bracketArm: 0.22,
  /**
   * The continuous edge is kept, but faint. A pane with NO edge at all loses its silhouette
   * against a bright strip; a pane with a uniform bright one is a selection box. Faint edge
   * plus bright corners reads as a framed sheet of glass, which is what it is.
   */
  rimFaintGain: 0.06,
  /**
   * How far a BREAKABLE pane's body colour is pulled from the theme's glass tint towards
   * the reserved hue. void-cathedral's tint is #dfe9ec - chroma 0.019, which is white with
   * a rumour of blue - so all the cyan a player ever saw came from the rim. The moment the
   * face was given real presence it diluted the pane towards that near-white and the face
   * chroma fell from 0.081 to 0.034. If the face is going to be most of the pixels, the
   * face is what has to carry the reserved hue.
   */
  breakableTintMix: 0.78,
  bracketFeatherUv: 0.02,
  /**
   * A BROAD facet catch across the whole face. Exponent near 1 on purpose: the existing
   * `streak` is a tight lobe that lands as a small hotspot, and a hotspot is not a surface.
   * A wide sheen gradient is what tells the eye there is a plane here at all.
   */
  faceSpecPower: 1.6,
  faceSpecGain: 0.18,
});

const SHAPE = Object.freeze({
  /** How sharply the Fresnel term ramps. 5 is the Schlick exponent; glass reads best higher. */
  fresnelPower: 2.2,
  /** Fraction of the pane's half-width the bevel occupies. */
  bevelWidth: 0.055,
  bevelGain: 2.4,
  refractionStrength: 0.018,
  streakSharpness: 42,
  streakGain: 0.9,
  noiseScale: 26,
  noiseAmount: 0.055,
});

/**
 * A pane's optical response. Built once per (theme, feature-set) and shared by every pane,
 * because a per-pane material would cost a draw call each and defeat the instancing.
 */
export function glassMaterial(options: GlassOptions): MeshStandardNodeMaterial {
  const { features: f } = options;

  const material = new MeshStandardNodeMaterial({
    color: new Color().copy(options.tint),
    transparent: true,
    roughness: 0.06,
    metalness: 0.0,
    depthWrite: false,
  });

  // View-space Fresnel. abs() so both faces of a thin pane behave, rather than the back
  // face going black the moment the camera crosses its plane.
  const viewDir = normalize(positionView.negate());
  const facing = abs(dot(normalize(normalView), viewDir)).clamp(0, 1);
  const fresnel = pow(facing.oneMinus(), float(SHAPE.fresnelPower));

  // Distance to the nearest pane border, in [0,0.5] - the bevel and the edge both key off it.
  const centred = uv().sub(vec2(0.5, 0.5)).abs();
  const borderDistance = float(0.5).sub(centred.x.max(centred.y));
  const bevel = smoothstep(float(SHAPE.bevelWidth), float(0), borderDistance);

  // Specular streak: a tight lobe around the key direction that slides as the pane turns.
  const key = normalize(vec3(...options.keyDirection));
  const streak = pow(dot(normalize(normalView), key).clamp(0, 1), float(SHAPE.streakSharpness));

  // Surface break-up, in world space so neighbouring panes never share a pattern.
  const noise = mx_noise_float(positionWorld.mul(float(SHAPE.noiseScale)));

  // ---- the legibility rim ------------------------------------------------------------
  // fwidth() is the UV distance covered by one device pixel, so dividing by it converts a
  // pixel width into UV space per-fragment. That is what makes the rim the SAME apparent
  // thickness at 10m and at 100m, which no world-space border can do.
  const uvPixel = fwidth(uv()).x.max(fwidth(uv()).y).max(float(1e-5));
  const rimUv = uvPixel.mul(float(LEGIBILITY.rimPixels)).max(float(LEGIBILITY.rimMinUv));
  const rim = smoothstep(rimUv, float(0), borderDistance);

  // CORNER BRACKETS. `centred` is |uv - 0.5| per axis, so `0.5 - centred.x` is the distance
  // to the nearest vertical edge and `centred.y` says how close to a corner we are along the
  // other axis. An arm is therefore "on an edge AND near a corner", and the max() of the two
  // orientations gives four Ls. No geometry, no extra draw - the same fwidth-derived width
  // as the rim, so the brackets stay pixel-constant with distance exactly as it does.
  const armEdge = float(0.5 - LEGIBILITY.bracketArm);
  const armFeather = armEdge.sub(float(LEGIBILITY.bracketFeatherUv));
  const armX = smoothstep(armFeather, armEdge, centred.x);
  const armY = smoothstep(armFeather, armEdge, centred.y);
  const edgeX = smoothstep(rimUv, float(0), float(0.5).sub(centred.x));
  const edgeY = smoothstep(rimUv, float(0), float(0.5).sub(centred.y));
  const bracket = edgeX.mul(armY).max(edgeY.mul(armX));

  // The broad facet catch - see LEGIBILITY.faceSpecPower.
  const faceSpec = pow(
    dot(normalize(normalView), key).clamp(0, 1),
    float(LEGIBILITY.faceSpecPower),
  );

  // Contact darkening just inside the rim. Without it a pane overlapping a bright ceiling
  // strip loses its silhouette entirely - the rim and the background both read as light.
  const shadeUv = uvPixel.mul(float(LEGIBILITY.shadeWidthPixels));
  const shade = smoothstep(shadeUv.add(rimUv), rimUv, borderDistance).mul(float(LEGIBILITY.shadeDepth));

  const isBreakable = options.role === 'breakable';
  // A hittable pane's BODY carries the reserved hue - see LEGIBILITY.breakableTintMix.
  if (isBreakable) material.color.lerp(options.rimColour, LEGIBILITY.breakableTintMix);
  let emissive: Node<'vec3'> = vec3(0, 0, 0);
  const edgeColour = vec3(options.edge.r, options.edge.g, options.edge.b);
  // Rim carries the RESERVED HUE, never the theme's raw edge colour: void-cathedral's edge
  // is #ffffff, and a pure-white outline is exactly the "unshaded debug quad" read.
  const rimColour = vec3(options.rimColour.r, options.rimColour.g, options.rimColour.b);

  if (isBreakable) {
    // Additive and ungated by tier: the rim is not an effect, it is how a target is read.
    // Bright at the corners, faint all the way round: the silhouette stays sealed and the
    // eye still gets an unambiguous 'framed pane' rather than an annotation stroke.
    emissive = emissive.add(rimColour.mul(bracket).mul(float(LEGIBILITY.rimGain)));
    emissive = emissive.add(rimColour.mul(rim).mul(float(LEGIBILITY.rimFaintGain)));
    // The face gets its own light, so the middle is a surface rather than a hole with a
    // border around it. White, not the reserved hue: this is a highlight, not a target cue.
    emissive = emissive.add(edgeColour.mul(faceSpec).mul(float(LEGIBILITY.faceSpecGain)));
  }
  if (f.fresnel) emissive = emissive.add(edgeColour.mul(fresnel).mul(float(isBreakable ? 1 : 0.25)));
  if (f.bevel && isBreakable) emissive = emissive.add(rimColour.mul(bevel).mul(float(SHAPE.bevelGain * 0.5)));
  // Streak is a target cue too - it was ungated, which let a decorative pane flash as
  // brightly as a breakable one at close range and broke the greyscale read entirely.
  if (f.streak && isBreakable) emissive = emissive.add(rimColour.mul(streak).mul(float(SHAPE.streakGain * 0.6)));

  material.emissiveNode = isBreakable
    ? emissive
    : emissive.mul(float(LEGIBILITY.decorativeDim));

  // Opacity is the property that makes it read as glass rather than plastic: nearly clear
  // face-on, nearly solid at grazing incidence.
  // A floor under face-on opacity, so a pane viewed dead-on is never invisible.
  const floorOpacity = float(Math.max(options.baseOpacity, LEGIBILITY.faceFloor));
  let opacity: Node<'float'> = floorOpacity;
  if (f.fresnel) opacity = mix(floorOpacity, float(1), fresnel);
  if (f.bevel) opacity = opacity.add(bevel.mul(float(0.5)));
  if (f.microNoise) opacity = opacity.add(noise.mul(float(SHAPE.noiseAmount)));
  if (isBreakable) opacity = opacity.add(bracket).add(rim.mul(float(0.15)));
  // Contact darkening removes light rather than adding it, which is what separates the
  // pane from a bright background instead of competing with it.
  opacity = opacity.sub(shade.mul(float(0.25))).clamp(0, 1);
  material.opacityNode = opacity;

  if (!isBreakable) {
    // Neutral, and opaque enough that nothing bright behind it can masquerade as a rim.
    material.color.setRGB(0.20, 0.22, 0.25);
    // FULLY opaque, and it must be: at 0.72 the HDR aperture behind it bled through and
    // saturated to 100% luma, making scenery read brighter than the target in front of it.
    // The breakable pane only escaped this because its rim drives opacity to 1 and blocks
    // the same glow. Decorative glass is a grey wall panel, not a window.
    material.transparent = false;
    material.depthWrite = true;
    material.opacityNode = float(1);
    // Rough enough that it cannot return a hot specular. At 0.55 it caught the key light
    // and read at 100% luma from 20-30m - brighter than the target in front of it, which
    // inverts the whole point of reserving brightness for hittables.
    material.roughnessNode = float(0.92);
    material.metalnessNode = float(0);
  }

  if (f.refraction) {
    // Real refraction: the backbuffer, sampled through an offset driven by the surface
    // normal. Cheap, and correct enough that geometry behind a pane visibly displaces.
    const offset = normalView.xy.mul(float(SHAPE.refractionStrength));
    const behind = viewportSharedTexture(screenUV.add(offset));
    material.colorNode = mix(behind.rgb, vec3(options.tint.r, options.tint.g, options.tint.b), float(0.45));
  }

  if (f.microNoise) {
    material.roughnessNode = float(0.06).add(noise.abs().mul(float(0.12)));
  }

  return material;
}
