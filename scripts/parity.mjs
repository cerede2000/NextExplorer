#!/usr/bin/env node
/**
 * What this fork has that upstream does not — generated, not remembered.
 *
 * The plan of nxzai#373 was closed on a route count, and a route count answers a
 * narrower question than the one it was used to answer: it sees capability that
 * arrives as a route, and not a service with no route of its own, a defect in a
 * shared value, or a screen missing for a route that did land. Three batches were
 * declared delivered while short, and nobody could see it from the outside.
 *
 * So the list is measured instead, along seven axes, and every item it finds must
 * be spoken for in `parity-manifest.json`. An item nobody has classified makes
 * this exit non-zero. That is the whole mechanism: the list cannot be forgotten,
 * because forgetting it is a failure.
 *
 * What it cannot see, stated so nobody trusts it too far: two functions with the
 * same name on both sides may still behave differently. The `drift` axis is the
 * answer — a file whose symbols match but whose body differs by more than a few
 * lines is reported for a human to read, and has to be classified like the rest.
 *
 *   node scripts/parity.mjs [--upstream origin/main] [--ours HEAD] [--json]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HERE, 'parity-manifest.json');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const UPSTREAM = flag('upstream', 'origin/main');
const OURS = flag('ours', 'HEAD');
const AS_JSON = argv.includes('--json');

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

/** A file's contents at a ref, or null when the ref does not have it. */
const show = (ref, file) => {
  try {
    return git('show', `${ref}:${file}`);
  } catch {
    return null;
  }
};

const listFiles = (ref, ...pathspecs) =>
  git('ls-tree', '-r', '--name-only', ref, '--', ...pathspecs)
    .split('\n')
    .filter(Boolean);

const findings = [];
const report = (axis, id, detail) => findings.push({ axis, id, detail });

const IS_TEST = (file) => /\.(spec|test)\.[jt]s$/.test(file) || /(^|\/)tests?\//.test(file);

// ── 1. files ────────────────────────────────────────────────────────────────
const ours = new Set(listFiles(OURS));
const theirs = new Set(listFiles(UPSTREAM));
for (const file of ours) if (!theirs.has(file)) report('file', file, 'only here');
for (const file of theirs) if (!ours.has(file)) report('file-upstream', file, 'only upstream');

// ── 2. routes ───────────────────────────────────────────────────────────────
const ROUTE = /\browter\.(get|post|put|patch|delete|all)\(\s*[`'"]([^`'"]+)/gs;
const routesOf = (ref) => {
  const found = new Set();
  for (const file of listFiles(ref, 'backend/src/routes')) {
    if (!file.endsWith('.js')) continue;
    const source = show(ref, file) || '';
    for (const [, verb, route] of source.matchAll(ROUTE)) {
      found.add(`${verb.toUpperCase()} ${route}`);
    }
  }
  return found;
};
{
  const mine = routesOf(OURS);
  const yours = routesOf(UPSTREAM);
  for (const route of mine) if (!yours.has(route)) report('route', route, 'only here');
  for (const route of yours) if (!mine.has(route)) report('route-upstream', route, 'only upstream');
}

// ── 3. symbols in files both trees have ─────────────────────────────────────
const SYMBOL =
  /^\s*(?:export\s+)?(?:const|let|async function|function|class)\s+([A-Za-z_$][\w$]*)/gm;
const symbolsOf = (source) => new Set([...source.matchAll(SYMBOL)].map((m) => m[1]));
const CODE = /\.(js|mjs|cjs|vue)$/;
for (const file of ours) {
  if (!theirs.has(file) || !CODE.test(file) || IS_TEST(file)) continue;
  if (!/^(backend|frontend)\/src\//.test(file)) continue;
  const mine = show(OURS, file);
  const yours = show(UPSTREAM, file);
  if (mine === null || yours === null || mine === yours) continue;
  const theirSymbols = symbolsOf(yours);
  for (const name of symbolsOf(mine)) {
    if (!theirSymbols.has(name)) report('symbol', `${file}:${name}`, 'only here');
  }
}

// ── 4. drift: same symbols, different body ──────────────────────────────────
// A symbol set can match while the code under it does not. Anything past the
// threshold is reported so somebody reads it; small edits are prose.
const DRIFT_LINES = 30;
{
  const numstat = git('diff', '--numstat', UPSTREAM, OURS).split('\n').filter(Boolean);
  for (const line of numstat) {
    const [added, removed, file] = line.split('\t');
    if (!file || IS_TEST(file)) continue;
    const isCode = CODE.test(file) && /^(backend|frontend)\/src\//.test(file);
    // Documentation counts: the plan's own rule is that a batch carries its
    // documentation, and a page that stayed behind is a batch that did not finish.
    const isDoc = /^docs\/.*\.md$/.test(file) || /^[A-Z_]+\.md$/.test(file);
    if (!isCode && !isDoc) continue;
    if (!theirs.has(file) || !ours.has(file)) continue;
    const changed = Number(added) + Number(removed);
    if (changed >= DRIFT_LINES)
      report(isDoc ? 'doc-drift' : 'drift', file, `${changed} lines differ`);
  }
}

// ── 5. translation keys ─────────────────────────────────────────────────────
const KEY_PATHS = (node, prefix = '') =>
  Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === 'object' ? KEY_PATHS(value, `${prefix}${key}.`) : [`${prefix}${key}`]
  );
{
  const EN = 'frontend/src/i18n/locales/en.json';
  const mine = show(OURS, EN);
  const yours = show(UPSTREAM, EN);
  if (mine && yours) {
    const theirKeys = new Set(KEY_PATHS(JSON.parse(yours)));
    for (const key of KEY_PATHS(JSON.parse(mine))) {
      if (!theirKeys.has(key)) report('i18n', key, 'only here');
    }
  }
}

// ── 6. environment variables the backend reads ──────────────────────────────
const ENV_READ = /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]{2,})\b/g;
const envOf = (ref) => {
  const found = new Set();
  for (const file of listFiles(ref, 'backend/src')) {
    if (!file.endsWith('.js')) continue;
    for (const [, name] of (show(ref, file) || '').matchAll(ENV_READ)) found.add(name);
  }
  return found;
};
{
  const mine = envOf(OURS);
  const yours = envOf(UPSTREAM);
  for (const name of mine) if (!yours.has(name)) report('env', name, 'only here');
}

// ── 7. database migrations ──────────────────────────────────────────────────
const MIGRATION = /(?:version|userVersion)\s*(?:<|===|<=)\s*(\d+)|to\s+version\s+(\d+)/gi;
const migrationsOf = (ref) => {
  const source = show(ref, 'backend/src/services/db.js') || '';
  const seen = new Set();
  for (const match of source.matchAll(MIGRATION)) {
    const n = Number(match[1] ?? match[2]);
    if (Number.isFinite(n)) seen.add(n);
  }
  return seen;
};
{
  const mine = migrationsOf(OURS);
  const yours = migrationsOf(UPSTREAM);
  const highestTheirs = Math.max(0, ...yours);
  for (const version of mine) {
    if (version > highestTheirs) report('migration', `v${version}`, 'only here');
  }
}

// ── the manifest decides ────────────────────────────────────────────────────
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { rules: [] };
const VERDICTS = ['OURS', 'SHAPE', 'PORT', 'DONE'];

const compiled = (manifest.rules || []).map((rule) => ({
  ...rule,
  test: (axis, id) =>
    (rule.axis === '*' || rule.axis === axis) &&
    (rule.exact ? id === rule.match : new RegExp(rule.match).test(id)),
}));

const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
const unclassified = [];
const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, []]));

for (const finding of findings) {
  const rule = compiled.find((r) => r.test(finding.axis, finding.id));
  if (!rule || !VERDICTS.includes(rule.verdict)) {
    unclassified.push(finding);
    continue;
  }
  counts[rule.verdict] += 1;
  byVerdict[rule.verdict].push({ ...finding, note: rule.note, batch: rule.batch });
}

if (AS_JSON) {
  console.log(JSON.stringify({ counts, unclassified, byVerdict }, null, 2));
} else {
  const axes = {};
  for (const f of findings) axes[f.axis] = (axes[f.axis] || 0) + 1;
  console.log(`${OURS} against ${UPSTREAM}\n`);
  console.log('measured');
  for (const [axis, n] of Object.entries(axes).sort()) {
    console.log(`  ${axis.padEnd(16)} ${String(n).padStart(5)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(16)} ${String(findings.length).padStart(5)}\n`);
  console.log('classified');
  for (const verdict of VERDICTS) {
    console.log(`  ${verdict.padEnd(16)} ${String(counts[verdict]).padStart(5)}`);
  }
  console.log(`  ${'unclassified'.padEnd(16)} ${String(unclassified.length).padStart(5)}\n`);

  if (byVerdict.PORT.length) {
    console.log(`still to reverse (${byVerdict.PORT.length}), by batch`);
    const batches = {};
    for (const item of byVerdict.PORT) (batches[item.batch || 'unassigned'] ||= []).push(item);
    for (const [batch, items] of Object.entries(batches).sort()) {
      console.log(`\n  ${batch}  —  ${items[0].note || ''}`);
      for (const item of items.slice(0, 6)) console.log(`      ${item.axis}: ${item.id}`);
      if (items.length > 6) console.log(`      … and ${items.length - 6} more`);
    }
    console.log('');
  }

  if (unclassified.length) {
    console.log(`UNCLASSIFIED — every one of these must be given a verdict:\n`);
    for (const f of unclassified.slice(0, 60)) console.log(`  ${f.axis.padEnd(15)} ${f.id}`);
    if (unclassified.length > 60) console.log(`  … and ${unclassified.length - 60} more`);
    console.log('');
  }
}

if (unclassified.length) {
  console.error(
    `${unclassified.length} finding(s) nobody has classified. Add a rule to ` +
      'scripts/parity-manifest.json — OURS, SHAPE, PORT or DONE — with the reason.'
  );
  process.exit(1);
}
// Not on stdout under --json: the output there is the document, nothing else.
const closing = byVerdict.PORT.length
  ? `${byVerdict.PORT.length} item(s) still to reverse.`
  : 'Nothing left to reverse: every finding is OURS, SHAPE or DONE.';
if (AS_JSON) console.error(closing);
else console.log(closing);
