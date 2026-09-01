/**
 * THE OBJECT POOL.
 *
 * SHATTERPOINT allocates nothing on a gameplay path. Not a Vector3, not a shard record,
 * not a Rapier rigid-body. The reason is not micro-optimisation: a major GC pause during
 * the 400 ms after a pane explodes lands squarely on the frames the player is judging the
 * game by, and no amount of render budget buys that frame back.
 *
 * The pool is deliberately NOT auto-growing. A pool that quietly doubles when it runs dry
 * turns a design error (too many shards for this tier) into a mid-run hitch plus a memory
 * spike, which is strictly worse than the honest alternative: `acquire()` returns `null`,
 * the caller sheds the effect, and the sim keeps its frame. `capacity` and `prewarm` are
 * always passed in from core/Quality.ts - this file contains no budget of its own.
 *
 * PRE-WARM IS CHUNKED ON PURPOSE. Building 2400 Rapier bodies in one synchronous burst
 * blocks the main thread for long enough that the loading screen visibly freezes, so the
 * loader drives `prewarmStep()` across frames and watches it return `true` when done.
 */

import type { Disposable } from '../core/types';

/**
 * Everything the pool needs to know about the thing it is pooling. `create` runs during
 * pre-warm; `reset` runs on every release and must leave the item indistinguishable from
 * a freshly created one, because the next acquirer cannot tell the difference.
 */
export interface PoolSpec<T extends object> {
  /** Appears verbatim in leak and exhaustion diagnostics, so make it greppable. */
  readonly name: string;
  /** Hard ceiling. Past this `acquire()` returns null rather than allocating. */
  readonly capacity: number;
  /** How many to build before frame one. Clamped to `capacity`. */
  readonly prewarm: number;
  /** `index` is the item's permanent slot: stable for the life of the pool. */
  create(index: number): T;
  reset(item: T): void;
  /** Releases native/GPU memory held by one item. Called only from `dispose()`. */
  retire?(item: T): void;
}

export interface PoolStats {
  readonly name: string;
  readonly capacity: number;
  /** How many items `create()` has produced so far. */
  readonly allocated: number;
  readonly live: number;
  readonly free: number;
  /** Highest `live` ever reached - the number that tells you if the budget is right. */
  readonly peakLive: number;
  /** Times `acquire()` returned null. Non-zero means the tier budget is too small. */
  readonly exhaustions: number;
}

/**
 * The non-generic face of a pool, so a registry can hold pools of unrelated element
 * types without erasing their element type at the call sites that actually use them.
 */
export interface PoolHandle extends Disposable {
  readonly name: string;
  prewarmStep(maxItems: number): boolean;
  stats(): PoolStats;
  assertNoLeaks(context: string): void;
}

export class Pool<T extends object> implements PoolHandle, Disposable {
  readonly name: string;

  private readonly spec: PoolSpec<T>;
  private readonly all: T[] = [];
  private readonly free: T[] = [];

  /**
   * Dev-only identity ledger. Counting is not enough to catch the two bugs that actually
   * happen - releasing the same item twice, and releasing something that came from a
   * different pool - because both keep the counter plausible while corrupting the free
   * list. In production this stays null and the pool is pure counters.
   */
  private readonly ledger: Set<T> | null;

  private liveCount = 0;
  private peakLive = 0;
  private exhaustions = 0;
  private disposed = false;

  constructor(spec: PoolSpec<T>) {
    this.spec = spec;
    this.name = spec.name;
    this.ledger = import.meta.env.DEV ? new Set<T>() : null;
  }

  /** Target allocation count: `prewarm`, never above `capacity`. */
  get prewarmTarget(): number {
    return Math.min(this.spec.prewarm, this.spec.capacity);
  }

  get prewarmed(): boolean {
    return this.all.length >= this.prewarmTarget;
  }

  /**
   * Builds at most `maxItems` more items. Returns true once the pool is fully warm, so a
   * loader can call it every frame until it reports done without tracking counts itself.
   */
  prewarmStep(maxItems: number): boolean {
    this.assertUsable();
    const target = this.prewarmTarget;
    let built = 0;
    while (this.all.length < target && built < maxItems) {
      const item = this.spec.create(this.all.length);
      this.all.push(item);
      this.spec.reset(item);
      this.free.push(item);
      built += 1;
    }
    return this.all.length >= target;
  }

  /** Blocking pre-warm. Fine at boot, never on a gameplay path. */
  prewarm(): void {
    while (!this.prewarmStep(this.prewarmTarget)) {
      // prewarmStep bounds itself by the remaining count; this cannot spin.
    }
  }

  /**
   * Returns null when the pool is exhausted. That is a normal, expected outcome on a low
   * tier under a big shatter - callers MUST handle it by dropping the effect, never by
   * allocating a replacement.
   */
  acquire(): T | null {
    this.assertUsable();
    const recycled = this.free.pop();
    if (recycled !== undefined) {
      this.check(recycled);
      return recycled;
    }
    if (this.all.length >= this.spec.capacity) {
      this.exhaustions += 1;
      return null;
    }
    const fresh = this.spec.create(this.all.length);
    this.all.push(fresh);
    this.check(fresh);
    return fresh;
  }

  release(item: T): void {
    this.assertUsable();
    if (this.ledger !== null && !this.ledger.delete(item)) {
      throw new Error(
        `${this.name}: released an item that was not checked out (double release, or an item from another pool).`,
      );
    }
    if (this.liveCount > 0) this.liveCount -= 1;
    this.spec.reset(item);
    this.free.push(item);
  }

  /** Run-teardown path: hands everything back without the caller tracking what it holds. */
  releaseAll(): void {
    this.assertUsable();
    for (const item of this.all) {
      if (this.ledger !== null && !this.ledger.has(item)) continue;
      this.release(item);
    }
    if (this.ledger === null) {
      // No ledger to reconcile against, so rebuild the free list from the full set.
      this.free.length = 0;
      for (const item of this.all) {
        this.spec.reset(item);
        this.free.push(item);
      }
      this.liveCount = 0;
    }
  }

  stats(): PoolStats {
    return {
      name: this.name,
      capacity: this.spec.capacity,
      allocated: this.all.length,
      live: this.liveCount,
      free: this.free.length,
      peakLive: this.peakLive,
      exhaustions: this.exhaustions,
    };
  }

  /**
   * Dev-only. Call at the end of a run: anything still checked out is a leak, and a leak
   * here is a permanent capacity loss that only shows up as "shards stop spawning after
   * twenty minutes", which is impossible to diagnose from the symptom.
   */
  assertNoLeaks(context: string): void {
    if (this.ledger === null || this.ledger.size === 0) return;
    throw new Error(`${this.name}: ${this.ledger.size} item(s) still checked out at ${context}.`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const retire = this.spec.retire;
    if (retire !== undefined) {
      for (const item of this.all) retire(item);
    }
    this.all.length = 0;
    this.free.length = 0;
    this.ledger?.clear();
    this.liveCount = 0;
  }

  private check(item: T): void {
    this.ledger?.add(item);
    this.liveCount += 1;
    if (this.liveCount > this.peakLive) this.peakLive = this.liveCount;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error(`${this.name}: pool used after dispose().`);
  }
}

/**
 * Groups the pools that share a lifetime so boot, teardown and the dev leak check are one
 * call each instead of one per pool - the failure mode being a pool added in step N and
 * forgotten by the shutdown path written in step N-1.
 */
export class PoolRegistry implements Disposable {
  private readonly pools: PoolHandle[] = [];

  add<P extends PoolHandle>(pool: P): P {
    this.pools.push(pool);
    return pool;
  }

  /** Chunked warm across every registered pool. True once they are all full. */
  prewarmStep(maxItems: number): boolean {
    let remaining = maxItems;
    let done = true;
    for (const pool of this.pools) {
      if (remaining <= 0) return false;
      const before = pool.stats().allocated;
      const full = pool.prewarmStep(remaining);
      remaining -= pool.stats().allocated - before;
      if (!full) done = false;
    }
    return done;
  }

  stats(): readonly PoolStats[] {
    return this.pools.map((pool) => pool.stats());
  }

  assertNoLeaks(context: string): void {
    for (const pool of this.pools) pool.assertNoLeaks(context);
  }

  dispose(): void {
    for (const pool of this.pools) pool.dispose();
    this.pools.length = 0;
  }
}
