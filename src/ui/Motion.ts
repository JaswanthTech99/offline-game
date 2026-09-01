/**
 * THE CHOREOGRAPHY SYSTEM.
 *
 * Every piece of UI movement in SHATTERPOINT is declared, never hand-tuned at the call
 * site. A panel says WHAT it is (`data-anim="glassIn"`) and WHERE it sits in the reading
 * order (`style="--delay:2"`), and this module decides how that reads as motion. The
 * reason is consistency at scale: a pause menu whose six rows each picked their own
 * duration is the single loudest tell that a game's UI was assembled rather than authored.
 *
 * THE THREE PARTS OF THE CONTRACT
 *
 *   1. `class="anim" data-anim="<name>"` selects the keyframe pair.
 *   2. `style="--delay:N"` is an INTEGER STEP INDEX, not a time. The element's real delay
 *      is `N * var(--stagger)`. Indices 0-7 are fixed by `DELAY` below and mean the same
 *      thing on every screen, so a title is always beaten onto the glass by its panel.
 *   3. Five curves exist and no sixth may be added: --e-spring, --e-spring-soft, --e-out,
 *      --e-snap, --e-impact.
 *
 * WHY THE SPRINGS ARE `linear()`
 *
 * A cubic-bezier cannot overshoot and settle - it has two control points and one hump. Real
 * spring motion needs the second, smaller rebound, and that is what separates UI that feels
 * physical from UI that feels merely eased. The alternative is a JS spring integrator
 * ticking every frame, which spends main-thread time we have promised to the shatter sim.
 * So the damped-harmonic solution is SAMPLED ONCE at module load into a CSS `linear()`
 * function of ~20 points. The browser's compositor then plays real spring physics with zero
 * per-frame JavaScript. This is the whole trick and it is why no curve here is hand-typed.
 *
 * REDUCED MOTION IS NOT A DIMMER
 *
 * `prefers-reduced-motion: reduce` OR `[data-reduced-motion="on"]` on the root element
 * collapses every duration to 1ms, zeroes the stagger and stops every loop dead. Both are
 * enforced in CSS with `!important`, which outranks the inline custom properties this
 * module writes - so the accessibility path cannot be defeated by a JS ordering bug.
 *
 * ONE ABSOLUTE MILLISECOND LIVES IN core/Quality.ts. `MotionRules.uiTransitionMs` is the
 * only wall-clock budget here; the whole duration scale is a table of RATIOS of it, so
 * retuning UI pace on a tier is still a one-line edit in Quality.ts.
 */

import { MOTION, REDUCED_MOTION_TIER, type Tier } from '../core/Quality';
import type { Millis } from '../core/types';

/* ------------------------------------------------------------------ stylesheet plumbing */

const constructed = new Map<string, CSSStyleSheet>();
const fallbacks = new Map<string, HTMLStyleElement>();

/**
 * Install (or hot-replace) a named stylesheet for the UI layer. Constructed stylesheets are
 * preferred because replacing one does not re-parse or re-order anything else in the
 * cascade; the `<style>` path exists only for engines without `adoptedStyleSheets`.
 *
 * The whole UI layer routes through here so that a sheet is never installed twice - the Nav
 * controller, the Legend and the touch guard are all constructible more than once (menus
 * mount and unmount) and each of them must be able to ask for its CSS unconditionally.
 */
export function adoptStyleSheet(id: string, css: string, doc: Document = document): void {
  const sheet = constructed.get(id);
  if (sheet !== undefined) {
    sheet.replaceSync(css);
    return;
  }

  const existingFallback = fallbacks.get(id);
  if (existingFallback !== undefined) {
    existingFallback.textContent = css;
    return;
  }

  if (typeof CSSStyleSheet === 'function' && Array.isArray(doc.adoptedStyleSheets)) {
    const created = new CSSStyleSheet();
    created.replaceSync(css);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, created];
    constructed.set(id, created);
    return;
  }

  const style = doc.createElement('style');
  style.dataset['spSheet'] = id;
  style.textContent = css;
  doc.head.append(style);
  fallbacks.set(id, style);
}

export function releaseStyleSheet(id: string, doc: Document = document): void {
  const sheet = constructed.get(id);
  if (sheet !== undefined) {
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
    constructed.delete(id);
  }
  const style = fallbacks.get(id);
  if (style !== undefined) {
    style.remove();
    fallbacks.delete(id);
  }
}

/* ----------------------------------------------------------------------------- contract */

/**
 * The stagger step. Fixed by the choreography contract rather than by a tier: it is a
 * READING RATE, not a performance budget - it is how long the eye needs to register that
 * one element has landed before the next one starts, and that does not vary with the GPU.
 * Tier controls how long each element takes; this controls how far apart they start.
 */
export const STAGGER_MS: Millis = 55;

/** Duration every animation collapses to under reduced motion. Not zero: zero suppresses `animationend`. */
const REDUCED_MS: Millis = 1;

/**
 * DELAY INDEX CONTRACT. These eight indices are the reading order of a SHATTERPOINT screen
 * and mean the same thing everywhere. A screen that needs a ninth element gives it the
 * index of the band it belongs to - the contract is the meaning, not the uniqueness.
 */
export const DELAY = Object.freeze({
  /** 0 - the scrim/backdrop that separates the panel from the corridor behind it. */
  scrim: 0,
  /** 1 - the panel, card or sheet itself. */
  surface: 1,
  /** 2 - the heading. */
  title: 2,
  /** 3 - subtitle, score line, any metadata under the heading. */
  meta: 3,
  /** 4 - the primary content band: first list row, the big number, the main art. */
  primary: 4,
  /** 5 - secondary content: remaining rows, detail columns. */
  secondary: 5,
  /** 6 - the action row: buttons, confirm/cancel. */
  actions: 6,
  /** 7 - the control legend and any footnote. */
  legend: 7,
} as const);

export type DelaySlot = keyof typeof DELAY;

/**
 * The five curves. WHY only five: an easing library with twenty entries produces UI where
 * no two transitions share a personality. These are spring (things that arrive), spring-soft
 * (things that settle), out (things that simply stop), snap (things that leave) and impact
 * (things that are struck).
 */
export const CURVES = ['spring', 'spring-soft', 'out', 'snap', 'impact'] as const;
export type Curve = (typeof CURVES)[number];

export const ENTRANCES = ['glassIn', 'veilIn', 'riseIn', 'dropIn', 'slideIn', 'popIn', 'wipeIn'] as const;
export type Entrance = (typeof ENTRANCES)[number];

export const EXITS = ['glassOut', 'veilOut', 'riseOut', 'dropOut', 'slideOut', 'popOut', 'wipeOut'] as const;
export type Exit = (typeof EXITS)[number];

/**
 * Every entrance has exactly one exit. Enforced as a total Record so that adding an
 * entrance without its counterpart is a compile error, not a screen that never closes.
 */
export const EXIT_FOR: Readonly<Record<Entrance, Exit>> = Object.freeze({
  glassIn: 'glassOut',
  veilIn: 'veilOut',
  riseIn: 'riseOut',
  dropIn: 'dropOut',
  slideIn: 'slideOut',
  popIn: 'popOut',
  wipeIn: 'wipeOut',
});

export const LOOPS = ['pulse', 'breathe', 'shimmer', 'spin', 'beat'] as const;
export type Loop = (typeof LOOPS)[number];

export type AnimName = Entrance | Exit | Loop;

/**
 * The duration scale, expressed as multiples of `MotionRules.uiTransitionMs`. Holding
 * ratios rather than milliseconds is what keeps core/Quality.ts the only file with a
 * wall-clock UI number in it while still giving the choreography five distinct speeds.
 */
const DURATION_RATIOS = Object.freeze({
  instant: 0.45,
  quick: 0.7,
  base: 1,
  slow: 1.6,
  scene: 2.6,
  loop: 9,
  loopSlow: 16,
});

type DurationName = keyof typeof DURATION_RATIOS;

const DURATION_NAMES = Object.keys(DURATION_RATIOS) as readonly DurationName[];

const cssVarForDuration = (name: DurationName): string => `--dur-${name.replace(/([A-Z])/g, '-$1').toLowerCase()}`;

/* ------------------------------------------------------------------------ spring sampling */

interface SpringSpec {
  /** 0 = undamped, 1 = critically damped. Below ~0.7 the rebound becomes visible. */
  readonly dampingRatio: number;
  /** Undamped natural frequency. Sets how *urgent* the arrival reads, independent of duration. */
  readonly frequencyHz: number;
}

/** Enough points that the rebound is resolved; few enough that the declaration stays readable. */
const SPRING_SAMPLE_COUNT = 20;

/** e^-4.6 leaves ~1% residual, which is below one device pixel of travel on any UI element. */
const SPRING_SETTLE_E_FOLDS = 4.6;

const trimNumber = (value: number): string => String(Math.round(value * 1e4) / 1e4);

/**
 * Closed-form step response of an underdamped mass-spring-damper, sampled evenly and emitted
 * as `linear()`. Evenly spaced samples are exactly what `linear()` expects when no explicit
 * stop positions are given, so no position arithmetic is needed. The final point is pinned to
 * 1 rather than left at its ~0.99 residual: an animation that ends 1% short of its target
 * leaves a permanent sub-pixel offset once fill-mode holds it there.
 */
function sampleSpring(spec: SpringSpec): string {
  const omega = Math.PI * 2 * spec.frequencyHz;
  const zeta = spec.dampingRatio;
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const settle = SPRING_SETTLE_E_FOLDS / (zeta * omega);

  const points: string[] = [];
  for (let i = 0; i <= SPRING_SAMPLE_COUNT; i += 1) {
    if (i === SPRING_SAMPLE_COUNT) {
      points.push('1');
      break;
    }
    const t = (settle * i) / SPRING_SAMPLE_COUNT;
    const decay = Math.exp(-zeta * omega * t);
    const value = 1 - decay * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
    points.push(trimNumber(value));
  }
  return `linear(${points.join(', ')})`;
}

const SPRING: SpringSpec = { dampingRatio: 0.52, frequencyHz: 1.7 };
const SPRING_SOFT: SpringSpec = { dampingRatio: 0.78, frequencyHz: 1.45 };

/* ------------------------------------------------------------------------------- the CSS */

const SHEET_ID = 'sp-motion';
const CLASS_ANIM = 'anim';

const defaultDurationCss = (tier: Tier): string =>
  DURATION_NAMES.map((name) => `  ${cssVarForDuration(name)}: ${MOTION[tier].uiTransitionMs * DURATION_RATIOS[name]}ms;`).join('\n');

/**
 * Emitted twice - once inside the media query, once against the explicit opt-in attribute -
 * because the two triggers are genuinely independent: a player may want stillness on a
 * machine whose OS was never told, and the OS preference must work before any JS has run.
 */
const reducedBlock = (scope: string): string => `
${scope} {
  --stagger: 0ms !important;
${DURATION_NAMES.map((name) => `  ${cssVarForDuration(name)}: ${REDUCED_MS}ms !important;`).join('\n')}
}
${scope} .${CLASS_ANIM} {
  animation-duration: ${REDUCED_MS}ms !important;
  animation-delay: 0ms !important;
  animation-iteration-count: 1 !important;
}
${scope} [data-anim-loop] { animation-name: none !important; }
${scope}, ${scope} *, ${scope} *::before, ${scope} *::after {
  transition-duration: ${REDUCED_MS}ms !important;
  transition-delay: 0ms !important;
}`;

function buildSheet(tier: Tier): string {
  return `
:root {
  --stagger: ${STAGGER_MS}ms;
${defaultDurationCss(tier)}

  --e-spring: ${sampleSpring(SPRING)};
  --e-spring-soft: ${sampleSpring(SPRING_SOFT)};
  /* Deceleration only - nothing overshoots, nothing anticipates. */
  --e-out: cubic-bezier(0.22, 1, 0.36, 1);
  /* Both ends steep: the shortest curve that still reads as motion rather than a cut. */
  --e-snap: cubic-bezier(0.4, 0, 0.1, 1);
  /* Violent onset, faint rebound - reserved for things that were HIT. */
  --e-impact: cubic-bezier(0.05, 0.85, 0.15, 1.06);

  --anim-rise: 14px;
  --anim-drop: -14px;
  --anim-slide: -24px;
  --glass-blur: 14px;
  --glass-scale: 0.94;
  --pop-scale: 0.82;
}

.${CLASS_ANIM} {
  --delay: 0;
  animation-name: none;
  animation-duration: var(--anim-dur, var(--dur-base));
  animation-timing-function: var(--anim-ease, var(--e-out));
  animation-delay: calc(var(--delay) * var(--stagger));
  animation-fill-mode: both;
}

/* will-change is scoped to elements that are mid-animation and cleared the moment they
   settle: leaving it on every panel permanently costs a compositor layer per panel. */
.${CLASS_ANIM}[data-anim] { will-change: transform, opacity; }
.${CLASS_ANIM}[data-anim='glassIn'],
.${CLASS_ANIM}[data-anim='glassOut'] { will-change: transform, opacity, filter; }

/* ---- signature modal transition. Blur is the whole point: a panel that merely fades is
   indistinguishable from every other web modal, whereas glass that resolves out of a blur
   reads as the same material the corridor is made of. Never substitute a cross-fade. ---- */
@keyframes sp-glass-in {
  from { opacity: 0; transform: translate3d(0, var(--anim-rise), 0) scale(var(--glass-scale)); filter: blur(var(--glass-blur)); }
  to   { opacity: 1; transform: translate3d(0, 0, 0) scale(1); filter: blur(0px); }
}
@keyframes sp-glass-out {
  from { opacity: 1; transform: translate3d(0, 0, 0) scale(1); filter: blur(0px); }
  /* Scales UP on the way out so the panel recedes THROUGH the camera rather than shrinking
     away from it - shrinking reads as dismissal, this reads as passing through glass. */
  to   { opacity: 0; transform: translate3d(0, 0, 0) scale(1.045); filter: blur(10px); }
}

@keyframes sp-veil-in  { from { opacity: 0; } to { opacity: 1; } }
@keyframes sp-veil-out { from { opacity: 1; } to { opacity: 0; } }

@keyframes sp-rise-in   { from { opacity: 0; transform: translate3d(0, var(--anim-rise), 0) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes sp-rise-out  { from { opacity: 1; transform: none; } to { opacity: 0; transform: translate3d(0, calc(var(--anim-rise) * 0.5), 0); } }
@keyframes sp-drop-in   { from { opacity: 0; transform: translate3d(0, var(--anim-drop), 0) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes sp-drop-out  { from { opacity: 1; transform: none; } to { opacity: 0; transform: translate3d(0, calc(var(--anim-drop) * 0.5), 0); } }
@keyframes sp-slide-in  { from { opacity: 0; transform: translate3d(var(--anim-slide), 0, 0); } to { opacity: 1; transform: none; } }
@keyframes sp-slide-out { from { opacity: 1; transform: none; } to { opacity: 0; transform: translate3d(calc(var(--anim-slide) * 0.5), 0, 0); } }
@keyframes sp-pop-in    { from { opacity: 0; transform: scale(var(--pop-scale)); } to { opacity: 1; transform: scale(1); } }
@keyframes sp-pop-out   { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(var(--pop-scale)); } }
/* scaleX rather than clip-path: a wipe on the compositor must be a transform. */
@keyframes sp-wipe-in   { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes sp-wipe-out  { from { transform: scaleX(1); } to { transform: scaleX(0); } }

@keyframes sp-pulse   { from { transform: scale(1); } to { transform: scale(1.035); } }
@keyframes sp-breathe { from { opacity: 0.55; } to { opacity: 1; } }
@keyframes sp-shimmer { from { transform: translate3d(-120%, 0, 0); } to { transform: translate3d(120%, 0, 0); } }
@keyframes sp-spin    { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes sp-beat    { from { transform: scale(1.14); } to { transform: scale(1); } }

.${CLASS_ANIM}[data-anim='glassIn']  { animation-name: sp-glass-in;  --anim-ease: var(--e-spring);      --anim-dur: var(--dur-slow); }
.${CLASS_ANIM}[data-anim='glassOut'] { animation-name: sp-glass-out; --anim-ease: var(--e-snap);        --anim-dur: var(--dur-quick); }
.${CLASS_ANIM}[data-anim='veilIn']   { animation-name: sp-veil-in;   --anim-ease: var(--e-out);         --anim-dur: var(--dur-base); }
.${CLASS_ANIM}[data-anim='veilOut']  { animation-name: sp-veil-out;  --anim-ease: var(--e-snap);        --anim-dur: var(--dur-quick); }
.${CLASS_ANIM}[data-anim='riseIn']   { animation-name: sp-rise-in;   --anim-ease: var(--e-spring);      --anim-dur: var(--dur-base); }
.${CLASS_ANIM}[data-anim='riseOut']  { animation-name: sp-rise-out;  --anim-ease: var(--e-snap);        --anim-dur: var(--dur-instant); }
.${CLASS_ANIM}[data-anim='dropIn']   { animation-name: sp-drop-in;   --anim-ease: var(--e-spring);      --anim-dur: var(--dur-base); }
.${CLASS_ANIM}[data-anim='dropOut']  { animation-name: sp-drop-out;  --anim-ease: var(--e-snap);        --anim-dur: var(--dur-instant); }
.${CLASS_ANIM}[data-anim='slideIn']  { animation-name: sp-slide-in;  --anim-ease: var(--e-spring-soft); --anim-dur: var(--dur-base); }
.${CLASS_ANIM}[data-anim='slideOut'] { animation-name: sp-slide-out; --anim-ease: var(--e-snap);        --anim-dur: var(--dur-instant); }
.${CLASS_ANIM}[data-anim='popIn']    { animation-name: sp-pop-in;    --anim-ease: var(--e-impact);      --anim-dur: var(--dur-quick); }
.${CLASS_ANIM}[data-anim='popOut']   { animation-name: sp-pop-out;   --anim-ease: var(--e-snap);        --anim-dur: var(--dur-instant); }
.${CLASS_ANIM}[data-anim='wipeIn']   { animation-name: sp-wipe-in;   --anim-ease: var(--e-out);         --anim-dur: var(--dur-base); transform-origin: var(--wipe-origin, left center); }
.${CLASS_ANIM}[data-anim='wipeOut']  { animation-name: sp-wipe-out;  --anim-ease: var(--e-snap);        --anim-dur: var(--dur-instant); transform-origin: var(--wipe-origin, left center); }

.${CLASS_ANIM}[data-anim-loop] { animation-iteration-count: infinite; animation-fill-mode: none; }
.${CLASS_ANIM}[data-anim='pulse']   { animation-name: sp-pulse;   animation-direction: alternate; --anim-ease: var(--e-spring-soft); --anim-dur: var(--dur-loop); }
.${CLASS_ANIM}[data-anim='breathe'] { animation-name: sp-breathe; animation-direction: alternate; --anim-ease: var(--e-spring-soft); --anim-dur: var(--dur-loop-slow); }
/* linear is legal here and only here-ish: a sweep and a rotation are continuous timelines
   with no beginning or end to ease, and easing them makes the loop visibly stutter. */
.${CLASS_ANIM}[data-anim='shimmer'] { animation-name: sp-shimmer; --anim-ease: linear; --anim-dur: var(--dur-loop-slow); }
.${CLASS_ANIM}[data-anim='spin']    { animation-name: sp-spin;    --anim-ease: linear; --anim-dur: var(--dur-loop); }
.${CLASS_ANIM}[data-anim='beat']    { animation-name: sp-beat;    --anim-ease: var(--e-impact); --anim-dur: var(--dur-base); }

@media (prefers-reduced-motion: reduce) {${reducedBlock(':root')}
}
${reducedBlock(':root[data-reduced-motion="on"]')}
`;
}

/* -------------------------------------------------------------------------------- runtime */

export interface PlayOptions {
  /** Step index on the stagger grid. Prefer a `DELAY` slot over a bare integer. */
  readonly delayIndex?: number | undefined;
  /** Overrides the animation's own duration. Reduced motion still wins. */
  readonly durationMs?: Millis | undefined;
  readonly curve?: Curve | undefined;
}

export interface StaggerOptions extends PlayOptions {
  /** Delay index applied to the first element; each subsequent one gets the next index. */
  readonly startIndex?: number | undefined;
}

/**
 * Waits for whatever the element is actually running. Reading `getAnimations()` rather than
 * listening for `animationend` is deliberate: `animationend` never fires for an element that
 * is display:none or whose animation was cancelled, and every menu teardown hits that case.
 */
async function settle(el: Element): Promise<void> {
  const running = el.getAnimations();
  if (running.length === 0) return;
  await Promise.allSettled(running.map((animation) => animation.finished));
}

export class MotionDirector {
  private tier: Tier;
  private readonly doc: Document;
  private readonly query: MediaQueryList | null;
  private readonly attrObserver: MutationObserver | null;

  constructor(tier: Tier, doc: Document = document) {
    this.tier = tier;
    this.doc = doc;
    this.query = typeof doc.defaultView?.matchMedia === 'function'
      ? doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

    adoptStyleSheet(SHEET_ID, buildSheet(tier), doc);
    this.applyDurations();

    this.query?.addEventListener('change', this.onPreferenceChange);

    this.attrObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(this.onPreferenceChange)
      : null;
    this.attrObserver?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] });
  }

  /** True when either trigger is active. Read it before scheduling anything JS-timed. */
  get reduced(): boolean {
    const opted = this.doc.documentElement.dataset['reducedMotion'] === 'on';
    return opted || this.query?.matches === true;
  }

  /** The tier whose MotionRules row is in force, mirroring how core/Quality resolves it. */
  get effectiveTier(): Tier {
    return this.reduced ? REDUCED_MOTION_TIER : this.tier;
  }

  setTier(tier: Tier): void {
    if (this.tier === tier) return;
    this.tier = tier;
    this.applyDurations();
  }

  /** The explicit in-game toggle. The OS preference is never overridden downwards by this. */
  setReducedMotion(on: boolean): void {
    this.doc.documentElement.dataset['reducedMotion'] = on ? 'on' : 'off';
    this.applyDurations();
  }

  /**
   * Plays an entrance and resolves when it has settled. The element is left in its natural
   * resting state with `data-anim` stripped, so a second entrance later starts clean.
   */
  async enter(el: HTMLElement, anim: Entrance, options: PlayOptions = {}): Promise<void> {
    this.start(el, anim, options, false);
    await settle(el);
    if (el.dataset['anim'] === anim) this.clear(el);
  }

  /**
   * Plays the exit paired with whatever entrance the element last ran (or an explicit one)
   * and resolves when it has settled. The element is deliberately LEFT in its exited state -
   * fill-mode holds it invisible - because the caller is the only one who knows whether the
   * node is about to be removed, hidden, or replayed.
   */
  async exit(el: HTMLElement, anim?: Exit, options: PlayOptions = {}): Promise<void> {
    const resolved = anim ?? this.pairedExit(el);
    this.start(el, resolved, options, false);
    await settle(el);
  }

  /** Runs one entrance across a list, walking the delay grid. Resolves when the last lands. */
  async stagger(els: readonly HTMLElement[], anim: Entrance, options: StaggerOptions = {}): Promise<void> {
    const start = options.startIndex ?? DELAY.primary;
    await Promise.all(
      els.map((el, index) => this.enter(el, anim, { ...options, delayIndex: start + index })),
    );
  }

  /** Starts a looping animation. Reduced motion kills it in CSS; nothing to check here. */
  loop(el: HTMLElement, anim: Loop, options: PlayOptions = {}): void {
    this.start(el, anim, options, true);
  }

  stopLoop(el: HTMLElement): void {
    this.clear(el);
  }

  /** Returns the element to its unanimated state and drops its compositor hint. */
  clear(el: HTMLElement): void {
    el.classList.remove(CLASS_ANIM);
    el.removeAttribute('data-anim');
    el.removeAttribute('data-anim-loop');
    el.style.removeProperty('--anim-dur');
    el.style.removeProperty('--anim-ease');
  }

  dispose(): void {
    this.query?.removeEventListener('change', this.onPreferenceChange);
    this.attrObserver?.disconnect();
    releaseStyleSheet(SHEET_ID, this.doc);
  }

  private pairedExit(el: HTMLElement): Exit {
    const last = el.dataset['animPaired'];
    const known = ENTRANCES.find((entrance) => entrance === last);
    return known === undefined ? 'glassOut' : EXIT_FOR[known];
  }

  private start(el: HTMLElement, anim: AnimName, options: PlayOptions, looping: boolean): void {
    el.classList.remove(CLASS_ANIM);
    el.removeAttribute('data-anim');
    el.removeAttribute('data-anim-loop');

    // Forces the style/layout flush that separates the removal from the addition. Without
    // it the browser coalesces both into one recalculation and the animation never restarts.
    el.getBoundingClientRect();

    if (options.delayIndex !== undefined) el.style.setProperty('--delay', String(options.delayIndex));
    if (options.durationMs !== undefined) el.style.setProperty('--anim-dur', `${options.durationMs}ms`);
    if (options.curve !== undefined) el.style.setProperty('--anim-ease', `var(--e-${options.curve})`);

    el.classList.add(CLASS_ANIM);
    el.dataset['anim'] = anim;
    if (looping) el.dataset['animLoop'] = '';
    const entrance = ENTRANCES.find((candidate) => candidate === anim);
    if (entrance !== undefined) el.dataset['animPaired'] = entrance;
  }

  /**
   * Written inline on the root so a tier change is one style write rather than a sheet
   * re-parse. The reduced-motion rules carry `!important` precisely so they still outrank
   * these; that ordering is the accessibility guarantee and must not be inverted.
   */
  private applyDurations(): void {
    const rules = MOTION[this.effectiveTier];
    const style = this.doc.documentElement.style;
    for (const name of DURATION_NAMES) {
      style.setProperty(cssVarForDuration(name), `${rules.uiTransitionMs * DURATION_RATIOS[name]}ms`);
    }
  }

  private readonly onPreferenceChange = (): void => {
    this.applyDurations();
  };
}

let installed: MotionDirector | null = null;

/** Boot calls this once with the resolved graphics tier; everything else uses `motion()`. */
export function installMotion(tier: Tier, doc: Document = document): MotionDirector {
  installed?.dispose();
  installed = new MotionDirector(tier, doc);
  return installed;
}

export function motion(): MotionDirector {
  if (installed === null) {
    throw new Error('ui/Motion: installMotion(tier) must run before any UI animates.');
  }
  return installed;
}
