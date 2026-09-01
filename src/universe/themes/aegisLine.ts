/**
 * AEGIS LINE - the only universe with a high sun.
 *
 * A monument-scale civic colonnade at hard noon. Everywhere else the light rakes in from the
 * horizon; here it comes down almost vertically, so shadows are short, contrast is brutal and
 * the corridor is read by its cast shadows on the floor rather than by its silhouette.
 *
 * Law 1 still holds and is not a contradiction: the sun disc is a light, not a sky stop. The
 * brightest BAND of the gradient remains the horizon haze, where the noon glare piles up
 * against the atmosphere.
 */

import type { UniverseTheme } from '../UniverseTheme';
import { defineTheme, srgb } from './palette';

export const AEGIS_LINE: UniverseTheme = defineTheme({
  id: 'aegis-line',
  displayName: 'Aegis Line',
  unlockCostPrisms: 2000,

  sky: {
    top: srgb('#0b1430'),
    mid: srgb('#1d3a6b'),
    horizon: srgb('#f2e4c4'),
    low: srgb('#0a1020'),
  },

  // Cold civic glazing with a gilt fracture: the break line is the one warm thing on an
  // otherwise blue-grey pane, which is what makes it findable in the noon glare.
  glass: {
    tint: srgb('#b9d4ea'),
    alpha: 0.12,
    edge: srgb('#ffe9a8'),
    edgeAlpha: 0.7,
  },

  haze: { color: srgb('#9fb6cf'), density: 0.05 },
  // The clearest air in the set. A steep falloff keeps the near colonnade crisp so the hard
  // noon shadows stay readable, and lets haze accumulate only in the deep distance.
  fogFalloff: 2.1,

  // Ash off a civic fire, drifting in still hot air: plentiful, unhurried, evenly graded.
  motes: { kind: 'civic-ash', count: 700, driftRates: [0.55, 0.34, 0.16] },

  emissive: { primary: srgb('#ffd76a'), secondary: srgb('#6fb6ff') },

  metal: srgb('#b9c2cc'),
  stone: srgb('#ded6c4'),
  kit: 'olympus-colonnade',

  // Inverted relative to the fire universes: sunlit stone goes warm and the sky-filled
  // shadows go cold. The largest highlight push in the set, because noon is the subject.
  grade: { lutUrl: '/luts/aegis-line.cube', shadowWarmth: -0.3, highlightWarmth: 0.52 },

  battle: 'aegis-host',
});
