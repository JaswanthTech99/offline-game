/**
 * Boot diagnostics. One line per fact, printed once, before anything can be blamed on
 * "the code" — most render-quality reports turn out to be a browser running a software
 * rasteriser, and that is invisible unless something says so out loud.
 */

import type { EngineCaps } from './Caps';
import type { QualityResolution, Tier } from './Quality';

export type TierSource = 'detected' | 'override';

export interface BootDiagnostics {
  readonly webgpuAvailable: boolean;
  readonly adapterVendor: string;
  readonly adapterArchitecture: string;
  readonly isFallbackAdapter: boolean;
  readonly glRenderer: string;
  readonly glVendor: string;
  /** True when the GL string names a known CPU rasteriser. No tier can be judged on one. */
  readonly isSoftwareRasteriser: boolean;
  readonly tier: Tier;
  readonly tierSource: TierSource;
  readonly renderScale: number;
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Internal pixels per display pixel, per axis. Below 1.0 is upscaling. */
  readonly pixelRatio: number;
  readonly aaNodes: readonly string[];
}

const SOFTWARE_RASTERISERS = ['swiftshader', 'llvmpipe', 'softpipe', 'lavapipe', 'microsoft basic'];

/**
 * `UNMASKED_RENDERER_WEBGL` is behind a debug extension that some browsers withhold for
 * fingerprinting reasons, so an empty answer means "not told", never "no GPU".
 */
function probeGlStrings(): { renderer: string; vendor: string } {
  const canvas = globalThis.document.createElement('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (gl === null) return { renderer: '', vendor: '' };

  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer =
    debug === null
      ? String(gl.getParameter(gl.RENDERER) ?? '')
      : String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? '');
  const vendor =
    debug === null
      ? String(gl.getParameter(gl.VENDOR) ?? '')
      : String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) ?? '');

  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose !== null) lose.loseContext();

  return { renderer, vendor };
}

export interface SurfaceInfo {
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly aaNodes: readonly string[];
}

export function collectDiagnostics(
  caps: EngineCaps,
  quality: QualityResolution,
  tierSource: TierSource,
  renderScale: number,
  surface: SurfaceInfo,
): BootDiagnostics {
  const gl = probeGlStrings();
  const haystack = `${gl.renderer} ${gl.vendor} ${caps.adapterVendor} ${caps.adapterArchitecture}`.toLowerCase();

  return {
    webgpuAvailable: caps.hasWebGPU,
    adapterVendor: caps.adapterVendor,
    adapterArchitecture: caps.adapterArchitecture,
    isFallbackAdapter: caps.isFallbackAdapter,
    glRenderer: gl.renderer,
    glVendor: gl.vendor,
    isSoftwareRasteriser:
      caps.isFallbackAdapter || SOFTWARE_RASTERISERS.some((name) => haystack.includes(name)),
    tier: quality.graphics,
    tierSource,
    renderScale,
    bufferWidth: surface.bufferWidth,
    bufferHeight: surface.bufferHeight,
    displayWidth: surface.displayWidth,
    displayHeight: surface.displayHeight,
    pixelRatio:
      surface.displayWidth > 0 ? surface.bufferWidth / surface.displayWidth : 0,
    aaNodes: surface.aaNodes,
  };
}

/** Printed unconditionally, not behind DEV: a bug report needs it from a production build. */
export function reportDiagnostics(d: BootDiagnostics): void {
  const lines = [
    `  WebGPU available : ${String(d.webgpuAvailable)}`,
    `  adapter          : ${d.adapterVendor || '(none)'} / ${d.adapterArchitecture || '(none)'}${d.isFallbackAdapter ? '  [FALLBACK ADAPTER]' : ''}`,
    `  GL_RENDERER      : ${d.glRenderer || '(withheld)'}`,
    `  GL_VENDOR        : ${d.glVendor || '(withheld)'}`,
    `  tier             : ${d.tier}  (${d.tierSource})`,
    `  render scale     : ${d.renderScale.toFixed(2)}  (after ladder snap)`,
    `  internal buffer  : ${d.bufferWidth} x ${d.bufferHeight}`,
    `  display          : ${d.displayWidth} x ${d.displayHeight}`,
    `  buffer / display : ${d.pixelRatio.toFixed(3)}  ${d.pixelRatio >= 1 ? '(native or supersampled)' : '(UPSCALED)'}`,
    `  AA live          : ${d.aaNodes.length > 0 ? d.aaNodes.join(', ') : '(none)'}`,
  ];
  console.info(`[shatterpoint] boot diagnostics\n${lines.join('\n')}`);

  if (d.isSoftwareRasteriser) {
    console.warn(
      '[shatterpoint] SOFTWARE RASTERISER DETECTED — this machine has no usable GPU for ' +
        'the browser. Frame rate and any tier-gated visual feature are meaningless here. ' +
        'This is a browser-flag or hardware condition, not a code defect.',
    );
  }
}
