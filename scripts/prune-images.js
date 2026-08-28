#!/usr/bin/env node
/* eslint-env node */

/**
 * Prune old container images, without breaking the ones that are kept.
 *
 * A multi-arch image is not one version in the registry but several: an index,
 * plus one manifest per architecture. Only the index carries the tag. Deleting
 * "untagged versions" — the obvious cleanup, and what most snippets do — takes
 * those per-architecture manifests with it: the tag still resolves, and pulling
 * it fails because the layers for your platform are gone.
 *
 * So this reads each kept index and keeps what it points at, then deletes the
 * rest. Dry run by default; deleting takes --apply.
 *
 *   node scripts/prune-images.js                 # show what would go
 *   node scripts/prune-images.js --apply         # actually delete
 *   node scripts/prune-images.js --keep-versions 4
 *
 * Needs GITHUB_TOKEN (packages: write) and OWNER in the environment.
 */

const OWNER = process.env.OWNER || 'cerede2000';
const PACKAGE = process.env.PACKAGE_NAME || 'explorer';
const TOKEN = process.env.GITHUB_TOKEN;

// Tags that always survive: they name what is currently published.
const PROTECTED_TAGS = new Set(['latest', 'latest-lean', 'test', 'test-lean']);

// A released version, as the release workflow writes it.
const RELEASE_TAG = /^v?\d+\.\d+\.\d+(-lean)?$/;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const keepVersions = Number(args[args.indexOf('--keep-versions') + 1]) || 2;

// A personal package is reached through /user, not /users/<name>: the latter
// exists but refuses to delete, and it answers 404 rather than saying so —
// which is how an earlier version of this script reported deleting a thousand
// versions while removing two.
const BASE = process.env.PACKAGE_SCOPE === 'org' ? `/orgs/${OWNER}` : '/user';

const api = async (path, options = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} → ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
};

/** Every version of the package, newest first. */
const listVersions = async () => {
  const versions = [];
  // No fixed page limit: the registry had accumulated thousands of versions,
  // and stopping at ten pages silently left most of them in place.
  for (let page = 1; page <= 200; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await api(
      `${BASE}/packages/container/${PACKAGE}/versions?per_page=100&page=${page}`
    );
    if (!batch?.length) break;
    versions.push(...batch);
    if (batch.length < 100) break;
  }
  return versions;
};

/** A pull token for the registry, which is not the GitHub API token. */
const registryToken = async () => {
  const response = await fetch(
    `https://ghcr.io/token?scope=repository:${OWNER}/${PACKAGE}:pull&service=ghcr.io`,
    { headers: { authorization: `Bearer ${Buffer.from(TOKEN).toString('base64')}` } }
  );
  if (!response.ok) throw new Error(`registry token → ${response.status}`);
  return (await response.json()).token;
};

/** The digests an index points at, or nothing when it is a plain image. */
const childDigests = async (token, digest) => {
  const response = await fetch(`https://ghcr.io/v2/${OWNER}/${PACKAGE}/manifests/${digest}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
  });

  if (!response.ok) return [];
  const manifest = await response.json();
  return Array.isArray(manifest.manifests) ? manifest.manifests.map((entry) => entry.digest) : [];
};

const main = async () => {
  if (!TOKEN) {
    console.error('GITHUB_TOKEN is required.');
    process.exit(1);
  }

  const versions = await listVersions();
  const tagsOf = (version) => version.metadata?.container?.tags ?? [];

  // A release is one version in two variants — v3.0.1 and v3.0.1-lean are the
  // same thing built twice — so they are counted as one, and kept together.
  const releaseNumber = (tag) => tag.replace(/^v/, '').replace(/-lean$/, '');

  const releases = [];
  for (const version of versions) {
    for (const tag of tagsOf(version).filter((t) => RELEASE_TAG.test(t) && t.startsWith('v'))) {
      const number = releaseNumber(tag);
      if (!releases.includes(number)) releases.push(number);
    }
  }
  const keptReleases = new Set(releases.slice(0, keepVersions));

  // The test image is rebuilt on every push to the integration branch, each
  // build tagged with its commit. The last few are what makes a rollback
  // possible while testing.
  const testBuilds = [];
  for (const version of versions) {
    for (const tag of tagsOf(version).filter((t) => /^test(-lean)?-[0-9a-f]{40}$/.test(t))) {
      const commit = tag.slice(-40);
      if (!testBuilds.includes(commit)) testBuilds.push(commit);
    }
  }
  const keptBuilds = new Set(testBuilds.slice(0, keepVersions));

  const keep = new Set();
  for (const version of versions) {
    const tags = tagsOf(version);
    if (!tags.length) continue;

    const isProtected = tags.some((tag) => PROTECTED_TAGS.has(tag));
    const isKeptRelease = tags.some(
      (tag) => RELEASE_TAG.test(tag) && keptReleases.has(releaseNumber(tag))
    );
    const isKeptBuild = tags.some((tag) => keptBuilds.has(tag.slice(-40)));
    if (isProtected || isKeptRelease || isKeptBuild) keep.add(version.id);
  }

  // Everything a kept index points at has to be kept too, or the image breaks.
  const token = await registryToken();
  const byDigest = new Map(versions.map((version) => [version.name, version]));
  for (const version of versions.filter((v) => keep.has(v.id))) {
    // eslint-disable-next-line no-await-in-loop
    for (const digest of await childDigests(token, version.name)) {
      const child = byDigest.get(digest);
      if (child) keep.add(child.id);
    }
  }

  const doomed = versions.filter((version) => !keep.has(version.id));

  console.log(`${versions.length} versions, keeping ${keep.size}, removing ${doomed.length}.`);
  console.log(`Releases kept: ${[...keptReleases].join(', ') || 'none'}`);
  console.log(`Integration builds kept: ${keptBuilds.size}`);

  for (const version of doomed) {
    const tags = tagsOf(version);
    console.log(
      `  ${apply ? 'delete' : 'would delete'} ${version.name.slice(0, 19)} ${
        tags.length ? `(${tags.join(', ')})` : '(untagged)'
      }`
    );
    if (apply) {
      // eslint-disable-next-line no-await-in-loop
      await api(`${BASE}/packages/container/${PACKAGE}/versions/${version.id}`, {
        method: 'DELETE',
      });
    }
  }

  if (!apply && doomed.length) {
    console.log('\nDry run. Pass --apply to delete.');
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
