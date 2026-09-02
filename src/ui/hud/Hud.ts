/**
 * THE HUD.
 *
 * The HUD is a pure read model. It never asks the game a question, never holds a piece of
 * run state, and never decides anything: the simulation hands it a `HudSnapshot` and it
 * renders exactly that. The reason is a debugging one - when the multiplier on screen
 * disagrees with the multiplier in the sim, there is precisely one place that can be
 * wrong, and it is not this file.
 *
 * Two disciplines run through everything below.
 *
 * 1. EVERY DOM WRITE HAPPENS IN `frame()`. `submit()` stores a reference and sets a flag.
 *    Simulation code calls it from the fixed step, possibly several times per rendered
 *    frame, and it must never cost a style invalidation to do so.
 *
 * 2. EVERY WRITE IS DIRTY-CHECKED. A score that has not moved must not be re-formatted and
 *    re-assigned; the string allocation and the subtree invalidation are both real, and
 *    twenty-odd readouts at 60 Hz is exactly how a HUD quietly eats its millisecond.
 *
 * Layout properties are never animated. Bars scale, panels fade, the reticle scales. If a
 * change to this file makes something animate `width`, `top` or `font-size`, the change is
 * wrong regardless of how it looks.
 */

import type { QualityResolution } from '../../core/Quality';
import type { Alpha, Disposable, Millis, Seed, Tickable, Unit } from '../../core/types';
import { NumVar, addStyleOnce, el, setAttr, setText } from '../Overlay';
import { BallCount, type BallEvent } from './BallCount';
import { Clusters, labelledValue, meter } from './Clusters';

export type { BallEvent, BallEventKind } from './BallCount';

/** Where the player is. Names are already localised and already uppercase-safe. */
export interface HudLocation {
  readonly universeName: string;
  readonly zoneName: string;
  readonly roomName: string;
  /** Zero-based index of the current room within the zone. */
  readonly roomIndex: number;
  readonly roomCount: number;
  readonly seed: Seed;
}

/** What the player is earning. `decay` is how much of the multiplier window is left. */
export interface HudEarnings {
  readonly score: number;
  readonly multiplier: number;
  readonly decay: Unit;
  readonly streak: number;
}

export interface HudPickup {
  readonly id: string;
  readonly label: string;
  /** A single mark, drawn as text. Original geometric glyphs only - never a brand mark. */
  readonly glyph: string;
  /** 1 at pickup, 0 the frame it expires. Rendered as a scaleX meter. */
  readonly remaining: Unit;
  readonly stacks: number;
}

export type ReticleState = 'idle' | 'tracking' | 'locked';

export interface HudTarget {
  readonly state: ReticleState;
  readonly label: string;
  readonly rangeM: number;
}

export type DangerLevel = 'none' | 'warn' | 'critical';

export interface HudDanger {
  readonly level: DangerLevel;
  readonly message: string;
}

export interface HudTelemetry {
  readonly fps: number;
  readonly frameMs: Millis;
  readonly uiMs: Millis;
  readonly drawCalls: number;
  readonly liveShards: number;
  readonly renderScale: number;
}

export interface HudLegendEntry {
  readonly keys: string;
  readonly action: string;
}

export interface HudSnapshot {
  readonly balls: number;
  readonly location: HudLocation;
  readonly earnings: HudEarnings;
  readonly pickups: readonly HudPickup[];
  readonly target: HudTarget;
  readonly danger: HudDanger;
  readonly telemetry: HudTelemetry;
}

/**
 * DOM pool sizes. Presentation, not performance budget: these bound how much HUD chrome
 * exists at all, and they are identical on every tier because a phone and a workstation
 * show the same instrument cluster. Overflow is clamped, never grown - a HUD that
 * allocates mid-run is a HUD that stutters mid-run.
 */
const HUD_POOLS = Object.freeze({
  railTicks: 24,
  pickupChips: 6,
  legendRows: 6,
});

const pad2 = (value: number): string => (value < 10 ? `0${value}` : String(value));

/** Thin-space grouping. Locale-independent on purpose: the score must not reflow by
 *  locale, and `toLocaleString` allocates a formatter's worth of work per call. */
function groupDigits(value: number): string {
  const raw = String(Math.max(0, Math.trunc(value)));
  if (raw.length <= 3) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const fromEnd = raw.length - i - 1;
    out += raw.charAt(i);
    if (fromEnd > 0 && fromEnd % 3 === 0) out += '\u2009';
  }
  return out;
}

const formatSeed = (seed: Seed): string => `0x${seed.toString(16).toUpperCase().padStart(8, '0')}`;

const HUD_CSS = `
.sp-hud { position: absolute; inset: 0; pointer-events: none; }

/* ---- topLeft: where you are ---- */
.sp-where { display: flex; flex-direction: column; gap: 6px; }
.sp-where-universe { font-size: 10px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--sp-accent); opacity: 0.85; }
.sp-where-zone { font-size: 20px; font-weight: 650; letter-spacing: 0.04em; }
.sp-where-room { display: flex; align-items: baseline; gap: 10px; }
.sp-where-room-name { font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sp-ink-dim); }
.sp-where-room-idx { font-family: var(--sp-font-mono); font-size: 11px; font-variant-numeric: tabular-nums; color: var(--sp-ink-faint); }

.sp-rail {
  --sp-rail-tick: 12px;
  --sp-rail-gap: 4px;
  position: relative;
  display: flex;
  gap: var(--sp-rail-gap);
  height: 3px;
}
.sp-rail-tick { width: var(--sp-rail-tick); height: 3px; border-radius: 2px; background: rgba(130, 170, 210, 0.22); }
.sp-rail-tick[data-done='true'] { background: rgba(111, 216, 255, 0.42); }
.sp-rail-tick[data-on='false'] { display: none; }
/* The marker travels on transform alone; the ticks themselves never move. */
.sp-rail-marker {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--sp-rail-tick);
  height: 3px;
  border-radius: 2px;
  background: var(--sp-accent);
  box-shadow: 0 0 10px rgba(111, 216, 255, 0.8);
  transform: translateX(calc(var(--rail-i, 0) * (var(--sp-rail-tick) + var(--sp-rail-gap))));
  transition: transform var(--sp-ui-transition) cubic-bezier(0.2, 0.8, 0.2, 1);
  will-change: transform;
}

.sp-seed { display: flex; align-items: center; gap: 6px; }
.sp-seed-btn {
  font: inherit;
  font-family: var(--sp-font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--sp-ink-dim);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.sp-seed-btn[data-copied='true'] { color: var(--sp-gain); }

/* ---- topRight: what you are earning ---- */
.sp-earn { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.sp-earn-mult { display: flex; align-items: baseline; gap: 2px; font-weight: 750; letter-spacing: -0.02em; }
.sp-earn-mult-sign { font-size: 16px; color: var(--sp-ink-faint); }
.sp-earn-mult-v { font-size: 28px; font-variant-numeric: tabular-nums; color: var(--sp-accent); text-shadow: 0 0 18px rgba(111, 216, 255, 0.45); }
.sp-earn-decay { width: 108px; }
.sp-earn-score { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.sp-earn-streak { font-family: var(--sp-font-mono); font-size: 10px; letter-spacing: 0.1em; color: var(--sp-ink-dim); }
.sp-earn[data-streaking='true'] .sp-earn-streak { color: var(--sp-warn); }

/* ---- rightRail: active pickups ---- */
/* A FIXED six-slot rack. Slots keep their space when empty (visibility, not display) so
   a pickup expiring mid-corridor cannot reflow the panel, the cluster and the grid on a
   frame the player is mid-throw. The whole rack fades out when nothing is active, which
   is the only state change worth paying a layout for - and it pays none. */
.sp-pickups { width: 184px; max-width: 100%; display: flex; flex-direction: column; gap: 8px; opacity: 1; transition: opacity var(--sp-ui-transition) linear; }
.sp-pickups[data-on='false'] { opacity: 0; visibility: hidden; }
.sp-pickup-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.sp-chip {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 8px;
  opacity: 1;
  transition: opacity var(--sp-ui-transition) linear;
}
.sp-chip[data-on='false'] { opacity: 0; visibility: hidden; }
.sp-chip-glyph { font-size: 14px; color: var(--sp-accent); text-align: center; }
.sp-chip-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.sp-chip-label { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sp-ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-chip-stacks { font-family: var(--sp-font-mono); font-size: 10px; color: var(--sp-ink-faint); }

/* ---- bottomRight: telemetry and legend ---- */
.sp-tel { display: flex; flex-direction: column; gap: 3px; align-items: flex-end; }
.sp-tel-row { display: grid; grid-template-columns: auto auto 44px; align-items: center; gap: 8px; }
.sp-tel-name { font-size: 9px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--sp-ink-faint); }
.sp-tel-v { font-family: var(--sp-font-mono); font-size: 10px; font-variant-numeric: tabular-nums; color: var(--sp-ink-dim); }
.sp-tel-row[data-over='true'] .sp-tel-v { color: var(--sp-danger); }
.sp-legend { display: flex; flex-direction: column; gap: 2px; align-items: flex-end; }
.sp-legend-row { display: flex; gap: 8px; align-items: baseline; }
.sp-legend-row[data-on='false'] { display: none; }
.sp-legend-keys { font-family: var(--sp-font-mono); font-size: 10px; color: var(--sp-ink); opacity: 0.8; }
.sp-legend-action { font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sp-ink-faint); }

/* ---- centre ---- */
/* Centred with negative margins, not translate(-50%,-50%): that keeps transform free
   for state animation instead of spending it on positioning. */
.sp-reticle {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 64px;
  height: 64px;
  margin: -32px 0 0 -32px;
  color: var(--sp-ink);
  opacity: 0.55;
  transform: scale(0.86);
  transition: transform var(--sp-ui-transition) cubic-bezier(0.2, 0.8, 0.2, 1),
              opacity var(--sp-ui-transition) linear;
  will-change: transform, opacity;
}
.sp-reticle[data-state='tracking'] { opacity: 0.85; transform: scale(1); }
.sp-reticle[data-state='locked'] { opacity: 1; transform: scale(1.14); color: var(--sp-accent); }
.sp-ret-tick { position: absolute; background: currentColor; box-shadow: 0 0 6px currentColor; }
.sp-ret-tick--n { left: 50%; top: 0; width: 1px; height: 10px; margin-left: -0.5px; }
.sp-ret-tick--s { left: 50%; bottom: 0; width: 1px; height: 10px; margin-left: -0.5px; }
.sp-ret-tick--w { top: 50%; left: 0; height: 1px; width: 10px; margin-top: -0.5px; }
.sp-ret-tick--e { top: 50%; right: 0; height: 1px; width: 10px; margin-top: -0.5px; }
.sp-ret-dot { position: absolute; left: 50%; top: 50%; width: 2px; height: 2px; margin: -1px 0 0 -1px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
.sp-ret-ring { position: absolute; inset: 20px; border: 1px solid currentColor; border-radius: 50%; opacity: 0; transition: opacity var(--sp-ui-transition) linear; }
.sp-reticle[data-state='locked'] .sp-ret-ring { opacity: 0.5; }

.sp-target { position: absolute; left: 0; right: 0; top: calc(50% + 46px); text-align: center; }
.sp-target-inner { display: inline-flex; gap: 10px; align-items: baseline; opacity: 0; transition: opacity var(--sp-ui-transition) linear; }
.sp-target[data-on='true'] .sp-target-inner { opacity: 1; }
.sp-target-label { font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--sp-ink-dim); }
.sp-target-range { font-family: var(--sp-font-mono); font-size: 10px; font-variant-numeric: tabular-nums; color: var(--sp-ink-faint); }

.sp-danger { position: absolute; left: 0; right: 0; top: calc(50% - 132px); text-align: center; }
.sp-danger-msg {
  display: inline-block;
  padding: 5px 14px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  border-radius: 2px;
  opacity: 0;
  transform: scale(0.94);
  transition: opacity var(--sp-ui-transition) linear,
              transform var(--sp-ui-transition) cubic-bezier(0.2, 0.8, 0.2, 1);
  will-change: transform, opacity;
}
.sp-danger[data-level='warn'] .sp-danger-msg {
  opacity: 1;
  transform: scale(1);
  color: var(--sp-warn);
  box-shadow: 0 0 0 1px rgba(255, 196, 107, 0.35) inset, 0 0 28px -10px var(--sp-warn);
}
.sp-danger[data-level='critical'] .sp-danger-msg {
  opacity: 1;
  transform: scale(1.06);
  color: var(--sp-danger);
  box-shadow: 0 0 0 1px rgba(255, 93, 108, 0.45) inset, 0 0 34px -8px var(--sp-danger);
}
`;

/** topLeft. Rebuilt only when the room actually changes; the rail is pooled. */
class WhereCluster {
  private readonly universe: HTMLElement;
  private readonly zone: HTMLElement;
  private readonly roomName: HTMLElement;
  private readonly roomIdx: HTMLElement;
  private readonly ticks: HTMLElement[] = [];
  private readonly markerIndex: NumVar;
  private readonly seedBtn: HTMLButtonElement;

  private lastRoomCount = -1;
  private lastRoomIndex = -1;
  private lastSeed = Number.NaN;

  constructor(parent: HTMLElement) {
    const root = el('div', 'sp-where', parent);
    this.universe = el('div', 'sp-where-universe', root);
    this.zone = el('div', 'sp-where-zone', root);

    const room = el('div', 'sp-where-room', root);
    this.roomName = el('span', 'sp-where-room-name', room);
    this.roomIdx = el('span', 'sp-where-room-idx', room);

    const rail = el('div', 'sp-rail', root);
    for (let i = 0; i < HUD_POOLS.railTicks; i += 1) {
      const tick = el('i', 'sp-rail-tick', rail);
      tick.dataset['on'] = 'false';
      tick.dataset['done'] = 'false';
      this.ticks.push(tick);
    }
    const marker = el('i', 'sp-rail-marker', rail);
    this.markerIndex = new NumVar(marker, '--rail-i', 1);

    const seedRow = el('div', 'sp-seed', root);
    const seedLabel = el('span', 'sp-label', seedRow);
    seedLabel.textContent = 'Seed';
    // A real `.hit` child: pointer events are gated by the overlay's data-interactive, so
    // this cannot swallow a throw during play - it is reachable from the pause screen.
    this.seedBtn = el('button', 'sp-seed-btn hit', seedRow);
    this.seedBtn.type = 'button';
    this.seedBtn.addEventListener('click', () => {
      void this.copySeed();
    });
  }

  apply(location: HudLocation): void {
    setText(this.universe, location.universeName);
    setText(this.zone, location.zoneName);
    setText(this.roomName, location.roomName);

    const count = Math.min(Math.max(0, Math.trunc(location.roomCount)), HUD_POOLS.railTicks);
    const index = Math.min(Math.max(0, Math.trunc(location.roomIndex)), Math.max(0, count - 1));

    if (count !== this.lastRoomCount || index !== this.lastRoomIndex) {
      setText(this.roomIdx, `${pad2(index + 1)} / ${pad2(count)}`);
      for (let i = 0; i < this.ticks.length; i += 1) {
        const tick = this.ticks[i];
        if (tick === undefined) continue;
        setAttr(tick, 'data-on', i < count ? 'true' : 'false');
        setAttr(tick, 'data-done', i < index ? 'true' : 'false');
      }
      this.markerIndex.set(index);
      this.lastRoomCount = count;
      this.lastRoomIndex = index;
    }

    if (location.seed !== this.lastSeed) {
      this.lastSeed = location.seed;
      setText(this.seedBtn, formatSeed(location.seed));
      setAttr(this.seedBtn, 'data-copied', 'false');
    }
  }

  private async copySeed(): Promise<void> {
    const text = this.seedBtn.textContent ?? '';
    if (text.length === 0) return;
    // Clipboard access is permission-gated and absent in insecure contexts; a seed the
    // player can still read on screen is a fine failure mode, an unhandled rejection is not.
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      setAttr(this.seedBtn, 'data-copied', 'true');
    } catch {
      setAttr(this.seedBtn, 'data-copied', 'false');
    }
  }
}

/** topRight. */
class EarnCluster {
  private readonly root: HTMLElement;
  private readonly mult: HTMLElement;
  private readonly decay: NumVar;
  private readonly score: HTMLElement;
  private readonly streak: HTMLElement;

  private lastMult = Number.NaN;
  private lastScore = Number.NaN;
  private lastStreak = Number.NaN;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'sp-earn', parent);

    const multRow = el('div', 'sp-earn-mult', this.root);
    const sign = el('span', 'sp-earn-mult-sign', multRow);
    sign.textContent = '×';
    this.mult = el('span', 'sp-earn-mult-v', multRow);

    this.decay = new NumVar(meter(this.root, 'sp-earn-decay'), '--fill', 0.005);
    this.score = el('div', 'sp-earn-score sp-value', this.root);
    this.streak = el('div', 'sp-earn-streak', this.root);
  }

  apply(earnings: HudEarnings): void {
    if (earnings.multiplier !== this.lastMult) {
      this.lastMult = earnings.multiplier;
      setText(this.mult, earnings.multiplier.toFixed(1));
    }
    this.decay.set(earnings.decay < 0 ? 0 : earnings.decay > 1 ? 1 : earnings.decay);
    if (earnings.score !== this.lastScore) {
      this.lastScore = earnings.score;
      setText(this.score, groupDigits(earnings.score));
    }
    if (earnings.streak !== this.lastStreak) {
      this.lastStreak = earnings.streak;
      setText(this.streak, `Streak ${Math.max(0, Math.trunc(earnings.streak))}`);
      setAttr(this.root, 'data-streaking', earnings.streak > 0 ? 'true' : 'false');
    }
  }
}

/** One pooled pickup chip. Never created or destroyed during a run - only shown and hidden. */
class PickupChip {
  readonly root: HTMLElement;
  private readonly glyph: HTMLElement;
  private readonly label: HTMLElement;
  private readonly stacks: HTMLElement;
  private readonly fill: NumVar;

  private lastId = '';
  private lastStacks = Number.NaN;

  constructor(parent: HTMLElement) {
    this.root = el('li', 'sp-chip', parent);
    this.root.dataset['on'] = 'false';
    this.glyph = el('span', 'sp-chip-glyph', this.root);
    const body = el('span', 'sp-chip-body', this.root);
    this.label = el('span', 'sp-chip-label', body);
    this.fill = new NumVar(meter(body, 'sp-chip-bar'), '--fill', 0.005);
    this.stacks = el('span', 'sp-chip-stacks', this.root);
  }

  show(pickup: HudPickup): void {
    if (pickup.id !== this.lastId) {
      this.lastId = pickup.id;
      setText(this.glyph, pickup.glyph);
      setText(this.label, pickup.label);
    }
    if (pickup.stacks !== this.lastStacks) {
      this.lastStacks = pickup.stacks;
      setText(this.stacks, pickup.stacks > 1 ? `×${Math.trunc(pickup.stacks)}` : '');
    }
    this.fill.set(pickup.remaining < 0 ? 0 : pickup.remaining > 1 ? 1 : pickup.remaining);
    setAttr(this.root, 'data-on', 'true');
  }

  hide(): void {
    if (this.lastId === '') return;
    this.lastId = '';
    setAttr(this.root, 'data-on', 'false');
  }
}

/** rightRail. */
class PickupRail {
  private readonly panel: HTMLElement;
  private readonly chips: PickupChip[] = [];

  constructor(parent: HTMLElement) {
    this.panel = el('div', 'sp-panel sp-pickups', parent);
    this.panel.dataset['on'] = 'false';
    const head = el('div', 'sp-label', this.panel);
    head.textContent = 'Active';
    const list = el('ul', 'sp-pickup-list', this.panel);
    for (let i = 0; i < HUD_POOLS.pickupChips; i += 1) this.chips.push(new PickupChip(list));
  }

  apply(pickups: readonly HudPickup[]): void {
    for (let i = 0; i < this.chips.length; i += 1) {
      const chip = this.chips[i];
      if (chip === undefined) continue;
      const pickup = pickups[i];
      if (pickup === undefined) chip.hide();
      else chip.show(pickup);
    }
    // Overflow past the rack is dropped, not queued: a seventh simultaneous pickup is a
    // design problem, and silently growing the DOM mid-run is a worse answer than losing
    // a row nobody has room to read.
    setAttr(this.panel, 'data-on', pickups.length > 0 ? 'true' : 'false');
  }
}

/** One telemetry line: name, value, and a scaleX meter against a Quality.ts ceiling. */
/**
 * Which way is bad. Most rows are ceilings - frame time, draw calls, live shards - where
 * exceeding the number is the failure. FPS is the opposite, and treating it as a ceiling is
 * why the HUD painted "59 / 30" red while the renderer was beating its target by double. A
 * telemetry readout that lies about pass/fail is worse than none, because it is believed.
 */
type TelemetryDirection = 'ceiling' | 'floor';

class TelemetryRow {
  private readonly root: HTMLElement;
  private readonly value: HTMLElement;
  private readonly fill: NumVar;
  private readonly track: HTMLElement;
  private readonly ceiling: number;
  private readonly direction: TelemetryDirection;
  private readonly decimals: number;
  private readonly ceilingText: string;

  private last = Number.NaN;
  private over = false;

  constructor(
    parent: HTMLElement,
    name: string,
    ceiling: number,
    decimals: number,
    direction: TelemetryDirection = 'ceiling',
  ) {
    this.ceiling = ceiling;
    this.direction = direction;
    this.decimals = decimals;
    this.ceilingText = ceiling.toFixed(decimals);

    this.root = el('div', 'sp-tel-row', parent);
    const label = el('span', 'sp-tel-name', this.root);
    label.textContent = name;
    this.value = el('span', 'sp-tel-v', this.root);
    this.track = meter(this.root, 'sp-tel-bar');
    this.fill = new NumVar(this.track, '--fill', 0.01);
  }

  set(value: number): void {
    const ratio = this.ceiling > 0 ? value / this.ceiling : 0;
    this.fill.set(ratio < 0 ? 0 : ratio > 1 ? 1 : ratio);
    if (value !== this.last) {
      this.last = value;
      setText(this.value, `${value.toFixed(this.decimals)} / ${this.ceilingText}`);
    }
    // A floor row fills as it APPROACHES the target and fails below it; a ceiling row
    // fills as it approaches the limit and fails above it.
    const over = this.direction === 'floor' ? value < this.ceiling : value > this.ceiling;
    if (over !== this.over) {
      this.over = over;
      const flag = over ? 'true' : 'false';
      setAttr(this.root, 'data-over', flag);
      setAttr(this.track, 'data-over', flag);
    }
  }
}

/**
 * bottomRight. Every ceiling here is imported from core/Quality.ts rather than typed in -
 * a telemetry readout measuring against a number the engine does not actually use is
 * worse than no telemetry, because it is believed.
 */
/** Native resolution. The scale row reports against this, not against the ladder ceiling. */
const SCALE_TARGET = 1.0;

class TelemetryCluster {
  private readonly fps: TelemetryRow;
  private readonly frame: TelemetryRow;
  private readonly ui: TelemetryRow;
  private readonly draw: TelemetryRow;
  private readonly shards: TelemetryRow;
  private readonly scale: TelemetryRow;
  private readonly legendRows: { root: HTMLElement; keys: HTMLElement; action: HTMLElement }[] = [];

  constructor(parent: HTMLElement, quality: QualityResolution) {
    const budget = quality.budget;

    const tier = labelledValue(parent, 'Tier', 'sp-mono');
    tier.textContent = quality.reducedMotion ? `${quality.graphics} · reduced motion` : quality.graphics;

    const tel = el('div', 'sp-tel', parent);
    this.fps = new TelemetryRow(tel, 'fps', budget.targetFps, 0, 'floor');
    this.frame = new TelemetryRow(tel, 'frame', budget.msBudget.frame, 1);
    this.ui = new TelemetryRow(tel, 'ui', budget.msBudget.ui, 2);
    this.draw = new TelemetryRow(tel, 'draw', budget.drawCallCeiling, 0);
    this.shards = new TelemetryRow(tel, 'shards', budget.maxShardsLive, 0);
    // The ladder max is 2.0 on every tier so the governor can supersample when it earns it,
    // but showing "0.67 / 2.00" invites the reading that the renderer is failing by 3x. The
    // row measures against NATIVE, which is what the scale is actually trying to reach.
    this.scale = new TelemetryRow(tel, 'scale', SCALE_TARGET, 2, 'floor');

    el('div', 'sp-rule', parent);

    const legend = el('div', 'sp-legend', parent);
    for (let i = 0; i < HUD_POOLS.legendRows; i += 1) {
      const row = el('div', 'sp-legend-row', legend);
      row.dataset['on'] = 'false';
      this.legendRows.push({
        root: row,
        keys: el('span', 'sp-legend-keys', row),
        action: el('span', 'sp-legend-action', row),
      });
    }
  }

  apply(telemetry: HudTelemetry): void {
    this.fps.set(telemetry.fps);
    this.frame.set(telemetry.frameMs);
    this.ui.set(telemetry.uiMs);
    this.draw.set(telemetry.drawCalls);
    this.shards.set(telemetry.liveShards);
    this.scale.set(telemetry.renderScale);
  }

  setLegend(entries: readonly HudLegendEntry[]): void {
    for (let i = 0; i < this.legendRows.length; i += 1) {
      const row = this.legendRows[i];
      if (row === undefined) continue;
      const entry = entries[i];
      if (entry === undefined) {
        setAttr(row.root, 'data-on', 'false');
        continue;
      }
      setText(row.keys, entry.keys);
      setText(row.action, entry.action);
      setAttr(row.root, 'data-on', 'true');
    }
  }
}

/** centre: reticle, target readout, danger callout. */
class CentreCluster {
  private readonly reticle: HTMLElement;
  private readonly target: HTMLElement;
  private readonly targetLabel: HTMLElement;
  private readonly targetRange: HTMLElement;
  private readonly danger: HTMLElement;
  private readonly dangerMsg: HTMLElement;

  private lastRange = Number.NaN;

  constructor(parent: HTMLElement) {
    this.danger = el('div', 'sp-danger', parent);
    this.danger.dataset['level'] = 'none';
    this.dangerMsg = el('span', 'sp-danger-msg', this.danger);

    this.reticle = el('div', 'sp-reticle', parent);
    this.reticle.dataset['state'] = 'idle';
    el('i', 'sp-ret-tick sp-ret-tick--n', this.reticle);
    el('i', 'sp-ret-tick sp-ret-tick--e', this.reticle);
    el('i', 'sp-ret-tick sp-ret-tick--s', this.reticle);
    el('i', 'sp-ret-tick sp-ret-tick--w', this.reticle);
    el('i', 'sp-ret-ring', this.reticle);
    el('i', 'sp-ret-dot', this.reticle);

    this.target = el('div', 'sp-target', parent);
    this.target.dataset['on'] = 'false';
    const inner = el('div', 'sp-target-inner', this.target);
    this.targetLabel = el('span', 'sp-target-label', inner);
    this.targetRange = el('span', 'sp-target-range', inner);
  }

  apply(target: HudTarget, danger: HudDanger): void {
    setAttr(this.reticle, 'data-state', target.state);

    const visible = target.state !== 'idle' && target.label.length > 0;
    setAttr(this.target, 'data-on', visible ? 'true' : 'false');
    if (visible) {
      setText(this.targetLabel, target.label);
      // Whole metres only: a range that flickers through decimals every frame is noise,
      // and it is the one readout sitting directly under the player's aim point.
      const rounded = Math.round(target.rangeM);
      if (rounded !== this.lastRange) {
        this.lastRange = rounded;
        setText(this.targetRange, `${rounded} m`);
      }
    }

    setAttr(this.danger, 'data-level', danger.level);
    if (danger.level !== 'none') setText(this.dangerMsg, danger.message);
  }
}

/**
 * The in-run instrument cluster. One per run; `submit` it a snapshot from the fixed step
 * and register it with the Overlay so it gets ticked.
 */
export class Hud implements Tickable, Disposable {
  readonly root: HTMLDivElement;
  readonly ballCount: BallCount;

  private readonly clusters: Clusters;
  private readonly where: WhereCluster;
  private readonly earn: EarnCluster;
  private readonly pickups: PickupRail;
  private readonly telemetry: TelemetryCluster;
  private readonly centre: CentreCluster;

  private snapshot: HudSnapshot | null = null;
  private snapshotDirty = false;

  constructor(parent: HTMLElement, quality: QualityResolution) {
    addStyleOnce('sp-hud', HUD_CSS);

    this.root = el('div', 'sp-hud', parent);
    this.clusters = new Clusters(this.root);

    this.where = new WhereCluster(this.clusters.cluster('topLeft'));
    this.earn = new EarnCluster(this.clusters.cluster('topRight'));
    this.pickups = new PickupRail(this.clusters.cluster('rightRail'));
    this.ballCount = new BallCount(this.clusters.cluster('bottomLeft'), quality.motionRules);
    this.telemetry = new TelemetryCluster(this.clusters.cluster('bottomRight'), quality);
    this.centre = new CentreCluster(this.clusters.cluster('centre'));
  }

  /**
   * Called from the fixed step. Stores the reference and returns: the snapshot is treated
   * as immutable for the frame, so the producer must hand over a value it will not mutate
   * before the next `frame()`.
   */
  submit(snapshot: HudSnapshot): void {
    this.snapshot = snapshot;
    this.snapshotDirty = true;
  }

  /**
   * The physical reaction to a ball gained, spent or lost. Ammo owns the count and calls
   * this once per event; the count itself still arrives through the snapshot, so a missed
   * event costs a punch of feedback and never a wrong number.
   */
  ammo(event: BallEvent): void {
    this.ballCount.apply(event);
  }

  setLegend(entries: readonly HudLegendEntry[]): void {
    this.telemetry.setLegend(entries);
  }

  fixedUpdate(dt: Millis): void {
    this.ballCount.fixedUpdate(dt);
  }

  frame(alpha: Alpha): void {
    const snapshot = this.snapshot;
    if (snapshot !== null && this.snapshotDirty) {
      this.snapshotDirty = false;
      this.where.apply(snapshot.location);
      this.earn.apply(snapshot.earnings);
      this.pickups.apply(snapshot.pickups);
      this.telemetry.apply(snapshot.telemetry);
      this.centre.apply(snapshot.target, snapshot.danger);
      this.ballCount.setCount(snapshot.balls);
    }
    // Always ticked: the springs keep moving on frames where no new snapshot arrived.
    this.ballCount.frame(alpha);
  }

  dispose(): void {
    this.ballCount.dispose();
    this.clusters.dispose();
    this.root.remove();
  }
}
