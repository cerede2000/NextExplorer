/**
 * What the panel can show of an entry without taking it out of the archive.
 *
 * One answer for the whole panel: the list asks it to decide whether a name
 * opens something, and the reader asks it to decide what to draw. Two lists
 * drifting apart is a name that offers to open and then says it cannot.
 */

/**
 * Images a browser decodes on its own.
 *
 * Deliberately not the explorer's own list of previewable images, which is
 * longer: a raw file from a camera or a HEIC is shown elsewhere because the
 * server converts it first, and nothing converts anything here — the bytes go
 * straight from the archive into an `<img>`. Offering those would be a name
 * that opens onto a broken image.
 */
const BROWSER_IMAGES = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);

const MARKDOWN = new Set(['md', 'markdown']);

const extensionOf = (name = '') => {
  const dot = String(name).lastIndexOf('.');
  return dot > 0
    ? String(name)
        .slice(dot + 1)
        .toLowerCase()
    : '';
};

/**
 * `'image'`, `'markdown'`, `'text'`, or null when the panel cannot show it.
 *
 * `isEditable` is handed in rather than imported so this stays a plain
 * function: the explorer's notion of what counts as text comes from the
 * server, through a store, and a decision this small should not need one.
 */
const entryKind = (name, isEditable) => {
  const extension = extensionOf(name);
  if (!extension) return null;
  if (MARKDOWN.has(extension)) return 'markdown';
  if (BROWSER_IMAGES.has(extension)) return 'image';
  return isEditable(extension) ? 'text' : null;
};

export { entryKind, extensionOf };
