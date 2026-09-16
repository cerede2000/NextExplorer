const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const { archives } = require('../config/index');
const { AppError } = require('../errors/AppError');
const { isArchivePasswordError } = require('./archiveService');

const execFileAsync = promisify(execFile);

const SEVEN_ZIP_BIN = process.env.SEVEN_ZIP_PATH || '7z';

/**
 * Looking inside an archive without unpacking it.
 *
 * Answering "what is in this backup?" cost a full extraction: forty gigabytes
 * written to disk to read one filename. 7-Zip already knows — `7z l -slt`
 * prints a record per entry, and the same command already runs before every
 * extraction to refuse an archive that would expand past its limit, where
 * everything but the sum of the sizes is thrown away.
 *
 * Two things shape everything here. An archive is somebody else's file, so
 * every name in it is hostile input: it is never used to build a path on disk,
 * and what it is allowed to mean is decided here rather than by the shell or
 * the filesystem. And the listing is the whole archive, always: there is no
 * such thing as listing one folder of a zip, so the level being looked at is
 * cut out of the full listing rather than asked for.
 */

/** How long a listing may take before it is somebody waiting for nothing. */
const LIST_TIMEOUT_MS = 30_000;

/** What `7z l -slt` may print. Beyond it the listing is refused, not truncated. */
const LIST_MAX_BUFFER = 32 * 1024 * 1024;

/** 7-Zip separates its own header from the entries with exactly ten dashes. */
const ENTRY_SEPARATOR = /^----------\r?$/m;

/**
 * One `Key = Value` record per entry, as 7-Zip prints them.
 *
 * Split on the *first* ` = `, because a filename may hold one too. A line with
 * no separator at all is the rest of a value that had a newline in it — a name
 * can carry one — and belongs to the key above rather than being dropped,
 * which would leave a truncated name that reads like a different file.
 */
const parseRecords = (stdout) => {
  const separated = String(stdout).split(ENTRY_SEPARATOR);
  if (separated.length < 2) return [];

  const records = [];
  let current = null;
  let lastKey = null;

  for (const rawLine of separated.slice(1).join('\n').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') {
      if (current) records.push(current);
      current = null;
      lastKey = null;
      continue;
    }
    const at = line.indexOf(' = ');
    if (at === -1) {
      if (current && lastKey) current[lastKey] += `\n${line}`;
      continue;
    }
    if (!current) current = {};
    lastKey = line.slice(0, at);
    current[lastKey] = line.slice(at + 3);
  }
  if (current) records.push(current);

  return records;
};

/**
 * Where an entry sits inside the archive, or nothing when it points outside.
 *
 * A crafted archive holds `../../etc/passwd`, or `/etc/passwd`, or a Windows
 * path with backslashes. None of these is a place inside the archive, and an
 * entry that claims one is left out of the listing and counted instead: what
 * cannot be shown as somewhere is not shown as somewhere.
 */
const entryPathOf = (rawPath) => {
  if (typeof rawPath !== 'string' || rawPath === '') return null;

  const segments = rawPath.replace(/\\/g, '/').split('/');
  const kept = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    kept.push(segment);
  }
  // A drive letter is not a folder name: `C:/Windows` says the same thing as
  // an absolute path, in the other family of systems.
  if (kept.length === 0 || /^[A-Za-z]:$/.test(kept[0])) return null;
  return kept.join('/');
};

/** 7-Zip says so twice, in different formats: take either. */
const isDirectoryRecord = (record) =>
  record.Folder === '+' || /^D/.test(String(record.Attributes || ''));

const sizeOf = (record) => {
  const size = Number.parseInt(record.Size, 10);
  return Number.isFinite(size) && size >= 0 ? size : null;
};

/** 7-Zip prints local time as `2026-09-16 11:22:33`, or nothing at all. */
const modifiedOf = (record) => {
  const written = String(record.Modified || '').trim();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(written) ? written.slice(0, 19) : null;
};

/** Everything the archive says about itself, entry by entry. */
const describeEntries = (stdout) => {
  const entries = [];
  let outside = 0;

  for (const record of parseRecords(stdout)) {
    if (!('Path' in record)) continue;
    const entryPath = entryPathOf(record.Path);
    if (entryPath === null) {
      outside += 1;
      continue;
    }
    entries.push({
      path: entryPath,
      isDirectory: isDirectoryRecord(record),
      size: sizeOf(record),
      modified: modifiedOf(record),
      encrypted: record.Encrypted === '+',
    });
  }

  return { entries, outside };
};

/**
 * One level of the archive, as a listing of folders and files.
 *
 * Most archives carry no record for their folders — a zip of `docs/a.txt` may
 * hold that one entry and nothing else — so the folders at a level are the
 * ones its entries imply. A real record for a folder is preferred when there
 * is one, because it carries a date; a folder nothing names keeps the shape
 * and says nothing it does not know.
 */
const levelOf = (entries, inside) => {
  const prefix = inside ? `${inside}/` : '';
  const folders = new Map();
  const files = [];
  let exists = inside === '';

  for (const entry of entries) {
    if (inside && entry.path === inside) {
      exists = true;
      continue;
    }
    if (!entry.path.startsWith(prefix)) continue;

    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf('/');

    if (slash === -1) {
      if (entry.isDirectory) {
        folders.set(rest, { ...entry, name: rest });
      } else {
        files.push({ ...entry, name: rest });
      }
      continue;
    }

    exists = true;
    const name = rest.slice(0, slash);
    if (!folders.has(name)) {
      folders.set(name, {
        name,
        path: `${prefix}${name}`,
        isDirectory: true,
        size: null,
        modified: null,
        encrypted: false,
      });
    }
  }

  if (folders.size > 0 || files.length > 0) exists = true;

  const byName = (left, right) => left.name.localeCompare(right.name);
  return {
    exists,
    entries: [...[...folders.values()].sort(byName), ...files.sort(byName)],
  };
};

/**
 * A refusal the caller can act on: an archive that is encrypted is a different
 * answer from one that is damaged, and a panel says something different for
 * each. The sentence travels with a code so it can be said in the reader's own
 * language rather than in this one.
 */
const listingError = (message, code, statusCode = 400) => new AppError(message, statusCode, code);

/**
 * Read an archive's table of contents.
 *
 * The whole archive is listed whatever level is being looked at: 7-Zip has no
 * way to list one folder, and an archive small enough to browse is one whose
 * listing is cheap. The cost that matters is the one this avoids — writing the
 * contents to disk to find out what they are called.
 */
const readArchiveListing = async (archiveAbsolutePath) => {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      SEVEN_ZIP_BIN,
      ['l', '-slt', '-y', '-p', '--', archiveAbsolutePath],
      { timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER }
    ));
  } catch (error) {
    // An archive whose table of contents is itself encrypted cannot be read at
    // all without the password. `-p` above answers the prompt with an empty
    // one rather than leaving 7-Zip waiting on a terminal that is not there.
    if (isArchivePasswordError(error)) {
      throw listingError(
        'This archive is protected by a password and cannot be browsed.',
        'ARCHIVE_ENCRYPTED',
        409
      );
    }
    if (error?.code === 'ENOENT') {
      throw listingError('Archives cannot be read on this server.', 'ARCHIVE_TOOL_MISSING', 503);
    }
    throw listingError('This archive could not be read.', 'ARCHIVE_UNREADABLE', 422);
  }

  const { entries, outside } = describeEntries(stdout);
  if (entries.length > archives.maxEntries) {
    throw listingError(
      `This archive holds more than ${archives.maxEntries} entries and was not opened.`,
      'ARCHIVE_TOO_MANY_ENTRIES',
      413
    );
  }

  return { entries, outside };
};

/**
 * What is at one level of an archive.
 *
 * @param {string} archiveAbsolutePath the archive itself, on disk
 * @param {string} [inside] the folder within it, '' for the top
 */
const browseArchive = async (archiveAbsolutePath, inside = '') => {
  // Where the caller says it is looking is held to the same rule as a name
  // read out of the archive: a position that points anywhere but inside is not
  // a position, whoever wrote it.
  const position = inside ? entryPathOf(inside) : '';
  if (position === null) {
    throw listingError('That is not a folder inside this archive.', 'ARCHIVE_BAD_POSITION', 400);
  }

  const { entries, outside } = await readArchiveListing(archiveAbsolutePath);
  const level = levelOf(entries, position);

  if (!level.exists) {
    throw listingError('That folder is not in this archive.', 'ARCHIVE_ENTRY_NOT_FOUND', 404);
  }

  return {
    inside: position,
    entries: level.entries,
    total: entries.length,
    outside,
  };
};

/**
 * One entry of an archive, as the archive itself describes it.
 *
 * The name comes from whoever asked, so it is looked up in the listing rather
 * than taken on trust: what is read is an entry this archive holds, under
 * exactly the name it holds it under. That lookup is also where the size and
 * the encryption come from, which are the two things the answer needs and the
 * caller must not be allowed to assert.
 */
const findArchiveEntry = async (archiveAbsolutePath, entryPath) => {
  const wanted = entryPathOf(entryPath);
  if (wanted === null) {
    throw listingError('That is not a file inside this archive.', 'ARCHIVE_BAD_POSITION', 400);
  }

  const { entries } = await readArchiveListing(archiveAbsolutePath);
  const found = entries.find((entry) => entry.path === wanted);
  if (!found) {
    throw listingError('That file is not in this archive.', 'ARCHIVE_ENTRY_NOT_FOUND', 404);
  }
  if (found.isDirectory) {
    throw listingError('That is a folder, not a file.', 'ARCHIVE_ENTRY_IS_FOLDER', 400);
  }
  if (found.encrypted) {
    throw listingError(
      'This file is encrypted and cannot be read without its password.',
      'ARCHIVE_ENCRYPTED',
      409
    );
  }

  return found;
};

/** How long one entry may take to come out before nobody is still waiting. */
const READ_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The bytes of one entry, straight out of the archive and nowhere else.
 *
 * `-so` writes to standard output, so nothing is ever placed on disk — the
 * whole point of this, and the thing a later change would quietly lose by
 * extracting to a temporary folder first.
 *
 * `-spd` matters as much: without it 7-Zip reads the name as a pattern, so an
 * entry genuinely called `report*.txt` would come back as every report in the
 * archive, joined end to end. The name is checked against the listing before
 * it gets here, which stops it naming another archive's business, but not one
 * name standing for several of its own.
 *
 * stderr is read and kept short on purpose: left unread it fills its pipe at
 * 64 KB and the extraction stops there, holding the connection open.
 */
const openArchiveEntry = (archiveAbsolutePath, entryPath) => {
  const child = spawn(
    SEVEN_ZIP_BIN,
    ['x', '-so', '-y', '-p', '-spd', '--', archiveAbsolutePath, entryPath],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let output = '';
  child.stderr.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-2000);
  });

  const timer = setTimeout(() => child.kill('SIGKILL'), READ_TIMEOUT_MS);
  timer.unref?.();

  const finished = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(
        error?.code === 'ENOENT'
          ? listingError('Archives cannot be read on this server.', 'ARCHIVE_TOOL_MISSING', 503)
          : error
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`7z exited with code ${code}: ${output.trim().slice(-500)}`);
      reject(
        isArchivePasswordError(error)
          ? listingError(
              'This file is encrypted and cannot be read without its password.',
              'ARCHIVE_ENCRYPTED',
              409
            )
          : listingError('This entry could not be read.', 'ARCHIVE_UNREADABLE', 422)
      );
    });
  });

  return {
    stdout: child.stdout,
    finished,
    stop: () => {
      clearTimeout(timer);
      child.kill('SIGKILL');
    },
  };
};

module.exports = {
  browseArchive,
  findArchiveEntry,
  openArchiveEntry,
  readArchiveListing,
  describeEntries,
  parseRecords,
  entryPathOf,
  levelOf,
  SEVEN_ZIP_BIN,
};
