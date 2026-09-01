#!/usr/bin/env node
/**
 * THE 40-PIXEL TEST, MADE LOOKABLE-AT.
 *
 * `battle/Silhouettes.ts` asserts in code that the cast is legible at 40px: enough ink, the
 * declared part count, an articulated outline, low overlap with every other shape. Those are
 * the right measurements and they are still not the test. The test is a human looking at a
 * sheet of small black shapes and being able to tell them apart. A validator can only prove
 * that no two shapes are numerically identical; it cannot notice that six of them are all
 * "person with a stick".
 *
 * So this tool renders every combatant of every roster at exactly 40 pixels tall, in pure
 * black, into docs/silhouettes/, and builds a contact sheet you open in a browser. It renders
 * the REAL geometry - the same rings, the same tableau pose, the same size box the backdrop
 * layer will use - because a sheet of stand-in boxes proves nothing at all.
 *
 * WHY IT PARSES TYPESCRIPT: Node 20 cannot import a .ts module and this repo may not grow a
 * dependency to do it. The alternative - a hand-copied JS duplicate of the ring data - would
 * decay the first time an artist moved a vertex, and a contact sheet that shows shapes the
 * game does not draw is worse than no contact sheet. So the ring expressions are read out of
 * the source and evaluated against ports of the four authoring primitives, which are small,
 * pure and change about once a year. If the parse cannot find something it expects, the tool
 * exits non-zero rather than quietly emitting a thinner cast.
 *
 * IP: every shape here is an original archetype - a mass, an attribute and a stance. Nothing
 * in this pipeline can introduce a likeness; it only draws what the roster files declare.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SILHOUETTE_SRC = join(ROOT, 'src/battle/Silhouettes.ts');
const ROSTER_DIR = join(ROOT, 'src/battle/rosters');
const OUT_DIR = join(ROOT, 'docs/silhouettes');

/** Files in the roster directory that hold no cast. */
const NON_ROSTER_FILES = new Set(['design.ts', 'index.ts']);

/** The test height. Not configurable: 40px is the claim being checked. */
const TEST_HEIGHT_PX = 40;

/** Reference backdrop shape. widthFrac and heightFrac are fractions of DIFFERENT axes, so a
 *  figure has no pixel aspect until a frame shape is chosen; 16:9 is the design target. */
const BACKDROP_W = 960;
const BACKDROP_H = 540;

/** Where the ground sits in the reference frame. anchor.yFrac lifts feet from here to 0. */
const HORIZON_Y = BACKDROP_H * 0.8;

/** Narrow figures still need a canvas wide enough to see the shape sitting inside it. */
const MIN_TILE_W = 8;

const RAD_TO_DEG = 180 / Math.PI;

// ------------------------------------------------------------------- authoring primitives
// Ports of the four shape builders in battle/Silhouettes.ts. They are duplicated here rather
// than shared because tools/ may not import from src/, and they are pure functions of numbers
// so a divergence shows up immediately as a visibly wrong contact sheet.

const TAU = Math.PI * 2;

const pt = (x, y) => ({ x, y });
const quad = (a, b, c, d) => [a, b, c, d];
const tri = (a, b, c) => [a, b, c];

function plate(cx, cy, rx, ry, rot = 0, segs = 14) {
  const out = [];
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let i = 0; i < segs; i += 1) {
    const a = (i / segs) * TAU;
    const px = Math.cos(a) * rx;
    const py = Math.sin(a) * ry;
    out.push(pt(cx + px * cr - py * sr, cy + px * sr + py * cr));
  }
  return out;
}

function limb(a, b, bow, wA, wB, segs = 8) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const cx = (a.x + b.x) * 0.5 + nx * bow;
  const cy = (a.y + b.y) * 0.5 + ny * bow;

  const left = [];
  const right = [];
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const u = 1 - t;
    const sx = u * u * a.x + 2 * u * t * cx + t * t * b.x;
    const sy = u * u * a.y + 2 * u * t * cy + t * t * b.y;
    const tx = 2 * u * (cx - a.x) + 2 * t * (b.x - cx);
    const ty = 2 * u * (cy - a.y) + 2 * t * (b.y - cy);
    const tl = Math.sqrt(tx * tx + ty * ty) || 1;
    const px = -ty / tl;
    const py = tx / tl;
    const hw = (wA + (wB - wA) * t) * 0.5;
    left.push(pt(sx + px * hw, sy + py * hw));
    right.push(pt(sx - px * hw, sy - py * hw));
  }
  right.reverse();
  return [...left, ...right];
}

function chevron(cx, cy, span, sweep, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const at = (x, y) => pt(cx + x * c - y * s, cy + x * s + y * c);
  const apex = at(span * 0.5, 0);
  return [
    limb(apex, at(-span * 0.5, sweep), span * 0.18, span * 0.16, span * 0.05, 4),
    limb(apex, at(-span * 0.5, -sweep), -span * 0.18, span * 0.16, span * 0.05, 4),
  ];
}

/**
 * `chevron` returns two rings, so a registry entry may list it either spread into the array
 * or nested inside it. Both spellings mean the same picture, and the sheet must not go blank
 * because an author changed their mind about a `...`.
 */
function flattenRings(items) {
  const out = [];
  for (const item of items) {
    if (!Array.isArray(item)) continue;
    if (Array.isArray(item[0])) out.push(...flattenRings(item));
    else out.push(item);
  }
  return out;
}

/** Port of the registry's normalise(): unit box, true aspect kept alongside. */
function normalise(rings) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 0 && h > 0)) return null;
  return {
    rings: rings.map((ring) => ring.map((p) => pt((p.x - minX) / w, (p.y - minY) / h))),
    aspect: w / h,
  };
}

// ------------------------------------------------------------------------------ source read

function die(message) {
  process.stderr.write(`silhouettes: ${message}\n`);
  process.exit(1);
}

/** Blanks comments, preserves string bodies and every byte offset. */
function maskComments(src) {
  const out = src.split('');
  let i = 0;
  let mode = 'code';
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        mode = 'line';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        mode = 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        i += 1;
        while (i < src.length) {
          if (src[i] === '\\') {
            i += 2;
            continue;
          }
          if (src[i] === quote) break;
          i += 1;
        }
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') mode = 'code';
      else out[i] = ' ';
      i += 1;
      continue;
    }
    if (c === '*' && d === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      mode = 'code';
      i += 2;
      continue;
    }
    if (c !== '\n') out[i] = ' ';
    i += 1;
  }
  return out.join('');
}

/** Index just past the bracket matching the one at `open`. */
function matchBracket(src, open) {
  const opener = src[open];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === opener) depth += 1;
    else if (src[i] === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Text of the `[...]` or `{...}` that follows `key:` inside `body`, brackets included. */
function bracketValue(body, key) {
  const at = new RegExp(`(^|[^\\w$.])${key}\\s*:\\s*[[{]`, 'm').exec(body);
  if (at === null) return null;
  const open = at.index + at[0].length - 1;
  const end = matchBracket(body, open);
  if (end < 0) return null;
  return body.slice(open, end);
}

const numberField = (body, key) => {
  const m = new RegExp(`(^|[^\\w$.])${key}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'm').exec(body);
  return m === null ? null : Number(m[2]);
};

const stringField = (body, key) => {
  const m = new RegExp(`(^|[^\\w$.])${key}\\s*:\\s*'([^']*)'`, 'm').exec(body);
  return m === null ? null : m[2];
};

/**
 * Reads the tier alias constants (ALL_TIERS, BACK_TIERS, ...) so `tiers: BACK_TIERS` resolves
 * to real tier names instead of being reported as an unknown symbol.
 */
function readTierAliases(src) {
  const aliases = new Map();
  for (const m of src.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*:[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)/g)) {
    const names = [...m[2].matchAll(/'([a-z-]+)'/g)].map((n) => n[1]);
    if (names.length > 0) aliases.set(m[1], names);
  }
  return aliases;
}

function readSilhouettes() {
  const src = maskComments(readFileSync(SILHOUETTE_SRC, 'utf8'));
  const aliases = readTierAliases(src);

  const registryAt = src.indexOf('export const SILHOUETTES');
  if (registryAt < 0) die('src/battle/Silhouettes.ts has no `export const SILHOUETTES`');
  const open = src.indexOf('{', registryAt);
  const end = matchBracket(src, open);
  if (end < 0) die('the SILHOUETTES registry literal is unbalanced');
  const registry = src.slice(open, end);

  const evaluateRings = new Function(
    'pt',
    'quad',
    'tri',
    'plate',
    'limb',
    'chevron',
    'Math',
    'expr',
    'return eval(expr);',
  );

  const defs = new Map();
  for (const hit of registry.matchAll(/define\(\s*'([^']+)'\s*,\s*\{/g)) {
    const id = hit[1];
    const specOpen = registry.indexOf('{', hit.index + hit[0].length - 1);
    const specEnd = matchBracket(registry, specOpen);
    if (specEnd < 0) die(`silhouette "${id}" has an unbalanced spec literal`);
    const spec = registry.slice(specOpen + 1, specEnd - 1);

    const ringsExpr = bracketValue(spec, 'rings');
    if (ringsExpr === null) die(`silhouette "${id}" declares no rings`);

    let raw;
    try {
      raw = evaluateRings(pt, quad, tri, plate, limb, chevron, Math, `(${ringsExpr})`);
    } catch (error) {
      die(`silhouette "${id}" rings did not evaluate: ${error instanceof Error ? error.message : error}`);
    }
    const unit = normalise(flattenRings(raw));
    if (unit === null) die(`silhouette "${id}" has a degenerate bounding box`);

    const tableauSrc = bracketValue(spec, 'tableau') ?? '{}';
    const tiersSymbol = /(^|[^\w$.])tiers\s*:\s*([A-Za-z_$][\w$]*)/m.exec(spec);

    defs.set(id, {
      id,
      rings: unit.rings,
      aspect: unit.aspect,
      leadingAngle: numberField(spec, 'leadingAngle') ?? 0,
      parts: numberField(spec, 'parts') ?? 1,
      tiers: tiersSymbol === null ? [] : (aliases.get(tiersSymbol[2]) ?? []),
      tableau: {
        lean: numberField(tableauSrc, 'lean') ?? 0,
        rise: numberField(tableauSrc, 'rise') ?? 0,
        scale: numberField(tableauSrc, 'scale') ?? 1,
        crop: numberField(tableauSrc, 'crop') ?? 0,
      },
    });
  }

  if (defs.size === 0) die('parsed zero silhouettes - the registry format has changed');
  return defs;
}

function readRosters() {
  const files = readdirSync(ROSTER_DIR)
    .filter((name) => name.endsWith('.ts') && !NON_ROSTER_FILES.has(name))
    .sort();

  const rosters = [];
  for (const name of files) {
    const path = join(ROSTER_DIR, name);
    const src = maskComments(readFileSync(path, 'utf8'));

    const callAt = src.indexOf('defineRoster(');
    if (callAt < 0) {
      die(`${name} is in rosters/ but calls no defineRoster - add it to NON_ROSTER_FILES or fix it`);
    }
    const specOpen = src.indexOf('{', callAt);
    const specEnd = matchBracket(src, specOpen);
    if (specEnd < 0) die(`${name}: defineRoster argument is unbalanced`);
    const spec = src.slice(specOpen + 1, specEnd - 1);

    const figuresSrc = bracketValue(spec, 'figures');
    if (figuresSrc === null) die(`${name}: defineRoster spec has no figures array`);

    const figures = [];
    let cursor = 1;
    while (cursor < figuresSrc.length) {
      const objOpen = figuresSrc.indexOf('{', cursor);
      if (objOpen < 0) break;
      const objEnd = matchBracket(figuresSrc, objOpen);
      if (objEnd < 0) die(`${name}: figure ${figures.length} is unbalanced`);
      const body = figuresSrc.slice(objOpen + 1, objEnd - 1);
      cursor = objEnd;

      const designSrc = bracketValue(body, 'design') ?? '{}';
      const anchorSrc = bracketValue(body, 'anchor') ?? '{}';
      figures.push({
        id: stringField(body, 'id') ?? `figure-${figures.length}`,
        tier: stringField(body, 'tier') ?? 'horizon',
        silhouette: stringField(body, 'silhouette') ?? '',
        widthFrac: numberField(body, 'widthFrac') ?? 0,
        heightFrac: numberField(body, 'heightFrac') ?? 0,
        opacity: numberField(body, 'opacity') ?? 1,
        xFrac: numberField(anchorSrc, 'xFrac') ?? 0,
        yFrac: numberField(anchorSrc, 'yFrac') ?? 0,
        attribute: stringField(designSrc, 'attribute') ?? '?',
        form: stringField(designSrc, 'form') ?? '?',
        stance: stringField(designSrc, 'stance') ?? '?',
        note: stringField(designSrc, 'note') ?? '',
      });
    }

    if (figures.length === 0) die(`${name}: parsed zero figures`);

    rosters.push({
      file: name,
      id: stringField(spec, 'id') ?? basename(name, '.ts'),
      displayName: stringField(spec, 'displayName') ?? basename(name, '.ts'),
      figures,
    });
  }

  if (rosters.length === 0) die('found no roster files in src/battle/rosters');
  return rosters;
}

// ----------------------------------------------------------------------------- rasterisation

const round2 = (n) => (Math.round(n * 100) / 100).toString();

/**
 * One `<path>` per ring, never one merged path. The registry's rings are UNIONED, and rings
 * are not consistently wound, so a single path with any fill rule would punch holes wherever
 * two overlapping rings happen to disagree - exactly where a limb meets a torso.
 */
function ringPaths(def, place) {
  const out = [];
  for (const ring of def.rings) {
    if (ring.length < 3) continue;
    let d = '';
    for (let i = 0; i < ring.length; i += 1) {
      const p = place(ring[i].x, ring[i].y);
      d += `${i === 0 ? 'M' : 'L'}${round2(p.x)},${round2(p.y)}`;
    }
    out.push(`${d}Z`);
  }
  return out;
}

/**
 * Places a figure inside a box of the given pixel size, honouring the tableau pose: `scale`
 * may deliberately overflow the box and `crop` then pushes the overflow out through the
 * bottom edge, which is what makes a near figure read as near rather than as a small toy.
 */
function placement(def, boxW, boxH, centreX, feetY) {
  const fitted = Math.min(boxW / def.aspect, boxH);
  const shapeH = fitted * def.tableau.scale;
  const shapeW = shapeH * def.aspect;
  const baseY = feetY + def.tableau.crop * shapeH - def.tableau.rise * shapeH;
  return {
    shapeW,
    shapeH,
    baseY,
    centreX,
    place: (rx, ry) => ({ x: centreX - shapeW / 2 + rx * shapeW, y: baseY - ry * shapeH }),
  };
}

/**
 * THE ARTEFACT. One figure, forty pixels of VISIBLE height, pure black, nothing else.
 *
 * "40px tall" measures the figure, not the canvas: letterboxing the shape inside its authored
 * size box would produce a 14px figure in a 40px tile and quietly pass a test it never took.
 * The size box is a staging constraint and it is answered by the tableau strip instead.
 *
 * `crop` is honoured because it is part of what the player sees - a figure authored to run off
 * the bottom of the aperture is read as a 40px band of body, not as a whole small body - so
 * the shape is scaled until its UNCROPPED part is exactly 40px and the rest falls out of the
 * viewport. `rise` is not honoured: it moves the figure within the backdrop and says nothing
 * about its outline.
 */
const MAX_CROP = 0.6;

function layoutAtTestHeight(def) {
  const spin = -def.tableau.lean;
  const cos = Math.cos(spin);
  const sin = Math.sin(spin);
  // Authoring space with y already flipped to screen-down, unit height, pivoting on the feet.
  const pivotX = def.aspect / 2;
  const turn = (rx, ry) => {
    const x = rx * def.aspect - pivotX;
    const y = -ry;
    return { x: x * cos - y * sin + pivotX, y: x * sin + y * cos };
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of def.rings) {
    for (const p of ring) {
      const q = turn(p.x, p.y);
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
  }

  const crop = Math.min(Math.max(def.tableau.crop, 0), MAX_CROP);
  const scale = TEST_HEIGHT_PX / ((maxY - minY) * (1 - crop));
  const width = Math.max(MIN_TILE_W, Math.ceil((maxX - minX) * scale));
  const offsetX = (width - (maxX - minX) * scale) / 2;

  return {
    width,
    height: TEST_HEIGHT_PX,
    place: (rx, ry) => {
      const q = turn(rx, ry);
      return { x: (q.x - minX) * scale + offsetX, y: (q.y - minY) * scale };
    },
  };
}

/** One SVG per shape. Two figures on the same silhouette ARE the same picture at 40px, and
 *  the sheet says so rather than pretending the size box made them different. */
function shapeSvg(def, label) {
  const geom = layoutAtTestHeight(def);
  const paths = ringPaths(def, geom.place)
    .map((d) => `<path d="${d}"/>`)
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${geom.width}" height="${geom.height}" ` +
    `viewBox="0 0 ${geom.width} ${geom.height}" role="img" aria-label="${escapeXml(label)}">` +
    `<title>${escapeXml(label)}</title>` +
    `<g fill="#000000" fill-rule="nonzero" shape-rendering="geometricPrecision">${paths}</g></svg>`
  );
}

/**
 * The whole cast staged in one reference frame at its authored sizes and opacities. The 40px
 * tiles answer "is this shape distinct"; only this answers "does the backdrop read as depth".
 */
function tableauSvg(roster, defs) {
  const order = { horizon: 0, mid: 1, fore: 2 };
  const staged = [...roster.figures].sort((a, b) => (order[a.tier] ?? 0) - (order[b.tier] ?? 0));

  const body = staged
    .map((figure) => {
      const def = defs.get(figure.silhouette);
      if (def === undefined) return '';
      const boxW = figure.widthFrac * BACKDROP_W;
      const boxH = figure.heightFrac * BACKDROP_H;
      const centreX = ((figure.xFrac + 1) / 2) * BACKDROP_W;
      const feetY = HORIZON_Y * (1 - figure.yFrac);
      const geom = placement(def, boxW, boxH, centreX, feetY);
      const spin = -def.tableau.lean * RAD_TO_DEG;
      const paths = ringPaths(def, geom.place)
        .map((d) => `<path d="${d}"/>`)
        .join('');
      const inner =
        Math.abs(spin) < 0.01
          ? paths
          : `<g transform="rotate(${round2(spin)} ${round2(geom.centreX)} ${round2(geom.baseY)})">${paths}</g>`;
      return `<g fill="#000000" fill-opacity="${figure.opacity}"><title>${escapeXml(figure.id)}</title>${inner}</g>`;
    })
    .join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BACKDROP_W} ${BACKDROP_H}" ` +
    `class="tableau" role="img" aria-label="${escapeXml(roster.displayName)} staged at authored scale">` +
    `<line x1="0" y1="${HORIZON_Y}" x2="${BACKDROP_W}" y2="${HORIZON_Y}" stroke="#000000" ` +
    `stroke-opacity="0.14" stroke-width="1"/>${body}</svg>`
  );
}

// ------------------------------------------------------------------------------ contact sheet

const escapeXml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const PAGE_CSS = `
:root { --z: 1; color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f4f4f2; color: #14161a;
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 32px 24px 96px; }
h1 { font-size: 24px; letter-spacing: -0.01em; margin: 0 0 8px; }
h2 { font-size: 17px; margin: 48px 0 4px; letter-spacing: -0.01em; }
h2 span { font-weight: 400; color: #6b7280; font-size: 13px; margin-left: 8px; }
p.lede { max-width: 62ch; color: #4b5563; margin: 0 0 20px; }
.bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center;
  padding: 10px 0; background: #f4f4f2; border-bottom: 1px solid #dcdcd8; margin-bottom: 8px; }
button { font: inherit; padding: 4px 12px; border: 1px solid #c3c3bd; border-radius: 999px;
  background: #fff; cursor: pointer; }
button[aria-pressed="true"] { background: #14161a; color: #fff; border-color: #14161a; }
.hint { color: #6b7280; margin-left: auto; }
.tableau { display: block; width: 100%; height: auto; background: #fff;
  border: 1px solid #e3e3df; border-radius: 6px; margin: 10px 0 18px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(178px, 1fr)); gap: 10px; }
.card { background: #fff; border: 1px solid #e3e3df; border-radius: 6px; padding: 10px;
  display: flex; flex-direction: column; gap: 8px; }
.stage { display: flex; align-items: flex-end; justify-content: center; overflow: hidden;
  height: calc(40px * var(--z) + 14px); border-bottom: 1px dashed #e3e3df; }
.stage svg { transform: scale(var(--z)); transform-origin: bottom center; }
.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  word-break: break-all; }
.meta { color: #6b7280; font-size: 11px; line-height: 1.45; }
.tag { display: inline-block; background: #eceae5; border-radius: 3px; padding: 0 5px;
  margin-right: 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.note { color: #6b7280; font-size: 11px; font-style: italic; }
.warn { background: #fff5d6; border: 1px solid #e6cf82; border-radius: 6px; padding: 10px 14px;
  margin: 16px 0; }
.warn ul { margin: 6px 0 0; padding-left: 18px; }
footer { color: #6b7280; margin-top: 56px; font-size: 12px; }
`;

const PAGE_JS = `
const buttons = [...document.querySelectorAll('[data-zoom]')];
for (const button of buttons) {
  button.addEventListener('click', () => {
    document.documentElement.style.setProperty('--z', button.dataset.zoom);
    for (const other of buttons) other.setAttribute('aria-pressed', String(other === button));
  });
}
`;

function cardHtml(figure, def, svg) {
  const missing = def === undefined;
  return [
    '<figure class="card">',
    `<div class="stage">${missing ? '<span class="meta">no shape</span>' : svg}</div>`,
    `<figcaption><div class="id">${escapeXml(figure.id)}</div>`,
    `<div class="meta"><span class="tag">${escapeXml(figure.tier)}</span>`,
    `${escapeXml(figure.silhouette)}<br>`,
    `${escapeXml(figure.attribute)} &middot; ${escapeXml(figure.form)} &middot; ${escapeXml(figure.stance)}<br>`,
    `opacity ${figure.opacity} &middot; ${figure.widthFrac}w &times; ${figure.heightFrac}h`,
    `${missing ? ' &middot; <strong>unknown silhouette</strong>' : ''}</div>`,
    `<div class="note">${escapeXml(figure.note)}</div></figcaption>`,
    '</figure>',
  ].join('');
}

function buildPage(rosters, defs, cards, warnings, figureCount, shapeUsers) {
  const sections = rosters
    .map((roster) => {
      const tiles = roster.figures.map((figure) => cards.get(`${roster.id}/${figure.id}`)).join('');
      return [
        `<h2>${escapeXml(roster.displayName)}<span>${escapeXml(roster.id)} &middot; ${roster.figures.length} figures</span></h2>`,
        tableauSvg(roster, defs),
        `<div class="grid">${tiles}</div>`,
      ].join('\n');
    })
    .join('\n');

  const castTiles = [...defs.values()]
    .map((def) => {
      const uses = shapeUsers.get(def.id) ?? 0;
      const staging = def.tiers.length === 0 ? 'unstaged' : def.tiers.join(' / ');
      return [
        '<figure class="card">',
        `<div class="stage">${shapeSvg(def, def.id)}</div>`,
        `<figcaption><div class="id">${escapeXml(def.id)}</div>`,
        `<div class="meta"><span class="tag">${escapeXml(staging)}</span>`,
        `${uses} figure${uses === 1 ? '' : 's'} use it<br>`,
        `${def.parts} part${def.parts === 1 ? '' : 's'} &middot; aspect ${def.aspect.toFixed(2)}</div>`,
        `<div class="note">lean ${def.tableau.lean} &middot; rise ${def.tableau.rise} ` +
          `&middot; scale ${def.tableau.scale} &middot; crop ${def.tableau.crop}</div>`,
        '</figcaption></figure>',
      ].join('');
    })
    .join('');

  const warningBlock =
    warnings.length === 0
      ? ''
      : `<div class="warn"><strong>${warnings.length} thing${warnings.length === 1 ? '' : 's'} to look at</strong>` +
        `<ul>${warnings.map((w) => `<li>${escapeXml(w)}</li>`).join('')}</ul></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SHATTERPOINT silhouette contact sheet</title>
<style>${PAGE_CSS}</style></head>
<body><main>
<h1>The 40-pixel test</h1>
<p class="lede">Every combatant in every roster, drawn from the real ring geometry at exactly
40 pixels tall in pure black &mdash; the size and the colour the player actually sees them at,
behind haze, for a fraction of a second. If two shapes on this page are hard to tell apart at
1&times;, they are the same figure in the game. The wide strip above each grid stages the cast
at its authored sizes and opacities, which is the separate question of whether the backdrop
reads as depth.</p>
<div class="bar">
  <button data-zoom="1" aria-pressed="true">1&times; (40px)</button>
  <button data-zoom="2" aria-pressed="false">2&times;</button>
  <button data-zoom="4" aria-pressed="false">4&times;</button>
  <span class="hint">Only 1&times; is the test. The others are for finding out <em>why</em> a shape failed it.</span>
</div>
${warningBlock}
${sections}
<h2>The shape registry<span>${defs.size} silhouettes, each staged alone</span></h2>
<div class="grid">${castTiles}</div>
<footer>Generated by tools/silhouettes.mjs from src/battle/Silhouettes.ts and
src/battle/rosters/ &mdash; ${figureCount} figures across ${rosters.length} rosters.
Regenerate with <code>npm run silhouettes</code>. Do not edit by hand.</footer>
</main><script>${PAGE_JS}</script></body></html>
`;
}

// -------------------------------------------------------------------------------------- main

function main() {
  const defs = readSilhouettes();
  const rosters = readRosters();

  mkdirSync(OUT_DIR, { recursive: true });
  // A stale SVG from a figure that has since been renamed is a shape nobody is reviewing any
  // more, sitting in the directory looking exactly like one that is.
  for (const name of readdirSync(OUT_DIR)) {
    if (name.endsWith('.svg')) rmSync(join(OUT_DIR, name));
  }

  const warnings = [];
  const cards = new Map();
  const shapeUsers = new Map();
  let written = 0;

  for (const roster of rosters) {
    const tierShapes = new Map();
    for (const figure of roster.figures) {
      const def = defs.get(figure.silhouette);
      if (def === undefined) {
        warnings.push(`${roster.id}/${figure.id} uses silhouette "${figure.silhouette}", which the registry does not define`);
        cards.set(`${roster.id}/${figure.id}`, cardHtml(figure, undefined, ''));
        continue;
      }
      if (def.tiers.length > 0 && !def.tiers.includes(figure.tier)) {
        warnings.push(
          `${roster.id}/${figure.id} stages "${figure.silhouette}" on the ${figure.tier} tier, ` +
            `but the registry allows only ${def.tiers.join(', ')}`,
        );
      }
      const key = `${figure.tier}/${figure.silhouette}`;
      tierShapes.set(key, (tierShapes.get(key) ?? 0) + 1);
      shapeUsers.set(figure.silhouette, (shapeUsers.get(figure.silhouette) ?? 0) + 1);

      const svg = shapeSvg(def, figure.id);
      writeFileSync(join(OUT_DIR, `${roster.id}__${figure.id}.svg`), `${svg}\n`, 'utf8');
      written += 1;
      cards.set(`${roster.id}/${figure.id}`, cardHtml(figure, def, svg));
    }

    for (const [key, count] of tierShapes) {
      if (count > 1) {
        warnings.push(`${roster.id} draws ${count} figures with shape "${key}" - same depth, same outline`);
      }
    }
  }

  const figureCount = rosters.reduce((sum, roster) => sum + roster.figures.length, 0);
  writeFileSync(
    join(OUT_DIR, 'index.html'),
    buildPage(rosters, defs, cards, warnings, figureCount, shapeUsers),
    'utf8',
  );

  process.stdout.write(
    `silhouettes: ${written} SVG${written === 1 ? '' : 's'} from ${rosters.length} rosters ` +
      `(${defs.size} shapes) -> docs/silhouettes/index.html\n`,
  );
  for (const warning of warnings) process.stdout.write(`  warn  ${warning}\n`);

  // A missing shape means a figure the sheet cannot show, which is the one failure mode that
  // makes the whole review dishonest. Everything else is a note for the reviewer's eyes.
  const fatal = warnings.filter((w) => w.includes('registry does not define')).length;
  if (fatal > 0) process.exit(1);
}

main();
