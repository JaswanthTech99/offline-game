/**
 * BALLS ARE BOTH HEALTH AND AMMO. There is ONE number.
 *
 * Every other survival game keeps two bars and then has to invent a reason for the player to
 * care about either. Here the resource you shoot is the resource you live on, so every throw
 * is a wager and every crystal is a reprieve. Splitting this into `health` and `ammo` would
 * delete the entire risk model of the game, so the counter is private and the only ways to
 * move it are the four verbs below.
 *
 * WHY THE BALANCE TABLE LIVES HERE AND NOT IN core/Quality.ts
 * Quality.ts is the perf axis: numbers that change because the hardware changed. These are
 * design-law numbers - they are identical on a phone and on a workstation, and a tier that
 * quietly grants more ammo would be a different game, not a cheaper one. Same reasoning as
 * the timeline laws in battle/types.ts, which live with the contract they constrain.
 * TODO(step-2): if a src/core/Balance.ts is introduced, move AMMO_BALANCE, CRYSTAL_BALANCE,
 * THROW_BALANCE and BALL_PHYSICS into it verbatim; this module does not own core/.
 */

/** Listener signature for every typed emitter in the gameplay layer. */
export type Listener<TEvent> = (event: TEvent) => void;

/** Returned by `on`. Calling it twice is safe - the second call is a no-op. */
export type Unsubscribe = () => void;

/**
 * The gameplay layer's one event primitive. Dispatch iterates a snapshot so a listener may
 * unsubscribe (or subscribe) from inside its own callback without corrupting the walk - the
 * HUD does exactly that when a run ends.
 *
 * TODO(step-2): lift to src/core/Emitter.ts once that module exists; it is here because
 * Ammo is the root of the gameplay layer's import graph and this agent does not own core/.
 */
export class Emitter<TEvent> {
  private listeners: Listener<TEvent>[] = [];

  on(listener: Listener<TEvent>): Unsubscribe {
    this.listeners.push(listener);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  emit(event: TEvent): void {
    if (this.listeners.length === 0) return;
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) listener(event);
  }

  clear(): void {
    this.listeners.length = 0;
  }
}

export const AMMO_BALANCE = Object.freeze({
  /** Enough to survive learning the first corridor, few enough that waste is felt. */
  startingBalls: 25,
  /** Ceiling exists so a crystal-rich stretch cannot bank an unloseable run. */
  maxBalls: 99,
  /** One throw, one ball. The whole economy hangs off this being exactly 1. */
  throwCost: 1,
  /** A cluster pays back three throws: collect two clusters and you are net ahead. */
  clusterGrant: 3,
  /**
   * Ten. A mistake must cost more than a miss, or the correct strategy is to ignore aiming
   * and barge through the glass - which is the one thing the game must never reward.
   */
  obstacleStrikePenalty: 10,
  reaction: Object.freeze({
    /** Amount that maps to a full-strength gain reaction. */
    gainReference: 3,
    /** Amount that maps to a full-strength loss reaction. */
    lossReference: 10,
    /** Floor so a +1 trickle still registers on the HUD instead of reading as a dropped input. */
    minStrength: 0.35,
    punchScale: 1.0,
    glowScale: 1.35,
    shakeScale: 1.0,
    desaturateScale: 0.85,
    /** At or below this the reaction is always full strength: the last balls must feel last. */
    criticalBalls: 5,
  }),
});

export type AmmoGainReason = 'crystal-cluster' | 'grant' | 'run-start';
export type AmmoLossReason = 'throw' | 'obstacle-strike';

/**
 * Pre-computed animation intent, 0..1 per channel. The HUD does not get to decide how hard a
 * -10 hurts: that is a balance decision and it belongs next to the number that caused it.
 * All four channels are always present so the HUD can drive one timeline with no branching.
 */
export interface AmmoReaction {
  /** Scale punch on the counter. Transform only. */
  readonly punch: number;
  /** Glow spike behind the counter. Opacity only. */
  readonly glow: number;
  /** Screen/HUD shake amplitude. Scaled again by MotionRules before it is applied. */
  readonly shake: number;
  /** Desaturation snap depth - the colour drains for an instant on a loss. */
  readonly desaturate: number;
}

const NO_REACTION: AmmoReaction = Object.freeze({ punch: 0, glow: 0, shake: 0, desaturate: 0 });

export type AmmoEvent =
  | {
      readonly kind: 'gain';
      readonly reason: AmmoGainReason;
      readonly amount: number;
      /** Count AFTER the change - the HUD renders this directly, no arithmetic. */
      readonly balls: number;
      readonly reaction: AmmoReaction;
    }
  | {
      readonly kind: 'loss';
      readonly reason: AmmoLossReason;
      readonly amount: number;
      readonly balls: number;
      readonly reaction: AmmoReaction;
    }
  | {
      /** A throw was attempted with nothing to throw. Distinct from `loss` of 0. */
      readonly kind: 'blocked';
      readonly reason: 'throw';
      readonly balls: number;
    }
  | {
      /** Fires exactly once per run, on the transition to zero. The run is over. */
      readonly kind: 'depleted';
      readonly reason: AmmoLossReason;
      readonly balls: 0;
    }
  | { readonly kind: 'reset'; readonly balls: number };

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * The run's single number. Integer at all times: a fractional ball would render as "24.7" on
 * the HUD and make the "one more throw?" decision unanswerable.
 */
export class Ammo {
  private readonly events = new Emitter<AmmoEvent>();
  private count: number;
  /** Latched so a penalty that lands on an already-dead run cannot re-fire the game over. */
  private depletedLatch = false;

  constructor(startingBalls: number = AMMO_BALANCE.startingBalls) {
    this.count = clamp(Math.trunc(startingBalls), 0, AMMO_BALANCE.maxBalls);
    this.depletedLatch = this.count === 0;
  }

  get balls(): number {
    return this.count;
  }

  get isDepleted(): boolean {
    return this.depletedLatch;
  }

  on(listener: Listener<AmmoEvent>): Unsubscribe {
    return this.events.on(listener);
  }

  /** True if `ballsToThrow` balls can be paid for right now. */
  canThrow(ballsToThrow = 1): boolean {
    if (this.depletedLatch) return false;
    return this.count >= AMMO_BALANCE.throwCost * Math.max(1, Math.trunc(ballsToThrow));
  }

  /**
   * Charges for a throw. Returns false and emits `blocked` when it cannot be paid, so the
   * caller never has to read the counter to decide - the transaction is the decision.
   *
   * A multi-ball throw charges once per THROW, not once per projectile: see THROW_BALANCE.
   */
  spendForThrow(throws = 1): boolean {
    const cost = AMMO_BALANCE.throwCost * Math.max(1, Math.trunc(throws));
    if (this.depletedLatch || this.count < cost) {
      this.events.emit({ kind: 'blocked', reason: 'throw', balls: this.count });
      return false;
    }
    this.applyLoss(cost, 'throw');
    return true;
  }

  /** A crystal cluster was shattered. `clusters` > 1 only when two pop in the same step. */
  grantCluster(clusters = 1): number {
    const amount = AMMO_BALANCE.clusterGrant * Math.max(1, Math.trunc(clusters));
    return this.applyGain(amount, 'crystal-cluster');
  }

  /** Out-of-band top-up: a pickup, a debug command, a run-start bonus. */
  grant(amount: number, reason: AmmoGainReason = 'grant'): number {
    return this.applyGain(Math.max(0, Math.trunc(amount)), reason);
  }

  /** The player hit glass they failed to break. The single most expensive event in the run. */
  strikeObstacle(): number {
    return this.applyLoss(AMMO_BALANCE.obstacleStrikePenalty, 'obstacle-strike');
  }

  reset(startingBalls: number = AMMO_BALANCE.startingBalls): void {
    this.count = clamp(Math.trunc(startingBalls), 0, AMMO_BALANCE.maxBalls);
    this.depletedLatch = this.count === 0;
    this.events.emit({ kind: 'reset', balls: this.count });
  }

  dispose(): void {
    this.events.clear();
  }

  private applyGain(amount: number, reason: AmmoGainReason): number {
    // A gain after the run has ended is discarded rather than resurrecting the player: the
    // ball that was already in flight must not undo the game over the HUD has begun playing.
    if (amount <= 0 || this.depletedLatch) return 0;
    const before = this.count;
    this.count = clamp(before + amount, 0, AMMO_BALANCE.maxBalls);
    const applied = this.count - before;
    if (applied === 0) return 0;

    const strength = this.strengthFor(applied, AMMO_BALANCE.reaction.gainReference);
    this.events.emit({
      kind: 'gain',
      reason,
      amount: applied,
      balls: this.count,
      reaction: {
        punch: strength * AMMO_BALANCE.reaction.punchScale,
        glow: strength * AMMO_BALANCE.reaction.glowScale,
        shake: 0,
        desaturate: 0,
      },
    });
    return applied;
  }

  private applyLoss(amount: number, reason: AmmoLossReason): number {
    if (amount <= 0 || this.depletedLatch) return 0;
    const before = this.count;
    this.count = clamp(before - amount, 0, AMMO_BALANCE.maxBalls);
    const applied = before - this.count;

    const strength = this.strengthFor(amount, AMMO_BALANCE.reaction.lossReference);
    this.events.emit({
      kind: 'loss',
      reason,
      amount: applied,
      balls: this.count,
      reaction: {
        punch: 0,
        glow: 0,
        shake: strength * AMMO_BALANCE.reaction.shakeScale,
        desaturate: strength * AMMO_BALANCE.reaction.desaturateScale,
      },
    });

    if (this.count === 0) {
      this.depletedLatch = true;
      this.events.emit({ kind: 'depleted', reason, balls: 0 });
    }
    return applied;
  }

  /**
   * Reaction strength rises with the size of the change, but floors at `minStrength` so small
   * changes still read, and pins to full when the run is nearly over.
   */
  private strengthFor(amount: number, reference: number): number {
    if (this.count <= AMMO_BALANCE.reaction.criticalBalls) return 1;
    return clamp(amount / reference, AMMO_BALANCE.reaction.minStrength, 1);
  }
}

/** Neutral reaction, for HUD code that needs a shape before the first event arrives. */
export const AMMO_REACTION_NONE: AmmoReaction = NO_REACTION;
