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
 * The stand-in answers `i` with a format list, `l` by printing the listing a
 * test wrote into the archive file, and `x -so` by printing the bytes that
 * test filed under the name being asked for. So the route is decided by this
 * application rather than by an archive somebody had to commit.
 *
 * It refuses an `x` that does not carry `-spd`, which is the switch that stops
 * 7-Zip reading a name as a pattern. Nothing else would notice its absence
 * until an archive held a file called `report*.txt`.
 *
 * That is the limit of it, and it is why the suites that use a real 7-Zip stay:
 * this proves what is done with a listing, never that 7-Zip prints one.
 */

const SCRIPT = `#!/bin/sh
# Every call, for a test that needs to know how much work was asked of 7-Zip
# rather than only what came back.
if [ -n "$FAKE_7Z_LOG" ]; then
  echo "$*" >> "$FAKE_7Z_LOG"
fi
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
    sed '/^%%FAKE-7Z-CONTENT%%$/,$d' "$last"
    exit 0
    ;;
  x)
    # Everything into a directory: how a solid archive is put in the cache.
    out=""
    for arg; do case "$arg" in -o*) out="\${arg#-o}";; esac; done
    if [ -n "$out" ]; then
      for last; do :; done
      mkdir -p "$out"
      tab=$(printf '\\t')
      sed -n '/^%%FAKE-7Z-CONTENT%%$/,$p' "$last" | tail -n +2 | while IFS="$tab" read -r name body; do
        [ -n "$name" ] || continue
        mkdir -p "$out/$(dirname "$name")"
        printf '%s' "$body" > "$out/$name"
      done
      exit 0
    fi
    # The last two arguments are the archive and the entry inside it — unless
    # there is no entry, which is how one layer of a compound archive is peeled:
    # then the archive is last, and what it decompresses to is the file a test
    # filed beside it.
    for entry; do archive="$previous"; previous="$entry"; done
    if [ "$archive" = "--" ]; then
      cat "$entry.inner"
      exit $?
    fi
    # Only an extraction that names an entry needs the switch that stops 7-Zip
    # reading that name as a pattern; peeling a whole archive names nothing.
    case " $* " in
      *" -spd "*) ;;
      *) echo "fake 7z: x of one entry without -spd would read its name as a pattern" >&2; exit 1 ;;
    esac
    awk -v want="$entry" '
      seen && index($0, want "\t") == 1 { printf "%s", substr($0, length(want) + 2); found = 1 }
      /^%%FAKE-7Z-CONTENT%%$/ { seen = 1 }
      END { exit(found ? 0 : 2) }
    ' "$archive" || { echo "ERROR: No files to process" >&2; exit 2; }
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

/**
 * An archive the stand-in can answer for: the listing 7-Zip would print, and
 * then the bytes of each entry that has any, behind a marker `l` never reads.
 */
const fakeListing = (entries, { solid = false } = {}) =>
  [
    '7-Zip (z) 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov',
    '',
    'Listing archive: pack.zip',
    '',
    '--',
    'Path = pack.zip',
    `Type = ${solid ? '7z' : 'zip'}`,
    // What 7-Zip prints for an archive whose files share one compressed
    // stream, and the whole reason a cached tree exists.
    ...(solid ? ['Solid = +', 'Blocks = 1'] : []),
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
    '%%FAKE-7Z-CONTENT%%',
    ...entries
      .filter((entry) => typeof entry.content === 'string')
      .map((entry) => `${entry.path}\t${entry.content}`),
    '',
  ].join('\n');

/**
 * A compound archive: one that decompresses to another archive rather than to
 * a file, which is what a .tar.gz is. The stand-in answers `l` with the single
 * entry a real 7-Zip reports, and a whole-archive `x` with the inner listing —
 * so what the test writes as `inner` is what the cache ends up holding.
 */
const fakeCompound = ({ innerName = 'backup.tar', innerSize = 4096, entries = [] } = {}) => ({
  outer: fakeListing([{ path: innerName, size: innerSize }]),
  inner: fakeListing(entries),
});

module.exports = { useFakeSevenZip, fakeListing, fakeCompound };
