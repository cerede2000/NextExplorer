const path = require('path');
const fs = require('fs/promises');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const logger = require('../utils/logger');
const { archives } = require('../config/index');

const execFileAsync = promisify(execFile);

// Whitelist of extensions the app may offer for extraction, provided the
// local 7-Zip build actually supports them (checked against `7z i` at
// startup). Configurable through ARCHIVE_EXTENSIONS (see config/index.js).
const CANDIDATE_EXTENSIONS = Array.isArray(archives?.extensions) ? archives.extensions : ['zip'];

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

const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run one 7-Zip command. `-bsp1` sends the percentage indicator to stdout, so
 * progress can be parsed from the output stream and forwarded to the caller
 * (0-100 per run).
 */
const runSevenZip = (args, onPercent) =>
  new Promise((resolve, reject) => {
    const child = spawn(SEVEN_ZIP_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: EXTRACT_TIMEOUT_MS,
    });

    let stderrTail = '';

    child.stdout.on('data', (chunk) => {
      if (typeof onPercent !== 'function') return;
      // Progress lines look like "  42% 137 - some/file"; keep the last match.
      const matches = String(chunk).match(/(\d{1,3})%/g);
      if (matches?.length) {
        const percent = Number.parseInt(matches[matches.length - 1], 10);
        if (Number.isFinite(percent)) onPercent(Math.min(100, Math.max(0, percent)));
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        onPercent?.(100);
        resolve();
      } else {
        reject(new Error(`7z exited with code ${code}: ${stderrTail.trim().slice(-500)}`));
      }
    });
  });

const runSevenZipExtract = (archiveAbsolutePath, destinationAbsolutePath, onPercent) =>
  runSevenZip(['x', '-y', '-bsp1', `-o${destinationAbsolutePath}`, archiveAbsolutePath], onPercent);

/**
 * Create a .zip archive from the given absolute paths, reporting progress
 * through `onPercent(0-100)`. 7-Zip stores each entry under its base name,
 * matching the behaviour of the previous in-memory implementation — but the
 * archive is streamed to disk instead of being assembled in the Node heap.
 */
const createZipArchive = (sourceAbsolutePaths, zipAbsolutePath, onPercent) =>
  runSevenZip(['a', '-tzip', '-y', '-bsp1', zipAbsolutePath, ...sourceAbsolutePaths], onPercent);

/**
 * Extract an archive into the given (existing, empty) destination folder,
 * reporting overall progress through `onPercent(0-100)`. Compound tarballs
 * are peeled in two passes (each mapped to half of the progress range); the
 * intermediate .tar is removed so the folder holds the real content.
 */
const extractArchive = async (archiveAbsolutePath, destinationAbsolutePath, onPercent) => {
  const ext = path.extname(archiveAbsolutePath).slice(1).toLowerCase();
  const isCompound = TAR_WRAPPER_EXTENSIONS.has(ext);

  await runSevenZipExtract(
    archiveAbsolutePath,
    destinationAbsolutePath,
    isCompound ? (p) => onPercent?.(Math.round(p / 2)) : onPercent
  );

  if (isCompound) {
    const entries = await fs.readdir(destinationAbsolutePath);
    if (entries.length === 1 && entries[0].toLowerCase().endsWith('.tar')) {
      const innerTar = path.join(destinationAbsolutePath, entries[0]);
      await runSevenZipExtract(innerTar, destinationAbsolutePath, (p) =>
        onPercent?.(50 + Math.round(p / 2))
      );
      await fs.rm(innerTar, { force: true });
    } else {
      onPercent?.(100);
    }
  }
};

module.exports = {
  getSupportedArchiveExtensions,
  isSevenZipAvailable,
  extractArchive,
  createZipArchive,
  archiveBaseName,
};
