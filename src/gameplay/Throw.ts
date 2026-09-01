/**
 * AIMING AND THROWING.
 *
 * Three input paths, one aim state. Pointer aiming is ABSOLUTE (the cursor is the crosshair),
 * touch aiming is RELATIVE (drag moves the crosshair, release throws) and stick aiming is
 * RATE-BASED (deflection is a velocity, integrated on the fixed step). They are genuinely
 * different mappings and collapsing them into one would make two of the three feel wrong -
 * an absolute stick is unusable and a relative mouse fights the cursor.
 *
 * Everything that changes the world happens in `fixedUpdate`: input only ever queues a
 * request. That is what keeps a throw reproducible at 30fps, at 144fps and under slow-motion
 * frame skipping, because the throw lands on a step boundary rather than on a frame boundary.
 *
 * The preview arc is the exception, and deliberately so: it is presentation, it is recomputed
 * in `frame` from the live camera pose, and it integrates the SAME ballistic that the throw
 * itself hands to the physics body. If those two ever disagree the preview is a lie.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Line,
  LineBasicNodeMaterial,
  Vector3,
  type Camera,
} from 'three/webgpu';
import { attribute, uniform } from 'three/tsl';
import { FIXED_STEP_MS } from '../core/Quality';
import type { Alpha, Millis, Tickable, Unit } from '../core/types';
import { Ammo, Emitter, type Listener, type Unsubscribe } from './Ammo';
import type { BallId, BallPool } from './Ball';

export type ThrowMode = 'single' | 'triple';

export const THROW_BALANCE = Object.freeze({
  /** Fast enough that the arc reads as flat inside the corridor, slow enough to be dodged. */
  muzzleSpeedMps: 32,
  /** Muzzle offset from the camera, in camera space. Below the eye line so it never occludes. */
  muzzleForwardM: 0.45,
  muzzleDownM: 0.16,
  muzzleRightM: 0.1,
  /** Floor on the gap between throws. Without it a held mouse button empties the run. */
  cooldownMs: 90,
  /** Radius of the aim cone in NDC. Past this the throw leaves the corridor mouth. */
  maxAimNdc: 0.86,
  /**
   * Distance at which the throw converges on the reticle. The muzzle sits below and ahead of
   * the eye, so a ray fired parallel to the camera's would run permanently under the
   * crosshair and never cross it; aiming at a point on the crosshair ray instead makes the
   * reticle truthful at roughly the range panes arrive at.
   */
  aimConvergenceM: 14,
  stickDeadzone: 0.14,
  /** NDC per second at full stick deflection. */
  stickRatePerSec: 2.0,
  /** Screen fractions to NDC for a touch drag; >1 so the thumb travels less than the reticle. */
  dragGain: 2.2,
  triple: Object.freeze({
    count: 3,
    /** Total fan half-angle, radians. Wide enough to catch two panes, tight enough to aim. */
    spreadRad: 0.065,
    /**
     * A triple shot costs ONE throw, not three. The discount is the entire reward of the
     * pickup; charging per projectile would make it a punishment with a particle effect.
     */
    costThrows: 1,
    durationMs: 9000,
  }),
  preview: Object.freeze({
    samples: 22,
    stepMs: 45,
    /** Tail fades out; the arc must suggest a direction, not draw a rope. */
    fadePower: 1.7,
    opacity: 0.55,
  }),
});

export type ThrowRefusal = 'cooldown' | 'no-ammo';

export type ThrowEvent =
  | {
      readonly kind: 'throw';
      readonly mode: ThrowMode;
      /** One per projectile. Length is 1 for single, THROW_BALANCE.triple.count for triple. */
      readonly ids: readonly BallId[];
      readonly ballsRemaining: number;
    }
  | { readonly kind: 'refused'; readonly reason: ThrowRefusal }
  | { readonly kind: 'mode'; readonly mode: ThrowMode };

export interface ThrowControllerOptions {
  readonly camera: Camera;
  readonly pool: BallPool;
  readonly ammo: Ammo;
  /** Start with the arc hidden on desktop, shown on touch; the caller knows which. */
  readonly previewVisible?: boolean;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Deadzone that rescales the remaining range, so the stick does not jump on entry. */
function applyDeadzone(value: number, deadzone: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  const scaled = (magnitude - deadzone) / (1 - deadzone);
  return value < 0 ? -scaled : scaled;
}

/**
 * The arc. Owns its own geometry and material so nothing outside can desynchronise it from
 * the ballistic, and fades along its length through a plain vertex attribute rather than a
 * texture - one buffer, one draw, no atlas.
 */
class TrajectoryPreview {
  readonly object: Line<BufferGeometry, LineBasicNodeMaterial>;

  private readonly positions: Float32Array;
  private readonly positionAttribute: BufferAttribute;
  private readonly strength = uniform(THROW_BALANCE.preview.opacity).setName('throwPreviewOpacity');

  constructor() {
    const { samples, fadePower } = THROW_BALANCE.preview;
    this.positions = new Float32Array(samples * 3);
    const fade = new Float32Array(samples);
    for (let i = 0; i < samples; i += 1) {
      fade[i] = Math.pow(1 - i / (samples - 1), fadePower);
    }

    const geometry = new BufferGeometry();
    // BufferAttribute, not Float32BufferAttribute: the latter copies the array it is handed,
    // which would leave `this.positions` writing into a buffer the GPU never sees.
    this.positionAttribute = new BufferAttribute(this.positions, 3);
    this.positionAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('arcFade', new BufferAttribute(fade, 1));

    const material = new LineBasicNodeMaterial();
    material.name = 'throw-preview-arc';
    material.transparent = true;
    material.depthWrite = false;
    // Guidance must stay readable at the far end of the corridor, so the haze does not
    // touch it - the same exemption the ball's hotspot gets, for the same reason.
    material.fog = false;
    material.opacityNode = attribute<'float'>('arcFade', 'float').mul(this.strength);

    this.object = new Line(geometry, material);
    this.object.name = 'throw-preview';
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
  }

  set visible(value: boolean) {
    this.object.visible = value;
  }

  get visible(): boolean {
    return this.object.visible;
  }

  setOpacity(value: Unit): void {
    this.strength.value = clamp01(value) * THROW_BALANCE.preview.opacity;
  }

  /** Integrates the same p(t) = p0 + v*t + g*t^2/2 the thrown body will follow. */
  update(origin: Vector3, velocity: Vector3, gravityY: number): void {
    const { samples, stepMs } = THROW_BALANCE.preview;
    for (let i = 0; i < samples; i += 1) {
      const t = (i * stepMs) / 1000;
      const base = i * 3;
      this.positions[base] = origin.x + velocity.x * t;
      this.positions[base + 1] = origin.y + velocity.y * t + 0.5 * gravityY * t * t;
      this.positions[base + 2] = origin.z + velocity.z * t;
    }
    this.positionAttribute.needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.object.material.dispose();
  }
}

export class ThrowController implements Tickable {
  /** Add `preview.object` to the scene; the controller never touches the scene graph itself. */
  readonly preview = new TrajectoryPreview();

  private readonly events = new Emitter<ThrowEvent>();
  private readonly camera: Camera;
  private readonly pool: BallPool;
  private readonly ammo: Ammo;

  private readonly aim = { x: 0, y: 0 };
  private readonly stick = { x: 0, y: 0 };
  private readonly drag = { active: false, lastX: 0, lastY: 0, pointerId: -1 };

  private readonly aimDirection = new Vector3();
  private readonly muzzle = new Vector3();
  private readonly muzzleVelocity = new Vector3();
  private readonly cameraForward = new Vector3();
  private readonly cameraRight = new Vector3();
  private readonly cameraUp = new Vector3();
  private readonly focusPoint = new Vector3();
  private readonly scratch = new Vector3();

  private mode: ThrowMode = 'single';
  private modeRemainingMs: Millis = 0;
  private cooldownMs: Millis = 0;
  private queuedThrows = 0;

  constructor(options: ThrowControllerOptions) {
    this.camera = options.camera;
    this.pool = options.pool;
    this.ammo = options.ammo;
    this.preview.visible = options.previewVisible ?? false;
  }

  get aimNdcX(): number {
    return this.aim.x;
  }

  get aimNdcY(): number {
    return this.aim.y;
  }

  get throwMode(): ThrowMode {
    return this.mode;
  }

  /** Fraction of the triple-shot window still to run, for the HUD's powerup meter. */
  get modeRemaining(): Unit {
    if (this.mode === 'single') return 0;
    return clamp01(this.modeRemainingMs / THROW_BALANCE.triple.durationMs);
  }

  on(listener: Listener<ThrowEvent>): Unsubscribe {
    return this.events.on(listener);
  }

  /** Absolute aim, in normalised device coordinates. The pointer path. */
  aimAt(ndcX: number, ndcY: number): void {
    this.aim.x = ndcX;
    this.aim.y = ndcY;
    this.clampAim();
  }

  /** Relative aim. The touch-drag path, and anything else that thinks in deltas. */
  aimBy(deltaNdcX: number, deltaNdcY: number): void {
    this.aim.x += deltaNdcX;
    this.aim.y += deltaNdcY;
    this.clampAim();
  }

  /** Stick deflection in [-1,1]. Integrated on the fixed step, not here. */
  setStick(x: number, y: number): void {
    this.stick.x = applyDeadzone(x, THROW_BALANCE.stickDeadzone);
    this.stick.y = applyDeadzone(y, THROW_BALANCE.stickDeadzone);
  }

  centreAim(): void {
    this.aim.x = 0;
    this.aim.y = 0;
  }

  /** Queues one throw for the next fixed step. Extra requests inside a step are dropped. */
  requestThrow(): void {
    this.queuedThrows = 1;
  }

  /** Grants the triple-shot powerup. Re-granting refreshes the window rather than stacking. */
  setMode(mode: ThrowMode, durationMs: Millis = THROW_BALANCE.triple.durationMs): void {
    const changed = this.mode !== mode;
    this.mode = mode;
    this.modeRemainingMs = mode === 'single' ? 0 : durationMs;
    if (changed) this.events.emit({ kind: 'mode', mode });
  }

  /**
   * Wires pointer input on the canvas. Mouse and pen aim absolutely and throw on press;
   * touch drags to aim and throws on release, which is the only mapping that leaves the
   * thumb somewhere useful on a phone.
   */
  attachPointer(element: HTMLElement): Unsubscribe {
    const toNdc = (event: PointerEvent): { x: number; y: number } => {
      const rect = element.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
      };
    };

    const onDown = (event: PointerEvent): void => {
      element.setPointerCapture(event.pointerId);
      if (event.pointerType === 'touch') {
        this.drag.active = true;
        this.drag.pointerId = event.pointerId;
        this.drag.lastX = event.clientX;
        this.drag.lastY = event.clientY;
        this.preview.visible = true;
        return;
      }
      const ndc = toNdc(event);
      this.aimAt(ndc.x, ndc.y);
      this.requestThrow();
    };

    const onMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        if (!this.drag.active || event.pointerId !== this.drag.pointerId) return;
        const rect = element.getBoundingClientRect();
        const dx = ((event.clientX - this.drag.lastX) / rect.width) * 2 * THROW_BALANCE.dragGain;
        const dy = -((event.clientY - this.drag.lastY) / rect.height) * 2 * THROW_BALANCE.dragGain;
        this.drag.lastX = event.clientX;
        this.drag.lastY = event.clientY;
        this.aimBy(dx, dy);
        return;
      }
      const ndc = toNdc(event);
      this.aimAt(ndc.x, ndc.y);
    };

    const onUp = (event: PointerEvent): void => {
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      if (event.pointerType !== 'touch') return;
      if (!this.drag.active || event.pointerId !== this.drag.pointerId) return;
      this.drag.active = false;
      this.drag.pointerId = -1;
      this.requestThrow();
    };

    const onCancel = (event: PointerEvent): void => {
      if (event.pointerId !== this.drag.pointerId) return;
      this.drag.active = false;
      this.drag.pointerId = -1;
    };

    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onCancel);

    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
    };
  }

  /**
   * Samples one gamepad. Called from fixedUpdate rather than from a frame callback so stick
   * aim integrates at the simulation rate and does not drift with the presentation rate.
   */
  pollGamepad(index = 0): void {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const pad = navigator.getGamepads()[index];
    if (pad === null || pad === undefined) return;
    const axisX = pad.axes[0];
    const axisY = pad.axes[1];
    if (axisX !== undefined && axisY !== undefined) this.setStick(axisX, -axisY);
    const trigger = pad.buttons[7];
    if (trigger !== undefined && trigger.pressed) this.requestThrow();
  }

  fixedUpdate(dt: Millis): void {
    if (this.cooldownMs > 0) this.cooldownMs -= dt;

    if (this.stick.x !== 0 || this.stick.y !== 0) {
      const step = (THROW_BALANCE.stickRatePerSec * dt) / 1000;
      this.aimBy(this.stick.x * step, this.stick.y * step);
    }

    if (this.mode === 'triple') {
      this.modeRemainingMs -= dt;
      if (this.modeRemainingMs <= 0) this.setMode('single');
    }

    if (this.queuedThrows > 0) {
      this.queuedThrows = 0;
      this.fire();
    }
  }

  frame(alpha: Alpha): void {
    if (!this.preview.visible) return;
    // Stick aim only advances on the fixed step, so at a presentation rate above 60Hz the
    // arc would visibly trail the reticle. Leading it by the fraction of a step already
    // elapsed is the same interpolation the renderer applies to every other moving thing.
    this.resolveAim(FIXED_STEP_MS * clamp01(alpha));
    this.preview.update(this.muzzle, this.muzzleVelocity, this.pool.gravityY);
  }

  reset(): void {
    this.centreAim();
    this.stick.x = 0;
    this.stick.y = 0;
    this.drag.active = false;
    this.drag.pointerId = -1;
    this.queuedThrows = 0;
    this.cooldownMs = 0;
    this.mode = 'single';
    this.modeRemainingMs = 0;
  }

  dispose(): void {
    this.events.clear();
    this.preview.dispose();
  }

  private fire(): void {
    if (this.cooldownMs > 0) {
      this.events.emit({ kind: 'refused', reason: 'cooldown' });
      return;
    }
    const cost = this.mode === 'triple' ? THROW_BALANCE.triple.costThrows : 1;
    if (!this.ammo.spendForThrow(cost)) {
      this.events.emit({ kind: 'refused', reason: 'no-ammo' });
      return;
    }

    this.resolveAim(0);
    const count = this.mode === 'triple' ? THROW_BALANCE.triple.count : 1;
    const ids: BallId[] = [];

    for (let i = 0; i < count; i += 1) {
      // Fan about the camera's up axis so the spread stays horizontal however the corridor
      // rolls the camera - a spread in screen space would tilt with the roll and read wrong.
      const offset = count === 1 ? 0 : (i / (count - 1) - 0.5) * 2 * THROW_BALANCE.triple.spreadRad;
      this.scratch.copy(this.aimDirection);
      if (offset !== 0) this.scratch.applyAxisAngle(this.cameraUp, offset);
      this.scratch.multiplyScalar(THROW_BALANCE.muzzleSpeedMps);
      const id = this.pool.spawn(this.muzzle, this.scratch);
      if (id !== null) ids.push(id);
    }

    this.cooldownMs = THROW_BALANCE.cooldownMs;
    this.events.emit({
      kind: 'throw',
      mode: this.mode,
      ids,
      ballsRemaining: this.ammo.balls,
    });
  }

  /**
   * Rebuilds the muzzle transform and the aim ray from the camera's current world pose.
   * `leadMs` pushes the aim forward along the stick so the preview does not lag the reticle.
   */
  private resolveAim(leadMs: Millis): void {
    // The camera may have been moved by the corridor in this same step; unproject reads
    // matrixWorld directly, so a stale matrix would aim at where the player used to be.
    this.camera.updateMatrixWorld();
    this.cameraRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.cameraUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.cameraForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);

    let ndcX = this.aim.x;
    let ndcY = this.aim.y;
    if (leadMs > 0 && (this.stick.x !== 0 || this.stick.y !== 0)) {
      const lead = (THROW_BALANCE.stickRatePerSec * leadMs) / 1000;
      ndcX += this.stick.x * lead;
      ndcY += this.stick.y * lead;
    }

    this.muzzle
      .copy(this.camera.position)
      .addScaledVector(this.cameraForward, THROW_BALANCE.muzzleForwardM)
      .addScaledVector(this.cameraUp, -THROW_BALANCE.muzzleDownM)
      .addScaledVector(this.cameraRight, THROW_BALANCE.muzzleRightM);

    // Unprojecting the reticle gives the exact ray the player is pointing along, including
    // the projection's own distortion at the edges of a wide fov. The subtraction is against
    // the CAMERA, not the muzzle: the unprojected point lies on the camera's ray at some
    // arbitrary depth, so only that difference is a valid direction.
    this.aimDirection.set(ndcX, ndcY, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    this.focusPoint
      .copy(this.camera.position)
      .addScaledVector(this.aimDirection, THROW_BALANCE.aimConvergenceM);
    this.aimDirection.copy(this.focusPoint).sub(this.muzzle).normalize();
    this.muzzleVelocity.copy(this.aimDirection).multiplyScalar(THROW_BALANCE.muzzleSpeedMps);
  }

  private clampAim(): void {
    const limit = THROW_BALANCE.maxAimNdc;
    const lengthSq = this.aim.x * this.aim.x + this.aim.y * this.aim.y;
    if (lengthSq <= limit * limit) return;
    const scale = limit / Math.sqrt(lengthSq);
    this.aim.x *= scale;
    this.aim.y *= scale;
  }
}
