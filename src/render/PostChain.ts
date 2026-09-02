/**
 * The whole post stack, assembled once, in render order, onto a single RenderPipeline.
 *
 * The ordering is not taste. Each stage below is placed where it is because of what the
 * stage before it did to the buffer:
 *
 *   scene pass -> AO -> SSR -> godrays        occlusion and light transport, on linear HDR
 *   -> bloom -> DoF -> motion blur            lens and sensor artefacts, still linear HDR
 *   -> TRAA | TAAU/FSR1 -> SMAA/FXAA          resolve and reconstruct: the buffer changes size here
 *   -> sharpen -> chromatic aberration        post-reconstruction detail and lens fringing
 *   -> vignette -> film grain                 framing and texture, still scene-referred
 *   -> split tone -> tone map -> LUT          the grade, straddling the tone map on purpose
 *
 * Bloom is the one stage that does not read the stage before it. It reads the scene pass's
 * `emissive` MRT attachment, because glow belongs to things that EMIT and not to things
 * that happen to be bright. See the bloom stage for what a threshold over the beauty costs.
 *
 * Every stage is gated by Quality.ts. Nothing here invents a number: `budget.postIntensity`
 * is the only source of magnitudes, and `resolvePostChain` is the only source of on/off.
 *
 * The compute gate is run HERE rather than trusted from the caller. `QualityResolution.post`
 * has already been through it, but re-running the pure function against the real device caps
 * costs nothing and means a hand-built QualityResolution (debug menu, test) cannot smuggle a
 * compute-only effect onto a device that has no compute queue.
 */

import type {
  DirectionalLight,
  Node,
  PassNode,
  PerspectiveCamera,
  PointLight,
  Renderer,
  Scene,
  UniformNode,
} from 'three/webgpu';
import { AdditiveBlending, BlendMode, Color, RenderPipeline } from 'three/webgpu';
import {
  convertToTexture,
  emissive,
  float,
  int,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  uniform,
  vec2,
  vec4,
  velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { depthAwareBlend } from 'three/addons/tsl/display/depthAwareBlend.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { taau } from 'three/addons/tsl/display/TAAUNode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { sharpen } from 'three/addons/tsl/display/SharpenNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';

import type { DeviceCaps, PostEffect, PostToggles, QualityResolution } from '../core/Quality';
import { resolvePostChain } from '../core/Quality';
import type { UniverseTheme } from '../universe/UniverseTheme';
import { Grade } from './Grade';
import type { VignetteUniforms } from './VignetteNode';
import { vignette } from './VignetteNode';

/**
 * Narrows a display node back to vec4.
 *
 * DepthOfFieldNode, SMAANode, FXAANode, ChromaticAberrationNode and FilmNode all call
 * `super( 'vec4' )` in their r185 constructors, but @types/three declares them as a bare
 * `TempNode`, which erases the node type. This is a typings correction with the JS
 * constructors as its proof, not a claim about runtime behaviour - and keeping it in one
 * function means the day upstream adds the generics, one line moves.
 */
function asVec4(node: Node): Node<'vec4'> {
  return node as Node<'vec4'>;
}

export interface PostChainOptions {
  readonly renderer: Renderer;
  readonly scene: Scene;
  /** Perspective specifically: SSR infers frustum maths from it and DoF works in view Z. */
  readonly camera: PerspectiveCamera;
  readonly quality: QualityResolution;
  readonly caps: Pick<DeviceCaps, 'hasCompute'>;
  readonly theme: UniverseTheme;
  /**
   * The one shadow-casting key light godrays marches through. Null disables the stage on
   * every tier: GodraysNode needs a real shadow map, and a corridor lit only by emissives
   * legitimately has no key light to march.
   */
  readonly keyLight: DirectionalLight | PointLight | null;
}

/** What the chain actually built, for the debug overlay and for tests to assert against. */
export interface PostStageReport {
  readonly effect: PostEffect;
  readonly built: boolean;
  readonly reason: string;
}

/**
 * Stand-in surface response for SSR. Real values would come from a metalness/roughness
 * G-buffer; until the MRT carries one, the corridor is described honestly as a dielectric
 * at moderate roughness rather than left null.
 */
const SSR_SURFACE = Object.freeze({ metalness: 0.0, roughness: 0.35 });

export class PostChain {
  readonly pipeline: RenderPipeline;
  readonly grade: Grade;
  readonly vignette: VignetteUniforms;
  /** Live gated toggles. Differs from `quality.post` if the caps gate bit here. */
  readonly toggles: PostToggles;

  private readonly scenePass: PassNode;
  private readonly reports: PostStageReport[] = [];
  private readonly focusDistance: UniformNode<'float', number>;
  /** Non-null only when an upscaler is in the chain; it is what holds the low-res image. */
  private upscaleSource: ReturnType<typeof convertToTexture> | null = null;
  private readonly godraysTint: Color | null;
  private renderScale: number;

  constructor(options: PostChainOptions) {
    const { renderer, scene, camera, quality, caps, theme, keyLight } = options;
    const budget = quality.budget;
    const intensity = budget.postIntensity;

    this.renderScale = budget.renderScale;
    this.toggles = resolvePostChain(budget, quality.reducedMotion, caps);
    // TEMP-BISECT
    {
      const q = new URLSearchParams(globalThis.location.search).get('only');
      if (q !== null) {
        const want = new Set(q.split(',').filter((x) => x.length > 0));
        const t: Record<string, boolean> = {};
        for (const k of Object.keys(this.toggles)) t[k] = want.has(k);
        (this as { toggles: PostToggles }).toggles = t as unknown as PostToggles;
      }
    }

    // SSR's GGX sampling loop does not compile on the WebGL backend - the fragment shader
    // fails VALIDATE_STATUS and the frame is lost. It is a WebGPU-era node, so on the
    // fallback backend it degrades off rather than taking the whole chain down with it.
    const onWebGL = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true;
    if (onWebGL && this.toggles.ssr) {
      (this as { toggles: PostToggles }).toggles = { ...this.toggles, ssr: false };
    }

    const post = this.toggles;
    const temporal = post.traa || post.taau;

    // MSAA is never enabled: TRAA and TAAU both forbid it, and on the tiers without them
    // SMAA/FXAA cost a fraction of what multisampling a 4x-overdrawn glass corridor does.
    this.scenePass = pass(scene, camera);
    this.scenePass.setResolutionScale(this.renderScale);

    // The MRT is bandwidth, so it is only widened for attachments something downstream will
    // actually read. MOBILE_LOW ends up with a plain colour target and no G-buffer at all.
    const wantsNormal = post.gtao || post.ssr;
    const wantsVelocity = temporal || post.motionBlur;
    // Bloom is EMISSIVE-ONLY, so the mask it reads is an attachment rather than a threshold
    // over the beauty. `emissive` is the lighting stack's EmissiveColor property, which
    // NodeMaterial assigns from each material's emissiveNode - so a surface glows in the
    // mask exactly when it emits, and a material that wants to be brighter in the mask than
    // it is in the frame overrides the attachment through its own `mrtNode`.
    const wantsEmissive = post.bloom;
    if (wantsNormal || wantsVelocity || wantsEmissive) {
      const attachments: Record<string, Node> = { output };
      if (wantsNormal) attachments['normal'] = normalView;
      if (wantsVelocity) attachments['velocity'] = velocity;
      if (wantsEmissive) attachments['emissive'] = emissive;
      const targets = mrt(attachments);
      if (wantsEmissive) {
        // Light ADDS. Under the default no-blend write, any surface drawn in front of an
        // emitter stamps its own zero into the mask and punches the glowing thing straight
        // out of it - a crystal's halo erasing the crystal, a pane erasing what is behind
        // it. (The WebGL fallback needs OES_draw_buffers_indexed for per-attachment blend
        // and warns once when it has to fall back to the material's own blending.)
        targets.setBlendMode('emissive', new BlendMode(AdditiveBlending));
      }
      this.scenePass.setMRT(targets);
    }

    const colorTexture = this.scenePass.getTextureNode('output');
    const depthTexture = this.scenePass.getTextureNode('depth');
    const viewZ = this.scenePass.getViewZNode();

    this.focusDistance = uniform(intensity.dofFocusRange).setName('dofFocusDistance');
    this.godraysTint = keyLight === null ? null : new Color();

    let node: Node<'vec4'> = colorTexture;

    // ---- Ambient occlusion -------------------------------------------------------------
    if (post.gtao) {
      const aoPass = ao(depthTexture, this.scenePass.getTextureNode('normal'), camera);
      aoPass.resolutionScale = intensity.gtaoScale;
      aoPass.radius.value = intensity.gtaoRadius;
      // `scale` is GTAONode's occlusion strength; `resolutionScale` above is the buffer size.
      aoPass.scale.value = intensity.gtaoIntensity;
      // GTAO writes occlusion to the RED CHANNEL ONLY - the other three are undefined, so
      // multiplying by the vec4 would tint and then destroy alpha.
      node = vec4(node.rgb.mul(aoPass.getTextureNode().r), node.a);
      this.note('gtao', true, 'AO from red channel, multiplied into radiance');
    } else {
      this.note('gtao', false, 'disabled by tier');
    }

    // SSGI is a toggle Quality carries but this chain does not yet honour.
    // TODO(step-2): wire SSGINode. It needs sliceCount/stepCount, which PostIntensity has no
    // fields for, and its giIntensity default is 10 - not the same scale as ssgiIntensity -
    // so mapping it now would silently mis-expose GI on ULTRA_4K rather than leave it off.
    this.note('ssgi', false, 'TODO(step-2): needs sliceCount/stepCount fields in Quality');

    // ---- Screen-space reflections ------------------------------------------------------
    if (post.ssr) {
      // Fed the RAW beauty, not the AO'd node: a reflection shows the lit surface, and the
      // AO term is a view-dependent approximation that has no business inside the mirror.
      // SSRNode's typings say Node<vec3>, but its implementation calls BOTH `.rgb` and
      // `.sample()` on this argument, so it has to be handed the MRT normal TEXTURE node.
      // Narrowing to the declared type is the honest description of what the node wants.
      const normalForSsr = this.scenePass.getTextureNode('normal') as unknown as Node<'vec3'>;
      // metalnessNode/roughnessNode are documented as optional, but SSRNode line ~907 calls
      // float() on them unconditionally, so a null there becomes a null node graph and the
      // whole chain fails to build. We have no metalness G-buffer, so supply constants: a
      // dielectric surface at moderate roughness, which is what this corridor mostly is.
      const ssrPass = ssr(colorTexture, depthTexture, normalForSsr, {
        camera,
        metalnessNode: float(SSR_SURFACE.metalness),
        roughnessNode: float(SSR_SURFACE.roughness),
      });
      ssrPass.resolutionScale = intensity.ssrScale;
      ssrPass.maxDistance.value = intensity.ssrMaxDistance;
      ssrPass.thickness.value = intensity.ssrThickness;
      // SSRNode BLENDS ADDITIVELY: its output is reflected radiance to be added, not a
      // replacement colour. Only rgb is summed - adding alpha would push the frame opaque
      // and break the premultiply that renderOutput does at the end.
      node = vec4(node.rgb.add(ssrPass.rgb), node.a);
      this.note('ssr', true, 'additive reflected radiance, rgb only');
    } else {
      this.note('ssr', false, 'disabled by tier');
    }

    // ---- Godrays -----------------------------------------------------------------------
    if (post.godrays && keyLight !== null && this.godraysTint !== null) {
      const godraysPass = godrays(depthTexture, camera, keyLight);
      godraysPass.raymarchSteps.value = intensity.godraysSamples;
      godraysPass.density.value = intensity.godraysDensity;
      // maxDensity is the ceiling on how far a pixel may travel toward the shaft colour,
      // which is exactly what "weight" means for this stage.
      godraysPass.maxDensity.value = intensity.godraysWeight;

      this.godraysTint.copy(keyLight.color).multiplyScalar(intensity.godraysExposure);
      // depthAwareBlend rather than a straight add: raymarched shafts alias hard against
      // depth discontinuities, and glass corridors are nothing but depth discontinuities.
      node = depthAwareBlend(convertToTexture(node), godraysPass.getTextureNode(), depthTexture, camera, {
        blendColor: uniform(this.godraysTint).setName('godraysTint'),
      });
      this.note('godrays', true, 'depth-aware blend toward the key light colour');
    } else {
      this.note('godrays', false, keyLight === null ? 'no key light' : 'disabled by tier');
    }

    // ---- Bloom -------------------------------------------------------------------------
    if (post.bloom) {
      // EMISSIVE-ONLY, from the MRT mask - not from a luminance threshold over the beauty.
      // Thresholding the finished frame blooms whatever happens to be bright: a lit floor
      // plate, fog at the vanishing point, a pane catching the key. That is how a crystal
      // ends up BRIGHT BUT NOT GLOWING - it never wins the threshold against the corridor
      // around it - and it is why the histogram went milky the first time. What emits,
      // blooms. What is merely lit, does not.
      //
      // Threshold is 0 rather than `intensity.bloomThreshold`: the mask IS the selection,
      // and asking a second luminance question of it only ever subtracts emitters, the
      // faintest first - which is the distant crystal, the one that most needs finding.
      // `bloomThreshold` is left in PostIntensity for a chain that reads the beauty.
      const bloomPass = bloom(
        this.scenePass.getTextureNode('emissive'),
        intensity.bloomStrength,
        intensity.bloomRadius,
        0,
      );
      node = vec4(node.rgb.add(bloomPass.rgb), node.a);
      this.note('bloom', true, 'emissive MRT mask, additive');
    } else {
      this.note('bloom', false, 'disabled by tier');
    }

    // ---- Depth of field ----------------------------------------------------------------
    if (post.dof) {
      // focalLength here is DepthOfFieldNode's "distance from the focal plane to fully out
      // of focus", not a lens millimetre value - dofFocusRange is precisely that quantity.
      node = asVec4(dof(node, viewZ, this.focusDistance, intensity.dofFocusRange, intensity.dofBokehScale));
      this.note('dof', true, 'focus distance is a live uniform, driven by gameplay');
    } else {
      this.note('dof', false, 'disabled by tier');
    }

    // ---- Motion blur -------------------------------------------------------------------
    if (post.motionBlur) {
      const source = convertToTexture(node);
      // Sample count is baked as a constant, not a uniform: it is the bound of the sampling
      // loop and a dynamic bound costs more than the samples it saves.
      const blurred = motionBlur(source, this.scenePass.getTextureNode('velocity').xy, int(intensity.motionBlurSamples));
      node = mix(source, blurred, intensity.motionBlurIntensity);
      this.note('motionBlur', true, 'mixed against the sharp frame by intensity');
    } else {
      this.note('motionBlur', false, quality.reducedMotion ? 'blocked by reduced motion' : 'disabled by tier');
    }

    // ---- Temporal resolve / spatial upscale --------------------------------------------
    if (post.traa) {
      const traaPass = traa(node, depthTexture, this.scenePass.getTextureNode('velocity'), camera);
      // temporalFeedback is "how much history to keep"; TRAANode has no direct dial, so the
      // history strength is left at the node's default and the field drives TAAU only.
      node = traaPass;
      this.note('traa', true, 'native-resolution temporal AA');
    } else {
      this.note('traa', false, 'disabled by tier');
    }

    if (post.taau) {
      // TAAU reconstructs an output-resolution frame from a LOWER-resolution input, so the
      // chain so far has to be pinned to the render scale or the upscale is a no-op that
      // still pays for the history buffer.
      const source = convertToTexture(node);
      source.setResolutionScale(this.renderScale);
      this.upscaleSource = source;
      const taauPass = taau(source, depthTexture, this.scenePass.getTextureNode('velocity'), camera);
      taauPass.currentFrameWeight = 1 - intensity.temporalFeedback;
      node = taauPass;
      this.note('taau', true, 'temporal upscale from the render scale');
    } else {
      this.note('taau', false, 'disabled by tier');
    }

    if (post.fsr1) {
      // The spatial stand-in for TAAU: no history buffer, so no ghosting on tumbling shards,
      // at the cost of reconstructing from one frame instead of eight.
      const source = convertToTexture(node);
      source.setResolutionScale(this.renderScale);
      this.upscaleSource = source;
      node = fsr1(source, intensity.fsr1Sharpness);
      this.note('fsr1', true, 'spatial upscale from the render scale');
    } else {
      this.note('fsr1', false, 'disabled by tier');
    }

    // Spatial AA sits after the upscale, not before it: antialiasing a buffer that is about
    // to be resampled throws the work away. resolvePostChain guarantees at least one of the
    // four AA paths is live, so glass edges are never shipped raw.
    if (post.smaa) {
      node = asVec4(smaa(node));
      this.note('smaa', true, 'post-upscale spatial AA');
    } else {
      this.note('smaa', false, 'disabled by tier');
    }

    if (post.fxaa) {
      node = asVec4(fxaa(node));
      this.note('fxaa', true, 'post-upscale spatial AA');
    } else {
      this.note('fxaa', false, 'disabled by tier');
    }

    // ---- Sharpen -----------------------------------------------------------------------
    if (post.sharpen) {
      node = sharpen(node, intensity.sharpenStrength);
      this.note('sharpen', true, 'recovers the edge the upscaler softened');
    } else {
      this.note('sharpen', false, 'disabled by tier');
    }

    // ---- Chromatic aberration ----------------------------------------------------------
    if (post.chromaticAberration) {
      // `center` defaults to null and ChromaticAberrationNode builds it unconditionally,
      // so it must be passed. Frame centre is the physically correct origin for lens fringing.
      node = asVec4(
        chromaticAberration(
          node,
          uniform(intensity.chromaticAberrationStrength).setName('caStrength'),
          vec2(0.5, 0.5),
        ),
      );
      this.note('chromaticAberration', true, 'lens fringing');
    } else {
      this.note(
        'chromaticAberration',
        false,
        quality.reducedMotion ? 'blocked by reduced motion' : 'disabled by tier',
      );
    }

    // ---- Vignette ----------------------------------------------------------------------
    // Ours, because r185 has none. Runs pre-tonemap so it multiplies radiance like a real
    // lens rather than painting a dark overlay onto display values.
    const vignetteStage = vignette(node, {
      strength: intensity.vignetteStrength,
      radius: intensity.vignetteRadius,
    });
    this.vignette = vignetteStage.uniforms;
    if (post.vignette) {
      node = vignetteStage.node;
      this.note('vignette', true, 'hand-rolled TSL, core biased above centre, corners capped');
    } else {
      this.note('vignette', false, 'disabled by tier');
    }

    // ---- Film grain --------------------------------------------------------------------
    if (post.film) {
      node = asVec4(film(node, uniform(intensity.filmIntensity).setName('filmIntensity')));
      this.note('film', true, 'sensor grain, applied to radiance');
    } else {
      this.note('film', false, 'disabled by tier');
    }

    // ---- Grade -------------------------------------------------------------------------
    this.grade = new Grade({ theme, lutIntensity: intensity.lutIntensity });

    // Split tone belongs to the scene: it says where the light came from. Tone map next,
    // then the LUT, which is a display transform and is meaningless on unbounded radiance.
    node = this.grade.applySplitTone(node);
    node = renderOutput(node);

    if (post.lut) {
      node = this.grade.applyLut(node);
      this.note('lut', true, 'display-referred, after tone mapping');
    } else {
      this.note('lut', false, 'disabled by tier');
    }

    this.pipeline = new RenderPipeline(renderer, node);
    // We ran renderOutput ourselves, in the middle of the grade. Letting the pipeline run it
    // again would tone-map the already-tone-mapped frame.
    this.pipeline.outputColorTransform = false;
  }

  get stages(): readonly PostStageReport[] {
    return this.reports;
  }

  /** Called by the Engine's single rAF. Synchronous in r185 - never renderAsync(). */
  render(): void {
    this.pipeline.render();
  }

  /**
   * Moves the whole chain onto a new rung of RENDER_SCALE_LADDER. The dynamic-resolution
   * controller owns which rung; this only applies it, to the scene pass and to the upscaler's
   * input in the same call so the two can never disagree about the buffer size.
   */
  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.scenePass.setResolutionScale(scale);
    if (this.upscaleSource !== null) this.upscaleSource.setResolutionScale(scale);
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  /** World-unit distance the DoF focal plane sits at. Gameplay drives this down the corridor. */
  setFocusDistance(worldUnits: number): void {
    this.focusDistance.value = worldUnits;
  }

  /** Universe swap. No graph rebuild: everything the theme touches is a live uniform. */
  setTheme(theme: UniverseTheme): void {
    this.grade.setTheme(theme);
  }

  /**
   * Re-reads the key light's colour into the godrays tint. Call after a light change; the
   * tint is a uniform holding this Color instance, so mutating it in place is enough.
   */
  syncKeyLight(light: DirectionalLight | PointLight, exposure: number): void {
    if (this.godraysTint === null) return;
    this.godraysTint.copy(light.color).multiplyScalar(exposure);
  }

  dispose(): void {
    this.pipeline.dispose();
    this.scenePass.dispose();
    this.grade.dispose();
  }

  private note(effect: PostEffect, built: boolean, reason: string): void {
    this.reports.push({ effect, built, reason });
  }
}
