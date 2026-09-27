import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the other side tests and this one does not.
 *
 *   node scripts/test-drift.mjs <their ref> [our ref]
 *
 * The axes in parity.mjs deliberately look past the tests: a test of ours travels
 * with the batch that brings what it tests, so comparing them file by file would
 * report the whole suite as a divergence. That left one direction unmeasured —
 * a test written *on a batch branch*, which never came home. `settings-preferences`
 * was found by accident, by building P3-57 in its own tree and watching it go red
 * where `integration` was green. This is that accident, on purpose.
 *
 * Compared by the *cases*, over both trees at once, and not by file: the first
 * version of this compared paths, and `two-factor.test.js` — sitting under
 * `services/` here and `routes/` there — read as forty files missing when it was
 * one file moved. A case is what a suite is; where it lives is filing.
 *
 * What it prints is a list to read rather than a verdict, and reading it is the
 * work: a case renamed while porting reads as a case missing, and so does a suite
 * the porting work split under other names. Worse, a file of the same name can be
 * a different layer altogether — `two-factor` is a service test here and a route
 * test there, and reading that as one file moved was the first wrong answer this
 * gave.
 *
 * So each reading is written down once, in test-drift-manifest.json, with what
 * makes it answered. What is left is a count rather than a list, and it goes to
 * zero — which is the only state worth keeping, because a list nobody has read to
 * the end is indistinguishable from a list with nothing in it.
 *
 * Swapping the two refs asks the other question — what this tree has and the other
 * does not — and that one is a diagnostic rather than a gate: `parity.mjs` already
 * governs it, file by file, with a verdict and a reason for each. Running it that
 * way is still worth doing, because it is what showed `^backend/tests/` calling
 * every test DONE, six of which test this fork's own scripts and have nowhere to go.
 */

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const IS_TEST = (file) => /\.(spec|test)\.[jt]s$/.test(file);

const CASE =
  /\b(?:it|test)(?:\.each\([\s\S]*?\))?(?:\.(?:only|skip|todo|concurrent|fails))*\s*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

/** Every case in a tree: its title, and the file that declares it. */
const casesOf = (ref) => {
  const found = new Map();
  for (const file of git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean)) {
    if (!IS_TEST(file)) continue;
    let source;
    try {
      source = git('show', `${ref}:${file}`);
    } catch {
      continue;
    }
    for (const match of source.matchAll(CASE)) {
      const title = match[2].replace(/\s+/g, ' ').trim();
      if (!title) continue;
      if (!found.has(title)) found.set(title, []);
      found.get(title).push(file);
    }
  }
  return found;
};

const theirRef = process.argv[2];
const ourRef = process.argv[3] || 'HEAD';

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-drift-manifest.json'),
    'utf8'
  )
);
const answered = (manifest.answered || []).map((entry) => ({
  ...entry,
  test: (file, title) =>
    new RegExp(entry.file).test(file) &&
    (!entry.cases || entry.cases.some((one) => new RegExp(one).test(title))),
}));
const reasonFor = (file, title) => answered.find((entry) => entry.test(file, title))?.note || null;

const theirs = casesOf(theirRef);
const ours = casesOf(ourRef);

const onlyThere = [...theirs]
  .filter(([title]) => !ours.has(title))
  .map(([title, files]) => ({ title, file: files[0], note: reasonFor(files[0], title) }));
const unanswered = onlyThere.filter((item) => !item.note);

/** Grouped by the file that declares them there, which is how they travel. */
const byFile = new Map();
for (const { title, file } of unanswered) {
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push(title);
}

const basenames = (map) => new Set([...map.values()].flat().map((f) => f.split('/').pop()));
const theirNames = basenames(theirs);
const ourNames = basenames(ours);

console.log(`\n${theirRef} against ${ourRef}\n`);
console.log(`  ${String(theirs.size).padStart(5)} case(s) there, in ${theirNames.size} file(s)`);
console.log(`  ${String(ours.size).padStart(5)} case(s) here,  in ${ourNames.size} file(s)`);
console.log(`  ${String(onlyThere.length).padStart(5)} case(s) only there`);
console.log(
  `  ${String(onlyThere.length - unanswered.length).padStart(5)} of them answered in test-drift-manifest.json\n`
);

const whole = [...byFile].filter(([file]) => !ourNames.has(file.split('/').pop()));
const partial = [...byFile].filter(([file]) => ourNames.has(file.split('/').pop()));

console.log(`── files this tree has nothing of (${whole.length}) ──`);
for (const [file, titles] of whole.sort()) console.log(`  ! ${file} — ${titles.length} case(s)`);
if (!whole.length) console.log('  none');

console.log(`\n── files that are here, missing cases (${partial.length}) ──`);
for (const [file, titles] of partial.sort()) {
  console.log(`  ! ${file} — ${titles.length} case(s) not here`);
  for (const title of titles) console.log(`      · ${title}`);
}
if (!partial.length) console.log('  none');

const spokenFor = new Map();
for (const { file, note } of onlyThere) if (note) spokenFor.set(file, note);
console.log(`\n── answered, and why (${spokenFor.size} file(s)) ──`);
for (const [file, note] of [...spokenFor].sort()) console.log(`    ${file}\n      ${note}`);
if (!spokenFor.size) console.log('  none');

console.log(
  `\n${unanswered.length} case(s) the other side has, this one does not, and nothing accounts for.`
);
process.exit(unanswered.length > 0 ? 1 : 0);
