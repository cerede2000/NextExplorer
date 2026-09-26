import { watch } from 'vue';
import { applyUserLocale } from '@/i18n';
import { useAppSettings } from '@/stores/appSettings';

/**
 * The language of whoever is signed in, put on the screen.
 *
 * Deliberately not in the settings store: that one holds what an account chose,
 * not what the interface does with it, and half the application reads it — a
 * store reaching into the translations would drag them into every component
 * that touches a preference, and into every test that mounts one.
 *
 * Used once, by the shell, so it follows every answer at once: the settings
 * fetched after signing in, a save on the preferences page, and the emptying
 * the store does when the account changes, which puts the language back to the
 * browser's before the next account's is known.
 */
export function useAccountLanguage() {
  const appSettings = useAppSettings();

  watch(
    () => appSettings.userSettings?.locale ?? null,
    (locale) => applyUserLocale(locale),
    { immediate: true }
  );
}
