/**
 * curtainwall-span - contemporary civic construction: stick-system glazing hung off slender
 * mullions, a concrete head beam, a raised access floor. Generic building technology, no
 * identifiable building.
 *
 * This is the kit with the largest uninterrupted glass area in the game. The structure is
 * deliberately thin so the pane, not the frame, is what the player reads as an obstacle -
 * every member here is sized to disappear against the horizon.
 */

import type { BufferGeometry } from 'three/webgpu';

import type { ArchitectureKit, KitModule } from './index';
import { aabb, boxCollider, boxPart, mergeParts, v3 } from './index';

const HALF_W = 3.4;
const H = 5.4;
const MULLION_X = HALF_W - 0.08;
const GLASS_X = HALF_W - 0.2;

const MULLION: KitModule = {
  id: 'curtainwall-mullion',
  role: 'pylon',
  slot: 'wall',
  surface: 'metal',
  bounds: aabb(v3(HALF_W - 0.16, 0, -0.15), v3(HALF_W, H, 0.15)),
  colliders: [boxCollider(v3(0.08, H / 2, 0.15), v3(MULLION_X, H / 2, 0), 'static', 'metal')],
  build: () =>
    mergeParts([
      boxPart(0.06, H, 0.24, MULLION_X, H / 2, 0),
      boxPart(0.14, H, 0.05, MULLION_X, H / 2, 0.115),
      boxPart(0.14, H, 0.05, MULLION_X, H / 2, -0.115),
    ]),
};

const TRANSOM: KitModule = {
  id: 'curtainwall-transom',
  role: 'span',
  slot: 'gate',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W, 2.6, -0.12), v3(HALF_W, 4.5, 0.12)),
  colliders: [
    boxCollider(v3(HALF_W, 0.08, 0.1), v3(0, 2.7, 0), 'static', 'metal'),
    boxCollider(v3(HALF_W, 0.08, 0.1), v3(0, 4.4, 0), 'static', 'metal'),
  ],
  build: () =>
    mergeParts([
      boxPart(HALF_W * 2, 0.16, 0.2, 0, 2.7, 0),
      boxPart(HALF_W * 2, 0.16, 0.2, 0, 4.4, 0),
    ]),
};

const GLAZING: KitModule = {
  id: 'curtainwall-glazing',
  role: 'panel',
  slot: 'wall',
  surface: 'glass',
  bounds: aabb(v3(GLASS_X - 0.1, 0.2, -1.75), v3(GLASS_X + 0.1, 5.1, 1.75)),
  colliders: [boxCollider(v3(0.025, 2.4, 1.7), v3(GLASS_X, 2.65, 0), 'breakable', 'glass')],
  build: (detail) => {
    const parts: BufferGeometry[] = [boxPart(0.05, 4.8, 3.4, GLASS_X, 2.65, 0)];
    if (detail.greeble) {
      // Structural silicone joints. They are what makes a big pane read as a made object
      // rather than as a hole, and they are the first thing the fracture pattern keys to.
      parts.push(boxPart(0.07, 4.8, 0.04, GLASS_X - 0.01, 2.65, 1.7));
      parts.push(boxPart(0.07, 4.8, 0.04, GLASS_X - 0.01, 2.65, -1.7));
      parts.push(boxPart(0.07, 0.04, 3.4, GLASS_X - 0.01, 0.25, 0));
      parts.push(boxPart(0.07, 0.04, 3.4, GLASS_X - 0.01, 5.05, 0));
    }
    return mergeParts(parts);
  },
};

const HEAD_BEAM: KitModule = {
  id: 'curtainwall-head',
  role: 'lintel',
  slot: 'gate',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W - 0.3, H - 0.35, -0.5), v3(HALF_W + 0.3, H, 0.5)),
  colliders: [boxCollider(v3(HALF_W + 0.3, 0.175, 0.5), v3(0, H - 0.175, 0), 'static', 'stone')],
  build: () => mergeParts([boxPart(HALF_W * 2 + 0.6, 0.35, 1.0, 0, H - 0.175, 0)]),
};

const FLOOR_SLAB: KitModule = {
  id: 'curtainwall-slab',
  role: 'plinth',
  slot: 'floor',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W, -0.46, -1.5), v3(HALF_W, 0, 1.5)),
  colliders: [boxCollider(v3(HALF_W, 0.08, 1.5), v3(0, -0.08, 0), 'static', 'stone')],
  build: (detail) => {
    const parts: BufferGeometry[] = [boxPart(HALF_W * 2, 0.16, 3.0, 0, -0.08, 0)];
    if (detail.greeble) {
      // Raised-floor pedestals, visible only where the deck is cut away - cheap depth.
      const count = detail.sweep + 1;
      const pitch = (HALF_W * 2) / count;
      for (let i = 0; i < count; i += 1) {
        parts.push(boxPart(0.1, 0.28, 0.1, -HALF_W + (i + 0.5) * pitch, -0.3, 1.3));
      }
    }
    return mergeParts(parts);
  },
};

const CEILING_RAFT: KitModule = {
  id: 'curtainwall-raft',
  role: 'baffle',
  slot: 'ceiling',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W + 0.4, H - 0.55, -1.3), v3(HALF_W - 0.4, H, 1.3)),
  colliders: [boxCollider(v3(HALF_W - 0.4, 0.04, 1.3), v3(0, H - 0.3, 0), 'static', 'metal')],
  build: () =>
    mergeParts([
      boxPart(HALF_W * 2 - 0.8, 0.08, 2.6, 0, H - 0.3, 0),
      boxPart(0.03, 0.5, 0.03, HALF_W - 1.0, H - 0.25, 1.0),
      boxPart(0.03, 0.5, 0.03, -(HALF_W - 1.0), H - 0.25, 1.0),
      boxPart(0.03, 0.5, 0.03, HALF_W - 1.0, H - 0.25, -1.0),
      boxPart(0.03, 0.5, 0.03, -(HALF_W - 1.0), H - 0.25, -1.0),
    ]),
};

const WALL_WASHER: KitModule = {
  id: 'curtainwall-washer',
  role: 'fixture',
  slot: 'wall',
  surface: 'emissive-primary',
  bounds: aabb(v3(HALF_W - 0.45, 0.2, -1.6), v3(HALF_W - 0.25, 0.5, 1.6)),
  colliders: [],
  build: () =>
    mergeParts([
      boxPart(0.14, 0.14, 3.0, HALF_W - 0.35, 0.42, 0),
      boxPart(0.1, 0.06, 3.1, HALF_W - 0.35, 0.28, 0),
    ]),
};

export const CURTAINWALL_SPAN: ArchitectureKit = Object.freeze({
  id: 'curtainwall-span',
  displayName: 'Curtainwall Span',
  halfWidth: HALF_W,
  height: H,
  ringSpacing: 3.6,
  modules: Object.freeze([MULLION, TRANSOM, GLAZING, HEAD_BEAM, FLOOR_SLAB, CEILING_RAFT, WALL_WASHER]),
});
