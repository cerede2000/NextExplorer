import { describe, it, expect } from 'vitest';
import { createI18n } from 'vue-i18n';

/**
 * Key parity is not enough: a message can be present, complete, and still fail
 * to compile. An ICU-style plural (`{count, plural, one {…} other {…}}`) parses
 * as an unterminated brace in vue-i18n, which then returns the raw source — the
 * user reads the template instead of the sentence. This compiles every string
 * in every locale so that never ships again.
 */
const localeModules = import.meta.glob('./locales/*.json', { eager: true });
const locales = Object.fromEntries(
  Object.entries(localeModules).map(([path, mod]) => [
    path.match(/\.\/locales\/(.*)\.json$/)[1],
    mod?.default ?? mod,
  ])
);

const flatten = (object, prefix = '') =>
  Object.entries(object).reduce((out, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...out, ...flatten(value, path) };
    }
    return { ...out, [path]: value };
  }, {});

describe('every message compiles', () => {
  it.each(Object.keys(locales))('%s', (code) => {
    const i18n = createI18n({
      legacy: false,
      locale: code,
      messages: { [code]: locales[code] },
      // A message that fails to compile must fail the test, not warn.
      missingWarn: false,
      fallbackWarn: false,
    });

    const failures = [];
    for (const [key, value] of Object.entries(flatten(locales[code]))) {
      if (typeof value !== 'string') continue;
      const rendered = i18n.global.t(key, { count: 1, name: 'x', names: 'x', action: 'x' }, 1);
      // An uncompiled message comes back byte-for-byte, braces included.
      if (rendered === value && /\{[^}]*\{/.test(value)) {
        failures.push(`${key}: ${value}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
