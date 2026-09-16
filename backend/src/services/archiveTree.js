const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');

const { excludedFiles } = require('../config/index');
const { combineRelativePath, isInsidePersonalRoot } = require('../utils/pathUtils');
const { getAccessInfo } = require('./accessManager');
const { createPermissionResolver } = require('./accessControlService');
const { getSettings } = require('./settingsService');

/**
 * What goes into an archive of a folder somebody may download.
 *
 * Handing the folder to the archiver whole took everything under it, including
 * what nobody browsing it can see: the `.nextexplorer` zone with other people's
 * deleted files and every earlier version of every file, a personal root kept
 * inside the volume, and the paths an access rule hides. A download is a read,
 * so it gets exactly what a listing would show — the same excluded names, the
 * same personal root, and the same per-path access decision.
 *
 * The walk returns the entries rather than writing them, so the same list feeds
 * a zip streamed to the browser and a zip written next to the folder.
 */

const readRules = async () => {
  const settings = await getSettings();
  return Array.isArray(settings?.access?.rules) ? settings.access.rules : [];
};

/**
 * Walk the given sources and list what an archive of them may hold.
 *
 * Each source is `{ absolutePath, logicalPath, entryName, stats }`, as the
 * caller resolved and authorized it. Returns the entries in archive order, how
 * many were left out, and the bytes of the files kept.
 */
const collectArchiveEntries = async (context, sources) => {
  const rules = await readRules();
  const accessOptions = {
    permissionResolver: rules.length ? createPermissionResolver(rules) : undefined,
    shareCache: new Map(),
    userVolumeCache: new Map(),
  };
  const entries = [];
  let excluded = 0;
  let totalBytes = 0;

  const visible = async ({ absolutePath, logicalPath, name, guardPersonalRoot }) => {
    if (excludedFiles.includes(name)) return false;
    if (guardPersonalRoot && isInsidePersonalRoot(absolutePath)) return false;
    // With no rules, nothing below a readable folder is less readable than it:
    // every other decision was made once, for the source.
    if (!rules.length) return true;
    const info = await getAccessInfo(context, logicalPath, accessOptions);
    return Boolean(info?.canAccess && info.canRead);
  };

  const walk = async ({ absoluteDir, logicalDir, entryDir, guardPersonalRoot }) => {
    const children = await fs.readdir(absoluteDir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolutePath = path.join(absoluteDir, child.name);
      const logicalPath = combineRelativePath(logicalDir, child.name);
      const name = `${entryDir}/${child.name}`;
      if (!(await visible({ absolutePath, logicalPath, name: child.name, guardPersonalRoot }))) {
        excluded += 1;
        continue;
      }
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        // Kept as the link it is, never followed: its target is text, not content.
        entries.push({ type: 'symlink', name, target: await fs.readlink(absolutePath) });
      } else if (stats.isDirectory()) {
        entries.push({ type: 'directory', name });
        await walk({
          absoluteDir: absolutePath,
          logicalDir: logicalPath,
          entryDir: name,
          guardPersonalRoot,
        });
      } else if (stats.isFile()) {
        entries.push({ type: 'file', name, absolutePath, stats });
        totalBytes += stats.size;
      }
    }
  };

  for (const source of sources) {
    const entryName = String(source.entryName || path.basename(source.absolutePath)).replace(
      /^\/+|\/+$/g,
      ''
    );
    if (source.stats.isDirectory()) {
      entries.push({ type: 'directory', name: entryName });
      // A folder that is itself inside the personal root was reached through the
      // personal space, or a share of it, which already decided whose it is.
      await walk({
        absoluteDir: source.absolutePath,
        logicalDir: source.logicalPath,
        entryDir: entryName,
        guardPersonalRoot: !isInsidePersonalRoot(source.absolutePath),
      });
    } else {
      entries.push({
        type: 'file',
        name: entryName,
        absolutePath: source.absolutePath,
        stats: source.stats,
      });
      totalBytes += source.stats.size;
    }
  }

  return { entries, excluded, totalBytes };
};

/** Queue the entries on an archiver instance. */
const appendEntries = (archive, entries) => {
  for (const entry of entries) {
    if (entry.type === 'directory') {
      archive.append(null, { name: `${entry.name}/`, type: 'directory' });
    } else if (entry.type === 'symlink') {
      archive.symlink(entry.name, entry.target);
    } else {
      archive.file(entry.absolutePath, { name: entry.name, stats: entry.stats });
    }
  }
};

/**
 * Write the entries to a zip file on disk, streamed, reporting progress through
 * `onPercent(0-100)` and stopping when `signal` aborts.
 */
const writeZipFile = (entries, destinationPath, { totalBytes = 0, onPercent, signal } = {}) =>
  new Promise((resolve, reject) => {
    const cancelled = () => {
      const error = new Error('Operation cancelled.');
      error.code = 'OPERATION_CANCELLED';
      return error;
    };
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }

    const output = fss.createWriteStream(destinationPath);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      archive.abort();
      output.destroy();
      finish(cancelled());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    archive.on('progress', (progress) => {
      if (totalBytes > 0 && typeof onPercent === 'function') {
        onPercent(Math.min(100, Math.round((progress.fs.processedBytes / totalBytes) * 100)));
      }
    });
    archive.on('warning', (warning) => finish(warning));
    archive.on('error', (error) => {
      output.destroy();
      finish(error);
    });
    output.on('error', finish);
    output.on('close', () => finish());

    archive.pipe(output);
    appendEntries(archive, entries);
    archive.finalize().catch(finish);
  });

module.exports = { collectArchiveEntries, appendEntries, writeZipFile };
