import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, reactive } from 'vue';

/**
 * The share button in the toolbar.
 *
 * It is the toolbar's way of saying "you may hand this out". Two places must
 * never offer it: a folder whose permissions forbid sharing, and the inside of
 * somebody else's share, where a link to a link would give a visitor more reach
 * than the owner granted. Where it is offered, it shares exactly one thing — the
 * item selected — and the dialog it opens has to be about that item, not about
 * whatever was selected before.
 */

let fileStore;

vi.mock('@/stores/fileStore', () => ({ useFileStore: () => fileStore }));
vi.mock('@/api', () => ({
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  useI18n: () => ({ t: (key) => key }),
}));
vi.mock('@/utils/logger', () => ({ default: { info: vi.fn() } }));
// The real dialog is a whole form with a date picker; only what it is given
// matters here.
vi.mock('@/components/ShareDialog.vue', () => ({
  default: defineComponent({
    name: 'ShareDialogStub',
    props: { modelValue: Boolean, item: { type: Object, default: null } },
    render: () => null,
  }),
}));

import MenuShare from './MenuShare.vue';

const REPORT = { name: 'report.pdf', path: 'Docs', kind: 'pdf' };
const PHOTOS = { name: 'Photos', path: 'Docs', kind: 'directory' };

let wrapper = null;

const mountMenu = async () => {
  wrapper = mount(MenuShare);
  await flushPromises();
  return wrapper;
};

const shareButton = () => wrapper.find('button');
const dialog = () => wrapper.findComponent({ name: 'ShareDialogStub' });

beforeEach(() => {
  fileStore = reactive({
    getCurrentPath: 'Docs',
    currentPathData: { canShare: true },
    selectedItems: [REPORT],
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('where sharing is offered', () => {
  it('is offered in an ordinary folder', async () => {
    await mountMenu();

    expect(shareButton().exists()).toBe(true);
  });

  it('is offered when the folder carries no permission data at all', async () => {
    fileStore.currentPathData = null;
    await mountMenu();

    expect(shareButton().exists()).toBe(true);
  });

  it('is not offered where the folder forbids sharing', async () => {
    fileStore.currentPathData = { canShare: false };
    await mountMenu();

    expect(shareButton().exists()).toBe(false);
    expect(dialog().exists()).toBe(false);
  });

  it('is not offered inside a share, however the path is written', async () => {
    fileStore.getCurrentPath = '/share/abc123/Docs';
    await mountMenu();

    expect(shareButton().exists()).toBe(false);
  });

  it('is offered in a folder that merely starts with the word share', async () => {
    fileStore.getCurrentPath = 'shared-projects';
    await mountMenu();

    expect(shareButton().exists()).toBe(true);
  });

  it('disappears as soon as the location stops allowing it', async () => {
    await mountMenu();
    expect(shareButton().exists()).toBe(true);

    fileStore.currentPathData = { canShare: false };
    await flushPromises();

    expect(shareButton().exists()).toBe(false);
  });
});

describe('what it shares', () => {
  it('opens the share dialog on the one selected item', async () => {
    await mountMenu();
    expect(dialog().props('modelValue')).toBe(false);

    await shareButton().trigger('click');

    expect(dialog().props('modelValue')).toBe(true);
    expect(dialog().props('item')).toEqual(REPORT);
  });

  it('shares what is selected when clicked, not what was selected when it appeared', async () => {
    await mountMenu();

    fileStore.selectedItems = [PHOTOS];
    await flushPromises();
    await shareButton().trigger('click');

    expect(dialog().props('item')).toEqual(PHOTOS);
  });

  it('cannot be used with nothing selected', async () => {
    fileStore.selectedItems = [];
    await mountMenu();

    expect(shareButton().attributes('disabled')).toBeDefined();
    await shareButton().trigger('click');
    expect(dialog().props('modelValue')).toBe(false);
  });

  it('cannot be used with several items selected', async () => {
    fileStore.selectedItems = [REPORT, PHOTOS];
    await mountMenu();

    expect(shareButton().attributes('disabled')).toBeDefined();
    expect(shareButton().attributes('title')).toBe('share.selectItemToShare');
    await shareButton().trigger('click');
    expect(dialog().props('modelValue')).toBe(false);
    expect(dialog().props('item')).toBe(null);
  });
});
