/**
 * A vignette node, hand-rolled in TSL because r185 ships no VignetteNode. (Verified against
 * the installed three/examples/jsm/tsl/display/ - every other stage in our chain has a
 * library node; this one does not.)
 *
 * Two decisions here are worth more than the maths:
 *
 * 1. THE CORE SITS ABOVE THE GEOMETRIC CENTRE. In a first-person corridor runner the eye
 *    lives on the vanishing point, which the camera holds slightly above frame centre so the
 *    floor reads as floor. Centring the vignette on the frame instead of on the vanishing
 *    point puts the brightest part of the image on the floor and the darkest on the thing the
 *    player is aiming at, which is exactly backwards.
 *
 * 2. THE CORNER DARKENING IS HARD-CAPPED, INDEPENDENTLY OF STRENGTH. The run's ball count is
 *    HUD text in a bottom corner, and decision 1 pushes MORE darkness into the bottom of the
 *    frame than into the top. Without a ceiling, raising `vignetteStrength` for cinematic
 *    reasons silently makes the one number the player must read at a glance unreadable. The
 *    ceiling is a product constraint wearing a shader's clothes: do not remove it, and do not
 *    raise it without re-checking the HUD against the darkest universe.
 */

import type { Node, UniformNode } from 'three/webgpu';
import { Vector2 } from 'three/webgpu';
import { length, min, oneMinus, screenUV, smoothstep, uniform, vec4 } from 'three/tsl';

/**
 * Where the darkening sits in the frame, as opposed to how strong it is. These are frame-
 * relative and therefore identical on a phone and on a 4K display, which is why they are not
 * a Quality tier row: Quality.ts owns `vignetteStrength` and `vignetteRadius`, the two numbers
 * that genuinely vary per tier, and PostChain feeds them in.
 *
 * TODO(step-2): if art direction wants the bias or the ceiling to differ per universe, they
 * move into UniverseTheme.grade as theme data - not into a tier table, because they are a
 * look, not a budget.
 */
export const VIGNETTE_SHAPE = Object.freeze({
  /**
   * Fraction of frame HEIGHT the bright core sits above centre, in three's screenUV space
   * where y = 0 is the bottom of the frame. Positive moves the core up. If a backend ever
   * reports the opposite handedness the `centre` uniform is the single knob that fixes it.
   */
  centreBiasY: 0.06,
  /** Width of the falloff ramp, in the same normalised frame units as `radius`. */
  softness: 0.55,
  /**
   * Hard ceiling on how much light the vignette may remove, whatever `strength` says.
   * Deliberately below three of the four tiers' vignetteStrength, so the clamp is LIVE in
   * shipping config rather than a theoretical guard - on ULTRA_4K, DESKTOP_HIGH and
   * MOBILE_HIGH the corners land on THIS number, not on the strength value.
   *
   * Measured against the Quality tiers, the darkening this shape produces is:
   *   ULTRA_4K   frame centre 0.00 | top edge 0.03 | bottom edge 0.23 | any corner 0.30
   *   MOBILE_LOW frame centre 0.00 | top edge 0.00 | bottom edge 0.13 | any corner 0.26
   * i.e. the bottom of the frame carries ~7x the top's weight (decision 1 doing its job)
   * while the HUD corner never drops below 70% of its lit luminance (decision 2 doing its).
   */
  maxCornerAlpha: 0.3,
});

export interface VignetteUniforms {
  /** Peak darkening before the corner ceiling clamps it. Quality: vignetteStrength. */
  readonly strength: UniformNode<'float', number>;
  /** Normalised frame radius at which the falloff starts. Quality: vignetteRadius. */
  readonly radius: UniformNode<'float', number>;
  readonly softness: UniformNode<'float', number>;
  /** Frame-space centre of the bright core. Bias above 0.5 in y - see decision 1. */
  readonly centre: UniformNode<'vec2', Vector2>;
  readonly maxCornerAlpha: UniformNode<'float', number>;
}

export interface VignetteStage {
  readonly node: Node<'vec4'>;
  readonly uniforms: VignetteUniforms;
}

export interface VignetteConfig {
  readonly strength: number;
  readonly radius: number;
}

/**
 * Multiplies `input` by a frame-relative elliptical falloff. Deliberately elliptical rather
 * than circular: a circle inscribed in a 21:9 window crushes the left and right edges long
 * before it touches the corners, which reads as a lens defect instead of an authored frame.
 *
 * Runs pre-tonemap on linear HDR, which is correct - real optical falloff is a multiply on
 * radiance, not a black overlay on display values.
 */
export function vignette(input: Node<'vec4'>, config: VignetteConfig): VignetteStage {
  const uniforms: VignetteUniforms = {
    strength: uniform(config.strength).setName('vignetteStrength'),
    radius: uniform(config.radius).setName('vignetteRadius'),
    softness: uniform(VIGNETTE_SHAPE.softness).setName('vignetteSoftness'),
    centre: uniform(new Vector2(0.5, 0.5 + VIGNETTE_SHAPE.centreBiasY)).setName('vignetteCentre'),
    maxCornerAlpha: uniform(VIGNETTE_SHAPE.maxCornerAlpha).setName('vignetteMaxCornerAlpha'),
  };

  // Remap to [-1,1] on both axes so the falloff tracks the frame's own aspect and the maths
  // needs no resolution uniform at all - one fewer thing to keep in sync on a resize.
  const offset = screenUV.sub(uniforms.centre).mul(2);
  const distance = length(offset);

  const falloff = smoothstep(uniforms.radius, uniforms.radius.add(uniforms.softness), distance);
  const darkening = min(falloff.mul(uniforms.strength), uniforms.maxCornerAlpha);

  const node = vec4(input.rgb.mul(oneMinus(darkening)), input.a);

  return { node, uniforms };
}
