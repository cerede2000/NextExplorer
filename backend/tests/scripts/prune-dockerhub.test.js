import { describe, it, expect } from 'vitest';

// eslint-disable-next-line global-require
const { decide } = require('../../../scripts/prune-dockerhub.js');

/**
 * The Docker Hub page is what people see before the repository, and a release
 * adds six tags to it. This keeps the last two releases and removes the rest —
 * so what it decides to remove is worth proving before it is given a token.
 */

const tag = (name, digest = 'sha256:default') => ({ name, digest });

/** A release, as the publish workflow writes it: two variants, three names each. */
const release = (number, digest, leanDigest) => [
  tag(number, digest),
  tag(`v${number}`, digest),
  tag(`${number}-lean`, leanDigest),
  tag(`v${number}-lean`, leanDigest),
];

describe('what stays on Docker Hub', () => {
  const listing = [
    tag('latest', 'sha256:c'),
    tag('latest-lean', 'sha256:c-lean'),
    ...release('3.1.2', 'sha256:c', 'sha256:c-lean'),
    ...release('3.1.1', 'sha256:b', 'sha256:b-lean'),
    ...release('3.1.0', 'sha256:a', 'sha256:a-lean'),
    tag('sha-' + 'c'.repeat(40), 'sha256:c'),
    tag('sha-' + 'c'.repeat(40) + '-lean', 'sha256:c-lean'),
    tag('sha-' + 'a'.repeat(40), 'sha256:a'),
    tag('sha-' + 'a'.repeat(40) + '-lean', 'sha256:a-lean'),
  ];

  const removed = (result) => result.doomed.map((t) => t.name).sort();

  it('keeps two releases and drops the one before them', () => {
    const result = decide({ tags: listing, keepVersions: 2, currentVersion: '3.1.2' });

    expect([...result.kept].sort()).toEqual(['3.1.1', '3.1.2']);
    expect(removed(result)).toEqual([
      '3.1.0',
      '3.1.0-lean',
      'sha-' + 'a'.repeat(40),
      'sha-' + 'a'.repeat(40) + '-lean',
      'v3.1.0',
      'v3.1.0-lean',
    ]);
  });

  it('never touches what is published now', () => {
    const result = decide({ tags: listing, keepVersions: 2, currentVersion: '3.1.2' });

    expect(removed(result)).not.toContain('latest');
    expect(removed(result)).not.toContain('latest-lean');
  });

  // The commit tag of the image `latest` points at is the current image under
  // another name, so it stays; the one from a dropped release goes with it.
  it('keeps a commit tag that is the current image, by digest', () => {
    const result = decide({ tags: listing, keepVersions: 2, currentVersion: '3.1.2' });

    expect(removed(result)).not.toContain('sha-' + 'c'.repeat(40));
    expect(removed(result)).toContain('sha-' + 'a'.repeat(40));
  });

  it('orders releases by version rather than by name', () => {
    const tags = [
      ...release('3.9.0', 'sha256:x', 'sha256:x-lean'),
      ...release('3.10.0', 'sha256:y', 'sha256:y-lean'),
      ...release('3.2.0', 'sha256:z', 'sha256:z-lean'),
    ];

    const result = decide({ tags, keepVersions: 2, currentVersion: '3.10.0' });

    // 3.10.0 is newer than 3.9.0, which a string sort gets backwards.
    expect([...result.kept].sort()).toEqual(['3.10.0', '3.9.0']);
    expect(removed(result)).toContain('3.2.0');
  });

  it('removes nothing while there are only two releases', () => {
    const tags = [
      tag('latest', 'sha256:b'),
      ...release('3.1.1', 'sha256:b', 'sha256:b-lean'),
      ...release('3.1.0', 'sha256:a', 'sha256:a-lean'),
    ];

    expect(decide({ tags, keepVersions: 2, currentVersion: '3.1.1' }).doomed).toEqual([]);
  });

  // A sort that went wrong must not be able to delete the release it was run
  // for. The version in package.json is protected whatever the listing says.
  it('refuses to remove the version it was run for', () => {
    const result = decide({ tags: listing, keepVersions: 1, currentVersion: '3.1.0' });

    expect(removed(result)).not.toContain('3.1.0');
    expect(removed(result)).not.toContain('3.1.0-lean');
    expect(removed(result)).toContain('3.1.1');
  });

  // A tag this script cannot explain is a tag it has no business deleting.
  it('leaves a tag of an unknown shape alone', () => {
    const tags = [...listing, tag('nightly', 'sha256:n'), tag('3.1.0-rc1', 'sha256:r')];

    expect(removed(decide({ tags, keepVersions: 2, currentVersion: '3.1.2' }))).not.toContain(
      'nightly'
    );
    expect(removed(decide({ tags, keepVersions: 2, currentVersion: '3.1.2' }))).not.toContain(
      '3.1.0-rc1'
    );
  });
});
