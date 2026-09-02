import { defineConfig, devices } from '@playwright/test';

/**
 * One project per tier x deviceScaleFactor. Twelve in total, because a render pass that is
 * correct at 1x and broken at 4x is a real defect and only shows up if something renders
 * at 4x on purpose.
 *
 * Chromium is launched with WebGPU forced onto SwiftShader: this host has no GPU (its own
 * boot diagnostics say so), and a software adapter that renders CORRECTLY is worth more to
 * a gate than a fast one. Only the frame-rate numbers are meaningless here; luma, draw
 * calls, geometry and phase ordering are all exact.
 */
// MOBILE_ULTRA is in this list because it is the tier a OnePlus 12 actually resolves to.
// It was absent, so every gate in this suite was blind to the exact configuration the
// device screenshots came from - which is how a pane can pass at DESKTOP_HIGH and still
// ship as a hollow outline on the hardware in someone's hand.
const TIERS = [
  'SHOWCASE',
  'ULTRA_4K',
  'DESKTOP_HIGH',
  'MOBILE_ULTRA',
  'MOBILE_HIGH',
  'MOBILE_LOW',
] as const;
const SCALES = [1, 2, 4] as const;

/** Device pixels every project targets, whatever its deviceScaleFactor. */
const BASE_DEVICE_PX = { w: 960, h: 540 } as const;

const GPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--use-webgpu-adapter=swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-features=Vulkan,WebGPU',
];

export default defineConfig({
  testDir: './e2e',
  // Software rasterisation at 4x is genuinely slow; these are correctness gates, not a
  // latency budget, so the timeout is generous and the runner is serial.
  timeout: 300_000,
  expect: { timeout: 30_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  // SwiftShader is CPU-bound, and this host has 16 cores. Serial was leaving 15 idle while
  // a 4x software frame took seconds. Parallel across FILES only - tests within a file that
  // drive the same frozen page must stay ordered.
  fullyParallel: false,
  workers: process.env['CI'] === undefined ? 4 : 2,
  retries: 0,
  reporter: [['html', { outputFolder: 'e2e-report', open: 'never' }], ['list']],
  use: {
    baseURL: process.env['SP_URL'] ?? 'http://localhost:59593',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: GPU_ARGS },
  },
  webServer: {
    command: 'node ./node_modules/vite/bin/vite.js --host 0.0.0.0 --port 59593',
    url: 'http://localhost:59593',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: TIERS.flatMap((tier) =>
    SCALES.map((scale) => ({
      name: `${tier}@${scale}x`,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: scale,
        // Every project renders the SAME number of device pixels. The scale axis exists to
        // prove the DPR plumbing - buffer sizing, the render-scale ladder, whether the CSS
        // stack resamples - not to measure software-rasteriser throughput. Holding device
        // pixels constant is what makes 1x and 4x comparable instead of one of them simply
        // timing out. Genuine 3840x2160 output is export:4k's job, and it may take minutes.
        viewport: { width: BASE_DEVICE_PX.w / scale, height: BASE_DEVICE_PX.h / scale },
        launchOptions: { args: GPU_ARGS },
      },
      metadata: { tier, scale },
    })),
  ),
});
