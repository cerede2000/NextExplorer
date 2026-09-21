const { spawn } = require('child_process');

const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * What the optional tools make possible here, and what is missing.
 *
 * Each tool is already probed by the service that uses it, and nearly all of
 * those probes were silent: at start-up the log said that ffmpeg was absent and
 * which archive formats 7-Zip had, and nothing about ripgrep, pdftotext, rsync
 * or ExifTool. Somebody checking an installation had to know every tool by
 * name and go looking for its absence (#9).
 *
 * So one report, read once at start and on demand from the About page: every
 * optional capability, whether it is there, what it gives, and how to get it
 * when it is not. Nothing here starts a worker or keeps a process: each probe
 * is the one its own service already runs, or a `--version`.
 */

/** Whether a program starts. Some builds of some tools exit non-zero on `-v`. */
const probe = (command, args, { anyExit = false } = {}) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(anyExit || code === 0));
  });

/**
 * Where RAW previews would come from, or null when there is no ExifTool to run.
 *
 * The bundled copy is a Perl program, so it runs only where Perl does — which
 * is why `perl` is in the list of optional tools at all.
 */
const exiftoolSource = async () => {
  const raw = require('./rawPreviewService');
  const named = typeof env.EXIFTOOL_PATH === 'string' ? env.EXIFTOOL_PATH.trim() : '';
  if (named) return raw.canRun(named) ? 'environment' : null;
  if (raw.hasVendoredExiftool()) return (await probe('perl', ['-v'])) ? 'bundled' : null;
  return raw.EXIFTOOL_CANDIDATES.some((candidate) => raw.canRun(candidate)) ? 'machine' : null;
};

/**
 * Every optional capability, in the order a reader would look for it.
 *
 * `name` and `enables` are stable keys the About page translates; `install` is
 * a Debian package name, the one the installer offers and the documentation
 * uses, and is left as it is in every language because it is typed, not read.
 */
/** What this machine has, asked of the services that use each tool. */
const probeMachine = async () => {
  const ffmpegRunner = require('./ffmpegRunner');
  const { hasPdfToText } = require('./pdfTextExtract');
  const archives = require('./archiveService');
  const { nativeTransferEnabled } = require('./fileTransferService');

  const [ripgrep, rsync, pdftotext, exiftool, sevenZip, missingFormats] = await Promise.all([
    probe('rg', ['--version']),
    probe('rsync', ['--version']),
    hasPdfToText(),
    exiftoolSource(),
    archives.isSevenZipAvailable(),
    archives.getMissingArchiveExtensions(),
  ]);

  return {
    ffmpeg: ffmpegRunner.hasFfmpeg(),
    ffprobe: ffmpegRunner.hasFfprobe(),
    ripgrep,
    rsync,
    pdftotext,
    exiftool,
    sevenZip,
    missingFormats,
    nativeTransfers: nativeTransferEnabled(),
  };
};

/**
 * @param {object} [found] what the probes answered; the machine's own when
 *   omitted. Passed in by the tests, which cannot choose what CI has installed.
 */
const describe = async (found) => {
  const {
    ffmpeg,
    ffprobe,
    ripgrep,
    rsync,
    pdftotext,
    exiftool,
    sevenZip,
    missingFormats,
    nativeTransfers,
  } = found || (await probeMachine());

  return [
    {
      name: 'ffmpeg',
      available: ffmpeg,
      enables: 'videoThumbnails',
      lost: 'video thumbnails and stills from HEIC photos',
      install: 'ffmpeg',
    },
    {
      name: 'ffprobe',
      available: ffprobe,
      enables: 'mediaDetails',
      lost: 'media durations and track lists',
      install: 'ffmpeg',
    },
    {
      name: 'ripgrep',
      available: ripgrep,
      enables: 'fastSearch',
      lost: 'fast search inside files; a slower scan is used instead',
      install: 'ripgrep',
    },
    {
      name: 'pdftotext',
      available: pdftotext,
      enables: 'pdfSearch',
      lost: 'the text of PDFs in search',
      install: 'poppler-utils',
    },
    {
      name: 'exiftool',
      available: Boolean(exiftool),
      source: exiftool || null,
      enables: 'rawPreviews',
      lost: 'previews of RAW photos',
      install: 'libimage-exiftool-perl',
    },
    {
      name: 'rsync',
      // Only the native transfer engine uses it; with the streaming one its
      // absence costs nothing and saying otherwise would send somebody to
      // install a tool for nothing.
      available: rsync,
      used: nativeTransfers,
      enables: 'copyProgress',
      lost: 'progress reporting on large copies and moves',
      install: 'rsync',
    },
    {
      name: '7-Zip',
      available: sevenZip,
      enables: 'archives',
      lost: 'browsing and extracting any archive but .zip',
      install: '7zip',
      missingFormats: sevenZip ? missingFormats : [],
      // Debian's 7zip dropped the RAR codec to stay within the DFSG; the
      // package that puts it back is in non-free.
      ...(sevenZip && missingFormats.includes('rar') ? { installMissing: '7zip-rar' } : {}),
    },
  ];
};

/** One line for what is there, and one each for what is not and why it matters. */
const report = async (found) => {
  let capabilities;
  try {
    capabilities = await describe(found);
  } catch (error) {
    logger.warn({ err: error }, 'Could not work out which optional tools are installed');
    return null;
  }

  const relevant = capabilities.filter((capability) => capability.used !== false);
  const present = relevant.filter((capability) => capability.available).map((c) => c.name);
  logger.info({ available: present }, `Optional tools found: ${present.join(', ') || 'none'}`);

  for (const capability of relevant) {
    if (!capability.available) {
      logger.warn(
        { tool: capability.name, install: capability.install },
        `${capability.name} not found. Without it: ${capability.lost}. ` +
          `Package: ${capability.install}`
      );
    } else if (capability.missingFormats?.length) {
      logger.warn(
        {
          tool: capability.name,
          missing: capability.missingFormats,
          install: capability.installMissing || null,
        },
        `${capability.name} cannot open ${capability.missingFormats.join(', ')}` +
          (capability.installMissing ? `. Package: ${capability.installMissing}` : '')
      );
    }
  }
  return capabilities;
};

module.exports = { describe, report };
