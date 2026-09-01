#!/usr/bin/env node
/**
 * FRAME BUDGET GATE.
 *
 * `core/Quality.ts` declares, per tier, how many milliseconds each subsystem may spend in a
 * frame. Those numbers are only a contract if something refuses to let them drift, and the
 * drift that matters is not "the table adds up" - Quality.ts already self-checks that in dev.
 * The drift that matters is SLACK vanishing. A table that sums to exactly 16.6ms has budgeted
 * a machine with no garbage collector, no compositor, no OS and no thermal throttle. It will
 * miss frames on hardware that hits every single one of its own targets, and the profiler
 * will report that every subsystem is inside budget while the player watches it stutter.
 *
 * So this gate asserts two things and fails the build on either:
 *   1. the parts do not overrun the frame;
 *   2. at least MIN_SLACK_MS of the frame is left unclaimed by real work.
 *
 * WHY IT PARSES RATHER THAN IMPORTS: Quality.ts is TypeScript and Node 20 cannot load it, and
 * the alternatives (a bundler step, a duplicated JS copy of the table) either add a dependency
 * or create a second source of truth - which is the exact failure this file exists to prevent.
 * The parse is deliberately shallow and deliberately loud: it derives the tier list and the
 * category list from the file's own declarations, and it exits non-zero rather than guessing
 * if either the tier table or any category it expected is missing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUALITY_PATH = join(ROOT, 'src/core/Quality.ts');

/**
 * Last-resort headroom floor. The real number is `MIN_FRAME_SLACK_MS` in Quality.ts and is
 * parsed out of it below - Quality.ts is the single source of truth for every budget number,
 * and a second copy here is exactly the drift this gate exists to catch. This fallback only
 * applies if that export has been renamed, in which case the gate warns loudly.
 */
const FALLBACK_MIN_SLACK_MS = 2.0;

/** Floating-point dust from summing one-decimal literals. Never a real budget difference. */
const EPSILON_MS = 1e-6;

/** `msBudget.frame` is declared as 1000/targetFps, but rounded (16.6, not 16.667). */
const FRAME_ROUNDING_TOLERANCE_MS = 0.1;

// ---------------------------------------------------------------------------- source parsing

/**
 * Blanks comments while preserving every byte offset, so a match found in the masked copy
 * still points at the right line in the original.
 */
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
    // block
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

/** Index just past the `}` matching the `{` at `open`, or -1. Braces only; input is masked. */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Body of the first `<declaration> ... {` found after `anchor`, exclusive of the braces. */
function blockAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  const end = matchBrace(src, open);
  if (end < 0) return null;
  return src.slice(open + 1, end - 1);
}

function fail(message) {
  process.stderr.write(`budget: ${message}\n`);
  process.exit(1);
}

/** Tier order comes from the union declaration so the report matches the file's own order. */
function readTierNames(src) {
  const decl = /export type Tier\s*=([^;]+);/.exec(src);
  if (decl === null) fail('could not find `export type Tier` in src/core/Quality.ts');
  return [...decl[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
}

/** Category order comes from `interface MsBudget`, so adding a category cannot be forgotten. */
function readMsBudgetKeys(src) {
  const body = blockAfter(src, 'interface MsBudget');
  if (body === null) fail('could not find `interface MsBudget` in src/core/Quality.ts');
  return [...body.matchAll(/(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*number\s*;/g)].map((m) => m[1]);
}

function readNumberFields(body) {
  const found = new Map();
  for (const m of body.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*:\s*(-?\d+(?:\.\d+)?)/g)) {
    if (!found.has(m[2])) found.set(m[2], Number(m[3]));
  }
  return found;
}

function readTierTable(src, tiers, categories) {
  const table = blockAfter(src, 'const QUALITY_TABLE');
  if (table === null) fail('could not find `const QUALITY_TABLE` in src/core/Quality.ts');

  const rows = [];
  for (const tier of tiers) {
    const marker = new RegExp(`(^|[^\\w$])${tier}\\s*:\\s*\\{`, 'm');
    const hit = marker.exec(table);
    if (hit === null) fail(`QUALITY_TABLE has no entry for tier ${tier}`);
    const open = table.indexOf('{', hit.index + hit[0].length - 1);
    const end = matchBrace(table, open);
    if (end < 0) fail(`tier ${tier} has an unbalanced object literal`);
    const tierBody = table.slice(open + 1, end - 1);

    const msBody = blockAfter(tierBody, 'msBudget');
    if (msBody === null) fail(`tier ${tier} declares no msBudget`);
    const ms = readNumberFields(msBody);

    const missing = categories.filter((key) => !ms.has(key));
    if (missing.length > 0) fail(`tier ${tier} msBudget is missing ${missing.join(', ')}`);

    const fpsMatch = /(^|[^\w$.])targetFps\s*:\s*(\d+)/.exec(tierBody);
    rows.push({
      tier,
      targetFps: fpsMatch === null ? null : Number(fpsMatch[2]),
      ms,
    });
  }
  return rows;
}

// -------------------------------------------------------------------------------- evaluation

function evaluate(rows, categories, minSlackMs) {
  // `spare` is declared headroom, not work. Everything else is a claim on the frame, so slack
  // is what is left after the WORK - counting spare as work would let a tier claim headroom
  // it has already promised to something.
  const workKeys = categories.filter((key) => key !== 'frame' && key !== 'spare');

  return rows.map((row) => {
    const frame = row.ms.get('frame');
    const spare = row.ms.get('spare');
    const work = workKeys.reduce((sum, key) => sum + row.ms.get(key), 0);
    const total = work + spare;
    const slack = frame - work;

    const failures = [];
    if (total > frame + EPSILON_MS) {
      failures.push(
        `parts sum to ${total.toFixed(2)}ms, over the declared ${frame.toFixed(2)}ms frame ` +
          `by ${(total - frame).toFixed(2)}ms`,
      );
    }
    if (slack < minSlackMs - EPSILON_MS) {
      failures.push(
        `only ${slack.toFixed(2)}ms of the ${frame.toFixed(2)}ms frame is unclaimed by work, ` +
          `below the ${minSlackMs.toFixed(2)}ms minimum (raise msBudget.spare or cut a category)`,
      );
    }

    const warnings = [];
    if (row.targetFps === null) {
      warnings.push('no targetFps found, so frame/fps agreement was not checked');
    } else {
      const expected = 1000 / row.targetFps;
      if (Math.abs(frame - expected) > FRAME_ROUNDING_TOLERANCE_MS) {
        warnings.push(
          `frame ${frame.toFixed(2)}ms does not match targetFps ${row.targetFps} ` +
            `(${expected.toFixed(2)}ms)`,
        );
      }
    }

    return { ...row, frame, spare, work, total, slack, failures, warnings };
  });
}

// ------------------------------------------------------------------------------------ output

const pad = (text, width) => String(text).padStart(width);
const padEnd = (text, width) => String(text).padEnd(width);

function printTable(results, categories, minSlackMs) {
  const slackLabel = `slack (min ${minSlackMs.toFixed(1)})`;
  const labelWidth = Math.max(12, ...categories.map((k) => k.length), slackLabel.length) + 2;
  const colWidth = Math.max(10, ...results.map((r) => r.tier.length + 2));
  const rule = '-'.repeat(labelWidth + results.length * colWidth);

  const header = padEnd('', labelWidth) + results.map((r) => pad(r.tier, colWidth)).join('');
  process.stdout.write(`\nSHATTERPOINT frame budget   src/core/Quality.ts   (ms per frame)\n\n`);
  process.stdout.write(`${header}\n${rule}\n`);

  for (const key of categories) {
    if (key === 'frame' || key === 'spare') continue;
    const cells = results.map((r) => pad(r.ms.get(key).toFixed(2), colWidth)).join('');
    process.stdout.write(`${padEnd(key, labelWidth)}${cells}\n`);
  }

  process.stdout.write(`${rule}\n`);
  process.stdout.write(
    `${padEnd('work', labelWidth)}${results.map((r) => pad(r.work.toFixed(2), colWidth)).join('')}\n`,
  );
  process.stdout.write(
    `${padEnd('spare', labelWidth)}${results.map((r) => pad(r.spare.toFixed(2), colWidth)).join('')}\n`,
  );
  process.stdout.write(
    `${padEnd('total', labelWidth)}${results.map((r) => pad(r.total.toFixed(2), colWidth)).join('')}\n`,
  );
  process.stdout.write(
    `${padEnd('frame', labelWidth)}${results.map((r) => pad(r.frame.toFixed(2), colWidth)).join('')}\n`,
  );
  process.stdout.write(
    `${padEnd('fps', labelWidth)}${results.map((r) => pad(r.targetFps ?? '?', colWidth)).join('')}\n`,
  );
  process.stdout.write(`${rule}\n`);
  process.stdout.write(
    `${padEnd(slackLabel, labelWidth)}` +
      `${results.map((r) => pad(r.slack.toFixed(2), colWidth)).join('')}\n`,
  );
  process.stdout.write(
    `${padEnd('', labelWidth)}` +
      `${results.map((r) => pad(r.failures.length === 0 ? 'ok' : 'FAIL', colWidth)).join('')}\n\n`,
  );
}

function printProblems(results) {
  let failed = 0;
  for (const row of results) {
    for (const warning of row.warnings) {
      process.stdout.write(`  warn  ${row.tier}: ${warning}\n`);
    }
    for (const failure of row.failures) {
      failed += 1;
      process.stdout.write(`  FAIL  ${row.tier}: ${failure}\n`);
    }
  }
  return failed;
}

// -------------------------------------------------------------------------------------- main

/** Reads `MIN_FRAME_SLACK_MS` out of Quality.ts, so the floor has one definition. */
function readMinSlack(src) {
  const hit = /MIN_FRAME_SLACK_MS\s*:\s*Millis\s*=\s*(\d+(?:\.\d+)?)/.exec(src);
  if (hit === null) {
    process.stdout.write(
      `  warn  Quality.ts exports no MIN_FRAME_SLACK_MS; falling back to ${FALLBACK_MIN_SLACK_MS.toFixed(2)}ms\n`,
    );
    return FALLBACK_MIN_SLACK_MS;
  }
  return Number(hit[1]);
}

function parseArgs(argv) {
  let minSlackMs = null;
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    const slack = /^--min-slack=(\d+(?:\.\d+)?)$/.exec(arg);
    if (slack !== null) {
      minSlackMs = Number(slack[1]);
      continue;
    }
    fail(`unknown argument "${arg}" (accepts --min-slack=<ms>, --json)`);
  }
  return { minSlackMs, json };
}

function main() {
  const { minSlackMs: minSlackOverride, json } = parseArgs(process.argv.slice(2));

  let raw;
  try {
    raw = readFileSync(QUALITY_PATH, 'utf8');
  } catch {
    fail(`cannot read ${QUALITY_PATH}`);
    return;
  }

  const src = maskComments(raw);
  const minSlackMs = minSlackOverride ?? readMinSlack(src);
  const tiers = readTierNames(src);
  const categories = readMsBudgetKeys(src);
  if (!categories.includes('frame') || !categories.includes('spare')) {
    fail('MsBudget must declare both `frame` and `spare`');
  }

  const results = evaluate(readTierTable(src, tiers, categories), categories, minSlackMs);

  if (json) {
    const payload = results.map((r) => ({
      tier: r.tier,
      targetFps: r.targetFps,
      frame: r.frame,
      work: Number(r.work.toFixed(4)),
      spare: r.spare,
      slack: Number(r.slack.toFixed(4)),
      categories: Object.fromEntries(r.ms),
      failures: r.failures,
      warnings: r.warnings,
    }));
    process.stdout.write(`${JSON.stringify({ minSlackMs, tiers: payload }, null, 2)}\n`);
  } else {
    printTable(results, categories, minSlackMs);
  }

  const failed = printProblems(results);
  if (failed > 0) {
    process.stdout.write(
      `\n${failed} budget violation${failed === 1 ? '' : 's'}. ` +
        `A tier with no slack misses frames it has no way to account for.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`All ${results.length} tiers fit their frame with >= ${minSlackMs.toFixed(1)}ms slack.\n`);
}

main();
