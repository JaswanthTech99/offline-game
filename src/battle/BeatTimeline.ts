/**
 * THE BEAT DRIVER.
 *
 * Data in (`BeatTimeline` from ./types), five floats out (`LightBus`). Nothing else. This
 * class owns no geometry, no material, no DOM node and no audio voice; if it ever gains
 * one, the "the battle is wallpaper" warning at the top of universe/LightBus.ts has come
 * true and the extra thing is the reason.
 *
 * TWO CHANNELS, DESYNCED. A beat fires one authored `LightEvent`, and that event is split
 * across two independent envelope banks:
 *
 *   FLASH    - emisIntensity, skyDim, rimBoost. Photons. They arrive the instant the beat
 *              fires, because light from something eight kilometres away is already here.
 *   PRESSURE - shaftOpacity, brazierGlow. The shock front. It leaves at the same moment and
 *              arrives 700-800ms later, softer and smeared, because air is slow: dust gets
 *              thrown up into the god rays and the practical flames get punched and flare.
 *
 * That delay is the single most important thing in this file. Light and pressure arriving
 * together read as a screen effect on the camera; arriving apart they read as DISTANCE, and
 * distance is what makes the corridor feel like it is inside a war rather than in front of
 * a poster of one. It is implemented as a real scheduled channel - the pressure voice is
 * spawned with a start time in the future and stays silent until the clock reaches it - and
 * not as a fudge factor smuggled into an attack curve.
 *
 * INTERPOLATION. `fixedUpdate` composes the pose at the fixed 60Hz sim rate into `pose`,
 * keeping the previous step in `prevPose`; `frame(alpha)` lerps between them and is the
 * only place the bus is written. Every channel therefore behaves like a CSS `@property`
 * declared as a number: a typed, named, smoothly interpolated value rather than a step
 * function, so a 144Hz display shows 144 distinct lighting states from a 60Hz timeline.
 */

import type { MotionRules } from '../core/Quality';
import type { Alpha, Disposable, Millis, Pausable, Tickable } from '../core/types';
import { assertNever } from '../core/types';
import type { LightBus, LightChannel } from '../universe/LightBus';
import { LIGHT_BUS_NEUTRAL, LIGHT_CHANNELS, LIGHT_CHANNEL_RANGE } from '../universe/LightBus';
import type { Beat, BeatTimeline, LightEvent, LightEventShape, Rng } from './types';
import { PRESSURE_DELAY_MAX_MS, PRESSURE_DELAY_MIN_MS, validateTimeline } from './types';

/**
 * Which side of the desync each bus channel is on. A Record over the union rather than two
 * hand-written arrays, so adding a sixth channel to the bus is a compile error here until
 * somebody decides whether it travels at the speed of light or the speed of sound.
 */
const CHANNEL_ROUTING: Readonly<Record<LightChannel, 'flash' | 'pressure'>> = Object.freeze({
  emisIntensity: 'flash',
  skyDim: 'flash',
  rimBoost: 'flash',
  shaftOpacity: 'pressure',
  brazierGlow: 'pressure',
});

export const FLASH_CHANNELS: readonly LightChannel[] = Object.freeze(
  LIGHT_CHANNELS.filter((channel) => CHANNEL_ROUTING[channel] === 'flash'),
);

export const PRESSURE_CHANNELS: readonly LightChannel[] = Object.freeze(
  LIGHT_CHANNELS.filter((channel) => CHANNEL_ROUTING[channel] === 'pressure'),
);

/**
 * Dramaturgy constants, not performance budgets - the same class of number as
 * FINAL_HOLD_MIN_MS in ./types, and kept next to the code they shape for the same reason.
 * core/Quality.ts owns what the hardware can afford; these own what the performance means,
 * and no tier is allowed to change them or the loop reads differently on a phone.
 */

/** Per-loop humanisation. Big enough to break the metronome, small enough to keep the form. */
const BEAT_START_JITTER_MS = 38;
const BEAT_GAIN_JITTER = 0.07;
const PRESSURE_DELAY_JITTER_MS = 28;

/**
 * A shock front has travelled through kilometres of turbulent air by the time it arrives,
 * so it cannot rise as fast as the flash that announced it however sharp the authored
 * attack was. Smearing the pressure envelope is what stops the delayed half reading as a
 * second, late flash.
 */
const PRESSURE_ATTACK_SMEAR = 2.6;
const PRESSURE_HOLD_SMEAR = 1.4;
const PRESSURE_RELEASE_SMEAR = 1.8;
const PRESSURE_MIN_ATTACK_MS = 160;

/** How much a bank stretches the authored envelope before playing it. */
interface EnvelopeSmear {
  readonly attack: number;
  readonly hold: number;
  readonly release: number;
  readonly minAttackMs: number;
}

/** The flash side plays the authored envelope verbatim; only the pressure side is smeared. */
const FLASH_SMEAR: EnvelopeSmear = Object.freeze({ attack: 1, hold: 1, release: 1, minAttackMs: 0 });

const PRESSURE_SMEAR: EnvelopeSmear = Object.freeze({
  attack: PRESSURE_ATTACK_SMEAR,
  hold: PRESSURE_HOLD_SMEAR,
  release: PRESSURE_RELEASE_SMEAR,
  minAttackMs: PRESSURE_MIN_ATTACK_MS,
});

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Rise from 0 to 1 across the attack. The shape is the drama; the peak is only the amount. */
function attackCurve(shape: LightEventShape, t: number): number {
  switch (shape) {
    case 'strike': {
      // Quartic ease-out: full before the eye can track the ramp, which is what a strike is.
      const inverse = 1 - t;
      return 1 - inverse * inverse * inverse * inverse;
    }
    case 'swell':
      return t * t * (3 - 2 * t);
    case 'pulse':
      return Math.sin(t * Math.PI * 0.5);
    case 'smother':
      // Ease-in: the dark closes slowly, then all at once.
      return t * t;
    default:
      return assertNever(shape, 'attackCurve');
  }
}

/** Fall from 1 to 0 across the release. */
function releaseCurve(shape: LightEventShape, t: number): number {
  switch (shape) {
    case 'strike': {
      // Cubic tail, deliberately long: what sells a strike is the afterimage, not the flash.
      const inverse = 1 - t;
      return inverse * inverse * inverse;
    }
    case 'swell':
      return 1 - t * t * (3 - 2 * t);
    case 'pulse': {
      const inverse = 1 - t;
      return inverse * inverse;
    }
    case 'smother':
      // Holds the choke, then lets go at once: the light coming back is the event.
      return 1 - t * t * t;
    default:
      return assertNever(shape, 'releaseCurve');
  }
}

type ChannelPose = Record<LightChannel, number>;

const neutralPose = (): ChannelPose => ({ ...LIGHT_BUS_NEUTRAL });

const noOwnership = (): Record<LightChannel, boolean> => ({
  emisIntensity: false,
  shaftOpacity: false,
  brazierGlow: false,
  skyDim: false,
  rimBoost: false,
});

/**
 * One envelope in flight. Voices are pooled and pre-warmed: a beat must never allocate,
 * because the one frame a beat fires on is frequently the frame a pane is also shattering.
 */
interface Voice {
  active: boolean;
  /** Absolute driver clock. For a pressure voice this is in the FUTURE - that is the delay. */
  startMs: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
  endMs: number;
  shape: LightEventShape;
  gain: number;
  readonly target: ChannelPose;
  readonly owns: Record<LightChannel, boolean>;
}

function envelopeAt(voice: Voice, nowMs: number): number {
  const elapsed = nowMs - voice.startMs;
  if (elapsed <= 0) return 0; // Scheduled but not yet arrived. This is the pressure delay.
  if (elapsed < voice.attackMs) return attackCurve(voice.shape, elapsed / voice.attackMs);

  const held = elapsed - voice.attackMs;
  if (held < voice.holdMs) return 1;

  const released = held - voice.holdMs;
  if (voice.releaseMs <= 0 || released >= voice.releaseMs) return 0;
  return releaseCurve(voice.shape, released / voice.releaseMs);
}

/**
 * A pool of voices that all write the same subset of the bus. Two of these - one per side
 * of the desync - are what make "flash" and "pressure" genuinely separate signal paths
 * rather than one path with an offset bolted on.
 */
class VoiceBank {
  private readonly voices: Voice[] = [];
  private readonly channels: readonly LightChannel[];

  constructor(channels: readonly LightChannel[], capacity: number) {
    this.channels = channels;
    for (let index = 0; index < capacity; index += 1) {
      this.voices.push({
        active: false,
        startMs: 0,
        attackMs: 0,
        holdMs: 0,
        releaseMs: 0,
        endMs: 0,
        shape: 'strike',
        gain: 1,
        target: neutralPose(),
        owns: noOwnership(),
      });
    }
  }

  get activeCount(): number {
    let count = 0;
    for (const voice of this.voices) if (voice.active) count += 1;
    return count;
  }

  /**
   * @param startMs absolute clock the envelope begins at; may be in the future.
   * @param smear multiplies the authored envelope so a delayed front can also be a softer
   *   one. 1 leaves the authored shape exactly as written.
   */
  spawn(startMs: number, event: LightEvent, gain: number, smear: EnvelopeSmear): void {
    // An event that touches none of this bank's channels must not burn a voice: a pure
    // photon flicker with no shock behind it is legal authoring.
    let owned = false;
    for (const channel of this.channels) {
      if (event.peak[channel] !== undefined) {
        owned = true;
        break;
      }
    }
    if (!owned) return;

    const voice = this.acquire();
    voice.active = true;
    voice.startMs = startMs;
    voice.shape = event.shape;
    voice.gain = gain;
    voice.attackMs = Math.max(event.attackMs * smear.attack, smear.minAttackMs);
    voice.holdMs = event.holdMs * smear.hold;
    voice.releaseMs = event.releaseMs * smear.release;
    voice.endMs = startMs + voice.attackMs + voice.holdMs + voice.releaseMs;

    for (const channel of LIGHT_CHANNELS) {
      voice.owns[channel] = false;
      voice.target[channel] = LIGHT_BUS_NEUTRAL[channel];
    }
    // Only this bank's side of the desync is claimed, so the two banks can carry the same
    // authored event at two different times without ever fighting over a channel.
    for (const channel of this.channels) {
      const peak = event.peak[channel];
      if (peak === undefined) continue;
      voice.owns[channel] = true;
      voice.target[channel] = peak;
    }
  }

  /**
   * Folds every live voice into `into`. Overlapping events combine by LARGEST DEVIATION
   * FROM NEUTRAL, never by sum: summing two strikes blows the corridor to white and reads
   * as a bug, while taking the more extreme of the two preserves the dominant shape and
   * lets a quiet event hide under a loud one exactly the way it would in life.
   */
  accumulate(nowMs: number, into: ChannelPose): void {
    for (const voice of this.voices) {
      if (!voice.active) continue;
      if (nowMs >= voice.endMs) {
        voice.active = false;
        continue;
      }

      const level = envelopeAt(voice, nowMs);
      if (level <= 0) continue;

      for (const channel of this.channels) {
        if (!voice.owns[channel]) continue;
        const neutral = LIGHT_BUS_NEUTRAL[channel];
        const value = neutral + (voice.target[channel] - neutral) * level * voice.gain;
        if (Math.abs(value - neutral) > Math.abs(into[channel] - neutral)) into[channel] = value;
      }
    }
  }

  clear(): void {
    for (const voice of this.voices) voice.active = false;
  }

  /** Steals the voice closest to finishing when the pool is full - standard voice stealing. */
  private acquire(): Voice {
    let oldest: Voice | null = null;
    for (const voice of this.voices) {
      if (!voice.active) return voice;
      if (oldest === null || voice.endMs < oldest.endMs) oldest = voice;
    }
    if (oldest === null) throw new Error('VoiceBank constructed with zero capacity');
    return oldest;
  }
}

/** Per-loop plan for one beat. Allocated once; the rng rewrites it at every loop boundary. */
interface BeatPlan {
  readonly beat: Beat;
  startMs: number;
  gain: number;
  pressureDelayMs: number;
}

/** Fired the moment a beat starts, for the silhouette layer and the debug overlay. */
export interface BeatCue {
  readonly beat: Beat;
  readonly loopIndex: number;
  /** Absolute driver clock the beat fired at. */
  readonly atMs: Millis;
  /** Clock the shock front reaches the corridor. Equals `atMs` for a beat with no light. */
  readonly pressureAtMs: Millis;
}

export type BeatListener = (cue: BeatCue) => void;

export interface BeatTimelinePlayerOptions {
  readonly timeline: BeatTimeline;
  /** Injected rather than taken from the module singleton so tests can watch a private bus. */
  readonly bus: LightBus;
  /** Already forked for this roster by the caller; the player forks per loop from it. */
  readonly rng: Rng;
  readonly motionRules: MotionRules;
}

/**
 * Playback laws that ./types cannot check because they depend on the bus, on the channel
 * routing above, or on the envelope maths. Returns every violation; never throws.
 */
export function validateTimelineForPlayback(timeline: BeatTimeline): string[] {
  const violations: string[] = [];
  const where = `timeline "${timeline.rosterId}"`;
  let pressureRouted = false;

  for (const beat of timeline.beats) {
    const { light } = beat;
    if (light === null) continue;

    const segments: readonly [string, number][] = [
      ['attackMs', light.attackMs],
      ['holdMs', light.holdMs],
      ['releaseMs', light.releaseMs],
    ];
    for (const [name, value] of segments) {
      if (!(Number.isFinite(value) && value >= 0)) {
        violations.push(`sanity: ${where} beat "${beat.id}" light.${name} must be finite and >= 0`);
      }
    }
    if (light.attackMs + light.holdMs + light.releaseMs <= 0) {
      violations.push(`sanity: ${where} beat "${beat.id}" has a zero-length light envelope`);
    }

    let touched = 0;
    for (const channel of LIGHT_CHANNELS) {
      const peak = light.peak[channel];
      if (peak === undefined) continue;
      touched += 1;
      if (CHANNEL_ROUTING[channel] === 'pressure') pressureRouted = true;

      const [min, max] = LIGHT_CHANNEL_RANGE[channel];
      if (!(Number.isFinite(peak) && peak >= min && peak <= max)) {
        // The bus would clamp this silently, and a silently clamped peak is an authored
        // intention that never reaches the player.
        violations.push(
          `sanity: ${where} beat "${beat.id}" peak.${channel} ${peak} is outside the bus domain ${min}..${max}`,
        );
      }
    }
    if (touched === 0) {
      violations.push(`sanity: ${where} beat "${beat.id}" has a light event that moves no channel`);
    }
  }

  if (!pressureRouted) {
    // Without a single pressure-routed peak the delay line never carries anything, so the
    // whole loop arrives as pure light: correct on paper, flat on screen.
    violations.push(
      `law: ${where} never writes a pressure channel (${PRESSURE_CHANNELS.join(', ')}) - ` +
        'light with no shock behind it reads as a camera effect, not as distance',
    );
  }

  return violations;
}

export class BeatTimelinePlayer implements Tickable, Pausable, Disposable {
  readonly timeline: BeatTimeline;

  private readonly bus: LightBus;
  private readonly rng: Rng;
  private motionRules: MotionRules;

  private readonly plans: BeatPlan[];
  private readonly flash: VoiceBank;
  private readonly pressure: VoiceBank;

  private readonly pose: ChannelPose = neutralPose();
  private readonly prevPose: ChannelPose = neutralPose();

  private readonly listeners: BeatListener[] = [];

  /** Monotonic since construction. Voices schedule against this, so a loop wrap cannot
   *  retire a pressure front that is still in the air. */
  private clockMs = 0;
  /** Position inside the current loop. */
  private phase = 0;
  private loop = 0;
  private cursor = 0;
  private paused = false;
  private lastFired: Beat | null = null;

  constructor(options: BeatTimelinePlayerOptions) {
    const violations = [
      ...validateTimeline(options.timeline),
      ...validateTimelineForPlayback(options.timeline),
    ];
    if (violations.length > 0) {
      throw new Error(`BeatTimelinePlayer refused an illegal timeline:\n  ${violations.join('\n  ')}`);
    }

    this.timeline = options.timeline;
    this.bus = options.bus;
    this.rng = options.rng;
    this.motionRules = options.motionRules;

    this.plans = options.timeline.beats.map((beat) => ({
      beat,
      startMs: beat.atMs,
      gain: 1,
      pressureDelayMs: beat.pressureDelayMs,
    }));

    // A beat contributes at most one voice per bank per loop, and no envelope outlives a
    // whole loop, so the beat count is an exact ceiling rather than a guessed budget.
    const capacity = options.timeline.beats.length;
    this.flash = new VoiceBank(FLASH_CHANNELS, capacity);
    this.pressure = new VoiceBank(PRESSURE_CHANNELS, capacity);

    this.planLoop();
  }

  get loopIndex(): number {
    return this.loop;
  }

  get phaseMs(): Millis {
    return this.phase;
  }

  get currentBeat(): Beat | null {
    return this.lastFired;
  }

  get activeVoiceCount(): number {
    return this.flash.activeCount + this.pressure.activeCount;
  }

  /** Read-only cue channel for the silhouette layer. Returns its own unsubscribe. */
  onBeat(listener: BeatListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Reduced motion can be toggled mid-run, so the scale is read per step, not baked in. */
  setMotionRules(motionRules: MotionRules): void {
    this.motionRules = motionRules;
  }

  fixedUpdate(dt: Millis): void {
    if (this.paused) return;

    for (const channel of LIGHT_CHANNELS) this.prevPose[channel] = this.pose[channel];

    this.clockMs += dt;
    this.phase += dt;

    while (this.phase >= this.timeline.loopMs) {
      // The final beat's long hold has just finished playing. It is NOT dead time and must
      // never be trimmed to tighten the loop: the corridor needs three seconds of nothing
      // to re-establish its own baseline, and without that baseline the opening beat of the
      // next loop has nothing to be louder than. Cut the hold and the loop stops landing
      // after two repeats and starts being exhausting after four.
      this.phase -= this.timeline.loopMs;
      this.loop += 1;
      this.cursor = 0;
      this.planLoop();
    }

    for (;;) {
      const plan = this.plans[this.cursor];
      if (plan === undefined || this.phase < plan.startMs) break;
      this.fire(plan);
      this.cursor += 1;
    }

    this.composePose();
  }

  frame(alpha: Alpha): void {
    const t = clamp(alpha, 0, 1);
    for (const channel of LIGHT_CHANNELS) {
      const from = this.prevPose[channel];
      this.bus.setChannel(channel, from + (this.pose[channel] - from) * t);
    }
  }

  /** Back to the top of loop zero with the same seed: the same performance, exactly. */
  reset(): void {
    this.clockMs = 0;
    this.phase = 0;
    this.loop = 0;
    this.cursor = 0;
    this.lastFired = null;
    this.flash.clear();
    this.pressure.clear();
    for (const channel of LIGHT_CHANNELS) {
      this.pose[channel] = LIGHT_BUS_NEUTRAL[channel];
      this.prevPose[channel] = LIGHT_BUS_NEUTRAL[channel];
    }
    this.planLoop();
    this.bus.reset();
  }

  dispose(): void {
    this.listeners.length = 0;
    this.flash.clear();
    this.pressure.clear();
    this.bus.reset();
  }

  private fire(plan: BeatPlan): void {
    const { beat } = plan;
    this.lastFired = beat;
    const pressureAtMs = beat.light === null ? this.clockMs : this.clockMs + plan.pressureDelayMs;

    if (beat.light !== null) {
      this.flash.spawn(this.clockMs, beat.light, plan.gain, FLASH_SMEAR);
      // The same authored event, launched into the future. Nothing else in the driver knows
      // about the delay - it is entirely expressed as this start time.
      this.pressure.spawn(pressureAtMs, beat.light, plan.gain, PRESSURE_SMEAR);
    }

    if (this.listeners.length === 0) return;
    const cue: BeatCue = { beat, loopIndex: this.loop, atMs: this.clockMs, pressureAtMs };
    for (const listener of this.listeners) listener(cue);
  }

  /**
   * Re-humanises every beat for the loop about to play. Forking per loop rather than
   * drawing from one long stream means adding a draw here shifts only this loop, instead of
   * reshuffling every random decision the rest of the game makes after it.
   */
  private planLoop(): void {
    const loopRng = this.rng.fork(this.loop);
    for (const plan of this.plans) {
      const { beat } = plan;
      // Always draw all three, on quiet beats too, so the stream a beat sees never depends
      // on what its neighbours happen to contain.
      const startJitter = loopRng.range(-BEAT_START_JITTER_MS, BEAT_START_JITTER_MS);
      const gainJitter = loopRng.range(-BEAT_GAIN_JITTER, BEAT_GAIN_JITTER);
      const delayJitter = loopRng.range(-PRESSURE_DELAY_JITTER_MS, PRESSURE_DELAY_JITTER_MS);

      plan.startMs = Math.max(0, beat.atMs + startJitter);
      plan.gain = 1 + gainJitter;
      plan.pressureDelayMs =
        beat.light === null
          ? 0
          : clamp(beat.pressureDelayMs + delayJitter, PRESSURE_DELAY_MIN_MS, PRESSURE_DELAY_MAX_MS);
    }
  }

  private composePose(): void {
    for (const channel of LIGHT_CHANNELS) this.pose[channel] = LIGHT_BUS_NEUTRAL[channel];

    this.flash.accumulate(this.clockMs, this.pose);
    this.pressure.accumulate(this.clockMs, this.pose);

    // The motion axis scales how far the corridor is allowed to be thrown from its own
    // baseline. It never touches the timing: a player on reduced motion sees the same
    // performance, quieter, not a different or a shorter one.
    const scale = this.motionRules.battleAnimationScale;
    if (scale === 1) return;
    for (const channel of LIGHT_CHANNELS) {
      const neutral = LIGHT_BUS_NEUTRAL[channel];
      this.pose[channel] = neutral + (this.pose[channel] - neutral) * scale;
    }
  }
}
