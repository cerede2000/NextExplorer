const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const readline = require('readline');

const { normalizeRelativePath } = require('../utils/pathUtils');
const { pathExists } = require('../utils/fsUtils');
const { excludedFiles, hiddenFiles, search: searchConfig } = require('../config/index');
const { resolvePathWithAccess, getAccessInfo } = require('../services/accessManager');
const asyncHandler = require('../utils/asyncHandler');
const { ValidationError, NotFoundError, ForbiddenError } = require('../errors/AppError');
const { createPermissionResolver } = require('../services/accessControlService');
const {
  findOfficeTextMatch,
  isOfficeDocument,
  SUPPORTED_EXTENSIONS: OFFICE_EXTENSIONS,
} = require('../services/officeTextExtract');
const logger = require('../utils/logger');
const { getSettings, getUserSettings } = require('../services/settingsService');

const router = express.Router();

// Constants
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const CONTENT_FALLBACK_MAX_SIZE =
  searchConfig?.maxFileSizeBytes > 0 ? searchConfig.maxFileSizeBytes : 5 * 1024 * 1024;

// Cache ripgrep availability (Optimization #4)
let ripgrepAvailable = null;

// Utilities
const toLimit = (value, def = DEFAULT_LIMIT) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : def;
};

const isDirectory = async (p) => {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
};

// Cached ripgrep check (Optimization #4)
const hasRipgrep = async () => {
  if (ripgrepAvailable !== null) return ripgrepAvailable;

  ripgrepAvailable = await new Promise((resolve) => {
    const child = spawn('rg', ['--version']);
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });

  return ripgrepAvailable;
};

// Search implementations
/**
 * Arguments for a content search.
 *
 * Exported so the `--` separator can be tested without ripgrep on the machine:
 * the route falls back to a JavaScript scan when ripgrep is missing, so an
 * end-to-end test passes there while never exercising this at all.
 */
const buildContentSearchArgs = (term, globArgs = [], maxFileSize = null) => {
  const args = [
    '--json', // Use JSON output for faster parsing (Optimization #2)
    '-n',
    '-H',
    '--hidden',
    '--no-messages',
    '--smart-case',
    '-F',
    '-m',
    '1',
    ...globArgs,
    // Everything after `--` is positional. Without it a search term starting
    // with `-` is parsed as a ripgrep flag, and options such as `--pre=<cmd>`
    // run that command against every scanned file.
    '--',
    term,
    '.',
  ];

  // Spawn arguments are strings; passing the number through and letting the
  // conversion happen somewhere else is how a value stops being checkable.
  if (maxFileSize) args.unshift('--max-filesize', String(maxFileSize));
  return args;
};

/**
 * Everything ripgrep is given for a content search, composed in one place.
 *
 * Exported so the wiring can be tested where ripgrep is not installed — which
 * is where this went wrong: the raw `SEARCH_MAX_FILESIZE` was handed over
 * instead of the parsed byte count, ripgrep refused the flag, and nothing
 * anywhere ran the code that would have shown it.
 */
const contentSearchArgs = (term, includeHiddenFiles = false) =>
  buildContentSearchArgs(
    term,
    buildRipgrepArgs(includeHiddenFiles),
    searchConfig?.maxFileSizeBytes
  );

const buildRipgrepArgs = (includeHiddenFiles = false) => [
  '-g',
  '!.git',
  '-g',
  '!node_modules',
  '-g',
  '!dist',
  '-g',
  '!build',
  ...(includeHiddenFiles ? [] : hiddenFiles.ripgrepGlobExcludes.flatMap((glob) => ['-g', glob])),
];

const normalizePath = (p, relBasePath) => {
  const normalized = p.replace(/\\/g, '/');
  return relBasePath ? path.posix.join(relBasePath, normalized) : normalized;
};

const shouldIgnore = (name, includeHiddenFiles = false) =>
  IGNORED_DIRS.has(name) ||
  excludedFiles.includes(name) ||
  (!includeHiddenFiles && hiddenFiles.isHiddenName(name));

const extractDirMatches = (fullPath, needle, includeHiddenFiles = false) => {
  const dirs = new Set();
  const dirPath = path.posix.dirname(fullPath);

  if (dirPath && dirPath !== '.') {
    const parts = dirPath.split('/');
    let acc = '';

    for (const part of parts) {
      if (!part || shouldIgnore(part, includeHiddenFiles)) continue;
      acc = acc ? `${acc}/${part}` : part;
      if (part.toLowerCase().includes(needle)) dirs.add(acc);
    }
  }

  return dirs;
};

const formatResult = (rel, kind, line, lineNumber) => {
  const parent = path.posix.dirname(rel);
  const item = {
    name: path.posix.basename(rel),
    path: parent === '.' ? '' : parent,
    kind,
  };

  if (line != null) {
    item.matchLine = line;
    if (Number.isFinite(lineNumber)) item.matchLineNumber = lineNumber;
  }

  return item;
};

// Helper to safely parse JSON lines (Optimization #2)
const parseJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

// Optimized: Stream file list results (Optimization #1 & #3)
async function* streamFileListMatches(
  baseAbsPath,
  relBasePath,
  needle,
  seenPaths,
  dirSet,
  shouldInclude,
  includeHiddenFiles = false
) {
  const globArgs = buildRipgrepArgs(includeHiddenFiles);
  const fileListProcess = spawn('rg', ['--files', '--hidden', '--no-messages', ...globArgs], {
    cwd: baseAbsPath,
  });

  const rl = readline.createInterface({
    input: fileListProcess.stdout,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!includeHiddenFiles && hiddenFiles.isHiddenPath(trimmed)) continue;

      const fullRel = normalizePath(trimmed, relBasePath);

      // Extract and yield directory matches immediately
      for (const dirPath of extractDirMatches(fullRel, needle, includeHiddenFiles)) {
        if (!dirSet.has(dirPath) && !seenPaths.has(dirPath)) {
          dirSet.add(dirPath);
          seenPaths.add(dirPath);
          if (await shouldInclude(dirPath)) {
            yield formatResult(dirPath, 'dir');
          }
        }
      }

      // Check filename match and yield immediately
      const baseName = path.posix.basename(fullRel).toLowerCase();
      if (baseName.includes(needle) && !seenPaths.has(fullRel)) {
        seenPaths.add(fullRel);
        if (await shouldInclude(fullRel)) {
          yield formatResult(fullRel, 'file');
        }
      }
    }
  } finally {
    rl.close();
    fileListProcess.kill('SIGTERM');
  }
}

// Optimized: Stream content matches with JSON output (Optimization #1 & #2)
async function* streamContentMatches(
  baseAbsPath,
  relBasePath,
  term,
  seenPaths,
  shouldInclude,
  includeHiddenFiles = false
) {
  const contentArgs = contentSearchArgs(term, includeHiddenFiles);

  // The parsed byte count, never the raw setting. `SEARCH_MAX_FILESIZE=5MB` —
  // the form our own README suggests — went to ripgrep verbatim, and ripgrep
  // only accepts `K`, `M` or `G`. It answered `invalid format for size '5MB'`,
  // exited, and searched nothing: content search returned no results at all
  // while filename search, a separate invocation without this flag, went on
  // working. With --no-messages set and stderr unread, it did it in silence.

  const contentProcess = spawn('rg', contentArgs, { cwd: baseAbsPath });

  // Whatever ripgrep has to say about how it was called. `--no-messages`
  // silences per-file errors, not usage ones, and nothing was reading this: a
  // refused flag looked exactly like a search that found nothing.
  let stderr = '';
  contentProcess.stderr?.on('data', (chunk) => {
    if (stderr.length < 2000) stderr += String(chunk);
  });
  contentProcess.on('close', (code) => {
    // 1 is ripgrep's "no matches", which is an answer rather than a failure.
    if (code !== null && code > 1) {
      logger.warn({ code, stderr: stderr.trim() }, 'Content search failed to run');
    }
  });

  const rl = readline.createInterface({
    input: contentProcess.stdout,
    crlfDelay: Infinity,
  });

  // The consumer stops as soon as it has enough results. Without this the
  // process would keep scanning the whole tree in the background.
  try {
    for await (const line of rl) {
      const data = parseJsonLine(line);
      if (!data || data.type !== 'match') continue;

      const filePath = data.data?.path?.text;
      if (!filePath) continue;
      // `rg` reports content-search paths as `./file`, unlike `rg --files`.
      // That prefix is not a hidden-file marker; checking it first made every
      // content match look hidden and in particular hid literal terms such as
      // `--pre=...` even though the arguments were safely protected by `--`.
      const normalizedFilePath = filePath.replace(/^(?:\.\/|\.\\)+/, '');
      if (!includeHiddenFiles && hiddenFiles.isHiddenPath(normalizedFilePath)) continue;

      const lineNum = data.data?.line_number;
      const lineText = data.data?.lines?.text;

      const rel = normalizePath(normalizedFilePath, relBasePath);
      if (seenPaths.has(rel)) continue;

      seenPaths.add(rel);
      if (await shouldInclude(rel)) {
        yield formatResult(rel, 'file', lineText, lineNum);
      }
    }
  } finally {
    rl.close();
    contentProcess.kill('SIGTERM');
  }
}

/**
 * Yield from several generators as their results arrive.
 *
 * The two passes used to be drained one after the other despite the comment
 * that said they ran in parallel, and the route stops at its result limit. So
 * a term that matched a hundred filenames spent the whole budget before the
 * content search had produced anything — and content matches, the ones people
 * come to a deep search for, never appeared at all. The content search did not
 * even start until the entire file listing had been walked.
 */
async function* mergeResults(...generators) {
  const next = new Map();
  for (const generator of generators) {
    next.set(
      generator,
      generator.next().then((result) => ({ generator, result }))
    );
  }

  try {
    while (next.size > 0) {
      // eslint-disable-next-line no-await-in-loop
      const { generator, result } = await Promise.race(next.values());
      if (result.done) {
        next.delete(generator);
        continue;
      }

      next.set(
        generator,
        generator.next().then((value) => ({ generator, result: value }))
      );
      yield result.value;
    }
  } finally {
    // The consumer stops as soon as it has enough. Each generator closes its
    // own ripgrep process in its `finally`; this is what gets them there.
    for (const generator of next.keys()) {
      generator.return?.();
    }
  }
}

/**
 * Matches inside Office documents.
 *
 * `.docx`, `.xlsx` and `.pptx` are zip archives, so ripgrep sees compressed
 * bytes and finds nothing in them however the search is configured. Reading
 * them costs an unzip and a parse per document, so this is bounded three ways:
 * only these extensions, only files under the configured size, and only so
 * many documents per search.
 */
const OFFICE_DOCUMENT_LIMIT = 500;

async function* streamOfficeMatches(
  baseAbsPath,
  relBasePath,
  term,
  seenPaths,
  shouldInclude,
  includeHiddenFiles = false
) {
  const needle = term.toLowerCase();
  const maxBytes = searchConfig?.maxFileSizeBytes > 0 ? searchConfig.maxFileSizeBytes : null;
  let examined = 0;

  let entries;
  try {
    entries = await fs.readdir(baseAbsPath, { withFileTypes: true, recursive: true });
  } catch (err) {
    logger.debug({ err }, 'Could not list documents for the content search');
    return;
  }

  for (const entry of entries) {
    if (examined >= OFFICE_DOCUMENT_LIMIT) return;
    if (!entry.isFile()) continue;

    const extension = path.extname(entry.name).slice(1).toLowerCase();
    if (!OFFICE_EXTENSIONS.includes(extension)) continue;

    const parent = path.relative(baseAbsPath, entry.parentPath || entry.path || baseAbsPath);
    const relFromBase = parent
      ? path.posix.join(parent.split(path.sep).join('/'), entry.name)
      : entry.name;
    if (!includeHiddenFiles && hiddenFiles.isHiddenPath(relFromBase)) continue;

    const rel = normalizePath(relFromBase, relBasePath);
    if (seenPaths.has(rel)) continue;

    const absolutePath = path.join(baseAbsPath, relFromBase);
    if (maxBytes) {
      // eslint-disable-next-line no-await-in-loop
      const stats = await fs.stat(absolutePath).catch(() => null);
      if (!stats || stats.size > maxBytes) continue;
    }

    examined += 1;
    const match = findOfficeTextMatch(absolutePath, needle);
    if (!match) continue;

    seenPaths.add(rel);
    // eslint-disable-next-line no-await-in-loop
    if (await shouldInclude(rel)) {
      yield formatResult(rel, 'file', match.line, match.lineNumber);
    }
  }
}

// Optimized ripgrep with parallel execution (Optimization #1, #2, #3)
async function* generateRipgrepResults(
  baseAbsPath,
  relBasePath,
  term,
  shouldInclude,
  deep = true,
  includeHiddenFiles = false
) {
  const needle = term.toLowerCase();
  const seenPaths = new Set();
  const dirSet = new Set();

  if (!deep) {
    // If no deep search, only run file list matches
    yield* streamFileListMatches(
      baseAbsPath,
      relBasePath,
      needle,
      seenPaths,
      dirSet,
      shouldInclude,
      includeHiddenFiles
    );
    return;
  }

  const fileListGen = streamFileListMatches(
    baseAbsPath,
    relBasePath,
    needle,
    seenPaths,
    dirSet,
    shouldInclude,
    includeHiddenFiles
  );
  const contentGen = streamContentMatches(
    baseAbsPath,
    relBasePath,
    term,
    seenPaths,
    shouldInclude,
    includeHiddenFiles
  );

  const officeGen = streamOfficeMatches(
    baseAbsPath,
    relBasePath,
    term,
    seenPaths,
    shouldInclude,
    includeHiddenFiles
  );

  yield* mergeResults(fileListGen, contentGen, officeGen);
}

// Optimized fallback with streaming (Optimization #1)
async function* generateFallbackResults(
  baseAbsPath,
  relBasePath,
  term,
  shouldInclude,
  deep = true,
  includeHiddenFiles = false
) {
  const seenPaths = new Set();
  const needle = term.toLowerCase();

  // Yield results immediately as we find them
  const walk = async function* (dirAbs, dirRel) {
    let dirents;
    try {
      dirents = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
    }

    for (const d of dirents) {
      if (shouldIgnore(d.name, includeHiddenFiles)) continue;

      const abs = path.join(dirAbs, d.name);
      const rel = dirRel ? path.posix.join(dirRel, d.name) : d.name;

      if (d.isDirectory()) {
        if (d.name.toLowerCase().includes(needle) && !seenPaths.has(rel)) {
          seenPaths.add(rel);
          if (await shouldInclude(rel)) {
            yield formatResult(rel, 'dir');
          }
        }
        yield* walk(abs, rel);
      } else if (d.isFile()) {
        if (d.name.toLowerCase().includes(needle) && !seenPaths.has(rel)) {
          seenPaths.add(rel);
          if (await shouldInclude(rel)) {
            yield formatResult(rel, 'file');
          }
        } else if (deep && !seenPaths.has(rel)) {
          try {
            const st = await fs.stat(abs);
            if (st.size <= CONTENT_FALLBACK_MAX_SIZE && isOfficeDocument(abs)) {
              // A .docx read as text is compressed bytes. Its words are in the
              // XML inside the archive, and that is what gets searched.
              const match = findOfficeTextMatch(abs, needle);
              if (match) {
                seenPaths.add(rel);
                if (await shouldInclude(rel)) {
                  yield formatResult(rel, 'file', match.line, match.lineNumber);
                }
              }
            } else if (st.size <= CONTENT_FALLBACK_MAX_SIZE) {
              const content = await fs.readFile(abs, 'utf8');
              const lower = content.toLowerCase();
              const idx = lower.indexOf(needle);

              if (idx !== -1) {
                const lineNumber = (content.slice(0, idx).match(/\n/g)?.length ?? 0) + 1;
                const matchedLine = content.split(/\r?\n/)[lineNumber - 1] || '';
                seenPaths.add(rel);
                if (await shouldInclude(rel)) {
                  yield formatResult(rel, 'file', matchedLine, lineNumber);
                }
              }
            }
          } catch {
            // Ignore read/encoding errors
          }
        }
      }
    }
  };

  yield* walk(baseAbsPath, relBasePath);
}

router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) {
      throw new ValidationError('Search term (q) is required.');
    }

    const relBaseInput = normalizeRelativePath(req.query.path || '');

    const context = { user: req.user, guestSession: req.guestSession };
    let accessInfo;
    let resolvedBase;
    try {
      ({ accessInfo, resolved: resolvedBase } = await resolvePathWithAccess(context, relBaseInput));
    } catch (error) {
      throw new NotFoundError('Base path not found.');
    }

    if (!accessInfo || !accessInfo.canAccess || !accessInfo.canRead) {
      throw new ForbiddenError(accessInfo?.denialReason || 'Search base is not accessible.');
    }

    const baseAbs = resolvedBase.absolutePath;
    const relBase = resolvedBase.relativePath;

    if (!(await pathExists(baseAbs))) {
      throw new NotFoundError('Base path not found.');
    }
    if (!(await isDirectory(baseAbs))) {
      throw new ValidationError('Search base path must be a directory.');
    }

    const limit = toLimit(req.query.limit);
    const ripgrepAllowed = searchConfig?.ripgrep !== false;
    const useRipgrep = ripgrepAllowed && (await hasRipgrep());
    const deepEnabled = searchConfig?.deep !== false;

    const settings = await getSettings();
    const userSettings = req.user?.id ? await getUserSettings(req.user.id) : {};
    const includeHiddenFiles = userSettings?.showHiddenFiles === true;
    const permissionRules = Array.isArray(settings?.access?.rules) ? settings.access.rules : [];
    const permissionResolver = permissionRules.length
      ? createPermissionResolver(permissionRules)
      : null;
    const shareCache = new Map();
    const userVolumeCache = new Map();

    const includeCache = new Map();
    const shouldInclude = async (rel) => {
      const name = path.posix.basename(rel);
      if (excludedFiles.includes(name)) return false;
      if (!includeHiddenFiles && hiddenFiles.isHiddenName(name)) return false;

      if (includeCache.has(rel)) return includeCache.get(rel);

      const info = await getAccessInfo(context, rel, {
        ...(permissionResolver ? { permissionResolver } : null),
        shareCache,
        userVolumeCache,
      });
      const ok = Boolean(info?.canAccess && info?.canRead);
      includeCache.set(rel, ok);
      return ok;
    };

    const generator = useRipgrep
      ? generateRipgrepResults(baseAbs, relBase, q, shouldInclude, deepEnabled, includeHiddenFiles)
      : generateFallbackResults(
          baseAbs,
          relBase,
          q,
          shouldInclude,
          deepEnabled,
          includeHiddenFiles
        );

    // What a name matched and what a document contained are counted apart, and
    // only put together at the end. Sharing one running total let filenames
    // spend it all: a term matching a hundred of them returned a hundred
    // results and not one line of content, which is the half people open a
    // deep search for. Names still lead — they are what someone looking for a
    // file expects first — but they can no longer take the whole page.
    const items = [];
    const contentItems = [];
    try {
      for await (const item of generator) {
        (item.matchLine ? contentItems : items).push(item);
        if (items.length + contentItems.length >= limit * 2) break;
        if (items.length >= limit && contentItems.length >= limit) break;
      }
    } finally {
      // Breaking out of a for-await leaves the generator suspended, and with
      // it the ripgrep processes it spawned — which keep scanning the whole
      // tree. Returning runs their cleanup so they are killed.
      await generator.return?.();
    }

    const nameQuota = contentItems.length > 0 ? Math.max(1, Math.floor(limit * 0.75)) : limit;
    const combined = [...items.slice(0, nameQuota), ...contentItems].slice(0, limit);
    // A quota that went unused is not a reason to answer short.
    if (combined.length < limit) {
      combined.push(...items.slice(nameQuota, nameQuota + (limit - combined.length)));
    }

    res.json({ items: combined });
  })
);

module.exports = router;
module.exports.buildContentSearchArgs = buildContentSearchArgs;
module.exports.contentSearchArgs = contentSearchArgs;
