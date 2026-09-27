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

// ── 5b. what the catalogues say ─────────────────────────────────────────────
// The axis above compares the keys and stops there, and a key both sides have is
// a key nobody reads again. Six hundred and fifty-six values differed under
// matching keys, and for four hundred and sixty-seven of them upstream still held
// the English sentence where this fork holds the translation: a German, Swedish
// or Polish reader upstream was looking at English in the settings screens, and
// no count said so. A key is a place for a sentence; the sentence is the feature.
const FLAT = (node, prefix = '') =>
  Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? FLAT(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value]]
  );
{
  const differing = new Map();
  const english = (() => {
    const text = show(UPSTREAM, 'frontend/src/i18n/locales/en.json');
    return text ? new Map(FLAT(JSON.parse(text))) : new Map();
  })();
  for (const file of listFiles(OURS, 'frontend/src/i18n/locales')) {
    if (!file.endsWith('.json')) continue;
    const mine = show(OURS, file);
    const yours = show(UPSTREAM, file);
    if (!mine || !yours) continue;
    const locale = path.basename(file, '.json');
    const theirs = new Map(FLAT(JSON.parse(yours)));
    for (const [key, value] of FLAT(JSON.parse(mine))) {
      if (!theirs.has(key) || theirs.get(key) === value) continue;
      if (!differing.has(key)) differing.set(key, { locales: [], untranslated: 0 });
      const entry = differing.get(key);
      entry.locales.push(locale);
      // Upstream holding the English sentence in a catalogue that is not English
      // is the worst of the two cases, and worth counting apart.
      if (locale !== 'en' && theirs.get(key) === english.get(key)) entry.untranslated += 1;
    }
  }
  for (const [key, { locales, untranslated }] of differing) {
    report(
      'i18n-value',
      key,
      `says something else in ${locales.length} catalogue(s): ${locales.join(', ')}` +
        (untranslated ? ` — still English upstream in ${untranslated} of them` : '')
    );
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

// ── 7. the schema itself, not the number stamped on it ──────────────────────
// Version numbers diverged long ago: this fork is at 24 where upstream is at 19, and
// the same feature carries a different number in each. Comparing numbers said five
// migrations were missing that upstream has had for months under other names —
// two-factor as `totp_credentials`, the activity log as `activity_events` — and said
// nothing about the one table that really was missing. So what is compared is what a
// migration leaves behind: the tables, and the columns added to a table that exists.
const TABLE = /CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi;
const ADDED_COLUMN = /addColumnIfMissing\(\s*db\s*,\s*'([a-z_]+)'\s*,\s*'([a-z_]+)/gi;
const schemaOf = (ref) => {
  // Every file that holds DDL, not db.js alone: the index and the search store keep
  // their own tables, and a table defined there is a table the schema has.
  const found = new Set();
  for (const file of listFiles(ref, 'backend/src')) {
    if (!file.endsWith('.js')) continue;
    const source = show(ref, file) || '';
    for (const [, name] of source.matchAll(TABLE)) found.add(name);
    for (const [, table, column] of source.matchAll(ADDED_COLUMN)) found.add(`${table}.${column}`);
  }
  return found;
};
{
  const mine = schemaOf(OURS);
  const yours = schemaOf(UPSTREAM);
  for (const name of [...mine].sort()) {
    if (!yours.has(name)) {
      report('migration', name, name.includes('.') ? 'column only here' : 'table only here');
    }
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
// THEIRS is the verdict the first version of this could not express: upstream's
// version of a shared file is the newer one, and the fork is what has to move. It was
// found on `betterSqliteSessionStore.js`, where upstream opens the session database
// lazily and this fork still opens it when the module is required — so porting "ours"
// over it would have broken the one check upstream's CI runs.
const VERDICTS = ['OURS', 'THEIRS', 'SHAPE', 'PORT', 'DONE'];

const compiled = (manifest.rules || []).map((rule) => ({
  ...rule,
  test: (axis, id) =>
    (rule.axis === '*' || rule.axis === axis) &&
    (rule.exact ? id === rule.match : new RegExp(rule.match).test(id)),
}));

// ── the residue a batch left behind ─────────────────────────────────────────
// A verdict on a file is not a verdict on its contents. A file a batch sent is
// marked DONE and nothing looks inside it again — and eleven of them did not
// match upstream afterwards: upstream had moved on, or the batch wrote something
// better than what it took and this fork never got it back. Neither direction
// showed up anywhere, because both sides were spoken for.
//
// The comparison is against the tip of the batch stack, not against `main`: a
// batch still waiting in a pull request has not reached `main`, so measuring
// there would call every file it carries a residue. Without such a ref the gate
// says so and passes, rather than pretending to have looked.
//
// Comments and blank lines are set aside — Prettier and a rewritten sentence
// change those without changing what runs — and lines are compared as multisets,
// so a moved import is not a difference either. What is left has to be spoken
// for under `residue` in the manifest, with the reason it may stand.
const refExists = (ref) => {
  if (!ref) return false;
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
};
const BATCHES = (() => {
  const asked = flag('batches', null);
  if (asked) return refExists(asked) ? asked : null;
  return refExists(manifest.batchTip) ? manifest.batchTip : null;
})();

const RUNNING_LINES = (text) =>
  (text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith('//') &&
        !line.startsWith('*') &&
        !line.startsWith('/*') &&
        line !== '*/' &&
        !line.startsWith('<!--') &&
        !line.startsWith('-->')
    )
    .sort();

const residue = [];
const residueRules = (manifest.residue || []).map((entry) => ({
  ...entry,
  test: (id) => new RegExp(entry.match).test(id),
}));
if (BATCHES) {
  const differing = git('diff', '--name-only', BATCHES, OURS).split('\n').filter(Boolean);
  for (const file of differing) {
    // Documentation counts as much as code. The axes hold a page a batch touched
    // to that batch and stop there, so four of them still described a different
    // application from the one the batches built — spoken for, and never read.
    const isDoc = /\.md$/.test(file);
    if (!isDoc) {
      if (IS_TEST(file) || !CODE.test(file)) continue;
      if (!/^(backend|frontend)\/src\//.test(file)) continue;
    }
    const mine = show(OURS, file);
    const theirs = show(BATCHES, file);
    if (mine === null || theirs === null) continue;
    const mineLines = RUNNING_LINES(mine);
    const theirLines = RUNNING_LINES(theirs);
    if (mineLines.join('\n') === theirLines.join('\n')) continue;
    const count = (a, b) => {
      const pool = [...b];
      let n = 0;
      for (const line of a) {
        const at = pool.indexOf(line);
        if (at === -1) n += 1;
        else pool.splice(at, 1);
      }
      return n;
    };
    const rule = residueRules.find((entry) => entry.test(file));
    residue.push({
      id: file,
      detail: `${count(mineLines, theirLines)} line(s) only here, ${count(theirLines, mineLines)} only in the batches`,
      note: rule?.note || null,
      spokenFor: Boolean(rule),
    });
  }
  residue.sort((a, b) => a.id.localeCompare(b.id));
}
const residueUnspoken = residue.filter((item) => !item.spokenFor);
// ── two more things a batch can lose, measured against the batches ──────────
// Both of these were found the hard way, and both are measured against the tip of
// the batch stack for the same reason `residue` is: `main` has not received the
// batches, so comparing there would call the whole backlog a loss.
//
// Sentences written into the code. A key both sides hold, with the same sentence
// under it, still says nothing about a sentence that never reached a catalogue at
// all: one row label had been written into a component in French, so every other
// language read French, and no axis could see it because there was no key. Both
// trees carry a couple of hundred such literals — a joint debt, not a divergence.
// What this is for is one appearing on a single side.
const READER_LITERAL = /(['"`])([A-Z][a-zé][^'"`\n]*\s[^'"`\n]{2,})\1/g;
const NOT_A_SENTENCE = /^(https?|\/|[A-Z_]+$)|[{}<>$]|\.(js|vue|json|png|svg)$/;
const literalsOf = (ref) => {
  const found = new Set();
  for (const file of listFiles(ref, 'frontend/src')) {
    if (!/\.(vue|js)$/.test(file) || IS_TEST(file) || file.includes('/i18n/locales/')) continue;
    const source = show(ref, file) || '';
    for (const match of source.matchAll(READER_LITERAL)) {
      const sentence = match[2];
      if (NOT_A_SENTENCE.test(sentence)) continue;
      const before = source.slice(Math.max(0, match.index - 30), match.index);
      if (/\b\$?t\(\s*$|\bte\(\s*$|i18n\.global\.t\(\s*$/.test(before)) continue;
      found.add(`${file}: ${sentence}`);
    }
  }
  return found;
};

// What a reader can press. Pause and resume on an upload existed upstream and went
// away when a batch replaced the panel holding them: the files were spoken for, the
// keys were spoken for, and nothing enumerated the controls. Two translated strings
// sitting unread in fifteen catalogues were the only trace.
const PRESSABLE = /<(button|a|input|select|textarea|label|summary)\b[^>]*>/gs;
const CONTROL_LABEL = /(?::?(?:aria-label|title|placeholder|alt)\s*=\s*)(["'])(.*?)\1/gs;
const LABEL_KEY = /\bt\(\s*['"`]([\w.$-]+)['"`]/g;
const controlsOf = (ref) => {
  const found = new Set();
  for (const file of listFiles(ref, 'frontend/src')) {
    if (!file.endsWith('.vue')) continue;
    const source = show(ref, file) || '';
    for (const tag of source.matchAll(PRESSABLE)) {
      for (const label of tag[0].matchAll(CONTROL_LABEL)) {
        const value = label[2].trim();
        if (!value) continue;
        const keys = [...value.matchAll(LABEL_KEY)].map((k) => k[1]);
        if (keys.length) keys.forEach((key) => found.add(key));
        else if (!/[{}]/.test(value) && value.length > 1) found.add(`"${value}"`);
      }
    }
    for (const button of source.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
      for (const key of button[0].matchAll(LABEL_KEY)) found.add(key[1]);
    }
  }
  return found;
};

const sided = (label, mine, theirs) => {
  const out = [];
  for (const id of mine) if (!theirs.has(id)) out.push({ side: 'ici', id });
  for (const id of theirs) if (!mine.has(id)) out.push({ side: 'dans les lots', id });
  const rules = (manifest[label] || []).map((entry) => ({
    ...entry,
    test: (id) => new RegExp(entry.match).test(id),
  }));
  return out.map((item) => {
    const rule = rules.find((entry) => entry.test(item.id));
    return { ...item, note: rule?.note || null, spokenFor: Boolean(rule) };
  });
};

const literals = BATCHES ? sided('literals', literalsOf(OURS), literalsOf(BATCHES)) : [];
const controls = BATCHES ? sided('controls', controlsOf(OURS), controlsOf(BATCHES)) : [];
const literalsUnspoken = literals.filter((item) => !item.spokenFor);
const controlsUnspoken = controls.filter((item) => !item.spokenFor);

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

/**
 * The verdict standing over each file, so an import can be judged against it.
 *
 * `ownerOf` above only knows files a batch brings. A file whose verdict is OURS
 * never travels at all, and a batch that ports a file importing one of those does
 * not build upstream — the import resolves to nothing there, however green it is
 * here. `SettingsUserPreferences.vue` importing the quick-actions menu, offered in
 * nxzai#333 and closed, is where this was found: the build-order check above said
 * the batch needed nothing.
 */
const verdictOfFile = new Map();
for (const verdict of VERDICTS) {
  for (const item of byVerdict[verdict]) {
    const file = item.id.split(':')[0];
    const seen = verdictOfFile.get(file);
    // PORT and DONE win: a file a batch brings is a file that travels, whatever
    // else a rule says about one symbol inside it.
    if (!seen || verdict === 'PORT' || verdict === 'DONE') verdictOfFile.set(file, verdict);
  }
}

const outOfOrder = [];
/**
 * A file a batch ports that imports a file staying in this fork.
 *
 * Reported as findings of their own, on the `stranded` axis, rather than as a gate
 * of their own: each one is either a part the batch leaves behind — the quick-actions
 * menu on the preferences screen — or a file whose verdict is wrong. Both are
 * answers the manifest gives, and an answer nobody has given is what this whole
 * script is built to refuse.
 */
const stranded = [];
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
    if (!targetBatch) {
      // Nobody brings it. If it is ours to keep, the importing batch cannot be
      // sent as it stands: the part that needs it has to be left out, or the file
      // has to be reclassified.
      if (verdictOfFile.get(target) === 'OURS') {
        stranded.push({ axis: 'stranded', id: `${file} -> ${target}`, batch: [...claimants][0] });
      }
      continue;
    }
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

// The second pass the stranded axis needs: it is measured from the verdicts, so it
// cannot be measured before them.
const strandedUnclassified = [];
for (const finding of stranded) {
  const rule = compiled.find((r) => r.test(finding.axis, finding.id));
  if (!rule || !VERDICTS.includes(rule.verdict)) {
    strandedUnclassified.push(finding);
    continue;
  }
  counts[rule.verdict] += 1;
  byVerdict[rule.verdict].push({ ...finding, note: rule.note, batch: rule.batch ?? finding.batch });
}

/**
 * A file that arrives before anything can call it.
 *
 * The check above reads each batch's imports: nothing it needs may come later. This
 * one reads the other direction — a new file that only files from *later* batches
 * import is dead the day it lands. Green, and nobody can reach it.
 *
 * It was found on P3-17: the destination picker's service, dialog and composable
 * were a batch of their own, while the route that records a destination (P3-27),
 * the client that asks for the list (P3-35) and the trash and versions that note
 * theirs (P3-30) all came after. Three files upstream would have had no way to use.
 *
 * Only files this fork alone has, and only the ones a batch brings: a file upstream
 * already has is already reachable, whatever changes.
 */
const importersOf = new Map();
for (const file of ours) {
  if (!CODE.test(file)) continue;
  const source = show(OURS, file);
  if (!source) continue;
  for (const match of source.matchAll(IMPORT)) {
    const target = resolveImport(file, match[1] || match[2]);
    if (!target || !onlyHere.has(target)) continue;
    if (!importersOf.has(target)) importersOf.set(target, new Set());
    importersOf.get(target).add(file);
  }
}

/** Whether upstream's own copy of `importer` already pulls in `target`. */
const importsAlready = (importer, target) => {
  const source = show(UPSTREAM, importer);
  if (!source) return false;
  for (const match of source.matchAll(IMPORT)) {
    if (resolveImport(importer, match[1] || match[2]) === target) return true;
  }
  return false;
};

const unreachable = [];
for (const [file, batch] of ownerOf) {
  if (batch === 'P3-00') continue;
  if (!CODE.test(file) || !onlyHere.has(file)) continue;
  // A test, a route mounted by name, a Vue view the router names: reached without
  // an import. Only a module something has to require can be judged this way.
  if (/\.(spec|test)\.[jt]s$/.test(file) || file.startsWith('backend/tests/')) continue;
  const importers = [...(importersOf.get(file) || [])];
  if (!importers.length) continue; // nothing imports it at all — the axes above speak for that
  const reachable = importers.some((importer) => {
    // Upstream having the importing file is not enough: it is the import line that
    // has to be there. `routes/files/transfer.js` exists upstream and does not
    // require the destination service, so it cannot call it until the batch that
    // adds that line lands.
    if (theirs.has(importer) && importsAlready(importer, file)) return true;
    const from = ownerOf.get(importer);
    return from && Number(from.slice(3)) <= Number(batch.slice(3));
  });
  if (!reachable) {
    const soonest = importers
      .map((i) => ownerOf.get(i))
      .filter(Boolean)
      .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))[0];
    unreachable.push({
      axis: 'unreachable',
      id: file,
      batch,
      detail: `nothing upstream can call it until ${soonest || 'a later batch'}`,
    });
  }
}

for (const finding of unreachable) {
  const rule = compiled.find((r) => r.test(finding.axis, finding.id));
  if (!rule || !VERDICTS.includes(rule.verdict)) {
    strandedUnclassified.push(finding);
    continue;
  }
  counts[rule.verdict] += 1;
  byVerdict[rule.verdict].push({ ...finding, note: rule.note, batch: rule.batch ?? finding.batch });
}

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        counts,
        unreachable,
        unclassified,
        byVerdict,
        completeness,
        outOfOrder,
        stranded,
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
  console.log(
    `arrives too early    ${unreachable.length ? `${unreachable.length} file(s) nothing upstream can call yet` : 'every file a batch brings has a caller'}\n`
  );
  for (const line of unreachable.slice(0, 20))
    console.log(`  ${line.batch}  ${line.id} — ${line.detail}`);
  if (unreachable.length) console.log('');
  console.log(
    `files that stay ours  ${stranded.length ? `imported by ${stranded.length} file(s) a batch ports` : 'imported by nothing a batch ports'}\n`
  );
  for (const line of stranded.slice(0, 20)) console.log(`  ${line.batch}  ${line.id}`);
  if (stranded.length) console.log('');
  console.log(
    'sentences in the code    ' +
      (!BATCHES
        ? 'not measured: no batch tip to compare with'
        : literals.length
          ? `${literals.length} written on one side only`
          : 'the same on both sides') +
      '\n'
  );
  for (const item of literals.slice(0, 20))
    console.log(`  ${item.spokenFor ? ' ' : '!'} ${item.side}: ${item.id}`);
  if (literals.length) console.log('');
  console.log(
    'what a reader can press  ' +
      (!BATCHES
        ? 'not measured: no batch tip to compare with'
        : controls.length
          ? `${controls.length} control(s) on one side only`
          : 'every control is on both sides') +
      '\n'
  );
  for (const item of controls.slice(0, 20))
    console.log(`  ${item.spokenFor ? ' ' : '!'} ${item.side}: ${item.id}`);
  if (controls.length) console.log('');
  console.log(
    'what a batch left behind  ' +
      (!BATCHES
        ? 'not measured: no batch tip to compare with (--batches, or `batchTip` in the manifest)'
        : residue.length
          ? `${residue.length} file(s) a batch sent still run differently`
          : 'every file a batch sent runs the same on both sides') +
      '\n'
  );
  for (const item of residue.slice(0, 30))
    console.log(`  ${item.spokenFor ? ' ' : '!'} ${item.id} — ${item.detail}`);
  if (residue.length) console.log('');

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
if (strandedUnclassified.length) {
  console.error(
    `${strandedUnclassified.length} finding(s) about what a batch can and cannot reach. ` +
      'batch ports. Upstream has no such file, so the batch does not build there unless that ' +
      'part is left out. Say which in scripts/parity-manifest.json, on the `stranded` axis:\n  ' +
      strandedUnclassified.map((f) => f.id).join('\n  ')
  );
  process.exit(1);
}
if (literalsUnspoken.length || controlsUnspoken.length) {
  console.error(
    `${literalsUnspoken.length} sentence(s) written into the code on one side only, and ` +
      `${controlsUnspoken.length} control(s) a reader can press on one side only. Bring it ` +
      'across, or say under `literals` / `controls` in scripts/parity-manifest.json why it ' +
      'stays where it is:\n  ' +
      [...literalsUnspoken, ...controlsUnspoken]
        .map((item) => `${item.side}: ${item.id}`)
        .join('\n  ')
  );
  process.exit(1);
}
if (residueUnspoken.length) {
  console.error(
    `${residueUnspoken.length} file(s) a batch sent, whose two versions still do different ` +
      'things. Bring the better one home, send the better one up, or say under `residue` in ' +
      'scripts/parity-manifest.json why the difference may stand:\n  ' +
      residueUnspoken.map((item) => `${item.id} — ${item.detail}`).join('\n  ')
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
