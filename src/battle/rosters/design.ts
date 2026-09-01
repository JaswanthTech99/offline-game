/**
 * THE SILHOUETTE DESIGN LAYER - what decides whether a backdrop figure reads at all.
 *
 * A battle figure is a black shape a long way off, routinely forty pixels tall on a phone.
 * At that size the figure IS its outline: no interior detail, no colour, no shading, no
 * texture. Everything below exists to keep authoring honest about that, because the failure
 * mode is silent - a roster full of unreadable smudges still compiles, still animates, and
 * still looks like a bug to the player.
 *
 * The four rules the validator enforces:
 *
 *  1. ONE dominant attribute plus ONE stance per figure, and no two figures in a roster may
 *     share BOTH. Sharing both makes two figures the same figure at any distance. Sharing an
 *     attribute inside a single tier is also refused: same depth, same shape, same read.
 *  2. The attribute must be real geometry. `AttributeForm` has exactly two members because
 *     there are exactly two ways an attribute survives forty pixels - it stands clear of the
 *     body, or it is a hole punched clean through it. Rim strokes, glows, auras, shrouds,
 *     smoke, spray and trailing cloth all disappear into the outline or into the haze, so
 *     none of them is expressible here. That is deliberate: the type is the rule.
 *  3. Depth is carried by SIZE and OPACITY, in disjoint per-tier bands. Position alone does
 *     not read as distance on a backdrop that scrolls.
 *  4. Two figures in the same tier may not overlap. Silhouettes at one depth that touch stop
 *     being two figures.
 *
 * The dramaturgy laws (an envelope must fit inside its own beat, a smother must darken, a
 * strike must snap) live here for the same reason the timeline laws live in battle/types.ts:
 * they bound what a beat MEANS. Every performance number still comes from core/Quality.ts -
 * see `tierFigureCap`, which reads the real instance caps rather than restating them.
 *
 * IP: every figure authored against this module is original. Archetypes and primary-source
 * mythology only - a mass, an attribute and a stance, never anyone's character.
 */

import { QUALITY, TIERS } from '../../core/Quality';
import { assertNever, type Millis, type Unit } from '../../core/types';
import {
  LIGHT_BUS_NEUTRAL,
  LIGHT_CHANNELS,
  LIGHT_CHANNEL_RANGE,
  type LightBusState,
} from '../../universe/LightBus';
import type { BattleRosterId } from '../../universe/UniverseTheme';
import {
  PARALLAX_TIERS,
  validateRoster,
  type BattleRoster,
  type Beat,
  type BeatId,
  type BeatTimeline,
  type Combatant,
  type LightEventShape,
  type ParallaxTier,
} from '../types';

/**
 * The attribute vocabulary. Every member is a MASS with an outline of its own: a rack, a
 * bundle, a drum, a cavity. There is no member for a stroke, a glow or a veil, and adding
 * one would break rule 2 for every roster at once.
 */
export type DominantAttribute =
  | 'anchor-chain'
  | 'antler-rack'
  | 'ballast-stone'
  | 'banner-cross'
  | 'bell-tree'
  | 'boarding-gaff'
  | 'brazier-bowl'
  | 'cantilever-arm'
  | 'claw-hook'
  | 'conical-hat'
  | 'counterweight-boom'
  | 'crest-fin'
  | 'drill-cone'
  | 'forked-bolt'
  | 'hinge-stack'
  | 'hollow-crown'
  | 'kite-frame'
  | 'ladder-back'
  | 'lantern-cage'
  | 'mask-plate'
  | 'mast-spar'
  | 'net-drum'
  | 'pike-bundle'
  | 'quiver-rack'
  | 'ring-blade'
  | 'saw-comb'
  | 'scaffold-yoke'
  | 'spool-drum'
  | 'split-jaw'
  | 'tail-fluke'
  | 'thermal-vane'
  | 'torii-yoke'
  | 'tower-shield'
  | 'tuning-spire'
  | 'void-cavity'
  | 'wheel-rim'
  | 'harpoon-rig'
  | 'censer-chain';

/**
 * Stance is the second half of the read and it is a WHOLE-BODY pose, never a gesture: at
 * forty pixels a turned wrist is nothing and a shifted centre of mass is everything.
 */
export type Stance =
  | 'aloft'
  | 'braced'
  | 'climbing'
  | 'coiled'
  | 'crouched'
  | 'falling'
  | 'hunched'
  | 'kneeling'
  | 'leaning'
  | 'lunging'
  | 'pivoting'
  | 'planted'
  | 'prone'
  | 'reared'
  | 'reeling'
  | 'seated'
  | 'striding'
  | 'suspended'
  | 'tethered'
  | 'wading';

/**
 * The only two ways an attribute survives the forty-pixel test.
 *
 * `detached-mass`  - the attribute does not touch the body. A quiver rack planted beside a
 *                    kneeling archer, a ballast stone already cut loose and falling. Read as
 *                    a second shape, so it cannot be absorbed by the first.
 * `evenodd-hole`   - the attribute is negative space cut through the body with a real
 *                    even-odd hole. A helm whose eye slot is a void, a wheel read by its
 *                    spoke gaps. Read as light through the figure, which no amount of
 *                    distance flattens away.
 *
 * There is no third member on purpose. An attribute laid ON the body merges with it and is
 * gone by the time the figure is forty pixels tall.
 */
export type AttributeForm = 'detached-mass' | 'evenodd-hole';

export interface SilhouetteDesign {
  readonly attribute: DominantAttribute;
  readonly form: AttributeForm;
  readonly stance: Stance;
  /** One line, for review and for the silhouette contact sheet. Never shown to the player. */
  readonly note: string;
}

/** A combatant carrying the design record that justifies its shape. */
export interface Figure extends Combatant {
  readonly design: SilhouetteDesign;
}

export interface DesignedRoster {
  /** What the renderer consumes. Its `combatants` are the same objects as `figures`. */
  readonly roster: BattleRoster;
  /** What review tooling consumes: the same cast, with the design record attached. */
  readonly figures: readonly Figure[];
}

/** Authoring laws. Counts and shapes of the CAST, not of the frame budget. */
export const MIN_FIGURES_PER_ROSTER = 8;
export const MAX_FIGURES_PER_ROSTER = 12;
/** A strike that ramps is a swell wearing the wrong label; the snap is the whole read. */
export const STRIKE_MAX_ATTACK_MS: Millis = 120;
/** A swell that snaps is a strike. Below this the shape stops being a rise. */
export const SWELL_MIN_ATTACK_MS: Millis = 400;
export const MAX_NOTE_CHARS = 160;

interface TierBand {
  readonly widthFrac: readonly [Unit, Unit];
  readonly heightFrac: readonly [Unit, Unit];
  readonly opacity: readonly [Unit, Unit];
}

/**
 * Disjoint by construction: no width, height or opacity value is legal in two tiers. That is
 * what makes depth survive a backdrop that slides horizontally, where vertical position is
 * the least reliable cue there is.
 */
const TIER_BANDS: Readonly<Record<ParallaxTier, TierBand>> = Object.freeze({
  horizon: {
    widthFrac: [0.03, 0.09],
    heightFrac: [0.06, 0.19],
    opacity: [0.26, 0.46],
  },
  mid: {
    widthFrac: [0.1, 0.19],
    heightFrac: [0.2, 0.44],
    opacity: [0.5, 0.74],
  },
  fore: {
    widthFrac: [0.21, 0.36],
    heightFrac: [0.46, 0.82],
    opacity: [0.78, 0.96],
  },
});

/** Anchors are fractions of the backdrop, so this is the frame, not a budget. */
const X_FRAC_LIMIT = 1;
const Y_FRAC_MIN = -0.25;
const Y_FRAC_MAX = 1;

/**
 * Tightest per-tier instance cap across every graphics tier, read from core/Quality.ts.
 *
 * A figure costs at least one instance, so a roster over this cap at authoring time can
 * never be drawn whole on the lowest tier - the renderer would have to drop cast members and
 * the performance would differ by device. Necessary but not sufficient: a `flock` figure
 * spends many instances, and the renderer meters that against the same budget at runtime.
 */
export function tierFigureCap(tier: ParallaxTier): number {
  let cap = Number.POSITIVE_INFINITY;
  for (const graphics of TIERS) {
    cap = Math.min(cap, QUALITY[graphics].battleInstanceCaps[tier]);
  }
  return cap;
}

interface LitBeatSpec {
  readonly id: BeatId;
  readonly title: string;
  readonly atMs: Millis;
  readonly durationMs: Millis;
  /** 700-800ms, enforced upstream: light and pressure arriving together read as a filter. */
  readonly pressureDelayMs: Millis;
  readonly shape: LightEventShape;
  readonly attackMs: Millis;
  readonly holdMs: Millis;
  readonly releaseMs: Millis;
  readonly peak: Partial<LightBusState>;
}

/** A beat that moves the light bus. Flattened so one authored beat is one object literal. */
export function lit(spec: LitBeatSpec): Beat {
  return {
    id: spec.id,
    title: spec.title,
    atMs: spec.atMs,
    durationMs: spec.durationMs,
    pressureDelayMs: spec.pressureDelayMs,
    quiet: false,
    light: {
      shape: spec.shape,
      attackMs: spec.attackMs,
      holdMs: spec.holdMs,
      releaseMs: spec.releaseMs,
      peak: spec.peak,
    },
  };
}

/**
 * A beat that fires nothing at all. `pressureDelayMs` is zero because the delay measures the
 * gap after a flash, and there is no flash here - the loop simply breathes.
 */
export function rest(spec: {
  readonly id: BeatId;
  readonly title: string;
  readonly atMs: Millis;
  readonly durationMs: Millis;
}): Beat {
  return {
    id: spec.id,
    title: spec.title,
    atMs: spec.atMs,
    durationMs: spec.durationMs,
    pressureDelayMs: 0,
    quiet: true,
    light: null,
  };
}

const inBand = (value: number, band: readonly [number, number]): boolean =>
  Number.isFinite(value) && value >= band[0] && value <= band[1];

const raisesLight = (peak: Partial<LightBusState>): boolean =>
  (peak.emisIntensity ?? LIGHT_BUS_NEUTRAL.emisIntensity) > LIGHT_BUS_NEUTRAL.emisIntensity ||
  (peak.shaftOpacity ?? LIGHT_BUS_NEUTRAL.shaftOpacity) > LIGHT_BUS_NEUTRAL.shaftOpacity ||
  (peak.brazierGlow ?? LIGHT_BUS_NEUTRAL.brazierGlow) > LIGHT_BUS_NEUTRAL.brazierGlow ||
  (peak.rimBoost ?? LIGHT_BUS_NEUTRAL.rimBoost) > LIGHT_BUS_NEUTRAL.rimBoost;

const lowersLight = (peak: Partial<LightBusState>): boolean =>
  (peak.skyDim ?? LIGHT_BUS_NEUTRAL.skyDim) > LIGHT_BUS_NEUTRAL.skyDim ||
  (peak.emisIntensity ?? LIGHT_BUS_NEUTRAL.emisIntensity) < LIGHT_BUS_NEUTRAL.emisIntensity;

/**
 * Self-check on the band table itself. A later edit that lets two tiers overlap destroys the
 * depth cue for every roster simultaneously, which is exactly the kind of change nobody
 * notices in review.
 */
export function validateTierBands(): string[] {
  const violations: string[] = [];
  const ordered: readonly ParallaxTier[] = PARALLAX_TIERS;

  for (let i = 1; i < ordered.length; i += 1) {
    const nearerTier = ordered[i];
    const fartherTier = ordered[i - 1];
    if (nearerTier === undefined || fartherTier === undefined) continue;
    const nearer = TIER_BANDS[nearerTier];
    const farther = TIER_BANDS[fartherTier];
    const keys: readonly (keyof TierBand)[] = ['widthFrac', 'heightFrac', 'opacity'];
    for (const key of keys) {
      if (nearer[key][0] <= farther[key][1]) {
        violations.push(
          `bands: ${nearerTier}.${key} starts at ${nearer[key][0]} but ${fartherTier}.${key} ` +
            `runs to ${farther[key][1]} - overlapping bands stop reading as depth`,
        );
      }
    }
  }

  return violations;
}

function validateFigures(rosterId: BattleRosterId, figures: readonly Figure[]): string[] {
  const violations: string[] = [];
  const where = `roster "${rosterId}"`;

  if (figures.length < MIN_FIGURES_PER_ROSTER || figures.length > MAX_FIGURES_PER_ROSTER) {
    violations.push(
      `design: ${where} fields ${figures.length} figures, must field ` +
        `${MIN_FIGURES_PER_ROSTER}-${MAX_FIGURES_PER_ROSTER}`,
    );
  }

  // Rule 1: the pair is the identity. Attributes additionally stay unique within one tier.
  const seenPairs = new Set<string>();
  const seenTierAttributes = new Set<string>();
  const tierCounts = new Map<ParallaxTier, number>();

  for (const figure of figures) {
    const { attribute, stance, form, note } = figure.design;
    const pair = `${attribute}+${stance}`;
    if (seenPairs.has(pair)) {
      violations.push(
        `design: ${where} figure "${figure.id}" repeats the pair ${pair} - two figures ` +
          `agreeing on attribute AND stance are one figure drawn twice`,
      );
    }
    seenPairs.add(pair);

    const tierAttribute = `${figure.tier}/${attribute}`;
    if (seenTierAttributes.has(tierAttribute)) {
      violations.push(
        `design: ${where} figure "${figure.id}" repeats attribute "${attribute}" inside the ` +
          `${figure.tier} tier - same depth, same shape, same read`,
      );
    }
    seenTierAttributes.add(tierAttribute);

    tierCounts.set(figure.tier, (tierCounts.get(figure.tier) ?? 0) + 1);

    if (note.trim().length === 0) {
      violations.push(`design: ${where} figure "${figure.id}" has no design note`);
    }
    if (note.includes('\n') || note.length > MAX_NOTE_CHARS) {
      violations.push(
        `design: ${where} figure "${figure.id}" design note must be one line of at most ` +
          `${MAX_NOTE_CHARS} characters`,
      );
    }
    // Narrowed by the type; the check exists so a widened union cannot slip past review.
    if (form !== 'detached-mass' && form !== 'evenodd-hole') {
      violations.push(`design: ${where} figure "${figure.id}" attribute form "${String(form)}" cannot survive 40px`);
    }

    const band = TIER_BANDS[figure.tier];
    if (!inBand(figure.widthFrac, band.widthFrac)) {
      violations.push(
        `design: ${where} figure "${figure.id}" widthFrac ${figure.widthFrac} outside the ` +
          `${figure.tier} band [${band.widthFrac[0]}, ${band.widthFrac[1]}]`,
      );
    }
    if (!inBand(figure.heightFrac, band.heightFrac)) {
      violations.push(
        `design: ${where} figure "${figure.id}" heightFrac ${figure.heightFrac} outside the ` +
          `${figure.tier} band [${band.heightFrac[0]}, ${band.heightFrac[1]}]`,
      );
    }
    if (!inBand(figure.opacity, band.opacity)) {
      violations.push(
        `design: ${where} figure "${figure.id}" opacity ${figure.opacity} outside the ` +
          `${figure.tier} band [${band.opacity[0]}, ${band.opacity[1]}]`,
      );
    }
    if (!(Number.isFinite(figure.anchor.xFrac) && Math.abs(figure.anchor.xFrac) <= X_FRAC_LIMIT)) {
      violations.push(`design: ${where} figure "${figure.id}" anchor.xFrac ${figure.anchor.xFrac} is off the backdrop`);
    }
    if (!inBand(figure.anchor.yFrac, [Y_FRAC_MIN, Y_FRAC_MAX])) {
      violations.push(`design: ${where} figure "${figure.id}" anchor.yFrac ${figure.anchor.yFrac} is off the backdrop`);
    }
  }

  for (const tier of PARALLAX_TIERS) {
    const count = tierCounts.get(tier) ?? 0;
    const cap = tierFigureCap(tier);
    if (count > cap) {
      violations.push(
        `budget: ${where} fields ${count} ${tier} figures but the lowest graphics tier can ` +
          `only instance ${cap} - the cast would differ by device`,
      );
    }
  }

  // Rule 4. xFrac spans -1..1 across the full backdrop width, so a figure's half-extent in
  // anchor units is exactly its widthFrac and two figures clear each other when the gap
  // between their anchors is at least the sum of the two widths.
  for (let i = 0; i < figures.length; i += 1) {
    const a = figures[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < figures.length; j += 1) {
      const b = figures[j];
      if (b === undefined || b.tier !== a.tier) continue;
      const gap = Math.abs(a.anchor.xFrac - b.anchor.xFrac);
      const clearance = a.widthFrac + b.widthFrac;
      if (gap < clearance) {
        violations.push(
          `design: ${where} ${a.tier} figures "${a.id}" and "${b.id}" overlap (gap ${gap.toFixed(3)} < ` +
            `${clearance.toFixed(3)}) - silhouettes that touch at one depth merge into one mass`,
        );
      }
    }
  }

  return violations;
}

function validateDramaturgy(timeline: BeatTimeline): string[] {
  const violations: string[] = [];
  const where = `timeline "${timeline.rosterId}"`;

  for (const beat of timeline.beats) {
    const light = beat.light;
    if (light === null) continue;

    const envelope = light.attackMs + light.holdMs + light.releaseMs;
    if (envelope > beat.durationMs) {
      violations.push(
        `drama: ${where} beat "${beat.id}" envelope ${envelope}ms outlives its ${beat.durationMs}ms ` +
          `beat - the next beat would cut the release off mid-fall`,
      );
    }

    for (const channel of LIGHT_CHANNELS) {
      const value = light.peak[channel];
      if (value === undefined) continue;
      const [min, max] = LIGHT_CHANNEL_RANGE[channel];
      if (!(Number.isFinite(value) && value >= min && value <= max)) {
        violations.push(
          `drama: ${where} beat "${beat.id}" peak.${channel} ${value} is outside ${min}..${max} and ` +
            `would be silently clamped, so the authored intent is not what plays`,
        );
      }
    }

    switch (light.shape) {
      case 'strike':
        if (light.attackMs > STRIKE_MAX_ATTACK_MS) {
          violations.push(
            `drama: ${where} beat "${beat.id}" is a strike with a ${light.attackMs}ms attack, ` +
              `must be <= ${STRIKE_MAX_ATTACK_MS}ms`,
          );
        }
        if (light.attackMs >= light.releaseMs) {
          violations.push(`drama: ${where} beat "${beat.id}" strike must fall slower than it rises`);
        }
        if (!raisesLight(light.peak)) {
          violations.push(`drama: ${where} beat "${beat.id}" is a strike that raises no channel`);
        }
        break;
      case 'swell':
        if (light.attackMs < SWELL_MIN_ATTACK_MS) {
          violations.push(
            `drama: ${where} beat "${beat.id}" is a swell with a ${light.attackMs}ms attack, ` +
              `must be >= ${SWELL_MIN_ATTACK_MS}ms or it reads as a strike`,
          );
        }
        if (!raisesLight(light.peak)) {
          violations.push(`drama: ${where} beat "${beat.id}" is a swell that raises no channel`);
        }
        break;
      case 'pulse':
        if (!raisesLight(light.peak)) {
          violations.push(`drama: ${where} beat "${beat.id}" is a pulse that raises no channel`);
        }
        break;
      case 'smother':
        if (!lowersLight(light.peak)) {
          violations.push(
            `drama: ${where} beat "${beat.id}" is a smother that darkens nothing - raise skyDim ` +
              `or drop emisIntensity below neutral`,
          );
        }
        break;
      default:
        assertNever(light.shape, `${where} beat "${beat.id}"`);
    }
  }

  return violations;
}

/** Every violation across the contract, the design rules and the dramaturgy. Never throws. */
export function validateDesignedRoster(designed: DesignedRoster): string[] {
  return [
    ...validateRoster(designed.roster),
    ...validateFigures(designed.roster.id, designed.figures),
    ...validateDramaturgy(designed.roster.timeline),
  ];
}

export interface RosterSpec {
  readonly id: BattleRosterId;
  readonly displayName: string;
  readonly figures: readonly Figure[];
  readonly timeline: BeatTimeline;
}

/**
 * The authoring entry point. Rosters call this at module scope, so an unreadable cast or an
 * illegal beat fails the first import of the build rather than the player's tenth minute.
 */
export function defineRoster(spec: RosterSpec): DesignedRoster {
  const roster: BattleRoster = {
    id: spec.id,
    displayName: spec.displayName,
    combatants: spec.figures,
    timeline: spec.timeline,
  };
  const designed: DesignedRoster = { roster, figures: spec.figures };

  const violations = validateDesignedRoster(designed);
  if (violations.length > 0) {
    throw new Error(`Invalid BattleRoster "${spec.id}":\n  ${violations.join('\n  ')}`);
  }
  return designed;
}
