/**
 * SALTGLASS - the only universe whose horizon line moves.
 *
 * The corridor is rigging strung between hulls on open water, and the bright sky band
 * pitches and rolls with the swell up to nine degrees. Everything in this record is chosen to
 * survive that: the horizon has to stay the brightest stop at every angle of the roll, so it
 * is pushed further from `mid` than anywhere else, and the sun-warmed `low` band that would
 * normally sit below the waterline is bright enough to read when the roll lifts it into view.
 *
 * Salt is the material story - the glass is thick and green, the fittings are corroded brass,
 * and the air is never clear.
 */

import type { UniverseTheme } from '../UniverseTheme';
import { defineTheme, srgb } from './palette';

export const SALTGLASS: UniverseTheme = defineTheme({
  id: 'saltglass',
  displayName: 'Saltglass',
  unlockCostPrisms: 2600,

  sky: {
    top: srgb('#0e2350'),
    mid: srgb('#2b6f8e'),
    horizon: srgb('#ffe2ab'),
    low: srgb('#b8763f'),
  },

  // The heaviest tint in the set: this glass is thick, cast, and full of salt. Alpha .34 and
  // an amber edge at .90 mean a pane announces itself long before it is in range - the roll
  // already costs the player enough reading time.
  glass: {
    tint: srgb('#6fd3bb'),
    alpha: 0.34,
    edge: srgb('#ffbf5c'),
    edgeAlpha: 0.9,
  },

  haze: { color: srgb('#e7c79b'), density: 0.058 },
  // Barely above linear: sea haze starts at the lens. Anything steeper would leave a clean
  // pocket of air around the player that no one has ever seen on open water.
  fogFalloff: 1.1,

  // Spray and burnt sail cloth on a crosswind - the fastest horizontal drift in the set.
  motes: { kind: 'spray-sail-ash', count: 420, driftRates: [1.4, 0.88, 0.41] },

  emissive: { primary: srgb('#ffb43c'), secondary: srgb('#4ff2d6') },

  metal: srgb('#c08a3e'),
  stone: srgb('#6d7671'),
  kit: 'saltglass-rigging',

  // Cold sea-shadow against warm low sun. The split does double duty here: it is also what
  // keeps the rolling horizon legible when the bright band swings off-centre.
  grade: { lutUrl: '/luts/saltglass.cube', shadowWarmth: -0.38, highlightWarmth: 0.46 },

  battle: 'saltglass-fleets',
});
