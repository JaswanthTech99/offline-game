/**
 * ROVING FOCUS NAVIGATION - keyboard, gamepad and pointer through one code path.
 *
 * Markup contract, and nothing else is required:
 *
 *   <div data-nav="grid" data-nav-wrap>
 *     <button data-nav-item data-focus="true">Resume</button>
 *     <button data-nav-item>Options</button>
 *   </div>
 *
 * `data-nav` is the container and its value constrains the axes ('row', 'column', 'grid' or
 * 'auto'). `data-nav-item` marks a stop. `data-focus="true"` names the stop the container
 * starts on. Everything else - tabindex management, arrow keys, stick and d-pad, the focus
 * ring, activation, group hopping - falls out of those three attributes.
 *
 * WHY GEOMETRY AND NOT INDICES
 *
 * A menu described as "index 3 is below index 1" breaks the moment the layout reflows, an
 * item is hidden, or the screen turns into two columns on a phone. Direction here is solved
 * against live `getBoundingClientRect()` geometry with a cross-axis penalty, which is how
 * console UIs have always done it: it is correct for rows, columns and ragged grids without
 * any of them declaring which they are, and it stays correct after a responsive reflow.
 *
 * WHY THE GAMEPAD HAS NO LOOP
 *
 * The Gamepad API is poll-only - there are no button events - so something must sample it
 * every frame. SHATTERPOINT has exactly ONE requestAnimationFrame, in core/Engine.ts, so
 * this controller is a `Tickable` and samples inside `frame()`. Opening a second rAF here
 * would put UI input on a different cadence to the simulation and quietly double the
 * browser's animation-frame bookkeeping for the entire run.
 *
 * WHY THE RING IS CONDITIONAL
 *
 * A focus ring that follows the mouse is visual noise; a focus ring that is missing under a
 * gamepad makes the menu unusable. So the last input SOURCE is tracked on the root element
 * and the ring is bound to it: keyboard and gamepad show it, mouse and touch never do.
 */

import type { Millis, Tickable } from '../core/types';
import { adoptStyleSheet, releaseStyleSheet } from './Motion';

export type NavDirection = 'up' | 'down' | 'left' | 'right';
export type NavSource = 'keyboard' | 'gamepad' | 'pointer' | 'touch';
export type NavAxis = 'row' | 'column' | 'grid' | 'auto';

export interface NavMoveDetail {
  readonly from: HTMLElement | null;
  readonly to: HTMLElement;
  readonly direction: NavDirection;
  readonly source: NavSource;
}

export interface NavActivateDetail {
  readonly item: HTMLElement;
  readonly source: NavSource;
}

export interface NavCancelDetail {
  readonly container: HTMLElement | null;
  readonly source: NavSource;
}

declare global {
  interface HTMLElementEventMap {
    'nav:move': CustomEvent<NavMoveDetail>;
    'nav:activate': CustomEvent<NavActivateDetail>;
    'nav:cancel': CustomEvent<NavCancelDetail>;
  }
}

/**
 * Input FEEL, not a frame budget - these decide when a held direction starts repeating and
 * how far a stick must travel before it counts, which are ergonomics questions with the same
 * answer on every tier. core/Quality.ts owns everything that varies with the hardware.
 *
 * Separate press and release thresholds on the stick give it hysteresis: one threshold means
 * a stick resting exactly on the line chatters between "held" and "centred" every frame.
 */
export const NAV_INPUT = Object.freeze({
  repeatDelayMs: 380 as Millis,
  repeatIntervalMs: 90 as Millis,
  stickPress: 0.5,
  stickRelease: 0.32,
});

/**
 * W3C Standard Gamepad button indices. Named by ROLE rather than by any manufacturer's
 * letter or symbol, which keeps the mapping readable and keeps console trade dress out of
 * the codebase entirely.
 */
const BUTTON = Object.freeze({
  accept: 0,
  cancel: 1,
  prevGroup: 4,
  nextGroup: 5,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
});

const AXIS_X = 0;
const AXIS_Y = 1;

/** How much a candidate is punished for being off-axis. Above ~1 straight lines always win. */
const CROSS_AXIS_WEIGHT = 2.5;
/** Sub-pixel differences are noise from fractional layout, not a direction. */
const DIRECTION_EPSILON = 1;

const SHEET_ID = 'sp-nav';

const SHEET = `
:root {
  /* The focus ring is the player's own colour, pushed a step brighter than --ice so it
     still reads as focus on top of a control that is already tinted with it. */
  --nav-ring: color-mix(in oklab, var(--ice) 78%, white);
  --nav-ring-shadow: var(--void-000);
  --nav-ring-width: 2px;
  --nav-ring-offset: 3px;
}

/* The ring is drawn as outline plus a dark halo so it survives BOTH a blown-out glass
   highlight and a black corridor behind the panel. A single-colour ring disappears against
   one of the two, and this game shows both within the same frame. */
[data-nav-item]:focus-visible,
:root[data-input='keyboard'] [data-nav-item]:focus,
:root[data-input='gamepad'] [data-nav-item]:focus {
  outline: var(--nav-ring-width) solid var(--nav-ring);
  outline-offset: var(--nav-ring-offset);
  box-shadow: 0 0 0 calc(var(--nav-ring-width) + var(--nav-ring-offset)) var(--nav-ring-shadow),
              0 0 12px 0 var(--nav-ring);
}

/* Higher specificity than the :focus-visible rule above, so a pointer or a thumb wins the
   argument and the ring stays hidden even when the browser thinks it should show. */
:root[data-input='pointer'] [data-nav-item]:focus,
:root[data-input='touch'] [data-nav-item]:focus {
  outline: none;
  box-shadow: none;
}

/* In forced-colours mode the system picks the colours and our halo would be ignored anyway. */
@media (forced-colors: active) {
  [data-nav-item]:focus-visible,
  :root[data-input='keyboard'] [data-nav-item]:focus,
  :root[data-input='gamepad'] [data-nav-item]:focus {
    outline: 3px solid Highlight;
    box-shadow: none;
  }
}

[data-nav-item][aria-disabled='true'] { pointer-events: none; }
`;

const KEY_DIRECTION: Readonly<Record<string, NavDirection>> = Object.freeze({
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
});

const OPPOSITE: Readonly<Record<NavDirection, NavDirection>> = Object.freeze({
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
});

const isVertical = (direction: NavDirection): boolean => direction === 'up' || direction === 'down';

function axisOf(container: HTMLElement): NavAxis {
  const raw = container.dataset['nav'];
  return raw === 'row' || raw === 'column' || raw === 'grid' ? raw : 'auto';
}

/** A container only constrains movement if it declared a single-axis layout. */
function axisAllows(axis: NavAxis, direction: NavDirection): boolean {
  if (axis === 'row') return !isVertical(direction);
  if (axis === 'column') return isVertical(direction);
  return true;
}

/**
 * Arrow keys inside a text field move the caret. A menu controller that swallows them turns
 * every name-entry box in the game into a trap, so the whole handler stands down.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== 'checkbox' && target.type !== 'radio' && target.type !== 'button';
}

function isNavigable(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-disabled') === 'true') return false;
  if (el instanceof HTMLButtonElement && el.disabled) return false;
  if (el instanceof HTMLInputElement && el.disabled) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/**
 * Gap between two 1-D ranges, 0 when they overlap. Using the gap rather than centre distance
 * is what makes a tall list item and a short one on the same row count as aligned.
 */
function rangeGap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  if (bMax < aMin) return aMin - bMax;
  if (bMin > aMax) return bMin - aMax;
  return 0;
}

/** Lower is better. `null` means the candidate is not in the requested direction at all. */
export function scoreCandidate(from: DOMRect, to: DOMRect, direction: NavDirection): number | null {
  const fromCx = from.left + from.width / 2;
  const fromCy = from.top + from.height / 2;
  const toCx = to.left + to.width / 2;
  const toCy = to.top + to.height / 2;

  let primary: number;
  let cross: number;

  if (isVertical(direction)) {
    primary = direction === 'down' ? toCy - fromCy : fromCy - toCy;
    cross = rangeGap(from.left, from.right, to.left, to.right);
  } else {
    primary = direction === 'right' ? toCx - fromCx : fromCx - toCx;
    cross = rangeGap(from.top, from.bottom, to.top, to.bottom);
  }

  if (primary <= DIRECTION_EPSILON) return null;
  return primary + cross * CROSS_AXIS_WEIGHT;
}

export type TickUnsubscribe = () => void;

/**
 * How the controller reaches the one rAF. Deliberately a bare function type rather than an
 * import of core/Engine: Nav must be constructible in a test, in a design harness and in the
 * game, and only the game has an Engine.
 */
export type TickRegistrar = (tickable: Tickable) => TickUnsubscribe;

export interface NavOptions {
  /** Subtree to manage. Defaults to the whole document. */
  readonly root?: ParentNode | undefined;
  /**
   * Focus the container's `data-focus="true"` item on construction. Off by default: pulling
   * DOM focus on mount is correct for a modal and rude for a HUD.
   */
  readonly autoFocus?: boolean | undefined;
}

export class NavController implements Tickable {
  private readonly root: ParentNode;
  private readonly doc: Document;
  private readonly repeat = new Map<number, { direction: NavDirection; nextAt: Millis }>();
  private readonly held = new Map<number, Set<number>>();
  private readonly observer: MutationObserver | null;
  private detachTick: TickUnsubscribe | null = null;
  private gamepadCount = 0;
  private synthesizing = false;
  private syncQueued = false;

  constructor(options: NavOptions = {}, doc: Document = document) {
    this.doc = doc;
    this.root = options.root ?? doc;

    adoptStyleSheet(SHEET_ID, SHEET, doc);

    doc.addEventListener('keydown', this.onKeyDown, true);
    doc.addEventListener('pointerdown', this.onPointerDown, true);
    doc.addEventListener('click', this.onClick, true);
    doc.addEventListener('focusin', this.onFocusIn, true);

    const view = doc.defaultView;
    view?.addEventListener('gamepadconnected', this.onGamepadConnected);
    view?.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);

    this.observer = typeof MutationObserver === 'function' ? new MutationObserver(this.scheduleSync) : null;
    this.observer?.observe(this.root === doc ? doc.documentElement : (this.root as Node), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-nav-item', 'data-nav', 'data-focus', 'disabled', 'aria-disabled', 'hidden'],
    });

    this.syncTabIndex();
    if (options.autoFocus === true) this.focusInitial();
  }

  /** Hand this the Engine's tick registration so the gamepad rides the single rAF. */
  attachFrameSource(register: TickRegistrar): void {
    this.detachTick?.();
    this.detachTick = register(this);
  }

  /**
   * Deliberately empty, and deliberately parameterless. Nav is presentation-rate input:
   * sampling the pad on the fixed step would sample it up to four times per frame with
   * identical results, and would put menu latency on the simulation's cadence instead of
   * the display's. `Tickable` is still satisfied - a narrower implementation is assignable.
   */
  fixedUpdate(): void {
    /* see above */
  }

  frame(): void {
    if (this.gamepadCount === 0 || this.doc.hidden) return;
    this.pollGamepads(performance.now());
  }

  /** The current input source, mirrored onto the root element for the ring's CSS to read. */
  get source(): NavSource {
    const raw = this.doc.documentElement.dataset['input'];
    return raw === 'gamepad' || raw === 'pointer' || raw === 'touch' ? raw : 'keyboard';
  }

  /** Moves focus one step. Public so a touch swipe or a cutscene can drive the same path. */
  move(direction: NavDirection, source: NavSource): boolean {
    const current = this.currentItem();
    const container = this.containerFor(current);
    if (container === null) return this.focusInitial();

    const axis = axisOf(container);
    if (!axisAllows(axis, direction)) {
      // A row asked to move vertically hops to the neighbouring container instead of
      // swallowing the keystroke - otherwise a stacked pair of toolbars becomes a trap.
      return this.moveGroup(direction === 'down' || direction === 'right' ? 1 : -1, source);
    }

    const items = this.itemsIn(container).filter(isNavigable);
    if (items.length === 0) return false;
    if (current === null) return this.focusItem(items[0] ?? null, null, direction, source);

    const fromRect = current.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const item of items) {
      if (item === current) continue;
      const score = scoreCandidate(fromRect, item.getBoundingClientRect(), direction);
      if (score === null || score >= bestScore) continue;
      best = item;
      bestScore = score;
    }

    if (best === null && container.hasAttribute('data-nav-wrap')) {
      best = this.wrapTarget(items, current, direction);
    }
    if (best === null) return false;

    return this.focusItem(best, current, direction, source);
  }

  /** Steps to the next or previous `[data-nav]` container in DOM order. */
  moveGroup(step: number, source: NavSource): boolean {
    const containers = this.containers();
    if (containers.length === 0) return false;
    const current = this.containerFor(this.currentItem());
    const index = current === null ? -1 : containers.indexOf(current);
    const next = containers[(index + step + containers.length * 2) % containers.length];
    if (next === undefined || next === current) return false;
    return this.focusInitial(next, source);
  }

  activate(item: HTMLElement | null, source: NavSource): boolean {
    if (item === null || !isNavigable(item)) return false;
    const event = new CustomEvent<NavActivateDetail>('nav:activate', {
      bubbles: true,
      cancelable: true,
      detail: { item, source },
    });
    const proceed = item.dispatchEvent(event);
    // Native activation is suppressed upstream (keydown is prevented, gamepads have no
    // native path at all), so this synthetic click is the ONLY click a consumer sees.
    if (proceed) {
      this.synthesizing = true;
      item.click();
      this.synthesizing = false;
    }
    return true;
  }

  cancel(source: NavSource): void {
    const container = this.containerFor(this.currentItem());
    const target: EventTarget = container ?? this.doc;
    target.dispatchEvent(
      new CustomEvent<NavCancelDetail>('nav:cancel', { bubbles: true, detail: { container, source } }),
    );
  }

  /** Focuses a container's declared starting item, falling back to its first navigable stop. */
  focusInitial(container?: HTMLElement, source: NavSource = 'keyboard'): boolean {
    const target = container ?? this.containers()[0];
    if (target === undefined) return false;
    const items = this.itemsIn(target).filter(isNavigable);
    const declared = items.find((item) => item.dataset['focus'] === 'true');
    const next = declared ?? items[0] ?? null;
    if (next === null) return false;
    return this.focusItem(next, this.currentItem(), 'down', source);
  }

  dispose(): void {
    this.detachTick?.();
    this.detachTick = null;
    this.doc.removeEventListener('keydown', this.onKeyDown, true);
    this.doc.removeEventListener('pointerdown', this.onPointerDown, true);
    this.doc.removeEventListener('click', this.onClick, true);
    this.doc.removeEventListener('focusin', this.onFocusIn, true);
    const view = this.doc.defaultView;
    view?.removeEventListener('gamepadconnected', this.onGamepadConnected);
    view?.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);
    this.observer?.disconnect();
    this.repeat.clear();
    this.held.clear();
    releaseStyleSheet(SHEET_ID, this.doc);
  }

  /* ------------------------------------------------------------------------ registry */

  private containers(): HTMLElement[] {
    return Array.from(this.root.querySelectorAll<HTMLElement>('[data-nav]'));
  }

  private itemsIn(container: HTMLElement): HTMLElement[] {
    // Filtered back to this container so a nested [data-nav] does not leak its stops upward.
    return Array.from(container.querySelectorAll<HTMLElement>('[data-nav-item]')).filter(
      (item) => item.closest('[data-nav]') === container,
    );
  }

  /** The container focus is genuinely inside, with no fallback. Used to decide ownership. */
  private activeContainer(): HTMLElement | null {
    const active = this.doc.activeElement;
    return active instanceof HTMLElement ? active.closest<HTMLElement>('[data-nav]') : null;
  }

  private containerFor(item: HTMLElement | null): HTMLElement | null {
    if (item !== null) return item.closest<HTMLElement>('[data-nav]');
    const active = this.doc.activeElement;
    if (active instanceof HTMLElement) {
      const container = active.closest<HTMLElement>('[data-nav]');
      if (container !== null) return container;
    }
    return this.containers()[0] ?? null;
  }

  private currentItem(): HTMLElement | null {
    const active = this.doc.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    return active.closest<HTMLElement>('[data-nav-item]');
  }

  private wrapTarget(items: readonly HTMLElement[], current: HTMLElement, direction: NavDirection): HTMLElement | null {
    // Wrapping is "keep going the same way from the far edge", so the target is the item
    // furthest in the OPPOSITE direction - not simply index 0, which is wrong in a grid.
    const back = OPPOSITE[direction];
    const fromRect = current.getBoundingClientRect();
    let best: HTMLElement | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const item of items) {
      if (item === current) continue;
      const score = scoreCandidate(fromRect, item.getBoundingClientRect(), back);
      if (score === null || score <= bestScore) continue;
      best = item;
      bestScore = score;
    }
    return best;
  }

  private focusItem(
    next: HTMLElement | null,
    from: HTMLElement | null,
    direction: NavDirection,
    source: NavSource,
  ): boolean {
    if (next === null) return false;
    this.setSource(source);
    this.applyRoving(next);
    next.focus({ preventScroll: false });
    next.dispatchEvent(
      new CustomEvent<NavMoveDetail>('nav:move', { bubbles: true, detail: { from, to: next, direction, source } }),
    );
    return true;
  }

  /**
   * Roving tabindex: exactly one stop per container is in the Tab order. That is what makes
   * Tab move BETWEEN menus while the arrows move within one, with no Tab handling of our own.
   */
  private applyRoving(active: HTMLElement | null): void {
    for (const container of this.containers()) {
      const items = this.itemsIn(container);
      const declared = items.find((item) => item.dataset['focus'] === 'true');
      const chosen = items.find((item) => item === active) ?? declared ?? items.find(isNavigable) ?? null;
      for (const item of items) {
        item.tabIndex = item === chosen && isNavigable(item) ? 0 : -1;
      }
    }
  }

  private syncTabIndex(): void {
    this.applyRoving(this.currentItem());
  }

  private readonly scheduleSync = (): void => {
    if (this.syncQueued) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      this.syncTabIndex();
    });
  };

  private setSource(source: NavSource): void {
    this.doc.documentElement.dataset['input'] = source;
  }

  /* -------------------------------------------------------------------- DOM listeners */

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTextEntry(event.target)) return;

    const current = this.currentItem();
    // Arrows only belong to Nav while focus is already inside a nav container. Claiming them
    // globally would break page scrolling and hijack every unrelated widget on the overlay.
    const inNav = current !== null || this.activeContainer() !== null;

    const direction = KEY_DIRECTION[event.key];
    if (direction !== undefined) {
      if (!inNav) return;
      this.setSource('keyboard');
      if (this.move(direction, 'keyboard')) event.preventDefault();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      if (current === null) return;
      // Prevented so the browser's own click never fires: `activate` synthesises exactly one.
      event.preventDefault();
      this.setSource('keyboard');
      this.activate(current, 'keyboard');
      return;
    }

    if (event.key === 'Escape') {
      this.setSource('keyboard');
      this.cancel('keyboard');
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.setSource(event.pointerType === 'touch' ? 'touch' : 'pointer');
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (this.synthesizing) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest<HTMLElement>('[data-nav-item]');
    if (item === null) return;
    this.applyRoving(item);
    item.dispatchEvent(
      new CustomEvent<NavActivateDetail>('nav:activate', {
        bubbles: true,
        cancelable: true,
        detail: { item, source: this.source === 'touch' ? 'touch' : 'pointer' },
      }),
    );
  };

  private readonly onFocusIn = (event: FocusEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest<HTMLElement>('[data-nav-item]');
    if (item !== null) this.applyRoving(item);
  };

  private readonly onGamepadConnected = (): void => {
    this.gamepadCount += 1;
  };

  private readonly onGamepadDisconnected = (): void => {
    this.gamepadCount = Math.max(0, this.gamepadCount - 1);
    this.repeat.clear();
    this.held.clear();
  };

  /* ----------------------------------------------------------------------- gamepad */

  private pollGamepads(now: Millis): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (pad === null || !pad.connected) continue;
      this.pollPad(pad, now);
    }
  }

  private pollPad(pad: Gamepad, now: Millis): void {
    const direction = this.readDirection(pad);
    this.stepRepeat(pad.index, direction, now);

    const buttons = this.held.get(pad.index) ?? new Set<number>();
    this.held.set(pad.index, buttons);

    if (this.edge(pad, BUTTON.accept, buttons)) {
      this.setSource('gamepad');
      this.activate(this.currentItem() ?? null, 'gamepad');
    }
    if (this.edge(pad, BUTTON.cancel, buttons)) {
      this.setSource('gamepad');
      this.cancel('gamepad');
    }
    if (this.edge(pad, BUTTON.prevGroup, buttons)) {
      this.setSource('gamepad');
      this.moveGroup(-1, 'gamepad');
    }
    if (this.edge(pad, BUTTON.nextGroup, buttons)) {
      this.setSource('gamepad');
      this.moveGroup(1, 'gamepad');
    }
  }

  /** Rising edge only. Held buttons repeat for DIRECTIONS and never for confirm/cancel. */
  private edge(pad: Gamepad, index: number, held: Set<number>): boolean {
    const pressed = pad.buttons[index]?.pressed === true;
    const was = held.has(index);
    if (pressed) held.add(index);
    else held.delete(index);
    return pressed && !was;
  }

  /** D-pad wins over the stick so that a resting stick cannot fight a deliberate press. */
  private readDirection(pad: Gamepad): NavDirection | null {
    if (pad.buttons[BUTTON.dpadUp]?.pressed === true) return 'up';
    if (pad.buttons[BUTTON.dpadDown]?.pressed === true) return 'down';
    if (pad.buttons[BUTTON.dpadLeft]?.pressed === true) return 'left';
    if (pad.buttons[BUTTON.dpadRight]?.pressed === true) return 'right';

    const x = pad.axes[AXIS_X] ?? 0;
    const y = pad.axes[AXIS_Y] ?? 0;
    const active = this.repeat.get(pad.index);
    // Hysteresis: once a direction is live it only ends below the lower release threshold.
    const threshold = active === undefined ? NAV_INPUT.stickPress : NAV_INPUT.stickRelease;

    if (Math.abs(x) < threshold && Math.abs(y) < threshold) return null;
    if (Math.abs(x) >= Math.abs(y)) return x > 0 ? 'right' : 'left';
    return y > 0 ? 'down' : 'up';
  }

  /**
   * Turns a held direction into discrete moves: one immediately, then a pause, then a steady
   * repeat. The pause is what stops a single flick of the stick skipping three menu rows.
   */
  private stepRepeat(padIndex: number, direction: NavDirection | null, now: Millis): void {
    const state = this.repeat.get(padIndex);

    if (direction === null) {
      this.repeat.delete(padIndex);
      return;
    }

    if (state === undefined || state.direction !== direction) {
      this.repeat.set(padIndex, { direction, nextAt: now + NAV_INPUT.repeatDelayMs });
      this.setSource('gamepad');
      this.move(direction, 'gamepad');
      return;
    }

    if (now < state.nextAt) return;
    state.nextAt = now + NAV_INPUT.repeatIntervalMs;
    this.setSource('gamepad');
    this.move(direction, 'gamepad');
  }
}
