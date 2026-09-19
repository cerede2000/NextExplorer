/**
 * What a typed search term means.
 *
 * Two terms typed into the same box do not ask the same question. `report` is
 * text: it is looked for in filenames and inside files alike. `*.ps1` is a
 * shape — it names a set of filenames, and no file contains those characters.
 * Searching the tree for the literal string is therefore both wrong and the
 * slowest thing the search can do: someone looking for their PowerShell
 * scripts waited eleven seconds to be shown six files that mention `*.ps1` in
 * their text, and not one of the scripts.
 *
 * So a wildcard is the signal to stop looking at content altogether. It is not
 * an optimisation on the side; it is the difference between answering the
 * question and answering a different one slowly.
 */

const path = require('path');

const WILDCARD = /[*?]/;

/**
 * The same letters, written the same way.
 *
 * `é` is one code point or two, and which one a filename carries depends on
 * what wrote it: a browser sends the composed form, a Mac writing over SMB or
 * rsync leaves the decomposed one. On Linux those are different bytes and
 * different strings, so a file called `Résumé.pdf` could not be found by
 * typing its name — the one thing somebody is most certain of (#11).
 *
 * Both sides are brought to the composed form before they are compared. It is
 * a no-op for the ASCII names that are most of a tree, and it is the whole
 * difference for the rest.
 */
const same = (value) => String(value).normalize('NFC');

// Everything a regular expression treats specially, minus the two characters
// that are the whole point. A term is typed by a person, so `a+b` is three
// characters and not an expression.
const REGEXP_SPECIALS = /[.+^${}()|[\]\\/]/g;

const toRegExp = (pattern) =>
  new RegExp(
    `^${pattern.replace(REGEXP_SPECIALS, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    'i'
  );

const textTerm = (text) => {
  const needle = same(text).toLowerCase();
  const contains = (value) => same(value).toLowerCase().includes(needle);

  return {
    isGlob: false,
    // Text is looked for inside files as well as in their names.
    readsFileContents: true,
    text,
    needle,
    matchesName: contains,
    // A path is matched on its last segment: this is the behaviour a plain
    // term has always had, and widening it would make every file under a
    // matching folder a result of its own.
    matchesRelativePath: (rel) => contains(path.posix.basename(rel)),
  };
};

const globTerm = (text) => {
  const wholePath = text.includes('/');
  const pattern = toRegExp(same(text));

  return {
    isGlob: true,
    // A pattern is a shape for names; there is nothing to look for inside a
    // file, and looking is what cost the whole budget.
    readsFileContents: false,
    text,
    needle: text.toLowerCase(),
    // A pattern spanning folders cannot be answered by one name, so a folder
    // is never a match for it — `Stacks/*.log` describes files under Stacks,
    // not a folder called that.
    matchesName: (name) => (wholePath ? false : pattern.test(same(name))),
    matchesRelativePath: (rel) => pattern.test(same(wholePath ? rel : path.posix.basename(rel))),
  };
};

/**
 * @param {string} raw what the user typed
 * @returns {{isGlob: boolean, readsFileContents: boolean, text: string, needle: string,
 *   matchesName: (name: string) => boolean,
 *   matchesRelativePath: (rel: string) => boolean}}
 */
const parseSearchTerm = (raw) => {
  const text = String(raw ?? '');
  return WILDCARD.test(text) ? globTerm(text) : textTerm(text);
};

module.exports = { parseSearchTerm };
