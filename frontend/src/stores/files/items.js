import { normalizePath } from '@/api';

/**
 * What the file store says about a single entry, with nothing of the store in
 * it: how an entry is known, where it is, and what is sent for it.
 */

/** `parent::name`, the identity of an entry across listings. */
export const itemKey = (item) => {
  if (!item || !item.name) {
    return '';
  }

  const parent = normalizePath(item.path || '');
  return `${parent}::${item.name}`;
};

/** The entry's path from the top, or null for something that is not one. */
export const itemRelativePath = (item) => {
  if (!item || !item.name) {
    return null;
  }

  const parent = normalizePath(item.path || '');
  const combined = parent ? `${parent}/${item.name}` : item.name;
  return normalizePath(combined);
};

/** What an operation on files is sent: never a volume, never a nameless row. */
export const serializeItems = (items) =>
  items
    .filter((item) => item && item.name && item.kind !== 'volume')
    .map((item) => ({
      name: item.name,
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
