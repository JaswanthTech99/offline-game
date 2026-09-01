/**
 * THE LIGHT BUS.
 *
 * The battle layer on the parallax backdrop is the only thing in SHATTERPOINT allowed to
 * change the mood of the corridor, and it does it through these five floats. The battle
 * WRITES them; the corridor materials, the crystal shader, the glass edge term and the
 * ball rim light READ them, every frame, as live TSL uniforms.
 *
 * ============================ READ THIS BEFORE TOUCHING IT ============================
 * Compositing a glow sprite, a flash quad, a screen-space overlay or an extra post pass
 * ON TOP of the frame to fake a battle light event is a FAILED IMPLEMENTATION. It is not
 * a shortcut, it is the wrong result: a decal over the image cannot brighten the emissive
 * trim on the far side of a pillar, cannot thicken a god ray, cannot put a rim on the ball
 * in the player's hand, and cannot survive the glass refraction that sells the whole game.
 * The distant lightning must light the near geometry. That only happens if these uniforms
 * move. If your change does not move a value on this bus, the battle is wallpaper.
 * ======================================================================================
 *
 * There is exactly one bus (`lightBus`). Materials capture its nodes at build time, so the
 * bus must exist before any material is compiled - it is constructed at module load, which
 * is safe because `uniform()` needs no renderer.
 */

import { uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Alpha } from '../core/types';

export interface LightBusState {
  /** Multiplier on every emissive trim, brazier and crystal in the corridor. 1 = neutral. */
  readonly emisIntensity: number;
  /** Opacity of the volumetric shafts cutting through the corridor. 0 = no shafts. */
  readonly shaftOpacity: number;
  /** Extra glow pushed into practical light sources (braziers, forges, lanterns). */
  readonly brazierGlow: number;
  /** Fraction the sky gradient is darkened by, so a distant strike can silhouette it. */
  readonly skyDim: number;
  /** Rim-light strength on the ball and on shard edges - the tell that a strike landed. */
  readonly rimBoost: number;
}

export type LightChannel = keyof LightBusState;

export const LIGHT_CHANNELS: readonly LightChannel[] = Object.freeze([
  'emisIntensity',
  'shaftOpacity',
  'brazierGlow',
  'skyDim',
  'rimBoost',
]);

/** Neutral pose: the corridor lit purely by its own theme, no battle influence at all. */
export const LIGHT_BUS_NEUTRAL: LightBusState = Object.freeze({
  emisIntensity: 1,
  shaftOpacity: 0,
  brazierGlow: 0,
  skyDim: 0,
  rimBoost: 0,
});

/**
 * Semantic domains, not performance budgets - these bound what the value MEANS, so a
 * runaway beat cannot blow the corridor to white. Perf numbers live in core/Quality.ts.
 */
export const LIGHT_CHANNEL_RANGE: Readonly<Record<LightChannel, readonly [number, number]>> =
  Object.freeze({
    emisIntensity: Object.freeze([0, 8] as const),
    shaftOpacity: Object.freeze([0, 1] as const),
    brazierGlow: Object.freeze([0, 4] as const),
    skyDim: Object.freeze([0, 1] as const),
    rimBoost: Object.freeze([0, 4] as const),
  });

/**
 * The read side. Typed as bare `Node<'float'>` on purpose: a consumer can compose these in
 * any TSL graph but cannot reach `.value`, so "materials read, battle writes" is enforced
 * by the compiler rather than by a comment.
 */
export interface LightBusUniforms {
  readonly emisIntensity: Node<'float'>;
  readonly shaftOpacity: Node<'float'>;
  readonly brazierGlow: Node<'float'>;
  readonly skyDim: Node<'float'>;
  readonly rimBoost: Node<'float'>;
}

const clampChannel = (channel: LightChannel, value: number): number => {
  const [min, max] = LIGHT_CHANNEL_RANGE[channel];
  if (!Number.isFinite(value)) return LIGHT_BUS_NEUTRAL[channel];
  return value < min ? min : value > max ? max : value;
};

export class LightBus {
  private readonly nodes = {
    emisIntensity: uniform(LIGHT_BUS_NEUTRAL.emisIntensity).setName('lightBusEmisIntensity'),
    shaftOpacity: uniform(LIGHT_BUS_NEUTRAL.shaftOpacity).setName('lightBusShaftOpacity'),
    brazierGlow: uniform(LIGHT_BUS_NEUTRAL.brazierGlow).setName('lightBusBrazierGlow'),
    skyDim: uniform(LIGHT_BUS_NEUTRAL.skyDim).setName('lightBusSkyDim'),
    rimBoost: uniform(LIGHT_BUS_NEUTRAL.rimBoost).setName('lightBusRimBoost'),
  };

  /** Hand this to materials. It is the same object every frame - capture it once. */
  readonly uniforms: LightBusUniforms = this.nodes;

  /**
   * Mirror of the uniform values kept on the CPU. Uniform nodes are write-oriented and
   * reading `.value` back per channel per frame is needless indirection when the bus is
   * blended dozens of times a second by the beat scheduler.
   */
  private readonly state: Record<LightChannel, number> = { ...LIGHT_BUS_NEUTRAL };

  /** Current values, copied so a caller cannot smuggle a write past `setChannel`. */
  snapshot(): LightBusState {
    return { ...this.state };
  }

  get(channel: LightChannel): number {
    return this.state[channel];
  }

  setChannel(channel: LightChannel, value: number): void {
    const clamped = clampChannel(channel, value);
    if (this.state[channel] === clamped) return;
    this.state[channel] = clamped;
    this.nodes[channel].value = clamped;
  }

  /** Partial write - the normal path for a beat that only moves two of the five channels. */
  set(patch: Partial<LightBusState>): void {
    for (const channel of LIGHT_CHANNELS) {
      const next = patch[channel];
      if (next !== undefined) this.setChannel(channel, next);
    }
  }

  /**
   * Frame-rate independent interpolation is the caller's job: pass an already-eased t so
   * beat envelopes stay reproducible under the fixed step rather than depending on dt.
   */
  blendTo(target: LightBusState, t: Alpha): void {
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    for (const channel of LIGHT_CHANNELS) {
      const from = this.state[channel];
      this.setChannel(channel, from + (target[channel] - from) * k);
    }
  }

  reset(): void {
    this.set(LIGHT_BUS_NEUTRAL);
  }
}

/**
 * The single instance every material binds to. Injecting a second bus means half the
 * corridor stops responding to the battle - construct your own only in tests.
 */
export const lightBus = new LightBus();
