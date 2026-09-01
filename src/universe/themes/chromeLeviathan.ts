/**
 * CHROME LEVIATHAN - the corridor is a moving part.
 *
 * Twice a loop the glass tube the player is inside hinges through 180 degrees as the machine
 * around it reconfigures. The palette exists to make that survivable: the sky gradient reads
 * the same way inverted (a dark cool top, a hot horizon band, a warm oil-stained floor
 * colour), so a player halfway through the hinge is never looking at a frame that gives the
 * wrong up.
 *
 * Materials are shop-floor honest - unpainted alloy, oil-darkened stone, and cyan machine
 * light against the orange of whatever is being cut.
 */

import type { UniverseTheme } from '../UniverseTheme';
import { defineTheme, srgb } from './palette';

export const CHROME_LEVIATHAN: UniverseTheme = defineTheme({
  id: 'chrome-leviathan',
  displayName: 'Chrome Leviathan',
  unlockCostPrisms: 4200,

  sky: {
    top: srgb('#10151f'),
    mid: srgb('#2c3a4e'),
    horizon: srgb('#f6e6c0'),
    low: srgb('#5a4634'),
  },

  glass: {
    tint: srgb('#8fb2a8'),
    alpha: 0.16,
    edge: srgb('#a9ecff'),
    edgeAlpha: 0.62,
  },

  haze: { color: srgb('#b9a184'), density: 0.048 },
  // Oil mist: thicker than clean air, thinner than the sea. Mid falloff keeps the moving
  // machinery beyond the tube readable through the hinge, which is the whole set piece.
  fogFalloff: 1.35,

  // Swarf - hot metal shavings thrown off the cut. Sparse and quick; a heavy mote field would
  // smear into streaks the moment the tube starts rotating.
  motes: { kind: 'swarf-flake', count: 220, driftRates: [0.95, 0.6, 0.28] },

  emissive: { primary: srgb('#8ce6ff'), secondary: srgb('#ff7a2b') },

  metal: srgb('#aeb8c2'),
  stone: srgb('#726b60'),
  kit: 'kit-foldworks',

  // Warm shadow, cool highlight - the same polarity as Incursion, and for the same reason:
  // the heat source is below and inside the structure, the cold light is the sky outside it.
  grade: { lutUrl: '/luts/chrome-leviathan.cube', shadowWarmth: 0.38, highlightWarmth: -0.42 },

  battle: 'foldworks-host',
});
