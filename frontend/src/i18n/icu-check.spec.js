import { describe, it, expect } from 'vitest';
import { createI18n } from 'vue-i18n';

// The rule under test, not a copy of it.
import { slavicPluralRule } from './index';

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

// Matches ICU argument types whatever follows, so `{n, plural, other}` and
// `{when, date, short}` are caught too — not only the nested-brace form.
const ICU_ARGUMENT = /\{\s*\w+\s*,\s*(plural|select|selectordinal|number|date|time)\b/;

const hasUnbalancedBraces = (value) => {
  let depth = 0;
  for (const char of value) {
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (depth < 0) return true;
  }
  return depth !== 0;
};

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
      if (ICU_ARGUMENT.test(value)) {
        failures.push(`${key}: ICU syntax, vue-i18n uses "singular | plural" — ${value}`);
        continue;
      }
      if (hasUnbalancedBraces(value)) {
        failures.push(`${key}: unbalanced braces — ${value}`);
        continue;
      }
      const rendered = i18n.global.t(key, { count: 1, name: 'x', names: 'x', action: 'x' }, 1);
      // An uncompiled message comes back byte-for-byte, braces included.
      if (rendered === value && /\{[^}]*\{/.test(value)) {
        failures.push(`${key}: ${value}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

/**
 * The pipe is vue-i18n's plural separator, so a literal one in a translation
 * silently truncates the sentence at the first form: "Press Ctrl | Alt" renders
 * as "Press Ctrl". Nothing in the rendering can flag that, but English is the
 * source every translation is written from: a pipe that exists only in the
 * translation is a stray separator, not a plural.
 *
 * The reverse is not checked on purpose — Chinese, Korean, Hindi and German
 * legitimately collapse several English forms into one.
 */
describe('no stray plural separator', () => {
  const reference = flatten(locales.en);

  it.each(Object.keys(locales).filter((code) => code !== 'en'))('%s', (code) => {
    const stray = [];
    for (const [key, value] of Object.entries(flatten(locales[code]))) {
      if (typeof value !== 'string' || typeof reference[key] !== 'string') continue;
      if (value.includes('|') && !reference[key].includes('|')) {
        stray.push(`${key}: ${value}`);
      }
    }
    expect(stray).toEqual([]);
  });
});

/**
 * Polish has a separate form for 2-4 ("są otwarte") that the default two-form
 * rule cannot express: it fell back to the 5+ wording for the most common
 * counts. The rule lives in i18n/index.js; this pins its effect.
 */
describe('Slavic plural rule', () => {
  const i18n = createI18n({
    legacy: false,
    locale: 'pl',
    messages: { pl: locales.pl },
    missingWarn: false,
    fallbackWarn: false,
    pluralRules: { pl: slavicPluralRule },
  });

  const render = (count) =>
    i18n.global.t('onlyoffice.editingBody', { names: 'a.docx', action: 'x' }, count);

  it.each([
    [1, 'jest otwarty'],
    [2, 'są otwarte'],
    [3, 'są otwarte'],
    [4, 'są otwarte'],
    [5, 'jest otwartych'],
    [22, 'są otwarte'],
    [25, 'jest otwartych'],
  ])('%i uses "%s"', (count, expected) => {
    expect(render(count)).toContain(expected);
  });
});
