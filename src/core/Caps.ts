/**
 * DEVICE FACTS.
 *
 * Everything this module reports is something the machine is, never something the game
 * wants. That split is deliberate: `core/Quality.ts` turns facts into budgets through
 * `detectTier`, and it can only stay pure and testable if the messy, browser-specific,
 * partly-lying detection lives somewhere else. This is that somewhere else.
 *
 * Detection happens in two passes, because the honest answer changes when the renderer
 * actually boots:
 *
 *   1. `probeCaps()` before the renderer exists - asks navigator.gpu for an adapter and
 *      reads its limits. Cheap, and its answer decides the tier we build the renderer for.
 *   2. `refineCaps()` after `renderer.init()` - replaces the guesses with what the created
 *      device really gave us. `getFallback` can quietly hand back a WebGL backend when the
 *      WebGPU device request fails after a perfectly healthy adapter probe, and a game that
 *      believes the probe would then enable compute paths that cannot run.
 *
 * WebGPU types are declared structurally here. `@webgpu/types` is not installed and this
 * project's tsconfig pins `types` to vite/client, so lib.dom has no `navigator.gpu`. These
 * interfaces cover only the members actually read, which keeps them honest - if a field is
 * declared below, something in this file uses it.
 */

import type { Renderer } from 'three/webgpu';
import { WebGPUBackend } from 'three/webgpu';

import type { Unsubscribe } from './Events';
import type { DeviceCaps } from './Quality';
import { readReducedMotionPreference } from './Quality';

interface GpuSupportedFeatures {
  has(name: string): boolean;
}

/**
 * `GPUSupportedLimits` is a platform object, not a dictionary: property access works but
 * enumeration does not, which is why every read below is by name.
 */
interface GpuSupportedLimits {
  readonly maxTextureDimension2D?: number;
  readonly maxComputeInvocationsPerWorkgroup?: number;
  readonly maxComputeWorkgroupStorageSize?: number;
  readonly maxStorageBufferBindingSize?: number;
  readonly maxBufferSize?: number;
}

interface GpuAdapterInfo {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly description?: string;
  readonly isFallbackAdapter?: boolean;
}

interface GpuAdapter {
  readonly features: GpuSupportedFeatures;
  readonly limits: GpuSupportedLimits;
  readonly info?: GpuAdapterInfo;
  /** Superseded by `info.isFallbackAdapter`; still the only spelling in older Chromium. */
  readonly isFallbackAdapter?: boolean;
}

interface Gpu {
  requestAdapter(options?: {
    powerPreference?: 'low-power' | 'high-performance';
  }): Promise<GpuAdapter | null>;
}

interface UserAgentDataLike {
  readonly mobile?: boolean;
}

interface NavigatorExtras {
  readonly gpu?: Gpu;
  /** Chromium-only, quantised to 0.25/0.5/1/2/4/8. Absent everywhere else. */
  readonly deviceMemory?: number;
  readonly userAgentData?: UserAgentDataLike;
}

/**
 * The WebGPU specification's guaranteed minimum limits, quoted verbatim. These are facts
 * about the platform floor rather than tunables, which is why they are here and not in
 * Quality.ts - no tier may raise or lower what the standard promises.
 */
const WEBGPU_SPEC_MINIMUMS = Object.freeze({
  maxTextureDimension2D: 8192,
  maxComputeInvocationsPerWorkgroup: 256,
  maxStorageBufferBindingSize: 134217728,
  maxBufferSize: 268435456,
  /** WGSL clamps sampler anisotropy at this value regardless of adapter. */
  maxSamplerAnisotropy: 16,
});

/** What a WebGL2 context can promise before its extensions are queried. */
const WEBGL2_SPEC_MINIMUMS = Object.freeze({
  maxTextureSize: 2048,
  maxAnisotropy: 1,
});

const MOBILE_UA = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile Safari|Silk|Kindle/i;

/**
 * The device facts SHATTERPOINT reads. Extends the pure `DeviceCaps` the tier detector
 * consumes with the input and adapter details that only the engine and the input layer
 * care about - the detector must not see them, or tier selection stops being reproducible
 * from the small set of fields it declares.
 */
export interface EngineCaps extends DeviceCaps {
  /** True when a WebGL2 fallback backend is even possible. If both are false, nothing runs. */
  readonly hasWebGL2: boolean;
  /** A software adapter. Reports large limits and cannot hold 60 fps at any tier. */
  readonly isFallbackAdapter: boolean;
  readonly adapterVendor: string;
  readonly adapterArchitecture: string;
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
  readonly maxTouchPoints: number;
  readonly hasTouch: boolean;
  readonly hasCoarsePointer: boolean;
  readonly hasHover: boolean;
  readonly hasPointerLock: boolean;
  /** The Gamepad API exists. Says nothing about a pad being plugged in - see `gamepadConnected`. */
  readonly hasGamepadApi: boolean;
  /**
   * A pad was connected at probe time. Browsers hide pads until the first button press, so
   * a false here is not a promise: the input layer must also listen for `gamepadconnected`.
   */
  readonly gamepadConnected: boolean;
}

/**
 * UNMASKED_RENDERER_WEBGL from a throwaway context.
 *
 * The debug extension is withheld by some browsers for fingerprinting reasons, so an empty
 * answer means "not told" and never "no GPU" - callers must treat null as unknown rather
 * than as low-end, or a privacy-hardened browser gets punished with MOBILE_LOW.
 */
function probeGlRenderer(): string | null {
  try {
    const canvas = globalThis.document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (gl === null) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const value =
      dbg === null
        ? gl.getParameter(gl.RENDERER)
        : gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function navigatorExtras(): Navigator & NavigatorExtras {
  return globalThis.navigator as Navigator & NavigatorExtras;
}

function mediaMatches(query: string): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia(query).matches;
}

function detectMobile(nav: Navigator & NavigatorExtras): boolean {
  const hint = nav.userAgentData?.mobile;
  if (typeof hint === 'boolean') return hint;

  // iPadOS 13+ ships a desktop user-agent string and is only distinguishable by the
  // combination of a Mac platform with a touchscreen, which no real Mac has.
  const touchPoints = nav.maxTouchPoints;
  if (touchPoints > 1 && /Mac/i.test(nav.platform)) return true;

  if (MOBILE_UA.test(nav.userAgent)) return true;
  return touchPoints > 0 && mediaMatches('(pointer: coarse)') && !mediaMatches('(hover: hover)');
}

/** True while any pad is live. Cheap enough to poll from the input layer's own tick. */
export function anyGamepadConnected(): boolean {
  const nav = globalThis.navigator;
  if (typeof nav?.getGamepads !== 'function') return false;
  try {
    for (const pad of nav.getGamepads()) {
      if (pad !== null && pad.connected) return true;
    }
  } catch {
    // Firefox throws here in an insecure context rather than returning an empty list.
    return false;
  }
  return false;
}

function surfacePixelsOf(surface?: HTMLCanvasElement): number {
  if (surface !== undefined) {
    const rect = surface.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect.width * rect.height;
  }
  return globalThis.innerWidth * globalThis.innerHeight;
}

/**
 * Pass 1. Safe to call before anything WebGPU exists; never throws, because a device that
 * cannot answer a question still has to be given a tier.
 */
export async function probeCaps(surface?: HTMLCanvasElement): Promise<EngineCaps> {
  const nav = navigatorExtras();
  const gpu = nav.gpu;

  let adapter: GpuAdapter | null = null;
  if (gpu !== undefined) {
    try {
      adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    } catch {
      // A blocked or crashed GPU process rejects here. Treated exactly like no WebGPU.
      adapter = null;
    }
  }

  const hasWebGPU = adapter !== null;
  const limits = adapter?.limits;
  const info = adapter?.info;

  return {
    hasWebGPU,
    // Every WebGPU adapter can run compute; the flag exists to be falsified in pass 2 when
    // the renderer turns out to have fallen back to WebGL, which cannot.
    hasCompute: hasWebGPU,
    hasTimestampQuery: adapter?.features.has('timestamp-query') ?? false,
    hasFloat32Filterable: adapter?.features.has('float32-filterable') ?? false,
    maxTextureSize: hasWebGPU
      ? (limits?.maxTextureDimension2D ?? WEBGPU_SPEC_MINIMUMS.maxTextureDimension2D)
      : WEBGL2_SPEC_MINIMUMS.maxTextureSize,
    maxAnisotropy: hasWebGPU
      ? WEBGPU_SPEC_MINIMUMS.maxSamplerAnisotropy
      : WEBGL2_SPEC_MINIMUMS.maxAnisotropy,
    // Probed even when WebGPU exists: on Android it is the only way to tell a flagship
    // GPU from a budget one, and detectTier reads it on every platform for consistency.
    glRenderer: probeGlRenderer(),
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    devicePixelRatio: globalThis.devicePixelRatio,
    surfacePixels: surfacePixelsOf(surface),
    isMobile: detectMobile(nav),
    prefersReducedMotion: readReducedMotionPreference(),

    hasWebGL2: typeof globalThis.WebGL2RenderingContext === 'function',
    isFallbackAdapter: info?.isFallbackAdapter ?? adapter?.isFallbackAdapter ?? false,
    adapterVendor: info?.vendor ?? '',
    adapterArchitecture: info?.architecture ?? '',
    maxComputeInvocationsPerWorkgroup:
      limits?.maxComputeInvocationsPerWorkgroup ??
      WEBGPU_SPEC_MINIMUMS.maxComputeInvocationsPerWorkgroup,
    maxStorageBufferBindingSize:
      limits?.maxStorageBufferBindingSize ?? WEBGPU_SPEC_MINIMUMS.maxStorageBufferBindingSize,
    maxBufferSize: limits?.maxBufferSize ?? WEBGPU_SPEC_MINIMUMS.maxBufferSize,

    maxTouchPoints: nav.maxTouchPoints,
    hasTouch: nav.maxTouchPoints > 0 || 'ontouchstart' in globalThis,
    hasCoarsePointer: mediaMatches('(pointer: coarse)'),
    hasHover: mediaMatches('(hover: hover)'),
    hasPointerLock: typeof globalThis.document !== 'undefined' && 'exitPointerLock' in document,
    hasGamepadApi: typeof globalThis.navigator?.getGamepads === 'function',
    gamepadConnected: anyGamepadConnected(),
  };
}

/**
 * Pass 2. Corrects the probe against the renderer that actually booted. Everything a live
 * device knows better than an adapter probe is replaced here; everything else is carried
 * through untouched.
 */
export function refineCaps(probed: EngineCaps, renderer: Renderer): EngineCaps {
  const onWebGPU = renderer.backend instanceof WebGPUBackend;

  const feature = (name: string): boolean => {
    try {
      return renderer.hasFeature(name);
    } catch {
      // hasFeature is backend-specific and throws on backends that never heard of the name.
      return false;
    }
  };

  return {
    ...probed,
    hasWebGPU: onWebGPU,
    // three's WebGL fallback backend has no compute pipelines at all, so a fallback must
    // switch off every compute-gated path even though the adapter probe said yes.
    hasCompute: onWebGPU,
    hasTimestampQuery: onWebGPU ? feature('timestamp-query') : false,
    hasFloat32Filterable: onWebGPU ? feature('float32-filterable') : probed.hasFloat32Filterable,
    maxAnisotropy: renderer.getMaxAnisotropy(),
    glRenderer: probed.glRenderer,
    /**
     * The probe leaves this at the WebGL2 SPEC MINIMUM of 2048 on the non-WebGPU path,
     * because the probe runs before a renderer exists and has nothing better to ask. Left
     * unrefined it silently capped supersampling: Engine derives its hardware ceiling from
     * maxTextureSize / css size, and 2048/1920 = 1.067, so every rung above that was thrown
     * away without a word. Real WebGL2 hardware reports 8192-16384.
     */
    maxTextureSize: realMaxTextureSize(renderer, probed.maxTextureSize),
  };
}

/** Asks the live backend rather than trusting a spec floor. Falls back to the probe. */
function realMaxTextureSize(renderer: Renderer, fallback: number): number {
  const backend = renderer.backend as {
    gl?: { getParameter(p: number): unknown; MAX_TEXTURE_SIZE?: number };
    device?: { limits?: { maxTextureDimension2D?: number } };
  };
  const gpuLimit = backend.device?.limits?.maxTextureDimension2D;
  if (typeof gpuLimit === 'number' && gpuLimit > 0) return gpuLimit;

  const gl = backend.gl;
  if (gl !== undefined && typeof gl.MAX_TEXTURE_SIZE === 'number') {
    const v = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (typeof v === 'number' && v > 0) return v;
  }
  return fallback;
}

/** Re-reads only the fields that can change while the tab is open. */
export function refreshVolatileCaps(caps: EngineCaps, surface?: HTMLCanvasElement): EngineCaps {
  return {
    ...caps,
    devicePixelRatio: globalThis.devicePixelRatio,
    surfacePixels: surfacePixelsOf(surface),
    prefersReducedMotion: readReducedMotionPreference(),
    gamepadConnected: anyGamepadConnected(),
  };
}

const NOOP_UNSUBSCRIBE: Unsubscribe = () => {
  // No media-query support means nothing to unsubscribe from.
};

/**
 * The accessibility preference is the one setting a player may change mid-run, and it must
 * take effect without a reload - the whole motion axis hangs off it.
 */
export function observeReducedMotion(listener: (reduced: boolean) => void): Unsubscribe {
  if (typeof globalThis.matchMedia !== 'function') return NOOP_UNSUBSCRIBE;
  const query = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
  const onChange = (event: MediaQueryListEvent): void => {
    listener(event.matches);
  };
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/**
 * Device pixel ratio changes when a window is dragged between monitors or the page is
 * zoomed, and it fires no resize event of its own. The trick is a media query pinned to
 * the *current* ratio: it stops matching the instant the ratio moves, and is then re-armed
 * against the new one.
 */
export function observeDevicePixelRatio(listener: (dpr: number) => void): Unsubscribe {
  if (typeof globalThis.matchMedia !== 'function') return NOOP_UNSUBSCRIBE;

  let query: MediaQueryList | null = null;
  let disposed = false;

  const onChange = (): void => {
    if (disposed) return;
    arm();
    listener(globalThis.devicePixelRatio);
  };

  function arm(): void {
    if (disposed) return;
    query = globalThis.matchMedia(`(resolution: ${String(globalThis.devicePixelRatio)}dppx)`);
    query.addEventListener('change', onChange, { once: true });
  }

  arm();

  return () => {
    disposed = true;
    query?.removeEventListener('change', onChange);
    query = null;
  };
}
