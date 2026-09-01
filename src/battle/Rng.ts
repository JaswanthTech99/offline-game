/**
 * SEEDING.
 *
 * The PRNG itself (`createRng`, mulberry32) lives with the battle contract in `./types` so
 * that the interface and its one implementation cannot drift apart. This module owns the
 * other half of the problem: turning the human-readable things a run is identified by - a
 * run id, a universe id, a roster id, a subsystem name - into the unsigned 32-bit integer
 * that machine wants, deterministically.
 *
 * `Math.random()` and `Date.now()` are forbidden on every runtime path in SHATTERPOINT.
 * They are not merely discouraged: one call to either anywhere in the chain that feeds a
 * seed makes the whole run unreproducible, which costs us replays, deterministic tests and
 * the ability to have a bug report mean anything. Seeds enter the game from exactly two
 * places - the save file and the URL - and both are strings, which is why `hashSeed` exists.
 */

import type { Seed } from '../core/types';
import { asSeed } from '../core/types';
import { createRng } from './types';
import type { Rng } from './types';

export type { Rng } from './types';
export { createRng } from './types';

/** FNV-1a 32-bit. Chosen for being byte-order independent and trivially auditable. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** murmur3 finaliser constants - pure avalanche, no accumulation. */
const AVALANCHE_A = 0x85ebca6b;
const AVALANCHE_B = 0xc2b2ae35;

/**
 * Text to seed. Stable across sessions, platforms and builds: the same string always
 * produces the same run, which is the contract the whole determinism story rests on.
 *
 * FNV-1a alone is not enough. It leaves the low bits of short, similar inputs strongly
 * correlated, and mulberry32 seeds its state directly from those bits, so two neighbouring
 * roster names would open with two visibly similar performances. The murmur3 finaliser
 * after it avalanches the whole word before anything is allowed to depend on it.
 */
export function hashSeed(text: string): Seed {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, AVALANCHE_A);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, AVALANCHE_B);
  hash ^= hash >>> 16;

  return asSeed(hash);
}

/** Joins parts with a separator that cannot occur inside a kebab-case id before hashing. */
export function hashSeedParts(...parts: readonly string[]): Seed {
  return hashSeed(parts.join(' '));
}

/** The normal entry point: a run seed as the player sees it, straight to a usable stream. */
export function createRngFromString(text: string): Rng {
  return createRng(hashSeed(text));
}

/**
 * Fork by name rather than by a magic stream number. Numeric stream ids are a collision
 * waiting to happen once four systems are each choosing their own, and a collision means
 * two systems silently drawing the identical sequence. A name cannot collide by accident
 * and it reads at the call site.
 */
export function forkByName(parent: Rng, name: string): Rng {
  return parent.fork(hashSeed(name));
}
