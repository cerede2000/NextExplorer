import { useFeaturesStore } from '@/stores/features';
import { isEditableExtension } from '@/config/editor';

/**
 * What can be compared side by side.
 *
 * Whatever the text editor can open, and nothing listed twice: a comparison reads
 * two files as lines of text, which is exactly what the editor does, so a second
 * list of the same extensions would be a second list to keep in step. An
 * installation adds its own through `COMPARE_FILE_EXTENSIONS` — what counts as text
 * is a local question, somebody's `.ino` and somebody else's `.tf`.
 *
 * Deliberately not "any file": comparing two photographs line by line produces
 * pages of binary nonsense and an offer that was never worth making. A file with no
 * extension is not comparable either, for the same reason — nothing says it is
 * text, and the cost of being wrong is a browser trying to lay out a megabyte of
 * control characters.
 */
/**
 * Read on each question rather than kept in a `computed`.
 *
 * A handful of files in a selection is a handful of questions, so there is nothing
 * to save — and a memoised answer over a store is a trap: it holds the first answer
 * for as long as nothing it *read* changed, which is not the same as nothing having
 * changed.
 */
const addedHere = () => {
  const features = useFeaturesStore();
  return (features.compareExtensions || []).map((one) => String(one).toLowerCase());
};

export const isComparableExtension = (extension = '') => {
  const one = String(extension || '')
    .toLowerCase()
    .replace(/^\./, '');
  if (!one) return false;
  return isEditableExtension(one) || addedHere().includes(one);
};

/** The extension of a listing entry, as this application reads one. */
export const extensionOf = (item) => {
  const name = typeof item?.name === 'string' ? item.name : '';
  const fromName = name.includes('.') ? name.split('.').pop() : '';
  return String(fromName || item?.kind || '').toLowerCase();
};

/** Whether an entry in a listing is a file at all, rather than a place. */
const isFileEntry = (item) =>
  Boolean(item) && item.kind !== 'directory' && item.kind !== 'volume' && item.kind !== 'personal';

/** Whether an entry in a listing is a file this application will compare. */
export const isComparableItem = (item) => {
  if (!isFileEntry(item)) return false;
  return isComparableExtension(extensionOf(item));
};

/**
 * How many files a comparison takes.
 *
 * Two is the comparison; three is the one that answers "who changed what", which is
 * what a comparison is for when two people have both edited a common version. Four
 * would be a table nobody can read on a screen.
 */
export const MIN_COMPARED = 2;
export const MAX_COMPARED = 3;

/** Whether this selection is one a comparison could be offered for. */
export const canCompare = (items) => {
  const files = Array.isArray(items) ? items : [];
  if (files.length < MIN_COMPARED || files.length > MAX_COMPARED) return false;
  return files.every((item) => isComparableItem(item));
};

/**
 * Whether this selection is one whose *checksums* could be compared.
 *
 * The same two or three, and files rather than places — but any files at all.
 * A side-by-side comparison needs text it can lay out in two columns, which is
 * why it is offered for so few kinds; this needs bytes, and the question it
 * answers is the one asked of a film, a disk image or an archive, which no
 * comparison of text can answer. Gating it on the other one's list of
 * extensions would have withheld it from everything it is for.
 */
export const canCompareChecksums = (items) => {
  const files = Array.isArray(items) ? items : [];
  if (files.length < MIN_COMPARED || files.length > MAX_COMPARED) return false;
  return files.every((item) => isFileEntry(item));
};
