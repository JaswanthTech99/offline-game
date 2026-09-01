/**
 * THE CLOCK.
 *
 * r185 ships no Timer addon, so this file is the only source of time in SHATTERPOINT.
 * It does not own a requestAnimationFrame - Engine owns the one that exists and calls
 * `advance()` with the timestamp rAF handed it. Keeping the clock separate from the frame
 * source is what lets the whole simulation be driven from a test with a synthetic
 * timeline and produce bit-identical results.
 *
 * FIXED STEP, INTERPOLATED PRESENTATION
 * `fixedUpdate` runs at exactly `fixedStepMs`, always, on every tier and every refresh
 * rate. A frame runs it zero, one or several times depending on how much wall clock has
 * accumulated, and `frame(alpha)` then draws the fraction of the way to the next step.
 * Nothing in this file ever scales a timestep: a variable dt makes the shatter impulses
 * frame-rate dependent, and a pane that explodes differently on a 144 Hz monitor is a
 * different game.
 *
 * SLOW MOTION IS A FRAMES-TO-SKIP COUNTER, NEVER A SCALED TIMESTEP.
 * `setSlowMo(n)` means: run one physics step, then skip the next `n` steps entirely. The
 * accumulator still drains at wall-clock rate, so the world advances at 1/(n+1) speed
 * while every step it does take is the same 1/60 s it always was. The simulation cannot
 * tell it is in slow motion, which is the entire point - a shard trajectory sampled during
 * a slow-mo replay matches the trajectory at full speed exactly. Alpha is stretched across
 * the whole (n+1)-tick span so the interpolated draw stays smooth instead of stepping.
 *
 * SPIRAL OF DEATH
 * If a frame takes longer than the wall time it must simulate, the next frame owes more
 * steps, which takes longer still. The guard is a hard ceiling on catch-up ticks, supplied
 * by the caller from `QualityBudget.physicsSubstepCap` - no budget number is written here.
 * Time past the ceiling is discarded and reported as `droppedMs`: the world briefly runs
 * slow, which the player barely notices, instead of the tab locking up, which they do.
 */

import type { Alpha, Frames, Millis, Pausable, Tickable } from './types';

export interface LoopOptions {
  /** Simulation period. Callers pass `FIXED_STEP_MS` from core/Quality.ts. */
  readonly fixedStepMs: Millis;
  /** Spiral-of-death ceiling: `QualityBudget.physicsSubstepCap`. */
  readonly maxCatchUpSteps: number;
}

interface MutableLoopStats {
  /** Frames presented since `resetClock()`. */
  frame: number;
  /** Wall time consumed by the previous frame, after clamping. */
  frameMs: Millis;
  /** Exponentially smoothed `frameMs`. The dynamic-resolution controller reads this one. */
  smoothedFrameMs: Millis;
  /** Derived from `smoothedFrameMs`, so it does not flicker on a single long frame. */
  fps: number;
  /** `fixedUpdate` calls made during the last frame. */
  steps: number;
  /** Ticks the slow-motion counter suppressed during the last frame. */
  skippedTicks: number;
  /** Wall time the spiral guard threw away last frame. Non-zero means we are behind. */
  droppedMs: Millis;
  /** Interpolation factor handed to `frame()` last time. */
  alpha: Alpha;
  /** Total simulated time. Advances only through executed steps, so slow-mo slows it. */
  simMs: Millis;
  slowMoSkip: Frames;
  paused: boolean;
}

export type LoopStats = Readonly<MutableLoopStats>;

interface Subscriber {
  readonly tickable: Tickable;
  readonly order: number;
}

/** Feature detection for the optional half of the tick contract in core/types.ts. */
function isPausable(value: Tickable): value is Tickable & Pausable {
  return 'setPaused' in value && typeof value.setPaused === 'function';
}

/**
 * How fast `smoothedFrameMs` chases the real frame time. Not a performance budget: it is
 * the time constant of a display filter, and putting it in Quality.ts would imply a tier
 * is allowed to change how the profiler reads, which it is not.
 */
const FRAME_TIME_SMOOTHING = 0.1;

export class Loop {
  private readonly fixedStepMs: Millis;
  /** Not readonly: the debug menu and the tier detector can both change tier at runtime. */
  private maxCatchUpSteps: number;

  /** Copy-on-write, and sorted by `order`, so a system may unsubscribe from inside a tick. */
  private subscribers: readonly Subscriber[] = [];

  private accumulatorMs: Millis = 0;
  private lastTimeMs: Millis | null = null;

  /**
   * Ticks still to be suppressed before the next real step. Counting down rather than up
   * keeps "skip n" true even when `setSlowMo` changes mid-span.
   */
  private skipRemaining: Frames = 0;
  /**
   * Ticks elapsed since the last executed step. Tracked rather than derived from
   * `skipRemaining`, which reads as a full span before the first step has ever run and
   * would hand the very first slow-motion frame an alpha near 1.
   */
  private ticksSinceStep: Frames = 0;
  private slowMoSkip: Frames = 0;

  private paused = false;

  private readonly mutableStats: MutableLoopStats = {
    frame: 0,
    frameMs: 0,
    smoothedFrameMs: 0,
    fps: 0,
    steps: 0,
    skippedTicks: 0,
    droppedMs: 0,
    alpha: 0,
    simMs: 0,
    slowMoSkip: 0,
    paused: false,
  };

  constructor(options: LoopOptions) {
    this.fixedStepMs = options.fixedStepMs;
    this.maxCatchUpSteps = Math.max(1, Math.trunc(options.maxCatchUpSteps));
  }

  /**
   * Live view. The same object every frame - read it, never retain it, never mutate it.
   * A fresh stats object per frame would be an allocation on the hottest path there is.
   */
  get stats(): LoopStats {
    return this.mutableStats;
  }

  /** Follows `QualityBudget.physicsSubstepCap` whenever the resolved tier changes. */
  setMaxCatchUpSteps(steps: number): void {
    this.maxCatchUpSteps = Math.max(1, Math.trunc(steps));
  }

  /** Lower `order` ticks first. Physics must precede anything that reads its output. */
  add(tickable: Tickable, order = 0): () => void {
    const subscriber: Subscriber = { tickable, order };
    this.subscribers = [...this.subscribers, subscriber].sort((a, b) => a.order - b.order);
    if (this.paused && isPausable(tickable)) tickable.setPaused(true);
    return () => {
      this.subscribers = this.subscribers.filter((candidate) => candidate !== subscriber);
    };
  }

  remove(tickable: Tickable): void {
    this.subscribers = this.subscribers.filter((candidate) => candidate.tickable !== tickable);
  }

  /**
   * `n` is a whole number of physics frames to suppress after each one that runs, so 0 is
   * full speed, 1 is half speed, 2 is a third. Fractions are truncated: a fractional skip
   * would have to be expressed as a scaled timestep, which is the thing this design bans.
   */
  setSlowMo(framesToSkip: Frames): void {
    const next = Math.max(0, Math.trunc(framesToSkip));
    if (next === this.slowMoSkip) return;
    this.slowMoSkip = next;
    this.mutableStats.slowMoSkip = next;
    // Shortening the span must not strand a countdown longer than the new span, nor leave
    // the interpolator reading further through a span than the span now runs.
    if (this.skipRemaining > next) this.skipRemaining = next;
    if (this.ticksSinceStep > next) this.ticksSinceStep = next;
  }

  get slowMo(): Frames {
    return this.slowMoSkip;
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.mutableStats.paused = paused;
    // Wall time passed while paused belongs to nobody: dropping the timestamp makes the
    // first frame after the resume a normal-length frame instead of a catch-up burst.
    if (!paused) this.lastTimeMs = null;
    for (const subscriber of this.subscribers) {
      if (isPausable(subscriber.tickable)) subscriber.tickable.setPaused(paused);
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Forgets the previous timestamp without touching the accumulator. Call it after any gap
   * the simulation should not be charged for - tab hidden, first frame, a long load.
   */
  resetClock(): void {
    this.lastTimeMs = null;
  }

  /** Called once per rendered frame by Engine, with the rAF timestamp. */
  advance(nowMs: Millis): LoopStats {
    const stats = this.mutableStats;
    stats.frame += 1;
    stats.steps = 0;
    stats.skippedTicks = 0;
    stats.droppedMs = 0;

    const previous = this.lastTimeMs;
    this.lastTimeMs = nowMs;

    // A null previous frame is a resume, not a stall; a negative delta is a clock that
    // went backwards. Both are worth exactly zero simulated time.
    let elapsedMs = previous === null ? 0 : Math.max(0, nowMs - previous);

    // One skipped tick costs nothing, so the ceiling is expressed in ticks and scales with
    // the slow-mo span: the frame still pays for at most `maxCatchUpSteps` real steps.
    const maxTicks = this.maxCatchUpSteps * (this.slowMoSkip + 1);
    const maxElapsedMs = maxTicks * this.fixedStepMs;
    if (elapsedMs > maxElapsedMs) {
      stats.droppedMs += elapsedMs - maxElapsedMs;
      elapsedMs = maxElapsedMs;
    }

    stats.frameMs = elapsedMs;
    stats.smoothedFrameMs =
      stats.smoothedFrameMs === 0
        ? elapsedMs
        : stats.smoothedFrameMs + (elapsedMs - stats.smoothedFrameMs) * FRAME_TIME_SMOOTHING;
    stats.fps = stats.smoothedFrameMs > 0 ? 1000 / stats.smoothedFrameMs : 0;

    if (this.paused) {
      // Hold the last interpolation so the frozen frame keeps drawing the pose the sim
      // stopped in, and let the DOM overlay animate the pause menu over the top of it.
      this.dispatchFrame(stats.alpha);
      return stats;
    }

    this.accumulatorMs += elapsedMs;

    let ticks = 0;
    while (this.accumulatorMs >= this.fixedStepMs && ticks < maxTicks) {
      this.accumulatorMs -= this.fixedStepMs;
      ticks += 1;

      if (this.skipRemaining > 0) {
        this.skipRemaining -= 1;
        this.ticksSinceStep += 1;
        stats.skippedTicks += 1;
        continue;
      }

      this.dispatchFixed();
      stats.steps += 1;
      stats.simMs += this.fixedStepMs;
      this.skipRemaining = this.slowMoSkip;
      this.ticksSinceStep = 0;
    }

    if (this.accumulatorMs >= this.fixedStepMs) {
      // The ceiling stopped us with work still owed. Abandon it rather than carry it into
      // the next frame, which is how the debt compounds into a lock-up.
      stats.droppedMs += this.accumulatorMs;
      this.accumulatorMs = 0;
    }

    // Stretched across the whole slow-motion span, so the draw glides between the two
    // simulated poses instead of stepping once per (n+1) ticks.
    const span = this.slowMoSkip + 1;
    const alpha = (this.ticksSinceStep + this.accumulatorMs / this.fixedStepMs) / span;
    stats.alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;

    this.dispatchFrame(stats.alpha);
    return stats;
  }

  dispose(): void {
    this.subscribers = [];
    this.accumulatorMs = 0;
    this.lastTimeMs = null;
    this.skipRemaining = 0;
    this.ticksSinceStep = 0;
  }

  private dispatchFixed(): void {
    const step = this.fixedStepMs;
    for (const subscriber of this.subscribers) subscriber.tickable.fixedUpdate(step);
  }

  private dispatchFrame(alpha: Alpha): void {
    for (const subscriber of this.subscribers) subscriber.tickable.frame(alpha);
  }
}
