import { normalizePath } from '@/api';
import { MAX_COMPARED, MIN_COMPARED } from '@/config/compare';

/**
 * Where a comparison is, as an address of its own.
 *
 * Two or three paths in the query rather than in the path itself, because a
 * comparison is not *at* a place — it is about several of them, and none of them is
 * the one it belongs to. A query also survives paths with slashes in them without
 * anybody having to invent a separator that a file name cannot contain, which is a
 * thing no separator is.
 *
 * An address, like everything else here: it can be kept in a tab, linked to and
 * come back to, which is what makes a comparison something the reader leaves and
 * returns to rather than a dialog they must finish.
 */
export const compareRoute = (paths) => {
  const wanted = (Array.isArray(paths) ? paths : [paths])
    .map((one) => normalizePath(one || ''))
    .filter(Boolean);

  // The same file against itself is not a comparison; nor is one file, nor four.
  const unique = [...new Set(wanted)];
  if (unique.length < MIN_COMPARED || unique.length > MAX_COMPARED) return null;

  return { path: '/compare', query: { paths: unique } };
};

/**
 * The paths a comparison address names, in the order they were given.
 *
 * One path arrives as a string and several as an array, which is what a router does
 * with a repeated parameter — so both are read the same way here rather than at
 * every caller.
 */
export const comparedPaths = (query) => {
  const raw = query?.paths;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return [
    ...new Set(
      list
        .map((one) => normalizePath(typeof one === 'string' ? one : ''))
        .filter(Boolean)
        .slice(0, MAX_COMPARED)
    ),
  ];
};
