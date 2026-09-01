/**
 * THE SETTINGS SCREEN'S BACKING STORE - AND ITS TEETH.
 *
 * A settings menu is decorative unless every switch in it lands on the same token the
 * engine already reads. So nothing here invents a parallel configuration channel: a tier
 * override goes through `core/Quality.resolveTier`, a post toggle goes through
 * `core/Quality.resolvePostChain`, and reduced motion is written as the exact
 * `data-reduced-motion` attribute `ui/Motion.ts` already watches. The settings layer is a
 * PERSISTED SET OF ARGUMENTS to code that exists, never a second implementation of it.
 *
 * THREE RULES THAT SHAPE EVERY FUNCTION BELOW
 *
 * 1. ACCESSIBILITY IS ONE-WAY. `reducedMotion: 'off'` means "do not add reduction"; it can
 *    never cancel the operating system's own preference. That mirrors `MotionDirector.reduced`,
 *    which ORs the attribute with the media query, and the two must not be able to disagree.
 *
 * 2. THE PLAYER CANNOT ASK FOR AN IMPOSSIBLE FRAME. A post override of `'on'` is a REQUEST:
 *    it is fed back through Quality's own gating, so switching on a compute-only effect on a
 *    WebGL fallback quietly stays off rather than producing a broken image.
 *
 * 3. BINDING CONFLICTS ARE FLAGGED, NEVER BLOCKED. A rebind always applies. The conflict list
 *    is advisory data the UI renders next to the row. Blocking the second half of a rebind is
 *    how a player ends up with an unusable control scheme and no way back to a usable one:
 *    they must be able to pass through a conflicting state to reach the mapping they want.
 *
 * Contexts are what make rule 3 honest: `Space` on both throw (in-run) and confirm (in-menu)
 * is not a conflict, because the two are never live at the same time.
 */

import { Emitter, type Unsubscribe } from '../core/Events';
import {
  MOTION,
  POST_EFFECTS,
  RENDER_SCALE_LADDER,
  TIERS,
  resolvePostChain,
  resolveTier,
  type DeviceCaps,
  type MotionRules,
  type PostEffect,
  type PostToggles,
  type QualityBudget,
  type QualityResolution,
  type Tier,
} from '../core/Quality';
import type { Millis } from '../core/types';
import { AUDIO_BUS_IDS, type AudioBusId } from '../audio/Audio';
import type { SaveDb } from './Db';

/**
 * Interaction and IO hygiene, NOT frame budgets - core/Quality.ts owns every number the
 * profiler holds the game to. How long the store waits before writing to disk is a property
 * of the disk, and the same on every tier.
 */
export const SETTINGS_TOKENS = Object.freeze({
  /** Coalescing window for persistence. A dragged volume slider must not write per pixel. */
  persistDebounceMs: 400 as Millis,
  /** Default bus level for a fresh save, before the player has touched anything. */
  defaultBusVolume: 0.8,
  /** Master sits at unity so the other buses are mixed relative to a fixed reference. */
  defaultMasterVolume: 1,
});

/** Bumped when a stored field's MEANING changes. `normalizeSettings` handles the shape. */
export const SETTINGS_VERSION = 1;

/* ------------------------------------------------------------------------------ bindings */

/**
 * Rebindable actions. `aim` and `navigate` are deliberately absent: they are axes, not
 * buttons, and offering a "rebind" for them in a key list is a lie about what the input
 * layer can do.
 */
export type ActionId = 'throw' | 'focus' | 'restart' | 'pause' | 'confirm' | 'back';

export const ACTION_IDS: readonly ActionId[] = Object.freeze([
  'throw',
  'focus',
  'restart',
  'pause',
  'confirm',
  'back',
]);

/**
 * When an action is live. Two actions sharing an input only conflict if their contexts can
 * be active at the same moment - which is why `global` conflicts with everything.
 */
export type ActionContext = 'run' | 'menu' | 'global';

export const ACTION_CONTEXT: Readonly<Record<ActionId, ActionContext>> = Object.freeze({
  throw: 'run',
  focus: 'run',
  restart: 'run',
  pause: 'global',
  confirm: 'menu',
  back: 'menu',
});

export const ACTION_LABEL: Readonly<Record<ActionId, string>> = Object.freeze({
  throw: 'Throw',
  focus: 'Focus',
  restart: 'Restart run',
  pause: 'Pause',
  confirm: 'Confirm',
  back: 'Back',
});

/**
 * A keyboard binding is a `KeyboardEvent.code`, or `Mouse<button>` for a pointer button.
 * One namespace rather than two tables because throw is bound to a mouse button by default
 * and a player rebinding it to a key must not have to know they are crossing a device.
 */
export type InputCode = string;

export const mouseCode = (button: number): InputCode => `Mouse${String(button)}`;

/** W3C Standard Gamepad indices, named by ROLE - no manufacturer's letters or symbols. */
const PAD = Object.freeze({
  faceSouth: 0,
  faceEast: 1,
  faceNorth: 3,
  leftTrigger: 6,
  rightTrigger: 7,
  start: 9,
});

export interface Bindings {
  readonly keyboard: Readonly<Record<ActionId, readonly InputCode[]>>;
  readonly gamepad: Readonly<Record<ActionId, readonly number[]>>;
}

export const DEFAULT_BINDINGS: Bindings = Object.freeze({
  keyboard: Object.freeze({
    throw: Object.freeze([mouseCode(0), 'Space']),
    focus: Object.freeze(['ShiftLeft', mouseCode(2)]),
    restart: Object.freeze(['KeyR']),
    pause: Object.freeze(['Escape']),
    confirm: Object.freeze(['Enter', 'Space']),
    back: Object.freeze(['Backspace']),
  }),
  gamepad: Object.freeze({
    throw: Object.freeze([PAD.rightTrigger]),
    focus: Object.freeze([PAD.leftTrigger]),
    restart: Object.freeze([PAD.faceNorth]),
    pause: Object.freeze([PAD.start]),
    confirm: Object.freeze([PAD.faceSouth]),
    back: Object.freeze([PAD.faceEast]),
  }),
});

export type BindingDevice = 'keyboard' | 'gamepad';

export interface BindingConflict {
  readonly device: BindingDevice;
  /** The shared input: a code for keyboard, a stringified button index for a pad. */
  readonly input: string;
  readonly actions: readonly ActionId[];
}

const contextsCollide = (a: ActionContext, b: ActionContext): boolean =>
  a === 'global' || b === 'global' || a === b;

/**
 * Advisory. Returns every input bound to two actions that can be live together. The result
 * is data for the UI to render - no caller is expected to refuse a rebind because of it.
 */
export function findBindingConflicts(bindings: Bindings): readonly BindingConflict[] {
  const conflicts: BindingConflict[] = [];

  const scan = (device: BindingDevice, table: Readonly<Record<ActionId, readonly (string | number)[]>>): void => {
    const owners = new Map<string, ActionId[]>();
    for (const action of ACTION_IDS) {
      for (const input of table[action]) {
        const key = String(input);
        const existing = owners.get(key);
        if (existing === undefined) owners.set(key, [action]);
        else existing.push(action);
      }
    }
    for (const [input, actions] of owners) {
      if (actions.length < 2) continue;
      const collides = actions.some((a, i) =>
        actions.slice(i + 1).some((b) => contextsCollide(ACTION_CONTEXT[a], ACTION_CONTEXT[b])),
      );
      if (collides) conflicts.push({ device, input, actions });
    }
  };

  scan('keyboard', bindings.keyboard);
  scan('gamepad', bindings.gamepad);
  return conflicts;
}

/* ------------------------------------------------------------------------------- settings */

/** `auto` follows the resolved tier; the other two are the player overruling it. */
export type PostOverride = 'auto' | 'on' | 'off';

export const POST_OVERRIDES: readonly PostOverride[] = Object.freeze(['auto', 'on', 'off']);

/** `system` follows the OS; `on` adds reduction. `off` never cancels the OS preference. */
export type PreferenceMode = 'system' | 'on' | 'off';

export const PREFERENCE_MODES: readonly PreferenceMode[] = Object.freeze(['system', 'on', 'off']);

export interface GraphicsSettings {
  /** null = detect from device caps. */
  readonly tierOverride: Tier | null;
  /** null = use the tier's own rung. Anything off RENDER_SCALE_LADDER is ignored. */
  readonly renderScaleOverride: number | null;
  readonly post: Readonly<Record<PostEffect, PostOverride>>;
}

export interface AccessibilitySettings {
  readonly reducedMotion: PreferenceMode;
  /** Suppresses screen flashes and chromatic pulses. Photosensitivity, not taste. */
  readonly reducedFlashing: boolean;
  /**
   * Damage and danger are signalled by SHAPE as well as colour. Red-on-dark is the single
   * most common thing a colour-blind player cannot read in a game whose whole palette is
   * glass, so the cue has to survive being desaturated.
   */
  readonly shapeCuesForDamage: boolean;
}

export interface ControlSettings {
  /** Charge while held, release to throw - instead of throw-on-press. */
  readonly holdToThrow: boolean;
  readonly bindings: Bindings;
}

export interface BusSetting {
  readonly volume: number;
  readonly muted: boolean;
}

export type AudioSettings = Readonly<Record<AudioBusId, BusSetting>>;

export interface SettingsState {
  readonly version: number;
  readonly graphics: GraphicsSettings;
  readonly accessibility: AccessibilitySettings;
  readonly controls: ControlSettings;
  readonly audio: AudioSettings;
}

const autoPost = (): Readonly<Record<PostEffect, PostOverride>> => {
  const table: Partial<Record<PostEffect, PostOverride>> = {};
  for (const effect of POST_EFFECTS) table[effect] = 'auto';
  return table as Readonly<Record<PostEffect, PostOverride>>;
};

const defaultAudio = (): AudioSettings => {
  const table: Partial<Record<AudioBusId, BusSetting>> = {};
  for (const bus of AUDIO_BUS_IDS) {
    table[bus] = {
      volume: bus === 'master' ? SETTINGS_TOKENS.defaultMasterVolume : SETTINGS_TOKENS.defaultBusVolume,
      muted: false,
    };
  }
  return table as AudioSettings;
};

export function defaultSettings(): SettingsState {
  return {
    version: SETTINGS_VERSION,
    graphics: { tierOverride: null, renderScaleOverride: null, post: autoPost() },
    accessibility: { reducedMotion: 'system', reducedFlashing: false, shapeCuesForDamage: false },
    controls: { holdToThrow: false, bindings: DEFAULT_BINDINGS },
    audio: defaultAudio(),
  };
}

/* -------------------------------------------------------------------------- normalisation */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.find((option) => option === value) ?? fallback;

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const unitScalar = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

const codeList = (value: unknown): readonly InputCode[] | null => {
  if (!Array.isArray(value)) return null;
  const codes = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return codes.length === 0 ? null : Object.freeze(codes);
};

const buttonList = (value: unknown): readonly number[] | null => {
  if (!Array.isArray(value)) return null;
  const buttons = value.filter(
    (entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0,
  );
  return buttons.length === 0 ? null : Object.freeze(buttons);
};

/**
 * Rebuilds a valid settings object from anything at all, field by field, falling back per
 * field rather than per file. A player who hand-edits one line into nonsense keeps every
 * other choice they made - and the options screen never opens onto a half-empty form.
 */
export function normalizeSettings(raw: unknown): SettingsState {
  const base = defaultSettings();
  if (!isRecord(raw)) return base;

  const rawGraphics = isRecord(raw['graphics']) ? raw['graphics'] : {};
  const rawPost = isRecord(rawGraphics['post']) ? rawGraphics['post'] : {};
  const post: Partial<Record<PostEffect, PostOverride>> = {};
  for (const effect of POST_EFFECTS) post[effect] = pick(POST_OVERRIDES, rawPost[effect], 'auto');

  const rawScale = rawGraphics['renderScaleOverride'];
  const renderScaleOverride =
    typeof rawScale === 'number' && RENDER_SCALE_LADDER.includes(rawScale) ? rawScale : null;

  const rawAccess = isRecord(raw['accessibility']) ? raw['accessibility'] : {};
  const rawControls = isRecord(raw['controls']) ? raw['controls'] : {};
  const rawBindings = isRecord(rawControls['bindings']) ? rawControls['bindings'] : {};
  const rawKeyboard = isRecord(rawBindings['keyboard']) ? rawBindings['keyboard'] : {};
  const rawGamepad = isRecord(rawBindings['gamepad']) ? rawBindings['gamepad'] : {};

  const keyboard: Partial<Record<ActionId, readonly InputCode[]>> = {};
  const gamepad: Partial<Record<ActionId, readonly number[]>> = {};
  for (const action of ACTION_IDS) {
    keyboard[action] = codeList(rawKeyboard[action]) ?? DEFAULT_BINDINGS.keyboard[action];
    gamepad[action] = buttonList(rawGamepad[action]) ?? DEFAULT_BINDINGS.gamepad[action];
  }

  const rawAudio = isRecord(raw['audio']) ? raw['audio'] : {};
  const audio: Partial<Record<AudioBusId, BusSetting>> = {};
  for (const bus of AUDIO_BUS_IDS) {
    const entry = isRecord(rawAudio[bus]) ? rawAudio[bus] : {};
    audio[bus] = {
      volume: unitScalar(entry['volume'], base.audio[bus].volume),
      muted: bool(entry['muted'], false),
    };
  }

  return {
    version: SETTINGS_VERSION,
    graphics: {
      tierOverride: TIERS.find((tier) => tier === rawGraphics['tierOverride']) ?? null,
      renderScaleOverride,
      post: post as Readonly<Record<PostEffect, PostOverride>>,
    },
    accessibility: {
      reducedMotion: pick(PREFERENCE_MODES, rawAccess['reducedMotion'], 'system'),
      reducedFlashing: bool(rawAccess['reducedFlashing'], false),
      shapeCuesForDamage: bool(rawAccess['shapeCuesForDamage'], false),
    },
    controls: {
      holdToThrow: bool(rawControls['holdToThrow'], false),
      bindings: {
        keyboard: keyboard as Readonly<Record<ActionId, readonly InputCode[]>>,
        gamepad: gamepad as Readonly<Record<ActionId, readonly number[]>>,
      },
    },
    audio: audio as AudioSettings,
  };
}

/* ---------------------------------------------------------------------------- resolution */

function overriddenPost(
  tierPost: PostToggles,
  overrides: Readonly<Record<PostEffect, PostOverride>>,
): PostToggles {
  const requested: Record<PostEffect, boolean> = { ...tierPost };
  for (const effect of POST_EFFECTS) {
    const override = overrides[effect];
    if (override === 'on') requested[effect] = true;
    else if (override === 'off') requested[effect] = false;
  }
  return requested;
}

/** A rung the player picked is only honoured inside the tier's own dynamic-resolution window. */
function overriddenRenderScale(budget: QualityBudget, override: number | null): number {
  if (override === null) return budget.renderScale;
  if (!RENDER_SCALE_LADDER.includes(override)) return budget.renderScale;
  if (override < budget.renderScaleMin || override > budget.renderScaleMax) return budget.renderScale;
  return override;
}

/**
 * The single place player choice meets device reality. Every override is layered ON TOP of
 * `resolveTier` and then pushed back through `resolvePostChain`, so the compute gate, the
 * reduced-motion gate and the "something must still upscale and anti-alias" repairs are
 * applied by Quality's own code rather than reimplemented here.
 */
export function resolveWithSettings(caps: DeviceCaps, settings: SettingsState): QualityResolution {
  const reducedMotion = caps.prefersReducedMotion || settings.accessibility.reducedMotion === 'on';
  const gatedCaps: DeviceCaps = { ...caps, prefersReducedMotion: reducedMotion };
  const base = resolveTier(gatedCaps, settings.graphics.tierOverride);

  const budget: QualityBudget = {
    ...base.budget,
    renderScale: overriddenRenderScale(base.budget, settings.graphics.renderScaleOverride),
    post: overriddenPost(base.budget.post, settings.graphics.post),
  };

  return { ...base, budget, post: resolvePostChain(budget, reducedMotion, gatedCaps) };
}

/**
 * Reduced flashing is a MOTION-axis veto, so it is expressed the way the motion axis already
 * expresses everything: as a MotionRules row. Systems keep reading `motionRules` and never
 * learn that a settings toggle exists.
 */
export function effectiveMotionRules(
  resolution: QualityResolution,
  settings: SettingsState,
): MotionRules {
  const rules = MOTION[resolution.motion];
  if (!settings.accessibility.reducedFlashing) return rules;
  return { ...rules, allowScreenFlash: false, allowChromaticPulse: false };
}

/* ----------------------------------------------------------------------------- application */

/** What a settings change is allowed to reach. Every port is optional and structurally typed. */
export interface MotionPort {
  setTier(tier: Tier): void;
  setReducedMotion(on: boolean): void;
}

export interface AudioPort {
  setBusVolume(bus: AudioBusId, volume: number): void;
  setBusMuted(bus: AudioBusId, muted: boolean): void;
}

export interface SettingsPorts {
  /** `ui/Motion.MotionDirector` satisfies this structurally. */
  readonly motion?: MotionPort | undefined;
  /** `audio/Audio.AudioEngine` satisfies this structurally. */
  readonly audio?: AudioPort | undefined;
  /** Defaults to `document.documentElement`. Null in a non-DOM test. */
  readonly root?: HTMLElement | null | undefined;
  /** The renderer subscribes here to rebuild its post chain when the tier changes. */
  readonly onQuality?: ((resolution: QualityResolution) => void) | undefined;
}

const onOff = (value: boolean): string => (value ? 'on' : 'off');

function resolveRoot(ports: SettingsPorts): HTMLElement | null {
  if (ports.root !== undefined) return ports.root;
  return typeof document === 'undefined' ? null : document.documentElement;
}

/**
 * Writes the resolved settings onto the tokens the rest of the game already reads.
 * `data-reduced-motion` is not a new attribute invented here - it is the one ui/Motion.ts
 * watches with a MutationObserver, which is why a change lands without a reload.
 */
export function applySettings(
  settings: SettingsState,
  caps: DeviceCaps,
  ports: SettingsPorts = {},
): QualityResolution {
  const resolution = resolveWithSettings(caps, settings);

  const root = resolveRoot(ports);
  if (root !== null) {
    root.dataset['graphicsTier'] = resolution.graphics;
    root.dataset['motionTier'] = resolution.motion;
    root.dataset['reducedMotion'] = onOff(resolution.reducedMotion);
    root.dataset['reducedFlashing'] = onOff(settings.accessibility.reducedFlashing);
    root.dataset['shapeCues'] = onOff(settings.accessibility.shapeCuesForDamage);
    root.dataset['holdToThrow'] = onOff(settings.controls.holdToThrow);
  }

  ports.motion?.setTier(resolution.graphics);
  ports.motion?.setReducedMotion(resolution.reducedMotion);

  const audio = ports.audio;
  if (audio !== undefined) {
    for (const bus of AUDIO_BUS_IDS) {
      const setting = settings.audio[bus];
      audio.setBusVolume(bus, setting.volume);
      audio.setBusMuted(bus, setting.muted);
    }
  }

  ports.onQuality?.(resolution);
  return resolution;
}

/* --------------------------------------------------------------------------------- store */

export interface SettingsChange {
  readonly state: SettingsState;
  readonly resolution: QualityResolution;
  readonly conflicts: readonly BindingConflict[];
}

interface SettingsEvents {
  'settings:changed': SettingsChange;
}

/**
 * The live settings object. Applies on every mutation and persists on a debounce, because a
 * dragged slider is a hundred mutations and one meaningful write.
 */
export class SettingsStore {
  private current: SettingsState;
  private resolved: QualityResolution;
  private readonly bus = new Emitter<SettingsEvents>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    state: SettingsState,
    private caps: DeviceCaps,
    private readonly ports: SettingsPorts = {},
    private readonly db: SaveDb | null = null,
  ) {
    this.current = state;
    this.resolved = applySettings(state, caps, ports);
  }

  /** Reads the saved row, normalises it and applies it before the first frame is drawn. */
  static async load(
    db: SaveDb | null,
    caps: DeviceCaps,
    ports: SettingsPorts = {},
  ): Promise<SettingsStore> {
    const record = db === null ? undefined : await db.loadSettingsRecord();
    return new SettingsStore(normalizeSettings(record?.state), caps, ports, db);
  }

  get state(): SettingsState {
    return this.current;
  }

  get resolution(): QualityResolution {
    return this.resolved;
  }

  get conflicts(): readonly BindingConflict[] {
    return findBindingConflicts(this.current.controls.bindings);
  }

  subscribe(listener: (change: SettingsChange) => void): Unsubscribe {
    return this.bus.on('settings:changed', listener);
  }

  /** Device facts changed under us - a new monitor, or the OS motion preference flipped. */
  refreshCaps(caps: DeviceCaps): void {
    this.caps = caps;
    this.reapply();
  }

  setTierOverride(tier: Tier | null): void {
    this.mutate({ ...this.current, graphics: { ...this.current.graphics, tierOverride: tier } });
  }

  setRenderScaleOverride(scale: number | null): void {
    this.mutate({
      ...this.current,
      graphics: { ...this.current.graphics, renderScaleOverride: scale },
    });
  }

  setPostOverride(effect: PostEffect, override: PostOverride): void {
    this.mutate({
      ...this.current,
      graphics: {
        ...this.current.graphics,
        post: { ...this.current.graphics.post, [effect]: override },
      },
    });
  }

  setReducedMotion(mode: PreferenceMode): void {
    this.mutate({
      ...this.current,
      accessibility: { ...this.current.accessibility, reducedMotion: mode },
    });
  }

  setReducedFlashing(on: boolean): void {
    this.mutate({
      ...this.current,
      accessibility: { ...this.current.accessibility, reducedFlashing: on },
    });
  }

  setShapeCuesForDamage(on: boolean): void {
    this.mutate({
      ...this.current,
      accessibility: { ...this.current.accessibility, shapeCuesForDamage: on },
    });
  }

  setHoldToThrow(on: boolean): void {
    this.mutate({ ...this.current, controls: { ...this.current.controls, holdToThrow: on } });
  }

  setBusVolume(bus: AudioBusId, volume: number): void {
    this.mutate({
      ...this.current,
      audio: { ...this.current.audio, [bus]: { ...this.current.audio[bus], volume: unitScalar(volume, 0) } },
    });
  }

  setBusMuted(bus: AudioBusId, muted: boolean): void {
    this.mutate({
      ...this.current,
      audio: { ...this.current.audio, [bus]: { ...this.current.audio[bus], muted } },
    });
  }

  /**
   * Always applies. Returns the conflicts the new mapping creates so the row can show them -
   * see rule 3 in the file header: refusing the rebind is what strands a player.
   */
  rebindKeys(action: ActionId, codes: readonly InputCode[]): readonly BindingConflict[] {
    const bindings: Bindings = {
      ...this.current.controls.bindings,
      keyboard: { ...this.current.controls.bindings.keyboard, [action]: [...codes] },
    };
    this.mutate({ ...this.current, controls: { ...this.current.controls, bindings } });
    return this.conflicts;
  }

  rebindButtons(action: ActionId, buttons: readonly number[]): readonly BindingConflict[] {
    const bindings: Bindings = {
      ...this.current.controls.bindings,
      gamepad: { ...this.current.controls.bindings.gamepad, [action]: [...buttons] },
    };
    this.mutate({ ...this.current, controls: { ...this.current.controls, bindings } });
    return this.conflicts;
  }

  resetBindings(): void {
    this.mutate({
      ...this.current,
      controls: { ...this.current.controls, bindings: DEFAULT_BINDINGS },
    });
  }

  resetAll(): void {
    this.mutate(defaultSettings());
  }

  /** Forces the pending write out now. Call before unload and in tests. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.persistNow();
    }
    await this.writing;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.bus.clear();
  }

  private mutate(next: SettingsState): void {
    this.current = next;
    this.reapply();
    this.schedulePersist();
  }

  private reapply(): void {
    this.resolved = applySettings(this.current, this.caps, this.ports);
    this.bus.emit('settings:changed', {
      state: this.current,
      resolution: this.resolved,
      conflicts: this.conflicts,
    });
  }

  private schedulePersist(): void {
    if (this.db === null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.persistNow();
    }, SETTINGS_TOKENS.persistDebounceMs);
  }

  private persistNow(): void {
    const db = this.db;
    if (db === null) return;
    const snapshot = this.current;
    // Chained rather than parallel: two overlapping writes of the same singleton row can
    // land out of order, and the loser would silently become the saved settings.
    this.writing = this.writing.then(() => db.saveSettings(snapshot)).catch(() => {
      // A failed settings write must never take down the frame that triggered it. The next
      // change retries, and the in-memory state the player is looking at is already correct.
    });
  }
}
