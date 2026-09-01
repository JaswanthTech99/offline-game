/**
 * kit-rectilinear-void - the austere baseline the whole game is measured against.
 *
 * Everything is a right angle and nothing is ornamented, so the only curve in frame is the
 * player's own trajectory and the only event is the glass. Every other kit is a departure
 * from this one; if a corridor reads worse than this it is over-decorated, not under-built.
 *
 * Local frame for every module in this folder: origin at the ring centre on the floor, +Y up,
 * corridor running toward -Z, wall modules authored on +X and mirrored by the generator.
 */

import type { BufferGeometry } from 'three/webgpu';

import type { ArchitectureKit, KitModule } from './index';
import { aabb, boxCollider, boxPart, mergeParts, v3 } from './index';

const HALF_W = 3.2;
const H = 5.0;

const PANE_TOP = H - 0.9;
const PANE_BOTTOM = 0.4;
const PANE_HEIGHT = PANE_TOP - PANE_BOTTOM;
const PANE_MID = (PANE_TOP + PANE_BOTTOM) / 2;
const PANE_X = HALF_W - 0.15;

const PYLON: KitModule = {
  id: 'void-pylon',
  role: 'pylon',
  slot: 'wall',
  surface: 'stone',
  bounds: aabb(v3(HALF_W - 0.4, 0, -0.5), v3(HALF_W + 0.4, H, 0.5)),
  colliders: [boxCollider(v3(0.4, H / 2, 0.5), v3(HALF_W, H / 2, 0), 'static', 'stone')],
  build: () =>
    mergeParts([
      boxPart(0.5, H, 0.7, HALF_W, H / 2, 0),
      boxPart(0.8, 0.22, 1.0, HALF_W, 0.11, 0),
      boxPart(0.8, 0.22, 1.0, HALF_W, H - 0.11, 0),
    ]),
};

const SPAN: KitModule = {
  id: 'void-span',
  role: 'span',
  slot: 'gate',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W, H - 1.05, -0.25), v3(HALF_W, H - 0.35, 0.25)),
  colliders: [boxCollider(v3(HALF_W, 0.2, 0.18), v3(0, H - 0.6, 0), 'static', 'metal')],
  build: (detail) => {
    const parts: BufferGeometry[] = [boxPart(HALF_W * 2, 0.4, 0.36, 0, H - 0.6, 0)];
    if (detail.greeble) {
      // Gussets only exist to break the beam's silhouette where it meets the pylons.
      parts.push(boxPart(0.5, 0.32, 0.34, HALF_W - 0.3, H - 0.89, 0));
      parts.push(boxPart(0.5, 0.32, 0.34, -(HALF_W - 0.3), H - 0.89, 0));
    }
    return mergeParts(parts);
  },
};

const PANE: KitModule = {
  id: 'void-pane',
  role: 'panel',
  slot: 'wall',
  surface: 'glass',
  bounds: aabb(v3(PANE_X - 0.26, PANE_BOTTOM - 0.08, -1.6), v3(PANE_X + 0.06, PANE_TOP + 0.08, 1.6)),
  colliders: [
    boxCollider(v3(0.03, PANE_HEIGHT / 2, 1.5), v3(PANE_X, PANE_MID, 0), 'breakable', 'glass'),
  ],
  build: (detail) => {
    const parts: BufferGeometry[] = [boxPart(0.06, PANE_HEIGHT, 3.0, PANE_X, PANE_MID, 0)];
    if (detail.greeble) {
      // A rail top and bottom: the pane needs an edge to catch the horizon light on.
      parts.push(boxPart(0.14, 0.08, 3.1, PANE_X - 0.04, PANE_BOTTOM - 0.04, 0));
      parts.push(boxPart(0.14, 0.08, 3.1, PANE_X - 0.04, PANE_TOP + 0.04, 0));
    }
    return mergeParts(parts);
  },
};

const LINTEL: KitModule = {
  id: 'void-lintel',
  role: 'lintel',
  slot: 'gate',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W - 0.4, H - 0.5, -0.6), v3(HALF_W + 0.4, H, 0.6)),
  colliders: [boxCollider(v3(HALF_W + 0.4, 0.25, 0.6), v3(0, H - 0.25, 0), 'static', 'stone')],
  build: () => mergeParts([boxPart(HALF_W * 2 + 0.8, 0.5, 1.2, 0, H - 0.25, 0)]),
};

const DECK: KitModule = {
  id: 'void-deck',
  role: 'plinth',
  slot: 'floor',
  surface: 'stone',
  bounds: aabb(v3(-HALF_W, -0.24, -1.2), v3(HALF_W, 0.06, 1.2)),
  colliders: [boxCollider(v3(HALF_W, 0.12, 1.2), v3(0, -0.12, 0), 'static', 'stone')],
  build: () =>
    mergeParts([
      boxPart(HALF_W * 2, 0.24, 2.4, 0, -0.12, 0),
      // A nosing strip at the leading edge is the only cue that the floor is made of plates.
      boxPart(HALF_W * 2, 0.06, 0.2, 0, 0.03, 1.1),
    ]),
};

const BAFFLE: KitModule = {
  id: 'void-baffle',
  role: 'baffle',
  slot: 'ceiling',
  surface: 'metal',
  bounds: aabb(v3(-HALF_W, H - 0.35, -0.8), v3(HALF_W, H, 0.8)),
  colliders: [boxCollider(v3(HALF_W, 0.175, 0.8), v3(0, H - 0.175, 0), 'static', 'metal')],
  build: (detail) => {
    const fins = detail.sweep * 2 + 1;
    const pitch = (HALF_W * 2) / fins;
    const parts: BufferGeometry[] = [];
    for (let i = 0; i < fins; i += 1) {
      parts.push(boxPart(0.08, 0.35, 1.6, -HALF_W + (i + 0.5) * pitch, H - 0.175, 0));
    }
    return mergeParts(parts);
  },
};

const LAMP: KitModule = {
  id: 'void-lamp',
  role: 'fixture',
  slot: 'suspended',
  surface: 'emissive-primary',
  bounds: aabb(v3(-0.9, H - 0.82, -0.06), v3(0.9, H, 0.06)),
  colliders: [],
  build: () =>
    mergeParts([
      boxPart(0.05, 0.72, 0.05, 0, H - 0.36, 0),
      boxPart(1.8, 0.1, 0.1, 0, H - 0.77, 0),
    ]),
};

export const KIT_RECTILINEAR_VOID: ArchitectureKit = Object.freeze({
  id: 'kit-rectilinear-void',
  displayName: 'Rectilinear Void',
  halfWidth: HALF_W,
  height: H,
  ringSpacing: 4.0,
  modules: Object.freeze([PYLON, SPAN, PANE, LINTEL, DECK, BAFFLE, LAMP]),
});
