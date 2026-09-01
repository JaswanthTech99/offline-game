/**
 * THE BALL COUNT.
 *
 * The loudest element on the screen, and the only number in the game that ends a run. A
 * player must be able to read it in peripheral vision while a corridor is disassembling
 * itself in front of them, which is why it is a machined numeral rather than a label: a
 * hard lower bevel, a light upper bevel, and three stacked glow radii, so the glyph reads
 * as a physical part lit from above and sitting proud of the glass.
 *
 * =========================== THE BEVEL TRAP - READ THIS ===============================
 * DO NOT build this numeral with a gradient clipped to the text:
 *
 *     background: linear-gradient(#fff, #6b7a8c);
 *     -webkit-background-clip: text;
 *     color: transparent;
 *
 * It looks like the obvious way to get a metallic top-to-bottom ramp and it is WRONG here.
 * The gradient grades across the element's EM BOX, not across the glyph outlines. This
 * numeral runs at `line-height: .8` because the crop is what makes it read as machined -
 * so the em box is far shorter than the digits' visual extent, the glyphs sample only the
 * middle band of the ramp, and every digit renders a flat steel-grey with no top light and
 * no bottom shadow. It will look "nearly right" in a screenshot at 200% and dead on a
 * phone. The fix is not to tune the stops or the line-height; the technique cannot express
 * a bevel that follows a glyph.
 *
 * A SOLID fill plus stacked `text-shadow` layers is the correct technique, because shadows
 * are cast from the GLYPH OUTLINE: a zero-blur dark shadow one pixel down is a machined
 * cut on the underside of the stroke no matter how tall the box is, and a zero-blur light
 * shadow one pixel up is the lit top edge. Everything below depends on that.
 * ======================================================================================
 *
 * The numeral also has to react physically. Balls arrive and leave constantly and a
 * count that merely swaps its digits is invisible during play, so gain, spend and penalty
 * each drive a spring: a scale punch, a vertical kick, a glow flare and a colour echo.
 * The springs are integrated on the FIXED step and only interpolated in `frame()`, so the
 * feel of a pickup is identical at 30, 60 and 144 fps.
 */

import type { MotionRules } from '../../core/Quality';
import type { Alpha, Disposable, Millis, Tickable } from '../../core/types';
import { NumVar, addStyleOnce, el, setAttr, setText } from '../Overlay';

/** Why the count moved. Ammo is the producer; the HUD never infers a cause from a delta. */
export type BallEventKind = 'gain' | 'spend' | 'penalty';

export interface BallEvent {
  readonly kind: BallEventKind;
  /** Always positive. Direction is carried by `kind`, never by the sign of the amount. */
  readonly amount: number;
}

/**
 * Feel constants. These are art direction - spring rates and impulse magnitudes tuned by
 * hand against the throw cadence - not performance budgets, so they live with the widget
 * they shape rather than in core/Quality.ts, exactly as universe/LightBus.ts keeps its
 * semantic channel ranges local. Nothing here is read per tier; if it ever is, it moves.
 */
const FEEL = Object.freeze({
  /** Underdamped on purpose (zeta ~0.68): one visible bounce, settled inside ~250ms. */
  scaleStiffness: 260,
  scaleDamping: 22,
  kickStiffness: 320,
  kickDamping: 24,
  /** A 30-crystal pickup must not launch the numeral off the screen. */
  saturateAt: 8,
  gainScaleImpulse: 3.2,
  gainKickImpulse: -110,
  gainFlare: 0.75,
  spendScaleImpulse: -1.1,
  spendKickImpulse: 26,
  spendFlare: 0.2,
  penaltyScaleImpulse: -2.6,
  penaltyKickImpulse: 150,
  penaltyFlare: 1,
  /** Per-second exponential decay. Colour outlives the flare so the cause stays legible. */
  flareDecay: 4.2,
  tintDecay: 2.6,
  /**
   * Floor applied to the FLARE impulse when hudPulseScale is 0. Reduced motion may stop
   * the numeral moving; it may not make a state change unreadable. Light is not motion.
   */
  flareFloor: 0.55,
  /** At or below this many balls the count goes critical. Three throws from a dead run. */
  criticalAt: 3,
});

const SECONDS_PER_MS = 0.001;

/**
 * The three glow radii are three separate shadows rather than one big blur because a
 * single wide blur reads as fog: the tight radius keeps the glyph edge crisp, the middle
 * one carries the colour, and the wide one is the only part that touches the corridor
 * behind it. `--bc-flare` lifts all three together on an event.
 *
 * The tint echoes are duplicate glyphs stacked over the face and blended with `screen`,
 * driven by opacity alone. That is not a workaround: a text-shadow colour cannot be
 * animated without rewriting the whole shadow string every frame, and rewriting a
 * text-shadow string per frame is a paint invalidation on the largest glyph on screen.
 * `isolation: isolate` bounds the blend group so the compositor never has to sample the
 * WebGPU canvas behind it.
 */
const BALL_COUNT_CSS = `
.sp-bc {
  --bc-scale: 1;
  --bc-kick: 0;
  --bc-flare: 0;
  --bc-cool: 0;
  --bc-hot: 0;
  --bc-size: 108px;
  /* A half-step brighter than plain ink: the count is the loudest glyph on screen. */
  --bc-ink: color-mix(in oklab, var(--ink) 82%, white);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.sp-overlay[data-size='tablet'] .sp-bc { --bc-size: 84px; }
.sp-overlay[data-size='phone']  .sp-bc { --bc-size: 60px; }

.sp-bc-stack {
  position: relative;
  isolation: isolate;
  font-family: var(--sp-font-ui);
  font-size: var(--bc-size);
  font-weight: 800;
  /* The crop that makes it read as machined - and the reason background-clip:text cannot
     be used here. See the trap at the top of this file. */
  line-height: 0.8;
  letter-spacing: -0.035em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
  transform: translate3d(0, calc(var(--bc-kick) * 1px), 0) scale(var(--bc-scale));
  transform-origin: 0% 100%;
  will-change: transform;
}

.sp-bc-num { display: block; white-space: pre; }

.sp-bc-face {
  /* SOLID fill. Not a clipped gradient. */
  color: var(--bc-ink);
  text-shadow:
    /* light upper bevel - one pixel, zero blur: a lit top edge, not a glow */
    0 -1px 0 rgba(228, 244, 255, 0.72),
    /* HARD LOWER BEVEL - stepped, zero blur, near black: the machined cut */
    0 1px 0 var(--void-100),
    0 2px 0 color-mix(in oklab, var(--void-100) 60%, var(--void-000)),
    0 3px 0 var(--void-000),
    0 4px 1px rgba(0, 0, 0, 0.85),
    /* three stacked glow radii: edge, colour, room */
    0 0 10px rgba(111, 216, 255, calc(0.30 + 0.45 * var(--bc-flare))),
    0 0 34px rgba(80, 170, 235, calc(0.18 + 0.42 * var(--bc-flare))),
    0 0 92px rgba(40, 120, 200, calc(0.08 + 0.36 * var(--bc-flare)));
}

.sp-bc-echo {
  position: absolute;
  left: 0;
  top: 0;
  mix-blend-mode: screen;
  will-change: opacity;
}
.sp-bc-echo--cool {
  color: var(--sp-gain);
  opacity: var(--bc-cool);
  text-shadow: 0 0 14px rgba(125, 255, 196, 0.7), 0 0 48px rgba(90, 220, 170, 0.45);
}
.sp-bc-echo--hot {
  color: var(--sp-danger);
  opacity: var(--bc-hot);
  text-shadow: 0 0 14px rgba(255, 93, 108, 0.75), 0 0 52px rgba(220, 60, 80, 0.5);
}

.sp-bc-foot { display: flex; align-items: center; gap: 8px; }
.sp-bc-label { color: var(--sp-ink-faint); }
.sp-bc-delta {
  font-family: var(--sp-font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  opacity: var(--bc-flare);
  will-change: opacity;
}
.sp-bc[data-last='gain'] .sp-bc-delta { color: var(--sp-gain); }
.sp-bc[data-last='penalty'] .sp-bc-delta { color: var(--sp-danger); }
.sp-bc[data-last='spend'] .sp-bc-delta { color: var(--sp-ink-dim); }

.sp-bc[data-critical='true'] { --bc-ink: color-mix(in oklab, var(--flare) 20%, var(--ink)); }
.sp-bc[data-critical='true'] .sp-bc-label { color: var(--sp-danger); }

/* Opacity only, and switched off from the motion axis rather than from a media query, so
   core/Quality.ts stays the single place reduced motion is decided. */
@keyframes sp-bc-breath { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.sp-bc[data-critical='true'][data-still='false'] .sp-bc-label {
  animation: sp-bc-breath 900ms ease-in-out infinite;
}
`;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

export class BallCount implements Tickable, Disposable {
  readonly root: HTMLDivElement;

  private readonly face: HTMLSpanElement;
  private readonly echoCool: HTMLSpanElement;
  private readonly echoHot: HTMLSpanElement;
  private readonly delta: HTMLSpanElement;

  private readonly varScale: NumVar;
  private readonly varKick: NumVar;
  private readonly varFlare: NumVar;
  private readonly varCool: NumVar;
  private readonly varHot: NumVar;

  private pulse: number;

  private count = 0;
  private countDirty = true;

  // Spring state. `*Prev` is captured at the top of each fixed step so frame() can
  // interpolate rather than sample - the whole reason the sim is fixed-step in the first
  // place. Writing these from frame() would make the feel frame-rate dependent.
  private scale = 1;
  private scaleVel = 0;
  private scalePrev = 1;
  private kick = 0;
  private kickVel = 0;
  private kickPrev = 0;
  private flare = 0;
  private flarePrev = 0;
  private tint = 0;
  private tintPrev = 0;

  constructor(parent: HTMLElement, motion: MotionRules) {
    addStyleOnce('sp-ballcount', BALL_COUNT_CSS);

    this.pulse = motion.hudPulseScale;

    this.root = el('div', 'sp-bc', parent);
    // Deliberately NOT role="status": a polite live region on a number that changes on
    // every throw turns a screen reader into a metronome. Overlay.announce() is the one
    // channel allowed to speak, and it is used for run-shaped events, not for each ball.
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Balls remaining');
    this.root.dataset['critical'] = 'false';
    this.root.dataset['last'] = 'spend';
    this.root.dataset['still'] = motion.hudPulseScale === 0 ? 'true' : 'false';

    const stack = el('div', 'sp-bc-stack', this.root);
    this.face = el('span', 'sp-bc-num sp-bc-face', stack);
    this.echoCool = el('span', 'sp-bc-num sp-bc-echo sp-bc-echo--cool', stack);
    this.echoHot = el('span', 'sp-bc-num sp-bc-echo sp-bc-echo--hot', stack);
    this.echoCool.setAttribute('aria-hidden', 'true');
    this.echoHot.setAttribute('aria-hidden', 'true');

    const foot = el('div', 'sp-bc-foot', this.root);
    const label = el('span', 'sp-label sp-bc-label', foot);
    label.textContent = 'Balls';
    this.delta = el('span', 'sp-bc-delta', foot);
    this.delta.setAttribute('aria-hidden', 'true');

    // Quantisation steps: a hundredth of a scale unit and a tenth of a pixel are both
    // below what the compositor can show, so anything finer is a wasted style write.
    this.varScale = new NumVar(this.root, '--bc-scale', 0.002);
    this.varKick = new NumVar(this.root, '--bc-kick', 0.1);
    this.varFlare = new NumVar(this.root, '--bc-flare', 0.01);
    this.varCool = new NumVar(this.root, '--bc-cool', 0.01);
    this.varHot = new NumVar(this.root, '--bc-hot', 0.01);
  }

  /** Reduced motion can be toggled mid-session; the springs keep their state. */
  setMotion(motion: MotionRules): void {
    this.pulse = motion.hudPulseScale;
    setAttr(this.root, 'data-still', motion.hudPulseScale === 0 ? 'true' : 'false');
  }

  /** Idempotent: the HUD pushes the authoritative count every frame, event or not. */
  setCount(count: number): void {
    const next = Math.max(0, Math.trunc(count));
    if (next === this.count && !this.countDirty) return;
    this.count = next;
    this.countDirty = true;
  }

  /**
   * The physical reaction. Ammo calls this once per gain, spend or penalty; the count
   * itself still arrives through `setCount`, so a dropped event costs a punch, never a
   * wrong number on screen.
   */
  apply(event: BallEvent): void {
    const weight = clamp01(Math.abs(event.amount) / FEEL.saturateAt);
    const motionGain = weight * this.pulse;
    // Light survives what movement does not - see FEEL.flareFloor.
    const flareGain = weight * Math.max(this.pulse, FEEL.flareFloor);

    switch (event.kind) {
      case 'gain':
        this.scaleVel += FEEL.gainScaleImpulse * motionGain;
        this.kickVel += FEEL.gainKickImpulse * motionGain;
        this.flare = clamp01(this.flare + FEEL.gainFlare * flareGain);
        this.tint = 1;
        break;
      case 'spend':
        this.scaleVel += FEEL.spendScaleImpulse * motionGain;
        this.kickVel += FEEL.spendKickImpulse * motionGain;
        this.flare = clamp01(this.flare + FEEL.spendFlare * flareGain);
        this.tint = 0;
        break;
      case 'penalty':
        this.scaleVel += FEEL.penaltyScaleImpulse * motionGain;
        this.kickVel += FEEL.penaltyKickImpulse * motionGain;
        this.flare = clamp01(this.flare + FEEL.penaltyFlare * flareGain);
        this.tint = -1;
        break;
    }

    setAttr(this.root, 'data-last', event.kind);
    const sign = event.kind === 'gain' ? '+' : '-';
    setText(this.delta, `${sign}${Math.abs(Math.trunc(event.amount))}`);
  }

  fixedUpdate(dt: Millis): void {
    const step = dt * SECONDS_PER_MS;

    this.scalePrev = this.scale;
    this.kickPrev = this.kick;
    this.flarePrev = this.flare;
    this.tintPrev = this.tint;

    // Semi-implicit Euler: velocity first, then position. Stable at 60 Hz for these rates
    // and, unlike explicit Euler, it cannot pump energy into a stiff spring.
    this.scaleVel += (-(this.scale - 1) * FEEL.scaleStiffness - this.scaleVel * FEEL.scaleDamping) * step;
    this.scale += this.scaleVel * step;

    this.kickVel += (-this.kick * FEEL.kickStiffness - this.kickVel * FEEL.kickDamping) * step;
    this.kick += this.kickVel * step;

    const flareFall = Math.exp(-FEEL.flareDecay * step);
    this.flare *= flareFall;
    this.tint *= Math.exp(-FEEL.tintDecay * step);
  }

  frame(alpha: Alpha): void {
    if (this.countDirty) {
      this.countDirty = false;
      const text = String(this.count);
      setText(this.face, text);
      setText(this.echoCool, text);
      setText(this.echoHot, text);
      setAttr(this.root, 'data-critical', this.count <= FEEL.criticalAt ? 'true' : 'false');
    }

    const scale = this.scalePrev + (this.scale - this.scalePrev) * alpha;
    const kick = this.kickPrev + (this.kick - this.kickPrev) * alpha;
    const flare = this.flarePrev + (this.flare - this.flarePrev) * alpha;
    const tint = this.tintPrev + (this.tint - this.tintPrev) * alpha;

    this.varScale.set(scale);
    this.varKick.set(kick);
    this.varFlare.set(flare);
    this.varCool.set(clamp01(tint) * flare);
    this.varHot.set(clamp01(-tint) * flare);
  }

  dispose(): void {
    this.root.remove();
  }
}
