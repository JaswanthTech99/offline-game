/**
 * THE DOM OVERLAY.
 *
 * Every pixel of SHATTERPOINT's interface is DOM sitting on top of the WebGPU canvas, and
 * that is a performance decision before it is a convenience one: browser-rendered text
 * costs zero draw calls, zero atlas uploads and zero of the frame budget the shatter sim
 * is fighting for. The price is that the compositor joins the loop, so ONE rule governs
 * everything below it:
 *
 *     ANIMATE `transform` AND `opacity`. NOTHING ELSE. EVER.
 *
 * A width, top, font-size or margin animation drags layout and paint into the frame the
 * player is watching a pane explode in - the single worst frame in the game to lose.
 * Progress bars scaleX, panels translate, callouts fade. There is no exception, and the
 * exception you are about to make is the one that ships a stutter.
 *
 * The overlay owns no requestAnimationFrame. Engine drives `fixedUpdate`/`frame`, every
 * widget registered with `add()` is ticked from here, and every DOM WRITE lands inside
 * `frame()`. That last part is not tidiness either: ResizeObserver delivers a measurement
 * mid-layout, and writing an attribute from inside that callback is how a project earns a
 * forced synchronous reflow it can never find again.
 */

import type { MotionRules } from '../core/Quality';
import type { Alpha, Disposable, Millis, Tickable } from '../core/types';

export type OverlaySize = 'desktop' | 'tablet' | 'phone';

/**
 * Stacking is DOM order, not z-index arithmetic: five siblings in one stacking context
 * are cheaper for the compositor than five layers competing on an integer nobody owns.
 * `hud` is the in-run instrument cluster; `panels` is diegetic run furniture; `modal` is
 * pause and run-end; `toast` is transient; `debug` is always on top and never shipped hot.
 *
 * TODO(step-2): only `hud` has an occupant. `panels`, `modal`, `toast` and `debug` are
 * live, styled, correctly stacked containers with nothing in them yet.
 */
export type OverlayLayerId = 'hud' | 'panels' | 'modal' | 'toast' | 'debug';

/**
 * Presentation tokens. Breakpoints and quantisation steps are art direction and DOM
 * hygiene, NOT performance budgets: core/Quality.ts owns every number the profiler holds
 * the game to. This is the same split universe/LightBus.ts makes for its channel ranges -
 * if one of these ever needs to differ per tier, it moves to Quality.ts that day.
 */
export const OVERLAY_TOKENS = Object.freeze({
  /** Viewport width at or below which phone padding applies. */
  phoneMaxPx: 640,
  /** Viewport width at or below which tablet padding applies. */
  tabletMaxPx: 1024,
  /**
   * Viewport HEIGHT at or below which phone padding applies regardless of width.
   *
   * This is not symmetry for its own sake. A OnePlus 12 in landscape is 851x393 CSS px:
   * classified on width alone it lands in `tablet`, so it was handed 40px gutters and an
   * 84px ball numeral inside 393px of height. Row one (90px) plus the pickup rail (117px)
   * plus the bottom row (156px) plus 80px of vertical pad is 443px of content in a 393px
   * box, and .sp-overlay { overflow: hidden } sliced the bottom row off mid-glyph. A
   * phone held sideways is still a phone; only its short axis says so.
   *
   * 480 is chosen to sit above every phone landscape height and below every laptop: the
   * shortest mainstream desktop viewport is 720px tall and small tablets landscape at 600.
   */
  shortMaxPx: 480,
});

/**
 * Pure so the padding tier can be asserted in a test without a layout engine.
 *
 * Width picks the tier and height can only DEMOTE it. Taking `min(w, h)` instead would
 * classify a 1280x720 desktop as a tablet, which is why the two axes are not symmetric.
 */
export function classifySize(widthPx: number, heightPx: number): OverlaySize {
  if (widthPx <= OVERLAY_TOKENS.phoneMaxPx) return 'phone';
  if (heightPx <= OVERLAY_TOKENS.shortMaxPx) return 'phone';
  if (widthPx <= OVERLAY_TOKENS.tabletMaxPx) return 'tablet';
  return 'desktop';
}

const injectedStyles = new Set<string>();

/**
 * Styles are injected rather than imported as CSS files because each UI module ships the
 * rules for the thing it builds and nothing else - a widget that is never constructed
 * costs no stylesheet. `id` deduplicates across hot reloads and across multiple Overlays
 * in a test file.
 */
export function addStyleOnce(id: string, css: string): void {
  if (typeof document === 'undefined') return;
  if (injectedStyles.has(id)) return;
  injectedStyles.add(id);
  const style = document.createElement('style');
  style.dataset['spStyle'] = id;
  style.textContent = css;
  document.head.append(style);
}

/** Element factory. Terse on purpose: the HUD builds a few hundred of these at boot. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement | null = null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className.length > 0) node.className = className;
  if (parent !== null) parent.append(node);
  return node;
}

/**
 * Text writes are dirty-checked everywhere in the HUD. An identical `textContent`
 * assignment still invalidates layout for that subtree, and at 60 Hz across two dozen
 * readouts that is a measurable slice of the ui millisecond budget for no visible change.
 */
export function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** Same argument as setText, for attributes that drive CSS state selectors. */
export function setAttr(node: HTMLElement, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/**
 * A numeric CSS custom property that refuses redundant writes.
 *
 * Springs spend most of their life settled. Quantising to a step the eye cannot resolve
 * and comparing against the last written value turns a settled widget into literally zero
 * style invalidation per frame, which is the difference between "the HUD is free" and
 * "the HUD costs a third of a millisecond doing nothing".
 */
export class NumVar {
  private readonly node: HTMLElement;
  private readonly name: string;
  private readonly inverseStep: number;
  private last = Number.NaN;

  constructor(node: HTMLElement, name: string, step: number) {
    this.node = node;
    this.name = name;
    this.inverseStep = 1 / step;
  }

  set(value: number): void {
    const quantised = Math.round(value * this.inverseStep) / this.inverseStep;
    if (quantised === this.last) return;
    this.last = quantised;
    this.node.style.setProperty(this.name, String(quantised));
  }
}

const isDisposable = (value: unknown): value is Disposable =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { dispose?: unknown }).dispose === 'function';

/**
 * `--sp-pad-*` is the one geometry contract every cluster obeys. The safe-area insets fold
 * INTO the pad rather than being applied separately, because a notch on a phone held in
 * landscape eats the left gutter only: adding the inset to a fixed pad keeps the HUD
 * optically centred instead of shoving the whole grid sideways.
 *
 * `.hit` is the pointer-events opt-in, gated by `data-interactive`. The gate is not
 * paranoia: an interactive element anywhere over the canvas during a run will eventually
 * swallow the tap that was meant to throw a ball, and that bug is unreproducible by
 * definition. Interactivity is switched on when the game is paused or in a menu.
 */
const OVERLAY_CSS = `
.sp-overlay {
  --sp-safe-l: var(--safe-l, env(safe-area-inset-left, 0px));
  --sp-safe-r: var(--safe-r, env(safe-area-inset-right, 0px));
  --sp-safe-t: var(--safe-t, env(safe-area-inset-top, 0px));
  --sp-safe-b: var(--safe-b, env(safe-area-inset-bottom, 0px));

  /* Overlay authors NO colour. Every slot below is an alias onto the design tokens in
     src/styles/tokens.css, which is the only place in the codebase a colour is written.
     The four meanings map one-to-one: accent is the player, danger is damage, gain is what
     the player banks, and warn is the same gold used one step earlier. Nothing here
     invents a fifth colour, and there is no hard-coded fallback: a var() that resolves to
     nothing inherits, which is the correct behaviour for a unit test mounting this widget
     with no application stylesheet at all. */
  --sp-ink: var(--ink);
  --sp-ink-dim: var(--ink-dim);
  --sp-ink-faint: var(--ink-faint);
  --sp-accent: var(--ice);
  --sp-accent-deep: color-mix(in oklab, var(--ice) 45%, var(--void-000));
  --sp-gain: var(--gold);
  --sp-warn: var(--gold);
  --sp-danger: var(--flare);
  --sp-glass: var(--glass);
  --sp-glass-hi: var(--glass-edge);
  --sp-glass-line: var(--glass-line);
  --sp-shadow: var(--shadow);

  --sp-font-ui: var(--font-ui-stack);
  --sp-font-mono: var(--font-mono-stack);

  --sp-ui-transition: 200ms;
  --sp-hud-pulse: 1;

  /* THE VISUAL VIEWPORT HEIGHT, stamped by frame() from window.visualViewport.
     .sp-overlay is position:fixed, so inset:0 sizes it to the LAYOUT viewport. On
     Android WebView in immersive fullscreen the two are not always the same box, and a
     cluster pinned to the bottom of the layout viewport then sits below the visible area
     with no way to tell from inside CSS. The clusters grid measures itself against this
     instead. 100% is the correct fallback: every desktop browser and every case where the
     two viewports agree resolves it to exactly the layout height. */
  --sp-vvh: 100%;
  --sp-vvt: 0px;

  /* Desktop pads are the base so the first paint - before ResizeObserver has reported and
     frame() has stamped data-size - is already laid out rather than flush to the bezel. */
  /* --sp-edge is the curved-display margin, written by main.ts from Quality.ts. It is
     separate from the safe-area inset on purpose: a curve occludes nothing, so Android
     reports no inset for it, and only the left and right edges are affected.
     IT MUST BE REPEATED IN EVERY data-size BLOCK BELOW. Those blocks re-declare --sp-pad-l
     and --sp-pad-r outright, so a block that omits the --sp-edge term silently deletes the
     curved-display margin the moment ResizeObserver stamps data-size - which is always. */
  --sp-pad-l: calc(64px + var(--sp-safe-l) + var(--sp-edge, 0px));
  --sp-pad-r: calc(64px + var(--sp-safe-r) + var(--sp-edge, 0px));
  --sp-pad-t: calc(64px + var(--sp-safe-t));
  --sp-pad-b: calc(64px + var(--sp-safe-b));

  position: fixed;
  inset: 0;
  z-index: 10;
  overflow: hidden;
  pointer-events: none;
  color: var(--sp-ink);
  font-family: var(--sp-font-ui);
  font-size: 13px;
  line-height: 1.2;
  letter-spacing: 0.02em;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
  opacity: 1;
  transition: opacity var(--sp-ui-transition) cubic-bezier(0.2, 0.8, 0.2, 1);
}

.sp-overlay[data-size='desktop'] {
  --sp-pad-l: calc(64px + var(--sp-safe-l) + var(--sp-edge, 0px));
  --sp-pad-r: calc(64px + var(--sp-safe-r) + var(--sp-edge, 0px));
  --sp-pad-t: calc(64px + var(--sp-safe-t));
  --sp-pad-b: calc(64px + var(--sp-safe-b));
}
.sp-overlay[data-size='tablet'] {
  --sp-pad-l: calc(40px + var(--sp-safe-l) + var(--sp-edge, 0px));
  --sp-pad-r: calc(40px + var(--sp-safe-r) + var(--sp-edge, 0px));
  --sp-pad-t: calc(40px + var(--sp-safe-t));
  --sp-pad-b: calc(40px + var(--sp-safe-b));
}
.sp-overlay[data-size='phone'] {
  --sp-pad-l: calc(16px + var(--sp-safe-l) + var(--sp-edge, 0px));
  --sp-pad-r: calc(16px + var(--sp-safe-r) + var(--sp-edge, 0px));
  --sp-pad-t: calc(16px + var(--sp-safe-t));
  --sp-pad-b: calc(16px + var(--sp-safe-b));
}

/* Hidden, not removed: teardown and rebuild of the HUD mid-run would cost a layout pass
   and lose every spring's state. */
.sp-overlay[data-visible='false'] { opacity: 0; visibility: hidden; }

.sp-layer { position: absolute; inset: 0; pointer-events: none; }

.hit { pointer-events: auto; }
.sp-overlay[data-interactive='false'] .hit { pointer-events: none; }

.sp-overlay .sp-sr {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  clip-path: inset(50%);
  overflow: hidden;
  white-space: nowrap;
}
`;

/**
 * The root of every DOM interface in the game. One per application; a second one means two
 * competing `data-size` attributes and two sets of safe-area maths.
 */
export class Overlay implements Tickable, Disposable {
  readonly root: HTMLDivElement;

  private readonly layers: Readonly<Record<OverlayLayerId, HTMLDivElement>>;
  private readonly live: HTMLDivElement;
  private readonly children: Tickable[] = [];
  private readonly observer: ResizeObserver | null;
  private readonly onWindowResize: (() => void) | null;
  private readonly viewport: VisualViewport | null;
  private readonly onViewportChange: (() => void) | null;

  private size: OverlaySize = 'desktop';
  private pendingSize: OverlaySize = 'desktop';
  private sizeDirty = true;

  // The last visual-viewport box written to CSS, and the one waiting to be. NaN is the
  // "never written" sentinel so the first frame always stamps.
  private vvHeight = Number.NaN;
  private vvTop = Number.NaN;
  private pendingVvHeight = Number.NaN;
  private pendingVvTop = Number.NaN;

  constructor(host: HTMLElement, motion: MotionRules) {
    addStyleOnce('sp-overlay', OVERLAY_CSS);

    this.root = el('div', 'sp-overlay');
    this.root.dataset['visible'] = 'true';
    this.root.dataset['interactive'] = 'false';

    // Written out longhand rather than built in a loop so the record has no optional keys
    // and `layer()` can never return undefined.
    const hud = el('div', 'sp-layer sp-layer--hud');
    const panels = el('div', 'sp-layer sp-layer--panels');
    const modal = el('div', 'sp-layer sp-layer--modal');
    const toast = el('div', 'sp-layer sp-layer--toast');
    const debug = el('div', 'sp-layer sp-layer--debug');
    this.layers = { hud, panels, modal, toast, debug };
    this.root.append(hud, panels, modal, toast, debug);

    this.live = el('div', 'sp-sr', this.root);
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');

    this.setMotion(motion);
    host.append(this.root);

    // ResizeObserver rather than a resize listener: it fires for the element, survives
    // browser-chrome collapse on mobile, and hands over a rect instead of tempting a read
    // of offsetWidth. The rect is stored and applied in frame(); see the class comment.
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry === undefined) return;
        this.queueSize(classifySize(entry.contentRect.width, entry.contentRect.height));
      });
      // observe() delivers an initial observation on its own, so nothing here has to read
      // clientWidth and force the layout the whole class is built to avoid.
      this.observer.observe(this.root);
      this.onWindowResize = null;
    } else {
      this.observer = null;
      this.onWindowResize = (): void =>
        this.queueSize(classifySize(window.innerWidth, window.innerHeight));
      window.addEventListener('resize', this.onWindowResize, { passive: true });
      this.onWindowResize();
    }

    // The visual viewport is a SEPARATE box from the one ResizeObserver reports, and it is
    // the only one that describes what the player can actually see. It moves without any
    // element resizing - browser chrome collapsing, an Android WebView entering immersive
    // mode, a soft keyboard - so it needs its own subscription. `scroll` matters as much as
    // `resize`: offsetTop is how far the visible box has slid down the layout viewport.
    // Both handlers only record; frame() does the writing, per the class contract.
    const vv: VisualViewport | undefined = window.visualViewport ?? undefined;
    if (vv !== undefined) {
      this.viewport = vv;
      this.onViewportChange = (): void => {
        this.pendingVvHeight = vv.height;
        this.pendingVvTop = vv.offsetTop;
      };
      vv.addEventListener('resize', this.onViewportChange, { passive: true });
      vv.addEventListener('scroll', this.onViewportChange, { passive: true });
      this.onViewportChange();
    } else {
      this.viewport = null;
      this.onViewportChange = null;
    }
  }

  layer(id: OverlayLayerId): HTMLDivElement {
    return this.layers[id];
  }

  /** Registered widgets are ticked in insertion order; nothing here reaches for a rAF. */
  add(child: Tickable): void {
    if (!this.children.includes(child)) this.children.push(child);
  }

  remove(child: Tickable): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
  }

  /**
   * Called on tier resolution and whenever the player's reduced-motion preference changes
   * mid-session. Rare by construction, so it writes straight through instead of queueing:
   * the dirty-flag discipline exists for per-frame writes, and applying an accessibility
   * preference a frame late is worse than a single style invalidation.
   */
  setMotion(rules: MotionRules): void {
    this.root.style.setProperty('--sp-ui-transition', `${rules.uiTransitionMs}ms`);
    this.root.style.setProperty('--sp-hud-pulse', String(rules.hudPulseScale));
  }

  setVisible(visible: boolean): void {
    setAttr(this.root, 'data-visible', visible ? 'true' : 'false');
  }

  /** Opens the `.hit` gate. True for pause, menus and run-end; false during play. */
  setInteractive(interactive: boolean): void {
    setAttr(this.root, 'data-interactive', interactive ? 'true' : 'false');
  }

  currentSize(): OverlaySize {
    return this.size;
  }

  /** Polite announcement for assistive tech - run start, room change, run over. */
  announce(message: string): void {
    setText(this.live, message);
  }

  fixedUpdate(dt: Millis): void {
    for (const child of this.children) child.fixedUpdate(dt);
  }

  frame(alpha: Alpha): void {
    if (this.sizeDirty) {
      this.sizeDirty = false;
      this.size = this.pendingSize;
      setAttr(this.root, 'data-size', this.size);
    }
    // Sub-pixel churn here would invalidate style on the whole overlay for nothing, so the
    // box is compared at whole pixels before it is written.
    const height = Math.round(this.pendingVvHeight);
    const top = Math.round(this.pendingVvTop);
    if (height !== this.vvHeight || top !== this.vvTop) {
      this.vvHeight = height;
      this.vvTop = top;
      if (Number.isFinite(height) && Number.isFinite(top)) {
        this.root.style.setProperty('--sp-vvh', `${String(height)}px`);
        this.root.style.setProperty('--sp-vvt', `${String(top)}px`);
      }
    }
    for (const child of this.children) child.frame(alpha);
  }

  dispose(): void {
    this.observer?.disconnect();
    if (this.onWindowResize !== null) window.removeEventListener('resize', this.onWindowResize);
    if (this.viewport !== null && this.onViewportChange !== null) {
      this.viewport.removeEventListener('resize', this.onViewportChange);
      this.viewport.removeEventListener('scroll', this.onViewportChange);
    }
    for (const child of this.children) {
      if (isDisposable(child)) child.dispose();
    }
    this.children.length = 0;
    this.root.remove();
  }

  private queueSize(size: OverlaySize): void {
    if (size === this.pendingSize && !this.sizeDirty) return;
    this.pendingSize = size;
    this.sizeDirty = true;
  }
}
