/**
 * THE AIR.
 *
 * Three things the corridor was missing, and one rule that decides how each is built.
 *
 *   1. VOLUMETRIC SHAFTS with density that VARIES ALONG THE BEAM. A shaft rendered as one
 *      quad with a gradient is a painted triangle: it reads as a decal stuck to the screen
 *      because nothing about it changes as you fly past. Here each beam is a run of
 *      axis-aligned billboard slices, and its opacity is driven by two incommensurable
 *      travelling waves along its own length, so a beam has bright and dim bands that
 *      drift through it and no two beams are ever in phase.
 *   2. MOTES SUSPENDED INSIDE THOSE SHAFTS. A mote is not placed near a beam and hoped
 *      for; it is placed IN the beam's own parameter space - the same origin, axis, length
 *      and flaring radius attributes the beam body reads - so it is inside the volume by
 *      construction and stays inside it when the beam scrolls. Its brightness is modulated
 *      by the SAME density function the body uses, which is what sells the dust as being
 *      lit by the beam rather than floating in front of it.
 *   3. THREE PARALLAX TIERS of ambient grain. Near is large, fast and swayed hardest; far
 *      is small, slow and nearly still. Rates come from `theme.motes.driftRates`, which the
 *      theme validator already forces to descend near-to-far, so the parallax cannot invert.
 *
 * THE RULE: every position in this file is computed on the GPU from per-instance
 * attributes and a handful of scalar uniforms. The CPU writes five floats per frame and
 * nothing else. That is what lets ~1500 elements cost FIVE draw calls, and it is why the
 * per-frame cost does not grow with the element count.
 *
 * WHAT HOLDS A NUMBER HERE. Counts and feature flags are budgets and come from
 * `ATMOSPHERE[tier]` in core/Quality.ts through `AtmosphereBudget`; this file invents none. The
 * `AIR` table below is art direction in the sense of corridor/Exposure.ts - a faster GPU
 * would want the same beam alpha and the same flare, so those live with the thing they
 * describe. Colour comes from the theme and from nowhere else.
 *
 * EXPOSURE. Everything here is additive, and additive is how a frame goes milky (see
 * docs/ARCHITECTURE.md section 6). Three defences: peak alphas are authored an order of
 * magnitude below anything else in the scene, every layer is scaled by the theme's own
 * haze density so a clear universe gets clear air, and depth testing stays ON so a beam
 * behind a wall is occluded by it rather than added on top of it.
 */

import {
  AdditiveBlending,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SpriteNodeMaterial,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import type { Color, Material, Node } from 'three/webgpu';
import {
  cameraPosition,
  cos,
  float,
  fract,
  instancedBufferAttribute,
  mix,
  positionGeometry,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl';

import type { Disposable, Millis, Seed, Tickable } from '../core/types';
import { asSeed } from '../core/types';
import type { Rng } from '../battle/types';
import { createRng, forkByName } from '../battle/Rng';
import { getTheme } from '../universe/registry';
import type { MoteKind, UniverseId, UniverseTheme } from '../universe/UniverseTheme';
import { lightBus } from '../universe/LightBus';
import type { LightBusUniforms } from '../universe/LightBus';

/* ------------------------------------------------------------------ the tier contract */

/**
 * One row of `ATMOSPHERE[tier]`. Declared here rather than in Quality.ts for the
 * same reason GlassToggles is declared there and consumed here: the degradation table is
 * the one place allowed to decide what a tier gets, and this is the one place that knows
 * what the fields mean. The two are structurally compatible and the compiler checks it at
 * the call site.
 */
export interface AtmosphereBudget {
  /** Volumetric beams in the corridor at once. */
  readonly shafts: number;
  /** Billboard slices per beam. This is what buys variation ALONG a beam; 1 is a gradient. */
  readonly shaftSlices: number;
  /** Motes suspended inside the beams, shared evenly between them. */
  readonly shaftMotes: number;
  /** Ambient grain per parallax tier, ordered NEAR to FAR to match theme.motes.driftRates. */
  readonly parallax: readonly [number, number, number];
  /** The travelling density waves. Off leaves a smooth beam - cheaper, and flatter. */
  readonly densityVariation: boolean;
}

/** Every count at zero: the A/B control, and what MOBILE_LOW's row must equal. */
export const ATMOSPHERE_OFF: AtmosphereBudget = Object.freeze({
  shafts: 0,
  shaftSlices: 0,
  shaftMotes: 0,
  parallax: Object.freeze([0, 0, 0]) as readonly [number, number, number],
  densityVariation: false,
});

/** The box the air fills, in metres. Handed in, so this layer knows no corridor geometry. */
export interface AtmosphereVolume {
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** Metres from the camera to the far end of the built corridor. */
  readonly depth: number;
}

export interface AtmosphereOptions {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly theme: UniverseTheme;
  readonly budget: AtmosphereBudget;
  readonly volume: AtmosphereVolume;
  readonly seed: Seed;
  /** MOTION[tier].moteDriftScale. Drift and sway are movement, so they ride the motion axis. */
  readonly motionScale?: number;
  /** Test seam. Production passes nothing and gets the one bus every material reads. */
  readonly light?: LightBusUniforms;
}

/** What the layer actually built, counted from the graph rather than from its own table. */
export interface AtmosphereReport {
  /** Draw calls this layer adds. One per InstancedMesh. */
  readonly meshes: number;
  /** Instances across every mesh - the number DebugBridge's elementCount will grow by. */
  readonly elements: number;
  readonly shaftSlices: number;
  readonly shaftMotes: number;
  readonly parallax: readonly [number, number, number];
  readonly densityVariation: boolean;
}

/* --------------------------------------------------------------------- art direction */

/**
 * Shape, alpha and rate. NOT budgets: a faster GPU wants a beam of exactly this density,
 * so by the test in docs/ARCHITECTURE.md these live with the thing they describe. The one
 * number here that is a budget - how many of each - arrives in AtmosphereBudget.
 */
const AIR = Object.freeze({
  /**
   * `theme.haze.density` is a per-metre extinction coefficient in the 0.03-0.058 range, not
   * an opacity. Dividing by the middle of that range turns it into a gain around 1.0, so a
   * hazy universe gets thicker air than a clear one without any theme reaching for a second
   * number that means the same thing.
   */
  referenceHazeDensity: 0.048,

  shaft: {
    /** Beam half-width where it enters the ceiling, metres. */
    slotHalfWidth: 0.5,
    /** Half-width multiplier at the far end. A beam that does not spread reads as a bar. */
    flare: 2.4,
    /** Maximum lean off vertical, per axis. Vertical beams in a row read as a fence. */
    tiltMax: 0.36,
    /** Beam runs past the floor by this factor so it never terminates in mid-air. */
    lengthSlack: 1.4,
    /** Peak opacity at the core of a slice, before haze gain. Additive: keep it tiny. */
    peakAlpha: 0.055,
    /** Higher concentrates the beam into its axis instead of spreading it as a wash. */
    coreExponent: 1.8,
    /**
     * Half-length of a slice as a multiple of the spacing between them. At 1.0 neighbouring
     * slices overlap by exactly half, and the raised-cosine window each one carries then
     * sums to precisely one along the whole beam - so a beam has NO beading between its
     * slices and every variation visible along it is the density wave, which is the point.
     */
    sliceHalfSpan: 1.0,
    /** The beam is up to strength by this t, and dying from this one. */
    headFade: 0.12,
    tailFade: 0.58,
    /**
     * Metres BEHIND the camera at which a beam recycles. A beam that wrapped at the camera
     * plane would blink out in the periphery, which is the one place the eye is best at
     * catching a pop.
     */
    wrapBehind: 9,
    /** Two incommensurable periods along the beam, so banding never visibly repeats. */
    bandsA: 5.5,
    bandsB: 9.25,
    /** Band travel, in beam lengths per second. Opposed signs: the two waves cross. */
    driftA: 0.19,
    driftB: -0.11,
    /** Depth of the density modulation, as a fraction of mean density. */
    variationAmp: 0.55,
    /** How hard lightBus.shaftOpacity thickens a beam. The battle THICKENS a god ray. */
    busGain: 1.7,
  },

  shaftMote: {
    sizeMin: 0.022,
    sizeMax: 0.058,
    /** Beam lengths per second. Dust falls down a shaft slowly or it reads as rain. */
    speedMin: 0.05,
    speedMax: 0.19,
    peakAlpha: 0.34,
    /** > 1 pulls motes toward the beam axis, where a real beam is brightest. */
    radialBias: 1.45,
    /** Nothing is placed on the exact surface of the beam, so every mote is strictly inside. */
    radialInset: 0.92,
    /** How much the beam's own density wave brightens the dust floating in it. */
    densityCoupling: 0.8,
  },

  /** Per parallax tier, ordered NEAR, MID, FAR - the same order as theme.motes.driftRates. */
  parallax: {
    /**
     * Fraction of the corridor depth each tier spans. Every band STARTS behind the camera
     * for the same reason a beam does: a particle that wraps in front of you pops, and the
     * tiers are separated by how deep they run, not by holding the near ones off the lens.
     */
    bandStart: [-0.06, -0.06, -0.06] as const,
    bandEnd: [0.32, 0.7, 1.0] as const,
    /** Sprite size in metres before per-instance jitter. Near is large, far is small. */
    size: [0.075, 0.042, 0.022] as const,
    peakAlpha: [0.1, 0.068, 0.042] as const,
    /**
     * Share of the corridor's own travel each tier carries. Near moves with the world, far
     * lags it - which is the exaggeration that makes travel read as depth rather than as a
     * uniform slide. Perspective alone is not enough at this fov.
     */
    travelShare: [1.0, 0.66, 0.34] as const,
    /** Lateral sway amplitude, metres, and its rate in Hz. */
    sway: [0.24, 0.13, 0.055] as const,
    swayHz: [0.31, 0.19, 0.11] as const,
    sizeJitter: 0.55,
  },
});

/** How a universe's dust is SHAPED. Data axis, read unconditionally - never an id branch. */
interface MoteLook {
  /** Falloff exponent. High is a hard sparkle, low is a soft smudge. */
  readonly falloff: number;
  /** Height over width. Flakes are wide and thin; sparks are square. */
  readonly aspect: number;
  /** Depth of the per-mote brightness flicker. */
  readonly twinkle: number;
}

const MOTE_LOOK: Readonly<Record<MoteKind, MoteLook>> = Object.freeze({
  'bone-dust': { falloff: 1.6, aspect: 1.0, twinkle: 0.16 },
  'glass-flake': { falloff: 3.2, aspect: 0.45, twinkle: 0.62 },
  'civic-ash': { falloff: 1.2, aspect: 0.85, twinkle: 0.1 },
  'spray-sail-ash': { falloff: 1.4, aspect: 0.7, twinkle: 0.24 },
  'swarf-flake': { falloff: 3.6, aspect: 0.35, twinkle: 0.7 },
  'ash-ofuda': { falloff: 1.1, aspect: 1.3, twinkle: 0.18 },
  'updraft-spark': { falloff: 4.2, aspect: 1.0, twinkle: 0.85 },
});

/**
 * Phase wrap, seconds. Long enough that no run reaches it and short enough that the float
 * uniform never loses sub-millisecond resolution.
 */
const PHASE_WRAP_S = 1e4;

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------------ the layer */

/** One beam, resolved on the CPU once at build time and never touched again. */
interface Beam {
  readonly x: number;
  readonly y: number;
  /** Distance-from-the-far-end coordinate, [0, depth). Scrolling wraps within that span. */
  readonly d: number;
  readonly axis: Vector3;
  /** Unit vector perpendicular to the axis; with `perpV` it spans the beam's cross-section. */
  readonly perpU: Vector3;
  readonly perpV: Vector3;
  readonly length: number;
  readonly radius: number;
  readonly flare: number;
  readonly brightness: number;
  readonly seed: number;
}

export class Atmosphere implements Tickable, Disposable {
  /**
   * Stays at the identity for the life of the layer. Every vertex position in this file is
   * computed in world space by the shader; moving the root would double-apply the transform.
   */
  readonly root = new Group();

  private readonly scene: Scene;
  private readonly budget: AtmosphereBudget;
  private readonly depth: number;
  private readonly motionScale: number;
  private readonly driftRates: readonly [number, number, number];

  /** One quad, shared by all five meshes. Per-instance data lives on the materials. */
  private readonly quad = new PlaneGeometry(1, 1);
  private readonly meshes: InstancedMesh[] = [];
  private readonly materials: Material[] = [];

  /** Corridor travel already applied to the beams, wrapped into [0, depth). */
  private readonly uShaftScroll = uniform(0).setName('spAirShaftScroll');
  /** Seconds since the layer was built, wrapped. Drives every wave and every drift. */
  private readonly uPhase = uniform(0).setName('spAirPhase');
  /** Seconds of mote drift, already scaled by the motion axis. */
  private readonly uDrift = uniform(0).setName('spAirDrift');
  private readonly uParallaxScroll = [
    uniform(0).setName('spAirParallaxNear'),
    uniform(0).setName('spAirParallaxMid'),
    uniform(0).setName('spAirParallaxFar'),
  ] as const;
  /** Band length per parallax tier, metres. Each tier wraps inside its own band. */
  private readonly bandSpan: [number, number, number] = [1, 1, 1];

  private phaseS = 0;
  private shaftScrollM = 0;
  private driftS = 0;
  private readonly parallaxScrollM: [number, number, number] = [0, 0, 0];
  private travelSpeed = 0;

  private shaftSliceCount = 0;
  private shaftMoteCount = 0;
  private readonly parallaxCount: [number, number, number] = [0, 0, 0];

  constructor(options: AtmosphereOptions) {
    this.scene = options.scene;
    this.budget = options.budget;
    this.motionScale = options.motionScale ?? 1;
    this.driftRates = options.theme.motes.driftRates;

    // Air past the far plane is air nobody can see, and instances nobody can see are the
    // cheapest thing to not build. This is the only thing the camera is consulted for:
    // every other camera-dependent quantity is resolved per-vertex on the GPU.
    this.depth = Math.max(1, Math.min(options.volume.depth, options.camera.far));

    for (let tier = 0; tier < 3; tier++) {
      const start = AIR.parallax.bandStart[tier] ?? 0;
      const end = AIR.parallax.bandEnd[tier] ?? 1;
      this.bandSpan[tier] = Math.max(1, (end - start) * this.depth);
    }

    const light = options.light ?? lightBus.uniforms;
    const haze = options.theme.haze.density / AIR.referenceHazeDensity;
    const rng = createRng(options.seed);

    const beams = this.seedBeams(forkByName(rng, 'atmosphere.beams'), options.volume);
    if (beams.length > 0) {
      this.buildShaftBodies(beams, options.theme, haze, light);
      this.buildShaftMotes(forkByName(rng, 'atmosphere.shaft-motes'), beams, options.theme, haze, light);
    }
    this.buildParallax(forkByName(rng, 'atmosphere.parallax'), options.theme, options.volume, haze);

    this.scene.add(this.root);
  }

  /* ---------------------------------------------------------------- construction */

  private seedBeams(rng: Rng, volume: AtmosphereVolume): Beam[] {
    const beams: Beam[] = [];
    const s = AIR.shaft;

    for (let i = 0; i < this.budget.shafts; i++) {
      const axis = new Vector3(
        rng.range(-s.tiltMax, s.tiltMax),
        -1,
        rng.range(-s.tiltMax, s.tiltMax),
      ).normalize();

      // A stable reference that is never parallel to the axis: the axis always leans mostly
      // down, so world +Z can only be degenerate for a beam that is nearly horizontal, which
      // tiltMax forbids.
      const perpU = new Vector3(0, 0, 1).cross(axis).normalize();
      const perpV = new Vector3().copy(axis).cross(perpU).normalize();

      beams.push({
        x: rng.range(-volume.halfWidth * 0.78, volume.halfWidth * 0.78),
        y: volume.halfHeight,
        d: rng.range(0, this.depth),
        axis,
        perpU,
        perpV,
        // Down through the corridor and out the bottom, measured along the lean.
        length: (volume.halfHeight * 2 * s.lengthSlack) / Math.max(0.35, Math.abs(axis.y)),
        radius: s.slotHalfWidth * rng.range(0.78, 1.4),
        // NOT jittered per beam. The motes rebuild this same cone from the same constant at
        // runtime, so a per-beam flare would put a beam's own dust outside it.
        flare: s.flare,
        brightness: rng.range(0.68, 1.3),
        seed: rng.next(),
      });
    }
    return beams;
  }

  /**
   * The beam bodies. Each slice is a quad that keeps the beam axis in its plane and spins
   * about that axis to face the camera - an axis-aligned billboard, which is the only cheap
   * primitive that reads as a volume from every angle a corridor gives you. A camera-facing
   * sprite would swim as you pass it, and a fixed card would vanish edge-on.
   */
  private buildShaftBodies(
    beams: readonly Beam[],
    theme: UniverseTheme,
    haze: number,
    light: LightBusUniforms,
  ): void {
    const slices = Math.max(1, this.budget.shaftSlices);
    const count = beams.length * slices;
    const origin = new Float32Array(count * 3);
    const axis = new Float32Array(count * 3);
    const span = new Float32Array(count * 4);
    const beamData = new Float32Array(count * 4);

    let n = 0;
    for (const beam of beams) {
      const segment = beam.length / slices;
      for (let i = 0; i < slices; i++) {
        const t = (i + 0.5) / slices;
        origin[n * 3 + 0] = beam.x;
        origin[n * 3 + 1] = beam.y;
        origin[n * 3 + 2] = beam.d;
        axis[n * 3 + 0] = beam.axis.x;
        axis[n * 3 + 1] = beam.axis.y;
        axis[n * 3 + 2] = beam.axis.z;
        span[n * 4 + 0] = t * beam.length;
        span[n * 4 + 1] = segment * AIR.shaft.sliceHalfSpan;
        span[n * 4 + 2] = beam.radius * (1 + (beam.flare - 1) * t);
        span[n * 4 + 3] = t;
        beamData[n * 4 + 0] = beam.length;
        beamData[n * 4 + 1] = beam.seed;
        beamData[n * 4 + 2] = beam.brightness;
        beamData[n * 4 + 3] = 0;
        n++;
      }
    }

    const aOrigin = instancedBufferAttribute<'vec3'>(origin, 'vec3');
    const aAxis = instancedBufferAttribute<'vec3'>(axis, 'vec3');
    const aSpan = instancedBufferAttribute<'vec4'>(span, 'vec4');
    const aBeam = instancedBufferAttribute<'vec4'>(beamData, 'vec4');

    const centre = this.beamPoint(aOrigin, aAxis, aSpan.x);
    // cross(axis, toCamera) is the one direction that is perpendicular to both the beam and
    // the view, which is exactly the direction the slice has to widen along.
    const toCam = cameraPosition.sub(centre).normalize();
    const raw = aAxis.cross(toCam);
    const side = raw.div(raw.length().max(float(1e-4))).mul(aSpan.z.mul(float(2)));
    const along = aAxis.mul(aSpan.y.mul(float(2)));

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      // The billboard can present either face as it spins about its beam.
      side: DoubleSide,
      // Additive blending is order-independent, so the back-then-front pass three runs for
      // double-sided transparency buys nothing here and would double this layer's draw calls.
      forceSinglePass: true,
    });
    material.positionNode = centre
      .add(side.mul(positionGeometry.x))
      .add(along.mul(positionGeometry.y));

    // t along the WHOLE beam, not along this slice: the density wave has to be continuous
    // across the seam between two slices or the seam becomes the pattern.
    const vT = varying(aSpan.w.add(positionGeometry.y.mul(aSpan.y.mul(float(2))).div(aBeam.x)));
    // -1..1 across the slice, and -1..1 along it. Both fade to nothing at their border.
    const vU = varying(positionGeometry.x.mul(float(2)));
    const vAlong = varying(positionGeometry.y.mul(float(2)));
    const vSeed = varying(aBeam.y);
    const vBright = varying(aBeam.z);

    // Ascending edges plus oneMinus, never a reversed smoothstep: WGSL leaves low >= high
    // indeterminate, and the polynomial is symmetric so this is the same curve.
    const core = smoothstep(float(0), float(1), vU.abs()).oneMinus().pow(float(AIR.shaft.coreExponent));
    // Raised cosine, zero at both ends of the slice: the partition of unity described above.
    const seam = cos(vAlong.mul(float(Math.PI))).add(float(1)).mul(float(0.5));
    const envelope = smoothstep(float(0), float(AIR.shaft.headFade), vT).mul(
      smoothstep(float(AIR.shaft.tailFade), float(1), vT).oneMinus(),
    );

    const alpha = core
      .mul(seam)
      .mul(envelope)
      .mul(vBright)
      .mul(this.densityNode(vT, vSeed))
      // The battle THICKENS a shaft rather than switching it on: at neutral the corridor
      // still has its own air, and a beat can only add to it.
      .mul(float(1).add(light.shaftOpacity.mul(float(AIR.shaft.busGain))))
      .mul(float(AIR.shaft.peakAlpha * haze));

    material.opacityNode = alpha.clamp(0, 1);
    // The beam is the horizon's light near the slot and the room's haze by the time it
    // reaches the floor, which is what an atmosphere physically does to a shaft of light.
    material.colorNode = mix(
      this.colour(theme.sky.horizon),
      this.colour(theme.haze.color),
      vT.clamp(0, 1),
    );

    this.shaftSliceCount = count;
    this.mount(material, count);
  }

  /**
   * Dust inside the beams. Every mote is positioned in its beam's own frame from the same
   * attributes the body reads, so "inside the volume" is a property of the construction
   * rather than something to eyeball: radius is the beam's flaring radius at the mote's own
   * t, scaled by a fraction strictly below 1.
   */
  private buildShaftMotes(
    rng: Rng,
    beams: readonly Beam[],
    theme: UniverseTheme,
    haze: number,
    light: LightBusUniforms,
  ): void {
    const count = this.budget.shaftMotes;
    if (count <= 0) return;

    const origin = new Float32Array(count * 3);
    const axis = new Float32Array(count * 3);
    const offset = new Float32Array(count * 3);
    const mote = new Float32Array(count * 4);
    const beamData = new Float32Array(count * 4);
    const m = AIR.shaftMote;

    for (let i = 0; i < count; i++) {
      // Round-robin rather than random: an even share keeps a four-beam field from putting
      // three quarters of its dust in one beam on an unlucky seed.
      const beam = beams[i % beams.length] as Beam;
      const angle = rng.range(0, TAU);
      const ux = beam.perpU.x * Math.cos(angle) + beam.perpV.x * Math.sin(angle);
      const uy = beam.perpU.y * Math.cos(angle) + beam.perpV.y * Math.sin(angle);
      const uz = beam.perpU.z * Math.cos(angle) + beam.perpV.z * Math.sin(angle);

      origin[i * 3 + 0] = beam.x;
      origin[i * 3 + 1] = beam.y;
      origin[i * 3 + 2] = beam.d;
      axis[i * 3 + 0] = beam.axis.x;
      axis[i * 3 + 1] = beam.axis.y;
      axis[i * 3 + 2] = beam.axis.z;
      offset[i * 3 + 0] = ux;
      offset[i * 3 + 1] = uy;
      offset[i * 3 + 2] = uz;
      mote[i * 4 + 0] = Math.pow(rng.next(), m.radialBias) * m.radialInset;
      mote[i * 4 + 1] = rng.next();
      mote[i * 4 + 2] = rng.range(m.speedMin, m.speedMax);
      mote[i * 4 + 3] = rng.range(m.sizeMin, m.sizeMax);
      beamData[i * 4 + 0] = beam.length;
      beamData[i * 4 + 1] = beam.seed;
      beamData[i * 4 + 2] = beam.brightness * rng.range(0.6, 1.35);
      beamData[i * 4 + 3] = beam.radius;
    }

    const aOrigin = instancedBufferAttribute<'vec3'>(origin, 'vec3');
    const aAxis = instancedBufferAttribute<'vec3'>(axis, 'vec3');
    const aOffset = instancedBufferAttribute<'vec3'>(offset, 'vec3');
    const aMote = instancedBufferAttribute<'vec4'>(mote, 'vec4');
    const aBeam = instancedBufferAttribute<'vec4'>(beamData, 'vec4');

    // Falls down its own beam and wraps, so a beam is never briefly empty.
    const t = fract(aMote.y.add(this.uDrift.mul(aMote.z)));
    const radius = aBeam.w
      .mul(float(1).add(float(AIR.shaft.flare - 1).mul(t)))
      .mul(aMote.x);
    const centre = this.beamPoint(aOrigin, aAxis, t.mul(aBeam.x)).add(aOffset.mul(radius));

    const look = MOTE_LOOK[theme.motes.kind];
    const material = new SpriteNodeMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    material.positionNode = centre;
    material.scaleNode = vec2(aMote.w, aMote.w.mul(float(look.aspect)));

    const vT = varying(t);
    const vSeed = varying(aBeam.y);
    const vBright = varying(aBeam.z);
    const radial = smoothstep(float(0), float(1), uv().sub(0.5).length().mul(float(2))).oneMinus();
    // Dust brightens where its beam is dense. The coupling is the whole tell that the mote
    // is IN the beam rather than in front of it.
    const density = mix(
      float(1),
      this.densityNode(vT, vSeed),
      float(AIR.shaftMote.densityCoupling),
    );
    const twinkle = float(1).add(
      sin(this.uPhase.mul(float(2.7)).add(vSeed.mul(float(TAU)))).mul(float(look.twinkle)),
    );

    material.opacityNode = radial
      .pow(float(look.falloff))
      .mul(vBright)
      .mul(density)
      .mul(twinkle)
      // Born and dying with its beam, on the beam's own envelope, rather than popping in at
      // the slot and surviving past the floor.
      .mul(smoothstep(float(0), float(AIR.shaft.headFade), vT))
      .mul(smoothstep(float(AIR.shaft.tailFade), float(1), vT).oneMinus())
      .mul(float(1).add(light.shaftOpacity.mul(float(AIR.shaft.busGain))))
      .mul(float(AIR.shaftMote.peakAlpha * haze))
      .clamp(0, 1);
    material.colorNode = mix(this.colour(theme.sky.horizon), this.colour(theme.emissive.primary), float(0.25));

    this.shaftMoteCount = count;
    this.mount(material, count);
  }

  /**
   * Ambient grain in three depth bands. The tiers differ in size, in how much of the
   * corridor's travel they carry and in how hard they sway, and every one of those three
   * differences pushes the same way: near reads near, far reads far.
   */
  private buildParallax(
    rng: Rng,
    theme: UniverseTheme,
    volume: AtmosphereVolume,
    haze: number,
  ): void {
    const look = MOTE_LOOK[theme.motes.kind];

    for (let tier = 0; tier < 3; tier++) {
      const count = this.budget.parallax[tier] ?? 0;
      if (count <= 0) continue;

      const span = this.bandSpan[tier] ?? 1;
      const start = (AIR.parallax.bandStart[tier] ?? 0) * this.depth;
      const size = AIR.parallax.size[tier] ?? 0.05;
      const sway = (AIR.parallax.sway[tier] ?? 0) * this.motionScale;
      const hz = AIR.parallax.swayHz[tier] ?? 0.2;
      const peak = AIR.parallax.peakAlpha[tier] ?? 0.05;

      const seat = new Float32Array(count * 4);
      const grain = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        seat[i * 4 + 0] = rng.range(-volume.halfWidth * 0.96, volume.halfWidth * 0.96);
        seat[i * 4 + 1] = rng.range(-volume.halfHeight * 0.96, volume.halfHeight * 0.96);
        seat[i * 4 + 2] = rng.range(0, span);
        seat[i * 4 + 3] = rng.range(0, TAU);
        grain[i * 2 + 0] = size * rng.range(1 - AIR.parallax.sizeJitter, 1 + AIR.parallax.sizeJitter);
        grain[i * 2 + 1] = rng.range(0.55, 1.35);
      }

      const aSeat = instancedBufferAttribute<'vec4'>(seat, 'vec4');
      const aGrain = instancedBufferAttribute<'vec2'>(grain, 'vec2');
      const scroll = this.uParallaxScroll[tier] ?? this.uParallaxScroll[0];

      // Both terms are already wrapped into [0, span) on the CPU, so their sum needs at
      // most ONE subtraction to wrap. That is exact on every backend, which a modulo of a
      // possibly-negative operand is not.
      const raw = aSeat.z.add(scroll);
      const wrapped = raw.sub(float(span).mul(step(float(span), raw)));
      const drift = aSeat.w.add(this.uPhase.mul(float(TAU * hz)));

      const material = new SpriteNodeMaterial({
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      });
      material.positionNode = vec3(
        aSeat.x.add(sin(drift).mul(float(sway))),
        aSeat.y.add(cos(drift.mul(float(0.73))).mul(float(sway * 0.55))),
        wrapped.add(float(start)).negate(),
      );
      material.scaleNode = vec2(aGrain.x, aGrain.x.mul(float(look.aspect)));

      const vBright = varying(aGrain.y);
      const radial = smoothstep(float(0), float(1), uv().sub(0.5).length().mul(float(2))).oneMinus();
      material.opacityNode = radial
        .pow(float(look.falloff))
        .mul(vBright)
        .mul(float(peak * haze))
        .clamp(0, 1);
      // Near grain still belongs to the room's light; far grain has already dissolved into
      // the haze it is seen through.
      material.colorNode = mix(
        this.colour(theme.sky.horizon),
        this.colour(theme.haze.color),
        float(tier / 2),
      );

      this.parallaxCount[tier] = count;
      this.mount(material, count);
    }
  }

  /**
   * A point on a beam, with the corridor's travel applied and wrapped. Shared by the body
   * and by its motes so the two cannot ever disagree about where the beam is.
   */
  private beamPoint(
    origin: Node<'vec3'>,
    axis: Node<'vec3'>,
    distance: Node<'float'>,
  ): Node<'vec3'> {
    const raw = origin.z.add(this.uShaftScroll);
    const wrapped = raw.sub(float(this.depth).mul(step(float(this.depth), raw)));
    return vec3(origin.x, origin.y, wrapped.negate().add(float(AIR.shaft.wrapBehind))).add(
      axis.mul(distance),
    );
  }

  /**
   * Density along a beam: two travelling waves at incommensurable periods, offset by the
   * beam's own seed. This is the difference between a shaft and a gradient, and it is the
   * one thing MOBILE_HIGH gives up - there it collapses to a constant and the beam keeps
   * only its envelope.
   */
  private densityNode(t: Node<'float'>, seed: Node<'float'>): Node<'float'> {
    if (!this.budget.densityVariation) return float(1);
    const s = AIR.shaft;
    const a = sin(
      t.mul(float(s.bandsA)).add(seed.mul(float(TAU))).add(this.uPhase.mul(float(s.driftA * TAU))),
    );
    const b = sin(
      t.mul(float(s.bandsB)).sub(this.uPhase.mul(float(s.driftB * TAU))).add(seed.mul(float(11.3))),
    );
    return float(1)
      .add(a.mul(float(0.62)).add(b.mul(float(0.38))).mul(float(s.variationAmp)))
      .clamp(0, 2);
  }

  private colour(c: Color): Node<'vec3'> {
    return vec3(c.r, c.g, c.b);
  }

  /**
   * One InstancedMesh per material: one draw call, however many instances it carries. The
   * instance matrices are all identity because every position is computed in the shader -
   * they exist only so nothing downstream meets an uninitialised matrix.
   */
  private mount(material: Material, count: number): void {
    const mesh = new InstancedMesh(this.quad, material, count);
    const identity = new Matrix4();
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, identity);
    mesh.instanceMatrix.needsUpdate = true;
    // Positions live in the shader, so a CPU bounding volume would cull the layer at random.
    mesh.frustumCulled = false;
    // After the corridor, before nothing: additive air must not write depth over glass.
    mesh.renderOrder = 2;
    this.root.add(mesh);
    this.meshes.push(mesh);
    this.materials.push(material);
  }

  /* ------------------------------------------------------------------------- ticking */

  /** Metres per second the world slides toward the camera. Pushed by whoever owns travel. */
  setTravelSpeed(metresPerSecond: number): void {
    this.travelSpeed = Number.isFinite(metresPerSecond) ? metresPerSecond : 0;
  }

  fixedUpdate(dtMs: Millis): void {
    const dt = dtMs / 1000;
    if (!(dt > 0)) return;

    this.phaseS = (this.phaseS + dt) % PHASE_WRAP_S;
    // Wrapped at the same horizon as the phase. Each mote has its own speed, so a wrap does
    // jump them - once every three hours of unbroken play, by a pixel of dust each.
    this.driftS = (this.driftS + dt * this.motionScale) % PHASE_WRAP_S;
    this.shaftScrollM = wrap(this.shaftScrollM + this.travelSpeed * dt, this.depth);

    for (let tier = 0; tier < 3; tier++) {
      const share = AIR.parallax.travelShare[tier] ?? 1;
      const rate = this.driftRates[tier] ?? 0;
      const span = this.bandSpan[tier] ?? 1;
      const advance = (this.travelSpeed * share + rate) * this.motionScale * dt;
      this.parallaxScrollM[tier] = wrap((this.parallaxScrollM[tier] ?? 0) + advance, span);
    }

    this.uPhase.value = this.phaseS;
    this.uDrift.value = this.driftS;
    this.uShaftScroll.value = this.shaftScrollM;
    for (let tier = 0; tier < 3; tier++) {
      const node = this.uParallaxScroll[tier];
      if (node !== undefined) node.value = this.parallaxScrollM[tier] ?? 0;
    }
  }

  frame(): void {
    // Nothing to interpolate. Every position is a pure function of uniforms the fixed step
    // already wrote, so a frame between two steps draws the last step's air - which at
    // these drift rates is below the noise floor and costs no CPU at all.
  }

  /* -------------------------------------------------------------------- measurement */

  /** Counted from the graph that was actually built, never from the budget that asked. */
  report(): AtmosphereReport {
    let elements = 0;
    for (const mesh of this.meshes) elements += mesh.count;
    return {
      meshes: this.meshes.length,
      elements,
      shaftSlices: this.shaftSliceCount,
      shaftMotes: this.shaftMoteCount,
      parallax: [this.parallaxCount[0], this.parallaxCount[1], this.parallaxCount[2]],
      densityVariation: this.budget.densityVariation,
    };
  }

  dispose(): void {
    this.scene.remove(this.root);
    for (const mesh of this.meshes) {
      this.root.remove(mesh);
      mesh.dispose();
    }
    this.meshes.length = 0;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.quad.dispose();
    this.shaftSliceCount = 0;
    this.shaftMoteCount = 0;
    this.parallaxCount[0] = 0;
    this.parallaxCount[1] = 0;
    this.parallaxCount[2] = 0;
  }
}

/** Keeps a scroll accumulator inside one span so the shader's single wrap stays exact. */
function wrap(value: number, span: number): number {
  if (!(span > 0)) return 0;
  const v = value % span;
  return v < 0 ? v + span : v;
}

/* -------------------------------------------------------------------------- test seam */

export interface AtmosphereProbeInput {
  readonly universe: UniverseId;
  readonly budget: AtmosphereBudget;
  readonly volume: AtmosphereVolume;
  readonly seed: number;
  /** Fixed steps to run before measuring, so the tick path is exercised, not just the build. */
  readonly steps: number;
  readonly travelSpeed: number;
  /**
   * Draw one frame on a private renderer and report the draw calls it took. This is the
   * only thing that proves the TSL graphs COMPILE - a count taken off the scene graph would
   * pass just as happily with a shader the backend refuses.
   */
  readonly render: boolean;
}

export interface AtmosphereProbeResult extends AtmosphereReport {
  /**
   * Elements counted by walking the scene the way core/DebugBridge.ts walks it. Reported
   * separately from `elements` so the gate is checking the graph rather than a getter.
   */
  readonly sceneElements: number;
  /** Draw calls one rendered frame of this layer alone cost, or -1 when `render` was off. */
  readonly drawCalls: number;
  /** Scene elements remaining after dispose(). Anything but zero is a leak. */
  readonly afterDispose: number;
}

/**
 * Builds the REAL layer against its own scene and camera, ticks it, optionally draws it,
 * and reports what it produced.
 *
 * This exists because the gate cannot yet drive an Atmosphere through the Playfield. It is
 * the same class, the same budget row, the same tick and the same shaders - measured in
 * isolation, which is worth more here than measuring it inside a corridor whose own cost
 * would have to be subtracted back out again.
 */
export async function probeAtmosphere(input: AtmosphereProbeInput): Promise<AtmosphereProbeResult> {
  const scene = new Scene();
  const camera = new PerspectiveCamera(68, 16 / 9, 0.08, input.volume.depth + 12);
  const layer = new Atmosphere({
    scene,
    camera,
    theme: getTheme(input.universe),
    budget: input.budget,
    volume: input.volume,
    seed: asSeed(input.seed),
  });

  layer.setTravelSpeed(input.travelSpeed);
  for (let i = 0; i < input.steps; i++) layer.fixedUpdate(1000 / 60);

  const report = layer.report();
  const sceneElements = countElements(scene);
  const drawCalls = input.render ? await drawOnce(scene, camera) : -1;
  layer.dispose();

  return { ...report, sceneElements, drawCalls, afterDispose: countElements(scene) };
}

/**
 * A private renderer, torn down immediately. Deliberately NOT the game's: borrowing that one
 * would mean this probe could only ever run inside a booted game, and its draw-call counter
 * would already be carrying the corridor.
 */
async function drawOnce(scene: Scene, camera: PerspectiveCamera): Promise<number> {
  // No canvas is passed, so three allocates its own detached one - this file never reaches
  // for `document`, which main.ts is the only module allowed to do.
  const renderer = new WebGPURenderer({
    antialias: false,
    alpha: false,
    depth: true,
    stencil: false,
    // The software host renders WebGL reliably and WebGPU under load does not; the gate is
    // after shader validity and a draw count, both of which are exact on either backend.
    forceWebGL: true,
  });
  try {
    await renderer.init();
    // Small on purpose: this measures draw CALLS, and fill rate on a CPU rasteriser is the
    // one thing that would make the measurement slow without making it any more true.
    renderer.setSize(256, 144, false);
    camera.aspect = 256 / 144;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return renderer.info.render.drawCalls;
  } finally {
    renderer.dispose();
  }
}

/** The same walk core/DebugBridge.ts does, so the two numbers are comparable by construction. */
function countElements(scene: Scene): number {
  let elements = 0;
  scene.traverse((object) => {
    const node = object as { isInstancedMesh?: boolean; isMesh?: boolean; count?: number };
    if (node.isInstancedMesh === true) elements += node.count ?? 0;
    else if (node.isMesh === true) elements += 1;
  });
  return elements;
}
