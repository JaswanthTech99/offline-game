/**
 * THE ONE PLACE IN SHATTERPOINT THAT READS THE WALL CLOCK.
 *
 * A run must replay from its seed. That is not a style preference: the seed is what makes a
 * challenge shareable and a replay honest, and a single `Date.now()` on a simulation path
 * silently breaks both in a way no test catches, because the test also ran at "now".
 *
 * Wall time is still real, though - a save record without a timestamp cannot be sorted,
 * expired or migrated. So the wall clock is not banned, it is CENTRALISED: it exists here,
 * behind an injectable function, and nowhere else. tools/audit.mjs exempts exactly this file
 * from the nondeterminism rule, the same way it exempts core/Engine.ts from the frame-loop
 * rule and core/Quality.ts from the budget-literal rule. If a second file needs the time, it
 * takes a `WallClock` as a parameter and the composition root hands it `systemClock`.
 *
 * It lives under src/save/ rather than src/core/ to say what it is for: persistence
 * metadata. Nothing that steps the simulation may take one.
 */

import type { EpochMs } from './Schema';

/** Injectable so a test can pin time and assert on the record it produced. */
export type WallClock = () => EpochMs;

export const systemClock: WallClock = () => Date.now();

/**
 * A clock that returns a fixed instant, then the same instant forever. For tests and for the
 * export path, where every record in one export should carry ONE timestamp rather than a
 * spread of instants that makes a bulk write look like a session.
 */
export function fixedClock(atMs: EpochMs): WallClock {
  return () => atMs;
}
