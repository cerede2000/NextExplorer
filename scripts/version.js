#!/usr/bin/env node
/* eslint-env node */

/**
 * Set — or check — the version, in the four places that carry it.
 *
 * The root, the backend and the frontend each have their own package.json, and
 * the lockfile records the root's. They drifted apart the moment anyone bumped
 * one by hand, and nothing noticed: the version served by /api/features comes
 * from the backend, so the number in a release could differ from the number the
 * running app reported.
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

  console.log(
    `Version ${version}, consistent across ${MANIFESTS.length} manifests and the lockfile.`
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

  execFileSync('npm', ['install', '--package-lock-only', '--silent'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  console.log('package-lock.json updated.');
  console.log(`\nNext: commit, then \`gh release create v${version}\` to publish the images.`);
};

const [argument] = process.argv.slice(2);

if (!argument || argument === '--check') {
  check();
} else {
  set(argument.replace(/^v/, ''));
}
