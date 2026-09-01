/**
 * The typed event bus.
 *
 * Every cross-system message in SHATTERPOINT travels through one of these. Direct method
 * calls between systems are the thing this exists to prevent: the corridor generator must
 * be able to tell the audio mixer a pane shattered without holding a reference to it, or
 * the two can never be built, torn down or profiled independently.
 *
 * Declare a channel map and instantiate one emitter per bus:
 *
 *   interface ShatterEvents { 'glass:break': { readonly impulse: number } }
 *   const bus = new Emitter<ShatterEvents>();
 *   const off = bus.on('glass:break', (e) => mixer.play(e.impulse));
 *
 * Both `interface` and `type` maps work: the class is constrained to `object` rather than
 * to `Record<string, unknown>` precisely so an interface - which has no implicit index
 * signature - is a legal map.
 *
 * DISPATCH GUARANTEES, because systems subscribe and unsubscribe from inside handlers:
 *   - A listener added during an emit is NOT called by that emit.
 *   - A listener removed during an emit IS honoured immediately, even mid-dispatch.
 *   - A throwing listener does not stop the ones behind it; the first error is rethrown
 *     once dispatch is complete, so a broken HUD cannot silently eat a physics event and
 *     cannot silently swallow its own bug either.
 *
 * The emit path allocates nothing. It runs inside the frame loop on every shard impact,
 * so an iterator copy per event would be a measurable cost by itself.
 */

/** Documentation alias for a channel map. Not a constraint - see the class comment. */
export type EventMap = Record<string, unknown>;

export type Listener<T> = (payload: T) => void;

/** Idempotent. Calling it twice, or after `clear()`, is defined and does nothing. */
export type Unsubscribe = () => void;

/**
 * One subscription. Listeners are boxed rather than stored bare so that removal can take
 * effect during a dispatch that is already iterating a snapshot of the array: the snapshot
 * still holds this object, and the flag inside it is shared with the live list.
 *
 * `fn` is typed `Listener<never>` because parameter contravariance makes every
 * `Listener<T>` assignable to it. That is what lets one array hold the listeners of a
 * heterogeneous channel map without `any` anywhere in the file.
 */
interface Slot {
  readonly fn: Listener<never>;
  active: boolean;
}

export class Emitter<M extends object> {
  /**
   * Copy-on-write. Mutating a channel replaces its array rather than editing it, so an
   * in-flight `emit` keeps iterating the list it started with and cannot skip an entry
   * because a handler spliced the one in front of it.
   */
  private readonly channels = new Map<string, readonly Slot[]>();

  on<K extends keyof M & string>(type: K, listener: Listener<M[K]>): Unsubscribe {
    const slot: Slot = { fn: listener, active: true };
    const existing = this.channels.get(type);
    this.channels.set(type, existing === undefined ? [slot] : [...existing, slot]);
    return () => {
      this.detach(type, slot);
    };
  }

  /** Unsubscribes itself before invoking the listener, so a re-entrant emit cannot loop. */
  once<K extends keyof M & string>(type: K, listener: Listener<M[K]>): Unsubscribe {
    const off = this.on(type, (payload: M[K]) => {
      off();
      listener(payload);
    });
    return off;
  }

  /**
   * Removal by function identity. Prefer the `Unsubscribe` returned by `on` - this exists
   * for call sites that keep a long-lived bound method and never held the closure.
   */
  off<K extends keyof M & string>(type: K, listener: Listener<M[K]>): void {
    const slots = this.channels.get(type);
    if (slots === undefined) return;
    for (const slot of slots) {
      if (slot.fn === (listener as Listener<never>)) {
        this.detach(type, slot);
        return;
      }
    }
  }

  emit<K extends keyof M & string>(type: K, payload: M[K]): void {
    const slots = this.channels.get(type);
    if (slots === undefined) return;

    let failure: unknown;
    let failed = false;

    for (const slot of slots) {
      if (!slot.active) continue;
      try {
        (slot.fn as Listener<M[K]>)(payload);
      } catch (error) {
        // Keep the first failure and keep dispatching: the systems behind a broken
        // listener are usually the ones that keep the frame coherent.
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }

    if (failed) throw failure;
  }

  listenerCount<K extends keyof M & string>(type: K): number {
    const slots = this.channels.get(type);
    if (slots === undefined) return 0;
    let live = 0;
    for (const slot of slots) if (slot.active) live += 1;
    return live;
  }

  /** Drops one channel, or every channel when called with no argument. */
  clear<K extends keyof M & string>(type?: K): void {
    if (type === undefined) {
      for (const slots of this.channels.values()) {
        for (const slot of slots) slot.active = false;
      }
      this.channels.clear();
      return;
    }
    const slots = this.channels.get(type);
    if (slots === undefined) return;
    for (const slot of slots) slot.active = false;
    this.channels.delete(type);
  }

  private detach(type: string, slot: Slot): void {
    if (!slot.active) return;
    // Flag first: an emit already walking a snapshot that contains this slot must skip it.
    slot.active = false;
    const slots = this.channels.get(type);
    if (slots === undefined) return;
    const next = slots.filter((candidate) => candidate !== slot);
    if (next.length === 0) this.channels.delete(type);
    else this.channels.set(type, next);
  }
}
