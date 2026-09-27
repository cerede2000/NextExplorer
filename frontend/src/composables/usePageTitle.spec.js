import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, reactive, ref } from 'vue';

/**
 * The tab's title follows the page and the instance's name, both of which can
 * change while the tab is open: a folder opened, a name saved in Settings →
 * Branding.
 */

const appSettings = reactive({ state: { branding: { appName: 'Chez Benjy' } } });
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));

import { usePageTitle } from './usePageTitle';

let wrapper;

const withPage = (page) =>
  mount(
    defineComponent({
      setup() {
        usePageTitle(page);
        return () => h('div');
      },
    })
  );

beforeEach(() => {
  appSettings.state.branding.appName = 'Chez Benjy';
  document.title = 'Explorer';
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('the tab’s title', () => {
  it('names the page and the instance', async () => {
    wrapper = withPage('Projects');
    await nextTick();
    expect(document.title).toBe('Projects | Chez Benjy');
  });

  it('follows the page as it changes', async () => {
    const page = ref('Projects');
    wrapper = withPage(page);
    page.value = 'Photos';
    await nextTick();
    expect(document.title).toBe('Photos | Chez Benjy');
  });

  it('follows a new name saved for the instance, without a reload', async () => {
    wrapper = withPage('Projects');
    appSettings.state.branding.appName = 'NextExplorer';
    await nextTick();
    expect(document.title).toBe('Projects | NextExplorer');
  });

  it('is the instance’s name alone for a page that is the instance itself', async () => {
    wrapper = withPage('');
    await nextTick();
    expect(document.title).toBe('Chez Benjy');
  });
});
