/**
 * A universe is DATA. There is exactly one corridor renderer, one glass material and one
 * mote system; a universe swaps the numbers they read and nothing else. If shipping a new
 * universe ever requires a new `if` in a renderer, the universe system has failed.
 *
 * `validateTheme` is what makes that claim enforceable rather than aspirational: it turns
 * the three art-direction laws into assertions that fail at load, in tooling and in tests.
 */

import type { Color } from 'three/webgpu';

export type UniverseId =
  | 'void-cathedral'
  | 'incursion'
  | 'aegis-line'
  | 'saltglass'
  | 'chrome-leviathan'
  | 'ashfall'
  | 'zenith-field';

/** What drifts through the air. Drives which mote instancing path and sprite atlas run. */
export type MoteKind =
  | 'bone-dust'
  | 'glass-flake'
  | 'civic-ash'
  | 'spray-sail-ash'
  | 'swarf-flake'
  | 'ash-ofuda'
  | 'updraft-spark';

/** Which greeble/structure module set the corridor generator draws rings from. */
export type ArchitectureKitId =
  | 'kit-rectilinear-void'
  | 'olympus-colonnade'
  | 'ragnarok-bifrost-span'
  | 'curtainwall-span'
  | 'saltglass-rigging'
  | 'kit-foldworks'
  | 'ashfall-shrine-approach';

/** A cast of silhouettes plus the beat timeline they perform on the parallax backdrop. */
export type BattleRosterId =
  | 'void-choir'
  | 'incursion-host'
  | 'aegis-host'
  | 'saltglass-fleets'
  | 'foldworks-host'
  | 'ashfall-war'
  | 'zenith-ascendants';

export const UNIVERSE_IDS: readonly UniverseId[] = Object.freeze([
  'void-cathedral',
  'incursion',
  'aegis-line',
  'saltglass',
  'chrome-leviathan',
  'ashfall',
  'zenith-field',
]);

export const MOTE_KINDS: readonly MoteKind[] = Object.freeze([
  'bone-dust',
  'glass-flake',
  'civic-ash',
  'spray-sail-ash',
  'swarf-flake',
  'ash-ofuda',
  'updraft-spark',
]);

export const ARCHITECTURE_KIT_IDS: readonly ArchitectureKitId[] = Object.freeze([
  'kit-rectilinear-void',
  'olympus-colonnade',
  'ragnarok-bifrost-span',
  'curtainwall-span',
  'saltglass-rigging',
  'kit-foldworks',
  'ashfall-shrine-approach',
]);

export const BATTLE_ROSTER_IDS: readonly BattleRosterId[] = Object.freeze([
  'void-choir',
  'incursion-host',
  'aegis-host',
  'saltglass-fleets',
  'foldworks-host',
  'ashfall-war',
  'zenith-ascendants',
]);

const DECLARED_ROSTERS: ReadonlySet<BattleRosterId> = new Set(BATTLE_ROSTER_IDS);

export interface UniverseTheme {
  readonly id: UniverseId;
  readonly displayName: string;
  readonly unlockCostPrisms: number;
  /** Four-stop vertical gradient. HORIZON IS ALWAYS THE BRIGHTEST STOP - see law 1. */
  readonly sky: { readonly top: Color; readonly mid: Color; readonly horizon: Color; readonly low: Color };
  readonly glass: { readonly tint: Color; readonly alpha: number; readonly edge: Color; readonly edgeAlpha: number };
  readonly haze: { readonly color: Color; readonly density: number };
  readonly fogFalloff: number;
  readonly motes: {
    readonly kind: MoteKind;
    readonly count: number;
    /** Drift speed per parallax layer, near to far. Must descend: far layers move slower. */
    readonly driftRates: readonly [number, number, number];
  };
  readonly emissive: { readonly primary: Color; readonly secondary: Color };
  readonly metal: Color;
  readonly stone: Color;
  readonly kit: ArchitectureKitId;
  /** shadowWarmth and highlightWarmth ALWAYS have opposite signs - see law 2. */
  readonly grade: { readonly lutUrl: string; readonly shadowWarmth: number; readonly highlightWarmth: number };
  readonly battle: BattleRosterId | null;
}

/**
 * Rec.709 relative luminance. three.js Colors are linear-sRGB once ColorManagement is on
 * (it is, by default, in r185), so the coefficients apply directly with no decode step.
 */
export function luminance(color: Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/** Laws are the non-negotiable art direction; sanity checks are ordinary data hygiene. */
const LAW_1 = 'law 1 (bright horizon)';
const LAW_2 = 'law 2 (opposed grade warmth)';
const LAW_3 = 'law 3 (roster exists)';

const inRange = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max;

/**
 * Returns every violation found, empty array means valid. Never throws and never stops at
 * the first problem: an artist fixing a theme wants the whole list, not a game of
 * whack-a-mole through eight reload cycles.
 *
 * @param knownRosters override to check against the rosters actually registered at runtime
 *   rather than merely declared in the BattleRosterId union.
 */
export function validateTheme(
  theme: UniverseTheme,
  knownRosters: ReadonlySet<BattleRosterId> = DECLARED_ROSTERS,
): string[] {
  const violations: string[] = [];
  const where = `theme "${theme.id}"`;

  // Law 1 - the horizon is the light source the whole corridor reads against. If any other
  // stop outglows it the depth cue inverts and the corridor looks like a flat painted tube.
  const stops = [
    { name: 'top', lum: luminance(theme.sky.top) },
    { name: 'mid', lum: luminance(theme.sky.mid) },
    { name: 'low', lum: luminance(theme.sky.low) },
  ];
  const horizonLum = luminance(theme.sky.horizon);
  for (const stop of stops) {
    if (stop.lum >= horizonLum) {
      violations.push(
        `${LAW_1}: ${where} sky.${stop.name} luminance ${stop.lum.toFixed(4)} >= sky.horizon ${horizonLum.toFixed(4)}`,
      );
    }
  }

  // Law 2 - a grade that warms both ends is just an exposure change. The split is the look.
  const { shadowWarmth, highlightWarmth } = theme.grade;
  if (!Number.isFinite(shadowWarmth) || !Number.isFinite(highlightWarmth)) {
    violations.push(`${LAW_2}: ${where} grade warmth values must be finite`);
  } else if (shadowWarmth === 0 || highlightWarmth === 0) {
    violations.push(`${LAW_2}: ${where} grade warmth values must be non-zero to have a sign`);
  } else if (Math.sign(shadowWarmth) === Math.sign(highlightWarmth)) {
    violations.push(
      `${LAW_2}: ${where} shadowWarmth ${shadowWarmth} and highlightWarmth ${highlightWarmth} share a sign`,
    );
  }

  // Law 3 - a theme pointing at a roster that was never built shows an empty backdrop, and
  // an empty backdrop reads as a bug rather than as calm.
  if (theme.battle !== null && !knownRosters.has(theme.battle)) {
    violations.push(`${LAW_3}: ${where} names battle roster "${theme.battle}" which is not registered`);
  }

  if (!Number.isInteger(theme.unlockCostPrisms) || theme.unlockCostPrisms < 0) {
    violations.push(`sanity: ${where} unlockCostPrisms must be a non-negative integer`);
  }
  if (theme.displayName.trim().length === 0) {
    violations.push(`sanity: ${where} displayName is empty`);
  }
  if (!inRange(theme.glass.alpha, 0, 1)) {
    violations.push(`sanity: ${where} glass.alpha ${theme.glass.alpha} out of 0..1`);
  }
  if (!inRange(theme.glass.edgeAlpha, 0, 1)) {
    violations.push(`sanity: ${where} glass.edgeAlpha ${theme.glass.edgeAlpha} out of 0..1`);
  }
  if (luminance(theme.glass.edge) <= luminance(theme.glass.tint)) {
    violations.push(`sanity: ${where} glass.edge must outglow glass.tint or fracture lines vanish`);
  }
  if (!(Number.isFinite(theme.haze.density) && theme.haze.density >= 0)) {
    violations.push(`sanity: ${where} haze.density must be finite and >= 0`);
  }
  if (!(Number.isFinite(theme.fogFalloff) && theme.fogFalloff > 0)) {
    violations.push(`sanity: ${where} fogFalloff must be finite and > 0`);
  }
  if (!Number.isInteger(theme.motes.count) || theme.motes.count < 0) {
    violations.push(`sanity: ${where} motes.count must be a non-negative integer`);
  }
  const [near, mid, far] = theme.motes.driftRates;
  if (!(near > mid && mid > far)) {
    violations.push(
      `sanity: ${where} motes.driftRates [${near}, ${mid}, ${far}] must descend near-to-far or parallax inverts`,
    );
  }
  if (theme.grade.lutUrl.trim().length === 0) {
    violations.push(`sanity: ${where} grade.lutUrl is empty`);
  }

  return violations;
}

/** Load-time gate. Use in theme registration so a bad theme never reaches the renderer. */
export function assertThemeValid(
  theme: UniverseTheme,
  knownRosters?: ReadonlySet<BattleRosterId>,
): void {
  const violations = knownRosters === undefined
    ? validateTheme(theme)
    : validateTheme(theme, knownRosters);
  if (violations.length > 0) {
    throw new Error(`Invalid UniverseTheme:\n  ${violations.join('\n  ')}`);
  }
}
