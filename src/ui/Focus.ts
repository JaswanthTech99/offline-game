/**
 * TOUCH TARGET ENFORCEMENT.
 *
 * On a phone the corridor is the whole screen and the UI is a thin overlay on top of it, so
 * every control is under pressure to be small. 48 CSS pixels is the floor below which a
 * control stops being reliably hittable with a thumb, and a missed tap during a run is not a
 * cosmetic failure - it is a lost ball.
 *
 * HOW IT WORKS, AND WHY NOT THE OBVIOUS WAY
 *
 * The obvious fix is to grow the element. That is wrong for a HUD: growing a 28px icon to
 * 48px either pushes its neighbours around or forces every layout to reserve space it does
 * not need visually. Instead this guard leaves the painted box alone and grows only the HIT
 * REGION, via a transparent positioned pseudo-element sized by two custom properties. The
 * control looks identical and gains 20px of invisible thumb margin.
 *
 * `data-touch-grow` opts an element into the other strategy - real min-inline-size /
 * min-block-size - for controls that live in a flex row with room to spare and read better
 * when they are genuinely bigger.
 *
 * Measurement is batched: every rect is read, then every style is written. Interleaving the
 * two across a dozen controls is a dozen forced synchronous layouts on the frame a menu
 * opens, which is exactly the frame that must not stutter.
 *
 * The keyboard/gamepad focus RING is not here - it belongs to ui/Nav.ts, which owns which
 * input source is driving and therefore whether a ring should be visible at all.
 */

import { adoptStyleSheet, releaseStyleSheet } from './Motion';

/**
 * The floor, in CSS pixels. A platform accessibility contract rather than a performance
 * budget, which is why it lives with the UI layer and not in core/Quality.ts - it does not
 * vary by tier, by device class or by frame budget, and a tier that shipped 32px targets
 * would be a broken tier rather than a cheaper one.
 */
export const MIN_TOUCH_TARGET_PX = 48;

const SHEET_ID = 'sp-touch-targets';

/** Default sweep: anything that can be activated, plus anything explicitly opted in. */
export const TOUCH_TARGET_SELECTOR =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="switch"], [data-nav-item], [data-touch-target]';

const SHEET = `
[data-touch-pad] { position: relative; }
/*
 * ::before rather than ::after: ui/Nav and most HUD chrome decorate with ::after, and a hit
 * region that silently replaces a control's own decoration is the worst kind of helper.
 * It is painted underneath the control's content and is fully transparent, so it changes
 * nothing visually and everything about where a thumb may land.
 */
[data-touch-pad]::before {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--sp-hit-y, 0px)) calc(-1 * var(--sp-hit-x, 0px));
  pointer-events: auto;
}
[data-touch-grow] {
  min-inline-size: var(--sp-hit-min, ${MIN_TOUCH_TARGET_PX}px);
  min-block-size: var(--sp-hit-min, ${MIN_TOUCH_TARGET_PX}px);
}
`;

export interface TouchTargetReport {
  readonly el: HTMLElement;
  readonly width: number;
  readonly height: number;
  /** Horizontal padding added to each side, in CSS px. 0 when the element already passed. */
  readonly padX: number;
  readonly padY: number;
  /** True when the element was under the floor and could not be padded (grow-mode failure). */
  readonly unresolved: boolean;
}

export interface TouchGuardOptions {
  readonly selector?: string | undefined;
  readonly minPx?: number | undefined;
  /**
   * Only pad when the primary pointer is coarse. Default true: a 20px invisible margin
   * around every button is correct for a thumb and actively wrong for a mouse, where it
   * makes adjacent controls swallow each other's clicks.
   */
  readonly coarseOnly?: boolean | undefined;
}

/** Pure so the rule can be asserted without a DOM. Half the shortfall goes on each side. */
export function computePad(size: number, min: number): number {
  if (!Number.isFinite(size) || size >= min) return 0;
  return Math.ceil((min - size) / 2);
}

export class TouchTargetGuard {
  private readonly root: ParentNode;
  private readonly selector: string;
  private readonly minPx: number;
  private readonly coarseOnly: boolean;
  private readonly doc: Document;
  private readonly coarse: MediaQueryList | null;
  private readonly mutations: MutationObserver | null;
  private readonly resizes: ResizeObserver | null;
  /** Observing an element twice re-fires the initial callback and re-enters `refresh`. */
  private readonly observed = new WeakSet<HTMLElement>();
  private queued = false;
  private disposed = false;

  constructor(root: ParentNode, options: TouchGuardOptions = {}, doc: Document = document) {
    this.root = root;
    this.selector = options.selector ?? TOUCH_TARGET_SELECTOR;
    this.minPx = options.minPx ?? MIN_TOUCH_TARGET_PX;
    this.coarseOnly = options.coarseOnly ?? true;
    this.doc = doc;

    adoptStyleSheet(SHEET_ID, SHEET, doc);

    this.coarse = typeof doc.defaultView?.matchMedia === 'function'
      ? doc.defaultView.matchMedia('(pointer: coarse)')
      : null;
    this.coarse?.addEventListener('change', this.schedule);

    this.mutations = typeof MutationObserver === 'function' ? new MutationObserver(this.schedule) : null;
    this.mutations?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'data-touch-target'] });

    // A control that changes size (a label swapping to a longer word) can cross the floor in
    // either direction, so the guard has to re-measure rather than latch its first answer.
    this.resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(this.schedule) : null;

    this.schedule();
  }

  get active(): boolean {
    return !this.coarseOnly || this.coarse === null || this.coarse.matches;
  }

  /** Re-measures immediately and returns what it found. Also the dev-time audit entry point. */
  refresh(): TouchTargetReport[] {
    if (this.disposed) return [];
    const targets = Array.from(this.root.querySelectorAll<HTMLElement>(this.selector));

    if (!this.active) {
      for (const el of targets) this.strip(el);
      return [];
    }

    // Read pass. Nothing below this line writes until every rect is in hand.
    const measured = targets.map((el) => ({ el, rect: el.getBoundingClientRect() }));

    const reports: TouchTargetReport[] = [];
    for (const { el, rect } of measured) {
      if (!this.observed.has(el)) {
        this.observed.add(el);
        this.resizes?.observe(el);
      }

      // A zero box is a hidden control, not a failing one; padding it would create an
      // invisible tap trap floating over whatever is behind it.
      if (rect.width === 0 && rect.height === 0) {
        this.strip(el);
        continue;
      }

      const grow = el.hasAttribute('data-touch-grow');
      const padX = grow ? 0 : computePad(rect.width, this.minPx);
      const padY = grow ? 0 : computePad(rect.height, this.minPx);

      if (padX === 0 && padY === 0) {
        this.strip(el);
        if (grow && (rect.width < this.minPx || rect.height < this.minPx)) {
          el.style.setProperty('--sp-hit-min', `${this.minPx}px`);
          reports.push({ el, width: rect.width, height: rect.height, padX: 0, padY: 0, unresolved: true });
        }
        continue;
      }

      el.dataset['touchPad'] = '';
      el.style.setProperty('--sp-hit-x', `${padX}px`);
      el.style.setProperty('--sp-hit-y', `${padY}px`);
      // The pseudo-element is absolutely positioned, so a statically positioned host would
      // let it escape to some distant ancestor. The stylesheet handles it, but an inline
      // `position: static` from another layer would defeat that, so re-assert here.
      if (this.doc.defaultView?.getComputedStyle(el).position === 'static') {
        el.style.position = 'relative';
      }
      reports.push({ el, width: rect.width, height: rect.height, padX, padY, unresolved: false });
    }

    return reports;
  }

  dispose(): void {
    this.disposed = true;
    this.coarse?.removeEventListener('change', this.schedule);
    this.mutations?.disconnect();
    this.resizes?.disconnect();
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-touch-pad]')) this.strip(el);
    releaseStyleSheet(SHEET_ID, this.doc);
  }

  private strip(el: HTMLElement): void {
    el.removeAttribute('data-touch-pad');
    el.style.removeProperty('--sp-hit-x');
    el.style.removeProperty('--sp-hit-y');
    el.style.removeProperty('--sp-hit-min');
  }

  /**
   * Coalesces every trigger into one pass per microtask. A menu opening fires dozens of
   * mutation records and each one would otherwise force its own layout.
   */
  private readonly schedule = (): void => {
    if (this.queued || this.disposed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.disposed) this.refresh();
    });
  };
}

/**
 * Convenience constructor. Returns the live guard rather than a snapshot because the guard
 * OWNS the padding it applied: disposing it is what removes the invisible hit regions again,
 * so a caller that only got a report array would have no way to unmount a screen cleanly.
 * Call `refresh()` on the result for the audit list.
 */
export function enforceTouchTargets(root: ParentNode, options: TouchGuardOptions = {}): TouchTargetGuard {
  return new TouchTargetGuard(root, options);
}
