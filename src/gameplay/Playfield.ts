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
  Color,
  Fog,
  Group,
  IcosahedronGeometry,
  Mesh,
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
import { createRng } from '../battle/Rng';
import type { Rng } from '../battle/types';
import {
  BALLS_AT_START,
  BALL_COST_PER_THROW,
  BALL_PENALTY_ON_IMPACT,
  BALLS_MAX,
  BALLS_PER_CRYSTAL,
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
});

interface Ball {
  readonly mesh: Mesh;
  readonly velocity: Vector3;
  ageMs: number;
  live: boolean;
}

interface Shard {
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

  private readonly paneMaterial: MeshStandardNodeMaterial;
  private readonly paneCrackedMaterial: MeshStandardNodeMaterial;
  private readonly shardMaterial: MeshStandardNodeMaterial;
  private readonly ballMaterial: MeshStandardNodeMaterial;
  private readonly crystalMaterial: MeshBasicNodeMaterial;
  private readonly ribMaterial: MeshStandardNodeMaterial;
  private readonly wallMaterial: MeshStandardNodeMaterial;

  private readonly plateMaterial: MeshStandardNodeMaterial;
  private readonly mullionMaterial: MeshStandardNodeMaterial;
  private readonly stripMaterial: MeshBasicNodeMaterial;
  private readonly seamMaterial: MeshBasicNodeMaterial;
  private readonly wallBands: (MeshStandardNodeMaterial | undefined)[] = [];
  private readonly ringGroups: Group[] = [];
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
    this.paneMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.glass.tint),
      emissive: new Color().copy(t.glass.edge),
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.34,
      roughness: 0.08,
      metalness: 0.0,
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
    this.ballMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.metal),
      emissive: new Color().copy(t.emissive.primary),
      emissiveIntensity: 0.22,
      roughness: 0.16,
      metalness: 1.0,
    });
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
      color: new Color().copy(t.stone).multiplyScalar(0.07),
      roughness: 0.34,
      metalness: 0.55,
    });
    this.mullionMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.metal).multiplyScalar(0.28),
      roughness: 0.42,
      metalness: 0.95,
    });
    this.stripMaterial = new MeshBasicNodeMaterial({ color: new Color().copy(t.emissive.primary) });
    this.seamMaterial = new MeshBasicNodeMaterial({
      color: new Color().copy(t.emissive.secondary),
      transparent: true,
      opacity: 0.7,
    });

    this.buildShell();

    // FOUR light contributions, not one blob.
    // 1. Key, from the aperture. Hard-clamped: an unbounded point light at the vanishing
    //    point is what clipped the old frame to white across a third of the image.
    this.keyLight = new PointLight(new Color().copy(t.emissive.primary), 14, 26, 2.6);
    this.keyLight.position.set(0, 0.8, -22);
    this.root.add(this.keyLight);

    // 2. Cool bounce off the floor plates, upward onto the underside of everything.
    this.bounceLight = new PointLight(new Color().copy(t.emissive.secondary), 5, 18, 2.6);
    this.bounceLight.position.set(0, -TUNING.corridorHalfHeight + 0.4, -9);
    this.root.add(this.bounceLight);

    // 3. A moving light carried by the ball, so a throw brightens what it passes.
    this.ballLight = new PointLight(new Color().copy(t.emissive.primary), 0, 14, 2);
    this.root.add(this.ballLight);

    // 4. Ambient floor fill, keeping shadow sides readable without lifting the black point.
    const fill = new PointLight(new Color().copy(t.glass.edge), 1.6, 22, 2.4);
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
   * The corridor shell. Density is the whole point: a tunnel made of four rectangles reads
   * as a 1990s prototype no matter how good the lighting is, so this emits rings of
   * individually-panelled faces with mullions, coffers, seams and emissive strips. Every
   * element is a plain Mesh sharing pooled geometry and one of five materials, so the count
   * costs draw calls but no allocation churn.
   *
   * Ring count is tier-driven: the budget decides how deep the corridor is built, and the
   * fog is retuned to match so a shallower corridor still ends in haze rather than a wall.
   */
  private buildShell(): void {
    const hw = TUNING.corridorHalfWidth;
    const hh = TUNING.corridorHalfHeight;
    const rings = this.ringsDeep;
    const spacing = TUNING.ringSpacing;
    const n = TUNING.panesPerFace;

    const paneW = (hw * 2) / n;
    const paneH = (hh * 2) / n;

    const faceGeom = new PlaneGeometry(paneW * 0.94, spacing * 0.9);
    const wallGeom = new PlaneGeometry(spacing * 0.9, paneH * 0.94);
    const mullionRing = new BoxGeometry(hw * 2 + 0.2, 0.1, 0.1);
    const mullionPost = new BoxGeometry(0.1, hh * 2, 0.1);
    const stripGeom = new BoxGeometry(0.06, 0.05, spacing * 0.8);
    const cofferGeom = new BoxGeometry(paneW * 0.7, 0.12, spacing * 0.6);

    for (let r = 0; r < rings; r++) {
      const z = -r * spacing;
      // Atmospheric perspective is applied as geometry-level dimming, not just fog: each
      // ring further out is built from a darker instance so contrast falls with depth even
      // where fog has not yet taken over.
      const depth = r / rings;
      const dim = 1 - depth * 0.72;

      const group = new Group();
      group.position.z = z;

      // floor + ceiling plates, individually panelled with visible seams
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * paneW;

        const floor = new Mesh(faceGeom, this.plateMaterial);
        floor.position.set(x, -hh, -spacing / 2);
        floor.rotation.x = -Math.PI / 2;
        group.add(floor);

        const ceil = new Mesh(faceGeom, this.plateMaterial);
        ceil.position.set(x, hh, -spacing / 2);
        ceil.rotation.x = Math.PI / 2;
        group.add(ceil);

        // recessed coffer with its own light strip, every other bay
        if (i % 2 === 1) {
          const coffer = new Mesh(cofferGeom, this.mullionMaterial);
          coffer.position.set(x, hh - 0.07, -spacing / 2);
          group.add(coffer);
          const strip = new Mesh(stripGeom, this.stripMaterial);
          strip.position.set(x, hh - 0.14, -spacing / 2);
          group.add(strip);
          this.emissives.push(strip);
        }
      }

      // side walls, panelled, with pilasters between groups
      for (let side = -1; side <= 1; side += 2) {
        for (let j = 0; j < n; j++) {
          const y = (j - (n - 1) / 2) * paneH;
          const pane = new Mesh(wallGeom, this.wallMaterial);
          pane.position.set(hw * side, y, -spacing / 2);
          pane.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
          // Seeded imperfection: nothing in the scene is mathematically flat.
          pane.rotation.z = (this.rng.next() - 0.5) * 0.012;
          group.add(pane);
        }
        const pilaster = new Mesh(mullionPost, this.mullionMaterial);
        pilaster.position.set(hw * side * 0.98, 0, -spacing + 0.05);
        group.add(pilaster);

        // inlaid emissive line converging on the vanishing point
        const seam = new Mesh(stripGeom, this.seamMaterial);
        seam.position.set(hw * side * 0.9, -hh + 0.03, -spacing / 2);
        seam.scale.set(2, 1, 1);
        group.add(seam);
        this.emissives.push(seam);
      }

      // mullion frame at the ring boundary
      for (const y of [hh, -hh]) {
        const bar = new Mesh(mullionRing, this.mullionMaterial);
        bar.position.set(0, y, -spacing);
        group.add(bar);
      }

      group.traverse((child) => {
        if (child instanceof Mesh && child.material === this.wallMaterial && dim < 1) {
          // Share one darkened material per depth band rather than cloning per mesh.
          child.material = this.wallBand(depth);
        }
      });

      this.root.add(group);
      this.ringGroups.push(group);
    }
  }

  /** One shared wall material per depth band. Eight bands is below the eye's threshold. */
  private wallBand(depth: number): MeshStandardNodeMaterial {
    const band = Math.min(7, Math.floor(depth * 8));
    const existing = this.wallBands[band];
    if (existing !== undefined) return existing;
    const factor = 1 - (band / 8) * 0.72;
    const made = new MeshStandardNodeMaterial({
      color: new Color().copy(this.theme.stone).multiplyScalar(0.11 * factor + 0.008),
      roughness: 0.88,
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
    // A short ladder that tops out fast, so the reward for a clean row is immediate.
    this.multiplier = Math.min(10, 1 + Math.floor(this.streak / 4));
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
    const created: Shard = { mesh, velocity: new Vector3(), spin: new Vector3(), ageMs: 0, live: false };
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

    this.advanceWorld(dt);
    this.advanceBalls(dt);
    this.advanceShards(dtMs);
  }

  /** Everything static moves toward the camera; the camera itself never translates. */
  private advanceWorld(dt: number): void {
    const step = TUNING.travelSpeed * dt;

    // Rings recycle rather than respawn: the corridor is a treadmill of fixed geometry.
    const wrap = this.ringsDeep * TUNING.ringSpacing;
    for (const group of this.ringGroups) {
      group.position.z += step;
      if (group.position.z > TUNING.ringSpacing) group.position.z -= wrap;
    }

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
        this.gainBalls(BALLS_PER_CRYSTAL * 3);
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
      }
    }
  }

  frame(): void {
    // Interpolation is deliberately skipped: at 60Hz fixed with these speeds the visual
    // gain is below the noise floor, and reading positions here would fight fixedUpdate.
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
    this.ribMaterial.dispose();
    this.wallMaterial.dispose();
    this.plateMaterial.dispose();
    this.mullionMaterial.dispose();
    this.stripMaterial.dispose();
    this.seamMaterial.dispose();
    for (const band of this.wallBands) band?.dispose();
  }
}
