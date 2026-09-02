import { expect, test } from '../fixtures/game';

/**
 * STAGE 2 logic gate. DESKTOP-ONLY - this proves the tier RULES, not any device's outcome.
 *
 * It exists because the rule that was wrong was a single line, and a single line is exactly
 * the kind of thing that gets reintroduced. Device numbers come from tools/device/gate.mjs.
 */
interface Caps {
  isMobile: boolean;
  hasWebGPU: boolean;
  hasCompute: boolean;
  glRenderer: string | null;
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
  maxTextureSize: number;
  devicePixelRatio: number;
  surfacePixels: number;
  prefersReducedMotion: boolean;
  hasTimestampQuery: boolean;
  hasFloat32Filterable: boolean;
  maxAnisotropy: number;
}

const base: Caps = {
  isMobile: true, hasWebGPU: false, hasCompute: false,
  glRenderer: null, hardwareConcurrency: 8, deviceMemoryGb: 8,
  maxTextureSize: 8192, devicePixelRatio: 3, surfacePixels: 851 * 393,
  prefersReducedMotion: false, hasTimestampQuery: false,
  hasFloat32Filterable: false, maxAnisotropy: 16,
};

// Evaluated INSIDE the page: Quality.ts reads import.meta.env, so it only resolves through
// Vite. Importing it into the e2e program directly would test a different module.
test('a flagship phone is no longer punished for WebView having no WebGPU', async ({ game }) => {
  await game.boot({ seed: 1 });
  const detect = async (caps: Caps): Promise<string> =>
    game.page.evaluate(async (c) => {
      // Specifier assembled at runtime: a literal would be resolved by tsc, which cannot
      // see Vite's dev server and has no business trying.
      const m = (await import(['', 'src', 'core', 'Quality.ts'].join('/'))) as {
        detectTier: (caps: unknown) => string;
      };
      return m.detectTier(c);
    }, caps);
  // OnePlus 12. Android WebView exposes no navigator.gpu at all, which is what used to
  // send this straight to MOBILE_LOW alongside a budget handset.
  expect(await detect({ ...base, glRenderer: 'Adreno (TM) 750', hasWebGPU: false })).toBe('MOBILE_ULTRA');

  expect(await detect({ ...base, glRenderer: 'Mali-G715-Immortalis MC11' })).toBe('MOBILE_ULTRA');

  // A budget part must still land low, or the tier means nothing.
  expect(await detect({ ...base, glRenderer: 'Adreno (TM) 610', hardwareConcurrency: 4, deviceMemoryGb: 3, maxTextureSize: 4096 })).toBe('MOBILE_LOW');

  // A withheld renderer string is UNKNOWN, not low-end: a privacy-hardened browser must
  // not be punished with the worst tier.
  expect(await detect({ ...base, glRenderer: null })).toBe('MOBILE_HIGH');
});

test('measurement promotes and demotes one step, and respects the ceiling', async ({ game }) => {
  await game.boot({ seed: 1 });
  const m = async (from: string, ms: number, cap: string): Promise<string> =>
    game.page.evaluate(async ([f, x, c]) => {
      const mod = (await import(['', 'src', 'core', 'Quality.ts'].join('/'))) as {
        measuredTier: (from: string, ms: number, cap: string) => { tier: string };
      };
      return mod.measuredTier(f as string, x as number, c as string).tier;
    }, [from, ms, cap] as const);

  expect(await m('MOBILE_HIGH', 8, 'MOBILE_ULTRA')).toBe('MOBILE_ULTRA');
  expect(await m('MOBILE_ULTRA', 40, 'MOBILE_ULTRA')).toBe('MOBILE_HIGH');
  expect(await m('MOBILE_HIGH', 16, 'MOBILE_ULTRA')).toBe('MOBILE_HIGH');
  // A phone measured cold must not be promoted past what its class can sustain.
  expect(await m('MOBILE_ULTRA', 4, 'MOBILE_ULTRA')).toBe('MOBILE_ULTRA');
});
