/**
 * THE CONTROL LEGEND.
 *
 * Keyboard, gamepad and touch are shown TOGETHER, always, at equal weight. This is a
 * deliberate rejection of the usual pattern where a game sniffs the device and shows one
 * scheme: that pattern is wrong here for three concrete reasons. A tablet with a paired
 * controller has all three simultaneously. A player mid-run who picks up a pad must be able
 * to see the mapping without opening a menu. And a legend that swaps its contents when an
 * input changes reflows underneath the eye that is trying to read it.
 *
 * So all three columns render, all three stay put, and the ACTIVE one is emphasised - a
 * change of emphasis, never a change of content. The active scheme is read from the
 * `data-input` attribute that ui/Nav.ts writes on the root element, which means the legend
 * follows the same source of truth as the focus ring and cannot disagree with it.
 *
 * ARTWORK: every glyph here is drawn from primitives in this file. Gamepad buttons are
 * identified by their POSITION on the face (a pip at north/east/south/west) rather than by
 * any manufacturer's letter, colour or symbol - that is unambiguous on every controller ever
 * made and keeps other people's trade dress out of the project entirely.
 */

import { adoptStyleSheet, releaseStyleSheet } from './Motion';
import type { NavSource } from './Nav';

export type InputScheme = 'keyboard' | 'gamepad' | 'touch';

export const SCHEMES: readonly InputScheme[] = Object.freeze(['keyboard', 'gamepad', 'touch']);

export type Compass = 'up' | 'down' | 'left' | 'right';

export type Glyph =
  | { readonly kind: 'key'; readonly cap: string; readonly wide?: boolean | undefined }
  | { readonly kind: 'pad-face'; readonly at: Compass }
  | { readonly kind: 'pad-dir'; readonly at: Compass | 'all' }
  | { readonly kind: 'pad-shoulder'; readonly side: 'left' | 'right' }
  | { readonly kind: 'pad-stick'; readonly side: 'left' | 'right' }
  | { readonly kind: 'touch'; readonly gesture: 'tap' | 'hold' | 'swipe' | 'drag' | 'pinch'; readonly at?: Compass | undefined };

export interface LegendBinding {
  readonly id: string;
  /** What the player is doing, in the player's language. Not the internal action name. */
  readonly action: string;
  readonly keyboard: readonly Glyph[];
  readonly gamepad: readonly Glyph[];
  readonly touch: readonly Glyph[];
}

/** Mouse is a keyboard-scheme peripheral for legend purposes - it shares the same column. */
export const schemeForSource = (source: NavSource): InputScheme =>
  source === 'gamepad' ? 'gamepad' : source === 'touch' ? 'touch' : 'keyboard';

const SCHEME_LABEL: Readonly<Record<InputScheme, string>> = Object.freeze({
  keyboard: 'Keys',
  gamepad: 'Pad',
  touch: 'Touch',
});

/* --------------------------------------------------------------------------- artwork */

const SVG_NS = 'http://www.w3.org/2000/svg' as const;
const VIEW = 24;
const MID = VIEW / 2;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Readonly<Record<string, string>>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

function svgRoot(): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: `0 0 ${VIEW} ${VIEW}`, 'aria-hidden': 'true', focusable: 'false' });
  svg.classList.add('sp-glyph', 'sp-glyph--svg');
  return svg;
}

const COMPASS_OFFSET: Readonly<Record<Compass, readonly [number, number]>> = Object.freeze({
  up: Object.freeze([0, -1] as const),
  down: Object.freeze([0, 1] as const),
  left: Object.freeze([-1, 0] as const),
  right: Object.freeze([1, 0] as const),
});

const COMPASS_DEGREES: Readonly<Record<Compass, number>> = Object.freeze({
  up: -90,
  right: 0,
  down: 90,
  left: 180,
});

function padFace(at: Compass): SVGSVGElement {
  const svg = svgRoot();
  svg.append(svgEl('circle', { cx: String(MID), cy: String(MID), r: '9', class: 'sp-stroke' }));
  const offset = COMPASS_OFFSET[at];
  svg.append(
    svgEl('circle', {
      cx: String(MID + offset[0] * 4.4),
      cy: String(MID + offset[1] * 4.4),
      r: '2.1',
      class: 'sp-fill',
    }),
  );
  return svg;
}

function padDir(at: Compass | 'all'): SVGSVGElement {
  const svg = svgRoot();
  svg.append(
    svgEl('path', {
      d: 'M9.2 3.4h5.6v5.8h5.8v5.6h-5.8v5.8H9.2v-5.8H3.4V9.2h5.8Z',
      class: 'sp-stroke',
      'stroke-linejoin': 'round',
    }),
  );
  if (at !== 'all') {
    const offset = COMPASS_OFFSET[at];
    svg.append(
      svgEl('circle', { cx: String(MID + offset[0] * 6.6), cy: String(MID + offset[1] * 6.6), r: '1.9', class: 'sp-fill' }),
    );
  }
  return svg;
}

function padShoulder(side: 'left' | 'right'): SVGSVGElement {
  const svg = svgRoot();
  svg.append(svgEl('rect', { x: '2.6', y: '7.5', width: '18.8', height: '9', rx: '4.2', class: 'sp-stroke' }));
  const text = svgEl('text', { x: String(MID), y: '15.1', 'text-anchor': 'middle', class: 'sp-glyph__text' });
  text.textContent = side === 'left' ? 'L' : 'R';
  svg.append(text);
  return svg;
}

function padStick(side: 'left' | 'right'): SVGSVGElement {
  const svg = svgRoot();
  svg.append(svgEl('circle', { cx: String(MID), cy: String(MID), r: '9', class: 'sp-stroke' }));
  svg.append(svgEl('circle', { cx: String(MID), cy: String(MID), r: '3.2', class: 'sp-fill' }));
  // The arc says "this one moves"; its side says which stick without needing a label.
  svg.append(
    svgEl('path', {
      d: side === 'left' ? 'M4.4 8.2A9 9 0 0 0 4.4 15.8' : 'M19.6 8.2a9 9 0 0 1 0 7.6',
      class: 'sp-stroke sp-stroke--thin',
    }),
  );
  return svg;
}

function touchGlyph(gesture: 'tap' | 'hold' | 'swipe' | 'drag' | 'pinch', at: Compass): SVGSVGElement {
  const svg = svgRoot();
  switch (gesture) {
    case 'tap':
      svg.append(svgEl('circle', { cx: String(MID), cy: String(MID), r: '3.4', class: 'sp-fill' }));
      svg.append(svgEl('circle', { cx: String(MID), cy: String(MID), r: '8.2', class: 'sp-stroke sp-stroke--thin' }));
      break;
    case 'hold':
      svg.append(svgEl('circle', { cx: String(MID), cy: String(MID), r: '3.4', class: 'sp-fill' }));
      svg.append(svgEl('path', { d: 'M12 3.8a8.2 8.2 0 1 1-7 3.9', class: 'sp-stroke sp-stroke--thin', fill: 'none' }));
      break;
    case 'swipe': {
      const group = svgEl('g', { transform: `rotate(${COMPASS_DEGREES[at]} ${MID} ${MID})` });
      group.append(svgEl('path', { d: 'M5.2 12h11.4', class: 'sp-stroke' }));
      group.append(svgEl('path', { d: 'M13.4 8.2 17.6 12l-4.2 3.8', class: 'sp-stroke', fill: 'none', 'stroke-linejoin': 'round' }));
      group.append(svgEl('circle', { cx: '4.2', cy: '12', r: '1.5', class: 'sp-fill' }));
      svg.append(group);
      break;
    }
    case 'drag': {
      const group = svgEl('g', { transform: `rotate(${COMPASS_DEGREES[at]} ${MID} ${MID})` });
      group.append(svgEl('circle', { cx: '6.4', cy: '12', r: '3', class: 'sp-fill' }));
      group.append(svgEl('path', { d: 'M11.2 12h7.6', class: 'sp-stroke sp-stroke--thin', 'stroke-dasharray': '2 2.6' }));
      svg.append(group);
      break;
    }
    case 'pinch':
      svg.append(svgEl('path', { d: 'M3.6 12h5.6M20.4 12h-5.6', class: 'sp-stroke' }));
      svg.append(svgEl('path', { d: 'M6.6 9 9.4 12l-2.8 3M17.4 9 14.6 12l2.8 3', class: 'sp-stroke', fill: 'none', 'stroke-linejoin': 'round' }));
      break;
  }
  return svg;
}

function keyCap(cap: string, wide: boolean): HTMLElement {
  const kbd = document.createElement('kbd');
  kbd.classList.add('sp-glyph', 'sp-glyph--key');
  if (wide) kbd.dataset['wide'] = '';
  kbd.textContent = cap;
  return kbd;
}

function renderGlyph(glyph: Glyph): Element {
  switch (glyph.kind) {
    case 'key':
      return keyCap(glyph.cap, glyph.wide === true);
    case 'pad-face':
      return padFace(glyph.at);
    case 'pad-dir':
      return padDir(glyph.at);
    case 'pad-shoulder':
      return padShoulder(glyph.side);
    case 'pad-stick':
      return padStick(glyph.side);
    case 'touch':
      return touchGlyph(glyph.gesture, glyph.at ?? 'right');
  }
}

/** Screen readers get prose, never a row of unlabelled boxes. */
function describeGlyph(glyph: Glyph): string {
  switch (glyph.kind) {
    case 'key':
      return glyph.cap;
    case 'pad-face':
      return `${glyph.at} face button`;
    case 'pad-dir':
      return glyph.at === 'all' ? 'direction pad' : `direction pad ${glyph.at}`;
    case 'pad-shoulder':
      return `${glyph.side} shoulder`;
    case 'pad-stick':
      return `${glyph.side} stick`;
    case 'touch':
      return glyph.at === undefined ? glyph.gesture : `${glyph.gesture} ${glyph.at}`;
  }
}

/* ------------------------------------------------------------------------------- CSS */

const SHEET_ID = 'sp-legend';

const SHEET = `
.sp-legend {
  display: grid;
  gap: 0.35rem 1.1rem;
  font: inherit;
  color: var(--sp-legend-fg, var(--ink-dim));
}
.sp-legend__row {
  display: grid;
  grid-template-columns: minmax(6rem, max-content) 1fr;
  align-items: center;
  gap: 0.4rem 1rem;
}
.sp-legend__action {
  font-size: 0.82em;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.72;
}
.sp-legend__schemes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 0.9rem;
  align-items: center;
}
.sp-legend__scheme {
  display: inline-flex;
  align-items: center;
  gap: 0.34rem;
  /* Opacity, never display: all three schemes keep their box so the row never reflows when
     the player picks up a controller mid-run. */
  opacity: 0.42;
  transition: opacity var(--dur-quick, 140ms) var(--e-out, ease-out);
}
.sp-legend__scheme[data-active='true'] { opacity: 1; }
.sp-legend__tag {
  font-size: 0.66em;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.62;
}
.sp-glyph {
  flex: none;
  inline-size: 1.45em;
  block-size: 1.45em;
}
.sp-glyph--svg { overflow: visible; }
.sp-glyph--svg .sp-stroke {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}
.sp-glyph--svg .sp-stroke--thin { stroke-width: 1.15; }
.sp-glyph--svg .sp-fill { fill: currentColor; stroke: none; }
.sp-glyph__text {
  fill: currentColor;
  font-size: 8px;
  font-weight: 600;
  font-family: inherit;
}
.sp-glyph--key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: auto;
  min-inline-size: 1.45em;
  block-size: 1.45em;
  padding-inline: 0.35em;
  border: 1px solid currentColor;
  border-radius: 0.32em;
  box-shadow: inset 0 -0.14em 0 0 color-mix(in srgb, currentColor 22%, transparent);
  font: inherit;
  font-size: 0.72em;
  line-height: 1;
  white-space: nowrap;
}
.sp-glyph--key[data-wide] { padding-inline: 0.7em; }
`;

/* --------------------------------------------------------------------------- runtime */

export interface LegendOptions {
  readonly bindings?: readonly LegendBinding[] | undefined;
  /** Pin the emphasised scheme instead of following `data-input`. Useful in screenshots. */
  readonly scheme?: InputScheme | undefined;
}

export class Legend {
  readonly el: HTMLElement;
  private bindings: readonly LegendBinding[];
  private readonly pinned: InputScheme | null;
  private readonly doc: Document;
  private readonly observer: MutationObserver | null;

  constructor(options: LegendOptions = {}, doc: Document = document) {
    this.doc = doc;
    this.bindings = options.bindings ?? [];
    this.pinned = options.scheme ?? null;

    adoptStyleSheet(SHEET_ID, SHEET, doc);

    this.el = doc.createElement('div');
    this.el.className = 'sp-legend';
    this.el.setAttribute('role', 'list');

    // Following the attribute rather than subscribing to Nav keeps the Legend usable in a
    // static screen that has no NavController at all.
    this.observer = typeof MutationObserver === 'function' ? new MutationObserver(this.onInputChange) : null;
    this.observer?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-input'] });

    this.render();
  }

  setBindings(bindings: readonly LegendBinding[]): void {
    this.bindings = bindings;
    this.render();
  }

  get activeScheme(): InputScheme {
    if (this.pinned !== null) return this.pinned;
    const raw = this.doc.documentElement.dataset['input'];
    const source: NavSource = raw === 'gamepad' || raw === 'touch' || raw === 'pointer' ? raw : 'keyboard';
    return schemeForSource(source);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.el.remove();
    releaseStyleSheet(SHEET_ID, this.doc);
  }

  private glyphsFor(binding: LegendBinding, scheme: InputScheme): readonly Glyph[] {
    if (scheme === 'keyboard') return binding.keyboard;
    if (scheme === 'gamepad') return binding.gamepad;
    return binding.touch;
  }

  private render(): void {
    const active = this.activeScheme;
    const rows = this.doc.createDocumentFragment();

    for (const binding of this.bindings) {
      const row = this.doc.createElement('div');
      row.className = 'sp-legend__row';
      row.setAttribute('role', 'listitem');
      row.dataset['bindingId'] = binding.id;

      const action = this.doc.createElement('span');
      action.className = 'sp-legend__action';
      action.textContent = binding.action;
      row.append(action);

      const schemes = this.doc.createElement('span');
      schemes.className = 'sp-legend__schemes';

      for (const scheme of SCHEMES) {
        const glyphs = this.glyphsFor(binding, scheme);
        const cell = this.doc.createElement('span');
        cell.className = 'sp-legend__scheme';
        cell.dataset['scheme'] = scheme;
        cell.dataset['active'] = String(scheme === active);
        cell.setAttribute(
          'aria-label',
          glyphs.length === 0
            ? `${binding.action}: not bound on ${scheme}`
            : `${binding.action} on ${scheme}: ${glyphs.map(describeGlyph).join(' then ')}`,
        );

        const tag = this.doc.createElement('span');
        tag.className = 'sp-legend__tag';
        tag.textContent = SCHEME_LABEL[scheme];
        tag.setAttribute('aria-hidden', 'true');
        cell.append(tag);

        for (const glyph of glyphs) cell.append(renderGlyph(glyph));
        schemes.append(cell);
      }

      row.append(schemes);
      rows.append(row);
    }

    this.el.replaceChildren(rows);
  }

  /** Emphasis only. Re-rendering the glyphs on an input change is what causes the reflow. */
  private readonly onInputChange = (): void => {
    const active = this.activeScheme;
    for (const cell of this.el.querySelectorAll<HTMLElement>('.sp-legend__scheme')) {
      cell.dataset['active'] = String(cell.dataset['scheme'] === active);
    }
  };
}

/**
 * The default run/menu legend. Content only - the glyph vocabulary and layout above are
 * final.
 *
 * TODO(step-2): the input agent replaces this table with a projection of the live binding
 * map from src/gameplay, so a remapped key updates the legend without an edit here.
 */
export const CORE_BINDINGS: readonly LegendBinding[] = Object.freeze([
  Object.freeze({
    id: 'throw',
    action: 'Throw',
    keyboard: Object.freeze([{ kind: 'key', cap: 'Click' } as const]),
    gamepad: Object.freeze([{ kind: 'pad-shoulder', side: 'right' } as const]),
    touch: Object.freeze([{ kind: 'touch', gesture: 'tap' } as const]),
  }),
  Object.freeze({
    id: 'aim',
    action: 'Aim',
    keyboard: Object.freeze([{ kind: 'key', cap: 'Move' } as const]),
    gamepad: Object.freeze([{ kind: 'pad-stick', side: 'right' } as const]),
    touch: Object.freeze([{ kind: 'touch', gesture: 'drag', at: 'right' } as const]),
  }),
  Object.freeze({
    id: 'focus',
    action: 'Focus',
    keyboard: Object.freeze([{ kind: 'key', cap: 'Shift', wide: true } as const]),
    gamepad: Object.freeze([{ kind: 'pad-shoulder', side: 'left' } as const]),
    touch: Object.freeze([{ kind: 'touch', gesture: 'hold' } as const]),
  }),
  Object.freeze({
    id: 'navigate',
    action: 'Navigate',
    keyboard: Object.freeze([{ kind: 'key', cap: '↑' } as const, { kind: 'key', cap: '↓' } as const]),
    gamepad: Object.freeze([{ kind: 'pad-dir', at: 'all' } as const]),
    touch: Object.freeze([{ kind: 'touch', gesture: 'swipe', at: 'up' } as const]),
  }),
  Object.freeze({
    id: 'confirm',
    action: 'Confirm',
    keyboard: Object.freeze([{ kind: 'key', cap: 'Enter', wide: true } as const]),
    gamepad: Object.freeze([{ kind: 'pad-face', at: 'down' } as const]),
    touch: Object.freeze([{ kind: 'touch', gesture: 'tap' } as const]),
  }),
  Object.freeze({
    id: 'back',
    action: 'Back',
    keyboard: Object.freeze([{ kind: 'key', cap: 'Esc', wide: true } as const]),
    gamepad: Object.freeze([{ kind: 'pad-face', at: 'right' } as const]),
    touch: Object.freeze([{ kind: 'touch', gesture: 'swipe', at: 'down' } as const]),
  }),
]);
