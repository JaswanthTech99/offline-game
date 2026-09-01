/**
 * kit-foldworks - a fabrication hall of folded plate steel. Everything here is a sheet that
 * has been bent, so the surfaces are large, flat and chamfered rather than moulded, and the
 * highlights are long straight streaks instead of soft round terminators.
 *
 * The corridor is the narrowest in the game, which makes the louvered ceiling and the truss
 * read as pressure. Widening it would cost the kit its only emotional idea.
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
  strutPart,
  v3,
} from './index';

const HALF_W = 3.0;
const H = 4.8;
const GLASS_X = HALF_W - 0.55;

/** [radius, height]: two folds at 0.35 and 2.4 give the plate a crease line to catch light on. */
const FOLD_PROFILE: readonly (readonly [number, number])[] = [
  [0, 0], [0.5, 0], [0.5, 0.15], [0.32, 0.35], [0.34, 2.2], [0.28, 2.4],
  [0.3, 4.3], [0.46, 4.55], [0.46, 4.8], [0, 4.8],
];

const FOLD_PYLON: KitModule = {
  id: 'foldworks-fold-pylon',
  role: 'pylon',
  slot: 'wall',
  surface: 'metal',
  bounds: aabb(v3(HALF_W - 0.5, 0, -0.5), v3(HALF_W + 0.5, H, 0.5)),
  colliders: [cylinderCollider(0.5, H / 2, v3(HALF_W, H / 2, 0), 'static', 'metal')],
  build: (detail) => mergeParts([lathePart(FOLD_PROFILE, detail, HALF_W, 0, 0)]),
};

const TRUSS: KitModule = {
  id: 'foldworks-truss',
  role: 'span',
  slot: 'gate',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W - 0.08, 3.2, -0.12), v3(HALF_W + 0.08, 4.0, 0.12)),
  colliders: [boxCollider(v3(HALF_W, 0.4, 0.1), v3(0, 3.6, 0), 'static', 'metal')],
  build: (detail) => {
    const bays = detail.sweep * 2 + 2;
    const pitch = (HALF_W * 2) / bays;
    const parts: BufferGeometry[] = [
      boxPart(HALF_W * 2, 0.12, 0.12, 0, 3.9, 0),
      boxPart(HALF_W * 2, 0.12, 0.12, 0, 3.3, 0),
    ];
    for (let i = 0; i < bays; i += 1) {
      const left = -HALF_W + i * pitch;
      // Alternating diagonals: a Warren truss, so every bay is braced by one member not two.
      const rise = i % 2 === 0;
      parts.push(
        strutPart(v3(left, rise ? 3.3 : 3.9, 0), v3(left + pitch, rise ? 3.9 : 3.3, 0), 0.045, detail),
      );
    }
    return mergeParts(parts);
  },
};

const VITRINE: KitModule = {
  id: 'foldworks-vitrine',
  role: 'panel',
  slot: 'wall',
  surface: 'glass',
  bounds: aabb(v3(GLASS_X - 0.1, 0.25, -1.5), v3(GLASS_X + 0.1, 4.25, 1.5)),
  colliders: [boxCollider(v3(0.025, 1.95, 1.4), v3(GLASS_X, 2.25, 0), 'breakable', 'glass')],
  build: () => mergeParts([boxPart(0.05, 3.9, 2.8, GLASS_X, 2.25, 0)]),
};

const HINGE_LINTEL: KitModule = {
  id: 'foldworks-hinge-lintel',
  role: 'lintel',
  slot: 'gate',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W - 0.2, H - 0.5, -0.55), v3(HALF_W + 0.2, H, 0.55)),
  colliders: [boxCollider(v3(HALF_W + 0.2, 0.14, 0.45), v3(0, H - 0.14, 0), 'static', 'metal')],
  build: (detail) =>
    mergeParts([
      boxPart(HALF_W * 2 + 0.4, 0.28, 0.9, 0, H - 0.14, 0),
      strutPart(v3(-HALF_W - 0.2, H - 0.36, 0.4), v3(HALF_W + 0.2, H - 0.36, 0.4), 0.09, detail),
    ]),
};

const GRATING: KitModule = {
  id: 'foldworks-grating',
  role: 'plinth',
  slot: 'floor',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W, -0.14, -1.3), v3(HALF_W, 0.06, 1.3)),
  colliders: [boxCollider(v3(HALF_W, 0.07, 1.3), v3(0, -0.07, 0), 'static', 'metal')],
  build: (detail) => {
    const bars = detail.sweep * 3 + 4;
    const pitch = (HALF_W * 2) / bars;
    const parts: BufferGeometry[] = [boxPart(HALF_W * 2, 0.14, 2.6, 0, -0.07, 0)];
    for (let i = 0; i < bars; i += 1) {
      parts.push(boxPart(0.04, 0.05, 2.5, -HALF_W + (i + 0.5) * pitch, 0.025, 0));
    }
    return mergeParts(parts);
  },
};

const LOUVERS: KitModule = {
  id: 'foldworks-louvers',
  role: 'baffle',
  slot: 'ceiling',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W, H - 0.45, -0.9), v3(HALF_W, H, 0.9)),
  colliders: [boxCollider(v3(HALF_W, 0.22, 0.9), v3(0, H - 0.23, 0), 'static', 'metal')],
  build: (detail) => {
    const blades = detail.sweep * 2 + 3;
    const pitch = (HALF_W * 2) / blades;
    const parts: BufferGeometry[] = [];
    for (let i = 0; i < blades; i += 1) {
      // Blades are raked so the ceiling never shows the player a flat unbroken face.
      parts.push(
        boxPart(0.06, 0.44, 1.8).rotateZ(0.5).translate(-HALF_W + (i + 0.5) * pitch, H - 0.23, 0),
      );
    }
    return mergeParts(parts);
  },
};

const STRIP_LIGHT: KitModule = {
  id: 'foldworks-strip',
  role: 'fixture',
  slot: 'ceiling',
  surface: 'emissive-primary',
  bounds: aabb(v3(-0.2, H - 0.12, -1.5), v3(0.2, H, 1.5)),
  colliders: [],
  build: () =>
    mergeParts([
      boxPart(0.3, 0.06, 2.8, 0, H - 0.09, 0),
      boxPart(0.36, 0.05, 2.9, 0, H - 0.025, 0),
    ]),
};

export const KIT_FOLDWORKS: ArchitectureKit = Object.freeze({
  id: 'kit-foldworks',
  displayName: 'Foldworks',
  halfWidth: HALF_W,
  height: H,
  ringSpacing: 3.2,
  modules: Object.freeze([FOLD_PYLON, TRUSS, VITRINE, HINGE_LINTEL, GRATING, LOUVERS, STRIP_LIGHT]),
});
