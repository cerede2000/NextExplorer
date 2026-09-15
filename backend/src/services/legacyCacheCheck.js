const fs = require('fs');
const path = require('path');

const { directories } = require('../config/index');
const logger = require('../utils/logger');

/**
 * What early releases left in the cache directory, said out loud at start.
 *
 * Up to 1.1.7 the database and app-config.json lived in the cache directory.
 * 1.1.8 moved them to the config directory and left links behind in their
 * place; 2.0.3 removed that move from the entrypoint. So an installation that
 * started on 1.1.7 or earlier and skipped the releases in between comes up on a
 * new, empty app.db in /config, with its accounts and shares sitting unread in
 * /cache — and nothing said so. The links, where an installation passed through
 * 1.1.8 to 2.0.2, are harmless but look like data.
 *
 * Nothing is moved: which of two databases holds what matters cannot be told
 * from here, and guessing wrong would overwrite the one in use. The log says
 * where the old file is and what to do with it.
 */

const LEGACY_NAMES = ['app.db', 'app-config.json', 'extensions'];

const readLinkOrNull = (file) => {
  try {
    return fs.readlinkSync(file);
  } catch {
    return null;
  }
};

/** What is there, without following anything. */
const inspectLegacyCache = (cacheDir = directories.cache) => {
  const findings = [];
  for (const name of LEGACY_NAMES) {
    const file = path.join(cacheDir, name);
    let stats;
    try {
      stats = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      findings.push({ name, path: file, kind: 'link', target: readLinkOrNull(file) });
    } else if (name === 'app.db' && stats.isFile()) {
      findings.push({ name, path: file, kind: 'database', sizeBytes: stats.size });
    }
  }
  return findings;
};

const reportLegacyCache = ({
  cacheDir = directories.cache,
  configDir = directories.config,
  log = logger,
} = {}) => {
  const findings = inspectLegacyCache(cacheDir);

  const database = findings.find((finding) => finding.kind === 'database');
  if (database) {
    log.warn(
      {
        legacyDatabase: database.path,
        sizeBytes: database.sizeBytes,
        databaseInUse: path.join(configDir, 'app.db'),
      },
      'An app.db written by release 1.1.7 or earlier is in the cache directory, and nothing reads it: this server runs on the app.db in the config directory. If accounts, shares or favorites are missing, stop the container, back up both files, and copy the old one over the one in the config directory.'
    );
  }

  const links = findings.filter((finding) => finding.kind === 'link');
  if (links.length > 0) {
    log.info(
      { links: links.map((link) => `${link.path} -> ${link.target}`) },
      'Links left in the cache directory by releases 1.1.8 to 2.0.2 are unused and can be deleted.'
    );
  }

  return findings;
};

module.exports = { inspectLegacyCache, reportLegacyCache };
