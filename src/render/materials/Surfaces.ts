/**
 * SURFACE RESPONSE — reusable TSL factories for the corridor's non-glass materials.
 *
 * The corridor's shell reads flat for one measurable reason: every architectural surface
 * returns a single value per facet. A plate is one grey, a mullion is one darker grey, a
 * wall band is one greyer grey. Lighting alone cannot fix that, because four point lights
 * over flat Lambert geometry produce four smooth gradients and nothing else — no break-up,
 * no edge, no contact, no reflection. This module supplies the four terms that turn a facet
 * into a surface, each independently switchable so a tier can drop one without losing the
 * others.
 *
 *   1 anisotropicMetal  a brushed-metal lobe, stretched perpendicular to the grain, plus
 *                       wear that brightens the edges where surfaces meet
 *   2 reflectiveFloor   a real planar reflection of the ceiling strip grid, blurring with
 *                       reflected path length
 *   3 surfaceDetail     normal AND roughness break-up, so nothing is mathematically flat
 *   4 contactShadow     darkening where geometry meets the floor
 *
 * ============================== THE ENVIRONMENT DECISION ==============================
 * There is no environment map in this scene, and a prior pass proved what that costs:
 * `metalness > 0` renders near-black, because a metal is a mirror and a mirror with nothing
 * to reflect is a hole. Two ways out — generate a PMREM from a procedural gradient, or keep
 * `metalness` at 0 and synthesise the response.
 *
 * THIS MODULE KEEPS METALNESS AT 0 AND SYNTHESISES. Three reasons, in order of weight:
 *
 *   a. A PMREM is GLOBAL. `scene.environment` (or a shared envMap) reaches the glass, the
 *      crystals and the ball as well, and all three have already been tuned by measurement
 *      against the exposure histogram in ARCHITECTURE.md §6. Lifting their indirect term is
 *      not a material change, it is a re-tune of the whole frame, and it is not this
 *      module's to make.
 *   b. A PMREM needs the RENDERER at material-build time. Playfield builds its materials in
 *      its constructor and never sees a renderer, so adopting one would change the boot
 *      order for every caller of this file.
 *   c. The single thing the corridor most wants reflected is not an environment at all — it
 *      is the ceiling strip grid directly overhead, which is a known analytic plane.
 *      `reflectiveFloor` ray-marches nothing and samples nothing: it intersects the
 *      reflected ray with the strip plane in closed form. That is both cheaper than a cube
 *      sample and *more* correct than a PMREM, which cannot produce a parallax-correct
 *      strip streak at all.
 *
 * What replaces the missing irradiance is `environmentRadiance()` — the theme's own sky
 * gradient evaluated along a direction. It is a function, not a texture: no upload, no
 * mip chain, no renderer, and no reach outside the material that asked for it.
 * ======================================================================================
 *
 * SPACES, and why they are not interchangeable:
 *   • Break-up patterns key off `positionLocal`, which under `InstancedMesh` is the
 *     INSTANCE-transformed local position (three assigns it in `Instance.js`). The corridor
 *     shell scrolls as one Group; a pattern keyed off `positionWorld` would crawl across
 *     every wall as the treadmill moves, which is worse than being flat.
 *   • The planar reflection is solved in that same shell-local space, for the same reason:
 *     the strip grid scrolls with the shell, so its phase is only constant there.
 *   • Lighting lobes are view-space, matching the key-direction convention the ball and the
 *     glass already use.
 *
 * No colour literal appears in this file. Every colour arrives from the UniverseTheme.
 */

import type { Node } from 'three/webgpu';
import { Color, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  cameraViewMatrix,
  dot,
  float,
  fract,
  fwidth,
  mix,
  modelWorldMatrixInverse,
  mx_noise_float,
  normalLocal,
  normalView,
  normalize,
  positionLocal,
  positionView,
  pow,
  reflect,
  smoothstep,
  transformNormalToView,
  uv,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * What a tier is allowed to pay for. Same contract as GlassFeatures: the caller decides,
 * so the degradation table stays the single place that knows what a tier gets.
 */
export interface SurfaceFeatures {
  /** Brushed-metal lobe. Costs one extra half-vector and two pow(). */
  readonly anisotropy: boolean;
  /** Edge wear. Costs an fwidth() pair and one noise tap. */
  readonly edgeWear: boolean;
  /** Analytic environment + the planar strip reflection. */
  readonly reflection: boolean;
  /** Normal break-up. The expensive one: four noise taps for the gradient. */
  readonly detailNormal: boolean;
  /** Roughness break-up. One noise tap; keep it on everywhere. */
  readonly detailRoughness: boolean;
  /** Contact darkening at floor junctions. Two smoothsteps, no texture. */
  readonly contact: boolean;
}

export const SURFACES_ALL: SurfaceFeatures = Object.freeze({
  anisotropy: true, edgeWear: true, reflection: true,
  detailNormal: true, detailRoughness: true, contact: true,
});

export const SURFACES_NONE: SurfaceFeatures = Object.freeze({
  anisotropy: false, edgeWear: false, reflection: false,
  detailNormal: false, detailRoughness: false, contact: false,
});

/** The theme's sky, as the only environment this scene has. */
export interface SurfaceSky {
  readonly top: Color;
  readonly horizon: Color;
  readonly low: Color;
}

/**
 * The ceiling strip grid, in SHELL-LOCAL metres. Every field is a fact about the geometry
 * Playfield already builds, not a tuning knob — get one wrong and the reflection lands in
 * the wrong place, which is instantly visible.
 */
export interface StripGrid {
  /** Height of the strip plane. */
  readonly y: number;
  /** Lateral repeat and the phase of the first centre. */
  readonly pitchX: number;
  readonly phaseX: number;
  readonly halfWidthX: number;
  /** Longitudinal repeat, phase and half-length of one strip segment. */
  readonly pitchZ: number;
  readonly phaseZ: number;
  readonly halfLengthZ: number;
  readonly colour: Color;
}

/** Where the room's surfaces meet, for the contact term. Shell-local metres. */
export interface ContactGeometry {
  readonly floorY: number;
  /** |x| of the side walls. */
  readonly wallX: number;
}

/**
 * Magnitudes. Every one is a look decision that a faster GPU would not want changed, which
 * is why they live with the shader instead of in Quality.ts — the tier axis is expressed by
 * SurfaceFeatures, not by these numbers.
 */
const SHAPE = Object.freeze({
  /* ---- anisotropy -------------------------------------------------------------------
   * Two lobes. The wide one is the body of a brushed streak; on its own it reads as a
   * painted band, so a tight lobe rides on top to give the streak a core. Kajiya-Kay, not
   * Blinn: the highlight is the locus where the half-vector is PERPENDICULAR to the grain,
   * which is what makes it a streak across the brushing rather than a dot along it. */
  anisoWideExponent: 18,
  anisoWideGain: 0.34,
  anisoTightExponent: 220,
  anisoTightGain: 0.80,
  /** A brushed surface still has a diffuse floor; without it the metal is black off-lobe. */
  anisoWrap: 0.30,

  /* ---- edge wear --------------------------------------------------------------------
   * Held in DEVICE PIXELS via fwidth for the same reason the glass rim is: a world-space
   * wear line falls below one pixel around 40m and the far half of the corridor loses its
   * edges exactly where it most needs them. */
  wearPixels: 1.9,
  wearMinUv: 0.012,
  wearGain: 0.62,
  /** Wear is never uniform. Noise breaks the outline so it does not read as a wireframe. */
  wearNoiseScale: 6.5,
  wearNoiseDepth: 0.60,
  /** A worn edge is POLISHED, not scratched: it returns a tighter specular than the face. */
  wearRoughnessDrop: 0.26,
  /** Silhouette component, so curved and chamfered geometry wears too, not only box faces. */
  grazePower: 3.4,
  grazeGain: 0.45,

  /* ---- detail -----------------------------------------------------------------------
   * Amplitude is deliberately below the level at which it reads as a texture. The job is to
   * stop a facet returning ONE value, not to add visible relief. */
  detailScale: 2.7,
  detailNormalAmount: 0.22,
  detailRoughnessAmount: 0.11,
  /** Finite-difference step for the gradient, in metres. Must exceed float error at 150m. */
  detailEpsilon: 0.05,
  /** A second, finer octave on roughness only — free, since roughness needs no gradient. */
  detailFineScale: 11.0,
  detailFineAmount: 0.05,

  /* ---- reflection -------------------------------------------------------------------
   * Blur grows with the REFLECTED PATH LENGTH (eye→surface plus surface→ceiling), which is
   * the physical quantity a rough mirror blurs by. Distance alone gets the near floor wrong:
   * a strip 6m overhead is already blurred when the floor beneath it is 2m away. */
  reflectBlurPerMetre: 0.022,
  reflectBlurFloor: 0.05,
  /** Energy comes off the streak as it widens, or the far floor turns into a milky sheet. */
  reflectSpread: 0.55,
  reflectStripGain: 0.62,
  reflectEnvGain: 0.30,
  /** Schlick F0 for a dielectric. Kept physical: the grazing ramp is the whole effect. */
  reflectF0: 0.04,
  /** Below this the reflected ray is heading away from the ceiling and there is nothing. */
  reflectUpEpsilon: 0.03,

  /* ---- contact ----------------------------------------------------------------------
   * An occlusion, so it SUBTRACTS. ARCHITECTURE.md §6: contrast, not more glow. */
  contactRiseM: 0.75,
  contactReachM: 0.9,
  contactStrength: 0.55,
});

/** Squash a Color into a TSL constant. Colours are data from the theme, never literals. */
function rgb(c: Color): Node<'vec3'> {
  return vec3(c.r, c.g, c.b);
}

/**
 * The scene's only environment: the theme's sky gradient, evaluated along a direction.
 *
 * A real irradiance probe integrates the hemisphere; this samples one direction and is
 * therefore wrong for anything but a mirror. That is exactly the use: it feeds specular
 * lobes and a planar reflection, never a diffuse term. Law 1 in UniverseTheme.ts guarantees
 * `horizon` outglows both neighbours, so the band always lands where the eye expects it.
 */
export function environmentRadiance(direction: Node<'vec3'>, sky: SurfaceSky): Node<'vec3'> {
  const y = direction.y.clamp(-1, 1);
  const up = smoothstep(float(0), float(0.55), y);
  const down = smoothstep(float(0), float(-0.55), y);
  return mix(mix(rgb(sky.horizon), rgb(sky.top), up), rgb(sky.low), down);
}

/** One value-noise tap in the shell-local domain the whole module keys off. */
function localNoise(scale: number): Node<'float'> {
  return mx_noise_float(positionLocal.mul(float(scale)));
}

export interface DetailOptions {
  /** Metres per noise cell. Lower is coarser. */
  readonly scale?: number | undefined;
  readonly normalAmount?: number | undefined;
  readonly roughnessAmount?: number | undefined;
}

export interface SurfaceDetailNodes {
  /** View-space, ready to assign straight to `material.normalNode`. Null when disabled. */
  readonly normal: Node<'vec3'> | null;
  /** SIGNED break-up to ADD to a base roughness. Null when disabled. */
  readonly roughness: Node<'float'> | null;
}

/**
 * The composable core of `surfaceDetail`. Returns nodes so a factory in this file can fold
 * the break-up into a roughness graph it is already building, instead of overwriting it.
 *
 * The normal is bumped in LOCAL space and converted with `transformNormalToView`, which is
 * the same path three's own `normalView` takes — so a bumped normal and an unbumped one are
 * in the same space by construction rather than by hope.
 */
export function surfaceDetailNodes(
  features: SurfaceFeatures,
  options: DetailOptions = {},
): SurfaceDetailNodes {
  const scale = options.scale ?? SHAPE.detailScale;
  const normalAmount = options.normalAmount ?? SHAPE.detailNormalAmount;
  const roughnessAmount = options.roughnessAmount ?? SHAPE.detailRoughnessAmount;

  let normal: Node<'vec3'> | null = null;
  if (features.detailNormal) {
    const p = positionLocal.mul(float(scale));
    const e = float(SHAPE.detailEpsilon * scale);
    const centre = mx_noise_float(p);
    // Forward differences, not central: three taps instead of six, and the half-cell bias
    // it introduces is a shift of the pattern, which is invisible in noise.
    const gradient = vec3(
      mx_noise_float(p.add(vec3(SHAPE.detailEpsilon * scale, 0, 0))).sub(centre),
      mx_noise_float(p.add(vec3(0, SHAPE.detailEpsilon * scale, 0))).sub(centre),
      mx_noise_float(p.add(vec3(0, 0, SHAPE.detailEpsilon * scale))).sub(centre),
    ).div(e);

    const n = normalize(normalLocal);
    // Only the component of the gradient IN the surface tilts the normal. Keeping the
    // normal component would scale the normal rather than bend it, which does nothing.
    const tangential = gradient.sub(n.mul(dot(gradient, n)));
    normal = transformNormalToView(normalize(n.sub(tangential.mul(float(normalAmount)))));
  }

  let roughness: Node<'float'> | null = null;
  if (features.detailRoughness) {
    // Two octaves. The coarse one gives a facet more than one value; the fine one keeps the
    // specular from resolving into a clean shape, which is what makes plastic look plastic.
    roughness = localNoise(scale)
      .mul(float(roughnessAmount))
      .add(localNoise(SHAPE.detailFineScale).mul(float(SHAPE.detailFineAmount)));
  }

  return { normal, roughness };
}

/**
 * Applies break-up to any MeshStandardNodeMaterial in one call.
 *
 * Use this on a material this module did not build — the crystal hull, the cracked pane,
 * a kit prop. It reads `material.roughness` as the base, so call it BEFORE assigning a
 * roughnessNode of your own, or the two will fight.
 */
export function surfaceDetail(
  material: MeshStandardNodeMaterial,
  features: SurfaceFeatures,
  options: DetailOptions = {},
): void {
  const detail = surfaceDetailNodes(features, options);
  if (detail.normal !== null) material.normalNode = detail.normal;
  if (detail.roughness !== null) {
    material.roughnessNode = float(material.roughness).add(detail.roughness).clamp(0.02, 1);
  }
}

export interface ContactOptions {
  readonly geometry: ContactGeometry;
  /** How far the darkening climbs a wall, and reaches across a floor. Metres. */
  readonly riseM?: number | undefined;
  readonly reachM?: number | undefined;
  /** Peak darkening, 0..1. */
  readonly strength?: number | undefined;
}

/**
 * A multiplier in [1 - strength, 1] that darkens the junction between a wall and the floor.
 *
 * It is driven by the NORMAL as well as the position, and that is the whole trick: a
 * position-only term darkens the entire floor plane (every fragment on it is at floorY) and
 * the entire wall base equally. Splitting by facing gives the two halves of a real contact —
 * an upward-facing surface occludes as it approaches a wall, a sideways-facing surface
 * occludes as it approaches the floor — and they meet in the corner where both are true.
 *
 * `aoNode` would be the obvious home for this and is the wrong one: three routes `aoNode`
 * into INDIRECT diffuse only, and this scene has no ambient and no environment, so the
 * indirect term is ~0 and an AO node multiplied into it changes nothing. It has to fold
 * into the albedo.
 */
export function contactShadow(options: ContactOptions, features: SurfaceFeatures): Node<'float'> {
  if (!features.contact) return float(1);

  const rise = options.riseM ?? SHAPE.contactRiseM;
  const reach = options.reachM ?? SHAPE.contactReachM;
  const strength = options.strength ?? SHAPE.contactStrength;
  const { floorY, wallX } = options.geometry;

  const n = normalize(normalLocal);
  const upFacing = n.y.clamp(0, 1);
  const sideFacing = abs(n.y).oneMinus().clamp(0, 1);

  // 1 at the floor plane, 0 by `rise` metres above it.
  const nearFloor = smoothstep(float(floorY + rise), float(floorY), positionLocal.y);
  // 1 at a side wall, 0 by `reach` metres inboard of it.
  const nearWall = smoothstep(float(wallX - reach), float(wallX), abs(positionLocal.x));

  const occlusion = upFacing.mul(nearWall).max(sideFacing.mul(nearFloor)).mul(float(strength));
  return occlusion.oneMinus().clamp(0, 1);
}

/** The pixel-width edge term both metal and stone use. Constant apparent width at any depth. */
function edgeWearTerm(): Node<'float'> {
  const centred = uv().sub(0.5).abs();
  const borderDistance = float(0.5).sub(centred.x.max(centred.y));
  const uvPixel = fwidth(uv()).x.max(fwidth(uv()).y).max(float(1e-5));
  const wearUv = uvPixel.mul(float(SHAPE.wearPixels)).max(float(SHAPE.wearMinUv));
  const outline = smoothstep(wearUv, float(0), borderDistance);

  // Noise in [0,1]; the outline survives at wearNoiseDepth even where the noise is at zero,
  // so wear varies along an edge without ever dropping the edge itself.
  const patchy = localNoise(SHAPE.wearNoiseScale)
    .mul(0.5)
    .add(0.5)
    .mul(float(SHAPE.wearNoiseDepth))
    .add(float(1 - SHAPE.wearNoiseDepth));

  // The silhouette half. A box face's UV border cannot see a chamfer or a curve; grazing can.
  const viewDir = normalize(positionView.negate());
  const graze = pow(dot(normalize(normalView), viewDir).clamp(0, 1).oneMinus(), float(SHAPE.grazePower));

  return outline.mul(patchy).max(graze.mul(float(SHAPE.grazeGain))).clamp(0, 1);
}

export interface AnisotropicMetalOptions {
  readonly colour: Color;
  /** Highlight colour. The theme's metal read against its own sky, never a literal. */
  readonly sky: SurfaceSky;
  /** VIEW-space key direction — same convention as the ball and the glass streak. */
  readonly keyDirection: readonly [number, number, number];
  /** WORLD-space brushing direction. The highlight stretches PERPENDICULAR to this. */
  readonly brushDirection: readonly [number, number, number];
  readonly roughness: number;
  readonly features: SurfaceFeatures;
  /** Optional contact term; supply the room's geometry to get floor junctions for free. */
  readonly contact?: ContactOptions | undefined;
}

/**
 * Brushed metal that is not metallic.
 *
 * `metalness` stays 0 — see THE ENVIRONMENT DECISION above. What makes it read as metal is
 * the shape of the highlight, not the BRDF flag: an anisotropic lobe smeared across the
 * grain, a worn edge that is brighter and smoother than the face it borders, and a faint
 * sky term picked up off the reflection vector. Set `metalness` to anything above 0 here
 * and the surface goes black; that is not a bug in this function, it is the missing
 * environment, and it is why this one keeps the response synthetic.
 */
export function anisotropicMetal(options: AnisotropicMetalOptions): MeshStandardNodeMaterial {
  const f = options.features;
  const material = new MeshStandardNodeMaterial({
    color: new Color().copy(options.colour),
    roughness: options.roughness,
    metalness: 0,
  });

  const detail = surfaceDetailNodes(f);
  if (detail.normal !== null) material.normalNode = detail.normal;

  const n = detail.normal !== null ? normalize(detail.normal) : normalize(normalView);
  const viewDir = normalize(positionView.negate());
  const key = normalize(vec3(...options.keyDirection));
  const half = normalize(key.add(viewDir));

  let emissive: Node<'vec3'> = vec3(0, 0, 0);
  const highlight = rgb(options.sky.horizon);

  if (f.anisotropy) {
    // Grain, brought into view space and flattened onto the surface. Flattening matters:
    // an unprojected grain vector tilts the lobe off the surface and the streak drifts.
    const grainView = normalize(cameraViewMatrix.mul(vec4(...options.brushDirection, 0)).xyz);
    const grain = normalize(grainView.sub(n.mul(dot(grainView, n))));

    // Kajiya-Kay. sin(grain, half) peaks where the half-vector is PERPENDICULAR to the
    // grain, so the bright locus is a band running across the brushing — which is the
    // stretched highlight. A Blinn dot(n,h) lobe would give a round dot instead.
    const along = dot(grain, half).clamp(-1, 1);
    const across = along.mul(along).oneMinus().max(float(0)).sqrt();

    // Wrapped lambert gate. Unwrapped, the lobe survives on faces turned away from the key
    // and the mullions light up on their dark side.
    const facing = dot(n, key).add(float(SHAPE.anisoWrap)).div(float(1 + SHAPE.anisoWrap)).clamp(0, 1);

    const wide = pow(across, float(SHAPE.anisoWideExponent)).mul(float(SHAPE.anisoWideGain));
    const tight = pow(across, float(SHAPE.anisoTightExponent)).mul(float(SHAPE.anisoTightGain));
    emissive = emissive.add(highlight.mul(wide.add(tight)).mul(facing));
  }

  if (f.reflection) {
    // The sky along the reflection vector. One direction, no integral — legitimate here
    // because it feeds a specular term and never a diffuse one.
    const reflected = reflect(viewDir.negate(), n);
    const grazing = pow(dot(n, viewDir).clamp(0, 1).oneMinus(), float(5));
    const fresnel = float(SHAPE.reflectF0).add(grazing.mul(float(1 - SHAPE.reflectF0)));
    emissive = emissive.add(
      environmentRadiance(reflected, options.sky).mul(fresnel).mul(float(SHAPE.reflectEnvGain)),
    );
  }

  let roughness: Node<'float'> = float(options.roughness);
  if (detail.roughness !== null) roughness = roughness.add(detail.roughness);

  if (f.edgeWear) {
    const wear = edgeWearTerm();
    emissive = emissive.add(highlight.mul(wear).mul(float(SHAPE.wearGain)));
    roughness = roughness.sub(wear.mul(float(SHAPE.wearRoughnessDrop)));
  }

  material.emissiveNode = emissive;
  material.roughnessNode = roughness.clamp(0.02, 1);

  const contact = options.contact === undefined ? float(1) : contactShadow(options.contact, f);
  material.colorNode = rgb(options.colour).mul(contact);

  return material;
}

export interface ReflectiveFloorOptions {
  readonly colour: Color;
  readonly sky: SurfaceSky;
  readonly strips: StripGrid;
  readonly roughness: number;
  readonly features: SurfaceFeatures;
  readonly contact?: ContactOptions | undefined;
}

/**
 * Floor plates that reflect the ceiling strips, blurrier the further the reflection travels.
 *
 * The reflection is EXACT, not approximated: the strip grid is an analytic plane, so the
 * reflected ray is intersected with it in closed form and the strip mask is evaluated at the
 * hit point. A cube map cannot do this — its samples carry no parallax, so the streaks would
 * not slide as the camera moves, and sliding is the entire depth cue.
 *
 * Solved in SHELL-LOCAL space. The corridor scrolls as one Group, so the strip grid's phase
 * is only constant in the shell's own frame; solve it in world space and the reflection
 * crawls against the geometry casting it.
 *
 * The same material is correct on the ceiling plates: their normal points down, the
 * reflected ray never reaches the strip plane, and the term gates itself off.
 */
export function reflectiveFloor(options: ReflectiveFloorOptions): MeshStandardNodeMaterial {
  const f = options.features;
  const s = options.strips;

  const material = new MeshStandardNodeMaterial({
    color: new Color().copy(options.colour),
    roughness: options.roughness,
    metalness: 0,
  });

  const detail = surfaceDetailNodes(f);
  if (detail.normal !== null) material.normalNode = detail.normal;

  let roughness: Node<'float'> = float(options.roughness);
  if (detail.roughness !== null) roughness = roughness.add(detail.roughness);
  material.roughnessNode = roughness.clamp(0.02, 1);

  let emissive: Node<'vec3'> = vec3(0, 0, 0);

  if (f.reflection) {
    const eyeLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    const p = positionLocal;
    const n = normalize(normalLocal);
    const viewLocal = normalize(eyeLocal.sub(p));
    const r = reflect(viewLocal.negate(), n);

    // Distance along the reflected ray to the strip plane. Gated, not clamped: a ray with
    // r.y at or below zero has no intersection and must contribute nothing rather than a
    // huge t that aliases into a random part of the grid.
    const up = r.y.max(float(SHAPE.reflectUpEpsilon));
    const t = float(s.y).sub(p.y).div(up).max(float(0));
    const hit = p.add(r.mul(t));

    // Reflected path length: eye to floor, then floor to ceiling. This is the quantity a
    // rough reflector blurs by, and it is why the near floor already blurs a high strip.
    const path = eyeLocal.sub(p).length().add(t);
    const blur = float(SHAPE.reflectBlurFloor).add(path.mul(float(SHAPE.reflectBlurPerMetre)));

    // Distance from the hit to the nearest strip centre, on each axis independently.
    const dx = abs(fract(hit.x.sub(float(s.phaseX)).div(float(s.pitchX)).add(0.5)).sub(0.5))
      .mul(float(s.pitchX));
    const dz = abs(fract(hit.z.sub(float(s.phaseZ)).div(float(s.pitchZ)).add(0.5)).sub(0.5))
      .mul(float(s.pitchZ));

    const maskX = smoothstep(float(s.halfWidthX).add(blur), float(s.halfWidthX), dx);
    const maskZ = smoothstep(float(s.halfLengthZ).add(blur), float(s.halfLengthZ), dz);
    // Energy leaves the streak as it widens. Without this the far floor turns into the milky
    // sheet the exposure histogram exists to forbid.
    const spread = float(1).add(blur.mul(float(SHAPE.reflectSpread))).reciprocal();
    const facing = smoothstep(float(0), float(SHAPE.reflectUpEpsilon * 3), r.y);

    const grazing = pow(dot(n, viewLocal).clamp(0, 1).oneMinus(), float(5));
    const fresnel = float(SHAPE.reflectF0).add(grazing.mul(float(1 - SHAPE.reflectF0)));

    emissive = emissive
      .add(rgb(s.colour).mul(maskX).mul(maskZ).mul(spread).mul(facing).mul(float(SHAPE.reflectStripGain)))
      .add(environmentRadiance(r, options.sky).mul(float(SHAPE.reflectEnvGain)))
      .mul(fresnel);
  }

  if (f.edgeWear) {
    // Plate joints. The same pixel-width term, at half gain: a floor seam is a shallower
    // feature than a mullion edge and reads wrong at full strength.
    emissive = emissive.add(rgb(options.sky.horizon).mul(edgeWearTerm()).mul(float(SHAPE.wearGain * 0.5)));
  }

  material.emissiveNode = emissive;

  const contact = options.contact === undefined ? float(1) : contactShadow(options.contact, f);
  material.colorNode = rgb(options.colour).mul(contact);

  return material;
}

export interface WallSurfaceOptions {
  readonly colour: Color;
  readonly sky: SurfaceSky;
  readonly roughness: number;
  readonly features: SurfaceFeatures;
  readonly contact?: ContactOptions | undefined;
}

/**
 * Stone wall panels — the drop-in for `Playfield.wallBand()`.
 *
 * The depth ramp stays the CALLER's: this takes the already-attenuated colour and roughness
 * that `wallBand` computes, because that ramp is an exposure decision (ARCHITECTURE.md §6
 * site 1) and moving it into a material would put it out of reach of `validateExposure`.
 * What this adds is everything the ramp cannot: break-up, a worn panel edge, and the contact
 * with the floor.
 */
export function wallSurface(options: WallSurfaceOptions): MeshStandardNodeMaterial {
  const f = options.features;
  const material = new MeshStandardNodeMaterial({
    color: new Color().copy(options.colour),
    roughness: options.roughness,
    metalness: 0,
  });

  const detail = surfaceDetailNodes(f, { scale: SHAPE.detailScale * 0.7 });
  if (detail.normal !== null) material.normalNode = detail.normal;

  let roughness: Node<'float'> = float(options.roughness);
  if (detail.roughness !== null) roughness = roughness.add(detail.roughness);

  let emissive: Node<'vec3'> = vec3(0, 0, 0);
  if (f.edgeWear) {
    const wear = edgeWearTerm();
    // Stone chips rather than polishes, so it goes ROUGHER at the edge - the opposite sign
    // to metal. That difference is most of what separates the two materials at a glance.
    emissive = emissive.add(rgb(options.sky.horizon).mul(wear).mul(float(SHAPE.wearGain * 0.35)));
    roughness = roughness.add(wear.mul(float(SHAPE.wearRoughnessDrop * 0.5)));
  }

  material.emissiveNode = emissive;
  material.roughnessNode = roughness.clamp(0.02, 1);

  const contact = options.contact === undefined ? float(1) : contactShadow(options.contact, f);
  material.colorNode = rgb(options.colour).mul(contact);

  return material;
}
