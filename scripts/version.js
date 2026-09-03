#!/usr/bin/env node
/* eslint-env node */

/**
 * Set — or check — the version, everywhere it is written down.
 *
 * The root, the backend and the frontend each have their own package.json, and
 * the lockfile records the root's. They drifted apart the moment anyone bumped
 * one by hand, and nothing noticed: the version served by /api/features comes
 * from the backend, so the number in a release could differ from the number the
 * running app reported.
 *
 * The prose has the same problem and no lockfile to catch it. The README and the
 * deployment page each name the current image tag, and both sat two releases
 * behind before anyone looked — a reader following them pulls an image that is
 * no longer published, since only the last two versions are kept. They are
 * listed here so `--check` fails on the drift rather than a person finding it.
 *
 *   node scripts/version.js 3.0.1   # set everywhere, and the lockfile
 *   node scripts/version.js --check # fail if they disagree (used by CI)
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFESTS = ['package.json', 'backend/package.json', 'frontend/package.json'];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Documentation that names the current version, and the shapes it names it in.
 *
 * Matched as a whole token so a dependency range like `^3.1.2` elsewhere on the
 * page is left alone, and anchored on the backtick-quoted forms the tables
 * actually use rather than on any three numbers in a row.
 */
const DOCUMENTED = ['README.md', 'docs/installation/deployment.md'];
const VERSION_MENTION = /`(\d+\.\d+\.\d+)(-lean)?`/g;

/**
 * The versions a page names that are not the one given, each once.
 *
 * Separate from the file reading so the rule can be tried on a string: what is
 * worth pinning is which shapes count as naming a version, not that a path can
 * be opened.
 */
const staleVersionMentions = (text, version) => {
  const found = new Set();
  for (const [, mentioned] of text.matchAll(VERSION_MENTION)) {
    if (mentioned !== version) found.add(mentioned);
  }
  return [...found];
};

/** Rewrite every mention to the given version, keeping the `-lean` suffix. */
const rewriteVersionMentions = (text, version) =>
  text.replace(VERSION_MENTION, (_match, _found, lean) => `\`${version}${lean || ''}\``);

const readManifest = (relativePath) => {
  const file = path.join(ROOT, relativePath);
  return { file, relativePath, contents: JSON.parse(fs.readFileSync(file, 'utf8')) };
};

const check = () => {
  const manifests = MANIFESTS.map(readManifest);
  const versions = new Set(manifests.map((m) => m.contents.version));

  if (versions.size !== 1) {
    console.error('Versions disagree:');
    for (const { relativePath, contents } of manifests) {
      console.error(`  ${relativePath}: ${contents.version}`);
    }
    console.error('\nRun `npm run version:set -- <version>` to line them up.');
    process.exit(1);
  }

  const [version] = [...versions];
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  if (lock.version !== version) {
    console.error(`package-lock.json says ${lock.version}, the manifests say ${version}.`);
    console.error('Run `npm install --package-lock-only` to bring it back in line.');
    process.exit(1);
  }

  const stale = [];
  for (const relativePath of DOCUMENTED) {
    const text = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    for (const mentioned of staleVersionMentions(text, version)) {
      stale.push(`  ${relativePath}: ${mentioned}`);
    }
  }

  if (stale.length) {
    console.error(`These name a version the code is not at (${version}):`);
    console.error(stale.join('\n'));
    console.error('\nRun `npm run version:set -- <version>` to line them up.');
    process.exit(1);
  }

  console.log(
    `Version ${version}, consistent across ${MANIFESTS.length} manifests, ` +
      `the lockfile and ${DOCUMENTED.length} documentation pages.`
  );
};

const set = (version) => {
  if (!SEMVER.test(version)) {
    console.error(`"${version}" is not a version. Expected something like 3.0.1.`);
    process.exit(1);
  }

  for (const { file, relativePath, contents } of MANIFESTS.map(readManifest)) {
    const previous = contents.version;
    contents.version = version;
    // Two spaces and a trailing newline, the way npm writes these.
    fs.writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`);
    console.log(`${relativePath}: ${previous} → ${version}`);
  }

  for (const relativePath of DOCUMENTED) {
    const file = path.join(ROOT, relativePath);
    const text = fs.readFileSync(file, 'utf8');
    const updated = rewriteVersionMentions(text, version);
    if (updated !== text) {
      fs.writeFileSync(file, updated);
      console.log(`${relativePath}: image tags updated`);
    }
  }

  execFileSync('npm', ['install', '--package-lock-only', '--silent'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  console.log('package-lock.json updated.');
  console.log(`\nNext: commit, then \`gh release create v${version}\` to publish the images.`);
};

// Only when run, not when required: a test asks about the rule without setting
// anybody's version.
if (require.main === module) {
  const [argument] = process.argv.slice(2);

  if (!argument || argument === '--check') {
    check();
  } else {
    set(argument.replace(/^v/, ''));
  }
}

module.exports = { staleVersionMentions, rewriteVersionMentions, DOCUMENTED };
