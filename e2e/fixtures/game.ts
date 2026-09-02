import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

/** Mirrors src/core/DebugBridge.ts. Kept structural so e2e never imports engine code. */
export interface DebugSnapshot {
  ready: boolean;
  phase: string;
  ballsLeft: number;
  approach: number;
  isTutorial: boolean;
  travelSpeed: number;
  paneCount: number;
  crystalCount: number;
  liveBalls: number;
  liveShards: number;
  drawCalls: number;
  elementCount: number;
  tier: string;
  tierSource: string;
  renderScale: number;
  bufferWidth: number;
  bufferHeight: number;
  displayWidth: number;
  displayHeight: number;
  liveAA: string[];
  score: number;
  multiplier: number;
}

export interface BootOptions {
  tier?: string;
  scale?: number;
  seed?: number;
  universe?: string;
  webgl?: boolean;
  /** Hide the HUD. The DOM overlay is part of the image and pollutes a scene measurement. */
  hideHud?: boolean;
}

export class Game {
  constructor(
    readonly page: Page,
    readonly info: TestInfo,
  ) {}

  get tier(): string {
    return (this.info.project.metadata as { tier?: string }).tier ?? 'DESKTOP_HIGH';
  }

  get scale(): number {
    return (this.info.project.metadata as { scale?: number }).scale ?? 1;
  }

  async boot(options: BootOptions = {}): Promise<void> {
    const q = new URLSearchParams();
    q.set('tier', options.tier ?? this.tier);
    if (options.scale !== undefined) q.set('scale', String(options.scale));
    if (options.seed !== undefined) q.set('seed', String(options.seed));
    if (options.universe !== undefined) q.set('universe', options.universe);
    // The WebGL backend is the only one this software host renders reliably; SSR and the
    // WebGPU device both fall over on SwiftShader under load.
    if (options.webgl !== false) q.set('webgl', '1');

    await this.page.goto(`/?${q.toString()}`, { waitUntil: 'load' });
    await this.page.waitForFunction(() => window.__sp?.ready() === true, null, {
      timeout: 150_000,
    });
    if (options.hideHud === true) await this.hideHud();
  }

  /** The HUD is DOM. It is part of the shipped image but never part of a scene measurement. */
  async hideHud(): Promise<void> {
    await this.page.addStyleTag({ content: '.sp-overlay{display:none!important}' });
    await this.page.waitForTimeout(120);
  }

  snapshot(): Promise<DebugSnapshot> {
    return this.page.evaluate(() => window.__sp!.snapshot() as unknown as DebugSnapshot);
  }

  /** Stops every clock so a capture is byte-stable. */
  async freeze(): Promise<void> {
    await this.page.evaluate(() => window.__sp!.freeze());
    await this.page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important}',
    });
    await this.page.waitForTimeout(150);
  }

  step(dtMs = 1000 / 60): Promise<void> {
    return this.page.evaluate((ms) => window.__sp!.step(ms), dtMs);
  }

  place(kind: 'pane' | 'decorative' | 'crystal', distanceM: number, offsetX = 0): Promise<void> {
    return this.page.evaluate(
      ([k, d, x]) => window.__sp!.place(k as 'pane', d as number, x as number),
      [kind, distanceM, offsetX] as const,
    );
  }

  clearField(): Promise<void> {
    return this.page.evaluate(() => window.__sp!.clearField());
  }

  throwAt(x = 0, y = 0): Promise<void> {
    return this.page.evaluate(([nx, ny]) => window.__sp!.throwAt(nx, ny), [x, y] as const);
  }

  shatter(): Promise<void> {
    return this.page.evaluate(() => window.__sp!.shatter());
  }

  ballScreen(): Promise<{ x: number; y: number } | null> {
    return this.page.evaluate(() => {
      const w = window.__sp!.ballWorld();
      return w === null ? null : window.__sp!.project(w.x, w.y, w.z);
    });
  }
}

export const test = base.extend<{ game: Game }>({
  game: async ({ page }, use, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await use(new Game(page, info));
    // A gate that passes while the console is full of errors has proved nothing.
    const real = errors.filter((e) => !/SOFTWARE RASTERISER|WebGPU is not available/.test(e));
    expect(real, `console errors:\n${real.join('\n')}`).toHaveLength(0);
  },
});

export { expect };

declare global {
  interface Window {
    __sp?: {
      ready(): boolean;
      snapshot(): unknown;
      freeze(): void;
      unfreeze(): void;
      step(dtMs: number): void;
      place(kind: 'pane' | 'decorative' | 'crystal', distanceM: number, offsetX?: number): void;
      clearField(): void;
      advanceTo(approach: number): void;
      throwAt(ndcX: number, ndcY: number): void;
      shatter(): void;
      restart(): void;
      ballWorld(): { x: number; y: number; z: number } | null;
      project(x: number, y: number, z: number): { x: number; y: number } | null;
    };
  }
}
