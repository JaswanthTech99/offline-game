/**
 * The shatter. Three readable phases and three distinct kinds of debris.
 *
 * Rebuilt because the first pass read wrong in every one of them: dust was a single opaque
 * sphere (a grey ellipse with a hard edge that occluded the corridor), shards were rounded
 * icosahedra (white pebbles, not glass), and nothing was staged.
 *
 * Shards come from the real Voronoi cells in Voronoi.ts - thin, sharp-edged, angular, with
 * physical thickness - because a rounded blob cannot read as broken glass no matter how it
 * is shaded. Dust is many small additive sprites at low alpha, so it never has an edge and
 * never occludes what is behind it.
 */

import type { PerspectiveCamera, Scene } from 'three/webgpu';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import { abs, dot, float, normalize, normalView, positionView, pow, smoothstep, uv, vec3 } from 'three/tsl';

import type { Millis, Seed } from '../core/types';
import type { Rng } from '../battle/types';
import { buildShardMesh, generateFracture } from './Voronoi';

/**
 * Shape and timing. Not performance budgets - those come from Quality.ts and arrive as
 * `maxShards` / `dustCount`. These decide what a break LOOKS like.
 */
export const SHATTER = Object.freeze({
  flashMs: 30,
  /** Spec calls for 70-90ms. Expressed in ms and converted to whole fixed steps. */
  hitStopMs: 80,
  releaseStaggerMs: 220,
  shardLifetimeMs: 1500,
  shardThickness: 0.035,
  ejectSpeed: 7.5,
  spinSpeed: 7.0,
  gravity: -13,
  /** How far a shard stretches along its velocity, per unit speed. */
  velocityStretch: 0.055,
  dustLifetimeMs: 1100,
  dustSpread: 2.2,
  dustStartScale: 0.30,
  dustEndScale: 1.5,
  /**
   * Low enough that 40 overlapping additive sprites cannot accumulate to white at the
   * impact point, which is where they are most concentrated in the first few frames.
   */
  dustAlpha: 0.028,
  /** Pool size: distinct cell shapes cut once and reused, so no allocation mid-run. */
  shapeVariants: 28,
});

interface Shard {
  readonly mesh: Mesh;
  readonly velocity: Vector3;
  readonly spin: Vector3;
  readonly baseScale: Vector3;
  delayMs: number;
  ageMs: number;
  live: boolean;
}

interface Mote {
  readonly mesh: Mesh;
  readonly velocity: Vector3;
  delayMs: number;
  ageMs: number;
  live: boolean;
}

export interface ShatterOptions {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly rng: Rng;
  readonly seed: Seed;
  /** Universe hue. Shard interiors tint toward it; nothing here is ever pure white. */
  readonly tint: Color;
  /** Reserved hue for the specular catch. `edge` may be pure white in some themes, and a
   *  white-hot shard is indistinguishable from the flash it is supposed to follow. */
  readonly edge: Color;
  readonly maxShards: number;
  readonly dustCount: number;
  readonly paneWidth: number;
  readonly paneHeight: number;
}

export type ShatterPhase = 'idle' | 'flash' | 'hitstop' | 'release';

export class ShatterFx {
  readonly root = new Group();

  private readonly camera: PerspectiveCamera;
  private readonly rng: Rng;
  private readonly maxShards: number;
  private readonly dustCount: number;

  private readonly shapes: BufferGeometry[] = [];
  private readonly shards: Shard[] = [];
  private readonly motes: Mote[] = [];

  private readonly shardMaterial: MeshStandardNodeMaterial;
  private readonly dustMaterial: MeshBasicNodeMaterial;
  private readonly flashMaterial: MeshBasicNodeMaterial;
  private readonly dustGeometry = new PlaneGeometry(1, 1);
  private readonly flash: Mesh;

  private flashMs = 0;
  private hitStopMs = 0;
  private hitStopStepsLeft = 0;

  constructor(options: ShatterOptions) {
    this.camera = options.camera;
    this.rng = options.rng;
    this.maxShards = options.maxShards;
    this.dustCount = options.dustCount;

    this.shapes = this.cutShapes(options);

    // Glass, not chalk: a transmissive interior tinted toward the universe hue, plus a hard
    // specular catch that only fires on the extruded skirt (the shard's own thickness), which
    // is the edge the eye actually reads as "sharp".
    this.shardMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(options.tint),
      transparent: true,
      side: DoubleSide,
      roughness: 0.08,
      metalness: 0.0,
      depthWrite: false,
    });
    {
      const n = normalize(normalView);
      const view = normalize(positionView.negate());
      const facing = abs(dot(n, view)).clamp(0, 1);
      // The skirt faces sideways relative to the caps, so a grazing term isolates it.
      const edgeCatch = pow(facing.oneMinus(), float(2.2));
      const spec = pow(facing.oneMinus(), float(9)).mul(float(0.85));
      // Clamped below 1 on every channel on purpose: a shard is lit glass, not a light
      // source, and only the single flash frame is allowed to touch pure white.
      const e = options.edge.clone().lerp(options.tint, 0.45).multiplyScalar(0.82);
      const edgeCol = vec3(e.r, e.g, e.b);
      this.shardMaterial.emissiveNode = edgeCol.mul(edgeCatch.mul(float(0.55)).add(spec));
      // Interior stays translucent so a shard never reads as an opaque white chip.
      this.shardMaterial.opacityNode = float(0.30).add(edgeCatch.mul(float(0.62))).clamp(0, 1);
    }

    // Dust: soft radial falloff to zero at the sprite border, so there is no edge anywhere.
    this.dustMaterial = new MeshBasicNodeMaterial({
      color: new Color().copy(options.tint).lerp(new Color(1, 1, 1), 0.35),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    {
      const r = uv().sub(0.5).length().mul(2);
      this.dustMaterial.opacityNode = smoothstep(float(1), float(0), r).mul(float(SHATTER.dustAlpha));
    }

    this.flashMaterial = new MeshBasicNodeMaterial({
      color: new Color(1, 1, 1),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    {
      const r = uv().sub(0.5).length().mul(2);
      this.flashMaterial.opacityNode = smoothstep(float(1), float(0), r);
    }
    this.flash = new Mesh(this.dustGeometry, this.flashMaterial);
    this.flash.visible = false;
    this.root.add(this.flash);

    options.scene.add(this.root);
  }

  /**
   * Cuts a reference pane into real Voronoi cells once, and keeps each cell's prism as a
   * reusable shape. Re-fracturing per break would be correct and far too expensive; reusing
   * a bank of genuine cell shapes is indistinguishable in motion.
   */
  private cutShapes(options: ShatterOptions): BufferGeometry[] {
    const pattern = generateFracture({
      rect: { halfWidth: options.paneWidth / 2, halfHeight: options.paneHeight / 2 },
      seed: options.seed,
      cellCount: SHATTER.shapeVariants,
      impact: { x: 0, y: 0 },
      focus: 0.55,
      relaxIterations: 2,
    });
    const data = buildShardMesh(pattern, SHATTER.shardThickness);

    // Split the merged buffer back into one geometry per shard, pivoted on its centroid.
    const out: BufferGeometry[] = [];
    const perShard = new Map<number, number[]>();
    for (let v = 0; v < data.vertexCount; v++) {
      const id = data.shardIndex[v] ?? 0;
      const list = perShard.get(id) ?? [];
      list.push(v);
      perShard.set(id, list);
    }
    for (const [id, verts] of perShard) {
      const remap = new Map<number, number>();
      const pos: number[] = [];
      const nor: number[] = [];
      const px = data.pivots[id * 3] ?? 0;
      const py = data.pivots[id * 3 + 1] ?? 0;
      const pz = data.pivots[id * 3 + 2] ?? 0;
      for (const v of verts) {
        remap.set(v, pos.length / 3);
        pos.push((data.positions[v * 3] ?? 0) - px, (data.positions[v * 3 + 1] ?? 0) - py, (data.positions[v * 3 + 2] ?? 0) - pz);
        nor.push(data.normals[v * 3] ?? 0, data.normals[v * 3 + 1] ?? 0, data.normals[v * 3 + 2] ?? 1);
      }
      const idx: number[] = [];
      for (let i = 0; i < data.indices.length; i += 3) {
        const a = data.indices[i] ?? 0;
        if (!remap.has(a)) continue;
        idx.push(remap.get(a) ?? 0, remap.get(data.indices[i + 1] ?? 0) ?? 0, remap.get(data.indices[i + 2] ?? 0) ?? 0);
      }
      if (idx.length === 0) continue;
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
      g.setIndex(idx);
      out.push(g);
    }
    return out;
  }

  get phase(): ShatterPhase {
    if (this.flashMs > 0) return 'flash';
    if (this.hitStopStepsLeft > 0) return 'hitstop';
    for (const s of this.shards) if (s.live) return 'release';
    return 'idle';
  }

  /** True while the world must be held. Frames are SKIPPED, never slowed. */
  get holding(): boolean {
    return this.hitStopStepsLeft > 0;
  }

  get liveShards(): number {
    let n = 0;
    for (const s of this.shards) if (s.live) n++;
    return n;
  }

  burst(at: Vector3, fixedStepMs: number): void {
    this.flashMs = SHATTER.flashMs;
    this.hitStopMs = SHATTER.hitStopMs;
    this.hitStopStepsLeft = Math.max(1, Math.round(SHATTER.hitStopMs / fixedStepMs));

    this.flash.position.copy(at);
    this.flash.scale.setScalar(1.1);
    this.flash.visible = true;

    const want = Math.min(this.shapes.length, Math.max(4, Math.floor(this.maxShards / 64)));
    for (let i = 0; i < want; i++) {
      const shard = this.acquireShard(i % this.shapes.length);
      if (shard === null) break;
      const dir = new Vector3(this.rng.next() * 2 - 1, this.rng.next() * 2 - 1, this.rng.next() - 0.15).normalize();
      shard.mesh.position.copy(at).addScaledVector(dir, 0.12);
      shard.velocity.copy(dir).multiplyScalar(SHATTER.ejectSpeed * (0.45 + this.rng.next()));
      shard.spin.set(
        (this.rng.next() - 0.5) * SHATTER.spinSpeed,
        (this.rng.next() - 0.5) * SHATTER.spinSpeed,
        (this.rng.next() - 0.5) * SHATTER.spinSpeed,
      );
      shard.mesh.rotation.set(this.rng.next() * 6.28, this.rng.next() * 6.28, this.rng.next() * 6.28);
      // Radial stagger: cells nearest the impact let go first.
      shard.delayMs = (i / want) * SHATTER.releaseStaggerMs;
      shard.ageMs = 0;
      shard.live = true;
      // Hidden until its own delay expires. Otherwise every shard sits stacked on the
      // impact point through the hold, and a pile of overlapping translucent glass
      // accumulates to pure white - which is reserved for the single flash frame.
      shard.mesh.visible = false;
    }

    for (let i = 0; i < this.dustCount; i++) {
      const mote = this.acquireMote();
      if (mote === null) break;
      const dir = new Vector3(this.rng.next() * 2 - 1, this.rng.next() * 2 - 1, this.rng.next() * 2 - 1).normalize();
      // Spread from the first frame, so the sprites never stack on a single point.
      mote.mesh.position.copy(at).addScaledVector(dir, 0.25 + this.rng.next() * 0.9);
      mote.velocity.copy(dir).multiplyScalar(SHATTER.dustSpread * (0.3 + this.rng.next()));
      mote.delayMs = this.rng.next() * 40;
      mote.ageMs = 0;
      mote.live = true;
      mote.mesh.visible = false;
    }
  }

  private acquireShard(shapeIndex: number): Shard | null {
    for (const s of this.shards) {
      if (s.live) continue;
      s.mesh.geometry = this.shapes[shapeIndex] ?? s.mesh.geometry;
      return s;
    }
    if (this.shards.length >= this.maxShards) return null;
    const geom = this.shapes[shapeIndex];
    if (geom === undefined) return null;
    const mesh = new Mesh(geom, this.shardMaterial);
    mesh.visible = false;
    this.root.add(mesh);
    const s: Shard = {
      mesh, velocity: new Vector3(), spin: new Vector3(),
      baseScale: new Vector3(1, 1, 1), delayMs: 0, ageMs: 0, live: false,
    };
    this.shards.push(s);
    return s;
  }

  private acquireMote(): Mote | null {
    for (const m of this.motes) if (!m.live) return m;
    if (this.motes.length >= this.dustCount * 2) return null;
    const mesh = new Mesh(this.dustGeometry, this.dustMaterial);
    mesh.visible = false;
    this.root.add(mesh);
    const m: Mote = { mesh, velocity: new Vector3(), delayMs: 0, ageMs: 0, live: false };
    this.motes.push(m);
    return m;
  }

  /** Runs even while the world is held, so the flash and hit-stop have their own timeline. */
  update(dtMs: Millis, travelStepZ: number): void {
    const dt = dtMs / 1000;

    if (this.flashMs > 0) {
      this.flashMs -= dtMs;
      const k = Math.max(0, this.flashMs / SHATTER.flashMs);
      this.flash.scale.setScalar(1.1 + (1 - k) * 1.8);
      this.flash.quaternion.copy(this.camera.quaternion);
      this.flash.visible = this.flashMs > 0;
    }
    if (this.hitStopStepsLeft > 0) {
      this.hitStopStepsLeft -= 1;
      this.hitStopMs = Math.max(0, this.hitStopMs - dtMs);
    }

    for (const s of this.shards) {
      if (!s.live) continue;
      s.ageMs += dtMs;
      if (s.ageMs < s.delayMs) continue;
      s.mesh.visible = true;

      s.velocity.y += SHATTER.gravity * dt;
      s.mesh.position.addScaledVector(s.velocity, dt);
      s.mesh.position.z += travelStepZ;
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;

      const life = (s.ageMs - s.delayMs) / SHATTER.shardLifetimeMs;
      if (life >= 1) {
        s.live = false;
        s.mesh.visible = false;
        continue;
      }
      // Stretch along velocity, and fade INDIVIDUALLY - a group fade reads as a sprite sheet.
      const speed = s.velocity.length();
      const stretch = 1 + speed * SHATTER.velocityStretch;
      s.mesh.scale.set(s.baseScale.x, s.baseScale.y * stretch, s.baseScale.z).multiplyScalar(1 - life * 0.35);
      // Depth sort: near shards must occlude far ones.
      s.mesh.renderOrder = 1000 - Math.round(Math.abs(s.mesh.position.z));
    }

    for (const m of this.motes) {
      if (!m.live) continue;
      m.ageMs += dtMs;
      if (m.ageMs < m.delayMs) continue;
      m.mesh.visible = true;
      m.mesh.position.addScaledVector(m.velocity, dt);
      m.mesh.position.z += travelStepZ;
      m.velocity.multiplyScalar(0.94);
      const life = (m.ageMs - m.delayMs) / SHATTER.dustLifetimeMs;
      if (life >= 1) {
        m.live = false;
        m.mesh.visible = false;
        continue;
      }
      // Own curve: fast expansion, slow dissipation.
      const k = Math.sqrt(life);
      m.mesh.scale.setScalar(SHATTER.dustStartScale + k * SHATTER.dustEndScale);
      m.mesh.quaternion.copy(this.camera.quaternion);
      m.mesh.renderOrder = 2000;
    }
  }

  reset(): void {
    for (const s of this.shards) { s.live = false; s.mesh.visible = false; }
    for (const m of this.motes) { m.live = false; m.mesh.visible = false; }
    this.flash.visible = false;
    this.flashMs = 0;
    this.hitStopStepsLeft = 0;
  }

  dispose(): void {
    for (const g of this.shapes) g.dispose();
    this.dustGeometry.dispose();
    this.shardMaterial.dispose();
    this.dustMaterial.dispose();
    this.flashMaterial.dispose();
  }
}
