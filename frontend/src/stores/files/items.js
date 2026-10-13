import { normalizePath } from '@/api';

/**
 * What the file store says about a single entry, with nothing of the store in
 * it: how an entry is known, where it is, and what is sent for it.
 */

/**
 * The entry's name as a path segment, which is not always what it is called.
 *
 * A name on a disk is bytes. Where those bytes are not valid UTF-8 — a volume
 * carried over from Windows is full of such names — they cannot be text without
 * losing: the server hands over `name` with U+FFFD in it for the eye, and
 * `pathName`, which is the same name written down so it survives a round trip.
 * A path built out of `name` would name nothing, which is the whole defect.
 *
 * The field is absent for every name that is valid UTF-8, so for every entry
 * anybody has ever looked at this answers exactly `item.name` and nothing about
 * the application changes. Everything that builds a path or a key out of an
 * entry asks this, and nothing asks `name` for that purpose: two spellings of
 * one entry is two identities for it, and a row whose key disagreed with the
 * path its actions use is a row that acts on something else.
 */
export const pathNameOf = (item) => {
  if (!item) return '';
  if (typeof item.pathName === 'string' && item.pathName) return item.pathName;
  return typeof item.name === 'string' ? item.name : '';
};

/**
 * `parent::name`, the identity of an entry across listings.
 *
 * Keyed on the path name rather than the readable one, because two names that
 * do not decode can read the same: `Contr<f4>le` and `Contr<f5>le` are both
 * `Contr?le` to the eye, and one key between them would draw one row for two
 * files and let an action on either reach whichever the merge kept.
 */
export const itemKey = (item) => {
  if (!item || !item.name) {
    return '';
  }

  const parent = normalizePath(item.path || '');
  return `${parent}::${pathNameOf(item)}`;
};

/** The entry's path from the top, or null for something that is not one. */
export const itemRelativePath = (item) => {
  if (!item || !item.name) {
    return null;
  }

  const parent = normalizePath(item.path || '');
  const name = pathNameOf(item);
  const combined = parent ? `${parent}/${name}` : name;
  return normalizePath(combined);
};

/** What an operation on files is sent: never a volume, never a nameless row. */
export const serializeItems = (items) =>
  items
    .filter((item) => item && item.name && item.kind !== 'volume')
    .map((item) => ({
      // The name the server can resolve, which for an entry whose own name does
      // not decode is the written-down one. Sending the readable name would ask
      // the server for a path that names nothing.
      name: pathNameOf(item),
      path: normalizePath(item.path || ''),
      kind: item.kind,
    }));

// Final name of a copied/moved entry, from its destination-relative path.
export const transferredBaseName = (relativePath) => {
  const normalized = normalizePath(relativePath || '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
};

// Collect the final entry names from a streamed transfer result ({ items:[{ to }] }).
export const collectTransferredNames = (result, out) => {
  const items = Array.isArray(result?.items) ? result.items : [];
  for (const entry of items) {
    const name = transferredBaseName(entry?.to);
    if (name) out.push(name);
  }
};

export const isAbortError = (error) =>
  error?.name === 'AbortError' ||
  error?.code === 'OPERATION_CANCELLED' ||
  (typeof DOMException !== 'undefined' && error?.code === DOMException.ABORT_ERR) ||
  /aborted/i.test(error?.message || '');
