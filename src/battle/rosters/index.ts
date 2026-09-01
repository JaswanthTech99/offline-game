/**
 * The roster registry - the only place the seven casts are named.
 *
 * `BATTLE_ROSTERS` is typed as a complete `Record<BattleRosterId, BattleRoster>`, so adding an
 * id to the union in universe/UniverseTheme.ts and forgetting to build its cast is a compile
 * error here rather than an empty backdrop at runtime. `REGISTERED_ROSTER_IDS` is what theme
 * validation should be handed as its `knownRosters` argument: it proves a roster was actually
 * BUILT, which the id union on its own cannot.
 *
 * Every roster validates itself at module load through `defineRoster`, so importing this file
 * at all is already the load-time gate. `validateAllRosters()` exists for tooling that wants
 * the full list of problems instead of the first thrown one.
 */

import { BATTLE_ROSTER_IDS, type BattleRosterId } from '../../universe/UniverseTheme';
import type { BattleRoster, ParallaxTier } from '../types';
import { validateDesignedRoster, validateTierBands, type DesignedRoster, type Figure } from './design';

import { AEGIS_HOST } from './aegis-host';
import { ASHFALL_WAR } from './ashfall-war';
import { FOLDWORKS_HOST } from './foldworks-host';
import { INCURSION_HOST } from './incursion-host';
import { SALTGLASS_FLEETS } from './saltglass-fleets';
import { VOID_CHOIR } from './void-choir';
import { ZENITH_ASCENDANTS } from './zenith-ascendants';

export type {
  AttributeForm,
  DesignedRoster,
  DominantAttribute,
  Figure,
  SilhouetteDesign,
  Stance,
} from './design';
export { MAX_FIGURES_PER_ROSTER, MIN_FIGURES_PER_ROSTER, tierFigureCap } from './design';

const DESIGNED_ROSTERS: Readonly<Record<BattleRosterId, DesignedRoster>> = Object.freeze({
  'void-choir': VOID_CHOIR,
  'incursion-host': INCURSION_HOST,
  'aegis-host': AEGIS_HOST,
  'saltglass-fleets': SALTGLASS_FLEETS,
  'foldworks-host': FOLDWORKS_HOST,
  'ashfall-war': ASHFALL_WAR,
  'zenith-ascendants': ZENITH_ASCENDANTS,
});

/** What the backdrop renderer consumes. */
export const BATTLE_ROSTERS: Readonly<Record<BattleRosterId, BattleRoster>> = Object.freeze({
  'void-choir': VOID_CHOIR.roster,
  'incursion-host': INCURSION_HOST.roster,
  'aegis-host': AEGIS_HOST.roster,
  'saltglass-fleets': SALTGLASS_FLEETS.roster,
  'foldworks-host': FOLDWORKS_HOST.roster,
  'ashfall-war': ASHFALL_WAR.roster,
  'zenith-ascendants': ZENITH_ASCENDANTS.roster,
});

/**
 * Proof of registration for `validateTheme(theme, knownRosters)`. Built from the record rather
 * than from the id union, so a theme can never point at a roster that only exists as a name.
 */
export const REGISTERED_ROSTER_IDS: ReadonlySet<BattleRosterId> = new Set(
  BATTLE_ROSTER_IDS.filter((id) => Object.hasOwn(BATTLE_ROSTERS, id)),
);

export function getRoster(id: BattleRosterId): BattleRoster {
  return BATTLE_ROSTERS[id];
}

/** The cast with its design records attached - review tooling and the contact sheet. */
export function getFigures(id: BattleRosterId): readonly Figure[] {
  return DESIGNED_ROSTERS[id].figures;
}

/** One depth plane's cast, in authored order. The renderer draws a tier at a time. */
export function figuresInTier(id: BattleRosterId, tier: ParallaxTier): readonly Figure[] {
  return DESIGNED_ROSTERS[id].figures.filter((figure) => figure.tier === tier);
}

/**
 * Every violation in every roster, plus the checks that only make sense across the whole set.
 * Empty array means the whole battle layer is legal.
 */
export function validateAllRosters(): string[] {
  const violations: string[] = [...validateTierBands()];
  // Figure ids are roster-local by contract, but the silhouette contact sheet keys images by
  // id across all seven, so a collision would silently drop a figure from review.
  const seenFigureIds = new Set<string>();

  for (const id of BATTLE_ROSTER_IDS) {
    const designed = DESIGNED_ROSTERS[id];
    if (designed.roster.id !== id) {
      violations.push(`registry: key "${id}" holds a roster that calls itself "${designed.roster.id}"`);
    }
    violations.push(...validateDesignedRoster(designed));

    for (const figure of designed.figures) {
      if (seenFigureIds.has(figure.id)) {
        violations.push(`registry: figure id "${figure.id}" is used by more than one roster`);
      }
      seenFigureIds.add(figure.id);
    }
  }

  return violations;
}
