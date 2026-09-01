/**
 * THE SHATTER RUNTIME.
 *
 * ============================ THREE-FRAME STAGING ============================
 * A pane breaking is not one event, it is three, and collapsing them is the difference
 * between glass and confetti:
 *
 *   1. FLASH     - a couple of fixed steps in which the pane is still WHOLE and the impact
 *                  point blows out. The player sees the hit register before anything moves.
 *   2. HIT-STOP  - the world holds. Implemented as a FRAMES-TO-SKIP COUNTER: `fixedUpdate`
 *                  spends one unit of the counter and returns, leaving `dt` untouched. It is
 *                  never a scaled timestep, because a scaled timestep makes the simulation
 *                  non-reproducible and every replay and export in this project assumes the
 *                  step is a constant. The chromatic split is pinned at its peak here, which
 *                  costs nothing precisely because the sim is not advancing.
 *   3. RELEASE   - shards let go, staggered outward from the impact so the fracture READS as
 *                  travelling through the pane rather than the pane ceasing to exist.
 *
 * ====================== WHY THE BASE STATE IS THE BROKEN ONE ======================
 * The obvious authoring is `t: 0 = intact -> 1 = scattered`. It is wrong, and the reason is
 * export. Anything that freezes this system without running its animation - a still-frame
 * grab, a thumbnail pass, a keyframe editor scrubbed to zero, a reduced-motion path that
 * skips the tween - lands on the DEFAULT value of the animated quantity. With that authoring
 * the default is 0 and every export shows the pane snapping back together, whole, which is
 * the one image the game must never produce.
 *
 * So it is inverted. Each shard's BASE (rest, default, zero) transform is its RELEASED one:
 * ejected, tumbled, gone. The animated quantity is `bond` - how much of the UNBROKEN pane is
 * still being imposed on the shard - and the keyframe drives it FROM 1 (pane whole) DOWN TO
 * 0 (base). `bond` lives in a Float32Array, which JavaScript zero-fills, so an uninitialised,
 * unticked, frozen or half-restored runtime shows the shatter RESOLVED. `shatter()` is the
 * only thing that ever writes a 1, and it writes it deliberately.
 * ==================================================================================
 */

import type { Rng } from '../battle/types';
import { createRng } from '../battle/types';
import type { QualityResolution } from '../core/Quality';
import type { Frames, Millis, Pausable, Tickable, Unit } from '../core/types';
import type { Pane, PaneBake } from './Panes';
import { paneLocalToWorld } from './Panes';
import type { Vec2 } from './Voronoi';

/** Position (3) + orientation quaternion (4). */
export const SHARD_POSE_STRIDE = 7;
/** Linear velocity (3) + angular velocity (3). */
export const SHARD_VELOCITY_STRIDE = 6;
/** Position (3) + quaternion (4) + bond weight (1), the layout the vertex stage reads. */
export const SHARD_TRANSFORM_STRIDE = 8;

const MS_PER_SECOND = 1000;

/**
 * Staging law. Like the timeline laws in battle/types.ts these describe FEEL and are the
 * same on every machine, so they belong with the contract they constrain rather than in
 * core/Quality.ts - which owns everything that varies with hardware: how many shards may be
 * alive, how long they live, and (through `motionRules.slowMoFrameSkip`) how many frames the
 * hit-stop is allowed to steal.
 *
 * Counted in FIXED STEPS, never milliseconds. A shatter that lasts a different number of
 * simulation steps on a 30fps tier is a different shatter.
 */
export const SHATTER_STAGING = Object.freeze({
  /** Steps the pane stays whole and blown out after the impact registers. */
  flashFrames: 2,
  /** Steps one shard takes to travel from the pane plane to its released base. */
  releaseFrames: 9,
  /** Spread of per-shard release delay across the pane, rim relative to impact. */
  staggerFrames: 15,
  /** Steps the chromatic split takes to fall back to nothing after the hold ends. */
  chromaticFrames: 10,
  /** Steps the impact flash takes to fall back to nothing. */
  flashDecayFrames: 6,
});

/** Physical constants for the fallback integrator. Not budgets - metres, seconds, newtons. */
export const SHARD_DYNAMICS = Object.freeze({
  gravity: 9.81,
  /** Fraction of velocity retained per second. Glass is light and sheds speed quickly. */
  linearRetentionPerSecond: 0.34,
  angularRetentionPerSecond: 0.5,
  /** Sideways spread of the ejection cone, relative to the pane normal. */
  lateralSpread: 0.55,
  /** Per-shard random scaling of the ejection speed, so no two shards travel together. */
  speedJitterMin: 0.7,
  speedJitterMax: 1.35,
  /** Energy kept when a shard meets the corridor floor. Glass skitters, it does not bounce. */
  restitution: 0.22,
});

/** Rng sub-stream for ejection. Fixed so adding a draw here never moves the fracture. */
const STREAM_EJECT = 0x2f3;

export type ShatterPhase = 'flash' | 'hitstop' | 'release' | 'settling';

/**
 * The pooled rigid bodies shards borrow. Implemented here by `createBallisticShardPool` and
 * expected to be implemented again, identically, by the Rapier-backed pool when collision is
 * wired up - the runtime never learns which one it has. Slots are integer indices into the
 * pool's own flat arrays; nothing per-shard is ever allocated on a shatter.
 */
export interface ShardPool {
  readonly capacity: number;
  readonly liveCount: number;
  /** A free slot, or -1 when the pool is exhausted. */
  acquire(): number;
  release(slot: number): void;
  /** Places the body at its RELEASED base pose and hands it the motion it leaves with. */
  launch(
    slot: number,
    pose: Float32Array,
    poseOffset: number,
    velocity: Float32Array,
    velocityOffset: number,
  ): void;
  /** One fixed step. Never called while the hit-stop counter is unspent. */
  step(dt: Millis): void;
  readPose(slot: number, out: Float32Array, outOffset: number): void;
  reset(): void;
}

/**
 * What the post chain reads. These are ENVELOPES in [0,1]; the amplitude they are multiplied
 * by belongs to Quality's `postIntensity`, so a tier can dial the chromatic split without
 * touching the staging and the staging cannot smuggle in a magnitude.
 */
export interface ShatterPresentation {
  readonly flash: Unit;
  readonly chromaticSplit: Unit;
  readonly hitStopFramesRemaining: Frames;
}

/** One in-flight shatter. The renderer draws `bake.geometry` with `baseShard` as its offset. */
export interface ShatterEvent {
  readonly pane: Pane;
  readonly bake: PaneBake;
  readonly phase: ShatterPhase;
  /** Index of this event's first shard in `ShatterRuntime.shardTransforms`. */
  readonly baseShard: number;
  readonly shardCount: number;
}

/**
 * A crazed pane needs no shards and no physics: its cells stay put, parted by a fixed gap.
 * That gap is a single uniform the vertex stage applies along each shard's own pivot ray, so
 * a laminated pane can stand cracked for the rest of the run at the cost of one float.
 */
export interface CrazedPane {
  readonly pane: Pane;
  readonly bake: PaneBake;
  /** 1 - bondFloor. Feed it to the pane material's craze uniform. */
  readonly crazeAmount: Unit;
}

export type ShatterResult =
  | { readonly kind: 'absorbed' }
  | { readonly kind: 'crazed'; readonly crazed: CrazedPane }
  | { readonly kind: 'shattered'; readonly event: ShatterEvent };

const ABSORBED: ShatterResult = Object.freeze({ kind: 'absorbed' as const });

/**
 * See the note in Voronoi.ts: `noUncheckedIndexedAccess` widens every indexed read to
 * `number | undefined`, and every index below is derived from a length checked in the same
 * scope. Stated once here instead of at every subscript in the per-shard loops.
 */
const f = (buffer: Float32Array, index: number): number => buffer[index] as number;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------------------
// Fallback pool
// ---------------------------------------------------------------------------------------

export interface BallisticPoolOptions {
  readonly capacity: number;
  readonly gravity: number;
  readonly linearRetentionPerSecond: number;
  readonly angularRetentionPerSecond: number;
  /** World height shards come to rest on. Corridor-owned; the pool only needs the number. */
  readonly floorY: number;
  readonly restitution: number;
}

/**
 * Options wired to the module's physical constants, so a caller only has to say how many
 * bodies it wants and where the corridor floor is.
 */
export function defaultBallisticPoolOptions(capacity: number, floorY: number): BallisticPoolOptions {
  return {
    capacity,
    floorY,
    gravity: SHARD_DYNAMICS.gravity,
    linearRetentionPerSecond: SHARD_DYNAMICS.linearRetentionPerSecond,
    angularRetentionPerSecond: SHARD_DYNAMICS.angularRetentionPerSecond,
    restitution: SHARD_DYNAMICS.restitution,
  };
}

/**
 * The guaranteed shard integrator. It is not a stub and not a placeholder: a WebGL-fallback
 * device that never finishes loading the physics WASM still has to show a shatter, so the
 * baseline path is analytic ballistics with a floor plane. Fixed step in, deterministic
 * poses out, no allocation after construction.
 */
export function createBallisticShardPool(options: BallisticPoolOptions): ShardPool {
  const { capacity } = options;
  const pose = new Float32Array(capacity * SHARD_POSE_STRIDE);
  const velocity = new Float32Array(capacity * SHARD_VELOCITY_STRIDE);
  const free = new Int32Array(capacity);
  const inUse = new Uint8Array(capacity);
  let freeCount = capacity;
  let live = 0;

  const prime = (): void => {
    for (let i = 0; i < capacity; i += 1) free[i] = capacity - 1 - i;
    freeCount = capacity;
    live = 0;
    inUse.fill(0);
    pose.fill(0);
    velocity.fill(0);
    // Identity quaternion in every slot, so a slot read before launch is a valid pose.
    for (let i = 0; i < capacity; i += 1) pose[i * SHARD_POSE_STRIDE + 6] = 1;
  };
  prime();

  return {
    capacity,
    get liveCount(): number {
      return live;
    },
    acquire(): number {
      if (freeCount === 0) return -1;
      freeCount -= 1;
      const slot = free[freeCount] as number;
      inUse[slot] = 1;
      live += 1;
      return slot;
    },
    release(slot: number): void {
      if (slot < 0 || slot >= capacity || inUse[slot] === 0) return;
      inUse[slot] = 0;
      free[freeCount] = slot;
      freeCount += 1;
      live -= 1;
    },
    launch(slot, srcPose, poseOffset, srcVelocity, velocityOffset): void {
      if (slot < 0 || slot >= capacity) return;
      const p = slot * SHARD_POSE_STRIDE;
      for (let i = 0; i < SHARD_POSE_STRIDE; i += 1) pose[p + i] = f(srcPose, poseOffset + i);
      const v = slot * SHARD_VELOCITY_STRIDE;
      for (let i = 0; i < SHARD_VELOCITY_STRIDE; i += 1) velocity[v + i] = f(srcVelocity, velocityOffset + i);
    },
    step(dt: Millis): void {
      const s = dt / MS_PER_SECOND;
      // Retention is quoted per second; per step it is that raised to the step fraction, but
      // the step is a constant so the equivalent linear damp is exact enough and cheaper.
      const linear = 1 - (1 - options.linearRetentionPerSecond) * s;
      const angular = 1 - (1 - options.angularRetentionPerSecond) * s;
      const dv = options.gravity * s;

      for (let slot = 0; slot < capacity; slot += 1) {
        if (inUse[slot] === 0) continue;
        const p = slot * SHARD_POSE_STRIDE;
        const v = slot * SHARD_VELOCITY_STRIDE;

        let vx = f(velocity, v) * linear;
        let vy = f(velocity, v + 1) * linear - dv;
        let vz = f(velocity, v + 2) * linear;

        let py = f(pose, p + 1) + vy * s;
        if (py < options.floorY) {
          py = options.floorY;
          vy = -vy * options.restitution;
          vx *= options.restitution;
          vz *= options.restitution;
        }
        pose[p] = f(pose, p) + vx * s;
        pose[p + 1] = py;
        pose[p + 2] = f(pose, p + 2) + vz * s;
        velocity[v] = vx;
        velocity[v + 1] = vy;
        velocity[v + 2] = vz;

        const wx = f(velocity, v + 3) * angular;
        const wy = f(velocity, v + 4) * angular;
        const wz = f(velocity, v + 5) * angular;
        velocity[v + 3] = wx;
        velocity[v + 4] = wy;
        velocity[v + 5] = wz;

        const qx = f(pose, p + 3);
        const qy = f(pose, p + 4);
        const qz = f(pose, p + 5);
        const qw = f(pose, p + 6);
        const h = 0.5 * s;
        let nx = qx + h * (wx * qw + wy * qz - wz * qy);
        let ny = qy + h * (-wx * qz + wy * qw + wz * qx);
        let nz = qz + h * (wx * qy - wy * qx + wz * qw);
        let nw = qw + h * (-wx * qx - wy * qy - wz * qz);
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
        if (len > 0) {
          const inv = 1 / len;
          nx *= inv;
          ny *= inv;
          nz *= inv;
          nw *= inv;
        } else {
          nx = 0;
          ny = 0;
          nz = 0;
          nw = 1;
        }
        pose[p + 3] = nx;
        pose[p + 4] = ny;
        pose[p + 5] = nz;
        pose[p + 6] = nw;
      }
    },
    readPose(slot: number, out: Float32Array, outOffset: number): void {
      if (slot < 0 || slot >= capacity) return;
      const p = slot * SHARD_POSE_STRIDE;
      for (let i = 0; i < SHARD_POSE_STRIDE; i += 1) out[outOffset + i] = f(pose, p + i);
    },
    reset: prime,
  };
}

// ---------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------

interface EventRecord {
  readonly pane: Pane;
  readonly bake: PaneBake;
  phase: ShatterPhase;
  readonly baseShard: number;
  readonly shardCount: number;
  /** Fixed steps spent in the current phase. Hit-stop frames are not counted; they are skipped. */
  phaseFrames: number;
  ageMs: Millis;
}

export interface ShatterRuntimeOptions {
  readonly quality: QualityResolution;
  readonly pool: ShardPool;
}

export class ShatterRuntime implements Tickable, Pausable, ShatterPresentation {
  /**
   * Interleaved position, quaternion and bond weight per live shard, indexed globally. The
   * renderer binds this once as a storage buffer and offsets into it by `event.baseShard`.
   */
  readonly shardTransforms: Float32Array;

  private readonly quality: QualityResolution;
  private readonly pool: ShardPool;
  private readonly capacity: number;

  /** Pool slot per shard, or -1 when the shard is static because the pool ran dry. */
  private readonly slots: Int32Array;
  /**
   * How much of the unbroken pane is still imposed on the shard. ZERO-FILLED ON PURPOSE:
   * see the header. 0 is released, 1 is the intact pane, and only `shatter()` writes 1.
   */
  private readonly bond: Float32Array;
  private readonly bondPrev: Float32Array;
  private readonly bondFloor: Float32Array;
  /** Fixed steps this shard waits after release begins. This is the stagger. */
  private readonly releaseDelay: Float32Array;
  /** World-space pose the shard occupies inside the UNBROKEN pane. */
  private readonly assembled: Float32Array;
  private readonly curPose: Float32Array;
  private readonly prevPose: Float32Array;
  private readonly alive: Uint8Array;

  private readonly events: EventRecord[] = [];
  private ringHead = 0;
  private liveShards = 0;

  /** Unspent hit-stop. Decremented one per fixed step; `dt` is never touched. */
  private skipFrames: Frames = 0;
  private flashCounter = 0;
  private chromaticCounter = 0;
  private paused = false;

  private readonly scratchPose = new Float32Array(SHARD_POSE_STRIDE);
  private readonly scratchVelocity = new Float32Array(SHARD_VELOCITY_STRIDE);
  private readonly scratchWorld = new Float32Array(3);

  constructor(options: ShatterRuntimeOptions) {
    this.quality = options.quality;
    this.pool = options.pool;
    this.capacity = options.quality.budget.maxShardsLive;

    this.shardTransforms = new Float32Array(this.capacity * SHARD_TRANSFORM_STRIDE);
    this.slots = new Int32Array(this.capacity).fill(-1);
    this.bond = new Float32Array(this.capacity);
    this.bondPrev = new Float32Array(this.capacity);
    this.bondFloor = new Float32Array(this.capacity);
    this.releaseDelay = new Float32Array(this.capacity);
    this.assembled = new Float32Array(this.capacity * 3);
    this.curPose = new Float32Array(this.capacity * SHARD_POSE_STRIDE);
    this.prevPose = new Float32Array(this.capacity * SHARD_POSE_STRIDE);
    this.alive = new Uint8Array(this.capacity);

    // Identity orientation everywhere, so an untouched transform slot is a legal transform
    // rather than a degenerate zero quaternion that collapses the shard to a point.
    for (let i = 0; i < this.capacity; i += 1) {
      this.curPose[i * SHARD_POSE_STRIDE + 6] = 1;
      this.prevPose[i * SHARD_POSE_STRIDE + 6] = 1;
      this.shardTransforms[i * SHARD_TRANSFORM_STRIDE + 6] = 1;
    }
  }

  get flash(): Unit {
    if (!this.quality.motionRules.allowScreenFlash) return 0;
    return clamp01(this.flashCounter / SHATTER_STAGING.flashDecayFrames);
  }

  get chromaticSplit(): Unit {
    if (!this.quality.motionRules.allowChromaticPulse) return 0;
    return clamp01(this.chromaticCounter / SHATTER_STAGING.chromaticFrames);
  }

  get hitStopFramesRemaining(): Frames {
    return this.skipFrames;
  }

  get liveShardCount(): number {
    return this.liveShards;
  }

  get eventCount(): number {
    return this.events.length;
  }

  eventAt(index: number): ShatterEvent | null {
    return this.events[index] ?? null;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * The entry point. Registers the hit against the pane, and if it was fatal bakes the
   * fracture, borrows bodies and starts the staging. Returns a discriminated result rather
   * than null-or-event so the caller has to decide what an absorbed hit sounds like.
   */
  shatter(pane: Pane, impact: Vec2, energy: number): ShatterResult {
    // Quality's live-shard cap is the ONLY ceiling on a pane's cell count. When the field is
    // already full the ring evicts the oldest shatter - which the player has flown past -
    // rather than shrinking the one exploding in front of the camera into three chunks.
    const cellBudget = this.capacity;

    const outcome = pane.hit(energy);
    if (outcome === 'absorbed') return ABSORBED;

    const bake = pane.bakeFracture(impact, cellBudget, this.dispersalRadius(pane));
    if (bake === null) return ABSORBED;

    this.flashCounter = SHATTER_STAGING.flashDecayFrames;

    if (outcome === 'crazed') {
      // No shards, no bodies, no ring space: a crazed pane is one uniform on a static mesh.
      this.requestHitStop(pane);
      return { kind: 'crazed', crazed: { pane, bake, crazeAmount: 1 - pane.bondFloor } };
    }

    const baseShard = this.allocateBlock(bake.shardCount);
    if (baseShard < 0) return ABSORBED;

    this.armShards(pane, bake, baseShard);

    const record: EventRecord = {
      pane,
      bake,
      phase: 'flash',
      baseShard,
      shardCount: bake.shardCount,
      phaseFrames: 0,
      ageMs: 0,
    };
    this.events.push(record);
    return { kind: 'shattered', event: record };
  }

  fixedUpdate(dt: Millis): void {
    if (this.paused) return;

    // THE HIT-STOP. One unit of the counter per step, `dt` passed through untouched to the
    // pool on the steps that do run. Scaling dt here would desynchronise every replay.
    if (this.skipFrames > 0) {
      this.skipFrames -= 1;
      return;
    }

    this.prevPose.set(this.curPose);
    this.bondPrev.set(this.bond);

    this.pool.step(dt);

    if (this.flashCounter > 0) this.flashCounter -= 1;
    if (this.chromaticCounter > 0) this.chromaticCounter -= 1;

    for (let e = this.events.length - 1; e >= 0; e -= 1) {
      const event = this.events[e];
      if (event === undefined) continue;
      event.phaseFrames += 1;
      event.ageMs += dt;

      switch (event.phase) {
        case 'flash':
          if (event.phaseFrames >= SHATTER_STAGING.flashFrames) {
            event.phase = 'hitstop';
            event.phaseFrames = 0;
            this.requestHitStop(event.pane);
          }
          break;
        case 'hitstop':
          // The skip counter has already burned the hold; reaching here means it is spent.
          event.phase = 'release';
          event.phaseFrames = 0;
          break;
        case 'release':
          this.advanceBonds(event);
          if (event.phaseFrames > SHATTER_STAGING.staggerFrames + SHATTER_STAGING.releaseFrames) {
            event.phase = 'settling';
            event.phaseFrames = 0;
          }
          break;
        case 'settling':
          if (event.ageMs >= this.quality.budget.shardLifetimeMs) this.retireAt(e);
          break;
      }
    }

    this.readPoses();
  }

  /**
   * Interpolates the fixed-step state for the frame being drawn and writes the transform the
   * renderer consumes. The blend is `mix(released, assembled, bond)`, so bond 1 reconstructs
   * the pane EXACTLY - identical pivot, identity rotation - which is what lets the intact
   * quad be swapped for the fracture mesh without a visible pop.
   */
  frame(alpha: number): void {
    const a = clamp01(alpha);

    for (const event of this.events) {
      const end = event.baseShard + event.shardCount;
      for (let i = event.baseShard; i < end; i += 1) {
        if (this.alive[i] === 0) continue;

        const b = f(this.bondPrev, i) + (f(this.bond, i) - f(this.bondPrev, i)) * a;
        const p = i * SHARD_POSE_STRIDE;

        const px = f(this.prevPose, p) + (f(this.curPose, p) - f(this.prevPose, p)) * a;
        const py = f(this.prevPose, p + 1) + (f(this.curPose, p + 1) - f(this.prevPose, p + 1)) * a;
        const pz = f(this.prevPose, p + 2) + (f(this.curPose, p + 2) - f(this.prevPose, p + 2)) * a;

        let qx = f(this.prevPose, p + 3);
        let qy = f(this.prevPose, p + 4);
        let qz = f(this.prevPose, p + 5);
        let qw = f(this.prevPose, p + 6);
        const cx = f(this.curPose, p + 3);
        const cy = f(this.curPose, p + 4);
        const cz = f(this.curPose, p + 5);
        const cw = f(this.curPose, p + 6);
        // Shortest-arc sign fix before both nlerps; without it a shard can spin the long way
        // round in a single frame when the integrator crosses the quaternion double cover.
        const sign = qx * cx + qy * cy + qz * cz + qw * cw < 0 ? -1 : 1;
        qx += (cx * sign - qx) * a;
        qy += (cy * sign - qy) * a;
        qz += (cz * sign - qz) * a;
        qw += (cw * sign - qw) * a;

        const ax = f(this.assembled, i * 3);
        const ay = f(this.assembled, i * 3 + 1);
        const az = f(this.assembled, i * 3 + 2);

        // Blending toward the identity quaternion is the assembled orientation: a shard's
        // vertices are stored relative to its own pivot in pane space, so "no rotation" is
        // exactly "back in the pane".
        const w = qw < 0 ? -1 : 1;
        let bx = qx * w * (1 - b);
        let by = qy * w * (1 - b);
        let bz = qz * w * (1 - b);
        let bw = qw * w * (1 - b) + b;
        const len = Math.sqrt(bx * bx + by * by + bz * bz + bw * bw);
        if (len > 0) {
          const inv = 1 / len;
          bx *= inv;
          by *= inv;
          bz *= inv;
          bw *= inv;
        } else {
          bx = 0;
          by = 0;
          bz = 0;
          bw = 1;
        }

        const t = i * SHARD_TRANSFORM_STRIDE;
        this.shardTransforms[t] = px + (ax - px) * b;
        this.shardTransforms[t + 1] = py + (ay - py) * b;
        this.shardTransforms[t + 2] = pz + (az - pz) * b;
        this.shardTransforms[t + 3] = bx;
        this.shardTransforms[t + 4] = by;
        this.shardTransforms[t + 5] = bz;
        this.shardTransforms[t + 6] = bw;
        this.shardTransforms[t + 7] = b;
      }
    }
  }

  /** Drops every in-flight shatter. Bonds go back to ZERO - released - not to one. */
  reset(): void {
    for (let e = this.events.length - 1; e >= 0; e -= 1) this.retireAt(e);
    this.events.length = 0;
    this.ringHead = 0;
    this.liveShards = 0;
    this.skipFrames = 0;
    this.flashCounter = 0;
    this.chromaticCounter = 0;
    this.pool.reset();
  }

  dispose(): void {
    this.reset();
  }

  // -------------------------------------------------------------------------------------

  /**
   * How far a shard can get before Quality retires it. The pane needs this for its bounding
   * sphere, and only the runtime can compute it because the lifetime is a Quality number and
   * the speed is an archetype number.
   */
  private dispersalRadius(pane: Pane): number {
    const seconds = this.quality.budget.shardLifetimeMs / MS_PER_SECOND;
    const diagonal = Math.sqrt(
      pane.rect.halfWidth * pane.rect.halfWidth + pane.rect.halfHeight * pane.rect.halfHeight,
    );
    return diagonal + pane.archetype.ejectSpeed * SHARD_DYNAMICS.speedJitterMax * seconds;
  }

  /**
   * Hit-stop length is a Quality number multiplied by an archetype weight, never a literal.
   * It is a MAX rather than a sum: two panes broken on the same frame should feel heavier,
   * not freeze the game for twice as long.
   */
  private requestHitStop(pane: Pane): void {
    const frames = Math.round(this.quality.motionRules.slowMoFrameSkip * pane.archetype.hitStopWeight);
    if (frames > this.skipFrames) this.skipFrames = frames;
    this.chromaticCounter = SHATTER_STAGING.chromaticFrames;
  }

  /**
   * Ring allocation. Shards all live for the same Quality-owned duration, so events retire
   * strictly in the order they were created and a ring is the natural fit: O(1), no free
   * list, no fragmentation. Anything still occupying the space being claimed is force-retired,
   * which is also the correct behaviour for the cap - the oldest shatter yields to the newest.
   */
  private allocateBlock(count: number): number {
    if (count <= 0 || count > this.capacity) return -1;
    if (this.ringHead + count > this.capacity) {
      this.retireOverlapping(this.ringHead, this.capacity);
      this.ringHead = 0;
    }
    this.retireOverlapping(this.ringHead, this.ringHead + count);
    const base = this.ringHead;
    this.ringHead += count;
    if (this.ringHead >= this.capacity) this.ringHead = 0;
    return base;
  }

  private retireOverlapping(from: number, to: number): void {
    for (let e = this.events.length - 1; e >= 0; e -= 1) {
      const event = this.events[e];
      if (event === undefined) continue;
      if (event.baseShard < to && event.baseShard + event.shardCount > from) this.retireAt(e);
    }
  }

  private retireAt(index: number): void {
    const event = this.events[index];
    if (event === undefined) return;
    const end = event.baseShard + event.shardCount;
    for (let i = event.baseShard; i < end; i += 1) {
      const slot = this.slots[i] ?? -1;
      if (slot >= 0) this.pool.release(slot);
      this.slots[i] = -1;
      if (this.alive[i] === 1) this.liveShards -= 1;
      this.alive[i] = 0;
      // Back to the base state, which is RELEASED. Never 1.
      this.bond[i] = 0;
      this.bondPrev[i] = 0;
      this.bondFloor[i] = 0;
      this.shardTransforms[i * SHARD_TRANSFORM_STRIDE + 7] = 0;
    }
    event.pane.markGone();
    this.events.splice(index, 1);
  }

  /**
   * Computes each shard's RELEASED base pose - where the fracture resolves to - launches a
   * body from it, and then raises `bond` to 1 so the keyframe has an unbroken pane to animate
   * away from. The order matters: base first, animation second. See the header.
   */
  private armShards(pane: Pane, bake: PaneBake, baseShard: number): void {
    const { pattern, pivots } = bake;
    const archetype = pane.archetype;
    const rng = createEjectionRng(pane);
    const frame = pane.frame;
    const releaseSeconds = SHATTER_STAGING.releaseFrames / this.quality.budget.targetFps;
    const reach = pattern.maxImpactDistance > 0 ? pattern.maxImpactDistance : 1;

    for (const cell of pattern.cells) {
      const i = baseShard + cell.index;
      if (i >= this.capacity) break;

      paneLocalToWorld(frame, f(pivots, cell.index * 3), f(pivots, cell.index * 3 + 1), 0, this.scratchWorld, 0);
      const wx = f(this.scratchWorld, 0);
      const wy = f(this.scratchWorld, 1);
      const wz = f(this.scratchWorld, 2);
      this.assembled[i * 3] = wx;
      this.assembled[i * 3 + 1] = wy;
      this.assembled[i * 3 + 2] = wz;

      // Cells near the impact are driven hardest; the rim barely lets go. That gradient is
      // what makes a fracture read as radiating rather than as a pane being deleted.
      const falloff = reach / (reach + cell.impactDistance * 2);
      const lateralX = (cell.centroid.x - pattern.impact.x) / reach;
      const lateralY = (cell.centroid.y - pattern.impact.y) / reach;
      const spread = SHARD_DYNAMICS.lateralSpread;

      const [nx, ny, nz] = frame.normal;
      const [rx, ry, rz] = frame.right;
      const [ux, uy, uz] = frame.up;
      let dx = nx + (rx * lateralX + ux * lateralY) * spread;
      let dy = ny + (ry * lateralX + uy * lateralY) * spread;
      let dz = nz + (rz * lateralX + uz * lateralY) * spread;
      const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dLen > 0) {
        dx /= dLen;
        dy /= dLen;
        dz /= dLen;
      }

      const speed =
        archetype.ejectSpeed *
        falloff *
        rng.range(SHARD_DYNAMICS.speedJitterMin, SHARD_DYNAMICS.speedJitterMax);
      const travel = speed * releaseSeconds;

      const spin = archetype.spinRate * falloff;
      let axX = rng.range(-1, 1);
      let axY = rng.range(-1, 1);
      let axZ = rng.range(-1, 1);
      const axLen = Math.sqrt(axX * axX + axY * axY + axZ * axZ);
      if (axLen > 0) {
        axX /= axLen;
        axY /= axLen;
        axZ /= axLen;
      } else {
        axX = 0;
        axY = 0;
        axZ = 1;
      }
      // (axis * tan(theta/2), 1) normalised IS the rotation quaternion for theta about axis,
      // so the tumble is built with arithmetic alone. Keeping the whole pipeline trig-free
      // means the resolved pose an export freezes on is reproducible on any JS engine, not
      // merely on the one that produced it - see the determinism note in Voronoi.ts.
      const tanHalf = spin * releaseSeconds * 0.5;
      let bqx = axX * tanHalf;
      let bqy = axY * tanHalf;
      let bqz = axZ * tanHalf;
      let bqw = 1;
      const bqLen = Math.sqrt(bqx * bqx + bqy * bqy + bqz * bqz + bqw * bqw);
      bqx /= bqLen;
      bqy /= bqLen;
      bqz /= bqLen;
      bqw /= bqLen;

      this.scratchPose[0] = wx + dx * travel;
      this.scratchPose[1] = wy + dy * travel;
      this.scratchPose[2] = wz + dz * travel;
      this.scratchPose[3] = bqx;
      this.scratchPose[4] = bqy;
      this.scratchPose[5] = bqz;
      this.scratchPose[6] = bqw;

      this.scratchVelocity[0] = dx * speed;
      this.scratchVelocity[1] = dy * speed;
      this.scratchVelocity[2] = dz * speed;
      this.scratchVelocity[3] = axX * spin;
      this.scratchVelocity[4] = axY * spin;
      this.scratchVelocity[5] = axZ * spin;

      const slot = this.pool.acquire();
      this.slots[i] = slot;
      if (slot >= 0) this.pool.launch(slot, this.scratchPose, 0, this.scratchVelocity, 0);

      const p = i * SHARD_POSE_STRIDE;
      for (let k = 0; k < SHARD_POSE_STRIDE; k += 1) {
        this.curPose[p + k] = f(this.scratchPose, k);
        this.prevPose[p + k] = f(this.scratchPose, k);
      }

      this.releaseDelay[i] = (cell.impactDistance / reach) * SHATTER_STAGING.staggerFrames;
      this.bondFloor[i] = pane.bondFloor;
      // The one place a 1 is ever written. Everything else in this runtime treats 0 - the
      // released, resolved shard - as the resting truth.
      this.bond[i] = 1;
      this.bondPrev[i] = 1;
      if (this.alive[i] === 0) this.liveShards += 1;
      this.alive[i] = 1;
    }
  }

  /** Drives bond from 1 down to its floor, each shard starting after its own stagger delay. */
  private advanceBonds(event: EventRecord): void {
    const step = 1 / SHATTER_STAGING.releaseFrames;
    const end = event.baseShard + event.shardCount;
    for (let i = event.baseShard; i < end; i += 1) {
      if (this.alive[i] === 0) continue;
      if (event.phaseFrames <= f(this.releaseDelay, i)) continue;
      const floor = f(this.bondFloor, i);
      const next = f(this.bond, i) - step;
      this.bond[i] = next < floor ? floor : next;
    }
  }

  private readPoses(): void {
    for (const event of this.events) {
      const end = event.baseShard + event.shardCount;
      for (let i = event.baseShard; i < end; i += 1) {
        if (this.alive[i] === 0) continue;
        const slot = this.slots[i] ?? -1;
        if (slot < 0) continue;
        this.pool.readPose(slot, this.curPose, i * SHARD_POSE_STRIDE);
      }
    }
  }
}

/**
 * Ejection draws its own sub-stream from the pane's seed, so the scatter is reproducible and
 * adding a draw here can never shift the fracture pattern the same seed produced.
 */
function createEjectionRng(pane: Pane): Rng {
  return createRng(pane.seed).fork(STREAM_EJECT);
}
