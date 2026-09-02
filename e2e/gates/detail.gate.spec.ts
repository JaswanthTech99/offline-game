import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { expect, test } from '../fixtures/game';

/**
 * STAGE 3 gate. Detail must be present in EVERY region of the image, not only where the
 * eye is drawn. A frame can look rich because its centre is busy while three quarters of it
 * is a flat gradient; dividing the frame into twelve cells and counting distinct luminance
 * values in each is what catches that.
 */
const GRID_X = 4;
const GRID_Y = 3;
/** Distinct 1/255 luminance levels a cell must contain. A flat gradient yields very few. */
const MIN_LEVELS_PER_CELL = 24;

test.describe('@detail', () => {
  test.beforeEach(({}, info) => {
    test.skip((info.project.metadata as { scale?: number }).scale !== 4, 'scale-4 project only');
    test.skip((info.project.metadata as { tier?: string }).tier !== 'DESKTOP_HIGH', 'DESKTOP_HIGH only');
  });

  test('every region of a 4x frame carries detail', async ({ game }, info) => {
    await game.boot({ scale: 1.5, seed: 20260902 });
    await game.hideHud();
    await game.freeze();

    const png = PNG.sync.read(await game.page.screenshot({ scale: 'device' }));
    await mkdir('exports', { recursive: true });
    await writeFile(join('exports', `detail-${game.tier}.png`), PNG.sync.write(png));

    const { width: W, height: H, data } = png;
    const rows: string[] = [`frame ${W}x${H}, ${GRID_X}x${GRID_Y} grid, distinct luma levels:`];
    const counts: number[] = [];

    for (let gy = 0; gy < GRID_Y; gy++) {
      const cells: string[] = [];
      for (let gx = 0; gx < GRID_X; gx++) {
        const x0 = Math.floor((gx * W) / GRID_X);
        const x1 = Math.floor(((gx + 1) * W) / GRID_X);
        const y0 = Math.floor((gy * H) / GRID_Y);
        const y1 = Math.floor(((gy + 1) * H) / GRID_Y);
        const seen = new Set<number>();
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const i = (y * W + x) * 4;
            const L = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
            seen.add(Math.round(L));
          }
        }
        counts.push(seen.size);
        cells.push(String(seen.size).padStart(4));
      }
      rows.push(`  ${cells.join('')}`);
    }
    const report = rows.join('\n');
    console.log(report);
    await info.attach('detail-grid', { body: report, contentType: 'text/plain' });

    for (const [i, c] of counts.entries()) {
      expect(c, `cell ${i} has only ${c} distinct luminance levels`).toBeGreaterThanOrEqual(
        MIN_LEVELS_PER_CELL,
      );
    }
  });
});
