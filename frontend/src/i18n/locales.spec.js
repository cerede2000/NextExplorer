import { describe, it, expect } from 'vitest';

/**
 * Locales drift silently: a feature ships with its English and French strings,
 * the other eleven fall back to English, and nobody notices until a user does.
 * This fails the build instead.
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

const reference = flatten(locales.en);
const referenceKeys = Object.keys(reference);
const otherLocales = Object.keys(locales).filter((code) => code !== 'en');

const PLACEHOLDERS = ['{count}', '{names}', '{action}', '{size}', '{name}'];

describe('locale completeness', () => {
  it('ships every English key in every locale', () => {
    const missing = {};
    for (const code of otherLocales) {
      const keys = new Set(Object.keys(flatten(locales[code])));
      const gaps = referenceKeys.filter((key) => !keys.has(key));
      if (gaps.length) missing[code] = gaps;
    }
    expect(missing).toEqual({});
  });

  it('has no key the English reference does not define', () => {
    const extra = {};
    for (const code of otherLocales) {
      const gaps = Object.keys(flatten(locales[code])).filter((key) => !reference[key]);
      if (gaps.length) extra[code] = gaps;
    }
    expect(extra).toEqual({});
  });

  it('keeps the same placeholders as the English string', () => {
    const mismatches = [];
    for (const code of otherLocales) {
      const translated = flatten(locales[code]);
      for (const key of referenceKeys) {
        const source = reference[key];
        const target = translated[key];
        if (typeof source !== 'string' || typeof target !== 'string') continue;
        for (const placeholder of PLACEHOLDERS) {
          if (source.includes(placeholder) !== target.includes(placeholder)) {
            mismatches.push(`${code}: ${key} (${placeholder})`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

/**
 * Key parity between locales says nothing about the keys the code actually
 * asks for. Nine of them were missing from every locale at once — including
 * two on the share dialog, where users read "share.password" instead of
 * "Password". Parity could not see it: absent everywhere is still parity.
 */
describe('every key the code asks for exists', () => {
  const sources = import.meta.glob('../**/*.{vue,js}', { eager: true, query: '?raw', import: 'default' });

  // t('a.b') and $t("a.b"), literals only — keys built at runtime
  // (`serverErrors.${code}`) cannot be checked this way.
  const CALL = /\$?t\(\s*['"]([a-z][\w]*(?:\.[\w]+)+)['"]/g;

  it('finds no missing key', () => {
    const missing = new Map();
    for (const [file, code] of Object.entries(sources)) {
      if (file.includes('/locales/') || file.includes('.spec.')) continue;
      for (const [, key] of String(code).matchAll(CALL)) {
        if (reference[key] === undefined && !missing.has(key)) {
          missing.set(key, file.replace('../', ''));
        }
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });
});
