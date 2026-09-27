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

/** Output worth reading for a version: the banner is at the top of it. */
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 5_000;

/**
 * What a program prints when asked its version, stdout and stderr together —
 * pdftotext answers on stderr — or the empty string when it cannot be asked.
 * Bounded in size and in time, and it never rejects: a version is something
 * to show, never a reason for the report to fail.
 */
const readOutput = (command, args) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve('');
      return;
    }
    const chunks = [];
    let size = 0;
    const keep = (chunk) => {
      if (size >= OUTPUT_LIMIT_BYTES) return;
      chunks.push(chunk);
      size += chunk.length;
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), VERSION_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });

/**
 * Where each tool says its version, one pattern per tool.
 *
 * Anchored on the line the tool writes about itself, because a number found
 * anywhere else — a copyright year, a protocol number, a compatibility claim —
 * would be a wrong answer, and no answer is better than a wrong one. Taken
 * from each tool's own source and output, variants included: a
 * distribution's suffix (`7.1.1-1+b1`), a git build (`ripgrep 14.1.0 (rev
 * e50df40a19)`), 7-Zip's editions (`7-Zip (z)`, `(a)`, p7zip's `[64]`), and
 * openrsync, which calls itself "rsync version 2.6.9 compatible" and is not
 * rsync 2.6.9.
 */
const VERSION_PATTERNS = {
  ffmpeg: /^ffmpeg version (\S+)/m,
  ffprobe: /^ffprobe version (\S+)/m,
  ripgrep: /^ripgrep (\S+)/m,
  pdftotext: /^pdftotext version (\S+)/m,
  exiftool: /^(\d+(?:\.\d+)+)\s*$/m,
  rsync: /^rsync\s+version\s+(\S+)\s+protocol version/m,
  '7-Zip': /^7-Zip(?: \([a-z]\))?(?: \[\d+\])? (\d+\.\d+)/m,
};

/** The version a tool printed, or null when its output does not say one. */
const parseVersion = (name, output) => {
  const pattern = VERSION_PATTERNS[name];
  if (!pattern || typeof output !== 'string') return null;
  const match = output.match(pattern);
  return match ? match[1] : null;
};

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

/** How to ask the ExifTool that `source` names for its version. */
const exiftoolVersionCommand = (source) => {
  const raw = require('./rawPreviewService');
  if (source === 'environment') return [env.EXIFTOOL_PATH.trim(), ['-ver']];
  if (source === 'bundled') return ['perl', [require('exiftool-vendored.pl'), '-ver']];
  if (source === 'machine') {
    return [raw.EXIFTOOL_CANDIDATES.find((candidate) => raw.canRun(candidate)), ['-ver']];
  }
  return null;
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

  const ffmpeg = ffmpegRunner.hasFfmpeg();
  const ffprobe = ffmpegRunner.hasFfprobe();

  // Asked only of the tools that are there, each the way the service that
  // uses it runs it — the same binary, not whichever one PATH finds first.
  const asked = {
    ffmpeg: ffmpeg && [ffmpegRunner.ffmpegPath, ['-version']],
    ffprobe: ffprobe && [ffmpegRunner.ffprobePath, ['-version']],
    ripgrep: ripgrep && ['rg', ['--version']],
    pdftotext: pdftotext && ['pdftotext', ['-v']],
    exiftool: exiftool && exiftoolVersionCommand(exiftool),
    rsync: rsync && ['rsync', ['--version']],
    '7-Zip': sevenZip && [archives.SEVEN_ZIP_BIN, ['i']],
  };
  const versions = Object.fromEntries(
    await Promise.all(
      Object.entries(asked).map(async ([name, command]) => [
        name,
        command && command[0] ? parseVersion(name, await readOutput(...command)) : null,
      ])
    )
  );

  return {
    ffmpeg,
    ffprobe,
    ripgrep,
    rsync,
    pdftotext,
    exiftool,
    sevenZip,
    missingFormats,
    nativeTransfers: nativeTransferEnabled(),
    versions,
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
    versions = {},
  } = found || (await probeMachine());

  // What each tool said its version was; null where it is missing, or said
  // nothing a pattern could read.
  const versionOf = (name, available) => (available && versions[name]) || null;

  return [
    {
      name: 'ffmpeg',
      available: ffmpeg,
      version: versionOf('ffmpeg', ffmpeg),
      enables: 'videoThumbnails',
      lost: 'video thumbnails and stills from HEIC photos',
      install: 'ffmpeg',
    },
    {
      name: 'ffprobe',
      available: ffprobe,
      version: versionOf('ffprobe', ffprobe),
      enables: 'mediaDetails',
      lost: 'media durations and track lists',
      install: 'ffmpeg',
    },
    {
      name: 'ripgrep',
      available: ripgrep,
      version: versionOf('ripgrep', ripgrep),
      enables: 'fastSearch',
      lost: 'fast search inside files; a slower scan is used instead',
      install: 'ripgrep',
    },
    {
      name: 'pdftotext',
      available: pdftotext,
      version: versionOf('pdftotext', pdftotext),
      enables: 'pdfSearch',
      lost: 'the text of PDFs in search',
      install: 'poppler-utils',
    },
    {
      name: 'exiftool',
      available: Boolean(exiftool),
      version: versionOf('exiftool', Boolean(exiftool)),
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
      version: versionOf('rsync', rsync),
      used: nativeTransfers,
      enables: 'copyProgress',
      lost: 'progress reporting on large copies and moves',
      install: 'rsync',
    },
    {
      name: '7-Zip',
      available: sevenZip,
      version: versionOf('7-Zip', sevenZip),
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
  const installed = relevant.filter((capability) => capability.available);
  const present = installed.map((c) => c.name);
  const versions = Object.fromEntries(installed.map((c) => [c.name, c.version]));
  const named = installed.map((c) => (c.version ? `${c.name} ${c.version}` : c.name));
  logger.info(
    { available: present, versions },
    `Optional tools found: ${named.join(', ') || 'none'}`
  );

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

module.exports = { describe, report, parseVersion };
