const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * A stand-in for 7-Zip, so what this application does around it can be run.
 *
 * Browsing an archive is two things: what 7-Zip says, and what is made of it.
 * The second is all of the interesting part — a name that climbs out of the
 * archive, a level cut out of a full listing, an archive that refuses to open
 * — and on a machine without 7-Zip installed none of it could be run at all,
 * which is most machines somebody develops on.
 *
 * The stand-in answers `i` with a format list, and `l` by printing the archive
 * file itself: a test writes the listing it wants read, exactly as 7-Zip would
 * have printed it, and the route is then decided by this application rather
 * than by an archive somebody had to commit.
 *
 * That is the limit of it, and it is why the suites that use a real 7-Zip stay:
 * this proves what is done with a listing, never that 7-Zip prints one.
 */

const SCRIPT = `#!/bin/sh
case "$1" in
  i)
    echo "7-Zip (z) 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov"
    echo "Formats:"
    echo " 7z zip tar gz bz2 xz rar iso cab wim"
    exit 0
    ;;
  l)
    # The last argument is the archive; everything before it is switches and --
    for last; do :; done
    if [ ! -f "$last" ]; then
      echo "ERROR: $last : The system cannot find the file specified." >&2
      exit 2
    fi
    if head -n 1 "$last" | grep -q '^FAKE-7Z-ENCRYPTED$'; then
      echo "ERROR: Can not open encrypted archive. Wrong password?" >&2
      exit 2
    fi
    if head -n 1 "$last" | grep -q '^FAKE-7Z-BROKEN$'; then
      echo "ERROR: Unexpected end of archive" >&2
      exit 2
    fi
    cat "$last"
    exit 0
    ;;
esac
echo "fake 7z: unsupported command $1" >&2
exit 1
`;

/**
 * Put the stand-in first on PATH for the duration of a test.
 *
 * @returns {() => void} restores PATH and removes the stand-in
 */
const useFakeSevenZip = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-7z-'));
  const binary = path.join(dir, '7z');
  fs.writeFileSync(binary, SCRIPT, { mode: 0o755 });

  const previousPath = process.env.PATH;
  const previousBin = process.env.SEVEN_ZIP_PATH;
  process.env.PATH = `${dir}${path.delimiter}${previousPath || ''}`;
  // The services read this once, at load: a test that set it for another
  // reason would otherwise reach a 7-Zip that is not this one.
  delete process.env.SEVEN_ZIP_PATH;

  return () => {
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.SEVEN_ZIP_PATH;
    else process.env.SEVEN_ZIP_PATH = previousBin;
    fs.rmSync(dir, { recursive: true, force: true });
  };
};

/** The text 7-Zip prints for an archive holding these entries. */
const fakeListing = (entries) =>
  [
    '7-Zip (z) 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov',
    '',
    'Listing archive: pack.zip',
    '',
    '--',
    'Path = pack.zip',
    'Type = zip',
    '',
    '----------',
    ...entries.map((entry) =>
      [
        `Path = ${entry.path}`,
        `Size = ${entry.size ?? 0}`,
        `Modified = ${entry.modified ?? '2026-09-16 11:22:33'}`,
        `Attributes = ${entry.directory ? 'D_ drwxr-xr-x' : 'A_ -rw-r--r--'}`,
        `Encrypted = ${entry.encrypted ? '+' : '-'}`,
        '',
      ].join('\n')
    ),
  ].join('\n');

module.exports = { useFakeSevenZip, fakeListing };
