/**
 * ASHFALL - opaque by default.
 *
 * The corridor is backlit oiled paper. In its resting state the player can see the pane they
 * are about to break and almost nothing beyond it; the war on the backdrop is the only thing
 * that ever reveals the level ahead, and it does so through the light bus rather than through
 * any change to this record. That is the point of the universe: the theme is deliberately
 * unreadable and the battle is what makes it playable.
 *
 * Everything here is tuned to sit one flash away from legible - not two, and never zero.
 */

import type { UniverseTheme } from '../UniverseTheme';
import { defineTheme, glow, srgb } from './palette';

/**
 * The fracture line is an ember, not a highlight. At unit range #ff4f22 is a good deal DARKER
 * than the paper it cracks, so an LDR edge would read as a line of soot on a lit screen - and
 * the "edge must outglow tint" law would reject it, correctly. The gain keeps the authored
 * hue exactly and puts the value where an emitter belongs: above 1, where bloom finds it and
 * where the light bus can drive it harder still when the war flares.
 */
const EMBER_EDGE_GAIN = 2.6;

export const ASHFALL: UniverseTheme = defineTheme({
  id: 'ashfall',
  displayName: 'Ashfall',
  unlockCostPrisms: 4800,

  sky: {
    top: srgb('#14101c'),
    mid: srgb('#2b2333'),
    horizon: srgb('#ffd6a1'),
    low: srgb('#7a2f18'),
  },

  // Oiled paper, not glass: a warm parchment tint at .17 that scatters rather than transmits.
  glass: {
    tint: srgb('#cbb894'),
    alpha: 0.17,
    edge: glow('#ff4f22', EMBER_EDGE_GAIN),
    edgeAlpha: 0.6,
  },

  haze: { color: srgb('#8c7f78'), density: 0.052 },
  // Below 1 on purpose - the only sub-linear falloff in the set. It pulls the haze onto the
  // lens so the corridor ahead is milk at rest, and a distant flash has to burn through it to
  // show the player anything.
  fogFalloff: 0.95,

  // The densest mote field in the game by a factor of nearly two: falling ash with paper
  // charms turning over in it. The fall is the `ash-ofuda` path's own behaviour; the record
  // only sets how fast each parallax layer carries it.
  motes: { kind: 'ash-ofuda', count: 1400, driftRates: [0.7, 0.44, 0.2] },

  emissive: { primary: srgb('#ff3d1e'), secondary: srgb('#ffab4d') },

  metal: srgb('#4a453f'),
  stone: srgb('#6b665c'),
  kit: 'ashfall-shrine-approach',

  // Cold shadow, warm highlight: the shrine's own lamps are the warm end and the ash-choked
  // sky is the cold one, so a flash reads as heat arriving rather than as exposure rising.
  grade: { lutUrl: '/luts/ashfall.cube', shadowWarmth: -0.34, highlightWarmth: 0.46 },

  battle: 'ashfall-war',
});
