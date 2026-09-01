/**
 * Theme authoring primitives shared by the seven universe records.
 *
 * Palettes are authored as sRGB hex because that is what a colour picker hands an artist.
 * `Color` converts to the linear working space in its constructor (ColorManagement is on by
 * default in r185), so every luminance comparison validateTheme() makes is already a
 * linear-light comparison - there is no decode step to forget and no place to forget it.
 */

import { Color } from 'three/webgpu';
import type { UniverseTheme } from '../UniverseTheme';

/** Narrow enough to catch a missing `#`, loose enough to stay readable in the tables. */
export type HexColor = `#${string}`;

/**
 * Theme colours are shared across every material in the game and are never per-instance
 * state, so they are frozen at construction: an accidental `theme.metal.multiplyScalar(2)`
 * throws on the frame it runs instead of silently re-tinting one universe from inside
 * another. Consumers `.copy()` into their own Color before mutating.
 */
export function srgb(hex: HexColor): Color {
  return Object.freeze(new Color(hex));
}

/**
 * A colour authored deliberately above unit range.
 *
 * Some fracture lines are embers rather than highlights: the authored hue is exactly right
 * but its unit-range luminance sits BELOW the glass it cracks, which would read as a line of
 * soot and rightly trips the "edge must outglow tint" check. Gain preserves the authored
 * chromaticity to the digit and moves the value to where an emitter actually lives - above
 * 1.0, where bloom and the light bus can reach it.
 */
export function glow(hex: HexColor, gain: number): Color {
  return Object.freeze(new Color(hex).multiplyScalar(gain));
}

function freezeDeep<T extends object>(value: T): T {
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const child: unknown = (value as unknown as Record<string, unknown>)[key];
    if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) {
      freezeDeep(child);
    }
  }
  return value;
}

/**
 * The authoring entry point for a theme record. Deep-freezes the whole tree because a theme
 * is read by dozens of systems and written by none; validation lives in the registry so a
 * single import of `universe/registry` checks all seven at once rather than each module
 * paying for itself.
 */
/**
 * The steel ball's colour, which is the one surface in the game that must NOT re-tint per
 * universe: the player has to recognise their own ammunition at a glance in all seven, and a
 * ball that borrowed the theme would vanish against the corridor it is thrown down. It lives
 * here anyway because this directory is where colour is allowed to be authored - the rule is
 * about where hexes are written, not about how many themes read them.
 */
export const BALL_PALETTE = Object.freeze({
  /** Dark forged steel. Deliberately not chrome: chrome mirrors the corridor and disappears. */
  steel: '#9aa3ab' as HexColor,
  /** Warm specular hotspot, so the key light reads as a light rather than a white dot. */
  hotspot: '#fff4e2' as HexColor,
  /** Cool rim, which is what separates the silhouette from a dark pane behind it. */
  rim: '#bcd7ff' as HexColor,
});

export function defineTheme(theme: UniverseTheme): UniverseTheme {
  return freezeDeep(theme);
}
