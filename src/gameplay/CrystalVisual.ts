/**
 * THE CRYSTAL AS A SOLID.
 *
 * A crystal is the only thing in the corridor that pays the player back, so it has to be
 * found at 100m and read as an object at 10m. Those two jobs pull in opposite directions,
 * and every earlier attempt lost one of them:
 *
 *  - An emissive-dominated hull is findable and reads as a flat card. Every facet returns
 *    the same value, so the silhouette is a polygon with no interior, and at distance it is
 *    a bright aliased blob.
 *  - A metallic hull reads as a solid nowhere, because THIS SCENE HAS NO ENVIRONMENT MAP.
 *    A metal with nothing to reflect returns near-black; the hull disappeared behind its own
 *    halo and the crystal became a glow with a hole in it. Metalness stays at 0 until
 *    something in this scene is worth reflecting.
 *  - A bright crystal is not a glowing crystal. Bloom in SHATTERPOINT is emissive-only via
 *    the scene pass's `emissive` MRT attachment (see render/PostChain.ts), so a material
 *    that does not write that attachment is bright and inert however high its colour goes.
 *
 * So the crystal is built as four cooperating parts, in the order the eye reads them:
 *
 *   1. A watertight 8-sided dipyramid with FLAT PER-FACET NORMALS, baked into the geometry.
 *      The facets are the whole point: each one takes the key at a different value, and it
 *      is that value ladder - not an outline, not a glow - that says "solid".
 *   2. An emissive core inside the hull, seen THROUGH it, so the interior has a value of
 *      its own instead of being an empty polygon.
 *   3. A soft halo at 2x hull radius, which gives the silhouette a gradient for the spatial
 *      AA to resolve and gives bloom a base wider than the hull.
 *   4. A dedicated key on CRYSTAL_LAYER. Confined, and it must be: unconfined it lit
 *      everything else near the camera and blew a decorative pane at 10m to full white,
 *      which inverts the target/scenery read the legibility pass exists to protect.
 *
 * The bloom MASK is authored separately from the beauty, through each part's own `mrtNode`.
 * That separation is the point: the hull can stay a shaded solid in the frame while telling
 * the bloom pass it is a lamp. Faking it the other way - raising the hull's emissive until
 * it blooms - is exactly the flat card described above, and it is what
 * `docs/ARCHITECTURE.md` §6 means by CONTRAST, NOT MORE GLOW.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import {
  abs,
  dot,
  float,
  mix,
  mrt,
  normalize,
  normalView,
  positionView,
  pow,
  screenUV,
  smoothstep,
  uv,
  vec3,
  viewportSharedTexture,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

import type { Disposable } from '../core/types';
import type { UniverseTheme } from '../universe/UniverseTheme';
import { CRYSTAL_MAX_SCALE_BOOST, CRYSTAL_MIN_SCREEN_PX, projectedHeightPx } from './Balance';

/**
 * Lights on this layer illuminate crystals and nothing else. Exported so the field and the
 * light that serves it cannot drift onto different numbers.
 */
export const CRYSTAL_LAYER = 2;

/**
 * The crystal's own dimensions and optical response. Not budgets - a faster GPU would want
 * exactly these numbers - so they live with the thing they describe, the way
 * `universe/kits/*` holds its metres. The one number a faster GPU WOULD want differently is
 * `bloomIntensity`, and that one is passed in from Quality.ts.
 */
const SHAPE = Object.freeze({
  /** Facets around the girdle. Eight is the fewest that still reads as cut rather than as a box. */
  sides: 8,
  /** Terminations are deliberately unequal: a symmetric bipyramid reads as a machined part. */
  topLength: 1.65,
  bottomLength: 1.05,
  /**
   * The girdle zig-zags by this fraction of the radius, alternating vertex by vertex. It
   * costs nothing and it doubles the number of distinct facet orientations from 8 to 16,
   * because no upper facet is any longer the mirror of the lower facet beneath it. The
   * ring is still shared by both halves, so the solid stays watertight.
   */
  girdleWobble: 0.11,
  /** Core size as a fraction of hull radius. Small enough to read as suspended inside. */
  coreScale: 0.46,
  /** Halo half-width in hull radii. */
  haloRadii: 2.0,
  /** How hard the hull's edge term ramps. Higher = a tighter rim, more interior left dark. */
  edgePower: 2.4,
  /** Emissive floor and edge gain in the BEAUTY. Low on purpose: the key must dominate. */
  hullEmissiveBase: 0.09,
  hullEmissiveEdge: 0.42,
  /** Face-on transmission. Grazing goes solid, which is what makes it read as a mineral. */
  hullFaceOpacity: 0.76,
  /** How much of the mask the hull carries face-on, before the rim adds the rest. */
  maskBase: 0.45,
  maskEdge: 0.55,
  /** Mask gains for the two additive parts, relative to the hull's. */
  coreMask: 0.9,
  haloMask: 0.3,
  coreOpacity: 0.6,
  haloOpacity: 0.15,
  /** Backbuffer offset for the refractive hull, in screen UV per unit of view normal. */
  refractionStrength: 0.026,
  refractionMix: 0.5,
  roughness: 0.28,
});

/** The two lights that build the facet ladder. Confined to CRYSTAL_LAYER, both of them. */
const KEY = Object.freeze({
  /** Off the corridor axis on all three axes, so no two facets face it equally. */
  keyPosition: [3.2, 2.4, 2.0] as const,
  keyIntensity: 26,
  keyRange: 70,
  keyDecay: 1.2,
  /**
   * A cool counter-light from the opposite side. Without it the away-facing facets all sit
   * at the ambient floor and collapse into ONE value, which is how a 16-facet solid ends up
   * reading as three. Its whole job is to spread the bottom of the value ladder.
   */
  fillPosition: [-2.6, -1.4, 1.4] as const,
  fillIntensity: 9,
  fillRange: 46,
  fillDecay: 1.4,
  fillColour: [0.62, 0.74, 1.0] as const,
});

/**
 * A watertight dipyramid with one flat normal per triangle, non-indexed by construction.
 *
 * Built by hand rather than by merging two ConeGeometries and re-deriving normals: the
 * merge path cannot give the two halves a shared girdle ring, so it cannot wobble the
 * girdle without opening a gap, and it pays for a merge, a clone, a toNonIndexed() and a
 * normal recomputation to arrive at the same 48 vertices this writes directly.
 */
function dipyramidGeometry(radius: number): BufferGeometry {
  const { sides, topLength, bottomLength, girdleWobble } = SHAPE;
  const girdle: Vector3[] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * Math.PI * 2;
    // Alternating sign, so consecutive girdle vertices sit above and below the equator.
    const wobble = (i % 2 === 0 ? 1 : -1) * radius * girdleWobble;
    girdle.push(new Vector3(Math.cos(angle) * radius, wobble, Math.sin(angle) * radius));
  }
  const apexTop = new Vector3(0, radius * topLength, 0);
  const apexBottom = new Vector3(0, -radius * bottomLength, 0);

  const faces = sides * 2;
  const positions = new Float32Array(faces * 9);
  const normals = new Float32Array(faces * 9);
  const uvs = new Float32Array(faces * 6);

  const edgeA = new Vector3();
  const edgeB = new Vector3();
  const normal = new Vector3();
  const centroid = new Vector3();
  let f = 0;

  const emit = (a: Vector3, b: Vector3, c: Vector3, uBase: number): void => {
    edgeA.subVectors(b, a);
    edgeB.subVectors(c, a);
    normal.crossVectors(edgeA, edgeB).normalize();
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    // The solid is centred on its own origin, so the outward direction at a face IS its
    // centroid. Swapping two vertices rather than negating the normal keeps the winding and
    // the normal agreeing, which back-face culling needs and a negated normal would not.
    const flip = normal.dot(centroid) < 0;
    const v0 = a;
    const v1 = flip ? c : b;
    const v2 = flip ? b : c;
    if (flip) normal.negate();

    const p = f * 9;
    const t = f * 6;
    const verts = [v0, v1, v2];
    for (let k = 0; k < 3; k += 1) {
      const v = verts[k] as Vector3;
      positions[p + k * 3] = v.x;
      positions[p + k * 3 + 1] = v.y;
      positions[p + k * 3 + 2] = v.z;
      normals[p + k * 3] = normal.x;
      normals[p + k * 3 + 1] = normal.y;
      normals[p + k * 3 + 2] = normal.z;
      uvs[t + k * 2] = uBase + (k === 0 ? 0 : k === 1 ? 1 / sides : 0.5 / sides);
      uvs[t + k * 2 + 1] = v.y > 0 ? 1 : 0;
    }
    f += 1;
  };

  for (let i = 0; i < sides; i += 1) {
    const a = girdle[i] as Vector3;
    const b = girdle[(i + 1) % sides] as Vector3;
    emit(a, b, apexTop, i / sides);
    emit(a, b, apexBottom, i / sides);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

export interface CrystalVisualOptions {
  /** Every colour comes from here. This module authors no palette. */
  readonly theme: UniverseTheme;
  /** The camera the size floor and the halo billboard are computed against. */
  readonly camera: PerspectiveCamera;
  /** Hull girdle radius in metres. The field owns this; the crystal only reads it. */
  readonly radius: number;
  /** CRYSTAL_BLOOM[tier].bloom - how far above the beauty the bloom mask is driven. */
  readonly bloomIntensity: number;
  /** GLASS[tier].refraction. The hull samples the backbuffer only where the tier pays for it. */
  readonly refraction: boolean;
}

interface Rig {
  readonly core: Mesh;
  readonly halo: Mesh;
}

export class CrystalVisual implements Disposable {
  /** The hull. Assign to the pooled target mesh; the rig attaches as its children. */
  readonly hullGeometry: BufferGeometry;
  readonly hullMaterial: MeshStandardNodeMaterial;
  /** Key and fill, both confined to CRYSTAL_LAYER. The caller adds and disposes them. */
  readonly lights: readonly PointLight[];
  readonly radius: number;

  private readonly camera: PerspectiveCamera;
  private readonly coreGeometry: BufferGeometry;
  private readonly haloGeometry: PlaneGeometry;
  private readonly coreMaterial: MeshBasicNodeMaterial;
  private readonly haloMaterial: MeshBasicNodeMaterial;
  private readonly rigs = new Map<Mesh, Rig>();
  private readonly scratchQuaternion = new Quaternion();
  private readonly cameraQuaternion = new Quaternion();
  /** Viewport height in DEVICE pixels. The size floor is a device-pixel promise. */
  private viewportPx = 720;

  constructor(options: CrystalVisualOptions) {
    const t = options.theme;
    this.camera = options.camera;
    this.radius = options.radius;

    this.hullGeometry = dipyramidGeometry(options.radius);
    this.coreGeometry = dipyramidGeometry(options.radius * SHAPE.coreScale);
    // Half a facet out of phase with the hull, so the core's edges sit under the hull's
    // faces. Aligned, the two solids read as one object with a double outline.
    this.coreGeometry.rotateY(Math.PI / SHAPE.sides);
    const halo = options.radius * SHAPE.haloRadii * 2;
    this.haloGeometry = new PlaneGeometry(halo, halo);

    const primary = vec3(t.emissive.primary.r, t.emissive.primary.g, t.emissive.primary.b);
    const secondary = vec3(t.emissive.secondary.r, t.emissive.secondary.g, t.emissive.secondary.b);
    const gain = float(options.bloomIntensity);

    // ---- hull ---------------------------------------------------------------------------
    this.hullMaterial = new MeshStandardNodeMaterial({
      color: new Color().copy(t.emissive.primary).multiplyScalar(0.95),
      roughness: SHAPE.roughness,
      // ZERO. There is no environment in this scene for a metal to reflect - see the header.
      metalness: 0,
      transparent: true,
      // The core has to be visible THROUGH the hull, and a depth-writing hull would reject
      // it. Depth is surrendered here and paid back by the value ladder on the facets.
      depthWrite: false,
    });

    // Per-facet, because the geometry carries one normal per triangle: `facing` is constant
    // across a facet and different on every one of the sixteen.
    const viewDir = normalize(positionView.negate());
    const facing = abs(dot(normalize(normalView), viewDir)).clamp(0, 1);
    const edge = pow(facing.oneMinus(), float(SHAPE.edgePower));

    // Low, and it must stay low: an emissive-dominated hull returns the same value on every
    // facet, which is the flat card this whole module exists to stop being.
    this.hullMaterial.emissiveNode = mix(primary, secondary, edge)
      .mul(edge.mul(float(SHAPE.hullEmissiveEdge)).add(float(SHAPE.hullEmissiveBase)));

    this.hullMaterial.opacityNode = mix(float(SHAPE.hullFaceOpacity), float(1), edge);

    if (options.refraction) {
      // Backbuffer through a normal-driven offset - the same trick GlassMaterial uses, and
      // the reason the hull refracts what is behind it instead of tinting it.
      const behind = viewportSharedTexture(screenUV.add(normalView.xy.mul(float(SHAPE.refractionStrength))));
      this.hullMaterial.colorNode = mix(
        behind.rgb,
        vec3(t.emissive.primary.r, t.emissive.primary.g, t.emissive.primary.b).mul(float(0.95)),
        float(SHAPE.refractionMix),
      );
    }

    // THE MASK. Authored apart from the beauty on purpose: in the frame the hull is a shaded
    // solid, and in the bloom mask it is a lamp. One material, two honest answers.
    this.hullMaterial.mrtNode = mrt({
      emissive: primary.mul(gain).mul(edge.mul(float(SHAPE.maskEdge)).add(float(SHAPE.maskBase))),
    });

    // ---- core ---------------------------------------------------------------------------
    this.coreMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    // Brightest where you look straight into a facet, so the interior has its own structure
    // rather than being one flat lozenge behind the hull.
    this.coreMaterial.colorNode = mix(secondary, primary, facing).mul(facing.mul(float(0.65)).add(float(0.55)));
    this.coreMaterial.opacityNode = float(SHAPE.coreOpacity);
    this.coreMaterial.mrtNode = mrt({ emissive: primary.mul(gain).mul(float(SHAPE.coreMask)) });

    // ---- halo ---------------------------------------------------------------------------
    this.haloMaterial = new MeshBasicNodeMaterial({
      color: new Color().copy(t.emissive.primary),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    // Radial, squared, so the gradient is soft at the rim and does not draw a visible disc
    // edge. This is what the spatial AA resolves against instead of a one-pixel step.
    const radial = uv().sub(0.5).length().mul(2).clamp(0, 1);
    const falloff: Node<'float'> = smoothstep(float(1), float(0), radial).pow(float(1.5));
    this.haloMaterial.opacityNode = falloff.mul(float(SHAPE.haloOpacity));
    // The halo is 2x the hull radius, so in the mask it is already a footprint wider than
    // the hull before bloom spreads it. That is the difference between a crystal that is
    // bright and one that glows.
    this.haloMaterial.mrtNode = mrt({ emissive: primary.mul(gain).mul(float(SHAPE.haloMask)).mul(falloff) });

    const key = new PointLight(new Color(1, 1, 1), KEY.keyIntensity, KEY.keyRange, KEY.keyDecay);
    key.position.set(...KEY.keyPosition);
    key.layers.set(CRYSTAL_LAYER);
    const fill = new PointLight(
      new Color(...KEY.fillColour),
      KEY.fillIntensity,
      KEY.fillRange,
      KEY.fillDecay,
    );
    fill.position.set(...KEY.fillPosition);
    fill.layers.set(CRYSTAL_LAYER);
    this.lights = [key, fill];
  }

  /** Device pixels of viewport height. The size floor is meaningless without it. */
  setViewportPx(px: number): void {
    this.viewportPx = Math.max(1, px);
  }

  /**
   * Turns a pooled target mesh into a crystal: hull geometry and material, core and halo
   * attached once and re-shown thereafter, and the layer bit that lets the crystal key
   * reach it. Idempotent, because the field re-dresses meshes out of a pool.
   */
  dress(mesh: Mesh): void {
    mesh.geometry = this.hullGeometry;
    mesh.material = this.hullMaterial;
    mesh.renderOrder = 0;

    let rig = this.rigs.get(mesh);
    if (rig === undefined) {
      const core = new Mesh(this.coreGeometry, this.coreMaterial);
      // After the hull, which wrote no depth, so the core is seen through it - and still
      // behind anything solid in front of the crystal, because it does depth-TEST.
      core.renderOrder = 1;
      const halo = new Mesh(this.haloGeometry, this.haloMaterial);
      halo.renderOrder = -1;
      mesh.add(core, halo);
      rig = { core, halo };
      this.rigs.set(mesh, rig);
    }
    rig.core.visible = true;
    rig.halo.visible = true;
    mesh.layers.enable(CRYSTAL_LAYER);
    rig.core.layers.enable(CRYSTAL_LAYER);
    rig.halo.layers.enable(CRYSTAL_LAYER);
  }

  /** Returns the mesh to the pool: rig hidden, layer bit cleared, size floor undone. */
  undress(mesh: Mesh): void {
    const rig = this.rigs.get(mesh);
    if (rig !== undefined) {
      rig.core.visible = false;
      rig.halo.visible = false;
    }
    mesh.layers.disable(CRYSTAL_LAYER);
    mesh.scale.setScalar(1);
  }

  /**
   * Spin, size floor and halo billboard, in one call.
   *
   * Call it on every step AND at spawn. A crystal placed while the world is held - which is
   * how every capture gate places one - never reaches the per-step path, and an unposed
   * crystal is the one case where the size floor silently does not exist.
   */
  pose(mesh: Mesh, spin: number): void {
    mesh.rotation.set(spin * 0.6, spin, 0);
    mesh.scale.setScalar(this.scaleFor(this.distanceTo(mesh)));

    const rig = this.rigs.get(mesh);
    if (rig === undefined) return;
    // The halo is a child of a mesh that is spinning, so copying the camera's WORLD
    // orientation into a LOCAL quaternion would make the billboard spin with its parent.
    // The parent's inverse is what turns a world orientation into a local one.
    mesh.getWorldQuaternion(this.scratchQuaternion).invert();
    this.camera.getWorldQuaternion(this.cameraQuaternion);
    rig.halo.quaternion.copy(this.scratchQuaternion.multiply(this.cameraQuaternion));
  }

  /**
   * The uniform scale that holds a crystal at CRYSTAL_MIN_SCREEN_PX, capped so a very
   * distant one becomes a legible object rather than a billboard hanging in the fog.
   */
  scaleFor(distanceM: number): number {
    const px = projectedHeightPx(this.radius * 2, distanceM, this.camera.fov, this.viewportPx);
    if (px >= CRYSTAL_MIN_SCREEN_PX) return 1;
    return Math.min(CRYSTAL_MIN_SCREEN_PX / Math.max(px, 0.5), CRYSTAL_MAX_SCALE_BOOST);
  }

  /** Projected girdle radius in device pixels, size floor included. What a gate measures. */
  screenRadiusPx(distanceM: number): number {
    return (
      projectedHeightPx(this.radius, distanceM, this.camera.fov, this.viewportPx) *
      this.scaleFor(distanceM)
    );
  }

  dispose(): void {
    for (const [mesh, rig] of this.rigs) {
      mesh.remove(rig.core, rig.halo);
    }
    this.rigs.clear();
    this.hullGeometry.dispose();
    this.coreGeometry.dispose();
    this.haloGeometry.dispose();
    this.hullMaterial.dispose();
    this.coreMaterial.dispose();
    this.haloMaterial.dispose();
  }

  private distanceTo(mesh: Mesh): number {
    const camera = this.camera.position;
    const p = mesh.position;
    return Math.max(
      0.001,
      Math.hypot(p.x - camera.x, p.y - camera.y, p.z - camera.z),
    );
  }
}
