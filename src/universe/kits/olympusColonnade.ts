/**
 * olympus-colonnade - a mountain-temple approach. Public-domain classical antiquity only:
 * post-and-lintel, entasis, stylobate, tripod brazier. No deity, no emblem, no likeness.
 *
 * The colonnade exists to give the run a rhythm the void kit cannot: columns are wide and
 * spaced, so the eye reads the corridor as a sequence of gaps rather than a tube, and the
 * glass sits in the gaps where the horizon light is already pouring through.
 */

import type { BufferGeometry } from 'three/webgpu';

import type { ArchitectureKit, KitModule } from './index';
import {
  aabb,
  boxCollider,
  boxPart,
  cylinderCollider,
  lathePart,
  mergeParts,
  repeatAround,
  strutPart,
  v3,
} from './index';

const HALF_W = 4.0;
const H = 6.5;
const COL_H = 5.6;
const BRAZIER_X = HALF_W - 1.1;

/** [radius, height] bottom to top. The 0.62 -> 0.38 taper is the entasis that keeps a stone
 * column from reading as concave; straight-sided columns look wrong and always have. */
const SHAFT: readonly (readonly [number, number])[] = [
  [0, 0], [0.62, 0], [0.62, 0.2], [0.5, 0.3], [0.48, 1.6], [0.45, 3.2],
  [0.4, 4.6], [0.38, 4.95], [0.5, 5.12], [0.58, 5.3], [0.58, 5.35], [0, 5.35],
];

const COLUMN: KitModule = {
  id: 'colonnade-column',
  role: 'pylon',
  slot: 'wall',
  surface: 'stone',
  bounds: aabb(v3(HALF_W - 0.62, 0, -0.62), v3(HALF_W + 0.62, COL_H, 0.62)),
  colliders: [cylinderCollider(0.62, COL_H / 2, v3(HALF_W, COL_H / 2, 0), 'static', 'stone')],
  build: (detail) => {
    const parts: BufferGeometry[] = [
      lathePart(SHAFT, detail, HALF_W, 0, 0),
      boxPart(1.2, 0.24, 1.2, HALF_W, 5.47, 0),
    ];
    if (detail.greeble) {
      parts.push(
        ...repeatAround(detail.radial, (_, angle) =>
          boxPart(0.1, 4.3, 0.1, HALF_W + Math.cos(angle) * 0.42, 2.75, Math.sin(angle) * 0.42),
        ),
      );
    }
    return mergeParts(parts);
  },
};

const ARCHITRAVE: KitModule = {
  id: 'colonnade-architrave',
  role: 'span',
  slot: 'gate',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W - 0.8, COL_H, -0.55), v3(HALF_W + 0.8, 6.2, 0.55)),
  colliders: [boxCollider(v3(HALF_W + 0.8, 0.3, 0.55), v3(0, 5.9, 0), 'static', 'stone')],
  build: (detail) => {
    const parts: BufferGeometry[] = [boxPart(HALF_W * 2 + 1.6, 0.6, 1.1, 0, 5.9, 0)];
    if (detail.greeble) {
      const count = detail.sweep * 2 + 3;
      const pitch = (HALF_W * 2 + 1.6) / count;
      for (let i = 0; i < count; i += 1) {
        parts.push(boxPart(0.22, 0.5, 0.14, -HALF_W - 0.8 + (i + 0.5) * pitch, 5.9, 0.48));
      }
    }
    return mergeParts(parts);
  },
};

const METOPE_PANE: KitModule = {
  id: 'colonnade-metope-pane',
  role: 'panel',
  slot: 'wall',
  surface: 'glass',
  bounds: aabb(v3(HALF_W - 0.34, 0.82, -2.0), v3(HALF_W - 0.16, 5.28, 2.0)),
  colliders: [boxCollider(v3(0.04, 2.15, 1.9), v3(HALF_W - 0.25, 3.05, 0), 'breakable', 'glass')],
  build: () => mergeParts([boxPart(0.08, 4.3, 3.8, HALF_W - 0.25, 3.05, 0)]),
};

const PEDIMENT: KitModule = {
  id: 'colonnade-pediment',
  role: 'lintel',
  slot: 'gate',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W - 0.8, 6.2, -0.65), v3(HALF_W + 0.8, H, 0.65)),
  colliders: [boxCollider(v3(HALF_W + 0.8, 0.15, 0.65), v3(0, 6.35, 0), 'static', 'stone')],
  build: (detail) => {
    // Corbelled courses rather than a solid wedge: the stepped silhouette catches rim light
    // on every course, which is the whole reason a gable reads at distance.
    const courses = detail.sweep * 2;
    const courseHeight = (H - 6.2) / courses;
    const parts: BufferGeometry[] = [];
    for (let i = 0; i < courses; i += 1) {
      const width = (HALF_W * 2 + 1.6) * (1 - i / courses);
      parts.push(boxPart(width, courseHeight, 1.3, 0, 6.2 + (i + 0.5) * courseHeight, 0));
    }
    return mergeParts(parts);
  },
};

const STYLOBATE: KitModule = {
  id: 'colonnade-stylobate',
  role: 'plinth',
  slot: 'floor',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W - 1.1, -0.54, -1.6), v3(HALF_W + 1.1, 0, 1.6)),
  colliders: [boxCollider(v3(HALF_W + 1.1, 0.27, 1.6), v3(0, -0.27, 0), 'static', 'stone')],
  build: () =>
    mergeParts([
      boxPart(HALF_W * 2 + 1.0, 0.18, 2.6, 0, -0.09, 0),
      boxPart(HALF_W * 2 + 1.6, 0.18, 2.9, 0, -0.27, 0),
      boxPart(HALF_W * 2 + 2.2, 0.18, 3.2, 0, -0.45, 0),
    ]),
};

const COFFER: KitModule = {
  id: 'colonnade-coffer',
  role: 'baffle',
  slot: 'ceiling',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W, 6.2, -1.3), v3(HALF_W, H, 1.3)),
  colliders: [boxCollider(v3(HALF_W, 0.15, 1.3), v3(0, 6.35, 0), 'static', 'stone')],
  build: (detail) => {
    const ribs = detail.sweep * 2 + 1;
    const pitch = (HALF_W * 2) / ribs;
    const parts: BufferGeometry[] = [
      boxPart(HALF_W * 2, 0.3, 0.16, 0, 6.35, 0.9),
      boxPart(HALF_W * 2, 0.3, 0.16, 0, 6.35, -0.9),
    ];
    for (let i = 0; i < ribs; i += 1) {
      parts.push(boxPart(0.16, 0.3, 2.6, -HALF_W + (i + 0.5) * pitch, 6.35, 0));
    }
    return mergeParts(parts);
  },
};

/** [radius, height]: a shallow bowl with an inner wall, so the flame reads as contained. */
const BOWL: readonly (readonly [number, number])[] = [
  [0, 0.9], [0.34, 0.92], [0.42, 1.12], [0.42, 1.24], [0.32, 1.16], [0, 1.0],
];

const TRIPOD: KitModule = {
  id: 'colonnade-tripod',
  role: 'fixture',
  slot: 'wall',
  surface: 'emissive-secondary',
  bounds: aabb(v3(BRAZIER_X - 0.45, 0, -0.45), v3(BRAZIER_X + 0.45, 1.26, 0.45)),
  colliders: [cylinderCollider(0.42, 0.62, v3(BRAZIER_X, 0.62, 0), 'static', 'metal')],
  build: (detail) =>
    mergeParts([
      lathePart(BOWL, detail, BRAZIER_X, 0, 0),
      ...repeatAround(3, (_, angle) =>
        strutPart(
          v3(BRAZIER_X + Math.cos(angle) * 0.34, 0, Math.sin(angle) * 0.34),
          v3(BRAZIER_X, 0.95, 0),
          0.05,
          detail,
        ),
      ),
    ]),
};

export const OLYMPUS_COLONNADE: ArchitectureKit = Object.freeze({
  id: 'olympus-colonnade',
  displayName: 'Olympus Colonnade',
  halfWidth: HALF_W,
  height: H,
  ringSpacing: 5.0,
  modules: Object.freeze([COLUMN, ARCHITRAVE, METOPE_PANE, PEDIMENT, STYLOBATE, COFFER, TRIPOD]),
});
