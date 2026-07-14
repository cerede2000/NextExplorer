const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);

// Archive extensions the app is willing to offer for extraction, provided the
// local 7-Zip build actually supports them (checked against `7z i` at startup).
// Kept as a whitelist so container-ish formats 7-Zip can technically read
// (docx, apk, exe…) are not presented as archives in the UI.
const CANDIDATE_EXTENSIONS = [
  '7z',
  'zip',
  'iso',
  'rar',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'tbz2',
  'xz',
  'txz',
  'cab',
  'wim',
  'cpio',
  'rpm',
  'deb',
  'z',
  'lzh',
  'arj',
  'zst',
];

// Compound extensions that decompress to an inner tar archive. 7-Zip only
// peels one layer per run, so these need a second pass on the produced .tar.
const TAR_WRAPPER_EXTENSIONS = new Set(['gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'z']);

const SEVEN_ZIP_BIN = process.env.SEVEN_ZIP_PATH || '7z';

let supportedExtensionsPromise = null;

/**
 * Probe the local 7-Zip once and derive the extraction formats it supports.
 * `7z i` lists every compiled-in format with its extensions, so this stays
 * accurate across builds (e.g. Alpine builds that ship without the RAR codec).
 * Falls back to plain .zip (handled by the bundled JS extractor) when 7-Zip
 * is not installed at all.
 */
const probeSupportedExtensions = async () => {
  try {
    const { stdout } = await execFileAsync(SEVEN_ZIP_BIN, ['i'], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const listed = new Set(
      stdout
        .toLowerCase()
        .split('\n')
        .flatMap((line) => line.split(/\s+/))
        .filter((token) => /^[a-z0-9]{1,5}$/.test(token))
    );
    const supported = CANDIDATE_EXTENSIONS.filter((ext) => listed.has(ext));
    // Compound tarball extensions piggy-back on the base codec being present.
    if (listed.has('gzip') || listed.has('gz')) supported.push('tgz');
    if (listed.has('bzip2')) supported.push('tbz2');
    if (listed.has('xz')) supported.push('txz');
    const unique = [...new Set(supported)];
    logger.info({ bin: SEVEN_ZIP_BIN, extensions: unique }, 'Archive extraction formats detected');
    return unique;
  } catch (error) {
    logger.warn(
      { bin: SEVEN_ZIP_BIN, err: error?.message },
      '7-Zip unavailable; archive extraction limited to .zip'
    );
    return ['zip'];
  }
};

const getSupportedArchiveExtensions = () => {
  if (!supportedExtensionsPromise) {
    supportedExtensionsPromise = probeSupportedExtensions();
  }
  return supportedExtensionsPromise;
};

const isSevenZipAvailable = async () => {
  const extensions = await getSupportedArchiveExtensions();
  // The zip-only fallback list means the probe failed.
  return !(extensions.length === 1 && extensions[0] === 'zip');
};

/**
 * Base name an extracted folder should take for a given archive filename:
 * strips the archive extension, plus the inner `.tar` of compound tarballs
 * (backup.tar.gz -> backup).
 */
const archiveBaseName = (filename) => {
  const ext = path.extname(filename).slice(1).toLowerCase();
  let base = path.basename(filename, path.extname(filename));
  if (TAR_WRAPPER_EXTENSIONS.has(ext) && base.toLowerCase().endsWith('.tar')) {
    base = base.slice(0, -4);
  }
  return base || 'Archive';
};

const runSevenZipExtract = async (archiveAbsolutePath, destinationAbsolutePath) => {
  // -y assume yes, -bd no progress indicator, -o output dir (no space allowed).
  await execFileAsync(
    SEVEN_ZIP_BIN,
    ['x', '-y', '-bd', `-o${destinationAbsolutePath}`, archiveAbsolutePath],
    { timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
  );
};

/**
 * Extract an archive into the given (existing, empty) destination folder.
 * Compound tarballs are peeled in two passes; the intermediate .tar is
 * removed so the folder holds the real content.
 */
const extractArchive = async (archiveAbsolutePath, destinationAbsolutePath) => {
  const ext = path.extname(archiveAbsolutePath).slice(1).toLowerCase();

  await runSevenZipExtract(archiveAbsolutePath, destinationAbsolutePath);

  if (TAR_WRAPPER_EXTENSIONS.has(ext)) {
    const entries = await fs.readdir(destinationAbsolutePath);
    if (entries.length === 1 && entries[0].toLowerCase().endsWith('.tar')) {
      const innerTar = path.join(destinationAbsolutePath, entries[0]);
      await runSevenZipExtract(innerTar, destinationAbsolutePath);
      await fs.rm(innerTar, { force: true });
    }
  }
};

module.exports = {
  getSupportedArchiveExtensions,
  isSevenZipAvailable,
  extractArchive,
  archiveBaseName,
};
