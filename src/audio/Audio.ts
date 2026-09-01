/**
 * THE MIXER.
 *
 * Four buses, one graph, and a hard rule that nothing in the game ever touches
 * `AudioContext.destination` directly: every sound is filed under `music`, `sfx` or `ui`,
 * and those three feed `master`. That is what makes the settings screen's volume sliders
 * real - there is exactly one gain node per bus for them to move, and a cue that bypassed
 * the graph would be a sound the player cannot turn down.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 *
 * The graph, the bus mix, the polyphony caps, the retrigger cooldowns, voice stealing and
 * the autoplay unlock are all implemented and work today. What is missing is AUDIO FILES:
 * this project ships no assets yet, so `AUDIO_MANIFEST` is empty and `preload()` is given
 * one by the caller. `play()` on a cue with no buffer is not an error - it records the miss
 * and returns null, so the whole game can be built, played and profiled silently, and the
 * step that adds sound is a manifest, not a refactor.
 *
 * WHY THE CONTEXT IS LAZY
 *
 * Every browser refuses to start an AudioContext outside a user gesture, and a context
 * created at boot lands in `suspended` and stays there - producing a game that is
 * permanently, silently muted on a first visit. So the context is built on first use and
 * `unlock()` is called from the first real input. Decoding works fine while suspended,
 * which is why preloading does not have to wait for the gesture.
 *
 * NO NETWORK: `preload` fetches same-origin bundled assets and nothing else. There is no
 * streaming service, no CDN and no analytics ping anywhere in the audio layer.
 */

import type { Millis } from '../core/types';

export const AUDIO_BUS_IDS = ['master', 'music', 'sfx', 'ui'] as const;

export type AudioBusId = (typeof AUDIO_BUS_IDS)[number];

/** Everything except the master sum. A cue is filed on one of these, never on master. */
export type PlayableBusId = Exclude<AudioBusId, 'master'>;

/**
 * MIX DESIGN, not frame budgets - core/Quality.ts owns every number the profiler holds the
 * game to, and `msBudget.audio` is the one that governs this module's cost. Voice counts and
 * ramp constants are authored values: they sound the same on every tier.
 */
export const AUDIO_TOKENS = Object.freeze({
  /**
   * Volume sliders are linear 0..1; loudness is not. Squaring gets close enough to
   * equal-loudness that the bottom half of the slider stops being a dead zone.
   */
  perceptualExponent: 2,
  /**
   * Time constant for every gain change. Not zero: an instantaneous gain step on a running
   * voice is a click, and a click is the one artefact a player always notices.
   */
  rampSeconds: 0.02,
  /** Hard ceiling on simultaneous voices across all cues. Past this, the oldest is stolen. */
  maxVoices: 48,
});

/* ---------------------------------------------------------------------------------- cues */

/**
 * The cue vocabulary. Named for what HAPPENED, never for the file that plays - the sound
 * designer must be free to replace a sample without a code change. All original material:
 * no cue here references any existing property, character or franchise.
 */
export type CueId =
  | 'ball-throw'
  | 'ball-bounce'
  | 'ball-recover'
  | 'glass-crack'
  | 'glass-shatter'
  | 'glass-shatter-heavy'
  | 'crystal-collect'
  | 'crystal-chime'
  | 'impact-penalty'
  | 'checkpoint'
  | 'zone-clear'
  | 'run-fail'
  | 'ui-move'
  | 'ui-confirm'
  | 'ui-cancel'
  | 'music-bed';

export const CUE_IDS: readonly CueId[] = Object.freeze([
  'ball-throw',
  'ball-bounce',
  'ball-recover',
  'glass-crack',
  'glass-shatter',
  'glass-shatter-heavy',
  'crystal-collect',
  'crystal-chime',
  'impact-penalty',
  'checkpoint',
  'zone-clear',
  'run-fail',
  'ui-move',
  'ui-confirm',
  'ui-cancel',
  'music-bed',
]);

export interface CueDef {
  readonly bus: PlayableBusId;
  /** Trim relative to the bus, in decibels. 0 is the sample as authored. */
  readonly gainDb: number;
  /** Simultaneous voices of THIS cue. A shatter storm must not become a wall of one sample. */
  readonly polyphony: number;
  /** Retrigger guard. Two hits inside this window sound like one louder hit, not two. */
  readonly cooldownMs: Millis;
  readonly loop: boolean;
}

export const CUES: Readonly<Record<CueId, CueDef>> = Object.freeze({
  'ball-throw': { bus: 'sfx', gainDb: -3, polyphony: 4, cooldownMs: 30, loop: false },
  'ball-bounce': { bus: 'sfx', gainDb: -8, polyphony: 8, cooldownMs: 25, loop: false },
  'ball-recover': { bus: 'sfx', gainDb: -6, polyphony: 3, cooldownMs: 40, loop: false },
  'glass-crack': { bus: 'sfx', gainDb: -5, polyphony: 6, cooldownMs: 20, loop: false },
  // The hero sound of the whole game. Loudest cue, widest polyphony, shortest guard.
  'glass-shatter': { bus: 'sfx', gainDb: 0, polyphony: 10, cooldownMs: 15, loop: false },
  'glass-shatter-heavy': { bus: 'sfx', gainDb: 0, polyphony: 4, cooldownMs: 60, loop: false },
  'crystal-collect': { bus: 'sfx', gainDb: -4, polyphony: 6, cooldownMs: 20, loop: false },
  'crystal-chime': { bus: 'sfx', gainDb: -7, polyphony: 4, cooldownMs: 40, loop: false },
  'impact-penalty': { bus: 'sfx', gainDb: -1, polyphony: 2, cooldownMs: 120, loop: false },
  'checkpoint': { bus: 'sfx', gainDb: -2, polyphony: 1, cooldownMs: 500, loop: false },
  'zone-clear': { bus: 'sfx', gainDb: -2, polyphony: 1, cooldownMs: 500, loop: false },
  'run-fail': { bus: 'sfx', gainDb: -2, polyphony: 1, cooldownMs: 500, loop: false },
  'ui-move': { bus: 'ui', gainDb: -12, polyphony: 2, cooldownMs: 30, loop: false },
  'ui-confirm': { bus: 'ui', gainDb: -8, polyphony: 2, cooldownMs: 50, loop: false },
  'ui-cancel': { bus: 'ui', gainDb: -9, polyphony: 2, cooldownMs: 50, loop: false },
  'music-bed': { bus: 'music', gainDb: -6, polyphony: 1, cooldownMs: 0, loop: true },
});

/* ------------------------------------------------------------------------------ manifest */

export interface AudioAsset {
  readonly cue: CueId;
  /** Same-origin, bundle-relative. Resolved by the bundler, never fetched cross-origin. */
  readonly url: string;
  /**
   * Long beds should stream rather than decode into memory whole.
   * TODO(step-2): honoured by routing streamed assets through MediaElementAudioSourceNode;
   * today every asset is decoded into an AudioBuffer regardless of this flag.
   */
  readonly streamed: boolean;
}

export type AudioManifest = readonly AudioAsset[];

/**
 * Empty on purpose - SHATTERPOINT ships no audio files yet, and a manifest naming files
 * that do not exist would fail every preload with a 404 the moment the game booted.
 *
 * TODO(step-2): the audio agent fills this with the authored cue set and flips `streamed`
 * on for `music-bed`.
 */
export const AUDIO_MANIFEST: AudioManifest = Object.freeze([]);

export interface PreloadFailure {
  readonly cue: CueId;
  readonly url: string;
  readonly reason: string;
}

export interface PreloadReport {
  readonly loaded: readonly CueId[];
  readonly failed: readonly PreloadFailure[];
}

/* -------------------------------------------------------------------------------- voices */

export interface PlayOptions {
  /** Extra trim on top of the cue's own, in decibels. */
  readonly gainDb?: number | undefined;
  /** Playback rate. Small random spreads are what stop a repeated sample sounding looped. */
  readonly rate?: number | undefined;
  /** Seconds from now. Used to place a sound on a beat the physics already knows about. */
  readonly delaySeconds?: number | undefined;
}

/** A running voice. `stop()` is idempotent - the caller may also just let it end. */
export interface Voice {
  readonly cue: CueId;
  stop(): void;
}

interface LiveVoice extends Voice {
  readonly source: AudioBufferSourceNode;
  readonly startedAt: number;
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const gainForVolume = (volume: number): number =>
  Math.pow(clamp01(volume), AUDIO_TOKENS.perceptualExponent);

interface BusState {
  /** Null only before the graph exists - see `busState`, which hands out detached mix rows. */
  readonly node: GainNode | null;
  volume: number;
  muted: boolean;
}

/* -------------------------------------------------------------------------------- engine */

export interface AudioEngineOptions {
  /** Injected in tests, or when the host page already owns a context. */
  readonly context?: AudioContext | null | undefined;
}

/**
 * Satisfies `save/Settings.AudioPort` structurally, which is how the options screen drives
 * the mix without either module importing the other's implementation.
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  private readonly provided: AudioContext | null;
  private buses: Map<AudioBusId, BusState> | null = null;

  private readonly buffers = new Map<CueId, AudioBuffer>();
  private readonly voices = new Map<CueId, LiveVoice[]>();
  private readonly lastStart = new Map<CueId, number>();
  private readonly misses = new Set<CueId>();

  /** Mix state survives a context that does not exist yet: sliders work before first sound. */
  private readonly pendingMix = new Map<AudioBusId, BusState>();

  constructor(options: AudioEngineOptions = {}) {
    this.provided = options.context ?? null;
  }

  /** False where WebAudio is unavailable. Every method below stays callable and does nothing. */
  get available(): boolean {
    return this.provided !== null || typeof AudioContext !== 'undefined';
  }

  get running(): boolean {
    return this.context?.state === 'running';
  }

  /**
   * Call from the first real user gesture. Resumes a context the browser parked, and creates
   * one if nothing has needed audio yet. Returns whether sound is actually flowing.
   */
  async unlock(): Promise<boolean> {
    const context = this.ensureContext();
    if (context === null) return false;
    if (context.state === 'running') return true;
    try {
      await context.resume();
    } catch {
      // Called outside a gesture, or the tab is backgrounded. Neither is worth throwing over.
      return false;
    }
    // Read through the getter: `state` was narrowed by the check above and the await is
    // exactly the thing that invalidates that narrowing.
    return this.running;
  }

  /**
   * Fetch and decode. Failures are collected rather than thrown: one missing sound must not
   * stop a boot, and the report is what tells the dev overlay which cue is silent.
   */
  async preload(manifest: AudioManifest = AUDIO_MANIFEST): Promise<PreloadReport> {
    const context = this.ensureContext();
    if (context === null) {
      return {
        loaded: [],
        failed: manifest.map((asset) => ({ cue: asset.cue, url: asset.url, reason: 'no audio context' })),
      };
    }

    const loaded: CueId[] = [];
    const failed: PreloadFailure[] = [];

    await Promise.all(
      manifest.map(async (asset) => {
        try {
          const response = await fetch(asset.url);
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          const bytes = await response.arrayBuffer();
          this.buffers.set(asset.cue, await context.decodeAudioData(bytes));
          loaded.push(asset.cue);
        } catch (error) {
          failed.push({
            cue: asset.cue,
            url: asset.url,
            reason: error instanceof Error ? error.message : 'decode failed',
          });
        }
      }),
    );

    return { loaded, failed };
  }

  setBusVolume(bus: AudioBusId, volume: number): void {
    const state = this.busState(bus);
    state.volume = clamp01(volume);
    this.applyBusGain(bus, state);
  }

  setBusMuted(bus: AudioBusId, muted: boolean): void {
    const state = this.busState(bus);
    state.muted = muted;
    this.applyBusGain(bus, state);
  }

  busVolume(bus: AudioBusId): number {
    return this.busState(bus).volume;
  }

  busMuted(bus: AudioBusId): boolean {
    return this.busState(bus).muted;
  }

  /**
   * Fires a cue. Returns null - never throws - when the cue is on cooldown, when audio is
   * unavailable, or when no buffer has been loaded for it yet. A silent game is a playable
   * game; an exception thrown from a shatter callback is not.
   */
  play(cue: CueId, options: PlayOptions = {}): Voice | null {
    const context = this.ensureContext();
    const buses = this.buses;
    if (context === null || buses === null) return null;

    const buffer = this.buffers.get(cue);
    if (buffer === undefined) {
      this.misses.add(cue);
      return null;
    }

    const def = CUES[cue];
    const now = context.currentTime;
    const last = this.lastStart.get(cue);
    if (last !== undefined && (now - last) * 1000 < def.cooldownMs) return null;

    const bus = buses.get(def.bus);
    if (bus === undefined || bus.node === null) return null;

    this.enforcePolyphony(cue, def.polyphony);

    const gain = context.createGain();
    gain.gain.value = dbToGain(def.gainDb + (options.gainDb ?? 0));
    gain.connect(bus.node);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = def.loop;
    if (options.rate !== undefined) source.playbackRate.value = options.rate;
    source.connect(gain);

    let stopped = false;
    const voice: LiveVoice = {
      cue,
      source,
      startedAt: now,
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          source.stop();
        } catch {
          // Already ended. Stopping a finished source throws in some engines and is a no-op.
        }
      },
    };

    source.onended = (): void => {
      gain.disconnect();
      this.forget(voice);
    };

    source.start(now + (options.delaySeconds ?? 0));
    this.lastStart.set(cue, now);
    this.track(voice);
    return voice;
  }

  stopCue(cue: CueId): void {
    for (const voice of this.voices.get(cue) ?? []) voice.stop();
  }

  stopAll(): void {
    for (const list of this.voices.values()) {
      for (const voice of [...list]) voice.stop();
    }
  }

  /** Cues that were asked for but had no buffer. Feeds the dev overlay, not the player. */
  missingCues(): readonly CueId[] {
    return [...this.misses];
  }

  liveVoiceCount(): number {
    let total = 0;
    for (const list of this.voices.values()) total += list.length;
    return total;
  }

  dispose(): void {
    this.stopAll();
    this.voices.clear();
    this.buffers.clear();
    this.buses = null;
    // A context this engine did not create belongs to whoever passed it in.
    if (this.context !== null && this.context !== this.provided) void this.context.close();
    this.context = null;
  }

  /* --------------------------------------------------------------------------- internals */

  private ensureContext(): AudioContext | null {
    if (this.context !== null) return this.context;
    if (this.provided !== null) {
      this.context = this.provided;
    } else {
      if (typeof AudioContext === 'undefined') return null;
      try {
        this.context = new AudioContext();
      } catch {
        return null;
      }
    }
    this.buildGraph(this.context);
    return this.context;
  }

  /** master -> destination, everything else -> master. Built once, never rewired. */
  private buildGraph(context: AudioContext): void {
    const master = context.createGain();
    master.connect(context.destination);

    const buses = new Map<AudioBusId, BusState>();
    buses.set('master', this.adoptMix('master', master));

    for (const bus of AUDIO_BUS_IDS) {
      if (bus === 'master') continue;
      const node = context.createGain();
      node.connect(master);
      buses.set(bus, this.adoptMix(bus, node));
    }

    this.buses = buses;
    for (const [bus, state] of buses) this.applyBusGain(bus, state);
  }

  /** Carries any volume set before the context existed onto the real node. */
  private adoptMix(bus: AudioBusId, node: GainNode): BusState {
    const pending = this.pendingMix.get(bus);
    return { node, volume: pending?.volume ?? 1, muted: pending?.muted ?? false };
  }

  /**
   * Returns the live bus when there is a graph, and a detached placeholder when there is
   * not, so the settings screen can set a volume before the first gesture and have it stick.
   */
  private busState(bus: AudioBusId): BusState {
    const live = this.buses?.get(bus);
    if (live !== undefined) return live;
    const pending = this.pendingMix.get(bus);
    if (pending !== undefined) return pending;
    const detached: BusState = { node: null, volume: 1, muted: false };
    this.pendingMix.set(bus, detached);
    return detached;
  }

  private applyBusGain(bus: AudioBusId, state: BusState): void {
    this.pendingMix.set(bus, state);
    const context = this.context;
    if (context === null || state.node === null || this.buses?.get(bus) !== state) return;
    const target = state.muted ? 0 : gainForVolume(state.volume);
    state.node.gain.setTargetAtTime(target, context.currentTime, AUDIO_TOKENS.rampSeconds);
  }

  /** Steals the oldest voice of the cue, and then the oldest voice anywhere, to stay in budget. */
  private enforcePolyphony(cue: CueId, limit: number): void {
    const list = this.voices.get(cue);
    while (list !== undefined && list.length >= limit) {
      const oldest = list[0];
      if (oldest === undefined) break;
      oldest.stop();
      this.forget(oldest);
    }

    while (this.liveVoiceCount() >= AUDIO_TOKENS.maxVoices) {
      const oldest = this.oldestVoice();
      if (oldest === null) break;
      oldest.stop();
      this.forget(oldest);
    }
  }

  private oldestVoice(): LiveVoice | null {
    let found: LiveVoice | null = null;
    for (const list of this.voices.values()) {
      for (const voice of list) {
        if (found === null || voice.startedAt < found.startedAt) found = voice;
      }
    }
    return found;
  }

  private track(voice: LiveVoice): void {
    const list = this.voices.get(voice.cue);
    if (list === undefined) this.voices.set(voice.cue, [voice]);
    else list.push(voice);
  }

  private forget(voice: LiveVoice): void {
    const list = this.voices.get(voice.cue);
    if (list === undefined) return;
    const index = list.indexOf(voice);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.voices.delete(voice.cue);
  }
}

/**
 * TODO(step-2), all of it seam-complete and none of it faked here:
 *   - music: crossfade between beds on a universe change, and duck `music` under
 *     `impact-penalty` and `zone-clear` (the graph already has the bus to duck).
 *   - streaming: route `AudioAsset.streamed` through MediaElementAudioSourceNode so a long
 *     bed does not decode into memory whole.
 *   - space: one ConvolverNode per universe theme, fed from UniverseTheme, plus a
 *     PannerNode on shatter cues so glass breaking left of the camera sounds left.
 *   - budget: assert this module's per-frame cost against `QUALITY[tier].msBudget.audio`
 *     once the profiler exists.
 */
