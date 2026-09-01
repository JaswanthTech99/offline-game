/**
 * The playable slice: a glass corridor you fly down, throw balls at, and break.
 *
 * This is deliberately self-contained and integrates by composition rather than by wiring
 * the full Run/Rapier/Shatter stack together. It owns its own kinematics because at this
 * scale a rigid-body world buys nothing: a thrown ball is a parabola and a pane is a plane,
 * and the closed-form answer is both cheaper and exactly reproducible.
 *
 * Every colour is read from the UniverseTheme. Nothing here invents a palette, so pointing
 * it at another universe re-dresses the whole level for free.
 */

import {
  BoxGeometry,
  BufferGeometry,
  Euler,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Color,
  Fog,
  Group,
  IcosahedronGeometry,
  Mesh,
  AdditiveBlending,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

import type { Millis, Seed, Tickable, Disposable } from '../core/types';
import type { UniverseTheme } from '../universe/UniverseTheme';
import {
  dot,
  float,
  normalize,
  normalView,
  positionView,
  pow,
  smoothstep,
  vec3,
} from 'three/tsl';
import { createRng } from '../battle/Rng';
import { glassMaterial } from './GlassMaterial';
import type { GlassFeatures } from './GlassMaterial';
import type { Rng } from '../battle/types';
import {
  BALLS_AT_START,
  BALL_COST_PER_THROW,
  BALL_PENALTY_ON_IMPACT,
  BALLS_MAX,
  BALLS_PER_CRYSTAL,
  multiplierForStreak,
} from './Balance';

/**
 * Geometry and feel. Separate from Quality.ts on purpose: these are level-design numbers,
 * not performance budgets, and they are the ones a designer wants to move.
 */
const TUNING = Object.freeze({
  corridorHalfWidth: 5,
  corridorHalfHeight: 3.4,
  spawnDistance: 150,
  despawnBehind: 6,
  rowSpacing: 26,
  rowsAhead: 8,
  travelSpeed: 17,
  ballSpeed: 78,
  gravity: -13,
  ballRadius: 0.34,
  ballLifetime: 4200,
  paneWidth: 3.0,
  paneHeight: 3.0,
  shardsPerPane: 14,
  shardLifetime: 1500,
  shardSpread: 5.5,
  crystalRadius: 0.72,
  crystalSpinRate: 1.7,
  ringSpacing: 10.5,
  ringsDeep: 14,
  panesPerFace: 5,
  ribSpacing: 13,
  maxLiveBalls: 12,
  maxLiveShards: 220,
  /* --- three-phase shatter --- */
  flashMs: 34,
  hitStopFrames: 4,
  shardDelayMaxMs: 190,
  dustLifetimeMs: 900,
  dustMaxScale: 4.2,
});

interface Ball {
  readonly mesh: Mesh;
  readonly velocity: Vector3;
  ageMs: number;
  live: boolean;
}

interface Shard {
  /** Staggered per-cell release. A pane that lets go all at once reads as a puff. */
  delayMs: number;
  readonly mesh: Mesh;
  readonly velocity: Vector3;
  readonly spin: Vector3;
  ageMs: number;
  live: boolean;
}

/** A pane or a crystal. One record type because they differ only in what hitting them does. */
interface Target {
  readonly mesh: Mesh;
  kind: 'pane' | 'crystal';
  live: boolean;
  /** Panes only: how many more hits it takes. Laminated glass is 2. */
  hits: number;
}

export interface PlayfieldEvents {
  onBallsChanged(balls: number): void;
  onScoreChanged(score: number, multiplier: number, streak: number): void;
  onRunOver(): void;
}

export interface PlayfieldOptions {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly theme: UniverseTheme;
  readonly seed: Seed;
  readonly events: PlayfieldEvents;
  /** QUALITY[tier].corridorRings. The corridor never invents its own depth. */
  readonly ringBudget: number;
  /** Which optical properties the tier pays for. */
  readonly glass: GlassFeatures;
  /** Coloured floor pools under lit panes. Dropped below ULTRA_4K. */
  readonly caustics: boolean;
}

export class Playfield implements Tickable, Disposable {
  readonly root = new Group();

  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly theme: UniverseTheme;
  private readonly events: PlayfieldEvents;
  private readonly rng: Rng;

  private readonly balls: Ball[] = [];
  private readonly shards: Shard[] = [];
  private readonly targets: Target[] = [];

  private readonly paneGeometry = new PlaneGeometry(TUNING.paneWidth, TUNING.paneHeight);
  private readonly shardGeometry = new IcosahedronGeometry(0.22, 0);
  private readonly ballGeometry = new SphereGeometry(TUNING.ballRadius, 20, 14);
  private readonly crystalGeometry = new OctahedronGeometry(TUNING.crystalRadius, 0);
  private readonly causticGeometry = new PlaneGeometry(TUNING.paneWidth * 1.5, TUNING.paneWidth * 1.5);

  private readonly paneMaterial: MeshStandardNodeMaterial;
  private readonly paneCrackedMaterial: MeshStandardNodeMaterial;
  private readonly shardMaterial: MeshStandardNodeMaterial;
  private readonly ballMaterial: MeshStandardNodeMaterial;
  private readonly crystalMaterial: MeshBasicNodeMaterial;
  private readonly causticMaterial: MeshBasicNodeMaterial | null;
  private readonly caustics: Mesh[] = [];
  private readonly ribMaterial: MeshStandardNodeMaterial;
  private readonly wallMaterial: MeshStandardNodeMaterial;

  private readonly plateMaterial: MeshStandardNodeMaterial;
  private readonly mullionMaterial: MeshStandardNodeMaterial;
  private readonly stripMaterial: MeshBasicNodeMaterial;
  private readonly seamMaterial: MeshBasicNodeMaterial;
  private readonly wallBands: (MeshStandardNodeMaterial | undefined)[] = [];
  private readonly shell = new Group();
  private readonly instanced: InstancedMesh[] = [];
  private readonly shellGeometry: BufferGeometry[] = [];
  private elementCount = 0;
  private readonly emissives: Mesh[] = [];
  private readonly ringsDeep: number;
  private readonly bounceLight: PointLight;
  private readonly ballLight: PointLight;
  private readonly ribs: Mesh[] = [];
  private readonly keyLight: PointLight;

  private travel = 0;
  private nextRowZ = 0;
  private ballsLeft = BALLS_AT_START;
  private score = 0;
  private streak = 0;
  private multiplier = 1;
  private over = false;
  private spinPhase = 0;
  private flashMs = 0;
  /** Frames still to be SKIPPED. Hit-stop is a counter, never a scaled timestep. */
  private hitStopFrames = 0;
  private dustMs = 0;
  private readonly flashMesh: Mesh;
  private readonly dustMesh: Mesh;

  constructor(options: PlayfieldOptions) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.theme = options.theme;
    this.events = options.events;
    this.rng = createRng(options.seed);
    // Tier-driven density. The corridor is the most expensive thing in the frame, so it is
    // the first thing the budget is allowed to shorten.
    this.ringsDeep = Math.max(4, Math.min(TUNING.ringsDeep, options.ringBudget));

    const t = this.theme;

    // Glass reads as an edge, not a surface: low opacity, high emissive rim. That is the
    // whole trick that makes a pane look like glass rather than a coloured rectangle.
    // The key sits down the corridor and slightly above, so the streak reads as a smear
    // across a pane rather than a dot on its centre.
    this.paneMaterial = glassMaterial({
      tint: t.glass.tint,
      edge: t.glass.edge,
      keyDirection: [0.15, 0.35, 1],
      features: options.glass,
      baseOpacity: t.glass.alpha,
    });
    this.paneCrackedMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.glass.tint),
      emissive: new Color().copy(t.emissive.secondary),
      emissiveIntensity: 1.1,
      transparent: true,
      opacity: 0.5,
      roughness: 0.3,
      metalness: 0.0,
    });
    this.shardMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.glass.tint),
      emissive: new Color().copy(t.glass.edge),
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.8,
      roughness: 0.15,
      metalness: 0.1,
    });
    // A three-point studio read, which is what makes a sphere look spherical rather than
    // like a painted circle: a hard key hotspot, a soft fill on the shadow side, a rim from
    // behind, and an environment band sampling the universe's own horizon colour so the
    // ball belongs to the room it is flying through.
    this.ballMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.metal),
      roughness: 0.14,
      metalness: 1.0,
    });
    {
      const n = normalize(normalView);
      const view = normalize(positionView.negate());
      const keyDir = normalize(vec3(0.35, 0.6, 0.72));
      const rimDir = normalize(vec3(-0.2, 0.1, -1));

      const hotspot = pow(dot(n, keyDir).clamp(0, 1), float(64)).mul(float(1.6));
      const fill = dot(n, keyDir).clamp(0, 1).oneMinus().mul(float(0.16));
      const rim = pow(dot(n, view).clamp(0, 1).oneMinus(), float(3)).mul(
        dot(n, rimDir).clamp(0, 1),
      ).mul(float(0.9));
      // The band slides against the surface as the ball turns, so the reflection reads as
      // an environment being sampled rather than a texture painted on.
      const band = smoothstep(float(0.12), float(0), n.y.add(view.y.mul(float(0.35))).abs())
        .mul(float(0.5));

      const keyCol = vec3(t.emissive.primary.r, t.emissive.primary.g, t.emissive.primary.b);
      const horizon = vec3(t.sky.horizon.r, t.sky.horizon.g, t.sky.horizon.b);
      this.ballMaterial.emissiveNode = keyCol
        .mul(hotspot.add(rim))
        .add(horizon.mul(band))
        .add(keyCol.mul(fill));
    }
    // Emissive-only, so the crystal stays exempt from any depth attenuation applied to the
    // surfaces around it - it is meant to be one of the few things that reaches full white.
    this.crystalMaterial = new MeshBasicNodeMaterial({
      color: new Color().copy(t.emissive.primary),
      transparent: true,
      opacity: 0.95,
    });
    this.ribMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.metal),
      emissive: new Color().copy(t.emissive.secondary),
      emissiveIntensity: 0.3,
      roughness: 0.55,
      metalness: 0.85,
    });
    this.wallMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.stone),
      roughness: 0.9,
      metalness: 0.05,
    });

    // Floor and ceiling plates are lower-roughness than the walls so they pick up a blurred
    // reflection of the strips above them - that reflection is most of what sells depth.
    this.plateMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.stone).multiplyScalar(0.34),
      roughness: 0.34,
      metalness: 0.55,
    });
    this.mullionMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.metal).multiplyScalar(0.42),
      roughness: 0.42,
      metalness: 0.95,
    });
    this.stripMaterial = new MeshBasicNodeMaterial({ color: new Color().copy(t.emissive.primary) });
    this.seamMaterial = new MeshBasicNodeMaterial({
      color: new Color().copy(t.emissive.secondary),
      transparent: true,
      opacity: 0.7,
    });

    // A lit pane throws a coloured pool onto the floor under it. Additive and unlit, so it
    // reads as transmitted light rather than as a painted decal, and it is the first thing
    // the degradation table drops because it costs a transparent pass per pane.
    this.causticMaterial = options.caustics
      ? new MeshBasicNodeMaterial({
          color: new Color().copy(t.glass.edge),
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          blending: AdditiveBlending,
        })
      : null;

    // Phase 1 of the shatter: a single bright frame at the impact point. An unlit sphere
    // so no light rig can dim it, and it is scaled to zero the instant its window closes.
    this.flashMesh = new Mesh(
      new SphereGeometry(1, 12, 8),
      new MeshBasicNodeMaterial({ color: new Color(1, 1, 1), transparent: true, blending: AdditiveBlending, depthWrite: false }),
    );
    this.flashMesh.visible = false;
    this.root.add(this.flashMesh);

    // Phase 3's dust, on its own dissipation curve so it outlives the shards.
    this.dustMesh = new Mesh(
      new SphereGeometry(1, 12, 8),
      new MeshBasicNodeMaterial({ color: new Color().copy(t.glass.edge), transparent: true, opacity: 0.16, blending: AdditiveBlending, depthWrite: false }),
    );
    this.dustMesh.visible = false;
    this.root.add(this.dustMesh);

    this.buildShell();

    // FOUR light contributions, not one blob.
    // 1. Key, from the aperture. Hard-clamped: an unbounded point light at the vanishing
    //    point is what clipped the old frame to white across a third of the image.
    this.keyLight = new PointLight(new Color().copy(t.emissive.primary), 24, 38, 2.0);
    this.keyLight.position.set(0, 0.8, -22);
    this.root.add(this.keyLight);

    // 2. Cool bounce off the floor plates, upward onto the underside of everything.
    this.bounceLight = new PointLight(new Color().copy(t.emissive.secondary), 8, 26, 2.2);
    this.bounceLight.position.set(0, -TUNING.corridorHalfHeight + 0.4, -9);
    this.root.add(this.bounceLight);

    // 3. A moving light carried by the ball, so a throw brightens what it passes.
    this.ballLight = new PointLight(new Color().copy(t.emissive.primary), 0, 14, 2);
    this.root.add(this.ballLight);

    // 4. Ambient floor fill, keeping shadow sides readable without lifting the black point.
    const fill = new PointLight(new Color().copy(t.glass.edge), 2.4, 40, 2.0);
    fill.position.set(0, 1.2, -3);
    this.root.add(fill);

    // Fog is what turns a tube of boxes into distance. Tied to the theme's haze so each
    // universe recedes at its own rate.
    // Fog reaches full density inside the built corridor, so the deepest ring is a
    // low-contrast silhouette rather than a lit wall floating in the dark.
    const corridorDepth = this.ringsDeep * TUNING.ringSpacing;
    this.scene.fog = new Fog(
      new Color().copy(t.sky.low).multiplyScalar(0.45),
      corridorDepth * 0.12,
      corridorDepth * 0.95,
    );
    this.scene.background = new Color().copy(t.sky.low).multiplyScalar(0.35);

    this.scene.add(this.root);

    for (let i = 0; i < TUNING.rowsAhead; i++) this.spawnRow();
    this.publishBalls();
    this.publishScore();
  }

  // ---- construction -------------------------------------------------------------------

  /**
   * The corridor shell. Density is the whole point — a tunnel of four rectangles reads as a
   * prototype no matter how good the lighting is — but density that blows the draw-call
   * budget is not a win either, so every repeated piece is an InstancedMesh.
   *
   * That collapses ~440 individual meshes into one draw call per material family. The whole
   * corridor scrolls as a single parent Group and wraps at the full field length, so no
   * per-instance matrix is ever rewritten after construction: the treadmill is one
   * transform, not four hundred.
   *
   * Ring count is tier-driven; the fog is retuned to match so a shallower corridor still
   * ends in haze rather than a visible end wall.
   */
  private buildShell(): void {
    const hw = TUNING.corridorHalfWidth;
    const hh = TUNING.corridorHalfHeight;
    const rings = this.ringsDeep;
    const spacing = TUNING.ringSpacing;
    const n = TUNING.panesPerFace;

    const paneW = (hw * 2) / n;
    const paneH = (hh * 2) / n;

    const plateGeom = new PlaneGeometry(paneW * 0.94, spacing * 0.9);
    const wallGeom = new PlaneGeometry(spacing * 0.9, paneH * 0.94);
    const mullionRing = new BoxGeometry(hw * 2 + 0.2, 0.1, 0.1);
    const mullionPost = new BoxGeometry(0.1, hh * 2, 0.1);
    const subMullion = new BoxGeometry(0.05, paneH * 0.9, 0.05);
    const stripGeom = new BoxGeometry(paneW * 0.20, 0.04, spacing * 0.68);
    const seamGeom = new BoxGeometry(0.05, 0.04, spacing * 0.88);
    const cofferGeom = new BoxGeometry(paneW * 0.82, 0.14, spacing * 0.72);
    const bandGeom = new BoxGeometry(0.12, 0.34, spacing * 0.5);
    this.shellGeometry.push(
      plateGeom, wallGeom, mullionRing, mullionPost, subMullion,
      stripGeom, seamGeom, cofferGeom, bandGeom,
    );

    // Pass one: collect a transform per instance, per family. Nothing is allocated in the
    // renderer until the counts are known, so no InstancedMesh is ever over-sized.
    const plates: Matrix4[] = [];
    const wallsByBand = new Map<number, Matrix4[]>();
    const mullions: Matrix4[] = [];
    const pilasters: Matrix4[] = [];
    const subs: Matrix4[] = [];
    const strips: Matrix4[] = [];
    const seams: Matrix4[] = [];
    const coffers: Matrix4[] = [];
    const bands: Matrix4[] = [];

    const m = new Matrix4();
    const q = new Quaternion();
    const e = new Euler();
    const pos = new Vector3();
    const one = new Vector3(1, 1, 1);
    const make = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Matrix4 => {
      e.set(rx, ry, rz);
      q.setFromEuler(e);
      pos.set(x, y, z);
      return m.compose(pos, q, one).clone();
    };
    const push = (into: Matrix4[], x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void => {
      into.push(make(x, y, z, rx, ry, rz));
    };

    for (let r = 0; r < rings; r++) {
      const z = -r * spacing - spacing / 2;
      const depth = r / rings;
      const band = Math.min(7, Math.floor(depth * 8));

      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * paneW;

        // Seeded variation: a missing floor plate reads as an open gap onto the void.
        if (this.rng.next() > 0.06) push(plates, x, -hh, z, -Math.PI / 2);
        if (this.rng.next() > 0.06) push(plates, x, hh, z, Math.PI / 2);

        // Recessed coffer + its own strip, every other bay.
        if (i % 2 === 1) {
          push(coffers, x, hh - 0.07, z);
          push(strips, x, hh - 0.15, z);
        }
      }

      for (let side = -1; side <= 1; side += 2) {
        for (let j = 0; j < n; j++) {
          const y = (j - (n - 1) / 2) * paneH;
          const roll = this.rng.next();
          if (roll < 0.05) continue; // missing pane, open to the void
          // Nothing in the scene is mathematically flat.
          const tilt = (this.rng.next() - 0.5) * 0.05;
          const list = wallsByBand.get(band) ?? [];
          list.push(make(hw * side, y, z, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2, tilt));
          wallsByBand.set(band, list);
          push(subs, hw * side * 0.99, y, z);
        }
        // Vertical pilaster. MUST use the post list: the `mullions` list is mounted with
        // mullionRing, a full-width horizontal bar, and putting a pilaster in it drew a
        // black line straight across the middle of the screen once per ring.
        push(pilasters, hw * side * 0.98, 0, z - spacing / 2);
        push(seams, hw * side * 0.9, -hh + 0.03, z);
        // Upper service band, repeating along the wall.
        push(bands, hw * side * 0.97, hh * 0.62, z);
      }

      for (const y of [hh, -hh]) push(mullions, 0, y, z - spacing / 2);
    }

    // Pass two: one InstancedMesh per family.
    const mount = (geom: BufferGeometry, mat: MeshStandardNodeMaterial | MeshBasicNodeMaterial, list: readonly Matrix4[]): void => {
      if (list.length === 0) return;
      const mesh = new InstancedMesh(geom, mat, list.length);
      for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, list[i] as Matrix4);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.shell.add(mesh);
      this.instanced.push(mesh);
      this.elementCount += list.length;
    };

    mount(plateGeom, this.plateMaterial, plates);
    mount(mullionRing, this.mullionMaterial, mullions);
    mount(mullionPost, this.mullionMaterial, pilasters);
    mount(subMullion, this.mullionMaterial, subs);
    mount(cofferGeom, this.mullionMaterial, coffers);
    mount(bandGeom, this.mullionMaterial, bands);
    mount(stripGeom, this.stripMaterial, strips);
    mount(seamGeom, this.seamMaterial, seams);

    // Walls are split by depth band so contrast and saturation can fall with distance;
    // eight bands is below the eye's threshold for banding and costs eight draw calls.
    for (const [band, list] of wallsByBand) mount(wallGeom, this.wallBand(band / 8), list);

    this.root.add(this.shell);
  }

  /** One shared wall material per depth band. Eight bands is below the eye's threshold. */
  private wallBand(depth: number): MeshStandardNodeMaterial {
    const band = Math.min(7, Math.floor(depth * 8));
    const existing = this.wallBands[band];
    if (existing !== undefined) return existing;
    const factor = 1 - (band / 8) * 0.72;

    // Contrast AND saturation both fall with depth. Darkening alone reads as "unlit", not
    // as "far away": what actually sells distance is chroma bleeding toward the haze colour,
    // because that is what an atmosphere physically does to a surface behind it.
    const tint = new Color().copy(this.theme.stone).multiplyScalar(0.62 * factor + 0.04);
    const hazed = new Color().copy(this.theme.haze.color).multiplyScalar(0.06);
    tint.lerp(hazed, (band / 8) * 0.65);

    const made = new MeshStandardNodeMaterial({
      color: tint,
      // Rougher with distance too, so far panes stop returning a crisp specular.
      roughness: 0.72 + (band / 8) * 0.22,
      metalness: 0.06,
    });
    this.wallBands[band] = made;
    return made;
  }

  // ---- spawning -----------------------------------------------------------------------

  private spawnRow(): void {
    const z = this.nextRowZ - TUNING.rowSpacing;
    this.nextRowZ = z;

    // One row is a short wall of panes with a gap, plus an occasional crystal in the gap.
    // The gap is what makes the row a decision rather than a wall to grind through.
    const columns = 3;
    const gap = Math.floor(this.rng.next() * columns);
    for (let c = 0; c < columns; c++) {
      const x = (c - (columns - 1) / 2) * (TUNING.paneWidth + 0.12);
      if (c === gap) {
        if (this.rng.next() < 0.55) this.spawnCrystal(x, this.rng.next() * 2 - 1, z);
        continue;
      }
      const yJitter = (this.rng.next() - 0.5) * 1.2;
      this.spawnPane(x, yJitter, z, this.rng.next() < 0.22 ? 2 : 1);
    }
  }

  private acquireTarget(): Target | null {
    for (const target of this.targets) if (!target.live) return target;
    if (this.targets.length > 96) return null;
    const mesh = new Mesh(this.paneGeometry, this.paneMaterial);
    const created: Target = { mesh, kind: 'pane', live: false, hits: 1 };
    this.root.add(mesh);
    this.targets.push(created);
    return created;
  }

  private spawnPane(x: number, y: number, z: number, hits: number): void {
    const target = this.acquireTarget();
    if (target === null) return;
    target.kind = 'pane';
    target.hits = hits;
    target.live = true;
    target.mesh.geometry = this.paneGeometry;
    target.mesh.material = hits > 1 ? this.paneCrackedMaterial : this.paneMaterial;
    target.mesh.scale.set(1, 1, 1);
    target.mesh.rotation.set(0, 0, 0);
    target.mesh.position.set(x, y, z);
    target.mesh.visible = true;
    this.attachCaustic(target);
  }

  /** Parks a pool on the floor directly beneath a pane and tracks it while the pane lives. */
  private attachCaustic(target: Target): void {
    if (this.causticMaterial === null) return;
    let pool = this.caustics.find((c) => !c.visible);
    if (pool === undefined) {
      if (this.caustics.length > 24) return;
      pool = new Mesh(this.causticGeometry, this.causticMaterial);
      pool.rotation.x = -Math.PI / 2;
      this.root.add(pool);
      this.caustics.push(pool);
    }
    pool.visible = true;
    pool.userData['owner'] = target;
  }

  private spawnCrystal(x: number, y: number, z: number): void {
    const target = this.acquireTarget();
    if (target === null) return;
    target.kind = 'crystal';
    target.hits = 1;
    target.live = true;
    target.mesh.geometry = this.crystalGeometry;
    target.mesh.material = this.crystalMaterial;
    target.mesh.scale.set(1, 1, 1);
    target.mesh.position.set(x, y, z);
    target.mesh.visible = true;
  }

  // ---- input --------------------------------------------------------------------------

  /**
   * Throw at a normalised device coordinate. Costs a ball whether or not it connects -
   * that is the entire economy of the game and it must never be forgiving.
   */
  throwAt(ndcX: number, ndcY: number): void {
    if (this.over || this.ballsLeft <= 0) return;
    if (this.liveBallCount() >= TUNING.maxLiveBalls) return;

    const ball = this.acquireBall();
    if (ball === null) return;

    const direction = new Vector3(ndcX, ndcY, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    ball.mesh.position.copy(this.camera.position);
    ball.velocity.copy(direction).multiplyScalar(TUNING.ballSpeed);
    ball.ageMs = 0;
    ball.live = true;
    ball.mesh.visible = true;

    this.spendBall(BALL_COST_PER_THROW);
  }

  private liveBallCount(): number {
    let n = 0;
    for (const ball of this.balls) if (ball.live) n++;
    return n;
  }

  private acquireBall(): Ball | null {
    for (const ball of this.balls) if (!ball.live) return ball;
    const mesh = new Mesh(this.ballGeometry, this.ballMaterial);
    mesh.visible = false;
    this.root.add(mesh);
    const created: Ball = { mesh, velocity: new Vector3(), ageMs: 0, live: false };
    this.balls.push(created);
    return created;
  }

  // ---- economy ------------------------------------------------------------------------

  private spendBall(cost: number): void {
    this.ballsLeft = Math.max(0, this.ballsLeft - cost);
    this.publishBalls();
    if (this.ballsLeft === 0 && !this.over) {
      this.over = true;
      this.events.onRunOver();
    }
  }

  private gainBalls(count: number): void {
    this.ballsLeft = Math.min(BALLS_MAX, this.ballsLeft + count);
    this.publishBalls();
  }

  private publishBalls(): void {
    this.events.onBallsChanged(this.ballsLeft);
  }

  private publishScore(): void {
    this.events.onScoreChanged(this.score, this.multiplier, this.streak);
  }

  private registerHit(points: number): void {
    this.streak += 1;
    // The ladder lives in Balance.ts and nowhere else, so the HUD, the score cascade and
    // the self-test can never disagree about what a streak is worth.
    this.multiplier = multiplierForStreak(this.streak);
    this.score += points * this.multiplier;
    this.publishScore();
  }

  private breakStreak(): void {
    if (this.streak === 0 && this.multiplier === 1) return;
    this.streak = 0;
    this.multiplier = 1;
    this.publishScore();
  }

  // ---- shatter ------------------------------------------------------------------------

  private shatter(at: Vector3): void {
    // PHASE 1 - one bright frame, PHASE 2 - a hit-stop hold, PHASE 3 - staggered release.
    this.flashMs = TUNING.flashMs;
    this.hitStopFrames = TUNING.hitStopFrames;
    this.flashMesh.position.copy(at);
    this.flashMesh.scale.setScalar(1.6);
    this.flashMesh.visible = true;

    this.dustMs = TUNING.dustLifetimeMs;
    this.dustMesh.position.copy(at);
    this.dustMesh.visible = true;

    let live = 0;
    for (const shard of this.shards) if (shard.live) live++;
    if (live > TUNING.maxLiveShards) return;

    for (let i = 0; i < TUNING.shardsPerPane; i++) {
      const shard = this.acquireShard();
      if (shard === null) return;
      shard.mesh.position.copy(at);
      // Released state first, animated outward - the same convention the shatter system
      // uses, so a frozen frame shows a break that happened rather than one about to.
      shard.velocity.set(
        (this.rng.next() - 0.5) * TUNING.shardSpread,
        (this.rng.next() - 0.5) * TUNING.shardSpread,
        (this.rng.next() - 0.2) * TUNING.shardSpread * 0.6,
      );
      shard.spin.set(this.rng.next() * 6, this.rng.next() * 6, this.rng.next() * 6);
      shard.ageMs = 0;
      // Per-cell delay, biased so cells near the impact go first.
      shard.delayMs = this.rng.next() * TUNING.shardDelayMaxMs;
      shard.live = true;
      shard.mesh.visible = true;
      shard.mesh.scale.setScalar(0.6 + this.rng.next() * 0.8);
    }
  }

  private acquireShard(): Shard | null {
    for (const shard of this.shards) if (!shard.live) return shard;
    if (this.shards.length >= TUNING.maxLiveShards) return null;
    const mesh = new Mesh(this.shardGeometry, this.shardMaterial);
    mesh.visible = false;
    this.root.add(mesh);
    const created: Shard = { mesh, velocity: new Vector3(), spin: new Vector3(), ageMs: 0, delayMs: 0, live: false };
    this.shards.push(created);
    return created;
  }

  // ---- simulation ---------------------------------------------------------------------

  fixedUpdate(dtMs: Millis): void {
    const dt = dtMs / 1000;
    if (this.over) return;

    this.travel += TUNING.travelSpeed * dt;
    this.spinPhase += dt * TUNING.crystalSpinRate;

    // Very low amplitude, two incommensurable periods so it never visibly repeats.
    this.camera.position.set(
      Math.sin(this.spinPhase * 0.37) * 0.06,
      Math.sin(this.spinPhase * 0.51) * 0.045,
      0,
    );
    this.camera.rotation.z = Math.sin(this.spinPhase * 0.23) * 0.004;

    this.advanceFlash(dtMs);

    // PHASE 2. Frames are SKIPPED, not slowed: a shard's trajectory is identical whether or
    // not the hold happened, which is what keeps the shatter reproducible from a seed.
    if (this.hitStopFrames > 0) {
      this.hitStopFrames -= 1;
      this.advanceShards(dtMs);
      return;
    }

    this.advanceWorld(dt);
    this.advanceBalls(dt);
    this.advanceShards(dtMs);
  }

  /** Everything static moves toward the camera; the camera itself never translates. */
  private advanceWorld(dt: number): void {
    const step = TUNING.travelSpeed * dt;

    // Rings recycle rather than respawn: the corridor is a treadmill of fixed geometry.
    // The whole corridor is one transform. Wrapping at the full field length rather than
    // one ring keeps the seeded per-ring variation from visibly repeating every 10 metres.
    const wrap = this.ringsDeep * TUNING.ringSpacing;
    this.shell.position.z += step;
    if (this.shell.position.z > wrap) this.shell.position.z -= wrap;

    // Every emissive breathes on its own period, so the corridor never pulses in unison -
    // synchronised blinking is the single fastest way to read as a prototype.
    for (let i = 0; i < this.emissives.length; i++) {
      const mesh = this.emissives[i];
      if (mesh === undefined) continue;
      const period = 2.6 + (i % 7) * 0.31;
      const breath = 0.78 + 0.22 * Math.sin((this.spinPhase * 2.2) / period + i);
      mesh.scale.y = breath;
    }

    for (const rib of this.ribs) {
      rib.position.z += step;
      if (rib.position.z > TUNING.despawnBehind) {
        rib.position.z -= TUNING.ribSpacing * this.ribs.length;
      }
    }

    let deepest = 0;
    for (const target of this.targets) {
      if (!target.live) continue;
      target.mesh.position.z += step;
      if (target.kind === 'crystal') {
        target.mesh.rotation.y = this.spinPhase;
        target.mesh.rotation.x = this.spinPhase * 0.6;
      }
      deepest = Math.min(deepest, target.mesh.position.z);

      if (target.mesh.position.z > TUNING.despawnBehind) {
        // A pane that reaches you unbroken is the only thing that really hurts.
        if (target.kind === 'pane') {
          this.breakStreak();
          this.spendBall(BALL_PENALTY_ON_IMPACT);
        }
        target.live = false;
        target.mesh.visible = false;
      }
    }

    for (const pool of this.caustics) {
      if (!pool.visible) continue;
      const owner = pool.userData['owner'] as Target | undefined;
      if (owner === undefined || !owner.live || owner.kind !== 'pane') {
        pool.visible = false;
        continue;
      }
      pool.position.set(owner.mesh.position.x, -TUNING.corridorHalfHeight + 0.02, owner.mesh.position.z);
    }

    this.nextRowZ += step;
    if (deepest > -TUNING.spawnDistance) this.spawnRow();
  }

  private advanceBalls(dt: number): void {
    let lit: Ball | null = null;
    for (const ball of this.balls) {
      if (!ball.live) continue;
      ball.velocity.y += TUNING.gravity * dt;
      // The world slides toward the camera, so a ball has to slide with it or it would
      // appear to drift backwards through the corridor it was thrown down.
      ball.mesh.position.addScaledVector(ball.velocity, dt);
      ball.mesh.position.z += TUNING.travelSpeed * dt;
      ball.ageMs += dt * 1000;

      if (lit === null) lit = ball;
      if (this.collide(ball)) continue;

      const p = ball.mesh.position;
      const out =
        ball.ageMs > TUNING.ballLifetime ||
        p.z > TUNING.despawnBehind ||
        Math.abs(p.x) > TUNING.corridorHalfWidth ||
        Math.abs(p.y) > TUNING.corridorHalfHeight;
      if (out) {
        if (ball.ageMs > TUNING.ballLifetime || p.z > TUNING.despawnBehind) this.breakStreak();
        ball.live = false;
        ball.mesh.visible = false;
      }
    }
    this.trackBallLight(lit);
  }

  /** Phases 1 and 3's own timelines, which run even while the world is held. */
  private advanceFlash(dtMs: Millis): void {
    if (this.flashMs > 0) {
      this.flashMs -= dtMs;
      const k = Math.max(0, this.flashMs / TUNING.flashMs);
      this.flashMesh.scale.setScalar(1.6 + (1 - k) * 2.2);
      this.flashMesh.visible = this.flashMs > 0;
    }
    if (this.dustMs > 0) {
      this.dustMs -= dtMs;
      const k = 1 - Math.max(0, this.dustMs / TUNING.dustLifetimeMs);
      // Expands fast then coasts - dust does not decelerate linearly.
      this.dustMesh.scale.setScalar(0.4 + Math.sqrt(k) * TUNING.dustMaxScale);
      this.dustMesh.visible = this.dustMs > 0;
    }
  }

  /** The in-flight ball carries its own light, so a throw visibly rakes the corridor. */
  private trackBallLight(lit: Ball | null): void {
    if (lit === null) {
      this.ballLight.intensity = 0;
      return;
    }
    this.ballLight.position.copy(lit.mesh.position);
    this.ballLight.intensity = 14;
  }

  /** Sphere against an axis-aligned quad. Returns true when the ball was consumed. */
  private collide(ball: Ball): boolean {
    const p = ball.mesh.position;
    for (const target of this.targets) {
      if (!target.live) continue;
      const q = target.mesh.position;
      if (Math.abs(p.z - q.z) > TUNING.ballRadius + 0.5) continue;

      const halfW = target.kind === 'crystal' ? TUNING.crystalRadius : TUNING.paneWidth / 2;
      const halfH = target.kind === 'crystal' ? TUNING.crystalRadius : TUNING.paneHeight / 2;
      if (Math.abs(p.x - q.x) > halfW + TUNING.ballRadius) continue;
      if (Math.abs(p.y - q.y) > halfH + TUNING.ballRadius) continue;

      if (target.kind === 'crystal') {
        this.gainBalls(BALLS_PER_CRYSTAL);
        this.registerHit(50);
        target.live = false;
        target.mesh.visible = false;
        return false; // a crystal does not stop the ball
      }

      target.hits -= 1;
      if (target.hits > 0) {
        // Laminated: first hit only cracks it, and it says so by changing material.
        target.mesh.material = this.paneCrackedMaterial;
        this.registerHit(20);
      } else {
        this.shatter(q);
        this.registerHit(100);
        target.live = false;
        target.mesh.visible = false;
      }
      ball.live = false;
      ball.mesh.visible = false;
      return true;
    }
    return false;
  }

  private advanceShards(dtMs: Millis): void {
    const dt = dtMs / 1000;
    for (const shard of this.shards) {
      if (!shard.live) continue;
      shard.ageMs += dtMs;
      if (shard.ageMs < shard.delayMs) continue; // still attached to the pane
      shard.velocity.y += TUNING.gravity * dt;
      shard.mesh.position.addScaledVector(shard.velocity, dt);
      shard.mesh.position.z += TUNING.travelSpeed * dt;
      shard.mesh.rotation.x += shard.spin.x * dt;
      shard.mesh.rotation.y += shard.spin.y * dt;
      shard.mesh.rotation.z += shard.spin.z * dt;

      const life = shard.ageMs / TUNING.shardLifetime;
      if (life >= 1) {
        shard.live = false;
        shard.mesh.visible = false;
      } else {
        shard.mesh.scale.setScalar((1 - life) * 1.1);
        // Depth-sorted opacity: a shard further down the corridor fades sooner, so the
        // cloud reads as having volume instead of as a flat sheet of identical chips.
        const depth = Math.min(1, Math.abs(shard.mesh.position.z) / TUNING.spawnDistance);
        shard.mesh.renderOrder = Math.round((1 - depth) * 100);
      }
    }
  }

  frame(): void {
    // Interpolation is deliberately skipped: at 60Hz fixed with these speeds the visual
    // gain is below the noise floor, and reading positions here would fight fixedUpdate.
  }

  /** Drawn elements in the shell, counting every instance. Read by the density gate. */
  get shellElements(): number {
    return this.elementCount;
  }

  /**
   * Which of the three shatter phases is on screen right now. Exposed for the capture gate:
   * on a slow rasteriser a 34ms flash can fall between two screenshots, so the staging has
   * to be provable from state as well as from pixels.
   */
  get shatterPhase(): 'idle' | 'flash' | 'hitstop' | 'release' {
    if (this.flashMs > 0) return 'flash';
    if (this.hitStopFrames > 0) return 'hitstop';
    for (const shard of this.shards) if (shard.live) return 'release';
    return 'idle';
  }

  get liveShards(): number {
    let n = 0;
    for (const shard of this.shards) if (shard.live) n++;
    return n;
  }

  get balls_(): number {
    return this.ballsLeft;
  }

  get scoreValue(): number {
    return this.score;
  }

  get multiplierValue(): number {
    return this.multiplier;
  }

  get streakValue(): number {
    return this.streak;
  }

  get travelMetres(): number {
    return this.travel;
  }

  get isOver(): boolean {
    return this.over;
  }

  /**
   * Restart the run in place. Cheaper and less jarring than tearing the Playfield down and
   * rebuilding it: the shell, the pools and every material are reusable, so a retry only
   * has to retire live objects and reset the counters. The corridor keeps travelling, so
   * the restart reads as continuous rather than as a reload.
   */
  restart(): void {
    for (const ball of this.balls) { ball.live = false; ball.mesh.visible = false; }
    for (const shard of this.shards) { shard.live = false; shard.mesh.visible = false; }
    for (const target of this.targets) { target.live = false; target.mesh.visible = false; }
    for (const pool of this.caustics) pool.visible = false;
    this.flashMesh.visible = false;
    this.dustMesh.visible = false;
    this.flashMs = 0;
    this.dustMs = 0;
    this.hitStopFrames = 0;

    this.ballsLeft = BALLS_AT_START;
    this.score = 0;
    this.streak = 0;
    this.multiplier = 1;
    this.over = false;
    this.nextRowZ = 0;
    for (let i = 0; i < TUNING.rowsAhead; i++) this.spawnRow();

    this.publishBalls();
    this.publishScore();
  }

  /* --- self-test seams. Drive the REAL economy, not a reimplementation of it. --- */
  testThrowCost(): void {
    this.spendBall(BALL_COST_PER_THROW);
  }

  testCrystal(): void {
    this.gainBalls(BALLS_PER_CRYSTAL);
    this.registerHit(0);
  }

  testPaneBroken(): void {
    this.registerHit(0);
  }

  testImpact(): void {
    this.breakStreak();
    this.spendBall(BALL_PENALTY_ON_IMPACT);
  }

  /** Fires a shatter at the reticle without needing a ball to connect. Capture-gate hook. */
  testShatter(): void {
    this.shatter(new Vector3(0, 0, -12));
  }

  /** One deterministic fixed step, for a capture that must not depend on frame rate. */
  testStep(dtMs: Millis): void {
    this.fixedUpdate(dtMs);
  }

  testMiss(): void {
    this.breakStreak();
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.paneGeometry.dispose();
    this.shardGeometry.dispose();
    this.ballGeometry.dispose();
    this.crystalGeometry.dispose();
    this.paneMaterial.dispose();
    this.paneCrackedMaterial.dispose();
    this.shardMaterial.dispose();
    this.ballMaterial.dispose();
    this.crystalMaterial.dispose();
    this.causticMaterial?.dispose();
    this.causticGeometry.dispose();
    this.ribMaterial.dispose();
    this.wallMaterial.dispose();
    this.plateMaterial.dispose();
    this.mullionMaterial.dispose();
    this.stripMaterial.dispose();
    this.seamMaterial.dispose();
    for (const band of this.wallBands) band?.dispose();
    for (const g of this.shellGeometry) g.dispose();
    for (const i of this.instanced) i.dispose();
  }
}
