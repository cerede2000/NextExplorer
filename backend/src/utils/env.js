const fs = require('node:fs');

/**
 * A secret, taken from the environment or from the file it names.
 *
 * `docker inspect` prints every variable a container was started with, so a
 * secret passed as `ONLYOFFICE_SECRET=…` is readable by anyone who can reach the
 * daemon and stays in the container's stored configuration long after the
 * process is gone. The convention around that — Postgres, Nextcloud and most
 * images that take credentials — is a companion `_FILE` variable naming a file
 * to read instead, so an orchestrator can mount the value from a secret store
 * and leave the environment empty.
 *
 * Names are tried in order, each as a direct value then as a `_FILE` pointer, so
 * a legacy alias only answers when the current name says nothing.
 *
 * A `_FILE` that cannot be read throws rather than resolving to null: the
 * operator asked for that file by name, and carrying on would quietly start the
 * server with whatever the secret protects turned off.
 */
const readSecret = (...names) => {
  for (const name of names) {
    const direct = process.env[name];
    if (direct) return direct;

    const file = process.env[`${name}_FILE`];
    if (!file) continue;

    let contents;
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`${name}_FILE: cannot read ${file} (${error.code || error.message})`);
    }

    // Trailing newlines are what `echo secret > file` leaves behind, and they
    // would travel into signatures and comparisons unnoticed.
    const value = contents.trim();
    if (!value) {
      throw new Error(`${name}_FILE: ${file} is empty`);
    }
    return value;
  }

  return null;
};

const normalizeBoolean = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return null;
};

// Parse sizes like "512", "512k", "10M", "1g" into bytes (number).
// Supports K, M, G, T suffixes (base 1024). Returns null if cannot parse.
const parseByteSize = (value) => {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== 'string') return null;

  const s = value.trim();
  if (!s) return null;
  const m = s.match(/^([0-9]+)\s*([kKmMgGtT]?)b?$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = (m[2] || '').toUpperCase();
  const pow = unit === 'K' ? 1 : unit === 'M' ? 2 : unit === 'G' ? 3 : unit === 'T' ? 4 : 0;
  const factor = 1024 ** pow;
  return Math.max(0, Math.floor(num * factor));
};

module.exports = {
  normalizeBoolean,
  parseByteSize,
  readSecret,
};
