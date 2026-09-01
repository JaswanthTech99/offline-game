/**
 * THE CLUSTER GRID.
 *
 * Six fixed positions, and every in-run screen reuses them. That is the whole point: a
 * player who has learned where the ball count lives in the corridor must not have to
 * re-find it on the pause screen, the room-clear card or the run-end summary. Screens
 * change what is IN a cluster; nothing is allowed to change where a cluster IS.
 *
 *   topLeft      where you are        universe / zone / room, the room rail, the seed
 *   topRight     what you are earning multiplier, decay, score, streak
 *   rightRail    what is acting on you active pickups, as a glass panel
 *   bottomLeft   what you can spend   THE BALL COUNT - the loudest element on screen
 *   bottomRight  what it costs        telemetry and the input legend
 *   centre       what you are aiming at reticle, target readout, danger callout
 *
 * The four corners and the rail live in a 3x3 grid inside the safe-area padding. `centre`
 * deliberately does NOT: the reticle must sit at the optical centre of the CANVAS, and a
 * grid cell centred inside asymmetric padding (a notch eats the left gutter only) is
 * several pixels off. A reticle a few pixels off centre is a game that feels broken and
 * nobody can say why. So `centre` is its own full-bleed absolute layer over the grid.
 *
 * This module also owns the shared chrome vocabulary - panel, label, value, hairline,
 * meter - because the alternative is six clusters that each invent their own hairline.
 */

import type { Disposable } from '../../core/types';
import { addStyleOnce, el } from '../Overlay';

export type ClusterId =
  | 'topLeft'
  | 'topRight'
  | 'rightRail'
  | 'bottomLeft'
  | 'bottomRight'
  | 'centre';

export const CLUSTER_IDS: readonly ClusterId[] = Object.freeze([
  'topLeft',
  'topRight',
  'rightRail',
  'bottomLeft',
  'bottomRight',
  'centre',
]);

const CLUSTERS_CSS = `
.sp-cluster-root { position: absolute; inset: 0; pointer-events: none; }

.sp-clusters {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: max-content 1fr max-content;
  grid-template-rows: max-content 1fr max-content;
  grid-template-areas:
    'tl .  tr'
    '.  .  rail'
    'bl .  br';
  padding: var(--sp-pad-t) var(--sp-pad-r) var(--sp-pad-b) var(--sp-pad-l);
  pointer-events: none;
}

/* contain: layout style - never paint. Paint containment clips, and the ball count's
   outermost glow radius reaches well outside its own box by design. */
.sp-c {
  display: flex;
  flex-direction: column;
  gap: 10px;
  contain: layout style;
}
.sp-c--tl   { grid-area: tl;   align-items: flex-start; }
.sp-c--tr   { grid-area: tr;   align-items: flex-end; text-align: right; }
.sp-c--rail { grid-area: rail; align-items: flex-end; align-self: center; justify-self: end; }
.sp-c--bl   { grid-area: bl;   align-items: flex-start; justify-content: flex-end; }
.sp-c--br   { grid-area: br;   align-items: flex-end; text-align: right; justify-content: flex-end; }

.sp-centre { position: absolute; inset: 0; pointer-events: none; contain: layout style; }

/* ---- shared chrome vocabulary ---- */

.sp-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--sp-ink-faint);
}

.sp-value {
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
  color: var(--sp-ink);
}

.sp-lv { display: flex; align-items: baseline; gap: 6px; }

.sp-mono {
  font-family: var(--sp-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--sp-ink-dim);
}

/* One-pixel rules are drawn as a scaled background rather than a border so that a cluster
   can fade a divider in and out without ever touching box metrics. */
.sp-rule {
  height: 1px;
  align-self: stretch;
  background: linear-gradient(90deg, var(--sp-glass-line), transparent);
}
.sp-c--tr .sp-rule,
.sp-c--br .sp-rule { background: linear-gradient(270deg, var(--sp-glass-line), transparent); }

.sp-panel {
  position: relative;
  padding: 10px 12px;
  border-radius: 3px;
  background: var(--sp-glass);
  border: 1px solid var(--sp-glass-line);
  box-shadow: 0 1px 0 var(--sp-glass-hi) inset, 0 8px 24px -12px var(--sp-shadow);
  /* One small rounded rect of backdrop blur is affordable and sells the glass; a
     full-width blurred bar is not, and would read as a phone UI over a 3D game. */
  backdrop-filter: blur(10px) saturate(120%);
  -webkit-backdrop-filter: blur(10px) saturate(120%);
}

/* METER: the only correct way to animate a bar. scaleX on a transform-origin:left fill.
   Animating width here would relayout the panel, the cluster and the grid every frame. */
.sp-meter {
  position: relative;
  height: 2px;
  border-radius: 1px;
  overflow: hidden;
  background: rgba(120, 160, 200, 0.16);
}
.sp-meter > i {
  display: block;
  height: 100%;
  transform: scaleX(var(--fill, 0));
  transform-origin: 0 50%;
  background: var(--sp-accent);
  will-change: transform;
}
.sp-meter[data-over='true'] > i { background: var(--sp-danger); }
`;

/**
 * Owns the grid element and the six cluster boxes. Construct one per in-run screen; they
 * are cheap (six divs) and keeping them separate means a screen can be built ahead of
 * time and swapped in with an opacity change instead of a DOM rebuild.
 *
 * TODO(step-2): pause, room-clear and run-end each construct their own Clusters into
 * Overlay.layer('modal') and fill the same six boxes - the grid is finished, the screens
 * that reuse it are not built yet.
 */
export class Clusters implements Disposable {
  readonly root: HTMLDivElement;

  private readonly grid: HTMLDivElement;
  private readonly boxes: Readonly<Record<ClusterId, HTMLDivElement>>;

  constructor(parent: HTMLElement) {
    addStyleOnce('sp-clusters', CLUSTERS_CSS);

    this.root = el('div', 'sp-cluster-root', parent);
    this.grid = el('div', 'sp-clusters', this.root);

    const topLeft = el('div', 'sp-c sp-c--tl', this.grid);
    const topRight = el('div', 'sp-c sp-c--tr', this.grid);
    const rightRail = el('div', 'sp-c sp-c--rail', this.grid);
    const bottomLeft = el('div', 'sp-c sp-c--bl', this.grid);
    const bottomRight = el('div', 'sp-c sp-c--br', this.grid);

    // Appended after the grid so the reticle paints over any cluster that grows into the
    // middle of the screen, and inset from nothing so it is centred on the canvas.
    const centre = el('div', 'sp-centre', this.root);

    this.boxes = { topLeft, topRight, rightRail, bottomLeft, bottomRight, centre };
  }

  cluster(id: ClusterId): HTMLDivElement {
    return this.boxes[id];
  }

  dispose(): void {
    this.root.remove();
  }
}

/** Label + value pair, the shape two thirds of the HUD is made of. */
export function labelledValue(
  parent: HTMLElement,
  labelText: string,
  valueClass: string,
): HTMLSpanElement {
  const row = el('div', 'sp-lv', parent);
  const label = el('span', 'sp-label', row);
  label.textContent = labelText;
  return el('span', `sp-value ${valueClass}`, row);
}

/** A scaleX meter plus the handle its owner writes `--fill` through. */
export function meter(parent: HTMLElement, extraClass: string): HTMLElement {
  const track = el('div', `sp-meter ${extraClass}`, parent);
  el('i', '', track);
  return track;
}
