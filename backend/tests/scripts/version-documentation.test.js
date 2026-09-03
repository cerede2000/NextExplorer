import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const {
  staleVersionMentions,
  rewriteVersionMentions,
  DOCUMENTED,
} = require('../../../scripts/version.js');

/**
 * The version written in prose, which nothing used to check.
 *
 * Three package.json files and a lockfile carry the version, and a script keeps
 * them in step. The README and the deployment page carry it too — they name the
 * image tag to pull — and nothing kept those. Both sat at 3.1.2 while the code
 * was at 3.2.0, found by a person reading rather than by any tool.
 *
 * That is worse than untidy. Only the last two versions stay published, so a
 * reader following a two-release-old tag pulls an image that is no longer there.
 */

describe('a page that names a version', () => {
  it('is reported when it names an older one', () => {
    const page = 'Pull `3.1.2` to get it.';

    expect(staleVersionMentions(page, '3.3.0')).toEqual(['3.1.2']);
  });

  it('is left alone when it names the current one', () => {
    const page = 'Pull `3.3.0` to get it.';

    expect(staleVersionMentions(page, '3.3.0')).toEqual([]);
  });

  it('reports each stale version once, however often it appears', () => {
    const page = '`3.1.2` and `3.1.2-lean`, or just `3.1.2` again.';

    expect(staleVersionMentions(page, '3.3.0')).toEqual(['3.1.2']);
  });

  /**
   * The `-lean` variant is the same release, so it is the same mention — and
   * rewriting it has to keep the suffix, or the second image stops existing.
   */
  it('treats the lean variant as the same version', () => {
    expect(staleVersionMentions('`3.3.0-lean`', '3.3.0')).toEqual([]);
  });

  it('keeps the lean suffix when it rewrites', () => {
    expect(rewriteVersionMentions('`3.1.2`, `3.1.2-lean`', '3.3.0')).toBe('`3.3.0`, `3.3.0-lean`');
  });

  /**
   * A dependency range is not a claim about this application's version. Without
   * the backticks and the exact-version shape, a page mentioning `^3.1.0` for
   * something else would be rewritten into a lie.
   */
  it('ignores a dependency range', () => {
    const page = 'This needs `^3.1.0` of the other thing.';

    expect(staleVersionMentions(page, '3.3.0')).toEqual([]);
  });

  it('ignores a bare number outside code formatting', () => {
    const page = 'Version 3.1.2 was the one before.';

    expect(staleVersionMentions(page, '3.3.0')).toEqual([]);
  });

  it('rewrites nothing in a page that names no version', () => {
    const page = 'Pull `latest` to get it.';

    expect(rewriteVersionMentions(page, '3.3.0')).toBe(page);
  });
});

describe('the pages the script watches', () => {
  /**
   * The list is the whole mechanism: a page that names a tag and is not listed
   * goes stale in silence, which is exactly what happened.
   */
  it('all exist', () => {
    const root = path.resolve(__dirname, '..', '..', '..');

    for (const relativePath of DOCUMENTED) {
      expect(fs.existsSync(path.join(root, relativePath))).toBe(true);
    }
  });

  it('each actually names a version, or watching it means nothing', () => {
    const root = path.resolve(__dirname, '..', '..', '..');

    for (const relativePath of DOCUMENTED) {
      const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
      expect(/`\d+\.\d+\.\d+(-lean)?`/.test(text)).toBe(true);
    }
  });

  /** And they agree with the manifests right now. */
  it('agrees with the version the application reports', () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    for (const relativePath of DOCUMENTED) {
      const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
      expect(staleVersionMentions(text, version)).toEqual([]);
    }
  });
});
