import { describe, expect, it, vi } from 'vitest';

/**
 * Where a comparison is.
 *
 * Two or three paths in the query rather than in the path, because a comparison is
 * not *at* a place — it is about several of them. A query also survives paths with
 * slashes in them without anybody having to invent a separator a file name cannot
 * contain, which is a thing no separator is.
 */

vi.mock('@/api', () => ({
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));
vi.mock('@/config/compare', () => ({ MIN_COMPARED: 2, MAX_COMPARED: 3 }));

import { comparedPaths, compareRoute } from './compareRoute';

describe('the address of a comparison', () => {
  it('carries the two paths it is about', () => {
    expect(compareRoute(['Docs/a.txt', 'Docs/b.txt'])).toEqual({
      path: '/compare',
      query: { paths: ['Docs/a.txt', 'Docs/b.txt'] },
    });
  });

  it('carries three when there are three', () => {
    expect(compareRoute(['a.txt', 'b.txt', 'c.txt']).query.paths).toHaveLength(3);
  });

  it('keeps the order they were given in', () => {
    expect(compareRoute(['z.txt', 'a.txt']).query.paths).toEqual(['z.txt', 'a.txt']);
  });

  /** A file against itself is not a comparison. */
  it('is nothing for the same file twice', () => {
    expect(compareRoute(['Docs/a.txt', 'Docs/a.txt'])).toBeNull();
  });

  it('is nothing for one file, and nothing for four', () => {
    expect(compareRoute(['a.txt'])).toBeNull();
    expect(compareRoute(['a.txt', 'b.txt', 'c.txt', 'd.txt'])).toBeNull();
  });

  it('is nothing for no files at all', () => {
    expect(compareRoute([])).toBeNull();
    expect(compareRoute(null)).toBeNull();
  });

  it('ignores a path that is nothing but slashes', () => {
    expect(compareRoute(['a.txt', '/', ''])).toBeNull();
  });
});

describe('the paths a comparison address names', () => {
  it('reads several, as a router hands a repeated parameter over', () => {
    expect(comparedPaths({ paths: ['Docs/a.txt', 'Docs/b.txt'] })).toEqual([
      'Docs/a.txt',
      'Docs/b.txt',
    ]);
  });

  /** One arrives as a string, not an array of one: both are read the same way. */
  it('reads one written as a string', () => {
    expect(comparedPaths({ paths: 'Docs/a.txt' })).toEqual(['Docs/a.txt']);
  });

  it('reads nothing from an address with no paths on it', () => {
    expect(comparedPaths({})).toEqual([]);
    expect(comparedPaths(null)).toEqual([]);
  });

  it('drops a repeat, so a hand-written address cannot compare a file with itself', () => {
    expect(comparedPaths({ paths: ['a.txt', 'a.txt', 'b.txt'] })).toEqual(['a.txt', 'b.txt']);
  });

  it('takes no more than a comparison can hold', () => {
    expect(comparedPaths({ paths: ['a', 'b', 'c', 'd', 'e'] })).toEqual(['a', 'b', 'c']);
  });

  it('ignores anything in the query that is not a path', () => {
    expect(comparedPaths({ paths: [null, 42, 'a.txt', 'b.txt'] })).toEqual(['a.txt', 'b.txt']);
  });
});
