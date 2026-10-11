const path = require('node:path');

/**
 * A directory entry whose name cannot be decoded, on a filesystem that would
 * not hold one.
 *
 * The defect is real and it is a Linux one. A name on disk is bytes; `readdir`
 * answers with text, so Node decodes those bytes as UTF-8 and puts U+FFFD where
 * it cannot. That character re-encodes to three bytes where the disk holds one,
 * so the path built back from the name points at nothing and `lstat` answers
 * ENOENT for a file that is plainly there. `Contrôle` written the Windows way
 * is `43 6f 6e 74 72 f4 6c 65` on disk and `43 6f 6e 74 72 ef bf bd 6c 65` in
 * the rebuilt path.
 *
 * This suite runs on macOS, where the kernel refuses to create such a name at
 * all — `open` answers EILSEQ — so the condition cannot be put on the real
 * filesystem here. It is put on the module instead: a stand-in for `fs` that
 * passes everything through to the real one, adds the undecodable name to the
 * listing of one directory, and answers ENOENT for every path under it. Every
 * other file in these tests is a real file in a real temporary directory, so
 * what is faked is exactly the one thing the host cannot do and nothing else.
 *
 * Checked against the real thing before being written, in a Linux container:
 *
 *   docker run --rm node:24-alpine sh -lc 'mkdir -p /t/d;
 *     printf x > "/t/d/$(printf "Contr\364le")";
 *     node -e "const fs=require(\"fs\");
 *       for (const n of fs.readdirSync(\"/t/d\")) {
 *         try { fs.lstatSync(\"/t/d/\"+n) } catch (e) { console.log(JSON.stringify(n), e.code) }
 *       }"'
 *
 * which answers `"Contr�le" ENOENT`, and succeeds when the directory is read
 * with `{ encoding: 'buffer' }` and the path rebuilt with `Buffer.concat`.
 */

/** The name as `readdir` hands it over: the replacement character in the middle. */
const UNDECODABLE_NAME = 'Contr�le du niveau d’huile';

const enoent = (operation, target) =>
  Object.assign(new Error(`ENOENT: no such file or directory, ${operation} '${target}'`), {
    code: 'ENOENT',
    errno: -2,
    syscall: operation,
    path: target,
  });

const isUnder = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Wrap `realFs` so that `directory` also holds `name`, and nothing can be done
 * with it.
 *
 * `promises` says whether the wrapped module is `fs/promises` (the methods
 * answer promises) or `fs` (they take callbacks). Only the calls the walks
 * under test make are intercepted; everything else is the real module's.
 *
 * @param {object} options
 * @param {object} options.realFs the module to pass through to
 * @param {string} options.directory absolute path of the directory that holds it
 * @param {string} [options.name] the name as a listing reads it
 * @param {boolean} [options.promises] false for the callback-style `fs`
 * @param {boolean} [options.isDirectory] whether the entry claims to be a folder
 */
const withUndecodableEntry = ({
  realFs,
  directory,
  name = UNDECODABLE_NAME,
  promises = true,
  isDirectory = false,
}) => {
  const ghost = path.join(directory, name);
  const refuses = (target) => typeof target === 'string' && isUnder(target, ghost);

  const dirent = {
    name,
    parentPath: directory,
    path: directory,
    isFile: () => !isDirectory,
    isDirectory: () => isDirectory,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };

  const listingFor = (entries) =>
    entries.length && typeof entries[0] === 'object' ? [...entries, dirent] : [...entries, name];

  if (promises) {
    const readdir = async (target, options) => {
      const entries = await realFs.readdir(target, options);
      return typeof target === 'string' && path.resolve(target) === path.resolve(directory)
        ? listingFor(entries)
        : entries;
    };

    const refuse =
      (operation, next) =>
      async (target, ...rest) => {
        if (refuses(target)) throw enoent(operation, target);
        return next(target, ...rest);
      };

    return {
      ...realFs,
      readdir,
      lstat: refuse('lstat', (...args) => realFs.lstat(...args)),
      stat: refuse('stat', (...args) => realFs.stat(...args)),
      open: refuse('open', (...args) => realFs.open(...args)),
      readlink: refuse('readlink', (...args) => realFs.readlink(...args)),
      copyFile: refuse('copyfile', (...args) => realFs.copyFile(...args)),
      rename: refuse('rename', (...args) => realFs.rename(...args)),
      link: refuse('link', (...args) => realFs.link(...args)),
      utimes: refuse('utimes', (...args) => realFs.utimes(...args)),
    };
  }

  const refuseSync =
    (operation, next) =>
    (target, ...rest) => {
      if (refuses(target)) throw enoent(operation, target);
      return next(target, ...rest);
    };

  return {
    ...realFs,
    readdirSync: (target, options) => {
      const entries = realFs.readdirSync(target, options);
      return typeof target === 'string' && path.resolve(target) === path.resolve(directory)
        ? listingFor(entries)
        : entries;
    },
    lstatSync: refuseSync('lstat', (...args) => realFs.lstatSync(...args)),
    statSync: refuseSync('stat', (...args) => realFs.statSync(...args)),
    createReadStream: refuseSync('open', (...args) => realFs.createReadStream(...args)),
  };
};

module.exports = { UNDECODABLE_NAME, withUndecodableEntry };
