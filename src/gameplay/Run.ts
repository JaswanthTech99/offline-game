/**
 * THE RUN STATE MACHINE: room -> zone -> universe.
 *
 * One object owns the whole shape of a play session. It is deliberately renderer-blind,
 * audio-blind and DOM-blind: it takes events in ("a pane broke", "a crystal was collected"),
 * advances on the fixed 60 Hz step, and emits events out. Everything visual subscribes.
 *
 * REPRODUCIBILITY IS THE POINT. Room composition is a pure function of (seed, mode, absolute
 * room index) and nothing else - no wall clock, no Math.random, no device tier, no frame
 * count. Two players on the same seed walk the same corridor in the same order with the same
 * pane counts on a phone and on a workstation. `composeRoom` is exported so tooling can print
 * a seed's whole run without instantiating anything.
 *
 * Each room forks its own RNG stream from the run seed rather than drawing from a shared
 * sequence, so adding a draw to room composition later cannot retroactively change room 40 of
 * every existing seed.
 */

import { createRng, type Rng } from '../battle/types';
import type { QualityResolution } from '../core/Quality';
import { asSeed, type Alpha, type Frames, type Millis, type Pausable, type RunId, type Seed, type Tickable } from '../core/types';
import type { UniverseId } from '../universe/UniverseTheme';
import {
  BALLS_AT_START,
  BALLS_MAX,
  BALLS_PER_CRYSTAL,
  BALL_COST_PER_THROW,
  BALL_PENALTY_ON_IMPACT,
  BRIEFING_MS,
  BASE_SPEED_UNITS_PER_SEC,
  CHECKPOINTED_MODES,
  CHECKPOINT_BALL_BONUS,
  CHECKPOINT_BALL_FLOOR,
  CHECKPOINT_HOLD_MS,
  ENDLESS_RAMP_ZONE_CAP,
  FAIL_SEQUENCE_MS,
  FALLBACK_ROOM_KIND,
  FREE_ROOM_POOL,
  HAZARD_DENSITY_MAX,
  HAZARD_DENSITY_RAMP_PER_ZONE,
  MAX_SPEED_UNITS_PER_SEC,
  MULTIPLIER_MAX,
  MULTIPLIER_MIN,
  OBSTACLE_RAMP_CAP,
  OBSTACLE_RAMP_PER_ZONE,
  POINTS_PER_CRYSTAL,
  POINTS_PER_PANE,
  PRACTICE_SPEED_SCALE,
  RING_SPACING_UNITS,
  ROOMS_PER_ZONE,
  ROOM_DETAIL_STREAM,
  ROOM_PLAN_LOOKAHEAD,
  ROOM_PROFILES,
  ROOM_STREAM_STRIDE,
  SPEED_GAIN_PER_ROOM,
  SPEED_GAIN_PER_ZONE,
  UNIVERSE_CLEAR_HOLD_MS,
  ZONES_PER_UNIVERSE,
  ZONE_APPROACH_SLOT,
  ZONE_CRUCIBLE_OFFSET_FROM_END,
  ZONE_TERMINATOR_OFFSET_FROM_END,
  ZONE_CLEAR_HOLD_MS,
  clamp,
  clampInt,
  multiplierForStreak,
  presentationBudget,
  streakFloorForMultiplier,
  type PresentationBudget,
  type RoomKind,
} from './Balance';

/** Unit conversion, not a tuning knob: speeds are authored per second, dt arrives in ms. */
const MS_PER_SECOND = 1000;
/** Sentinel for "this run has never banked a checkpoint". Endless never leaves this value. */
const NO_CHECKPOINT = -1;

export type RunMode = 'classic' | 'endless' | 'practice';

export const RUN_MODES: readonly RunMode[] = Object.freeze(['classic', 'endless', 'practice']);

export const modeHasCheckpoints = (mode: RunMode): boolean => CHECKPOINTED_MODES.includes(mode);

/**
 * `paused` is a phase rather than a flag so that "can the player throw right now" is one
 * comparison instead of a compound condition every caller has to remember to write.
 */
export type RunPhase =
  | 'idle'
  | 'briefing'
  | 'running'
  | 'paused'
  | 'checkpoint'
  | 'zone-clear'
  | 'universe-clear'
  | 'failing'
  | 'ended';

const LEGAL_TRANSITIONS: Readonly<Record<RunPhase, readonly RunPhase[]>> = Object.freeze({
  idle: ['briefing'],
  briefing: ['running', 'paused', 'ended'],
  running: ['paused', 'checkpoint', 'zone-clear', 'universe-clear', 'failing', 'ended'],
  paused: ['briefing', 'running', 'checkpoint', 'zone-clear', 'ended'],
  checkpoint: ['running', 'paused', 'ended'],
  'zone-clear': ['running', 'paused', 'ended'],
  'universe-clear': ['ended'],
  failing: ['running', 'ended'],
  ended: [],
});

/** Phases in which the corridor moves and input is live. */
export const isPlayable = (phase: RunPhase): boolean => phase === 'running';

/* ------------------------------------------------------------------------ room composition */

/** Pure output of the seeded composer. Holds no position - the run places it in the corridor. */
export interface RoomComposition {
  readonly index: number;
  readonly zoneIndex: number;
  readonly roomInZone: number;
  readonly kind: RoomKind;
  /** Stream the corridor generator forks from for prop placement. Stable for this room. */
  readonly detailSeed: Seed;
  readonly rings: number;
  readonly lengthUnits: number;
  readonly panes: number;
  readonly crystals: number;
  readonly obstacles: number;
  readonly hazardDensity: number;
  readonly speedUnitsPerSec: number;
  readonly isCheckpoint: boolean;
  readonly isZoneFinale: boolean;
}

/** A composition placed on the corridor's distance axis. */
export interface RoomPlan extends RoomComposition {
  readonly startDistance: number;
  readonly endDistance: number;
}

/** Rng.int is half-open; room profiles author inclusive ranges, so convert in exactly one place. */
const drawInclusive = (rng: Rng, range: readonly [number, number]): number =>
  rng.int(range[0], range[1] + 1);

function pickFreeRoomKind(rng: Rng): RoomKind {
  let total = 0;
  for (const kind of FREE_ROOM_POOL) total += ROOM_PROFILES[kind].weight;

  let roll = rng.next() * total;
  for (const kind of FREE_ROOM_POOL) {
    roll -= ROOM_PROFILES[kind].weight;
    if (roll <= 0) return kind;
  }
  // Only reachable on floating-point dust at the very top of the range.
  return FREE_ROOM_POOL[FREE_ROOM_POOL.length - 1] ?? FALLBACK_ROOM_KIND;
}

/**
 * A zone's skeleton is fixed - approach, free rooms, crucible, terminator - and only the
 * middle is drawn. A player who has run a universe twice should recognise its rhythm without
 * recognising its rooms.
 */
function roomKindFor(roomInZone: number, mode: RunMode, rng: Rng): RoomKind {
  if (roomInZone === ZONE_APPROACH_SLOT) return 'approach';
  if (roomInZone === ROOMS_PER_ZONE - ZONE_TERMINATOR_OFFSET_FROM_END) {
    return modeHasCheckpoints(mode) ? 'sanctum' : 'crucible';
  }
  if (roomInZone === ROOMS_PER_ZONE - ZONE_CRUCIBLE_OFFSET_FROM_END) return 'crucible';
  return pickFreeRoomKind(rng);
}

/**
 * Pure, total, and the single definition of what a seed means. Everything that draws, streams
 * or scores a room agrees because they all call this.
 */
export function composeRoom(seed: Seed, mode: RunMode, index: number): RoomComposition {
  const zoneIndex = Math.floor(index / ROOMS_PER_ZONE);
  const roomInZone = index - zoneIndex * ROOMS_PER_ZONE;
  const rng = createRng(seed).fork(Math.imul(index + 1, ROOM_STREAM_STRIDE));

  const kind = roomKindFor(roomInZone, mode, rng);
  const profile = ROOM_PROFILES[kind];

  // Endless would otherwise ramp to an unplayable wall of obstacles; the cap turns the curve
  // into a plateau the player can actually learn.
  const rampZone = Math.min(zoneIndex, ENDLESS_RAMP_ZONE_CAP);

  const rings = drawInclusive(rng, profile.rings);
  const panes = drawInclusive(rng, profile.panes);
  const crystals = drawInclusive(rng, profile.crystals);

  // A room authored with no obstacles stays that way at every depth: the sanctum is the beat
  // where the player breathes, and ramping it would delete that beat in late zones.
  const obstacleCeiling = profile.obstacles[1] === 0 ? 0 : profile.obstacles[1] + OBSTACLE_RAMP_CAP;
  const obstacles =
    obstacleCeiling === 0
      ? 0
      : clampInt(
          drawInclusive(rng, profile.obstacles) + Math.floor(rampZone * OBSTACLE_RAMP_PER_ZONE),
          profile.obstacles[0],
          obstacleCeiling,
        );

  const hazardDensity =
    profile.hazardDensity === 0
      ? 0
      : clamp(profile.hazardDensity + rampZone * HAZARD_DENSITY_RAMP_PER_ZONE, 0, HAZARD_DENSITY_MAX);

  const paceScale = mode === 'practice' ? PRACTICE_SPEED_SCALE : 1;
  const speedUnitsPerSec =
    clamp(
      BASE_SPEED_UNITS_PER_SEC + rampZone * SPEED_GAIN_PER_ZONE + index * SPEED_GAIN_PER_ROOM,
      BASE_SPEED_UNITS_PER_SEC,
      MAX_SPEED_UNITS_PER_SEC,
    ) *
    profile.speedScale *
    paceScale;

  return {
    index,
    zoneIndex,
    roomInZone,
    kind,
    detailSeed: asSeed(Math.imul(rng.seed ^ index, ROOM_DETAIL_STREAM)),
    rings,
    lengthUnits: rings * RING_SPACING_UNITS,
    panes,
    crystals,
    obstacles,
    hazardDensity,
    speedUnitsPerSec,
    isCheckpoint: kind === 'sanctum' && modeHasCheckpoints(mode),
    isZoneFinale: roomInZone === ROOMS_PER_ZONE - ZONE_TERMINATOR_OFFSET_FROM_END,
  };
}

/* ------------------------------------------------------------------------------ run state */

export interface RunConfig {
  readonly runId: RunId;
  readonly seed: Seed;
  readonly mode: RunMode;
  readonly universe: UniverseId;
  /** Zone the run enters at. Non-zero for practice and for a checkpoint continue. */
  readonly startZone: number;
}

/** Why the ball reserve changed. Audio and HUD react differently to each, so it is explicit. */
export type BallDeltaCause = 'start' | 'throw' | 'crystal' | 'impact' | 'checkpoint';

export interface RunState {
  readonly phase: RunPhase;
  readonly roomIndex: number;
  readonly zoneIndex: number;
  readonly roomInZone: number;
  readonly balls: number;
  readonly multiplier: number;
  readonly crystalStreak: number;
  readonly peakMultiplier: number;
  readonly panesShattered: number;
  readonly crystalsCollected: number;
  readonly crystalsMissed: number;
  readonly impacts: number;
  readonly distance: number;
  readonly elapsedMs: Millis;
  /** Multiplier-weighted running total. Score.ts derives the flat/carry split from it. */
  readonly bankedPoints: number;
  readonly roomsCleared: number;
  readonly perfectRooms: number;
  readonly zonesCleared: number;
  readonly checkpointRoom: number;
  readonly universeCleared: boolean;
}

type MutableRunState = { -readonly [K in keyof RunState]: RunState[K] };

export interface RunSummary {
  readonly runId: RunId;
  readonly seed: Seed;
  readonly mode: RunMode;
  readonly universe: UniverseId;
  readonly startZone: number;
  readonly deepestZone: number;
  readonly zonesCleared: number;
  /** Absolute zone indices cleared without a single impact anywhere inside them. */
  readonly noHitZones: readonly number[];
  readonly universeCleared: boolean;
  readonly roomsCleared: number;
  readonly perfectRooms: number;
  readonly panesShattered: number;
  readonly crystalsCollected: number;
  readonly crystalsMissed: number;
  readonly impacts: number;
  readonly distance: number;
  readonly elapsedMs: Millis;
  readonly bankedPoints: number;
  readonly peakMultiplier: number;
  readonly ballsRemaining: number;
  readonly reachedCheckpoint: boolean;
  /** True when the run ended by finishing content rather than by emptying the reserve. */
  readonly completed: boolean;
}

export type RunEvent =
  | { readonly kind: 'phase'; readonly from: RunPhase; readonly to: RunPhase }
  | { readonly kind: 'room-entered'; readonly plan: RoomPlan }
  | { readonly kind: 'room-cleared'; readonly plan: RoomPlan; readonly perfect: boolean }
  | { readonly kind: 'zone-cleared'; readonly zoneIndex: number; readonly noHit: boolean }
  | { readonly kind: 'checkpoint'; readonly roomIndex: number; readonly balls: number }
  | { readonly kind: 'multiplier'; readonly from: number; readonly to: number }
  | { readonly kind: 'balls'; readonly from: number; readonly to: number; readonly cause: BallDeltaCause }
  | { readonly kind: 'impact'; readonly ballsLost: number }
  | { readonly kind: 'rescued'; readonly balls: number }
  | { readonly kind: 'ended'; readonly summary: RunSummary };

export type RunListener = (event: RunEvent) => void;

/* ---------------------------------------------------------------------------------- Run */

export class Run implements Tickable, Pausable {
  readonly config: RunConfig;
  readonly presentation: PresentationBudget;

  private readonly mutable: MutableRunState;
  private readonly listeners: RunListener[] = [];
  private readonly plans: RoomPlan[] = [];
  private readonly noHitZoneList: number[] = [];

  /** Distance at the end of the previous fixed step, so `frame` can interpolate honestly. */
  private previousDistance = 0;
  private renderDistanceValue = 0;

  private phaseTimerMs: Millis = 0;
  private phaseBeforePause: RunPhase = 'running';
  private roomHadImpact = false;
  private zoneHadImpact = false;
  private deepestZone: number;
  private endedCompleted = false;

  /**
   * Frames of physics the fail sequence swallows per simulated step. A COUNTER, never a
   * scaled timestep: the sim stays bit-identical, it simply runs less often.
   */
  private slowMoFrameSkip: Frames = 0;
  private slowMoPhase = 0;

  constructor(config: RunConfig, quality: QualityResolution) {
    this.config = config;
    this.presentation = presentationBudget(quality.budget, quality.motionRules);

    const firstRoom = config.startZone * ROOMS_PER_ZONE;
    this.deepestZone = config.startZone;
    this.mutable = {
      phase: 'idle',
      roomIndex: firstRoom,
      zoneIndex: config.startZone,
      roomInZone: 0,
      balls: BALLS_AT_START,
      multiplier: MULTIPLIER_MIN,
      crystalStreak: 0,
      peakMultiplier: MULTIPLIER_MIN,
      panesShattered: 0,
      crystalsCollected: 0,
      crystalsMissed: 0,
      impacts: 0,
      distance: 0,
      elapsedMs: 0,
      bankedPoints: 0,
      roomsCleared: 0,
      perfectRooms: 0,
      zonesCleared: 0,
      checkpointRoom: NO_CHECKPOINT,
      universeCleared: false,
    };

    this.topUpPlans(firstRoom, 0);
  }

  /** Live snapshot. Same object every call by design - do not retain it across frames. */
  get state(): RunState {
    return this.mutable;
  }

  get currentRoom(): RoomPlan {
    const plan = this.plans[0];
    if (plan === undefined) throw new Error('Run has no planned room; the plan queue must never drain');
    return plan;
  }

  /** Rooms the corridor may stream, current first. Always ROOM_PLAN_LOOKAHEAD deep. */
  get plannedRooms(): readonly RoomPlan[] {
    return this.plans;
  }

  /** Distance to draw at, interpolated between fixed steps. Never drives simulation. */
  get renderDistance(): number {
    return this.renderDistanceValue;
  }

  on(listener: RunListener): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  /* ------------------------------------------------------------------------ transitions */

  start(): void {
    this.transition('briefing', BRIEFING_MS);
    this.emit({ kind: 'balls', from: 0, to: this.mutable.balls, cause: 'start' });
    this.emit({ kind: 'room-entered', plan: this.currentRoom });
  }

  setPaused(paused: boolean): void {
    if (paused) {
      if (!LEGAL_TRANSITIONS[this.mutable.phase].includes('paused')) return;
      this.phaseBeforePause = this.mutable.phase;
      this.transition('paused', this.phaseTimerMs);
      return;
    }
    if (this.mutable.phase !== 'paused') return;
    this.transition(this.phaseBeforePause, this.phaseTimerMs);
  }

  /** Ends the run immediately without a fail sequence (quit to menu, app backgrounded away). */
  abandon(): void {
    if (this.mutable.phase === 'ended') return;
    this.endedCompleted = false;
    this.finish();
  }

  /**
   * Resumes at the last banked checkpoint. Score and stats are KEPT: a checkpoint is a
   * continuation of the same run, not a new one, which is why endless refuses to have them.
   */
  continueFromCheckpoint(): boolean {
    if (this.mutable.checkpointRoom === NO_CHECKPOINT) return false;
    if (this.mutable.phase !== 'failing' && this.mutable.phase !== 'ended') return false;

    const resumeRoom = this.mutable.checkpointRoom;
    const resumeZone = Math.floor(resumeRoom / ROOMS_PER_ZONE);
    this.plans.length = 0;
    this.topUpPlans(resumeRoom, 0);

    this.mutable.roomIndex = resumeRoom;
    this.mutable.zoneIndex = resumeZone;
    this.mutable.roomInZone = resumeRoom - resumeZone * ROOMS_PER_ZONE;
    this.mutable.distance = 0;
    this.previousDistance = 0;
    this.renderDistanceValue = 0;
    this.roomHadImpact = false;
    this.zoneHadImpact = false;
    this.setBalls(Math.max(this.mutable.balls, CHECKPOINT_BALL_FLOOR), 'checkpoint');
    this.setMultiplier(MULTIPLIER_MIN, 0);
    this.slowMoFrameSkip = 0;
    this.slowMoPhase = 0;

    // 'ended' is terminal by design, so a continue rebuilds the machine from 'running'
    // rather than pretending the ended transition never happened.
    this.forceTransition('running', 0);
    this.emit({ kind: 'room-entered', plan: this.currentRoom });
    return true;
  }

  /* --------------------------------------------------------------------- player actions */

  /**
   * Releases one volley and returns how many balls left the hand - the multiplier. 0 means the
   * throw was refused (wrong phase, or an empty reserve). The reserve pays BALL_COST_PER_THROW
   * regardless of volley size; see the note on that constant for why the multiplier is free.
   */
  throwVolley(): number {
    if (!isPlayable(this.mutable.phase)) return 0;
    if (this.mutable.balls < BALL_COST_PER_THROW) return 0;
    this.setBalls(this.mutable.balls - BALL_COST_PER_THROW, 'throw');
    return this.mutable.multiplier;
  }

  notePaneShattered(count = 1): void {
    if (count <= 0) return;
    this.mutable.panesShattered += count;
    this.mutable.bankedPoints += POINTS_PER_PANE * this.mutable.multiplier * count;
  }

  noteCrystalCollected(): void {
    this.mutable.crystalsCollected += 1;
    this.mutable.bankedPoints += POINTS_PER_CRYSTAL * this.mutable.multiplier;
    this.setMultiplier(multiplierForStreak(this.mutable.crystalStreak + 1), this.mutable.crystalStreak + 1);
    this.setBalls(this.mutable.balls + BALLS_PER_CRYSTAL, 'crystal');

    // The grace window: a crystal reached while the reserve is empty pulls the run back out.
    if (this.mutable.phase === 'failing' && this.mutable.balls > 0) {
      this.slowMoFrameSkip = 0;
      this.slowMoPhase = 0;
      this.transition('running', 0);
      this.emit({ kind: 'rescued', balls: this.mutable.balls });
    }
  }

  /** A crystal that went past uncollected. Costs the climb to the next tier, not the tier. */
  noteCrystalMissed(): void {
    this.mutable.crystalsMissed += 1;
    this.setMultiplier(this.mutable.multiplier, streakFloorForMultiplier(this.mutable.multiplier));
  }

  /** The player flew into glass. The only event that demotes the multiplier outright. */
  noteImpact(): void {
    if (this.mutable.phase !== 'running' && this.mutable.phase !== 'failing') return;
    this.mutable.impacts += 1;
    this.roomHadImpact = true;
    this.zoneHadImpact = true;
    const lost = Math.min(this.mutable.balls, BALL_PENALTY_ON_IMPACT);
    this.setMultiplier(MULTIPLIER_MIN, 0);
    this.setBalls(this.mutable.balls - BALL_PENALTY_ON_IMPACT, 'impact');
    this.emit({ kind: 'impact', ballsLost: lost });
  }

  /* -------------------------------------------------------------------------- the tick */

  fixedUpdate(dt: Millis): void {
    if (this.mutable.phase === 'idle' || this.mutable.phase === 'ended' || this.mutable.phase === 'paused') {
      this.previousDistance = this.mutable.distance;
      return;
    }

    // Frames-to-skip slow motion: the step is dropped whole, never shortened.
    if (this.slowMoFrameSkip > 0) {
      this.slowMoPhase += 1;
      if (this.slowMoPhase <= this.slowMoFrameSkip) return;
      this.slowMoPhase = 0;
    }

    this.previousDistance = this.mutable.distance;
    this.mutable.elapsedMs += dt;

    if (this.phaseTimerMs > 0) {
      this.phaseTimerMs -= dt;
      if (this.phaseTimerMs <= 0) {
        this.phaseTimerMs = 0;
        this.onPhaseTimerElapsed();
      }
      if (this.mutable.phase !== 'running') return;
    }

    if (this.mutable.phase !== 'running') return;

    this.mutable.distance += (this.currentRoom.speedUnitsPerSec * dt) / MS_PER_SECOND;
    while (this.mutable.phase === 'running' && this.mutable.distance >= this.currentRoom.endDistance) {
      this.clearCurrentRoom();
    }
  }

  frame(alpha: Alpha): void {
    this.renderDistanceValue =
      this.previousDistance + (this.mutable.distance - this.previousDistance) * alpha;
  }

  /* ------------------------------------------------------------------------- room flow */

  private clearCurrentRoom(): void {
    const finished = this.currentRoom;
    const perfect = !this.roomHadImpact;

    this.mutable.roomsCleared += 1;
    if (perfect) this.mutable.perfectRooms += 1;
    this.emit({ kind: 'room-cleared', plan: finished, perfect });

    const zoneFinished = finished.isZoneFinale;
    const zoneWasClean = !this.zoneHadImpact;

    this.plans.shift();
    this.topUpPlans(finished.index + 1 + this.plans.length, finished.endDistance);
    this.roomHadImpact = false;

    const next = this.currentRoom;
    this.mutable.roomIndex = next.index;
    this.mutable.zoneIndex = next.zoneIndex;
    this.mutable.roomInZone = next.roomInZone;
    // Clearing the last zone advances roomIndex into a zone that does not exist in classic;
    // the deepest-zone record must not learn about that phantom.
    const reachedZone =
      this.config.mode === 'classic' ? Math.min(next.zoneIndex, ZONES_PER_UNIVERSE - 1) : next.zoneIndex;
    this.deepestZone = Math.max(this.deepestZone, reachedZone);

    if (!zoneFinished) {
      this.emit({ kind: 'room-entered', plan: next });
      return;
    }

    this.mutable.zonesCleared += 1;
    if (zoneWasClean) this.noHitZoneList.push(finished.zoneIndex);
    this.emit({ kind: 'zone-cleared', zoneIndex: finished.zoneIndex, noHit: zoneWasClean });
    this.zoneHadImpact = false;

    if (this.config.mode === 'practice') {
      // Practice is exactly one zone: finishing it is the whole session.
      this.endedCompleted = true;
      this.finish();
      return;
    }

    if (this.config.mode === 'classic' && next.zoneIndex >= ZONES_PER_UNIVERSE) {
      this.mutable.universeCleared = true;
      this.endedCompleted = true;
      this.transition('universe-clear', UNIVERSE_CLEAR_HOLD_MS);
      return;
    }

    if (finished.isCheckpoint) {
      this.mutable.checkpointRoom = next.index;
      this.setBalls(Math.max(this.mutable.balls, CHECKPOINT_BALL_FLOOR) + CHECKPOINT_BALL_BONUS, 'checkpoint');
      this.emit({ kind: 'checkpoint', roomIndex: next.index, balls: this.mutable.balls });
      this.transition('checkpoint', CHECKPOINT_HOLD_MS);
      return;
    }

    // Endless never stalls for a checkpoint, but it still marks the zone boundary so the
    // player can feel the depth they have reached.
    this.transition('zone-clear', ZONE_CLEAR_HOLD_MS);
  }

  /** Keeps the plan queue exactly ROOM_PLAN_LOOKAHEAD deep, placed head-to-tail on distance. */
  private topUpPlans(fallbackIndex: number, fallbackStart: number): void {
    let nextIndex = fallbackIndex;
    let nextStart = fallbackStart;
    const tail = this.plans[this.plans.length - 1];
    if (tail !== undefined) {
      nextIndex = tail.index + 1;
      nextStart = tail.endDistance;
    }

    while (this.plans.length < ROOM_PLAN_LOOKAHEAD) {
      const composition = composeRoom(this.config.seed, this.config.mode, nextIndex);
      this.plans.push({
        ...composition,
        startDistance: nextStart,
        endDistance: nextStart + composition.lengthUnits,
      });
      nextStart += composition.lengthUnits;
      nextIndex += 1;
    }
  }

  /* --------------------------------------------------------------------- state helpers */

  private setBalls(next: number, cause: BallDeltaCause): void {
    const from = this.mutable.balls;
    const to = clampInt(next, 0, BALLS_MAX);
    if (to === from) return;
    this.mutable.balls = to;
    this.emit({ kind: 'balls', from, to, cause });

    if (to <= 0 && this.mutable.phase === 'running') this.beginFail();
  }

  private setMultiplier(next: number, streak: number): void {
    this.mutable.crystalStreak = Math.max(0, streak);
    const from = this.mutable.multiplier;
    const to = clampInt(next, MULTIPLIER_MIN, MULTIPLIER_MAX);
    if (to === from) return;
    this.mutable.multiplier = to;
    this.mutable.peakMultiplier = Math.max(this.mutable.peakMultiplier, to);
    this.emit({ kind: 'multiplier', from, to });
  }

  /**
   * The reserve hit zero. The run is not over yet: the fail sequence is a real grace window
   * in which a crystal still counts, which is what makes the last second of a run playable
   * rather than a cutscene.
   */
  private beginFail(): void {
    this.slowMoFrameSkip = this.presentation.failSlowMoFrameSkip;
    this.slowMoPhase = 0;
    this.transition('failing', FAIL_SEQUENCE_MS);
  }

  private onPhaseTimerElapsed(): void {
    switch (this.mutable.phase) {
      case 'briefing':
      case 'checkpoint':
      case 'zone-clear':
        this.transition('running', 0);
        return;
      case 'failing':
        this.endedCompleted = false;
        this.finish();
        return;
      case 'universe-clear':
        this.finish();
        return;
      case 'idle':
      case 'running':
      case 'paused':
      case 'ended':
        return;
    }
  }

  private finish(): void {
    this.slowMoFrameSkip = 0;
    this.slowMoPhase = 0;
    this.forceTransition('ended', 0);
    this.emit({ kind: 'ended', summary: this.summary() });
  }

  private transition(to: RunPhase, timerMs: Millis): void {
    const from = this.mutable.phase;
    if (from === to) {
      this.phaseTimerMs = timerMs;
      return;
    }
    if (!LEGAL_TRANSITIONS[from].includes(to)) {
      throw new Error(`Run: illegal phase transition ${from} -> ${to}`);
    }
    this.forceTransition(to, timerMs);
  }

  /** Bypasses the transition table. Only `finish` and `continueFromCheckpoint` may use it. */
  private forceTransition(to: RunPhase, timerMs: Millis): void {
    const from = this.mutable.phase;
    this.mutable.phase = to;
    this.phaseTimerMs = timerMs;
    if (from !== to) this.emit({ kind: 'phase', from, to });
  }

  private emit(event: RunEvent): void {
    // Snapshot: a listener is allowed to unsubscribe itself in response to an event.
    for (const listener of this.listeners.slice()) listener(event);
  }

  summary(): RunSummary {
    const s = this.mutable;
    return {
      runId: this.config.runId,
      seed: this.config.seed,
      mode: this.config.mode,
      universe: this.config.universe,
      startZone: this.config.startZone,
      deepestZone: this.deepestZone,
      zonesCleared: s.zonesCleared,
      noHitZones: this.noHitZoneList.slice(),
      universeCleared: s.universeCleared,
      roomsCleared: s.roomsCleared,
      perfectRooms: s.perfectRooms,
      panesShattered: s.panesShattered,
      crystalsCollected: s.crystalsCollected,
      crystalsMissed: s.crystalsMissed,
      impacts: s.impacts,
      distance: s.distance,
      elapsedMs: s.elapsedMs,
      bankedPoints: s.bankedPoints,
      peakMultiplier: s.peakMultiplier,
      ballsRemaining: s.balls,
      reachedCheckpoint: s.checkpointRoom !== NO_CHECKPOINT,
      completed: this.endedCompleted,
    };
  }
}

/** Convenience factory so call sites never hand-build a config object field by field. */
export function createRun(
  runId: RunId,
  seed: Seed,
  mode: RunMode,
  universe: UniverseId,
  startZone: number,
  quality: QualityResolution,
): Run {
  const zoneCap = mode === 'classic' ? ZONES_PER_UNIVERSE - 1 : Number.MAX_SAFE_INTEGER;
  return new Run(
    { runId, seed, mode, universe, startZone: clampInt(startZone, 0, zoneCap) },
    quality,
  );
}
