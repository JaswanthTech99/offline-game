/**
 * saltglass-rigging - a salt-flat wreck yard where hulls are propped upright and rigged. The
 * vocabulary is generic sailing-ship gear: mast, yard, shrouds, planking, a hung lantern.
 *
 * The sail is glass. That is the joke and the mechanic at once: the largest breakable surface
 * in the kit is also the one the eye expects to be soft, so the first shatter here always
 * lands harder than the player expects.
 */

import type { BufferGeometry } from 'three/webgpu';

import type { ArchitectureKit, KitModule } from './index';
import {
  aabb,
  archPart,
  boxCollider,
  boxPart,
  cylinderCollider,
  lathePart,
  mergeParts,
  strutPart,
  v3,
} from './index';

const HALF_W = 3.8;
const H = 6.0;
const SAIL_X = HALF_W - 0.6;

/** A bowed gantry: a 1.2rad sweep of a 6m circle, seated so its crown clears the corridor. */
const GANTRY_RADIUS = 6.0;
const GANTRY_SWEEP = 1.2;
const GANTRY_CENTER_Y = -0.252;
const GANTRY_HALF_SPAN = GANTRY_RADIUS * Math.sin(GANTRY_SWEEP / 2);

const MAST_PROFILE: readonly (readonly [number, number])[] = [
  [0, 0], [0.38, 0], [0.38, 0.25], [0.3, 0.4], [0.22, 5.2], [0.26, 5.4], [0.26, 5.55], [0, 5.55],
];

const MAST: KitModule = {
  id: 'saltglass-mast',
  role: 'pylon',
  slot: 'wall',
  surface: 'metal',
  bounds: aabb(v3(HALF_W - 0.7, 0, -0.38), v3(HALF_W + 0.7, 5.7, 0.38)),
  colliders: [cylinderCollider(0.38, 2.8, v3(HALF_W, 2.8, 0), 'static', 'metal')],
  build: (detail) =>
    mergeParts([
      lathePart(MAST_PROFILE, detail, HALF_W, 0, 0),
      boxPart(1.4, 0.1, 0.12, HALF_W, 4.2, 0),
      boxPart(0.9, 0.08, 0.1, HALF_W, 5.3, 0),
    ]),
};

const YARD: KitModule = {
  id: 'saltglass-yard',
  role: 'span',
  slot: 'gate',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W - 0.5, 4.1, -0.2), v3(HALF_W + 0.5, 4.7, 0.2)),
  colliders: [boxCollider(v3(HALF_W + 0.5, 0.08, 0.08), v3(0, 4.6, 0), 'static', 'metal')],
  build: (detail) => {
    const parts: BufferGeometry[] = [boxPart(HALF_W * 2 + 1.0, 0.16, 0.16, 0, 4.6, 0)];
    if (detail.greeble) {
      // Footropes sag below the yard. They read as slack even though they are straight rods,
      // because the eye judges slack from the angle at the ends, not from curvature.
      parts.push(strutPart(v3(-HALF_W, 4.52, 0), v3(0, 4.18, 0), 0.025, detail));
      parts.push(strutPart(v3(HALF_W, 4.52, 0), v3(0, 4.18, 0), 0.025, detail));
    }
    return mergeParts(parts);
  },
};

const SAIL_PANE: KitModule = {
  id: 'saltglass-sail-pane',
  role: 'panel',
  slot: 'wall',
  surface: 'glass',
  bounds: aabb(v3(SAIL_X - 0.1, 0.9, -1.9), v3(SAIL_X + 0.1, 5.1, 1.9)),
  colliders: [boxCollider(v3(0.025, 2.0, 1.8), v3(SAIL_X, 3.0, 0), 'breakable', 'glass')],
  build: (detail) => {
    const parts: BufferGeometry[] = [boxPart(0.05, 4.0, 3.6, SAIL_X, 3.0, 0)];
    if (detail.greeble) {
      parts.push(boxPart(0.09, 0.07, 3.7, SAIL_X, 1.02, 0));
      parts.push(boxPart(0.09, 0.07, 3.7, SAIL_X, 4.98, 0));
    }
    return mergeParts(parts);
  },
};

const GANTRY: KitModule = {
  id: 'saltglass-gantry',
  role: 'lintel',
  slot: 'gate',
  surface: 'metal',
  bounds: aabb(v3(-GANTRY_HALF_SPAN - 0.2, 4.5, -0.2), v3(GANTRY_HALF_SPAN + 0.2, H, 0.2)),
  colliders: [boxCollider(v3(GANTRY_HALF_SPAN, 0.2, 0.18), v3(0, 5.6, 0), 'static', 'metal')],
  build: (detail) =>
    mergeParts([archPart(GANTRY_RADIUS, 0.18, GANTRY_SWEEP, detail, 0, GANTRY_CENTER_Y, 0)]),
};

const PLANKING: KitModule = {
  id: 'saltglass-planking',
  role: 'plinth',
  slot: 'floor',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W, -0.18, -1.6), v3(HALF_W, 0.06, 1.6)),
  colliders: [boxCollider(v3(HALF_W, 0.09, 1.6), v3(0, -0.09, 0), 'static', 'stone')],
  build: (detail) => {
    const planks = detail.sweep * 2 + 3;
    const pitch = (HALF_W * 2) / planks;
    const parts: BufferGeometry[] = [boxPart(HALF_W * 2, 0.18, 3.2, 0, -0.09, 0)];
    for (let i = 0; i < planks; i += 1) {
      parts.push(boxPart(pitch * 0.82, 0.05, 3.1, -HALF_W + (i + 0.5) * pitch, 0.025, 0));
    }
    return mergeParts(parts);
  },
};

const SHROUDS: KitModule = {
  id: 'saltglass-shrouds',
  role: 'baffle',
  slot: 'wall',
  surface: 'metal',
  bounds: aabb(v3(HALF_W - 1.2, 0, -0.15), v3(HALF_W, 4.3, 0.15)),
  colliders: [boxCollider(v3(0.6, 2.1, 0.1), v3(HALF_W - 0.6, 2.15, 0), 'static', 'metal')],
  build: (detail) => {
    const lines = detail.sweep + 2;
    const rungs = detail.sweep * 2 + 2;
    const parts: BufferGeometry[] = [];
    for (let i = 0; i < lines; i += 1) {
      const foot = HALF_W - 0.15 - (i * 0.9) / lines;
      parts.push(strutPart(v3(foot, 0.1, 0), v3(HALF_W - 0.3, 4.18, 0), 0.022, detail));
    }
    for (let i = 0; i < rungs; i += 1) {
      parts.push(boxPart(0.85, 0.03, 0.03, HALF_W - 0.55, 0.4 + (i * 3.6) / rungs, 0));
    }
    return mergeParts(parts);
  },
};

/** [radius, height]: a squat storm lantern - wide skirt, pinched waist, domed cap. */
const LANTERN_PROFILE: readonly (readonly [number, number])[] = [
  [0, 4.95], [0.18, 5.0], [0.2, 5.2], [0.14, 5.4], [0.18, 5.5], [0.1, 5.58], [0, 5.6],
];

const LANTERN: KitModule = {
  id: 'saltglass-lantern',
  role: 'fixture',
  slot: 'suspended',
  surface: 'emissive-secondary',
  bounds: aabb(v3(-0.22, 4.9, -0.22), v3(0.22, H, 0.22)),
  colliders: [],
  build: (detail) =>
    mergeParts([lathePart(LANTERN_PROFILE, detail, 0, 0, 0), boxPart(0.04, 0.4, 0.04, 0, 5.8, 0)]),
};

export const SALTGLASS_RIGGING: ArchitectureKit = Object.freeze({
  id: 'saltglass-rigging',
  displayName: 'Saltglass Rigging',
  halfWidth: HALF_W,
  height: H,
  ringSpacing: 4.8,
  modules: Object.freeze([MAST, YARD, SAIL_PANE, GANTRY, PLANKING, SHROUDS, LANTERN]),
});
