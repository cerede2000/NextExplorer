import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every string a screen asks for is one the catalogue has.
 *
 * A screen that arrives without its strings shows its own keys —
 * `settings.about.tools.title` where a heading belongs — and nothing fails:
 * the build succeeds, the page renders, and the words are missing. It is the
 * one defect a batch of screens can ship with and pass every other gate, and
 * it has happened: the About page's list of optional tools was ported with no
 * catalogue entries at all.
 *
 * English is the one checked. The others are missing-translation fallbacks by
 * design — a key absent there falls back to English, which is a reader seeing
 * the wrong language rather than a key.
 */

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'src');
const CATALOGUE = path.join(FRONTEND, 'i18n', 'locales', 'en.json');

/** `t('a.b')`, `$t('a.b')`, `te('a.b')` — the literal calls, which is all that can be checked. */
const KEY_CALL = /(?<![\w$])\$?te?\(\s*'([A-Za-z][\w.-]*)'/g;

const sourcesUnder = (directory) => {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'locales') continue;
      found.push(...sourcesUnder(full));
    } else if (/\.(vue|js)$/.test(entry.name) && !entry.name.endsWith('.spec.js')) {
      found.push(full);
    }
  }
  return found;
};

const has = (catalogue, key) => {
  let node = catalogue;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false;
    node = node[part];
  }
  return typeof node === 'string' || typeof node === 'object';
};

describe('the strings the interface asks for', () => {
  it('are all in the English catalogue', () => {
    const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
    const missing = new Set();

    for (const file of sourcesUnder(FRONTEND)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const [, key] of source.matchAll(KEY_CALL)) {
        // A key is a path with a dot in it; a bare word is some other `t(...)`.
        if (!key.includes('.')) continue;
        // `t('settings.categories.' + name)` — a prefix being built, not a key.
        if (key.endsWith('.')) continue;
        if (!has(catalogue, key)) {
          missing.add(`${key}  (${path.relative(FRONTEND, file)})`);
        }
      }
    }

    expect([...missing].sort()).toEqual([]);
  });
});
