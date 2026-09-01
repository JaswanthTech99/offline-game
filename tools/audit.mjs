#!/usr/bin/env node
/**
 * CONTRACT AUDIT over src/.
 *
 * SHATTERPOINT has a short list of rules that are not style preferences - each one exists
 * because breaking it produces a bug that does not look like a bug:
 *
 *   bare `three`        drags in the WebGL renderer beside the WebGPU one; TSL nodes stop
 *                       resolving and the failure surfaces as a blank canvas, not an error.
 *   `any` / @ts-ignore  removes the only mechanism that keeps eighty modules agreeing.
 *   loose hex colours   a universe theme is a palette you can swap; a colour baked into a
 *                       gameplay module is a theme that silently does not apply.
 *   a second rAF        two clocks means physics stepped twice per frame on some machines
 *                       and once on others, which reads to a player as "the game is heavy".
 *   Math.random/Date.now a run stops being reproducible from its seed, and every replay,
 *                       every deterministic test and every bug report becomes anecdotal.
 *   a stray budget number  a tier that silently does not exist: the literal wins on every
 *                       device and Quality.ts stops being the single source of truth.
 *
 * ESLint enforces the first two and half of the fourth. The rest are not expressible as lint
 * rules, and a rule nothing enforces is a comment. This is a STATIC auditor - it reads source
 * text, never a running page - so it costs a second and can gate every commit.
 *
 * FALSE POSITIVES ARE THE ENEMY. An audit people learn to ignore is worse than none, so every
 * rule below runs against a masked view of the file where comments (and, where it matters,
 * string bodies) have been blanked out with their byte offsets preserved. A rule that cannot
 * be stated precisely is stated narrowly instead - see BUDGET_GENERIC_KEYS for the one place
 * that trade-off is visible.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** The one file allowed to own the frame loop. */
const ENGINE_FILE = 'src/core/Engine.ts';

/** The one file allowed to declare a budget number. */
const QUALITY_FILE = 'src/core/Quality.ts';

/** Colour belongs to a theme or to the stylesheet layer, nowhere else. */
const COLOUR_HOMES = ['src/universe/themes/', 'src/styles/'];

/**
 * The one file allowed to read the wall clock. Save records need real timestamps to be
 * sorted, expired and migrated; the simulation needs never to see one. Centralising the read
 * behind an injectable `WallClock` is what keeps those two facts from fighting.
 */
const WALL_CLOCK_FILE = 'src/save/WallClock.ts';

/**
 * MsBudget and PrewarmCounts are made of ordinary English words - `frame`, `render`, `post`,
 * `balls` - that legitimately name unrelated things all over the codebase. Matching them one
 * at a time would bury the report in noise, so they are excluded from the per-key rule and
 * caught structurally instead: a RESTATED BUDGET TABLE is several of them together, which is
 * what BUDGET_CLUSTER_MIN looks for.
 */
const BUDGET_GENERIC_KEYS = new Set([
  'frame', 'physics', 'shatter', 'culling', 'corridor', 'battle', 'render', 'post', 'audio',
  'ui', 'spare', 'shards', 'motes', 'particles', 'balls', 'decals', 'tier',
]);

/** Distinct generic budget keys within BUDGET_CLUSTER_LINES of each other to count as a table. */
const BUDGET_CLUSTER_MIN = 4;
const BUDGET_CLUSTER_LINES = 15;

/** How much of the offending line to echo. Long enough to recognise, short enough to scan. */
const SNIPPET_CHARS = 96;

// ------------------------------------------------------------------------------------ masking

/**
 * Blanks comments - and optionally string bodies - while preserving every byte offset, so a
 * match in the masked view still reports the right line and column of the real file.
 *
 * Template interpolations are deliberately NOT blanked: `${Math.random()}` is code that
 * happens to live inside a string, and it breaks determinism exactly as much as any other
 * call would.
 */
function mask(src, { blankStrings, css }) {
  const out = src.split('');
  const hide = (i) => {
    if (src[i] !== '\n' && src[i] !== undefined) out[i] = ' ';
  };

  let mode = 'code';
  let quote = '';
  const interpolation = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];

    if (mode === 'code') {
      if (!css && c === '/' && d === '/') {
        hide(i);
        hide(i + 1);
        mode = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        hide(i);
        hide(i + 1);
        mode = 'block';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        mode = 'quote';
        i += 1;
        continue;
      }
      if (c === '`') {
        mode = 'template';
        i += 1;
        continue;
      }
      if (interpolation.length > 0) {
        if (c === '{') interpolation[interpolation.length - 1] += 1;
        else if (c === '}') {
          interpolation[interpolation.length - 1] -= 1;
          if (interpolation[interpolation.length - 1] === 0) {
            interpolation.pop();
            mode = 'template';
            i += 1;
            continue;
          }
        }
      }
      i += 1;
      continue;
    }

    if (mode === 'line') {
      if (c === '\n') mode = 'code';
      else hide(i);
      i += 1;
      continue;
    }

    if (mode === 'block') {
      if (c === '*' && d === '/') {
        hide(i);
        hide(i + 1);
        mode = 'code';
        i += 2;
        continue;
      }
      hide(i);
      i += 1;
      continue;
    }

    if (mode === 'quote') {
      if (c === '\\') {
        if (blankStrings) {
          hide(i);
          hide(i + 1);
        }
        i += 2;
        continue;
      }
      if (c === quote || c === '\n') {
        mode = 'code';
        i += 1;
        continue;
      }
      if (blankStrings) hide(i);
      i += 1;
      continue;
    }

    // template literal
    if (c === '\\') {
      if (blankStrings) {
        hide(i);
        hide(i + 1);
      }
      i += 2;
      continue;
    }
    if (c === '`') {
      mode = 'code';
      i += 1;
      continue;
    }
    if (c === '$' && d === '{') {
      interpolation.push(1);
      mode = 'code';
      i += 2;
      continue;
    }
    if (blankStrings) hide(i);
    i += 1;
  }

  return out.join('');
}

// ------------------------------------------------------------------------------- file loading

function walk(dir, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function locate(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

function loadFiles() {
  return walk(SRC)
    .filter((path) => path.endsWith('.ts') || path.endsWith('.css'))
    .map((path) => {
      const raw = readFileSync(path, 'utf8');
      const css = path.endsWith('.css');
      return {
        path: relative(ROOT, path).split(sep).join('/'),
        css,
        raw,
        starts: lineIndex(raw),
        noComments: mask(raw, { blankStrings: false, css }),
        code: mask(raw, { blankStrings: true, css }),
      };
    });
}

// ---------------------------------------------------------------------------- budget vocabulary

/**
 * The budget rule derives its vocabulary from Quality.ts itself. Hard-coding the key list here
 * would create a second place to update when a budget gains a field - which is precisely the
 * duplication the rule exists to prevent.
 */
function readBudgetKeys(files) {
  const quality = files.find((file) => file.path === QUALITY_FILE);
  if (quality === undefined) {
    process.stderr.write(`audit: ${QUALITY_FILE} is missing - the budget rule cannot be enforced\n`);
    process.exit(1);
  }

  const src = quality.noComments;
  const interfaces = ['MsBudget', 'PrewarmCounts', 'PostIntensity', 'QualityBudget', 'MotionRules'];
  const keys = new Set();

  for (const name of interfaces) {
    const at = src.indexOf(`interface ${name}`);
    if (at < 0) continue;
    const open = src.indexOf('{', at);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    for (const m of src.slice(open, end).matchAll(/(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:/g)) {
      keys.add(m[1]);
    }
  }

  if (keys.size === 0) {
    process.stderr.write(`audit: parsed no budget keys out of ${QUALITY_FILE} - has it been restructured?\n`);
    process.exit(1);
  }

  return {
    distinctive: [...keys].filter((key) => !BUDGET_GENERIC_KEYS.has(key)).sort(),
    generic: [...keys].filter((key) => BUDGET_GENERIC_KEYS.has(key)).sort(),
  };
}

// ------------------------------------------------------------------------------------- rules

/**
 * `anchor` picks which character inside the match the report should point at. It defaults to
 * the first non-space one, because several patterns have to swallow leading punctuation or a
 * newline to establish context and a column that lands on that noise is a column nobody trusts.
 */
const scanRegex = (file, view, regex, make, anchor = (text) => text.length - text.trimStart().length) => {
  const found = [];
  for (const m of view.matchAll(regex)) {
    const at = locate(file.starts, m.index + anchor(m[0]));
    found.push({ ...at, text: make(m) });
  }
  return found;
};

const lineText = (file, line) => {
  const start = file.starts[line - 1] ?? 0;
  const end = file.starts[line] ?? file.raw.length;
  const text = file.raw.slice(start, end).trim();
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
};

function ruleThreeImport(file) {
  if (file.css) return [];
  const bare = /(?:from|import|require)\s*\(?\s*(['"])(three(?:\/(?:src|build)\/[^'"]*)?)\1/g;
  return scanRegex(file, file.noComments, bare, (m) => `imports "${m[2]}"`);
}

function ruleExplicitAny(file) {
  if (file.css) return [];
  return scanRegex(file, file.code, /\bany\b/g, () => 'the `any` type');
}

/**
 * Anchored the way tsc anchors it: a directive only suppresses when it OPENS the comment.
 * Scanned against the raw text rather than a masked view, because a suppression lives in a
 * comment by definition - and anchoring is what keeps prose that merely names the directive
 * (a rule doc, this file's own header) out of the report.
 */
function ruleTsSuppression(file) {
  if (file.css) return [];
  const directive = /(?:^|\n)[ \t]*(?:\/\/+|\/\*+|\*)[ \t]*@ts-(?:ignore|expect-error|nocheck)/g;
  return scanRegex(
    file,
    file.raw,
    directive,
    (m) => m[0].trim().replace(/^[/*\s]+/, ''),
    (text) => text.indexOf('@'),
  );
}

/**
 * `#rgb`, `#rrggbb` and their alpha forms, plus the six-digit `0x` form three uses. An eight
 * digit `0x` value is a hash, a mask or a seed - never a colour - so the digit count is what
 * separates `0x9aa3ab` from `0x9e3779b9` without a stoplist of magic numbers.
 */
function ruleHexColour(file) {
  if (COLOUR_HOMES.some((home) => file.path.startsWith(home))) return [];
  const hash = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F\w])/g;
  const hex = /\b0x[0-9a-fA-F]{6}(?![0-9a-fA-F])/g;
  return [
    ...scanRegex(file, file.noComments, hash, (m) => `colour literal ${m[0]}`),
    ...scanRegex(file, file.noComments, hex, (m) => `colour literal ${m[0]}`),
  ];
}

function ruleFrameLoop(file) {
  if (file.css || file.path === ENGINE_FILE) return [];
  return scanRegex(file, file.noComments, /\b(?:request|cancel)AnimationFrame\b/g, (m) => `${m[0]}()`);
}

function ruleNondeterminism(file) {
  if (file.css || file.path === WALL_CLOCK_FILE) return [];
  return scanRegex(
    file,
    file.code,
    // `new Date(ms)` is deterministic; only the no-argument form reads the wall clock.
    /\bMath\.random\s*\(|\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)/g,
    (m) => `${m[0].replace(/\s+/g, ' ').replace(/\(\s*\)?$/, '')}()`,
  );
}

/**
 * Two shapes of the same violation: one budget key restated on its own, and a whole budget
 * table copied into another module. `x.renderScale = 0.8` is excluded by the lookbehind on
 * `.` because writing to a resolved budget object is reading Quality, not duplicating it.
 */
function ruleBudgetLiteral(file, budgetKeys) {
  if (file.css || file.path === QUALITY_FILE) return [];
  const found = [];

  for (const key of budgetKeys.distinctive) {
    const literal = new RegExp(`(?<![\\w$.])${key}\\s*:\\s*-?\\d`, 'g');
    const declared = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${key}\\s*(?::[^=;]+)?=\\s*-?\\d`, 'g');
    found.push(
      ...scanRegex(file, file.code, literal, () => `budget key \`${key}\` given a literal here, not imported from Quality`),
      ...scanRegex(file, file.code, declared, () => `budget key \`${key}\` redeclared as a local constant`),
    );
  }

  const hits = [];
  for (const key of budgetKeys.generic) {
    const literal = new RegExp(`(?<![\\w$.])${key}\\s*:\\s*-?\\d`, 'g');
    for (const hit of scanRegex(file, file.code, literal, () => key)) {
      hits.push({ line: hit.line, key });
    }
  }
  hits.sort((a, b) => a.line - b.line);

  for (let i = 0; i < hits.length; i += 1) {
    const window = new Set();
    for (let j = i; j < hits.length && hits[j].line - hits[i].line <= BUDGET_CLUSTER_LINES; j += 1) {
      window.add(hits[j].key);
    }
    if (window.size >= BUDGET_CLUSTER_MIN) {
      found.push({
        line: hits[i].line,
        column: 1,
        text: `a budget table restated here (${[...window].join(', ')}) - import it from Quality`,
      });
      break;
    }
  }

  return found;
}

const RULES = [
  {
    id: 'bare-three-import',
    why: 'bare `three` loads the WebGL renderer alongside WebGPU; import three/webgpu, three/tsl or three/addons/*.',
    run: ruleThreeImport,
  },
  {
    id: 'explicit-any',
    why: '`any` switches off the one mechanism keeping eighty modules agreeing on a shape.',
    run: ruleExplicitAny,
  },
  {
    id: 'ts-suppression',
    why: 'a suppressed error is an error that ships. Fix the type or widen the contract.',
    run: ruleTsSuppression,
  },
  {
    id: 'hex-colour-literal',
    why: `colour lives in src/universe/themes/ and src/styles/; anywhere else it is a theme that never applies.`,
    run: ruleHexColour,
  },
  {
    id: 'second-frame-loop',
    why: `exactly one requestAnimationFrame exists, in ${ENGINE_FILE}. Subscribe to it instead.`,
    run: ruleFrameLoop,
  },
  {
    id: 'nondeterminism',
    why: `a run must replay from its seed. Draw from Rng, take frame time from the fixed-step clock, and take wall time by injecting the WallClock from ${WALL_CLOCK_FILE}.`,
    run: ruleNondeterminism,
  },
  {
    id: 'budget-literal',
    why: `every count, cap, resolution and millisecond allowance lives in ${QUALITY_FILE}. Import it.`,
    run: ruleBudgetLiteral,
  },
];

// ------------------------------------------------------------------------------------- output

function main() {
  const json = process.argv.includes('--json');
  const files = loadFiles();
  if (files.length === 0) {
    process.stderr.write('audit: found no source files under src/\n');
    process.exit(1);
  }

  const budgetKeys = readBudgetKeys(files);
  const report = RULES.map((rule) => {
    const findings = [];
    for (const file of files) {
      for (const hit of rule.run(file, budgetKeys)) {
        findings.push({ file: file.path, line: hit.line, column: hit.column, text: hit.text, source: lineText(file, hit.line) });
      }
    }
    findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
    return { id: rule.id, why: rule.why, findings };
  });

  const total = report.reduce((sum, rule) => sum + rule.findings.length, 0);

  if (json) {
    process.stdout.write(`${JSON.stringify({ scanned: files.length, total, rules: report }, null, 2)}\n`);
    process.exit(total === 0 ? 0 : 1);
  }

  const width = Math.max(...RULES.map((rule) => rule.id.length)) + 2;
  process.stdout.write(`\nSHATTERPOINT source audit   ${files.length} files under src/\n\n`);
  for (const rule of report) {
    const count = rule.findings.length;
    const mark = count === 0 ? 'pass' : `FAIL  ${count}`;
    process.stdout.write(`  ${rule.id.padEnd(width)}${mark}\n`);
  }

  for (const rule of report) {
    if (rule.findings.length === 0) continue;
    process.stdout.write(`\n${rule.id}  (${rule.findings.length})\n  ${rule.why}\n\n`);
    let lastFile = '';
    for (const finding of rule.findings) {
      if (finding.file !== lastFile) {
        process.stdout.write(`  ${finding.file}\n`);
        lastFile = finding.file;
      }
      process.stdout.write(`    ${String(finding.line).padStart(5)}:${String(finding.column).padEnd(4)} ${finding.text}\n`);
      process.stdout.write(`          ${finding.source}\n`);
    }
  }

  if (total > 0) {
    process.stdout.write(`\n${total} contract violation${total === 1 ? '' : 's'}. These are only rules if this exits 1.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nClean. ${RULES.length} contracts hold across ${files.length} files.\n`);
}

main();
