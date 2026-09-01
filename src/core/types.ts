/**
 * Shared primitives. Every module in SHATTERPOINT imports from here rather than
 * re-declaring its own aliases, so a change to the tick contract is a change in
 * exactly one place.
 *
 * Branding policy: identity-shaped values (Seed, RunId, ResourceId) are branded
 * because mixing them up is silent and catastrophic - a run keyed by the wrong id
 * corrupts the save, a seed taken from the wrong source destroys reproducibility.
 * Quantities that are constantly added, scaled and compared (Millis, Alpha, Frames)
 * are deliberately NOT branded: branding them would force a cast at every literal in
 * every data table and buy nothing, because the compiler already stops you assigning
 * a Millis where a Color is wanted.
 */

declare const BRAND: unique symbol;

/** Nominal typing helper. `Brand<number, 'Foo'>` is a number nothing else can impersonate. */
export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/**
 * PRNG seed. Always an unsigned 32-bit integer: the runtime RNG is a 32-bit state
 * machine, so anything wider silently truncates and breaks replay of the same run.
 */
export type Seed = Brand<number, 'Seed'>;

/** Identifies one play session end-to-end: telemetry, save slot, replay. */
export type RunId = Brand<string, 'RunId'>;

/** Identifies one loaded resource inside the loader's registry. */
export type ResourceId = Brand<string, 'ResourceId'>;

/** Milliseconds. Wall-clock and simulation time are both expressed in this unit. */
export type Millis = number;

/**
 * Fixed-step interpolation factor in [0,1]: how far the renderer is between the last
 * completed physics step and the next one. This is the ONLY quantity allowed to make
 * rendering smoother than 60 Hz - never a scaled timestep.
 */
export type Alpha = number;

/**
 * A whole-frame count. Slow-motion is expressed as "skip N frames of physics", never
 * as a scaled dt, so the sim stays bit-identical between normal and slowed play.
 */
export type Frames = number;

/** Normalised 0..1 scalar (opacity, fraction of screen, progress through a beat). */
export type Unit = number;

export const asSeed = (value: number): Seed => (value >>> 0) as Seed;
export const asRunId = (value: string): RunId => value as RunId;
export const asResourceId = (value: string): ResourceId => value as ResourceId;

/**
 * Anything holding GPU or WASM memory. `dispose()` must be idempotent: the shutdown
 * path walks the whole graph and will reach shared resources more than once.
 */
export interface Disposable {
  dispose(): void;
}

/**
 * The engine's only update contract. `fixedUpdate` runs at the fixed 60 Hz rate an
 * integer number of times per frame - possibly zero, possibly several - and `dt` is
 * the same constant on every call. `frame` runs exactly once per rendered frame and
 * must not mutate simulation state; it only interpolates what fixedUpdate produced.
 */
export interface Tickable {
  fixedUpdate(dt: Millis): void;
  frame(alpha: Alpha): void;
}

/** Opt-in extras a Tickable may also implement; the loop feature-detects them. */
export interface Pausable {
  setPaused(paused: boolean): void;
}

interface ResourceHandleBase {
  readonly id: ResourceId;
  readonly url: string;
}

/**
 * A reference to something the loader owns. Handles are plain data so they can live in
 * frozen theme/kit tables; the payload lives in the loader's registry and is fetched by
 * id. Nothing outside the loader may hold the payload directly - that is how pre-warm
 * and eviction stay correct.
 */
export type ResourceHandle =
  | (ResourceHandleBase & { readonly kind: 'texture'; readonly srgb: boolean })
  | (ResourceHandleBase & { readonly kind: 'ktx2'; readonly srgb: boolean })
  | (ResourceHandleBase & { readonly kind: 'hdr' })
  | (ResourceHandleBase & { readonly kind: 'lut'; readonly size: number })
  | (ResourceHandleBase & { readonly kind: 'gltf'; readonly draco: boolean })
  | (ResourceHandleBase & { readonly kind: 'audio'; readonly streamed: boolean })
  | (ResourceHandleBase & { readonly kind: 'json' });

export type ResourceKind = ResourceHandle['kind'];

/** Narrowing helper so call sites stop writing the same `h.kind === 'x'` by hand. */
export const isResourceKind = <K extends ResourceKind>(
  handle: ResourceHandle,
  kind: K,
): handle is Extract<ResourceHandle, { kind: K }> => handle.kind === kind;

/**
 * Compile-time exhaustiveness guard. Reaching this at runtime means a union grew and a
 * switch did not, so it throws loudly instead of silently doing nothing.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}
