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

export interface GlassOptions {
  readonly tint: Color;
  readonly edge: Color;
  /** Where the key light sits, so the specular streak knows which way to smear. */
  readonly keyDirection: readonly [number, number, number];
  readonly features: GlassFeatures;
  /** Base opacity face-on. Grazing angles climb from here toward 1. */
  readonly baseOpacity: number;
}

const SHAPE = Object.freeze({
  /** How sharply the Fresnel term ramps. 5 is the Schlick exponent; glass reads best higher. */
  fresnelPower: 5.5,
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

  let emissive: Node<'vec3'> = vec3(0, 0, 0);
  const edgeColour = vec3(options.edge.r, options.edge.g, options.edge.b);

  if (f.fresnel) emissive = emissive.add(edgeColour.mul(fresnel));
  if (f.bevel) emissive = emissive.add(edgeColour.mul(bevel).mul(float(SHAPE.bevelGain)));
  if (f.streak) emissive = emissive.add(edgeColour.mul(streak).mul(float(SHAPE.streakGain)));

  material.emissiveNode = emissive;

  // Opacity is the property that makes it read as glass rather than plastic: nearly clear
  // face-on, nearly solid at grazing incidence.
  let opacity: Node<'float'> = float(options.baseOpacity);
  if (f.fresnel) opacity = mix(float(options.baseOpacity), float(1), fresnel);
  if (f.bevel) opacity = opacity.add(bevel.mul(float(0.5))).clamp(0, 1);
  if (f.microNoise) opacity = opacity.add(noise.mul(float(SHAPE.noiseAmount))).clamp(0, 1);
  material.opacityNode = opacity;

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
