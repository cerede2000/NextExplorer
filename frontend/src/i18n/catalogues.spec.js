import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Thirteen catalogues, six hundred and thirty-seven keys, and not one missing
 * or orphaned in any of them. That is rare and it does not hold by itself: a
 * key added to the English file and forgotten elsewhere shows the key name on
 * screen to everyone who reads another language, and a key removed from
 * English but left behind is dead weight nobody will ever find.
 *
 * The audit measured this by hand. Measuring it by hand is how it drifts.
 */

const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');

const flatten = (object, prefix = '', into = {}) => {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, into);
    else into[full] = value;
  }
  return into;
};

const read = (locale) =>
  flatten(JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8')));

const locales = fs
  .readdirSync(localesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace('.json', ''));

const english = read('en');
const others = locales.filter((locale) => locale !== 'en');

describe('the translation catalogues', () => {
  it('has more than one language to keep aligned', () => {
    expect(locales).toContain('en');
    expect(others.length).toBeGreaterThan(5);
  });

  it.each(others)('%s says everything English says', (locale) => {
    const missing = Object.keys(english).filter((key) => !(key in read(locale)));

    expect(missing).toEqual([]);
  });

  it.each(others)('%s says nothing English no longer says', (locale) => {
    const orphaned = Object.keys(read(locale)).filter((key) => !(key in english));

    expect(orphaned).toEqual([]);
  });

  /**
   * A placeholder dropped in translation renders as nothing where a number
   * belonged; one invented renders as literal braces. Either is the failure
   * people report as "the message is broken".
   *
   * Compared as a set of names and not as a count: vue-i18n separates plural
   * forms with `|`, and how many a language has is the language's business —
   * Chinese has one where English has two, Polish and Russian have three. A
   * test that counted `{minutes}` across the whole string called all three of
   * those wrong, which was the test being wrong.
   */
  it.each(others)('%s uses the same placeholders English does', (locale) => {
    const catalogue = read(locale);
    const namesIn = (text) =>
      typeof text === 'string'
        ? [...new Set(text.match(/\{[a-zA-Z0-9_]+\}/g) || [])].sort().join(',')
        : '';

    const differing = Object.keys(english).filter((key) => {
      const expected = namesIn(english[key]);
      return expected !== '' && namesIn(catalogue[key]) !== expected;
    });

    expect(differing).toEqual([]);
  });
});
