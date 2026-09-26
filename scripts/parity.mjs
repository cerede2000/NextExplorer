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
/**
 * Every finding, and every file it speaks for.
 *
 * The second part is what makes the coverage check at the end possible: a file
 * that differs between the two trees and that no axis spoke for is itself a
 * finding. Without that, an axis nobody thought to write is an axis nobody
 * notices is missing — which is how 190 files, the lockfile and the Dockerfile
 * among them, sat outside the first version of this.
 */
const covered = new Set();
const report = (axis, id, detail, file = null) => {
  findings.push({ axis, id, detail });
  if (file) covered.add(file);
};

const IS_TEST = (file) => /\.(spec|test)\.[jt]s$/.test(file) || /(^|\/)tests?\//.test(file);

// ── 1. files ────────────────────────────────────────────────────────────────
const ours = new Set(listFiles(OURS));
const theirs = new Set(listFiles(UPSTREAM));
for (const file of ours) if (!theirs.has(file)) report('file', file, 'only here', file);
for (const file of theirs)
  if (!ours.has(file)) report('file-upstream', file, 'only upstream', file);

// ── 2. routes ───────────────────────────────────────────────────────────────
const ROUTE = /\browter\.(get|post|put|patch|delete|all)\(\s*[`'"]([^`'"]+)/gs;
const routesOf = (ref) => {
  const found = new Map();
  for (const file of listFiles(ref, 'backend/src/routes')) {
    if (!file.endsWith('.js')) continue;
    const source = show(ref, file) || '';
    for (const [, verb, route] of source.matchAll(ROUTE)) {
      found.set(`${verb.toUpperCase()} ${route}`, file);
    }
  }
  return found;
};
{
  const mine = routesOf(OURS);
  const yours = routesOf(UPSTREAM);
  for (const [route, file] of mine) {
    if (!yours.has(route)) report('route', route, 'only here', file);
  }
  for (const [route, file] of yours) {
    if (!mine.has(route)) report('route-upstream', route, 'only upstream', file);
  }
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
    if (!theirSymbols.has(name)) report('symbol', `${file}:${name}`, 'only here', file);
  }
}

// ── 4. drift: same symbols, different body ──────────────────────────────────
// A symbol set can match while the code under it does not, so every file that
// differs at all is reported. There was a threshold of thirty lines here, on the
// grounds that smaller edits are prose — and 93 files sat under it, unseen. A
// threshold is a guess about which differences matter, and this instrument exists
// because guesses about that were wrong.
const DRIFT_LINES = 1;
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
    if (changed >= DRIFT_LINES) {
      report(isDoc ? 'doc-drift' : 'drift', file, `${changed} lines differ`, file);
    }
  }
}

// ── 5. translation keys ─────────────────────────────────────────────────────
const KEY_PATHS = (node, prefix = '') =>
  Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === 'object' ? KEY_PATHS(value, `${prefix}${key}.`) : [`${prefix}${key}`]
  );
// Every catalogue, not only English: a string this fork translated and upstream
// never received is a reader seeing the wrong language, and the English file alone
// says nothing about it. One finding per key, naming the catalogues that lack it,
// because fifteen findings for one key is fifteen times the noise and no more
// information.
{
  const lacking = new Map();
  for (const file of listFiles(OURS, 'frontend/src/i18n/locales')) {
    if (!file.endsWith('.json')) continue;
    const mine = show(OURS, file);
    const yours = show(UPSTREAM, file);
    if (!mine) continue;
    const locale = path.basename(file, '.json');
    covered.add(file);
    if (!yours) {
      report('i18n', `the ${locale} catalogue`, 'only here', file);
      continue;
    }
    const theirKeys = new Set(KEY_PATHS(JSON.parse(yours)));
    for (const key of KEY_PATHS(JSON.parse(mine))) {
      if (!theirKeys.has(key)) {
        if (!lacking.has(key)) lacking.set(key, []);
        lacking.get(key).push(locale);
      }
    }
  }
  for (const [key, locales] of lacking) {
    report('i18n', key, `missing from ${locales.length} catalogue(s): ${locales.join(', ')}`);
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

// ── 8. dependencies ────────────────────────────────────────────────────────
// A package this fork installs and upstream does not is a feature that cannot run
// there, and nothing above would have said so.
for (const manifestFile of ['package.json', 'backend/package.json', 'frontend/package.json']) {
  const mine = show(OURS, manifestFile);
  const yours = show(UPSTREAM, manifestFile);
  if (!mine) continue;
  if (!yours) {
    report('deps', manifestFile, 'only here', manifestFile);
    continue;
  }
  const readDeps = (raw) => {
    const parsed = JSON.parse(raw);
    return { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
  };
  const ourDeps = readDeps(mine);
  const theirDeps = readDeps(yours);
  for (const [name, range] of Object.entries(ourDeps)) {
    if (!(name in theirDeps)) {
      report('deps', `${manifestFile}: ${name}`, `only here (${range})`, manifestFile);
    } else if (theirDeps[name] !== range) {
      report(
        'deps',
        `${manifestFile}: ${name}`,
        `${theirDeps[name]} upstream, ${range} here`,
        manifestFile
      );
    }
  }
}
// The lockfile is not read package by package: it follows whatever the manifests
// above resolve to, and a batch that changes a dependency regenerates it.
covered.add('package-lock.json');
covered.add('backend/package-lock.json');
covered.add('frontend/package-lock.json');

// ── 9. how the image is built ──────────────────────────────────────────────
// Everything a batch may need installed, and nothing above looks at any of it.
const IMAGE_FILES = [
  'Dockerfile',
  'Dockerfile.dev',
  '.dockerignore',
  'docker-compose.yml',
  'docker-compose.dev.yml',
  'docker/entrypoint.sh',
];
for (const file of IMAGE_FILES) {
  const mine = show(OURS, file);
  const yours = show(UPSTREAM, file);
  if (!mine) continue;
  if (!yours) {
    report('image', file, 'only here', file);
  } else if (mine !== yours) {
    const mineLines = mine.split('\n').length;
    const yoursLines = yours.split('\n').length;
    report('image', file, `differs (${yoursLines} lines upstream, ${mineLines} here)`, file);
  }
}

// ── 10. the coverage of everything above ───────────────────────────────────
// The axis that makes a missing axis visible. Anything that differs and that no
// finding spoke for is reported as such, and has to be classified like the rest —
// so the honest answer to "is that everything?" is this number being zero.
for (const file of git('diff', '--name-only', UPSTREAM, OURS).split('\n').filter(Boolean)) {
  if (!covered.has(file)) {
    report('uncovered', file, 'differs, and no other axis speaks for it', file);
  }
}

// ── the completeness proof ──────────────────────────────────────────────────
/**
 * Every path in either tree is either identical in both, or spoken for.
 *
 * The axes above each answer one question, and a question nobody asked is a gap
 * nobody sees. This asks the only question that cannot have a gap: of all the
 * paths that exist in either tree, how many are neither identical nor named by a
 * finding? The answer has to be zero, and it is checked rather than asserted.
 *
 * It is what makes "the breakdown is complete" a statement about the trees rather
 * than about how carefully somebody looked.
 */
const completeness = (() => {
  const everyPath = new Set([...ours, ...theirs]);
  const differing = new Set(git('diff', '--name-only', UPSTREAM, OURS).split('\n').filter(Boolean));
  const identical = [...everyPath].filter((file) => !differing.has(file));
  const unspokenFor = [...differing].filter((file) => !covered.has(file));
  return {
    paths: everyPath.size,
    identical: identical.length,
    differing: differing.size,
    unspokenFor,
  };
})();

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

/**
 * Whether each batch can be merged on its own and still build.
 *
 * A batch that changes a file which imports a file only this fork has, brought by
 * a later batch, does not build when it lands: the import resolves to nothing. That
 * is not a thing to notice at review time — it is arithmetic over the import graph,
 * so it is done here.
 *
 * Only files this fork alone has matter. A file upstream already has resolves
 * whatever its content, so a batch may well touch it out of order.
 */
const ownerOf = new Map();
for (const verdict of ['PORT', 'DONE']) {
  for (const item of byVerdict[verdict]) {
    const file = item.id.split(':')[0];
    const batch = verdict === 'DONE' ? 'P3-00' : item.batch;
    if (!batch || !/^P3-\d+$/.test(batch)) continue;
    const previous = ownerOf.get(file);
    // The earliest batch that claims a file is the one that brings it.
    if (!previous || Number(batch.slice(3)) < Number(previous.slice(3))) ownerOf.set(file, batch);
  }
}

/**
 * Files two batches both claim.
 *
 * A file that holds two subjects — `routes/settings.js` holds the logo and the
 * folder preferences — is claimed by whichever rule matched first, and the other
 * batch then ships a service nothing calls, or a screen with no route behind it.
 * Green, and useless. So they are reported: either the batches merge, or the
 * findings inside the file are assigned one by one.
 */
const claimsOn = new Map();
for (const item of byVerdict.PORT) {
  const file = item.id.split(':')[0];
  if (!item.batch || !/^P3-\d+$/.test(item.batch)) continue;
  if (!claimsOn.has(file)) claimsOn.set(file, new Set());
  claimsOn.get(file).add(item.batch);
}
const shared = [...claimsOn]
  .filter(([, batches]) => batches.size > 1)
  .map(([file, batches]) => `${file}: ${[...batches].sort().join(', ')}`);

const onlyHere = new Set([...ours].filter((file) => !theirs.has(file)));
const IMPORT = /(?:require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"])/g;

/** What an import specifier points at, as a path in the tree, or null. */
const resolveImport = (fromFile, specifier) => {
  let base;
  if (specifier.startsWith('@/')) base = `frontend/src/${specifier.slice(2)}`;
  else if (specifier.startsWith('.'))
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  else return null; // a package, not a file of ours
  for (const candidate of [base, `${base}.js`, `${base}.vue`, `${base}.mjs`, `${base}/index.js`]) {
    if (ours.has(candidate)) return candidate;
  }
  return null;
};

const outOfOrder = [];
/** batch → the batches it needs, because a file it changes imports a file of theirs. */
const needs = new Map();
// Only files one batch owns outright. A file two batches share is ported in parts
// — the logo's routes with the logo, the switches' section with the switches — so
// each batch adds the import it needs and no cross-batch order follows. Which is a
// discipline rather than a proof, and the shared-file list above is where it
// applies: four files, three of them package manifests.
for (const [file, claimants] of claimsOn) {
  if (claimants.size > 1) continue;
  if (!CODE.test(file)) continue;
  const source = show(OURS, file);
  if (!source) continue;
  for (const match of source.matchAll(IMPORT)) {
    const target = resolveImport(file, match[1] || match[2]);
    if (!target || !onlyHere.has(target)) continue;
    const targetBatch = ownerOf.get(target);
    if (!targetBatch) continue;
    for (const batch of claimants) {
      if (targetBatch === batch) continue;
      if (!needs.has(batch)) needs.set(batch, new Set());
      needs.get(batch).add(targetBatch);
      if (Number(targetBatch.slice(3)) > Number(batch.slice(3))) {
        outOfOrder.push(`${batch} ${file} imports ${target}, which ${targetBatch} brings`);
      }
    }
  }
}

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        counts,
        unclassified,
        byVerdict,
        completeness,
        outOfOrder,
        shared,
        needs: Object.fromEntries([...needs].map(([k, v]) => [k, [...v]])),
      },
      null,
      2
    )
  );
} else {
  const axes = {};
  for (const f of findings) axes[f.axis] = (axes[f.axis] || 0) + 1;
  console.log(`${OURS} against ${UPSTREAM}\n`);
  console.log('measured');
  for (const [axis, n] of Object.entries(axes).sort()) {
    console.log(`  ${axis.padEnd(16)} ${String(n).padStart(5)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(16)} ${String(findings.length).padStart(5)}\n`);
  console.log('every path in either tree');
  console.log(`  ${'identical'.padEnd(16)} ${String(completeness.identical).padStart(5)}`);
  console.log(`  ${'differing'.padEnd(16)} ${String(completeness.differing).padStart(5)}`);
  console.log(
    `  ${'unspoken for'.padEnd(16)} ${String(completeness.unspokenFor.length).padStart(5)}` +
      (completeness.unspokenFor.length ? '   ← a gap in the axes themselves' : '')
  );
  console.log(`  ${'TOTAL'.padEnd(16)} ${String(completeness.paths).padStart(5)}\n`);
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

  console.log(
    `shared files       ${shared.length ? `${shared.length} file(s) two batches share, each bringing its own part` : 'every file has one owner'}`
  );
  for (const line of shared.slice(0, 12)) console.log(`  ${line}`);
  if (shared.length) console.log('');
  console.log(
    `build order        ${outOfOrder.length ? `${outOfOrder.length} batch(es) would not build in this order` : 'every batch builds where it sits'}\n`
  );
  for (const line of outOfOrder.slice(0, 20)) console.log(`  ${line}`);
  if (outOfOrder.length) console.log('');

  if (unclassified.length) {
    console.log(`UNCLASSIFIED — every one of these must be given a verdict:\n`);
    for (const f of unclassified.slice(0, 60)) console.log(`  ${f.axis.padEnd(15)} ${f.id}`);
    if (unclassified.length > 60) console.log(`  … and ${unclassified.length - 60} more`);
    console.log('');
  }
}

if (outOfOrder.length) {
  console.error(
    `${outOfOrder.length} batch(es) would not build where they sit: a file they change imports ` +
      'a file only this fork has that a later batch brings. Move the batch, or move the file.'
  );
  process.exit(1);
}
if (completeness.unspokenFor.length) {
  console.error(
    `${completeness.unspokenFor.length} path(s) differ and no axis speaks for them, ` +
      'which is a gap in this script rather than in the manifest:\n  ' +
      completeness.unspokenFor.slice(0, 20).join('\n  ')
  );
  process.exit(1);
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
