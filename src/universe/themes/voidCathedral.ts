/**
 * VOID CATHEDRAL - the reference record.
 *
 * The architecture has no colour of its own. Metal, stone and glass are all near-neutral,
 * separated only by how they respond to light, so every hue the player sees is evidence of a
 * light source rather than a painted surface. Read this file first when authoring a new
 * universe: anything the other six do that this one does not is an extra, and an extra has
 * to earn its cost.
 *
 * Free to enter (0 prisms) because it is also the tutorial ground: the emptiest corridor is
 * the one where a new player can actually read a pane of glass against the background.
 */

import type { UniverseTheme } from '../UniverseTheme';
import { defineTheme, srgb } from './palette';

export const VOID_CATHEDRAL: UniverseTheme = defineTheme({
  id: 'void-cathedral',
  displayName: 'Void Cathedral',
  unlockCostPrisms: 0,

  // Near-black nave, bone-white horizon. The gap between `low` and `horizon` is the widest
  // of any universe: with no colour to carry depth, contrast has to carry all of it.
  sky: {
    top: srgb('#05070b'),
    mid: srgb('#131b26'),
    horizon: srgb('#f4f1e9'),
    low: srgb('#090c11'),
  },

  // Barely-there tint and an almost fully opaque white edge: the pane is invisible until it
  // catches the horizon, and the fracture line is the brightest thing in the frame.
  glass: {
    tint: srgb('#dfe9ec'),
    alpha: 0.1,
    edge: srgb('#ffffff'),
    edgeAlpha: 0.94,
  },

  haze: { color: srgb('#c9d6da'), density: 0.045 },
  // Above 1 holds the haze off the lens and packs it into the far half of the corridor, so
  // the vault reads as deep rather than as fogged.
  fogFalloff: 1.85,

  // Dust that has been falling in here for centuries: slow, and slower still with distance.
  motes: { kind: 'bone-dust', count: 900, driftRates: [0.42, 0.26, 0.11] },

  // The only two chromatic values in the universe, and both are lights, not materials.
  emissive: { primary: srgb('#7fdfff'), secondary: srgb('#eaf4ff') },

  metal: srgb('#9aa3a8'),
  stone: srgb('#b9bcb6'),
  kit: 'kit-rectilinear-void',

  // Warm shadows against cool highlights - the gentlest split in the set, because a strong
  // grade would reintroduce exactly the colour the architecture spends its whole budget
  // keeping out.
  grade: { lutUrl: '/luts/void-cathedral.cube', shadowWarmth: 0.18, highlightWarmth: -0.3 },

  battle: 'void-choir',
});
