/**
 * THE UNIVERSE REGISTRY.
 *
 * One table, seven records, no branching. Everything downstream - the corridor generator, the
 * glass material, the mote system, the grade pass, the unlock screen - reads a universe from
 * here and nothing else, which is what keeps "a universe is data" true instead of merely
 * intended. Adding an eighth universe is a new file in `themes/` and one line in `THEMES`.
 *
 * Each theme lives in `themes/<id>.ts` (camelCased to match the sibling kit modules), so the
 * mapping below can be audited by eye; a key that disagrees with the record's own `id` is
 * caught by the dev assertion at the bottom rather than left to a screenshot review.
 */

import { assertThemeValid, UNIVERSE_IDS } from './UniverseTheme';
import type { UniverseId, UniverseTheme } from './UniverseTheme';
import { AEGIS_LINE } from './themes/aegisLine';
import { ASHFALL } from './themes/ashfall';
import { CHROME_LEVIATHAN } from './themes/chromeLeviathan';
import { INCURSION } from './themes/incursion';
import { SALTGLASS } from './themes/saltglass';
import { VOID_CATHEDRAL } from './themes/voidCathedral';
import { ZENITH_FIELD } from './themes/zenithField';

/**
 * Keyed by `UniverseId` rather than declared as an array, so the compiler - not a test -
 * is what fails when a universe is added to the union and nobody authors its theme.
 */
export const THEMES: Readonly<Record<UniverseId, UniverseTheme>> = Object.freeze({
  'void-cathedral': VOID_CATHEDRAL,
  incursion: INCURSION,
  'aegis-line': AEGIS_LINE,
  saltglass: SALTGLASS,
  'chrome-leviathan': CHROME_LEVIATHAN,
  ashfall: ASHFALL,
  'zenith-field': ZENITH_FIELD,
});

export function getTheme(id: UniverseId): UniverseTheme {
  return THEMES[id];
}

/**
 * Progression order. Sorted once at module load because the unlock screen re-reads it on
 * every open and the answer never changes; ties break on id so the list is stable rather
 * than dependent on the engine's sort.
 */
const BY_UNLOCK_COST: readonly UniverseTheme[] = Object.freeze(
  UNIVERSE_IDS.map((id) => THEMES[id]).sort((a, b) =>
    a.unlockCostPrisms === b.unlockCostPrisms
      ? a.id.localeCompare(b.id, 'en')
      : a.unlockCostPrisms - b.unlockCostPrisms,
  ),
);

/** Cheapest first. The unlock screen renders this order verbatim. */
export function listThemes(): readonly UniverseTheme[] {
  return BY_UNLOCK_COST;
}

// Vite replaces `import.meta.env.DEV` with a literal, so this block is dead code eliminated
// from the production bundle. It runs at import time on purpose: a theme that breaks an art
// direction law should fail on the developer's first load, not in a screenshot review.
if (import.meta.env.DEV) {
  const problems: string[] = [];
  for (const id of UNIVERSE_IDS) {
    const theme = THEMES[id];
    if (theme.id !== id) {
      problems.push(`registry: THEMES["${id}"] holds a theme whose own id is "${theme.id}"`);
    }
    try {
      assertThemeValid(theme);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length > 0) {
    throw new Error(`Universe registry is invalid:\n${problems.join('\n')}`);
  }
}
