/**
 * An entry a walk found and cannot reach.
 *
 * `readdir` answers with text. Node decodes a name's bytes as UTF-8 and puts
 * U+FFFD where it cannot, and that character re-encodes to three bytes where
 * the disk holds one: `Contrôle` written the Windows way is `43 6f 6e 74 72 f4
 * 6c 65` on disk, eight bytes, and `43 6f 6e 74 72 ef bf bd 6c 65` in the path
 * built back from the decoded name, ten. `lstat` then answers ENOENT for a file
 * that is plainly there. A volume carried over from Windows is full of such
 * names, and nothing on a Linux filesystem forbids them.
 *
 * Three answers were possible and two of them were wrong. Dying takes the whole
 * archive, the whole copy or the whole listing down over one name: the zip
 * download of a folder holding one answered 500 and wrote no archive at all.
 * Skipping in silence is worse — "download folder" then hands back an archive
 * with files missing and calls it the folder, which is a backup that lies. So
 * the entry is skipped and counted, and the count travels with the result as
 * far as the screen: an operation says how many entries it could not read.
 *
 * The same codes cover an entry that went while the walk was running, and a
 * folder the server may not open. Those are the other reasons a name read a
 * moment ago leads nowhere, and they want exactly the same treatment.
 */

const UNREACHABLE_CODES = new Set([
  // The name leads nowhere: bytes Node could not decode, or an entry that went
  // between the readdir and the stat.
  'ENOENT',
  // A folder on the way turned into a file under us.
  'ENOTDIR',
  // The byte sequence is refused outright, which is what a Mac answers when
  // asked to create such a name.
  'EILSEQ',
  'EACCES',
  'EPERM',
  'ELOOP',
  'ENAMETOOLONG',
]);

/** Whether `error` says the entry cannot be reached, rather than that the walk cannot go on. */
const isUnreachableEntry = (error) => UNREACHABLE_CODES.has(error?.code);

/** How many of the names are kept for the log; the count is kept in full. */
const SAMPLE_LIMIT = 5;

/**
 * A running count of what one walk could not reach.
 *
 * `noteOrThrow` is what a catch block wants: an entry nothing can reach is
 * counted and the walk goes on, and anything else — a full disk, an I/O error,
 * a cancellation — is still the caller's to hear about.
 */
const createUnreachableTally = () => {
  let count = 0;
  const sample = [];

  const note = (absolutePath) => {
    count += 1;
    if (sample.length < SAMPLE_LIMIT) sample.push(absolutePath);
    return true;
  };

  const noteOrThrow = (absolutePath, error) => {
    if (!isUnreachableEntry(error)) throw error;
    return note(absolutePath);
  };

  return {
    get count() {
      return count;
    },
    get sample() {
      return sample.slice();
    },
    note,
    noteOrThrow,
  };
};

module.exports = { isUnreachableEntry, createUnreachableTally, UNREACHABLE_CODES };
