import { createI18n } from 'vue-i18n';

const localeModules = import.meta.glob('./locales/*.json', { eager: true });

const messages = Object.fromEntries(
  Object.entries(localeModules).map(([path, mod]) => {
    const match = path.match(/\.\/locales\/(.*)\.json$/);
    if (!match) return [path, mod?.default ?? mod];
    return [match[1], mod?.default ?? mod];
  })
);

const preferredLocaleOrder = [
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'it',
  'ko',
  'pl',
  'pt-BR',
  'ro',
  'ru',
  'sv',
  'zh-CN',
  'zh-TW',
];

export const supportedLocaleOptions = [
  ...preferredLocaleOrder.filter((code) => Object.prototype.hasOwnProperty.call(messages, code)),
  ...Object.keys(messages)
    .filter((code) => !preferredLocaleOrder.includes(code))
    .sort(),
].map((code) => ({ code }));

const supportedLocales = supportedLocaleOptions.map(({ code }) => code);

/**
 * A browser says `zh-cn`; the bundle is called `zh-CN`. Compared as written,
 * those never match — so a Chinese browser was never detected as Chinese, and
 * neither was a Taiwanese one. The tag is case-insensitive by specification and
 * this is the only place that treated it otherwise.
 */
const matchLocale = (supportedLocales, preference) =>
  supportedLocales.find((code) => code.toLowerCase() === String(preference).toLowerCase());

export function detectLocale(supportedLocales) {
  try {
    const saved = localStorage.getItem('locale');
    const remembered = saved && matchLocale(supportedLocales, saved);
    if (remembered) return remembered;
  } catch (_) {
    // Ignore localStorage errors (e.g., in private browsing mode)
  }

  const prefs =
    typeof navigator !== 'undefined' &&
    Array.isArray(navigator.languages) &&
    navigator.languages.length
      ? navigator.languages
      : [typeof navigator !== 'undefined' ? navigator.language : 'en'];

  const normalized = prefs
    .filter(Boolean)
    .map((l) => l.toLowerCase())
    .filter(Boolean);

  for (const p of normalized) {
    const base = p.split('-')[0];
    const hit = matchLocale(supportedLocales, p) || matchLocale(supportedLocales, base);
    if (hit) return hit;
  }

  return 'en';
}

/**
 * Polish and Russian need three plural forms: 2-4 ("few") is not the same word
 * as 5+ ("many"), and the default two-form rule always picked "many" — wrong
 * for the most common counts. Messages that only carry two forms fall back to
 * the default behaviour, so this stays safe for every other string.
 */
export const slavicPluralRule = (choice, choicesLength) => {
  if (choicesLength < 3) return choice === 1 ? 0 : 1;
  if (choice === 1) return 0;
  const mod10 = choice % 10;
  const mod100 = choice % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1;
  return 2;
};

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: detectLocale(supportedLocales),
  fallbackLocale: 'en',
  messages,
  pluralRules: {
    pl: slavicPluralRule,
    ru: slavicPluralRule,
  },
});

export default i18n;
