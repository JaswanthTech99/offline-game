/**
 * ZENITH FIELD - no floor.
 *
 * A stratospheric arena. There is no ground plane anywhere in the level, so the corridor has
 * nothing to cast a shadow onto and nothing to occlude the sky; depth is carried entirely by
 * haze, by mote parallax and by the beam clashes on the backdrop. The theme is therefore the
 * thinnest in the set - the least haze, the faintest glass, the coldest metal - and the light
 * bus does more of the work here than anywhere else.
 *
 * The most expensive universe to unlock, and the last one authored: it only reads correctly
 * once a player already knows what a corridor with a floor looks like.
 */

import type { UniverseTheme } from '../UniverseTheme';
import { defineTheme, srgb } from './palette';

export const ZENITH_FIELD: UniverseTheme = defineTheme({
  id: 'zenith-field',
  displayName: 'Zenith Field',
  unlockCostPrisms: 5400,

  sky: {
    top: srgb('#060a18'),
    mid: srgb('#123a5e'),
    horizon: srgb('#eaf6ff'),
    low: srgb('#0a1424'),
  },

  // The faintest pane in the game at .08 - eight thousand metres of thin air behind it and no
  // floor to catch a reflection, so the white edge at .80 is very nearly all the player has
  // to aim at.
  glass: {
    tint: srgb('#a8d8f0'),
    alpha: 0.08,
    edge: srgb('#ffffff'),
    edgeAlpha: 0.8,
  },

  haze: { color: srgb('#7fb2d8'), density: 0.03 },
  // The thinnest air and the steepest falloff in the set: nothing at all near the player, a
  // clean milky wall at the far end. With no floor plane, that wall is the only depth cue the
  // geometry provides.
  fogFalloff: 2.4,

  // Sparks riding an updraft - the fastest mote field in the game, and the reason the empty
  // space between structures still reads as moving.
  motes: { kind: 'updraft-spark', count: 600, driftRates: [1.6, 0.98, 0.45] },

  emissive: { primary: srgb('#9fe8ff'), secondary: srgb('#ffcf5c') },

  metal: srgb('#c6d2dc'),
  stone: srgb('#8a94a0'),
  kit: 'kit-rectilinear-void',

  // Warm shadow against a cool highlight, held gently: at this altitude the sky IS the key
  // light, and a heavy grade would tint the one surface - the horizon band - that the whole
  // universe is read against.
  grade: { lutUrl: '/luts/zenith-field.cube', shadowWarmth: 0.3, highlightWarmth: -0.36 },

  battle: 'zenith-ascendants',
});
