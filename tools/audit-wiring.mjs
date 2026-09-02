/**
 * Wiring audit. Walks the import graph from src/main.ts and reports which modules the LIVE
 * app actually reaches.
 *
 * This exists because editing an unreached module and reporting it as a visual fix has
 * happened more than once in this project. A module that main.ts cannot reach cannot appear
 * on screen, whatever its contents.
 *
 *   node tools/audit-wiring.mjs
 *   node tools/audit-wiring.mjs --json
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src/main.ts');

/** Categories a module can be in. Anything unreached must be one of the last three. */
const PARKED = {
  // Reached only as types, or genuinely pending a wiring decision.
  'battle/': 'parked - backdrop war layer, not yet wired into any universe record',
  'universe/kits/': 'parked - corridor kits, consumed by CorridorGenerator which is itself unwired',
  'save/': 'parked - persistence, no UI surfaces it yet',
  'audio/': 'parked - typed stub, no assets',
};

const seen = new Set();
function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(c) && c.endsWith('.ts')) return c;
  }
  return null;
}
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  const specs = [
    ...[...src.matchAll(/import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
  ];
  for (const s of specs) {
    const t = resolveSpec(file, s);
    if (t) walk(t);
  }
}
walk(ENTRY);

const all = [];
(function scan(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) scan(p);
    else if (e.name.endsWith('.ts')) all.push(p);
  }
})(join(ROOT, 'src'));

const reached = new Set([...seen].map((f) => relative(ROOT, f)));
const rows = all
  .map((f) => relative(ROOT, f))
  .sort()
  .map((f) => {
    const live = reached.has(f);
    const key = Object.keys(PARKED).find((k) => f.includes(k));
    return { file: f, live, note: live ? '' : (key ? PARKED[key] : 'UNREACHED - decide: wire, delete, or park') };
  });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const dead = rows.filter((r) => !r.live);
  console.log(`  reached from main.ts : ${rows.length - dead.length}`);
  console.log(`  total under src/     : ${rows.length}`);
  console.log(`  UNREACHED            : ${dead.length}\n`);
  for (const r of dead) console.log(`  ${r.file.padEnd(42)} ${r.note}`);
}
process.exitCode = 0;
