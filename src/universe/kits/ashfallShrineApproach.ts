/**
 * ashfall-shrine-approach - a processional way through a shrine precinct under falling ash.
 * Vernacular timber-and-stone forms only: paired gateposts, an upswept crossbeam, latticed
 * screens, a stepped terrace, a pedestal lantern. Nothing here belongs to any existing work.
 *
 * The kit's job is reverence, which means SLOW silhouettes: the widest ring spacing after the
 * colonnade and the heaviest overhead mass, so the corridor keeps pressing down on the player
 * even while the palette stays soft.
 */

import type { BufferGeometry } from 'three/webgpu';

import type { ArchitectureKit, KitModule } from './index';
import {
  aabb,
  boxCollider,
  boxPart,
  cylinderCollider,
  cylinderPart,
  lathePart,
  mergeParts,
  v3,
} from './index';

const HALF_W = 3.4;
const H = 5.6;
const SCREEN_X = HALF_W - 0.45;
const LANTERN_X = HALF_W - 1.0;
/** atan(rise / run) for the canopy slabs; shallow enough that ash settles on them. */
const EAVE_PITCH = 0.138;

const POST_PROFILE: readonly (readonly [number, number])[] = [
  [0, 0], [0.44, 0], [0.44, 0.22], [0.36, 0.38], [0.3, 4.4], [0.33, 4.55], [0.33, 4.7], [0, 4.7],
];

const GATEPOST: KitModule = {
  id: 'shrine-gatepost',
  role: 'pylon',
  slot: 'wall',
  surface: 'stone',
  bounds: aabb(v3(HALF_W - 0.44, 0, -0.44), v3(HALF_W + 0.44, 4.8, 0.44)),
  colliders: [cylinderCollider(0.44, 2.35, v3(HALF_W, 2.35, 0), 'static', 'stone')],
  build: (detail) =>
    mergeParts([
      lathePart(POST_PROFILE, detail, HALF_W, 0, 0),
      cylinderPart(0.4, 0.4, 0.16, detail, HALF_W, 3.9, 0),
    ]),
};

const CROSSBEAM: KitModule = {
  id: 'shrine-crossbeam',
  role: 'span',
  slot: 'gate',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W - 1.4, 3.8, -0.3), v3(HALF_W + 1.4, 4.95, 0.3)),
  colliders: [
    boxCollider(v3(HALF_W + 0.8, 0.15, 0.25), v3(0, 4.55, 0), 'static', 'stone'),
    boxCollider(v3(HALF_W + 0.2, 0.11, 0.18), v3(0, 3.95, 0), 'static', 'stone'),
  ],
  build: () =>
    mergeParts([
      boxPart(HALF_W * 2 + 1.6, 0.3, 0.5, 0, 4.55, 0),
      boxPart(HALF_W * 2 + 0.4, 0.22, 0.36, 0, 3.95, 0),
      // The upswept tips are the whole silhouette. A straight beam reads as scaffolding.
      boxPart(1.2, 0.26, 0.45).rotateZ(0.2).translate(-(HALF_W + 0.75), 4.62, 0),
      boxPart(1.2, 0.26, 0.45).rotateZ(-0.2).translate(HALF_W + 0.75, 4.62, 0),
    ]),
};

const SCREEN: KitModule = {
  id: 'shrine-screen',
  role: 'panel',
  slot: 'wall',
  surface: 'glass',
  bounds: aabb(v3(SCREEN_X - 0.13, 0.4, -1.7), v3(SCREEN_X + 0.13, 3.8, 1.7)),
  colliders: [boxCollider(v3(0.025, 1.6, 1.6), v3(SCREEN_X, 2.1, 0), 'breakable', 'glass')],
  build: (detail) => {
    const parts: BufferGeometry[] = [boxPart(0.05, 3.2, 3.2, SCREEN_X, 2.1, 0)];
    if (detail.greeble) {
      const bays = detail.sweep + 2;
      const pitch = 3.2 / bays;
      for (let i = 1; i < bays; i += 1) {
        parts.push(boxPart(0.09, 3.2, 0.06, SCREEN_X - 0.04, 2.1, -1.6 + i * pitch));
      }
      parts.push(boxPart(0.09, 0.06, 3.3, SCREEN_X - 0.04, 3.66, 0));
      parts.push(boxPart(0.09, 0.06, 3.3, SCREEN_X - 0.04, 0.54, 0));
    }
    return mergeParts(parts);
  },
};

const CANOPY: KitModule = {
  id: 'shrine-canopy',
  role: 'lintel',
  slot: 'gate',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W - 1.1, 4.85, -1.05), v3(HALF_W + 1.1, 5.75, 1.05)),
  colliders: [boxCollider(v3(HALF_W + 0.9, 0.2, 1.0), v3(0, 5.2, 0), 'static', 'stone')],
  build: () =>
    mergeParts([
      boxPart(4.34, 0.16, 1.9).rotateZ(EAVE_PITCH).translate(-(HALF_W + 0.9) / 2, 5.3, 0),
      boxPart(4.34, 0.16, 1.9).rotateZ(-EAVE_PITCH).translate((HALF_W + 0.9) / 2, 5.3, 0),
      boxPart(0.5, 0.3, 2.0, 0, 5.5, 0),
    ]),
};

const TERRACE: KitModule = {
  id: 'shrine-terrace',
  role: 'plinth',
  slot: 'floor',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W - 1.2, -0.54, -2.0), v3(HALF_W + 1.2, 0, 2.0)),
  colliders: [boxCollider(v3(HALF_W + 1.2, 0.27, 2.0), v3(0, -0.27, 0), 'static', 'stone')],
  build: () =>
    mergeParts([
      boxPart(HALF_W * 2 + 1.2, 0.18, 3.2, 0, -0.09, 0),
      boxPart(HALF_W * 2 + 1.8, 0.18, 3.6, 0, -0.27, 0),
      boxPart(HALF_W * 2 + 2.4, 0.18, 4.0, 0, -0.45, 0),
    ]),
};

const RAFTERS: KitModule = {
  id: 'shrine-rafters',
  role: 'baffle',
  slot: 'ceiling',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W, H - 0.4, -1.5), v3(HALF_W, H, 1.5)),
  colliders: [boxCollider(v3(HALF_W, 0.2, 1.5), v3(0, H - 0.2, 0), 'static', 'stone')],
  build: (detail) => {
    const rafters = detail.sweep + 2;
    const pitch = 2.8 / rafters;
    const parts: BufferGeometry[] = [boxPart(0.22, 0.26, 3.0, 0, H - 0.2, 0)];
    for (let i = 0; i < rafters; i += 1) {
      parts.push(boxPart(HALF_W * 2, 0.18, 0.18, 0, H - 0.2, -1.4 + (i + 0.5) * pitch));
    }
    return mergeParts(parts);
  },
};

/** [radius, height]: pedestal, shaft, firebox, flared roof, finial - read bottom to top. */
const LANTERN_PROFILE: readonly (readonly [number, number])[] = [
  [0, 0], [0.3, 0], [0.3, 0.12], [0.16, 0.24], [0.14, 1.0], [0.2, 1.1], [0.34, 1.16],
  [0.3, 1.5], [0.42, 1.56], [0.34, 1.76], [0.1, 1.86], [0.08, 1.98], [0, 2.02],
];

const LANTERN: KitModule = {
  id: 'shrine-lantern',
  role: 'fixture',
  slot: 'wall',
  surface: 'emissive-secondary',
  bounds: aabb(v3(LANTERN_X - 0.42, 0, -0.42), v3(LANTERN_X + 0.42, 2.05, 0.42)),
  colliders: [cylinderCollider(0.42, 1.02, v3(LANTERN_X, 1.02, 0), 'static', 'stone')],
  build: (detail) => mergeParts([lathePart(LANTERN_PROFILE, detail, LANTERN_X, 0, 0)]),
};

export const ASHFALL_SHRINE_APPROACH: ArchitectureKit = Object.freeze({
  id: 'ashfall-shrine-approach',
  displayName: 'Shrine Approach',
  halfWidth: HALF_W,
  height: H,
  ringSpacing: 4.2,
  modules: Object.freeze([GATEPOST, CROSSBEAM, SCREEN, CANOPY, TERRACE, RAFTERS, LANTERN]),
});
