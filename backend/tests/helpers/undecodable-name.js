const path = require('node:path');

/**
 * A directory entry whose name the disk holds in bytes that are not valid
 * UTF-8, on a filesystem that will not hold one.
 *
 * The defect is real and it is a Linux one. A name on disk is bytes; `readdir`
 * answers text unless asked otherwise, so Node decodes those bytes as UTF-8 and
 * puts U+FFFD where it cannot. That character re-encodes to three bytes where
 * the disk holds one, so the path built back from the name points at nothing and
 * `lstat` answers ENOENT for a file that is plainly there. `Contrôle` written the
 * Windows way is `43 6f 6e 74 72 f4 6c 65` on disk and
 * `43 6f 6e 74 72 ef bf bd 6c 65` in the rebuilt path.
 *
 * This suite runs on macOS, where the kernel refuses to create such a name at
 * all — `open` answers EILSEQ — so the condition is put on the `fs` module
 * instead. What the stand-in reproduces is the whole of the real behaviour, in
 * both directions:
 *
 *   - `readdir` with `{ encoding: 'buffer' }` hands back the real bytes, and
 *     without it hands back the lossy text, exactly as Node does.
 *   - Any path whose bytes are the entry's bytes reaches a real file: the entry
 *     is *there*, which is what phase two is for. A substitute file under an
 *     ordinary name stands in for it, since the host cannot create the real one.
 *   - Any path spelled with the decoded text answers ENOENT, which is the defect
 *     itself.
 *
 * So a test can assert both halves — that the entry is reachable through its
 * bytes and unreachable through its text — and neither half is an assumption.
 * Checked against the real thing in a Linux container before being written:
 *
 *   docker run --rm node:24-alpine sh -lc 'mkdir -p /t/d;
 *     printf x > "/t/d/$(printf "Contr\364le")";
 *     node -e "const fs=require(\"fs\");
 *       for (const n of fs.readdirSync(\"/t/d\")) {
 *         try { fs.lstatSync(\"/t/d/\"+n) } catch (e) { console.log(JSON.stringify(n), e.code) }
 *       }
 *       for (const b of fs.readdirSync(\"/t/d\",{encoding:\"buffer\"})) {
 *         console.log(b.toString(\"hex\"), fs.lstatSync(Buffer.concat([Buffer.from(\"/t/d/\"),b])).size)
 *       }"'
 *
 * which answers `"Contr<FFFD>le" ENOENT` and then `436f6e7472f46c65 1`.
 */

/** `Contrôle du niveau d’huile`, with `ô` as the single byte 0xF4. */
const UNDECODABLE_BYTES = Buffer.concat([
  Buffer.from('Contr', 'utf8'),
  Buffer.from([0xf4]),
  Buffer.from('le du niveau d’huile', 'utf8'),
]);

/** The same name as `readdir` hands it over when it is read as text. */
const UNDECODABLE_NAME = UNDECODABLE_BYTES.toString('utf8');

/** The name as a path segment, which is what the listing gives a client. */
const UNDECODABLE_PATH_NAME = `￾${UNDECODABLE_BYTES.toString('hex')}`;

const enoent = (operation, target) =>
  Object.assign(new Error(`ENOENT: no such file or directory, ${operation} '${target}'`), {
    code: 'ENOENT',
    errno: -2,
    syscall: operation,
    path: target,
  });

const asBytes = (target) =>
  Buffer.isBuffer(target) ? target : Buffer.from(String(target), 'utf8');

/**
 * Wrap `realFs` so that `directory` holds one entry named in bytes that do not
 * decode, standing in for `substitute`.
 *
 * @param {object} options
 * @param {object} options.realFs the module to pass through to
 * @param {string} options.directory absolute path of the directory holding it
 * @param {string} options.substitute absolute path of the real file or folder
 *   that answers for it, which is hidden from the listing in its place
 * @param {Buffer} [options.bytes] the name's bytes
 * @param {boolean} [options.promises] false for the callback-style `fs`
 */
const withUndecodableEntry = ({
  realFs,
  directory,
  substitute,
  bytes = UNDECODABLE_BYTES,
  promises = true,
  places,
}) => {
  /**
   * One or more directories, each holding one such entry.
   *
   * More than one because a copy has two ends. The host will not create the
   * name at the destination either, so a test that only stood in for the source
   * would watch the copy read the entry and then fail to write it — which is the
   * host's limitation, not the application's. Each place says where its entry
   * stands in, and writes are redirected the same way reads are.
   */
  const declared = places || [{ directory, substitute, bytes }];
  const entries = declared.map((place) => {
    const placeBytes = place.bytes || bytes;
    const ghostBytes = Buffer.concat([
      Buffer.from(`${place.directory}${path.sep}`, 'utf8'),
      placeBytes,
    ]);
    return {
      directory: place.directory,
      bytes: placeBytes,
      substitute: place.substitute || null,
      hiddenName: place.substitute ? path.basename(place.substitute) : null,
      isDirectory:
        place.substitute && require('node:fs').existsSync(place.substitute)
          ? require('node:fs').statSync(place.substitute).isDirectory()
          : false,
      ghostBytes,
      decodedGhost: ghostBytes.toString('utf8'),
    };
  });

  /** Where an operation on this path should really go, or null to pass through. */
  const redirect = (target) => {
    const asked = asBytes(target);
    for (const entry of entries) {
      if (!entry.substitute) continue;
      if (asked.equals(entry.ghostBytes)) return entry.substitute;
      const prefix = Buffer.concat([entry.ghostBytes, Buffer.from(path.sep)]);
      if (asked.length > prefix.length && asked.subarray(0, prefix.length).equals(prefix)) {
        return entry.substitute + asked.subarray(entry.ghostBytes.length).toString('utf8');
      }
    }
    return null;
  };

  /** Whether this path is an entry spelled the lossy way, which names nothing. */
  const namesNothing = (target) =>
    typeof target === 'string' &&
    entries.some(
      (entry) =>
        target === entry.decodedGhost || target.startsWith(`${entry.decodedGhost}${path.sep}`)
    );

  /**
   * The entry in whichever of the four shapes `readdir` was asked for: a name
   * or a `Dirent`, as text or as bytes. Getting this wrong is not a detail —
   * handing a string to a walk that asked for `withFileTypes` reads as an entry
   * with no name at all, which is a different defect from the one under test.
   */
  const entryFor = (entry, { withFileTypes, wantsBuffer }) => {
    const asName = wantsBuffer ? entry.bytes : entry.bytes.toString('utf8');
    if (!withFileTypes) return asName;
    return {
      name: asName,
      parentPath: entry.directory,
      path: entry.directory,
      isFile: () => !entry.isDirectory,
      isDirectory: () => entry.isDirectory,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    };
  };

  const listedBy = (target) =>
    entries.find(
      (entry) =>
        typeof target === 'string' && path.resolve(target) === path.resolve(entry.directory)
    );

  const listing = (entry, existing, options) => {
    const kept = existing.filter((item) => {
      const name = typeof item === 'string' || Buffer.isBuffer(item) ? item : item?.name;
      const text = Buffer.isBuffer(name) ? name.toString('utf8') : name;
      return text !== entry.hiddenName;
    });
    return [
      ...kept,
      entryFor(entry, {
        withFileTypes: Boolean(options?.withFileTypes),
        wantsBuffer: options?.encoding === 'buffer',
      }),
    ];
  };

  if (promises) {
    const guard =
      (operation, next) =>
      async (target, ...rest) => {
        if (namesNothing(target)) throw enoent(operation, target);
        const to = redirect(target);
        return next(to === null ? target : to, ...rest);
      };

    return {
      ...realFs,
      readdir: async (target, options) => {
        const existing = await realFs.readdir(redirect(target) ?? target, options);
        const entry = listedBy(target);
        return entry ? listing(entry, existing, options) : existing;
      },
      mkdir: guard('mkdir', (...args) => realFs.mkdir(...args)),
      lstat: guard('lstat', (...args) => realFs.lstat(...args)),
      stat: guard('stat', (...args) => realFs.stat(...args)),
      open: guard('open', (...args) => realFs.open(...args)),
      readFile: guard('open', (...args) => realFs.readFile(...args)),
      writeFile: guard('open', (...args) => realFs.writeFile(...args)),
      readlink: guard('readlink', (...args) => realFs.readlink(...args)),
      realpath: guard('realpath', (...args) => realFs.realpath(...args)),
      utimes: guard('utimes', (...args) => realFs.utimes(...args)),
      chmod: guard('chmod', (...args) => realFs.chmod(...args)),
      unlink: guard('unlink', (...args) => realFs.unlink(...args)),
      rm: guard('rm', (...args) => realFs.rm(...args)),
      copyFile: async (from, to, ...rest) => {
        if (namesNothing(from) || namesNothing(to)) throw enoent('copyfile', from);
        return realFs.copyFile(redirect(from) ?? from, redirect(to) ?? to, ...rest);
      },
      rename: async (from, to, ...rest) => {
        if (namesNothing(from) || namesNothing(to)) throw enoent('rename', from);
        return realFs.rename(redirect(from) ?? from, redirect(to) ?? to, ...rest);
      },
      link: async (from, to, ...rest) => {
        if (namesNothing(from) || namesNothing(to)) throw enoent('link', from);
        return realFs.link(redirect(from) ?? from, redirect(to) ?? to, ...rest);
      },
    };
  }

  const guardSync =
    (operation, next) =>
    (target, ...rest) => {
      if (namesNothing(target)) throw enoent(operation, target);
      const to = redirect(target);
      return next(to === null ? target : to, ...rest);
    };

  return {
    ...realFs,
    readdirSync: (target, options) => {
      const existing = realFs.readdirSync(redirect(target) ?? target, options);
      const entry = listedBy(target);
      return entry ? listing(entry, existing, options) : existing;
    },
    lstatSync: guardSync('lstat', (...args) => realFs.lstatSync(...args)),
    statSync: guardSync('stat', (...args) => realFs.statSync(...args)),
    createReadStream: guardSync('open', (...args) => realFs.createReadStream(...args)),
    createWriteStream: guardSync('open', (...args) => realFs.createWriteStream(...args)),
  };
};

module.exports = {
  UNDECODABLE_BYTES,
  UNDECODABLE_NAME,
  UNDECODABLE_PATH_NAME,
  withUndecodableEntry,
};
