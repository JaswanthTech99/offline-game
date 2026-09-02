/**
 * THE THROWN BALL, MADE TRACKABLE.
 *
 * WHY THIS FILE EXISTS - the measurement, not the guess.
 * A ball leaves the muzzle at 78 m/s and the corridor slides toward the camera at 9 m/s, so
 * it recedes at 69 m/s. Its projected radius therefore decays as
 *
 *     r_px(d) = (0.34 / d) * (viewportPx / 2) / tan(fov/2)
 *
 * which on a 540-device-pixel-tall frame at fov 68 is 136/d px:
 *
 *     t        0.10s   0.20s   0.30s   0.40s   0.50s   0.60s
 *     d          6.9    13.8    20.7    27.6    34.5    41.4  m
 *     r_px      19.7     9.9     6.6     4.9     3.9     3.3  px
 *
 * Those numbers are measured, not derived: e2e/gates/ball.gate.spec.ts projects the live
 * ball through the debug bridge and reports 118.35 px at 1.15 m falling to 7.40 px at
 * 18.4 m, which is the same 136/d curve. The ball never becomes literally sub-pixel inside
 * its own lifetime, and it is never frustum-culled or depth-sorted away - it simply loses
 * 97% of its area in six tenths of a second, and a 3 px unlit steel disc against a
 * corridor of lit greebles is, to the player, gone.
 *
 * So the fix is not "make it brighter". Per docs/ARCHITECTURE.md §6 the answer to a
 * legibility failure is never more glow. The answer is to stop the SCREEN size of the
 * subject from being a pure function of distance:
 *
 *   1. a screen-space radius FLOOR, the same projection Playfield already applies to
 *      crystals (Balance.projectedHeightPx), so the ball stops shrinking at a stated size;
 *   2. a velocity-stretched streak carrying the last 120 ms of travel, so the eye is given
 *      a direction and a length instead of a point;
 *   3. the ball's own moving point light, so it announces itself by changing the corridor
 *      it passes rather than by being brighter than it;
 *   4. a soft outer halo, so SMAA has a gradient to resolve instead of a hard one-pixel
 *      step - the same defect the crystal halo was added to fix.
 *
 * WHY ONE OBJECT FOR ALL BALLS. Every layer is an InstancedMesh, so the whole rig is three
 * draw calls whatever the pool does, and there is exactly one node graph per layer rather
 * than one per live ball - twelve materials would mean twelve pipeline compilations, each
 * landing on the frame a player first throws that many.
 */

import {
  AdditiveBlending,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  PointLight,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';
import type { Color, PerspectiveCamera, Scene } from 'three/webgpu';
import { dot, float, normalize, normalView, positionView, pow, smoothstep, uv, vec3 } from 'three/tsl';

import type { Disposable } from '../core/types';
import { projectedHeightPx } from './Balance';

/**
 * Ball feel and ball legibility. Game-design numbers, not performance budgets - a faster
 * GPU would want every one of them unchanged - so by the rule in docs/ARCHITECTURE.md §1
 * they belong beside CRYSTAL_MIN_SCREEN_PX in gameplay/Balance.ts. They are declared here
 * because this agent does not own that file; see CONSTANTS REQUESTED in the hand-off.
 */
export const BALL_VISUAL = Object.freeze({
  /** Metres. Must equal Playfield's TUNING.ballRadius or the drawn ball lies about its hitbox. */
  radiusM: 0.34,

  /**
   * DEVICE pixels of projected DIAMETER the ball may never fall below, mirroring
   * LEGIBLE_MIN_SCREEN_PX: the thing you throw must never be less legible than the thing
   * you throw it at. Unboosted, the ball crosses this at 19.4 m - a third of the way to
   * the first pane row.
   */
  minScreenPx: 14,

  /**
   * Ceiling on the floor's scale-up, mirroring CRYSTAL_MAX_SCALE_BOOST. It is never
   * reached in play: the corridor culls a ball at |y| > 3.4 m, which a flat throw hits at
   * 723 ms and 50 m, where the required boost is 2.6. The cap exists so a ball that
   * somehow outlives that envelope becomes a small dot rather than a billboard.
   */
  maxScaleBoost: 3.2,

  /**
   * Milliseconds of travel the streak represents. Expressed as a LENGTH (speed x 0.12 s)
   * rather than as a ring buffer of past positions: a geometric streak cannot drift out of
   * step with the fixed timestep, allocates nothing, and reads identically at any frame rate.
   */
  trailMs: 120,
  /** Streak width as a fraction of the drawn ball diameter. Narrower reads as speed. */
  trailWidth: 0.62,
  /** Fade toward the tail. Above 1 the streak dies quickly and stops looking like a rope. */
  trailFadePower: 1.5,
  trailAlpha: 0.42,
  /**
   * Minimum share of the velocity that lies ACROSS the view ray before a streak is drawn.
   * A ball thrown straight down the corridor recedes along the view ray and has no
   * screen-space direction to stretch along; drawing one anyway paints a disc over the
   * ball and destroys the very silhouette this file exists to protect.
   */
  trailMinAxis: 0.05,

  /** Halo diameter as a multiple of the drawn ball diameter. */
  haloScale: 3.4,
  /** Peak halo alpha. Low: forty of these must never sum to white at the muzzle. */
  haloAlpha: 0.15,

  /**
   * Balls that carry a light. A PointLight costs every lit material in the scene one more
   * loop iteration whether or not it is on, so this is a hard cap and not a per-ball
   * property; the pool hands its lowest free slots out first, so the lit balls are the
   * ones in flight.
   */
  lightCount: 3,
  lightIntensity: 14,
  lightRangeM: 14,
  lightDecay: 2,

  /**
   * There is no environment map in this scene. A metalness-1 surface has nothing to
   * reflect and returns near-black - the same defect that made the crystal hull vanish
   * behind its own halo. Enough metal to catch a specular, enough albedo to hold a value
   * when the ball is nine pixels across.
   */
  coreMetalness: 0.35,
  coreRoughness: 0.30,
  /**
   * The hotspot is deliberately BROADER and the rim deliberately stronger than a
   * beauty-shot sphere would want. A pow-64 lobe covers a few percent of the silhouette,
   * which at 14 px is a fraction of one pixel and averages away to nothing; the rim wraps
   * the whole outline and is therefore the term that survives downsampling.
   */
  hotspotPower: 40,
  hotspotGain: 1.9,
  rimPower: 2.2,
  rimGain: 1.15,
  fillGain: 0.2,

  /** Live balls the rig can draw at once. Must be >= Playfield's TUNING.maxLiveBalls. */
  capacity: 12,
});

export interface BallVisualOptions {
  readonly capacity?: number;
  /** Device pixels of viewport HEIGHT. The screen-space floor is meaningless without it. */
  readonly viewportPx?: number;
  readonly lightCount?: number;
}

const scratchMatrix = new Matrix4();
const scratchBasis = new Matrix4();
const scratchQuat = new Quaternion();
const scratchScale = new Vector3();
const scratchToEye = new Vector3();
const scratchDir = new Vector3();
const scratchAxis = new Vector3();
const scratchRight = new Vector3();
const scratchMid = new Vector3();
/** The core is a sphere: it has no orientation to keep and never needs one composed. */
const IDENTITY_QUAT = new Quaternion();

export class BallVisual implements Disposable {
  /** Added to the scene by the constructor; exposed so a caller can toggle the whole rig. */
  readonly root = new Group();

  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly capacity: number;

  private readonly coreGeometry: SphereGeometry;
  private readonly haloGeometry: PlaneGeometry;
  private readonly trailGeometry: PlaneGeometry;
  private readonly coreMaterial: MeshStandardNodeMaterial;
  private readonly haloMaterial: MeshBasicNodeMaterial;
  private readonly trailMaterial: MeshBasicNodeMaterial;
  private readonly core: InstancedMesh;
  private readonly halo: InstancedMesh;
  private readonly trail: InstancedMesh;
  private readonly lights: PointLight[] = [];

  private viewportPx: number;
  private written = 0;
  private trailsWritten = 0;
  private litWritten = 0;
  private drawn = 0;
  private lastRadiusPx = 0;

  /**
   * @param tint  the ball's own body colour - the universe's metal.
   * @param edge  the reserved hot hue the hotspot, rim, streak and halo are drawn in. It is
   *              the same hue the corridor uses for things you can hit, which is the point:
   *              the ball belongs to the same read as its targets.
   */
  constructor(
    scene: Scene,
    camera: PerspectiveCamera,
    tint: Color,
    edge: Color,
    options: BallVisualOptions = {},
  ) {
    this.scene = scene;
    this.camera = camera;
    this.capacity = options.capacity ?? BALL_VISUAL.capacity;
    this.viewportPx = options.viewportPx ?? 720;

    this.coreGeometry = new SphereGeometry(BALL_VISUAL.radiusM, 20, 14);
    // Unit quad. The halo is centred on the ball; the streak's pivot is its HEAD, so the
    // instance transform can place it at the ball and scale it backwards along the flight
    // path without a second position to keep in step.
    this.haloGeometry = new PlaneGeometry(1, 1);
    this.trailGeometry = new PlaneGeometry(1, 1);
    this.trailGeometry.translate(0, -0.5, 0);

    this.coreMaterial = new MeshStandardNodeMaterial({
      color: tint,
      metalness: BALL_VISUAL.coreMetalness,
      roughness: BALL_VISUAL.coreRoughness,
    });
    this.coreMaterial.name = 'ball-core';
    {
      const n = normalize(normalView);
      const view = normalize(positionView.negate());
      // A direction, not a colour: over the player's shoulder and down the corridor, so the
      // hotspot sits where the corridor's own key light would put it.
      const keyDir = normalize(vec3(0.35, 0.6, 0.72));
      const hotspot = pow(dot(n, keyDir).clamp(0, 1), float(BALL_VISUAL.hotspotPower)).mul(
        float(BALL_VISUAL.hotspotGain),
      );
      const rim = pow(dot(n, view).clamp(0, 1).oneMinus(), float(BALL_VISUAL.rimPower)).mul(
        float(BALL_VISUAL.rimGain),
      );
      const fill = dot(n, keyDir).clamp(0, 1).oneMinus().mul(float(BALL_VISUAL.fillGain));
      this.coreMaterial.emissiveNode = vec3(edge.r, edge.g, edge.b)
        .mul(hotspot.add(rim))
        .add(vec3(tint.r, tint.g, tint.b).mul(fill));
    }

    // ADDITIVE, depthWrite FALSE, both layers, and the reason is the same for both: they
    // are light the ball emits, not surface it owns. Additive because two overlapping
    // streaks must brighten rather than one of them winning a sort that has no correct
    // answer; depthWrite false because a soft halo that wrote depth would punch a
    // ball-shaped hole in every pane behind it. Depth TESTING stays on, so a pane in front
    // of the ball still occludes it - the ball must not read as being nearer than it is.
    this.haloMaterial = new MeshBasicNodeMaterial({
      color: edge,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.haloMaterial.name = 'ball-halo';
    this.haloMaterial.opacityNode = smoothstep(
      float(1),
      float(0),
      uv().sub(0.5).length().mul(2),
    ).mul(float(BALL_VISUAL.haloAlpha));
    // Exempt from the corridor's haze for the reason docs/ARCHITECTURE.md §6 site 4 gives:
    // the ball's read is an emissive, and an emissive that fogs out at 20 m makes a long
    // throw unreadable. It is safe because it is small - a 48 px halo is 0.35% of frame.
    this.haloMaterial.fog = false;

    this.trailMaterial = new MeshBasicNodeMaterial({
      color: edge,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.trailMaterial.name = 'ball-trail';
    {
      // uv.y is 1 at the head and 0 at the tail; the across-quad term is a smoothstep
      // rather than a hard edge so SMAA is given a gradient on both long sides.
      const along = pow(uv().y, float(BALL_VISUAL.trailFadePower));
      const across = smoothstep(float(1), float(0), uv().x.sub(0.5).abs().mul(2));
      this.trailMaterial.opacityNode = along.mul(across).mul(float(BALL_VISUAL.trailAlpha));
    }
    this.trailMaterial.fog = false;

    this.core = new InstancedMesh(this.coreGeometry, this.coreMaterial, this.capacity);
    this.halo = new InstancedMesh(this.haloGeometry, this.haloMaterial, this.capacity);
    this.trail = new InstancedMesh(this.trailGeometry, this.trailMaterial, this.capacity);
    this.core.name = 'ball-cores';
    this.halo.name = 'ball-halos';
    this.trail.name = 'ball-trails';

    for (const mesh of [this.core, this.halo, this.trail]) {
      // Instance bounds are rewritten every frame and never recomputed. Culling an
      // InstancedMesh against a bounding sphere built at construction - when every
      // instance was at the origin - pops the whole rig out of frame the moment the first
      // ball leaves the muzzle. This is the ONE place hypothesis (a) is real, and it is
      // real because this rig is instanced; the pooled single Mesh it replaces culled
      // correctly, because a Mesh is tested against its own live matrixWorld.
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.root.add(mesh);
    }
    // Drawn after the opaque corridor so the additive terms land on a finished image. The
    // corridor's glass writes no depth, so a pane in front of the ball does not reject the
    // halo behind it: the ball's glow bleeds through glass. That is deliberate - glass is
    // the thing the player is aiming THROUGH, and a ball that vanishes behind the pane it
    // is about to break is the defect this file exists to remove. The opaque core still
    // depth-tests normally, so the ball itself never reads as nearer than it is.
    this.halo.renderOrder = 2;
    this.trail.renderOrder = 2;

    const lightCount = Math.max(0, Math.min(options.lightCount ?? BALL_VISUAL.lightCount, this.capacity));
    for (let i = 0; i < lightCount; i += 1) {
      const light = new PointLight(
        edge,
        0,
        BALL_VISUAL.lightRangeM,
        BALL_VISUAL.lightDecay,
      );
      light.name = `ball-light-${String(i)}`;
      this.lights.push(light);
      this.root.add(light);
    }

    this.root.name = 'ball-visual';
    scene.add(this.root);
  }

  /** Device pixels of viewport height. Without this the screen-space floor is a guess. */
  setViewportPx(px: number): void {
    this.viewportPx = Math.max(1, px);
  }

  /**
   * The screen radius, in device pixels, the most recently tracked ball was DRAWN at -
   * after the floor. A measurement seam: read alongside the framebuffer it separates "the
   * geometry was too small" from "the shading lost it", which are different bugs.
   */
  get screenRadiusPx(): number {
    return this.lastRadiusPx;
  }

  /** How many balls the last COMMITTED frame drew. Zero between `end()` and the next `track`. */
  get drawnCount(): number {
    return this.drawn;
  }

  /**
   * One live ball, this frame. Call once per ball, then `end()`. Position is world space;
   * velocity is metres per second in world space and may be zero.
   */
  track(position: Vector3, velocity: Vector3): void {
    if (this.written >= this.capacity) return;

    // Range to the EYE, not depth down the corridor: a ball thrown wide is further away
    // than its z says, and using z would over-shrink it exactly when it is hardest to see.
    scratchToEye.copy(this.camera.position).sub(position);
    const distance = scratchToEye.length();
    const boost = this.scaleFor(distance);
    const drawnRadius = BALL_VISUAL.radiusM * boost;
    this.lastRadiusPx =
      projectedHeightPx(drawnRadius * 2, distance, this.camera.fov, this.viewportPx) / 2;

    scratchScale.setScalar(boost);
    scratchMatrix.compose(position, IDENTITY_QUAT, scratchScale);
    this.core.setMatrixAt(this.written, scratchMatrix);

    // The halo is a billboard: it must present the same disc from every angle or it
    // flickers as the corridor rolls the camera.
    const haloSize = drawnRadius * 2 * BALL_VISUAL.haloScale;
    scratchScale.set(haloSize, haloSize, 1);
    scratchMatrix.compose(position, this.camera.quaternion, scratchScale);
    this.halo.setMatrixAt(this.written, scratchMatrix);

    this.written += 1;

    if (this.litWritten < this.lights.length) {
      const light = this.lights[this.litWritten];
      if (light !== undefined) {
        light.position.copy(position);
        light.intensity = BALL_VISUAL.lightIntensity;
        this.litWritten += 1;
      }
    }

    this.writeTrail(position, velocity, distance, drawnRadius);
  }

  /**
   * Commits the frame. Instance counts are set here rather than in `track` so a frame that
   * tracked nothing parks every layer and every light at zero in one place.
   */
  end(): void {
    this.drawn = this.written;
    this.core.count = this.written;
    this.halo.count = this.written;
    this.trail.count = this.trailsWritten;
    if (this.written > 0) {
      this.core.instanceMatrix.needsUpdate = true;
      this.halo.instanceMatrix.needsUpdate = true;
    }
    if (this.trailsWritten > 0) this.trail.instanceMatrix.needsUpdate = true;
    for (let i = this.litWritten; i < this.lights.length; i += 1) {
      const light = this.lights[i];
      if (light !== undefined) light.intensity = 0;
    }
    this.written = 0;
    this.trailsWritten = 0;
    this.litWritten = 0;
  }

  /** Everything off, immediately. For a restart, which must not leave a streak burning. */
  reset(): void {
    this.written = 0;
    this.trailsWritten = 0;
    this.litWritten = 0;
    this.end();
    this.lastRadiusPx = 0;
  }

  dispose(): void {
    this.reset();
    this.scene.remove(this.root);
    this.root.clear();
    this.coreGeometry.dispose();
    this.haloGeometry.dispose();
    this.trailGeometry.dispose();
    this.coreMaterial.dispose();
    this.haloMaterial.dispose();
    this.trailMaterial.dispose();
    this.core.dispose();
    this.halo.dispose();
    this.trail.dispose();
    this.lights.length = 0;
  }

  /**
   * The screen-space floor. Identical in form to the crystal floor in Playfield: project
   * the object's size, and if it lands under the bar, scale it up until it does not.
   */
  private scaleFor(distanceM: number): number {
    const px = projectedHeightPx(
      BALL_VISUAL.radiusM * 2,
      distanceM,
      this.camera.fov,
      this.viewportPx,
    );
    if (px >= BALL_VISUAL.minScreenPx) return 1;
    // The 0.5 guard is the same one the crystal uses: a ball momentarily at the near plane
    // projects to a huge number, and a ball at zero distance would divide by zero.
    return Math.min(BALL_VISUAL.minScreenPx / Math.max(px, 0.5), BALL_VISUAL.maxScaleBoost);
  }

  /**
   * The streak. Oriented so its long axis is the part of the velocity that lies ACROSS the
   * view ray - the only part that has any length on screen - and rolled to face the camera
   * so it never presents an edge.
   */
  private writeTrail(
    position: Vector3,
    velocity: Vector3,
    distance: number,
    drawnRadius: number,
  ): void {
    if (this.trailsWritten >= this.capacity) return;
    const speed = velocity.length();
    if (speed <= 1e-4 || distance <= 1e-4) return;

    scratchToEye.divideScalar(distance);
    scratchDir.copy(velocity).divideScalar(speed);
    scratchAxis.copy(scratchDir).addScaledVector(scratchToEye, -scratchDir.dot(scratchToEye));
    const across = scratchAxis.length();
    if (across < BALL_VISUAL.trailMinAxis) return;
    scratchAxis.divideScalar(across);
    scratchRight.crossVectors(scratchAxis, scratchToEye).normalize();

    // Only the across-view component earns screen length, so the streak shortens honestly
    // as a throw turns to face the camera instead of pretending to be metres long.
    const length = speed * (BALL_VISUAL.trailMs / 1000) * across;
    scratchBasis.makeBasis(scratchRight, scratchAxis, scratchToEye);
    scratchQuat.setFromRotationMatrix(scratchBasis);
    scratchScale.set(drawnRadius * 2 * BALL_VISUAL.trailWidth, length, 1);
    // The quad's pivot is its head, so the ball's own position places it and the geometry
    // trails backwards along -axis, which is where the ball was 120 ms ago.
    scratchMid.copy(position);
    scratchMatrix.compose(scratchMid, scratchQuat, scratchScale);
    this.trail.setMatrixAt(this.trailsWritten, scratchMatrix);
    this.trailsWritten += 1;
  }
}
