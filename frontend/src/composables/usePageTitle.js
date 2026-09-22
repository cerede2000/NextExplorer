import { computed, unref } from 'vue';
import { useTitle } from '@vueuse/core';
import { useAppSettings } from '@/stores/appSettings';
import { composeTitle } from '@/utils/pageTitle';

/**
 * Keep the browser tab's title as the page's name and the instance's.
 *
 * The instance's name is the one set in Settings → Branding, read from the
 * settings every page already loads — signed in or not, a share visitor
 * included — so a new name reaches every open tab without a reload.
 *
 * @param {import('vue').MaybeRef<string>} page what the page is; empty for a
 *   page that is the instance itself, such as signing in
 */
export function usePageTitle(page = '') {
  const appSettings = useAppSettings();
  const title = computed(() => composeTitle(unref(page), appSettings.state?.branding?.appName));
  useTitle(title);
  return title;
}
