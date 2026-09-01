/**
 * ragnarok-bifrost-span - a mythic burning bridge, drawn from public-domain Norse material
 * only: a prismatic causeway, guyed masts, a segmental arch, no figure and no heraldry.
 *
 * The deck itself is the emissive element here rather than a fixture, so the player is flying
 * over the brightest surface in the scene. That inverts the usual lighting read and is the
 * entire identity of the kit - keep the ceiling dim or it collapses into every other corridor.
 */

import type { BufferGeometry } from 'three/webgpu';

import type { ArchitectureKit, KitModule } from './index';
import {
  aabb,
  archPart,
  boxCollider,
  boxPart,
  cylinderCollider,
  cylinderPart,
  lathePart,
  mergeParts,
  strutPart,
  v3,
} from './index';

const HALF_W = 3.6;
const H = 5.8;
const MAST_TOP = 5.0;

/** Segmental arch: a 1.6rad sweep of a 5.02m circle clears the corridor without a tall crown. */
const ARCH_RADIUS = 5.02;
const ARCH_SWEEP = 1.6;
const ARCH_CENTER_Y = 0.503;

const MAST: readonly (readonly [number, number])[] = [
  [0, 0], [0.45, 0], [0.45, 0.3], [0.34, 0.5], [0.26, 4.6], [0.3, 4.8], [0.3, 5.0], [0, 5.0],
];

const MAST_MODULE: KitModule = {
  id: 'bifrost-mast',
  role: 'pylon',
  slot: 'wall',
  surface: 'metal',
  bounds: aabb(v3(HALF_W - 0.45, 0, -0.45), v3(HALF_W + 0.45, 5.2, 0.45)),
  colliders: [cylinderCollider(0.45, 2.6, v3(HALF_W, 2.6, 0), 'static', 'metal')],
  build: (detail) => {
    const parts: BufferGeometry[] = [lathePart(MAST, detail, HALF_W, 0, 0)];
    if (detail.greeble) {
      // Banded collars, not carving: the mast reads as forged, and bands survive at distance.
      for (let i = 0; i < detail.sweep; i += 1) {
        parts.push(cylinderPart(0.34, 0.34, 0.12, detail, HALF_W, 0.9 + i * 1.1, 0));
      }
    }
    return mergeParts(parts);
  },
};

const DECK: KitModule = {
  id: 'bifrost-deck',
  role: 'plinth',
  slot: 'floor',
  surface: 'emissive-primary',
  bounds: aabb(v3(-HALF_W, -0.22, -1.5), v3(HALF_W, 0.06, 1.5)),
  colliders: [boxCollider(v3(HALF_W, 0.11, 1.5), v3(0, -0.11, 0), 'static', 'metal')],
  build: (detail) => {
    const planks = detail.sweep * 3 + 2;
    const pitch = (HALF_W * 2) / planks;
    const parts: BufferGeometry[] = [boxPart(HALF_W * 2, 0.22, 3.0, 0, -0.11, 0)];
    for (let i = 0; i < planks; i += 1) {
      parts.push(boxPart(pitch * 0.7, 0.06, 2.9, -HALF_W + (i + 0.5) * pitch, 0.03, 0));
    }
    return mergeParts(parts);
  },
};

const ARCH: KitModule = {
  id: 'bifrost-arch',
  role: 'lintel',
  slot: 'gate',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W - 0.25, 3.85, -0.24), v3(HALF_W + 0.25, 5.78, 0.24)),
  // Only the crown is collidable: the haunches sit outside the flight envelope, and a curved
  // collider chain there would cost more than anything the player can ever touch.
  colliders: [boxCollider(v3(HALF_W, 0.25, 0.22), v3(0, 5.35, 0), 'static', 'metal')],
  build: (detail) => mergeParts([archPart(ARCH_RADIUS, 0.22, ARCH_SWEEP, detail, 0, ARCH_CENTER_Y, 0)]),
};

const STAY: KitModule = {
  id: 'bifrost-stay',
  role: 'span',
  slot: 'gate',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W - 0.08, 0, -1.5), v3(HALF_W + 0.08, 5.05, 1.5)),
  // The cables are deliberately non-collidable - a thrown ball threading between them is the
  // shot the kit exists to offer. Only the tie beam stops anything.
  colliders: [boxCollider(v3(HALF_W, 0.06, 0.06), v3(0, 4.6, 0), 'static', 'metal')],
  build: (detail) =>
    mergeParts([
      boxPart(HALF_W * 2, 0.12, 0.12, 0, 4.6, 0),
      strutPart(v3(HALF_W, MAST_TOP, 0), v3(0, 0.1, -1.4), 0.035, detail),
      strutPart(v3(-HALF_W, MAST_TOP, 0), v3(0, 0.1, -1.4), 0.035, detail),
      strutPart(v3(HALF_W, MAST_TOP, 0), v3(0, 0.1, 1.4), 0.035, detail),
      strutPart(v3(-HALF_W, MAST_TOP, 0), v3(0, 0.1, 1.4), 0.035, detail),
    ]),
};

const BALUSTRADE: KitModule = {
  id: 'bifrost-balustrade',
  role: 'panel',
  slot: 'wall',
  surface: 'glass',
  bounds: aabb(v3(HALF_W - 0.62, 0.1, -1.7), v3(HALF_W - 0.38, 1.85, 1.7)),
  colliders: [boxCollider(v3(0.03, 0.8, 1.6), v3(HALF_W - 0.5, 0.95, 0), 'breakable', 'glass')],
  build: () =>
    mergeParts([
      boxPart(0.06, 1.6, 3.2, HALF_W - 0.5, 0.95, 0),
      boxPart(0.12, 0.08, 3.3, HALF_W - 0.5, 1.79, 0),
    ]),
};

const CANOPY_RIBS: KitModule = {
  id: 'bifrost-canopy-ribs',
  role: 'baffle',
  slot: 'ceiling',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W, 5.5, -1.4), v3(HALF_W, H, 1.4)),
  colliders: [boxCollider(v3(HALF_W, 0.15, 1.4), v3(0, 5.65, 0), 'static', 'metal')],
  build: (detail) => {
    const ribs = detail.sweep + 1;
    const pitch = 2.4 / ribs;
    const parts: BufferGeometry[] = [boxPart(0.16, 0.16, 2.8, 0, 5.65, 0)];
    for (let i = 0; i < ribs; i += 1) {
      parts.push(boxPart(HALF_W * 2, 0.14, 0.14, 0, 5.65, -1.2 + (i + 0.5) * pitch));
    }
    return mergeParts(parts);
  },
};

const RUNE_LAMP: KitModule = {
  id: 'bifrost-rune-lamp',
  role: 'fixture',
  slot: 'suspended',
  surface: 'emissive-secondary',
  bounds: aabb(v3(-0.18, 4.7, -0.18), v3(0.18, H, 0.18)),
  colliders: [],
  build: (detail) =>
    mergeParts([
      boxPart(0.04, 0.6, 0.04, 0, 5.5, 0),
      cylinderPart(0.16, 0.1, 0.5, detail, 0, 4.95, 0),
    ]),
};

export const RAGNAROK_BIFROST_SPAN: ArchitectureKit = Object.freeze({
  id: 'ragnarok-bifrost-span',
  displayName: 'Bifrost Span',
  halfWidth: HALF_W,
  height: H,
  ringSpacing: 4.5,
  modules: Object.freeze([MAST_MODULE, DECK, ARCH, STAY, BALUSTRADE, CANOPY_RIBS, RUNE_LAMP]),
});
