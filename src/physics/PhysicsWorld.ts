/**
 * THE PHYSICS WORLD.
 *
 * One Rapier world, stepped at a fixed 60 Hz by core/Loop.ts and never by the animation
 * frame. Everything the player can hit, throw or break lives here; everything that only
 * looks like it does (motes, sparks, the battle backdrop) deliberately does not.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. FIXED STEP, INTERPOLATED PRESENTATION. `fixedUpdate` advances the sim by exactly one
 *    constant timestep or not at all. `frame(alpha)` never touches sim state - it only
 *    blends the last two completed steps into the buffers the renderer reads. A variable
 *    timestep makes a thrown ball's trajectory depend on frame rate, which means the same
 *    throw misses on a slower machine.
 *
 * 2. SLOW MOTION IS A FRAME-SKIP COUNTER. `setFrameSkip(n)` makes the world step once every
 *    n+1 fixed updates. The timestep itself never changes, so the simulation is bit-for-bit
 *    the same whether or not time is slowed. Presentation stays smooth because the held
 *    step is stretched across the skipped interval (see `frame`), NOT because dt was
 *    scaled - scaling dt would change contact resolution and let balls tunnel.
 *
 * 3. NOTHING IS ALLOCATED PER SPAWN. Ball and shard bodies are Rapier rigid-bodies built
 *    during pre-warm and parked disabled. Spawning re-enables and repositions one; despawn
 *    disables it again. Creating and destroying bodies at play time churns WASM memory and
 *    invalidates the broad phase, which is precisely the cost pooling exists to avoid.
 *
 * Numbers: every count, cap and lifetime comes from core/Quality.ts. The simulation-domain
 * constants that are not tier-scalable (gravity, solver iterations, damping) are in
 * SIM_TUNING below, and the collider-facing ones are in Colliders.ts - see the note there.
 */

import type {
  Collider,
  ColliderHandle,
  EventQueue,
  RigidBody,
  World,
} from '@dimforge/rapier3d-compat';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Quaternion, Vector3 } from 'three/webgpu';

import { FIXED_STEP_MS, type QualityBudget } from '../core/Quality';
import type { Alpha, Brand, Disposable, Frames, Millis, Pausable, Tickable } from '../core/types';
import {
  SHAPE_DEFAULTS,
  buildModuleColliders,
  configureDesc,
  groupsForRole,
  isSensorRole,
  type BuiltCollider,
  type ModuleColliderSpec,
  type ModulePlacement,
  type PhysicsRole,
  type Vec3Like,
} from './Colliders';
import { Pool, PoolRegistry, type PoolStats } from './Pool';

/** Unit conversion, not a budget: Rapier's timestep is seconds, the engine's clock is ms. */
const MS_PER_SECOND = 1000;

/**
 * Simulation-domain settings. Not tier-scalable: a corridor with weaker gravity on mobile
 * is a different game. The only tier lever on the solver is how many steps per frame the
 * Loop is allowed to run, and that lives in Quality as `physicsSubstepCap`.
 */
export const SIM_TUNING = Object.freeze({
  /** m/s2. Shards need to fall convincingly; the ball's arc is authored on top of this. */
  gravityY: -18.5,
  /**
   * Rapier's default of 4 leaves a ball resting on a shard visibly jittering. 6 is the
   * point where that stops without measurably moving the physics ms budget.
   */
  solverIterations: 6,
  /**
   * World-wide CCD substep count, but only the ball has CCD enabled on its body, so this
   * is the ball's setting in practice. A thrown ball crosses far more than a pane's
   * thickness in one step and without it would pass straight through the thing the whole
   * game is about.
   */
  ballCcdSubsteps: 2,
  ballLinearDamping: 0.02,
  ballAngularDamping: 0.05,
  /** Debris bleeds energy fast so a broken pane settles instead of skittering forever. */
  shardLinearDamping: 0.18,
  shardAngularDamping: 0.42,
  /** Metres. Rapier scales its internal tolerances by the size of a typical object. */
  lengthUnit: 1,
  /**
   * EMA weight on the measured step cost. Low enough that one long frame (a tab regaining
   * focus, a shader compile) cannot collapse the shard ceiling on its own.
   */
  stepTimeSmoothing: 0.12,
  /**
   * Fraction of full shard capacity the ceiling regains per step once the sim is inside
   * budget - a full recovery takes about a third of a second. Expressed against capacity
   * rather than against the current ceiling so a ceiling that was cut to almost nothing
   * still climbs at a usable rate instead of crawling back by ones.
   */
  ceilingRecoveryRate: 0.05,
});

/**
 * A slot in the transform buffers. Branded because it is an index that is meaningless in
 * any other array, and handing the renderer the wrong integer silently draws the wrong
 * shard at the wrong place rather than failing.
 */
export type BodyId = Brand<number, 'BodyId'>;

/** Handle to one instantiated corridor module's colliders, so a ring can be recycled. */
export type StaticModuleId = Brand<number, 'StaticModuleId'>;

export type PooledKind = 'ball' | 'shard';

/**
 * What a collider means to gameplay. Handed to listeners by reference and valid only for
 * the duration of the callback: the same object is reused across events for a given slot.
 */
export interface PhysicsTag {
  readonly role: PhysicsRole;
  /** The pooled body this collider belongs to, or null for static corridor geometry. */
  readonly body: BodyId | null;
  /** The owning layer's own id - a pane index, a crystal index, a gate id. */
  readonly ref: number;
}

interface MutableTag {
  role: PhysicsRole;
  body: BodyId | null;
  ref: number;
}

/** Impact strong enough to break something. Vectors are scratch - copy what you keep. */
export interface ImpactEvent {
  /** The thing that was hit: the glass pane, the crystal. */
  readonly target: PhysicsTag;
  /** The thing that hit it, usually a ball. */
  readonly source: PhysicsTag;
  /**
   * Sum of contact force magnitudes. Rapier reports impulse-over-timestep, so this scales
   * with the solver's step and is a RELATIVE hint for how violently to break the pane -
   * never a physical force, and never the thing that decides WHETHER it breaks.
   */
  readonly magnitude: number;
  /** World-space direction of the strongest contact force. */
  readonly direction: Vec3Like;
  /** World-space contact point, or the source body's centre if no manifold survived. */
  readonly point: Vec3Like;
}

export interface PhysicsListener {
  /** Fires on both begin and end so sensors (crystals, gates) can be edge-triggered. */
  onContact?(a: PhysicsTag, b: PhysicsTag, started: boolean): void;
  onImpact?(event: ImpactEvent): void;
}

export interface RayHit {
  readonly tag: PhysicsTag;
  readonly distance: number;
  readonly normal: Vec3Like;
}

export interface PhysicsStats {
  readonly liveBodies: number;
  readonly liveShards: number;
  /** Current governed ceiling on simultaneously simulated shards. */
  readonly shardCeiling: number;
  readonly staticColliders: number;
  readonly stepsTaken: number;
  /** Smoothed cost of one fixed update, ms. The profiler asserts this against msBudget. */
  readonly stepMs: number;
  readonly frameSkip: Frames;
  readonly pools: readonly PoolStats[];
}

interface PooledBody {
  readonly id: BodyId;
  readonly kind: PooledKind;
  readonly body: RigidBody;
  readonly collider: Collider;
  /** Index into `live`, or -1 while parked. Enables O(1) swap removal. */
  liveIndex: number;
  /** Step number at which a shard retires. Number.POSITIVE_INFINITY for balls. */
  expiresAtStep: number;
}

interface StaticModule {
  readonly id: StaticModuleId;
  readonly colliders: Collider[];
}

/**
 * Rapier ships as WASM and every constructor in it traps before the module is
 * instantiated. `initPhysics()` is the one await the Engine owes physics at boot; the
 * promise is memoised so a second caller (a test, a hot reload) joins the first.
 */
let initPromise: Promise<void> | null = null;
let ready = false;

export async function initPhysics(): Promise<void> {
  if (ready) return;
  if (initPromise === null) {
    initPromise = RAPIER.init().then(() => {
      ready = true;
    });
  }
  await initPromise;
}

export function isPhysicsReady(): boolean {
  return ready;
}

export class PhysicsWorld implements Tickable, Pausable, Disposable {
  readonly budget: QualityBudget;

  /**
   * Interleaved xyz / xyzw, one entry per slot, already blended by alpha. Exposed as raw
   * arrays because the shard renderer uploads them straight to an instanced buffer, and
   * copying them through Vector3s would cost more than the physics step.
   */
  readonly interpolatedPosition: Float32Array;
  readonly interpolatedRotation: Float32Array;

  private readonly world: World;
  private readonly events: EventQueue;
  private readonly pools = new PoolRegistry();
  private readonly ballPool: Pool<PooledBody>;
  private readonly shardPool: Pool<PooledBody>;

  private readonly slots: (PooledBody | null)[];
  private readonly tags: MutableTag[];
  private readonly live: PooledBody[] = [];

  private readonly prevPosition: Float32Array;
  private readonly prevRotation: Float32Array;
  private readonly currPosition: Float32Array;
  private readonly currRotation: Float32Array;

  /**
   * Collider handle -> what it means to gameplay.
   *
   * Rapier 0.20 hands out handles as a u64 (index + generation) reinterpreted as a double,
   * so they print as denormals like `5e-324` rather than as small integers. That is not a
   * bug and must not be "fixed": `collider.handle` and the handles delivered by the event
   * queue use the identical encoding, so they compare and hash correctly, and the packed
   * generation counter means a handle freed and reissued never aliases a stale map entry.
   */
  private readonly tagByCollider = new Map<ColliderHandle, MutableTag>();
  private readonly staticModules = new Map<StaticModuleId, StaticModule>();
  private readonly builtScratch: BuiltCollider[] = [];

  private readonly ballSlotBase = 0;
  private readonly shardSlotBase: number;
  private readonly shardCapacity: number;
  private readonly shardLifetimeSteps: number;

  /**
   * THE LOAD GOVERNOR. Measured on this machine, active shards cost roughly 3.3 ms at 600,
   * 7.3 ms at 1200 and 16.4 ms at 2400 - so a tier that allows 2400 live shards can and
   * will blow a 2 ms physics budget the instant a big pane goes. Disabled and sleeping
   * bodies, by contrast, cost nothing measurable, which is what makes a big parked pool
   * safe in the first place.
   *
   * The response is to simulate fewer pieces, never to shorten the step. Quality's
   * msBudget.physics is the setpoint; this is the actuator.
   */
  private shardCeiling: number;
  private liveShardCount = 0;
  private stepMsAvg = 0;

  private listener: PhysicsListener | null = null;
  private frameSkip: Frames = 0;
  private heldFrames = 0;
  private stepsTaken = 0;
  private paused = false;
  private nextModuleId = 1;
  private staticColliderCount = 0;
  private disposed = false;
  private warnedVariableStep = false;

  /** Scratch reused by every query and event so the hot paths allocate nothing. */
  private readonly scratchVectorA = { x: 0, y: 0, z: 0 };
  private readonly scratchVectorB = { x: 0, y: 0, z: 0 };
  private readonly scratchVectorC = { x: 0, y: 0, z: 0 };
  private readonly scratchRotation = { x: 0, y: 0, z: 0, w: 1 };
  private readonly scratchRay: RAPIER.Ray;
  private readonly scratchHit: { tag: PhysicsTag; distance: number; normal: Vec3Like };
  private readonly scratchImpact: {
    target: PhysicsTag;
    source: PhysicsTag;
    magnitude: number;
    direction: Vec3Like;
    point: Vec3Like;
  };
  private readonly nullTag: MutableTag = { role: 'structure', body: null, ref: -1 };

  constructor(budget: QualityBudget) {
    if (!ready) {
      throw new Error('PhysicsWorld: await initPhysics() before constructing the world.');
    }
    this.budget = budget;

    this.world = new RAPIER.World({ x: 0, y: SIM_TUNING.gravityY, z: 0 });
    this.world.timestep = FIXED_STEP_MS / MS_PER_SECOND;
    this.world.numSolverIterations = SIM_TUNING.solverIterations;
    this.world.maxCcdSubsteps = SIM_TUNING.ballCcdSubsteps;
    this.world.lengthUnit = SIM_TUNING.lengthUnit;
    this.events = new RAPIER.EventQueue(true);

    const ballCapacity = budget.prewarm.balls;
    // Shards are capped by what may be alive at once, not by what was pre-warmed: those
    // are the same number in every tier today, but conflating them would silently break
    // the first tier where they differ.
    const shardCapacity = Math.max(budget.maxShardsLive, budget.prewarm.shards);
    this.shardSlotBase = ballCapacity;
    this.shardCapacity = shardCapacity;
    this.shardCeiling = shardCapacity;
    const slotCount = ballCapacity + shardCapacity;

    this.slots = new Array<PooledBody | null>(slotCount).fill(null);
    this.tags = [];
    for (let i = 0; i < slotCount; i += 1) {
      this.tags.push({ role: i < ballCapacity ? 'ball' : 'shard', body: i as BodyId, ref: 0 });
    }

    this.prevPosition = new Float32Array(slotCount * 3);
    this.prevRotation = new Float32Array(slotCount * 4);
    this.currPosition = new Float32Array(slotCount * 3);
    this.currRotation = new Float32Array(slotCount * 4);
    this.interpolatedPosition = new Float32Array(slotCount * 3);
    this.interpolatedRotation = new Float32Array(slotCount * 4);
    for (let i = 0; i < slotCount; i += 1) {
      this.prevRotation[i * 4 + 3] = 1;
      this.currRotation[i * 4 + 3] = 1;
      this.interpolatedRotation[i * 4 + 3] = 1;
    }

    this.shardLifetimeSteps = Math.max(1, Math.round(budget.shardLifetimeMs / FIXED_STEP_MS));

    this.ballPool = this.pools.add(
      new Pool<PooledBody>({
        name: 'physics/ball',
        capacity: ballCapacity,
        prewarm: budget.prewarm.balls,
        create: (index) => this.createPooled('ball', (this.ballSlotBase + index) as BodyId),
        reset: (item) => this.parkBody(item),
        retire: (item) => this.retireBody(item),
      }),
    );

    this.shardPool = this.pools.add(
      new Pool<PooledBody>({
        name: 'physics/shard',
        capacity: shardCapacity,
        prewarm: budget.prewarm.shards,
        create: (index) => this.createPooled('shard', (this.shardSlotBase + index) as BodyId),
        reset: (item) => this.parkBody(item),
        retire: (item) => this.retireBody(item),
      }),
    );

    this.scratchRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    this.scratchHit = { tag: this.nullTag, distance: 0, normal: this.scratchVectorA };
    this.scratchImpact = {
      target: this.nullTag,
      source: this.nullTag,
      magnitude: 0,
      direction: this.scratchVectorB,
      point: this.scratchVectorC,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Chunked pre-warm for the loading screen. Returns true when every pooled body exists.
   * Building thousands of rigid-bodies is the single longest synchronous block at boot,
   * so it is deliberately drivable frame by frame.
   */
  prewarmStep(maxBodies: number): boolean {
    return this.pools.prewarmStep(maxBodies);
  }

  /** Blocking pre-warm. Boot-time only. */
  prewarm(): void {
    this.ballPool.prewarm();
    this.shardPool.prewarm();
  }

  setListener(listener: PhysicsListener | null): void {
    this.listener = listener;
  }

  /**
   * Slow motion. `frames` is how many fixed updates to SKIP between steps, so 0 is real
   * time and 1 is half speed. Never expressed as a timestep multiplier - see the file
   * header for why that distinction is load-bearing rather than stylistic.
   */
  setFrameSkip(frames: Frames): void {
    const next = Math.max(0, Math.floor(frames));
    if (next === this.frameSkip) return;
    this.frameSkip = next;
    // Held frames are counted against the old window; keeping them would make the very
    // next presented frame jump backwards.
    this.heldFrames = 0;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  // ---------------------------------------------------------------- the tick

  fixedUpdate(dt: Millis): void {
    if (this.disposed || this.paused) return;

    // The world's timestep was fixed at construction. A caller handing over anything else
    // has a clock bug, and the failure mode is silent: the sim just runs at the wrong rate
    // and every throw lands somewhere different. Warned once, never thrown - a dev-time
    // clock hiccup must not take the run down.
    if (import.meta.env.DEV && dt !== FIXED_STEP_MS && !this.warnedVariableStep) {
      this.warnedVariableStep = true;
      console.warn(
        `PhysicsWorld: fixedUpdate received dt=${dt}ms but the world steps at ${FIXED_STEP_MS}ms.`,
      );
    }

    if (this.frameSkip > 0 && this.heldFrames < this.frameSkip) {
      this.heldFrames += 1;
      return;
    }

    const startedAt = performance.now();
    this.snapshotPrevious();
    this.world.step(this.events);
    this.stepsTaken += 1;
    this.heldFrames = 0;
    this.snapshotCurrent();
    this.drainEvents();
    this.retireExpired();

    const elapsed = performance.now() - startedAt;
    this.stepMsAvg += (elapsed - this.stepMsAvg) * SIM_TUNING.stepTimeSmoothing;
    this.governShardCount();
  }

  /**
   * Blends the last two completed steps into the render buffers.
   *
   * Under slow motion the blend runs across the whole skipped window rather than a single
   * step, so the presented motion is continuous while the underlying steps stay unscaled.
   * That is the entire trick: the sim is discrete and unchanged, only the presentation
   * clock is stretched.
   */
  frame(alpha: Alpha): void {
    if (this.disposed) return;
    const window = this.frameSkip + 1;
    const raw = (this.heldFrames + alpha) / window;
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;

    for (const item of this.live) {
      const slot = item.id as number;
      const p = slot * 3;
      const r = slot * 4;

      const px = this.prevPosition[p] ?? 0;
      const py = this.prevPosition[p + 1] ?? 0;
      const pz = this.prevPosition[p + 2] ?? 0;
      this.interpolatedPosition[p] = px + ((this.currPosition[p] ?? 0) - px) * t;
      this.interpolatedPosition[p + 1] = py + ((this.currPosition[p + 1] ?? 0) - py) * t;
      this.interpolatedPosition[p + 2] = pz + ((this.currPosition[p + 2] ?? 0) - pz) * t;

      // Normalised lerp, not slerp. Across a single 16.6 ms step the angle between the two
      // quaternions is small enough that the two are visually identical, and at 2400 live
      // shards the trig in a slerp is the difference between fitting the frame and not.
      const ax = this.prevRotation[r] ?? 0;
      const ay = this.prevRotation[r + 1] ?? 0;
      const az = this.prevRotation[r + 2] ?? 0;
      const aw = this.prevRotation[r + 3] ?? 1;
      let bx = this.currRotation[r] ?? 0;
      let by = this.currRotation[r + 1] ?? 0;
      let bz = this.currRotation[r + 2] ?? 0;
      let bw = this.currRotation[r + 3] ?? 1;
      // Take the short way round; without this a shard flips through 360 degrees whenever
      // the solver hands back the antipodal representation of the same orientation.
      if (ax * bx + ay * by + az * bz + aw * bw < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
      }
      const qx = ax + (bx - ax) * t;
      const qy = ay + (by - ay) * t;
      const qz = az + (bz - az) * t;
      const qw = aw + (bw - aw) * t;
      const inv = 1 / (Math.hypot(qx, qy, qz, qw) || 1);
      this.interpolatedRotation[r] = qx * inv;
      this.interpolatedRotation[r + 1] = qy * inv;
      this.interpolatedRotation[r + 2] = qz * inv;
      this.interpolatedRotation[r + 3] = qw * inv;
    }
  }

  // ---------------------------------------------------------------- spawning

  /**
   * Throws a ball. Returns null when every ball body is already in flight, which the
   * throw path must treat as "the throw did not happen" rather than retrying.
   */
  spawnBall(origin: Vec3Like, velocity: Vec3Like, ref: number): BodyId | null {
    const item = this.ballPool.acquire();
    if (item === null) return null;
    this.wake(item, origin, velocity, null, ref);
    item.expiresAtStep = Number.POSITIVE_INFINITY;
    return item.id;
  }

  /**
   * Spawns one piece of debris. `scale` rescales the pooled plate so a single body type
   * covers the whole size distribution a shattered pane produces. Retires itself after
   * `shardLifetimeMs`; the caller never has to remember it.
   */
  spawnShard(
    origin: Vec3Like,
    velocity: Vec3Like,
    spin: Vec3Like,
    scale: number,
    ref: number,
  ): BodyId | null {
    // Refused before touching the pool: the governor's whole job is to stop shards being
    // simulated, and a body that is acquired and immediately retired has already cost a
    // broad-phase insertion.
    if (this.liveShardCount >= this.shardCeiling) return null;

    const item = this.shardPool.acquire();
    if (item === null) return null;

    const [hx, hy, hz] = SHAPE_DEFAULTS.shardHalfExtents;
    this.scratchVectorA.x = hx * scale;
    this.scratchVectorA.y = hy * scale;
    this.scratchVectorA.z = hz * scale;
    item.collider.setHalfExtents(this.scratchVectorA);
    // Half-extents changed, so the cached inertia tensor is now wrong; a shard with a
    // stale tensor tumbles at the wrong rate and reads as weightless.
    item.body.recomputeMassPropertiesFromColliders();

    this.wake(item, origin, velocity, spin, ref);
    item.expiresAtStep = this.stepsTaken + this.shardLifetimeSteps;
    return item.id;
  }

  despawn(id: BodyId): void {
    const item = this.slots[id as number];
    if (item === undefined || item === null) return;
    this.removeFromLive(item);
    this.slots[id as number] = null;
    if (item.kind === 'ball') this.ballPool.release(item);
    else this.shardPool.release(item);
  }

  /** Returns false when the slot is not live, so the caller can drop a stale reference. */
  readTransform(id: BodyId, outPosition: Vector3, outRotation: Quaternion): boolean {
    const slot = id as number;
    if (this.slots[slot] == null) return false;
    const p = slot * 3;
    const r = slot * 4;
    outPosition.set(
      this.interpolatedPosition[p] ?? 0,
      this.interpolatedPosition[p + 1] ?? 0,
      this.interpolatedPosition[p + 2] ?? 0,
    );
    outRotation.set(
      this.interpolatedRotation[r] ?? 0,
      this.interpolatedRotation[r + 1] ?? 0,
      this.interpolatedRotation[r + 2] ?? 0,
      this.interpolatedRotation[r + 3] ?? 1,
    );
    return true;
  }

  /** Slots that currently hold a live body, in no particular order. Do not retain. */
  liveIds(out: BodyId[]): BodyId[] {
    out.length = 0;
    for (const item of this.live) out.push(item.id);
    return out;
  }

  isLive(id: BodyId): boolean {
    return this.slots[id as number] != null;
  }

  // ---------------------------------------------------------------- corridor

  /**
   * Instantiates one corridor kit module's colliders at a placement on the rail. Static
   * colliders are parentless: Rapier treats them as fixed without the cost of a body, and
   * a corridor ring is thousands of them.
   */
  addStaticModule(module: ModuleColliderSpec, placement: ModulePlacement, ref: number): StaticModuleId {
    const id = this.nextModuleId as StaticModuleId;
    this.nextModuleId += 1;

    const built = buildModuleColliders(module, placement, this.builtScratch);
    const colliders: Collider[] = [];
    for (const entry of built) {
      const collider = this.world.createCollider(entry.desc);
      colliders.push(collider);
      // The module's own ref wins when a collider did not declare one, so a whole ring can
      // be identified from any surface in it.
      this.tagByCollider.set(collider.handle, {
        role: entry.role,
        body: null,
        ref: entry.ref === 0 ? ref : entry.ref,
      });
    }
    this.staticColliderCount += colliders.length;
    this.staticModules.set(id, { id, colliders });
    return id;
  }

  removeStaticModule(id: StaticModuleId): void {
    const module = this.staticModules.get(id);
    if (module === undefined) return;
    for (const collider of module.colliders) {
      this.tagByCollider.delete(collider.handle);
      this.world.removeCollider(collider, true);
    }
    this.staticColliderCount -= module.colliders.length;
    this.staticModules.delete(id);
  }

  /** Drops every corridor collider. Used between runs, never mid-run. */
  clearStaticModules(): void {
    for (const id of Array.from(this.staticModules.keys())) this.removeStaticModule(id);
  }

  // ---------------------------------------------------------------- queries

  /**
   * Closest hit along a ray. The returned object is scratch and is overwritten by the next
   * call - copy anything you keep. Used by the aim assist and by the crystal magnet.
   */
  castRay(origin: Vec3Like, direction: Vec3Like, maxDistance: number, role: PhysicsRole = 'ball'): RayHit | null {
    this.scratchRay.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.scratchRay.dir = { x: direction.x, y: direction.y, z: direction.z };
    const hit = this.world.castRayAndGetNormal(
      this.scratchRay,
      maxDistance,
      true,
      undefined,
      groupsForRole(role),
    );
    if (hit === null) return null;
    const tag = this.tagByCollider.get(hit.collider.handle);
    if (tag === undefined) return null;
    this.scratchVectorA.x = hit.normal.x;
    this.scratchVectorA.y = hit.normal.y;
    this.scratchVectorA.z = hit.normal.z;
    this.scratchHit.tag = tag;
    this.scratchHit.distance = hit.timeOfImpact;
    this.scratchHit.normal = this.scratchVectorA;
    return this.scratchHit;
  }

  stats(): PhysicsStats {
    return {
      liveBodies: this.live.length,
      liveShards: this.liveShardCount,
      shardCeiling: this.shardCeiling,
      staticColliders: this.staticColliderCount,
      stepsTaken: this.stepsTaken,
      stepMs: this.stepMsAvg,
      frameSkip: this.frameSkip,
      pools: this.pools.stats(),
    };
  }

  /** Dev-only. Call between runs: a leaked body is capacity that never comes back. */
  assertNoLeaks(context: string): void {
    this.pools.assertNoLeaks(context);
  }

  /** Hands every in-flight ball and shard back to its pool. Run teardown, not mid-run. */
  reset(): void {
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const item = this.live[i];
      if (item !== undefined) this.despawn(item.id);
    }
    this.clearStaticModules();
    this.heldFrames = 0;
    this.shardCeiling = this.shardCapacity;
    this.stepMsAvg = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.pools.dispose();
    this.tagByCollider.clear();
    this.events.free();
    // Frees every body, collider and pipeline the world owns in one WASM call, so the
    // pools must have been disposed first - their bodies are about to become invalid.
    this.world.free();
  }

  // ---------------------------------------------------------------- internals

  private createPooled(kind: PooledKind, id: BodyId): PooledBody {
    const bodyDesc =
      kind === 'ball'
        ? RAPIER.RigidBodyDesc.dynamic()
            .setCcdEnabled(true)
            .setLinearDamping(SIM_TUNING.ballLinearDamping)
            .setAngularDamping(SIM_TUNING.ballAngularDamping)
        : RAPIER.RigidBodyDesc.dynamic()
            .setLinearDamping(SIM_TUNING.shardLinearDamping)
            .setAngularDamping(SIM_TUNING.shardAngularDamping);
    bodyDesc.setEnabled(false);
    const body = this.world.createRigidBody(bodyDesc);

    const [hx, hy, hz] = SHAPE_DEFAULTS.shardHalfExtents;
    const shapeDesc =
      kind === 'ball'
        ? RAPIER.ColliderDesc.ball(SHAPE_DEFAULTS.ballRadius)
        : RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    const role: PhysicsRole = kind === 'ball' ? 'ball' : 'shard';
    configureDesc(shapeDesc, role, isSensorRole(role));
    // Overrides the density configureDesc just set. Shards keep density-derived mass so a
    // rescaled piece weighs what its size implies; the ball does not, for the reason in
    // SHAPE_DEFAULTS.ballMass.
    if (kind === 'ball') shapeDesc.setMass(SHAPE_DEFAULTS.ballMass);
    const collider = this.world.createCollider(shapeDesc, body);

    const tag = this.tags[id as number];
    if (tag !== undefined) this.tagByCollider.set(collider.handle, tag);

    return { id, kind, body, collider, liveIndex: -1, expiresAtStep: Number.POSITIVE_INFINITY };
  }

  /**
   * Returns a body to the parked state. Velocities are zeroed explicitly because a
   * disabled body keeps its last velocity and would resume mid-flight on the next spawn.
   */
  private parkBody(item: PooledBody): void {
    this.scratchVectorA.x = 0;
    this.scratchVectorA.y = 0;
    this.scratchVectorA.z = 0;
    item.body.setLinvel(this.scratchVectorA, false);
    item.body.setAngvel(this.scratchVectorA, false);
    item.body.setEnabled(false);
    item.liveIndex = -1;
    item.expiresAtStep = Number.POSITIVE_INFINITY;
    const tag = this.tags[item.id as number];
    if (tag !== undefined) tag.ref = 0;
  }

  private retireBody(item: PooledBody): void {
    this.tagByCollider.delete(item.collider.handle);
    // The world is freed wholesale in dispose(); removing bodies individually first would
    // be pure waste, so only unregister and let World.free reclaim the WASM memory.
  }

  private wake(
    item: PooledBody,
    origin: Vec3Like,
    velocity: Vec3Like,
    spin: Vec3Like | null,
    ref: number,
  ): void {
    const slot = item.id as number;
    this.slots[slot] = item;
    const tag = this.tags[slot];
    if (tag !== undefined) tag.ref = ref;

    this.scratchVectorA.x = origin.x;
    this.scratchVectorA.y = origin.y;
    this.scratchVectorA.z = origin.z;
    item.body.setEnabled(true);
    item.body.setTranslation(this.scratchVectorA, false);
    item.body.setRotation(this.scratchRotation, false);

    this.scratchVectorA.x = velocity.x;
    this.scratchVectorA.y = velocity.y;
    this.scratchVectorA.z = velocity.z;
    item.body.setLinvel(this.scratchVectorA, false);

    this.scratchVectorA.x = spin?.x ?? 0;
    this.scratchVectorA.y = spin?.y ?? 0;
    this.scratchVectorA.z = spin?.z ?? 0;
    item.body.setAngvel(this.scratchVectorA, true);

    item.liveIndex = this.live.length;
    this.live.push(item);
    if (item.kind === 'shard') this.liveShardCount += 1;

    // Seed BOTH history slots from the spawn pose. Without this the first presented frame
    // interpolates from wherever the body was parked, and every ball visibly streaks in
    // from the previous throw's resting place.
    this.writeTransform(item, this.prevPosition, this.prevRotation);
    this.writeTransform(item, this.currPosition, this.currRotation);
    this.writeTransform(item, this.interpolatedPosition, this.interpolatedRotation);
  }

  private removeFromLive(item: PooledBody): void {
    const index = item.liveIndex;
    if (index < 0) return;
    if (item.kind === 'shard' && this.liveShardCount > 0) this.liveShardCount -= 1;
    const last = this.live.pop();
    if (last !== undefined && last !== item) {
      this.live[index] = last;
      last.liveIndex = index;
    }
    item.liveIndex = -1;
  }

  private snapshotPrevious(): void {
    for (const item of this.live) {
      const slot = item.id as number;
      const p = slot * 3;
      const r = slot * 4;
      this.prevPosition[p] = this.currPosition[p] ?? 0;
      this.prevPosition[p + 1] = this.currPosition[p + 1] ?? 0;
      this.prevPosition[p + 2] = this.currPosition[p + 2] ?? 0;
      this.prevRotation[r] = this.currRotation[r] ?? 0;
      this.prevRotation[r + 1] = this.currRotation[r + 1] ?? 0;
      this.prevRotation[r + 2] = this.currRotation[r + 2] ?? 0;
      this.prevRotation[r + 3] = this.currRotation[r + 3] ?? 1;
    }
  }

  private snapshotCurrent(): void {
    for (const item of this.live) {
      this.writeTransform(item, this.currPosition, this.currRotation);
    }
  }

  private writeTransform(item: PooledBody, positions: Float32Array, rotations: Float32Array): void {
    const slot = item.id as number;
    const translation = item.body.translation(this.scratchVectorA);
    const rotation = item.body.rotation(this.scratchRotation);
    const p = slot * 3;
    const r = slot * 4;
    positions[p] = translation.x;
    positions[p + 1] = translation.y;
    positions[p + 2] = translation.z;
    rotations[r] = rotation.x;
    rotations[r + 1] = rotation.y;
    rotations[r + 2] = rotation.z;
    rotations[r + 3] = rotation.w;
  }

  private retireExpired(): void {
    if (this.live.length === 0) return;
    // Backwards, because despawn swap-removes and would otherwise skip the entry that
    // takes the retired one's place.
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const item = this.live[i];
      if (item === undefined) continue;
      if (this.stepsTaken >= item.expiresAtStep) this.despawn(item.id);
    }
  }

  /**
   * Moves the shard ceiling toward whatever the measured cost says fits in
   * `msBudget.physics`, then culls down to it.
   *
   * The cut is computed from the LIVE count rather than the current ceiling: a ceiling
   * sitting far above what is actually simulated would take many steps to bite, and the
   * frames being protected are the handful right after a pane explodes.
   */
  private governShardCount(): void {
    const allowance = this.budget.msBudget.physics;
    // No shards live means shards are not what blew the budget, and cutting the ceiling on
    // that evidence is how the governor ends up at zero after one slow boot frame and then
    // spends a second climbing back while the first pane refuses to produce debris.
    const overBudget = this.stepMsAvg > allowance && this.liveShardCount > 0;
    if (overBudget) {
      const scaled = Math.floor(this.liveShardCount * (allowance / this.stepMsAvg));
      this.shardCeiling = Math.max(0, Math.min(this.shardCeiling, scaled));
    } else if (this.shardCeiling < this.shardCapacity) {
      const regained = Math.ceil(this.shardCapacity * SIM_TUNING.ceilingRecoveryRate);
      this.shardCeiling = Math.min(this.shardCapacity, this.shardCeiling + regained);
    }
    if (this.liveShardCount > this.shardCeiling) this.cullShards();
  }

  /**
   * Retires roughly the oldest shards until the live count fits under the ceiling.
   *
   * Expiry step is a proxy for age - shards are stamped at spawn - so culling everything
   * below a threshold in the expiry range removes the oldest debris, which is the debris
   * furthest behind the player and least likely to be watched. It is approximate: an exact
   * k-th smallest selection costs more than the frame it is protecting, and being off by a
   * few shards is invisible where being late by a frame is not.
   */
  private cullShards(): void {
    let oldest = Number.POSITIVE_INFINITY;
    let newest = Number.NEGATIVE_INFINITY;
    for (const item of this.live) {
      if (item.kind !== 'shard') continue;
      if (item.expiresAtStep < oldest) oldest = item.expiresAtStep;
      if (item.expiresAtStep > newest) newest = item.expiresAtStep;
    }
    if (oldest === Number.POSITIVE_INFINITY) return;

    const excess = this.liveShardCount - this.shardCeiling;
    const cutFraction = excess / this.liveShardCount;
    const cutoff = oldest + (newest - oldest) * cutFraction;

    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      if (this.liveShardCount <= this.shardCeiling) return;
      const item = this.live[i];
      if (item === undefined || item.kind !== 'shard') continue;
      if (item.expiresAtStep <= cutoff) this.despawn(item.id);
    }

    // The threshold pass can leave a remainder when many shards share an expiry step, so
    // finish the job unconditionally rather than carrying the overrun into the next step.
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      if (this.liveShardCount <= this.shardCeiling) return;
      const item = this.live[i];
      if (item === undefined || item.kind !== 'shard') continue;
      this.despawn(item.id);
    }
  }

  private drainEvents(): void {
    const listener = this.listener;
    if (listener === null) {
      // Still drained: an EventQueue nobody reads grows without bound.
      this.events.drainCollisionEvents(() => undefined);
      this.events.drainContactForceEvents(() => undefined);
      return;
    }

    const onContact = listener.onContact;
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (onContact === undefined) return;
      const a = this.tagByCollider.get(h1);
      const b = this.tagByCollider.get(h2);
      if (a === undefined || b === undefined) return;
      onContact(a, b, started);
    });

    const onImpact = listener.onImpact;
    this.events.drainContactForceEvents((event) => {
      if (onImpact === undefined) return;
      const a = this.tagByCollider.get(event.collider1());
      const b = this.tagByCollider.get(event.collider2());
      if (a === undefined || b === undefined) return;

      // The moving body is the source and the thing it hit is the target, regardless of
      // which side Rapier happened to put first.
      const aIsSource = a.body !== null;
      const source = aIsSource ? a : b;
      const target = aIsSource ? b : a;

      const direction = event.maxForceDirection(this.scratchVectorB);
      this.scratchVectorB.x = direction.x;
      this.scratchVectorB.y = direction.y;
      this.scratchVectorB.z = direction.z;

      this.resolveContactPoint(event.collider1(), event.collider2(), source);

      this.scratchImpact.target = target;
      this.scratchImpact.source = source;
      this.scratchImpact.magnitude = event.totalForceMagnitude();
      this.scratchImpact.direction = this.scratchVectorB;
      this.scratchImpact.point = this.scratchVectorC;
      onImpact(this.scratchImpact);
    });
  }

  /**
   * Writes the world-space contact point into scratch C. The shatter origin has to be the
   * point of impact, not the pane's centre - a crack pattern that ignores where it was hit
   * is the single most obvious tell that glass is faked.
   */
  private resolveContactPoint(h1: ColliderHandle, h2: ColliderHandle, source: MutableTag): void {
    const c1 = this.world.getCollider(h1);
    const c2 = this.world.getCollider(h2);
    let found = false;
    if (c1 !== null && c2 !== null) {
      this.world.contactPair(c1, c2, (manifold) => {
        if (found || manifold.numSolverContacts() === 0) return;
        const point = manifold.solverContactPoint(0, this.scratchVectorC);
        if (point === null) return;
        this.scratchVectorC.x = point.x;
        this.scratchVectorC.y = point.y;
        this.scratchVectorC.z = point.z;
        found = true;
      });
    }
    if (found) return;

    // Fall back to the moving body's centre. Within a ball radius of the truth, and the
    // alternative - dropping the impact - would mean a pane that visibly refuses to break.
    const slot = source.body;
    if (slot === null) return;
    const p = (slot as number) * 3;
    this.scratchVectorC.x = this.currPosition[p] ?? 0;
    this.scratchVectorC.y = this.currPosition[p + 1] ?? 0;
    this.scratchVectorC.z = this.currPosition[p + 2] ?? 0;
  }
}
