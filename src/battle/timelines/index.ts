/**
 * THE AUTHORED LOOPS.
 *
 * One ten-beat timeline per battle roster. The roster agent owns the cast - who is on the
 * backdrop, at what depth, at what size - and this file owns what they DO and when. The two
 * halves are coupled by `BattleRosterId` and by nothing else, so a silhouette can be
 * redesigned without touching a beat and a beat can be retimed without touching the cast.
 *
 * HOW TO READ A LOOP. Beats are laid end to end by `composeLoop`, so a draft carries a
 * duration and never an absolute time: inserting two seconds into beat three cannot
 * desynchronise beats four through ten, which is the failure mode that makes hand-authored
 * timelines rot. The loop length is the sum, computed here rather than typed.
 *
 * THE SHAPE OF EVERY LOOP:
 *   - an opening that establishes a baseline the rest can be measured against,
 *   - two or three escalations,
 *   - ONE DELIBERATELY QUIET BEAT somewhere in the middle. It carries no light event at
 *     all. It is not a gap in the writing, it is the thing that makes the beat after it
 *     land; a loop that is loud everywhere reads as flat within one repetition.
 *   - a peak,
 *   - and a HOLD of three seconds or more at the end. The hold is NOT dead time. The
 *     corridor has to be allowed to settle back onto its own theme lighting, because the
 *     opening beat of the next loop is only loud relative to that baseline. Trim the hold
 *     to tighten the loop and the loop stops landing after two repeats and starts being
 *     actively exhausting after four. If a loop feels slow here, cut a middle beat - never
 *     the hold.
 *
 * Every peak is authored in bus units (see universe/LightBus.ts for each channel's domain).
 * Peaks that name only flash channels are legal and used on purpose: a sheet-lightning
 * flicker with no shock behind it is a real thing that reads as very far away.
 *
 * IP: every roster here is an archetype - a wall, a fleet, a machine host, a shrine road.
 * Nothing in this file may reference any existing character, property or trade dress.
 */

import type { Millis } from '../../core/types';
import type { LightBusState } from '../../universe/LightBus';
import type { BattleRosterId } from '../../universe/UniverseTheme';
import { BATTLE_ROSTER_IDS } from '../../universe/UniverseTheme';
import { validateTimelineForPlayback } from '../BeatTimeline';
import type { Beat, BeatDecad, BeatId, BeatTimeline, LightEvent, LightEventShape } from '../types';
import {
  PRESSURE_DELAY_MAX_MS,
  PRESSURE_DELAY_MIN_MS,
  defineTimeline,
  validateTimeline,
} from '../types';

/** Mid-window by construction, so the default can never drift outside the law in ./types. */
const DEFAULT_PRESSURE_DELAY_MS: Millis = Math.round(
  (PRESSURE_DELAY_MIN_MS + PRESSURE_DELAY_MAX_MS) / 2,
);

/** A beat before it knows where it sits in the loop. `composeLoop` supplies `atMs`. */
interface BeatDraft {
  readonly id: BeatId;
  readonly title: string;
  readonly durationMs: Millis;
  readonly light: LightEvent | null;
  /** Per-beat travel time for the shock front. Closer events arrive sooner. */
  readonly pressureDelayMs?: Millis;
  readonly quiet?: boolean;
}

type DraftDecad = readonly [
  BeatDraft,
  BeatDraft,
  BeatDraft,
  BeatDraft,
  BeatDraft,
  BeatDraft,
  BeatDraft,
  BeatDraft,
  BeatDraft,
  BeatDraft,
];

const envelope =
  (shape: LightEventShape) =>
  (attackMs: Millis, holdMs: Millis, releaseMs: Millis, peak: Partial<LightBusState>): LightEvent => ({
    shape,
    attackMs,
    holdMs,
    releaseMs,
    peak,
  });

const strike = envelope('strike');
const swell = envelope('swell');
const pulse = envelope('pulse');
const smother = envelope('smother');

/**
 * Lays ten drafts end to end and validates the result twice: once against the timeline laws
 * in ./types, once against the playback laws in ../BeatTimeline. Both throw at module scope,
 * so an illegal loop fails the build's first import rather than the player's tenth minute.
 */
function composeLoop(rosterId: BattleRosterId, drafts: DraftDecad): BeatTimeline {
  let cursor = 0;

  const place = (draft: BeatDraft): Beat => {
    const atMs = cursor;
    cursor += draft.durationMs;
    return {
      id: draft.id,
      title: draft.title,
      atMs,
      durationMs: draft.durationMs,
      light: draft.light,
      // No light, no shock: a silent beat cannot have a pressure front to be late.
      pressureDelayMs: draft.light === null ? 0 : (draft.pressureDelayMs ?? DEFAULT_PRESSURE_DELAY_MS),
      quiet: draft.quiet ?? false,
    };
  };

  // Destructured rather than mapped so the tuple arity survives into `BeatDecad` without a
  // cast; array literal elements evaluate left to right, so `cursor` accumulates in order.
  const [one, two, three, four, five, six, seven, eight, nine, ten] = drafts;
  const beats: BeatDecad = [
    place(one),
    place(two),
    place(three),
    place(four),
    place(five),
    place(six),
    place(seven),
    place(eight),
    place(nine),
    place(ten),
  ];

  const timeline = defineTimeline(rosterId, cursor, beats);
  const violations = validateTimelineForPlayback(timeline);
  if (violations.length > 0) {
    throw new Error(`Unplayable BeatTimeline:\n  ${violations.join('\n  ')}`);
  }
  return timeline;
}

/**
 * VOID CHOIR. Vast, sacral, mostly dark. The performance is a call and an answer between
 * two masses too large to see the edges of, and the corridor spends most of the loop being
 * dimmed rather than lit - which is what makes the single unison strike enormous.
 */
const VOID_CHOIR = composeLoop('void-choir', [
  {
    id: 'vc-intake',
    title: 'the choir draws breath',
    durationMs: 2200,
    light: swell(900, 300, 900, { emisIntensity: 1.35, skyDim: 0.14, shaftOpacity: 0.2 }),
    pressureDelayMs: 780,
  },
  {
    id: 'vc-first-note',
    title: 'first note hits the vault',
    durationMs: 1800,
    light: strike(60, 120, 900, {
      emisIntensity: 3.2,
      rimBoost: 1.6,
      skyDim: 0.34,
      shaftOpacity: 0.5,
      brazierGlow: 1.1,
    }),
    pressureDelayMs: 720,
  },
  {
    id: 'vc-low-answer',
    title: 'the low answer',
    durationMs: 2600,
    light: swell(700, 500, 1200, {
      emisIntensity: 2.1,
      brazierGlow: 1.7,
      shaftOpacity: 0.62,
      skyDim: 0.2,
    }),
    pressureDelayMs: 800,
  },
  { id: 'vc-hollow', title: 'hollow', durationMs: 2400, light: null, quiet: true },
  {
    id: 'vc-antiphon',
    title: 'antiphon',
    durationMs: 2000,
    light: pulse(120, 80, 700, { emisIntensity: 2.6, rimBoost: 1.9, shaftOpacity: 0.44 }),
    pressureDelayMs: 740,
  },
  {
    id: 'vc-antiphon-near',
    title: 'antiphon, closer',
    durationMs: 1700,
    light: pulse(100, 70, 620, { emisIntensity: 3.0, rimBoost: 2.4, brazierGlow: 1.5 }),
    pressureDelayMs: 705,
  },
  {
    id: 'vc-swallow',
    title: 'the vault swallows it',
    durationMs: 2600,
    light: smother(800, 700, 1000, { emisIntensity: 0.42, skyDim: 0.74, shaftOpacity: 0.1 }),
    pressureDelayMs: 770,
  },
  {
    id: 'vc-unison',
    title: 'unison',
    durationMs: 2300,
    light: strike(50, 160, 1300, {
      emisIntensity: 4.6,
      rimBoost: 3.0,
      skyDim: 0.5,
      shaftOpacity: 0.82,
      brazierGlow: 2.3,
    }),
    pressureDelayMs: 730,
  },
  {
    id: 'vc-embers',
    title: 'embers fall through the shafts',
    durationMs: 2200,
    light: swell(900, 400, 900, { emisIntensity: 1.5, shaftOpacity: 0.5, brazierGlow: 0.9 }),
    pressureDelayMs: 790,
  },
  {
    id: 'vc-hold',
    title: 'hold',
    durationMs: 3200,
    light: smother(1200, 700, 1300, { emisIntensity: 0.86, skyDim: 0.2, shaftOpacity: 0.14 }),
    pressureDelayMs: 760,
  },
]);

/**
 * INCURSION HOST. Something is opening a way in. Irregular, violent, and the only loop with
 * two consecutive strikes - the pair reads as one thing failing twice rather than as rhythm.
 */
const INCURSION_HOST = composeLoop('incursion-host', [
  {
    id: 'ih-seam',
    title: 'something finds the seam',
    durationMs: 1500,
    light: swell(700, 200, 600, { emisIntensity: 1.25, shaftOpacity: 0.3, skyDim: 0.1 }),
    pressureDelayMs: 760,
  },
  {
    id: 'ih-tear',
    title: 'first tear',
    durationMs: 1200,
    light: strike(45, 90, 700, {
      emisIntensity: 3.6,
      rimBoost: 2.6,
      shaftOpacity: 0.55,
      skyDim: 0.28,
    }),
    pressureDelayMs: 715,
  },
  {
    id: 'ih-tear-wide',
    title: 'the tear widens',
    durationMs: 1100,
    light: strike(40, 80, 650, { emisIntensity: 4.2, rimBoost: 3.0, brazierGlow: 1.9 }),
    pressureDelayMs: 700,
  },
  {
    id: 'ih-through',
    title: 'it comes through',
    durationMs: 2600,
    light: swell(600, 600, 1200, {
      emisIntensity: 2.4,
      shaftOpacity: 0.78,
      brazierGlow: 2.2,
      skyDim: 0.42,
    }),
    pressureDelayMs: 800,
  },
  { id: 'ih-listen', title: 'the corridor listens', durationMs: 2200, light: null, quiet: true },
  {
    id: 'ih-volley',
    title: 'volley',
    durationMs: 1500,
    light: pulse(110, 70, 640, { emisIntensity: 3.0, rimBoost: 2.2, shaftOpacity: 0.5 }),
    pressureDelayMs: 735,
  },
  {
    id: 'ih-volley-answer',
    title: 'answering volley',
    durationMs: 1300,
    light: pulse(100, 60, 600, { emisIntensity: 3.3, rimBoost: 2.5, brazierGlow: 1.7 }),
    pressureDelayMs: 725,
  },
  {
    id: 'ih-collapse',
    title: 'a span collapses',
    durationMs: 2400,
    light: smother(700, 800, 900, { emisIntensity: 0.34, skyDim: 0.86, shaftOpacity: 0.12 }),
    pressureDelayMs: 780,
  },
  {
    id: 'ih-reprisal',
    title: 'reprisal',
    durationMs: 2600,
    light: strike(45, 180, 1400, {
      emisIntensity: 5.4,
      rimBoost: 3.4,
      skyDim: 0.55,
      shaftOpacity: 0.9,
      brazierGlow: 2.8,
    }),
    pressureDelayMs: 710,
  },
  {
    id: 'ih-hold',
    title: 'hold',
    durationMs: 3000,
    light: swell(1300, 600, 1100, { emisIntensity: 1.2, shaftOpacity: 0.24, brazierGlow: 0.6 }),
    pressureDelayMs: 790,
  },
]);

/**
 * AEGIS HOST. A shield line holding. The only metronomic loop in the game: three identical
 * hammer blows on an even count, so that the beat where the line buckles is the first thing
 * all loop that has not been on the grid.
 */
const AEGIS_HOST = composeLoop('aegis-host', [
  {
    id: 'ah-lock',
    title: 'the line locks',
    durationMs: 2000,
    light: swell(800, 400, 700, { emisIntensity: 1.4, brazierGlow: 1.0, shaftOpacity: 0.26 }),
    pressureDelayMs: 750,
  },
  {
    id: 'ah-hammer-one',
    title: 'hammer, one',
    durationMs: 1400,
    light: strike(50, 110, 620, { emisIntensity: 2.8, rimBoost: 2.0, shaftOpacity: 0.42 }),
    pressureDelayMs: 730,
  },
  {
    id: 'ah-hammer-two',
    title: 'hammer, two',
    durationMs: 1400,
    light: strike(50, 110, 620, { emisIntensity: 2.9, rimBoost: 2.1, brazierGlow: 1.4 }),
    pressureDelayMs: 745,
  },
  {
    id: 'ah-hammer-three',
    title: 'hammer, three',
    durationMs: 1400,
    light: strike(50, 110, 620, { emisIntensity: 3.1, rimBoost: 2.2, shaftOpacity: 0.5 }),
    pressureDelayMs: 760,
  },
  { id: 'ah-breath', title: 'the line breathes', durationMs: 2100, light: null, quiet: true },
  {
    id: 'ah-press',
    title: 'the wall presses',
    durationMs: 2500,
    light: swell(900, 700, 1100, {
      emisIntensity: 2.2,
      shaftOpacity: 0.68,
      brazierGlow: 2.0,
      skyDim: 0.24,
    }),
    pressureDelayMs: 785,
  },
  {
    id: 'ah-buckle',
    title: 'a section buckles',
    durationMs: 1800,
    light: smother(600, 500, 900, { emisIntensity: 0.5, skyDim: 0.66, shaftOpacity: 0.16 }),
    pressureDelayMs: 770,
  },
  {
    id: 'ah-horn',
    title: 'the horn',
    durationMs: 2400,
    light: strike(70, 200, 1300, {
      emisIntensity: 4.4,
      rimBoost: 2.9,
      shaftOpacity: 0.84,
      brazierGlow: 2.6,
      skyDim: 0.38,
    }),
    pressureDelayMs: 720,
  },
  {
    id: 'ah-reform',
    title: 'the line reforms',
    durationMs: 2000,
    light: pulse(300, 300, 900, { emisIntensity: 1.9, brazierGlow: 1.5, shaftOpacity: 0.4 }),
    pressureDelayMs: 755,
  },
  {
    id: 'ah-hold',
    title: 'hold',
    durationMs: 3100,
    light: swell(1200, 800, 1100, { emisIntensity: 1.15, brazierGlow: 0.7, shaftOpacity: 0.2 }),
    pressureDelayMs: 795,
  },
]);

/**
 * SALTGLASS FLEETS. Two rigged fleets fighting in weather. Everything here rides a slow
 * swell, and the loop carries the game's clearest demonstration of the desync: sheet
 * lightning with no shock at all, immediately before a broadside that has a very loud one.
 */
const SALTGLASS_FLEETS = composeLoop('saltglass-fleets', [
  {
    id: 'sf-swell',
    title: 'the swell lifts the fleet',
    durationMs: 2400,
    light: swell(1000, 400, 1000, { emisIntensity: 1.3, shaftOpacity: 0.34, skyDim: 0.16 }),
    pressureDelayMs: 770,
  },
  {
    id: 'sf-harpoon',
    title: 'harpoon volley',
    durationMs: 1500,
    light: strike(45, 100, 680, { emisIntensity: 2.9, rimBoost: 2.6, shaftOpacity: 0.46 }),
    pressureDelayMs: 705,
  },
  {
    id: 'sf-hull',
    title: 'hull strike',
    durationMs: 1600,
    light: strike(55, 130, 760, {
      emisIntensity: 3.4,
      rimBoost: 2.2,
      brazierGlow: 1.8,
      skyDim: 0.3,
    }),
    pressureDelayMs: 735,
  },
  { id: 'sf-trough', title: 'the trough', durationMs: 2300, light: null, quiet: true },
  {
    id: 'sf-thunderhead',
    title: 'thunderhead',
    durationMs: 2600,
    light: smother(900, 600, 1100, { emisIntensity: 0.46, skyDim: 0.8, shaftOpacity: 0.18 }),
    pressureDelayMs: 790,
  },
  {
    // Flash channels only. Far enough away that the shock never arrives at all, which is
    // exactly why the eye reads it as kilometres off rather than as a camera flash.
    id: 'sf-sheet',
    title: 'sheet lightning, far off',
    durationMs: 1200,
    light: pulse(30, 60, 520, { emisIntensity: 3.8, rimBoost: 2.8, skyDim: 0.2 }),
  },
  {
    id: 'sf-broadside',
    title: 'broadside',
    durationMs: 2200,
    light: strike(60, 180, 1200, {
      emisIntensity: 4.2,
      rimBoost: 3.0,
      shaftOpacity: 0.86,
      brazierGlow: 2.4,
    }),
    pressureDelayMs: 745,
  },
  {
    id: 'sf-list',
    title: 'the fleet lists',
    durationMs: 2000,
    light: swell(800, 500, 900, {
      emisIntensity: 1.8,
      shaftOpacity: 0.56,
      brazierGlow: 1.2,
      skyDim: 0.28,
    }),
    pressureDelayMs: 800,
  },
  {
    id: 'sf-spray',
    title: 'spray across the shafts',
    durationMs: 1700,
    light: pulse(250, 250, 800, { emisIntensity: 1.6, shaftOpacity: 0.64 }),
    pressureDelayMs: 780,
  },
  {
    id: 'sf-hold',
    title: 'hold',
    durationMs: 3300,
    light: swell(1400, 800, 1100, { emisIntensity: 1.1, shaftOpacity: 0.22, skyDim: 0.12 }),
    pressureDelayMs: 760,
  },
]);

/**
 * FOLDWORKS HOST. A machine host unfolding itself. Arc light is instant and tiny; the drop
 * hammer and the vent stacks are the only things here with any mass behind them, and the
 * brownout before the restart is the loop's real subject.
 */
const FOLDWORKS_HOST = composeLoop('foldworks-host', [
  {
    id: 'fh-spool',
    title: 'the frames spool up',
    durationMs: 1900,
    light: swell(800, 300, 800, { emisIntensity: 1.45, brazierGlow: 1.2, shaftOpacity: 0.24 }),
    pressureDelayMs: 755,
  },
  {
    id: 'fh-unfold',
    title: 'a frame unfolds',
    durationMs: 2300,
    light: swell(600, 600, 1000, {
      emisIntensity: 2.0,
      rimBoost: 1.4,
      shaftOpacity: 0.5,
      brazierGlow: 1.8,
    }),
    pressureDelayMs: 785,
  },
  {
    // Flash only: an arc has no shock front worth the name at this distance.
    id: 'fh-arc',
    title: 'arc weld',
    durationMs: 1100,
    light: pulse(25, 60, 480, { emisIntensity: 4.0, rimBoost: 3.2 }),
  },
  {
    id: 'fh-arc-answer',
    title: 'arc weld, answered',
    durationMs: 1100,
    light: pulse(25, 60, 480, { emisIntensity: 4.1, rimBoost: 3.3, shaftOpacity: 0.38 }),
    pressureDelayMs: 710,
  },
  { id: 'fh-stall', title: 'the line stalls', durationMs: 2200, light: null, quiet: true },
  {
    id: 'fh-hammer',
    title: 'drop hammer',
    durationMs: 1800,
    light: strike(40, 140, 900, {
      emisIntensity: 3.4,
      rimBoost: 2.4,
      shaftOpacity: 0.72,
      brazierGlow: 2.2,
    }),
    pressureDelayMs: 730,
  },
  {
    id: 'fh-vent',
    title: 'vent stacks blow',
    durationMs: 2100,
    light: swell(500, 700, 900, {
      emisIntensity: 2.2,
      shaftOpacity: 0.9,
      brazierGlow: 2.6,
      skyDim: 0.22,
    }),
    pressureDelayMs: 795,
  },
  {
    id: 'fh-brownout',
    title: 'brownout',
    durationMs: 2000,
    light: smother(400, 900, 700, { emisIntensity: 0.3, skyDim: 0.7, brazierGlow: 0.3 }),
    pressureDelayMs: 775,
  },
  {
    id: 'fh-restart',
    title: 'everything restarts at once',
    durationMs: 2500,
    light: strike(60, 200, 1300, {
      emisIntensity: 5.0,
      rimBoost: 3.4,
      shaftOpacity: 0.8,
      brazierGlow: 3.0,
      skyDim: 0.3,
    }),
    pressureDelayMs: 715,
  },
  {
    id: 'fh-hold',
    title: 'hold',
    durationMs: 3000,
    light: swell(1200, 700, 1100, { emisIntensity: 1.2, brazierGlow: 0.8, shaftOpacity: 0.2 }),
    pressureDelayMs: 765,
  },
]);

/**
 * ASHFALL WAR. A war fought along a shrine road, seen through falling ash. The warmest loop
 * in the game: braziers do most of the work and the sky is dimmed by smoke rather than by
 * anything dramatic. Slowest tempo of the seven.
 */
const ASHFALL_WAR = composeLoop('ashfall-war', [
  {
    id: 'aw-bell',
    title: 'the first bell',
    durationMs: 2200,
    light: pulse(200, 200, 900, { emisIntensity: 1.6, brazierGlow: 1.4, shaftOpacity: 0.3 }),
    pressureDelayMs: 760,
  },
  {
    id: 'aw-ashfall',
    title: 'ash comes down heavier',
    durationMs: 2600,
    light: swell(1100, 500, 1000, { emisIntensity: 1.3, shaftOpacity: 0.7, skyDim: 0.3 }),
    pressureDelayMs: 800,
  },
  {
    id: 'aw-ember-surge',
    title: 'ember surge',
    durationMs: 1800,
    light: strike(60, 140, 820, { emisIntensity: 3.0, rimBoost: 2.0, brazierGlow: 2.8 }),
    pressureDelayMs: 725,
  },
  {
    id: 'aw-stillness',
    title: 'stillness on the approach',
    durationMs: 2500,
    light: null,
    quiet: true,
  },
  {
    id: 'aw-bell-near',
    title: 'the second bell, nearer',
    durationMs: 1900,
    light: pulse(180, 180, 860, {
      emisIntensity: 2.2,
      rimBoost: 1.6,
      brazierGlow: 1.9,
      shaftOpacity: 0.42,
    }),
    pressureDelayMs: 745,
  },
  {
    id: 'aw-pyre',
    title: 'a pyre takes',
    durationMs: 2400,
    light: swell(700, 800, 1000, { emisIntensity: 2.4, brazierGlow: 3.2, shaftOpacity: 0.6 }),
    pressureDelayMs: 780,
  },
  {
    id: 'aw-smoke',
    title: 'smoke closes over the road',
    durationMs: 2200,
    light: smother(800, 700, 900, { emisIntensity: 0.5, skyDim: 0.78, shaftOpacity: 0.2 }),
    pressureDelayMs: 790,
  },
  {
    id: 'aw-toll',
    title: 'the great toll',
    durationMs: 2600,
    light: strike(80, 220, 1400, {
      emisIntensity: 4.2,
      rimBoost: 2.8,
      brazierGlow: 3.4,
      shaftOpacity: 0.78,
      skyDim: 0.34,
    }),
    pressureDelayMs: 735,
  },
  {
    id: 'aw-roof',
    title: 'the shrine roof falls',
    durationMs: 2000,
    light: strike(50, 120, 1000, {
      emisIntensity: 3.2,
      rimBoost: 2.4,
      shaftOpacity: 0.66,
      brazierGlow: 2.0,
    }),
    pressureDelayMs: 715,
  },
  {
    id: 'aw-hold',
    title: 'hold',
    durationMs: 3400,
    light: smother(1400, 900, 1100, { emisIntensity: 0.9, skyDim: 0.22, shaftOpacity: 0.24 }),
    pressureDelayMs: 770,
  },
]);

/**
 * ZENITH ASCENDANTS. Figures climbing an updraft against a bright sky. The inverse of the
 * void choir: the corridor is mostly being lit rather than dimmed, so the one smother beat -
 * something enormous crossing in front of the light - is the shock in this loop.
 */
const ZENITH_ASCENDANTS = composeLoop('zenith-ascendants', [
  {
    id: 'za-updraft',
    title: 'the updraft takes',
    durationMs: 2100,
    light: swell(900, 300, 900, { emisIntensity: 1.5, shaftOpacity: 0.36, rimBoost: 0.8 }),
    pressureDelayMs: 775,
  },
  {
    id: 'za-ascent-one',
    title: 'first ascent',
    durationMs: 1900,
    light: swell(600, 400, 900, { emisIntensity: 2.2, rimBoost: 1.8, shaftOpacity: 0.5 }),
    pressureDelayMs: 750,
  },
  {
    // Flash only: light off a rising edge, kilometres up, with nothing behind it.
    id: 'za-crown',
    title: 'the crown catches',
    durationMs: 1500,
    light: pulse(90, 100, 620, { emisIntensity: 3.2, rimBoost: 2.6 }),
  },
  {
    id: 'za-breath',
    title: 'the field holds its breath',
    durationMs: 2000,
    light: null,
    quiet: true,
  },
  {
    id: 'za-ascent-two',
    title: 'second ascent',
    durationMs: 2200,
    light: swell(700, 500, 1000, {
      emisIntensity: 2.8,
      rimBoost: 2.2,
      shaftOpacity: 0.66,
      brazierGlow: 1.4,
    }),
    pressureDelayMs: 785,
  },
  {
    id: 'za-shear',
    title: 'shear',
    durationMs: 1400,
    light: strike(35, 90, 620, { emisIntensity: 3.6, rimBoost: 3.0, shaftOpacity: 0.44 }),
    pressureDelayMs: 710,
  },
  {
    id: 'za-eclipse',
    title: 'something crosses the light',
    durationMs: 2300,
    light: smother(900, 600, 900, { emisIntensity: 0.55, skyDim: 0.62, shaftOpacity: 0.24 }),
    pressureDelayMs: 795,
  },
  {
    id: 'za-zenith',
    title: 'zenith',
    durationMs: 2700,
    light: strike(70, 240, 1400, {
      emisIntensity: 5.8,
      rimBoost: 3.6,
      shaftOpacity: 0.92,
      brazierGlow: 2.4,
    }),
    pressureDelayMs: 730,
  },
  {
    id: 'za-fallout',
    title: 'sparks fall back through the shafts',
    durationMs: 2100,
    light: pulse(300, 300, 900, { emisIntensity: 1.7, shaftOpacity: 0.6, rimBoost: 1.2 }),
    pressureDelayMs: 765,
  },
  {
    id: 'za-hold',
    title: 'hold',
    durationMs: 3200,
    light: swell(1400, 800, 1000, { emisIntensity: 1.18, shaftOpacity: 0.2, rimBoost: 0.5 }),
    pressureDelayMs: 760,
  },
]);

/**
 * Every roster id has a timeline. Keyed by the union rather than by `string`, so declaring
 * a new roster in universe/UniverseTheme.ts is a compile error here until it has one.
 */
export const TIMELINES: Readonly<Record<BattleRosterId, BeatTimeline>> = Object.freeze({
  'void-choir': VOID_CHOIR,
  'incursion-host': INCURSION_HOST,
  'aegis-host': AEGIS_HOST,
  'saltglass-fleets': SALTGLASS_FLEETS,
  'foldworks-host': FOLDWORKS_HOST,
  'ashfall-war': ASHFALL_WAR,
  'zenith-ascendants': ZENITH_ASCENDANTS,
});

export function getTimeline(rosterId: BattleRosterId): BeatTimeline {
  return TIMELINES[rosterId];
}

/**
 * Re-runs every law over every timeline. `composeLoop` already threw at import if one was
 * illegal; this exists so tooling and tests can assert the whole set in one call without
 * relying on a module-scope throw for their signal.
 */
export function validateAllTimelines(): string[] {
  const violations: string[] = [];
  for (const rosterId of BATTLE_ROSTER_IDS) {
    const timeline = TIMELINES[rosterId];
    violations.push(...validateTimeline(timeline), ...validateTimelineForPlayback(timeline));
  }
  return violations;
}
