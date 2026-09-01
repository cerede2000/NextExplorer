#!/usr/bin/env node
/* eslint-env node */

/**
 * Keep only the last two releases on Docker Hub.
 *
 * The page people land on before the repository lists every tag ever pushed,
 * and a release adds six of them: the number, the `v` form, the commit, each
 * in a full and a lean variant. Left alone it becomes a wall of versions
 * nobody runs, and the two that matter are lost in it.
 *
 * What survives:
 *
 * - `latest` and `latest-lean`, which name what is published now.
 * - The two newest releases, in every form they were pushed under — `3.1.1`,
 *   `v3.1.1` and both `-lean` variants are one release, not four.
 * - The commit tags of the images those releases point at, matched by digest
 *   rather than by name, so a `sha-…` tag that is the current image keeps its
 *   place while older ones go.
 * - Anything whose shape is not recognised. A tag this script cannot explain
 *   is a tag it has no business deleting.
 *
 * Dry run by default; deleting takes --apply.
 *
 *   node scripts/prune-dockerhub.js                 # show what would go
 *   node scripts/prune-dockerhub.js --dry-run       # the same, said out loud
 *   node scripts/prune-dockerhub.js --apply
 *   node scripts/prune-dockerhub.js --keep-versions 3
 *
 * Needs DOCKERHUB_USERNAME and DOCKERHUB_TOKEN in the environment.
 */

const USERNAME = process.env.DOCKERHUB_USERNAME;
const TOKEN = process.env.DOCKERHUB_TOKEN;
const NAMESPACE = process.env.DOCKERHUB_NAMESPACE || USERNAME;
const REPOSITORY = process.env.DOCKERHUB_REPOSITORY || 'explorer';

const API = 'https://hub.docker.com/v2';

// Tags that always survive: they name what is currently published.
const PROTECTED_TAGS = new Set(['latest', 'latest-lean']);

// A released version, as the publish workflow writes it.
const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)(-lean)?$/;
const COMMIT_TAG = /^sha-[0-9a-f]{40}(-lean)?$/;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const keepVersions = Number(args[args.indexOf('--keep-versions') + 1]) || 2;

/** The release a tag belongs to: 3.1.1, v3.1.1 and both -lean forms are one. */
const releaseOf = (tag) => {
  const match = RELEASE_TAG.exec(tag);
  if (!match) return null;
  return { number: `${match[1]}.${match[2]}.${match[3]}`, parts: match.slice(1, 4).map(Number) };
};

const newestFirst = (a, b) => {
  const left = a.parts;
  const right = b.parts;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return right[i] - left[i];
  }
  return 0;
};

const login = async () => {
  const response = await fetch(`${API}/users/login/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: TOKEN }),
  });
  if (!response.ok) throw new Error(`login → ${response.status}`);
  const { token } = await response.json();
  if (!token) throw new Error('login returned no token');
  return token;
};

const listTags = async (jwt) => {
  const tags = [];
  for (let page = 1; page <= 100; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(
      `${API}/repositories/${NAMESPACE}/${REPOSITORY}/tags?page_size=100&page=${page}`,
      { headers: { authorization: `JWT ${jwt}` } }
    );
    if (!response.ok) throw new Error(`list tags → ${response.status}`);
    // eslint-disable-next-line no-await-in-loop
    const body = await response.json();
    if (!Array.isArray(body.results) || body.results.length === 0) break;
    tags.push(...body.results);
    if (!body.next) break;
  }
  return tags;
};

const deleteTag = async (jwt, tag) => {
  const response = await fetch(
    `${API}/repositories/${NAMESPACE}/${REPOSITORY}/tags/${encodeURIComponent(tag)}/`,
    { method: 'DELETE', headers: { authorization: `JWT ${jwt}` } }
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete ${tag} → ${response.status}`);
  }
};

/**
 * What survives and what goes, decided from the tag listing alone.
 *
 * Separated from the deleting so it can be tested against a real listing
 * without credentials and without a registry to damage.
 */
const decide = ({ tags, keepVersions: keep = 2, currentVersion }) => {
  const releases = new Map();
  for (const { name } of tags) {
    const release = releaseOf(name);
    if (release && !releases.has(release.number)) releases.set(release.number, release);
  }

  const ordered = [...releases.values()].sort(newestFirst);
  const kept = new Set(ordered.slice(0, keep).map((release) => release.number));

  // The version this checkout carries is the one that has just been published.
  // Whatever the listing says, it is not a candidate for removal — a sort that
  // went wrong must not be able to delete the release it was run for.
  if (currentVersion) kept.add(currentVersion);

  if (ordered.length <= keep) {
    return { kept, doomed: [], releases: ordered.length };
  }

  // Commit tags are kept by digest: the one that is the current image survives
  // under whatever name it has, and the rest go with the releases they came
  // from.
  const keptDigests = new Set(
    tags
      .filter(({ name }) => PROTECTED_TAGS.has(name) || kept.has(releaseOf(name)?.number))
      .map(({ digest }) => digest)
      .filter(Boolean)
  );

  const doomed = tags.filter(({ name, digest }) => {
    if (PROTECTED_TAGS.has(name)) return false;

    const release = releaseOf(name);
    if (release) return !kept.has(release.number);

    if (COMMIT_TAG.test(name)) return !digest || !keptDigests.has(digest);

    // Not a shape this script knows. Leave it alone.
    return false;
  });

  return { kept, doomed, releases: ordered.length };
};

const main = async () => {
  if (!USERNAME || !TOKEN) {
    console.error('DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are required.');
    process.exit(1);
  }

  const jwt = await login();
  const tags = await listTags(jwt);
  console.log(`${tags.length} tags on ${NAMESPACE}/${REPOSITORY}.`);

  // eslint-disable-next-line global-require
  const { version: currentVersion } = require('../package.json');
  const { kept, doomed, releases } = decide({ tags, keepVersions, currentVersion });

  console.log(`Keeping ${[...kept].sort().join(', ')}.`);
  if (doomed.length === 0) {
    console.log(`${releases} release(s) published; nothing to remove.`);
    return;
  }

  console.log(`${apply ? 'Removing' : 'Would remove'} ${doomed.length} tag(s):`);
  for (const { name } of doomed) console.log(`  ${name}`);

  if (!apply) {
    console.log('\nDry run. Pass --apply to delete.');
    return;
  }

  for (const { name } of doomed) {
    // eslint-disable-next-line no-await-in-loop
    await deleteTag(jwt, name);
    console.log(`  removed ${name}`);
  }
};

module.exports = { decide, releaseOf };

// Required from a test rather than run: do nothing.
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
