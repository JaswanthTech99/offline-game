/**
 * The colour grade: the last thing that happens to a frame and most of what makes one
 * universe feel like a different place from another while running identical geometry.
 *
 * Two stages, deliberately separated because they belong on opposite sides of the tone map:
 *
 *   applySplitTone() - SCENE-REFERRED. Runs on linear HDR radiance, before tone mapping.
 *                      A split tone is a statement about where light comes from (cold sky,
 *                      warm bounce, or the reverse), and that is a property of the scene,
 *                      not of the display.
 *   applyLut()       - DISPLAY-REFERRED. Runs after tone mapping and the working-to-output
 *                      colour space conversion. A 3D LUT is a cube indexed by [0,1]; feeding
 *                      it linear HDR crushes every value above 1.0 into the top cell and the
 *                      highlights come back flat and wrong.
 *
 * PostChain owns the ordering; this module owns the maths and refuses to pretend one call
 * can do both jobs.
 */

import type { Node, UniformNode } from 'three/webgpu';
import {
  ClampToEdgeWrapping,
  Data3DTexture,
  LinearFilter,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from 'three/webgpu';
import { luminance, max, smoothstep, texture3D, uniform, vec3, vec4 } from 'three/tsl';
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js';
import type Lut3DNode from 'three/addons/tsl/display/Lut3DNode.js';
import type { UniverseTheme } from '../universe/UniverseTheme';

/**
 * Rec.709 relative luminance weights. Passed explicitly to TSL's `luminance()` rather than
 * relying on its default, so the split-tone pivot and the axis below are provably derived
 * from the SAME primaries - a mismatch there tilts the neutral axis and every grade in the
 * game picks up a colour cast nobody can find.
 */
const REC709 = Object.freeze({ r: 0.2126, g: 0.7152, b: 0.0722 });

/**
 * Photographic mid grey in linear light. The pivot the split tone rotates around: below it
 * the shadow warmth applies, above it the highlight warmth. Not a tunable - moving it turns
 * a split tone into an exposure change.
 */
const MID_GREY_LINEAR = 0.18;

/**
 * How far a full-strength warmth is allowed to push a mid-grey pixel along the warm axis.
 * A split tone is a lean, not a colour wash: past about a third the image stops reading as
 * lit and starts reading as tinted.
 */
const SPLIT_TONE_STRENGTH = 0.35;

/**
 * A chroma axis with ZERO Rec.709 luminance: warming the shadows with it changes their hue
 * and nothing else. Solved rather than typed in, so it cannot drift from REC709 above.
 * Positive warmth pushes red up and blue down (amber); negative pushes the other way (teal).
 * Because UniverseTheme law 2 forces shadowWarmth and highlightWarmth to opposite signs, one
 * scalar axis is all a split tone needs.
 */
const WARM_AXIS = new Vector3(1, -(REC709.r - REC709.b) / REC709.g, -1);

/**
 * A 2x2x2 identity LUT is EXACTLY identity under trilinear interpolation - the eight texels
 * are the eight RGB cube corners and Lut3DNode's half-texel inset lands the sample on them.
 * So the LUT stage is in the graph and neutral from frame one, and loading a real LUT is a
 * texture swap plus a size uniform rather than a shader recompile.
 */
const IDENTITY_LUT_SIZE = 2;

const RGBA_CHANNELS = 4;
const BYTE_MAX = 255;

function createIdentityLut(size: number): Data3DTexture {
  const data = new Uint8Array(size * size * size * RGBA_CHANNELS);
  const last = size - 1;
  let i = 0;

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        data[i++] = Math.round((r / last) * BYTE_MAX);
        data[i++] = Math.round((g / last) * BYTE_MAX);
        data[i++] = Math.round((b / last) * BYTE_MAX);
        data[i++] = BYTE_MAX;
      }
    }
  }

  const texture = new Data3DTexture(data, size, size, size);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export interface GradeConfig {
  readonly theme: UniverseTheme;
  /** Quality: postIntensity.lutIntensity. How far to travel toward the LUT's answer. */
  readonly lutIntensity: number;
}

export interface GradeUniforms {
  readonly shadowWarmth: UniformNode<'float', number>;
  readonly highlightWarmth: UniformNode<'float', number>;
  readonly lutIntensity: UniformNode<'float', number>;
}

export class Grade {
  readonly uniforms: GradeUniforms;

  private readonly identityLut: Data3DTexture;
  private readonly lutTexture: ReturnType<typeof texture3D>;
  private lutStage: Lut3DNode | null = null;
  private lutSize: number = IDENTITY_LUT_SIZE;
  private themeRef: UniverseTheme;

  constructor(config: GradeConfig) {
    this.themeRef = config.theme;
    this.identityLut = createIdentityLut(IDENTITY_LUT_SIZE);
    this.lutTexture = texture3D(this.identityLut);

    this.uniforms = {
      shadowWarmth: uniform(config.theme.grade.shadowWarmth).setName('gradeShadowWarmth'),
      highlightWarmth: uniform(config.theme.grade.highlightWarmth).setName('gradeHighlightWarmth'),
      lutIntensity: uniform(config.lutIntensity).setName('gradeLutIntensity'),
    };
  }

  /** The LUT this grade wants; the loader fetches it and hands the texture back to setLut(). */
  get lutUrl(): string {
    return this.themeRef.grade.lutUrl;
  }

  get theme(): UniverseTheme {
    return this.themeRef;
  }

  /**
   * Scene-referred split tone. Both masks are one-sided ramps away from mid grey rather than
   * a single reversed smoothstep, because smoothstep with edge0 > edge1 is undefined in GLSL
   * and merely happens to work in WGSL today.
   */
  applySplitTone(input: Node<'vec4'>): Node<'vec4'> {
    const coefficients = vec3(REC709.r, REC709.g, REC709.b);
    const lum = luminance(input.rgb, coefficients);

    const shadowMask = smoothstep(0, MID_GREY_LINEAR, lum).oneMinus();
    const highlightMask = smoothstep(MID_GREY_LINEAR, 1, lum);

    const warmth = this.uniforms.shadowWarmth
      .mul(shadowMask)
      .add(this.uniforms.highlightWarmth.mul(highlightMask));

    // The tint is PROPORTIONAL to the pixel's own luminance, never an absolute offset.
    // Adding a constant to linear radiance lifts the black point: at shadowWarmth 0.18 a
    // near-black wall gains +0.18 red and the whole frame goes crimson, which is both the
    // ugliest possible failure and the one the exposure histogram exists to catch. Scaling
    // by `lum` means black stays black and only light that is actually there gets coloured.
    //
    // Clamped at zero because the axis is signed: a strong cool shadow tone can otherwise
    // drive red negative, and a negative radiance poisons every downstream blur's kernel.
    const tint = vec3(WARM_AXIS).mul(warmth).mul(lum).mul(SPLIT_TONE_STRENGTH);
    const graded = max(input.rgb.add(tint), vec3(0));

    return vec4(graded, input.a);
  }

  /** Display-referred LUT. `input` must already be tone-mapped and in the output colour space. */
  applyLut(input: Node<'vec4'>): Node<'vec4'> {
    const stage = lut3D(input, this.lutTexture, this.lutSize, this.uniforms.lutIntensity);
    this.lutStage = stage;
    // Lut3DNode calls `super( 'vec4' )` but is declared as a bare TempNode upstream, which
    // erases the node type. Narrowing it back, with the constructor as the proof.
    return stage as unknown as Node<'vec4'>;
  }

  /** Swaps the universe without rebuilding the graph - both warmths are live uniforms. */
  setTheme(theme: UniverseTheme): void {
    this.themeRef = theme;
    this.uniforms.shadowWarmth.value = theme.grade.shadowWarmth;
    this.uniforms.highlightWarmth.value = theme.grade.highlightWarmth;
  }

  /**
   * Installs a loaded LUT. Size is a shader uniform inside Lut3DNode, so a 33-cube can
   * replace the 2-cube identity mid-run with no recompile and no frame hitch.
   */
  setLut(texture: Data3DTexture, size: number): void {
    this.lutTexture.value = texture;
    this.lutSize = size;
    if (this.lutStage !== null) this.lutStage.size.value = size;
  }

  /** Falls back to the neutral cube, e.g. when a universe's LUT fails to load. */
  clearLut(): void {
    this.lutTexture.value = this.identityLut;
    this.lutSize = IDENTITY_LUT_SIZE;
    if (this.lutStage !== null) this.lutStage.size.value = IDENTITY_LUT_SIZE;
  }

  /** Only the identity cube is ours to free; loaded LUTs belong to the resource registry. */
  dispose(): void {
    this.identityLut.dispose();
  }
}
