/**
 * Browser-compatibility shims applied before the renderer is constructed.
 *
 * These exist because a pinned three.js and a moving browser target disagree, not because
 * of anything this project does. Each one is narrow, feature-detected, idempotent, and
 * removes itself from the hot path when the browser does not need it. If a shim here ever
 * stops being necessary, delete it - do not leave it running "just in case", because a
 * silent prototype patch is the worst kind of thing to inherit.
 *
 * WebGPU types are declared structurally, for the same reason as in Caps.ts: `@webgpu/types`
 * is not installed and tsconfig pins `types` to vite/client, so lib.dom has no `navigator.gpu`.
 */

/** The feature that makes `GPUTextureViewDescriptor.swizzle` legal to send at all. */
const SWIZZLE_FEATURE = 'texture-component-swizzle';

interface GpuFeatureSet {
  has(name: string): boolean;
}

interface GpuAdapterLike {
  readonly features: GpuFeatureSet;
}

interface GpuLike {
  requestAdapter(): Promise<GpuAdapterLike | null>;
}

/** Only the shape the shim rewrites; every other descriptor field passes through untouched. */
type TextureViewDescriptor = Record<string, unknown>;

interface TexturePrototypeLike {
  createView(descriptor?: TextureViewDescriptor): unknown;
}

export interface CompatReport {
  /** True when the running browser advertises `texture-component-swizzle`. */
  readonly swizzleSupported: boolean;
  /** True when we actually patched `createView`. */
  readonly swizzlePatched: boolean;
  readonly notes: readonly string[];
}

const PATCH_FLAG = '__spSwizzleStripped';

function texturePrototype(): TexturePrototypeLike | null {
  const ctor = (globalThis as { GPUTexture?: { prototype?: unknown } }).GPUTexture;
  const proto = ctor?.prototype;
  if (proto === undefined || proto === null) return null;
  if (typeof (proto as TexturePrototypeLike).createView !== 'function') return null;
  return proto as TexturePrototypeLike;
}

/**
 * three r185 sets `swizzle = 'rgba'` on every texture-view descriptor and forwards it to
 * `createView()` unconditionally. Its own docs say the field is "ignored otherwise", but a
 * browser that implements the newer spec validates it as a `GPUTextureComponentSwizzle`
 * DICTIONARY and throws on the string - which loses the device on the very first frame, with
 * an error message that names neither three nor the texture.
 *
 * The strip is deliberately NOT gated on feature detection. `swizzle` is specced as a
 * `GPUTextureComponentSwizzle` DICTIONARY, so the string three sends is invalid whether or
 * not the browser advertises the feature - and Chromium advertises it while still rejecting
 * the string, which is exactly the case a support check gets wrong. Only the string form is
 * removed, so a future three that sends the spec shape passes straight through untouched.
 */
export function installTextureSwizzleWorkaround(): boolean {
  const proto = texturePrototype();
  if (proto === null) return false;

  const flagged = proto as unknown as Record<string, unknown>;
  if (flagged[PATCH_FLAG] === true) return true;

  const original = proto.createView;
  proto.createView = function patchedCreateView(
    this: TexturePrototypeLike,
    descriptor?: TextureViewDescriptor,
  ): unknown {
    // Only a string is the broken case. A browser-legal dictionary is passed straight
    // through, so this stays correct if three starts sending the spec shape.
    if (descriptor !== undefined && typeof descriptor['swizzle'] === 'string') {
      const rest: TextureViewDescriptor = { ...descriptor };
      delete rest['swizzle'];
      return original.call(this, rest);
    }
    return original.call(this, descriptor);
  };
  flagged[PATCH_FLAG] = true;
  return true;
}

/**
 * Probes the adapter and applies every shim the browser needs. Call once, before the
 * renderer is constructed - patching after three has already built views is too late.
 *
 * Never throws: a browser with no WebGPU at all simply needs no shims, and the caller is
 * already handling that case by falling back to the WebGL backend.
 */
export async function installWebGPUCompat(): Promise<CompatReport> {
  const notes: string[] = [];
  const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;

  if (gpu === undefined) {
    return { swizzleSupported: false, swizzlePatched: false, notes: ['no navigator.gpu'] };
  }

  let swizzleSupported = false;
  try {
    const adapter = await gpu.requestAdapter();
    swizzleSupported = adapter?.features.has(SWIZZLE_FEATURE) ?? false;
  } catch {
    // An adapter request that throws is a no-WebGPU signal, not a shim decision.
    notes.push('adapter probe failed; assuming no swizzle feature');
  }

  const swizzlePatched = installTextureSwizzleWorkaround();
  notes.push(
    swizzlePatched
      ? `patched createView: stripping invalid string swizzle (${SWIZZLE_FEATURE} advertised=${String(swizzleSupported)})`
      : 'GPUTexture unavailable; no patch installed',
  );

  return { swizzleSupported, swizzlePatched, notes };
}
