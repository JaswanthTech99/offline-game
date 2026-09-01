/**
 * INCURSION - lit from below.
 *
 * The corridor is a glass curtainwall span thrown across a burning street. The floor is the
 * brightest surface in the level, which inverts every lighting habit the other universes
 * rely on: shafts climb, shadows are cast upward onto ceilings, and the thermal column
 * lifts debris past the player instead of letting it settle.
 *
 * The mote record carries speed only; the upward travel is the `glass-flake` path's own
 * behaviour, which is why the kind - not a direction field - is what selects it.
 */

import type { UniverseTheme } from '../UniverseTheme';
import { defineTheme, srgb } from './palette';

export const INCURSION: UniverseTheme = defineTheme({
  id: 'incursion',
  displayName: 'Incursion',
  unlockCostPrisms: 3200,

  // Bruised violet overhead falling to sodium fire at the horizon: the fire below the span
  // is what the sky is reflecting, so the gradient is upside-down relative to a real dusk.
  sky: {
    top: srgb('#140b1e'),
    mid: srgb('#4a2540'),
    horizon: srgb('#ffc27a'),
    low: srgb('#2a1a22'),
  },

  // Green-grey structural glazing, cyan fracture. The edge is deliberately the coldest value
  // in the universe so a break reads instantly against the sodium wash coming up through it.
  glass: {
    tint: srgb('#6f9a94'),
    alpha: 0.16,
    edge: srgb('#a8f0ff'),
    edgeAlpha: 0.55,
  },

  haze: { color: srgb('#d0a184'), density: 0.048 },
  // Just above linear: smoke is already at the player's face, but the far end of the span
  // must stay legible or the run becomes guesswork.
  fogFalloff: 1.25,

  // Few, fast and bright - flakes carried on a thermal, not dust hanging in still air.
  motes: { kind: 'glass-flake', count: 240, driftRates: [1.15, 0.72, 0.34] },

  emissive: { primary: srgb('#66e0ff'), secondary: srgb('#ff8a3d') },

  metal: srgb('#8e969e'),
  stone: srgb('#5f5a54'),
  kit: 'curtainwall-span',

  // Hard split: the fire owns the shadows, the sky owns the highlights, and the two never
  // meet in the middle. This is the strongest warm-shadow grade in the set.
  grade: { lutUrl: '/luts/incursion.cube', shadowWarmth: 0.34, highlightWarmth: -0.42 },

  battle: 'incursion-host',
});
