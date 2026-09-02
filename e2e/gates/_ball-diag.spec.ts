import { expect, test } from '../fixtures/game';

interface MeshInfo {
  name: string;
  geo: string;
  radius: number;
  frustumCulled: boolean;
  visible: boolean;
  renderOrder: number;
  matType: string;
  depthWrite: boolean;
  transparent: boolean;
  metalness: number;
  emissiveNode: boolean;
  pos: [number, number, number];
}

declare global {
  interface Window {
    __shatterpoint__?: {
      scene: {
        traverse(cb: (o: unknown) => void): void;
      };
      camera: { fov: number; position: { x: number; y: number; z: number } };
    };
  }
}

async function ballMeshes(page: import('@playwright/test').Page): Promise<MeshInfo[]> {
  return page.evaluate(() => {
    const out: MeshInfo[] = [];
    const app = window.__shatterpoint__;
    if (app === undefined) return out;
    app.scene.traverse((raw) => {
      const o = raw as {
        isMesh?: boolean;
        name?: string;
        frustumCulled?: boolean;
        visible?: boolean;
        renderOrder?: number;
        position?: { x: number; y: number; z: number };
        geometry?: { type?: string; parameters?: { radius?: number }; boundingSphere?: unknown };
        material?: {
          type?: string;
          depthWrite?: boolean;
          transparent?: boolean;
          metalness?: number;
          emissiveNode?: unknown;
        };
      };
      if (o.isMesh !== true) return;
      const g = o.geometry;
      if (g?.type !== 'SphereGeometry') return;
      const m = o.material ?? {};
      out.push({
        name: o.name ?? '',
        geo: g.type ?? '?',
        radius: g.parameters?.radius ?? -1,
        frustumCulled: o.frustumCulled === true,
        visible: o.visible === true,
        renderOrder: o.renderOrder ?? 0,
        matType: m.type ?? '?',
        depthWrite: m.depthWrite === true,
        transparent: m.transparent === true,
        metalness: m.metalness ?? -1,
        emissiveNode: m.emissiveNode !== undefined && m.emissiveNode !== null,
        pos: [o.position?.x ?? 0, o.position?.y ?? 0, o.position?.z ?? 0],
      });
    });
    return out;
  }) as Promise<MeshInfo[]>;
}

test.describe('@diag', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 1, 'scale-1 only');
  });

  test('A: frozen field vs live field', async ({ game }) => {
    await game.boot({ seed: 4242 });
    await game.hideHud();
    await game.freeze();

    // --- frozen field (what the gate does today) ---
    await game.clearField();
    await game.throwAt(0, 0);
    const frozenRows: string[] = [];
    for (let i = 0; i < 36; i++) {
      await game.step();
      if (i % 6 === 5) {
        const w = await game.page.evaluate(() => window.__sp!.ballWorld());
        const s = await game.ballScreen();
        const snap = await game.snapshot();
        frozenRows.push(
          `  step ${String(i + 1).padStart(2)} (${String(Math.round(((i + 1) * 1000) / 60)).padStart(3)}ms)  ` +
            `world ${w === null ? 'null' : `${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)}`}  ` +
            `screen ${s === null ? 'null' : `${s.x.toFixed(0)},${s.y.toFixed(0)}`}  live ${snap.liveBalls}  panes ${snap.paneCount}`,
        );
      }
    }
    console.log(`A/frozen (clearField then step):\n${frozenRows.join('\n')}`);

    const meshes = await ballMeshes(game.page);
    console.log(`A/ball meshes: ${JSON.stringify(meshes, null, 1)}`);

    // --- live field (no clearField) ---
    await game.boot({ seed: 4242 });
    await game.hideHud();
    await game.freeze();
    await game.throwAt(0, 0);
    const liveRows: string[] = [];
    const dpr = game.scale;
    for (let i = 0; i < 40; i++) {
      await game.step();
      const w = await game.page.evaluate(() => window.__sp!.ballWorld());
      const s = await game.ballScreen();
      let radiusPx = -1;
      if (w !== null) {
        const edge = await game.page.evaluate(
          ([x, y, z]) => window.__sp!.project((x as number) + 0.34, y as number, z as number),
          [w.x, w.y, w.z] as const,
        );
        if (s !== null && edge !== null) radiusPx = Math.hypot(edge.x - s.x, edge.y - s.y) * dpr;
      }
      const snap = await game.snapshot();
      liveRows.push(
        `  step ${String(i + 1).padStart(2)} (${String(Math.round(((i + 1) * 1000) / 60)).padStart(3)}ms)  ` +
          `world ${w === null ? 'null' : `${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)}`}  ` +
          `screen ${s === null ? 'null' : `${s.x.toFixed(0)},${s.y.toFixed(0)}`}  ` +
          `projR ${radiusPx.toFixed(2)}px  live ${snap.liveBalls}  panes ${snap.paneCount}`,
      );
    }
    console.log(`A/live (no clearField):\n${liveRows.join('\n')}`);
    expect(true).toBe(true);
  });
});
