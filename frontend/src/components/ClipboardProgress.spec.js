import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';

import ClipboardProgress from './ClipboardProgress.vue';
import { useOperationTasksStore } from '@/stores/operationTasks';

/**
 * An upload isn't over when the last byte leaves the browser. The server still
 * has to write the file where it belongs, and across two filesystems that is a
 * copy of the whole thing — minutes, for a large file. The client has nothing
 * left to send by then, so a bar tied to bytes sent would sit at 100% for all
 * of it and read as a freeze. Once the server reports the copy, that is what
 * the panel counts.
 */

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: { item: 'item', items: 'items', to: 'to', cancel: 'Cancel', close: 'Close' },
      clipboard: { working: 'Working…' },
      upload: { uploads: 'Uploading {count} {items}', finalizing: 'Finishing up' },
    },
  },
});

const mountPanel = () => mount(ClipboardProgress, { global: { plugins: [i18n] } });

const uploadOf = (store, extra = {}) =>
  store.startOperation({
    type: 'upload',
    name: 'holiday.mkv',
    totalBytes: 1000,
    copiedBytes: 1000,
    ...extra,
  });

describe('ClipboardProgress', () => {
  let store;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useOperationTasksStore();
  });

  it('counts the transfer while bytes are still going out', () => {
    uploadOf(store, { copiedBytes: 250 });

    expect(mountPanel().text()).toContain('25%');
  });

  it('switches to the server-side copy once the transfer is done', () => {
    uploadOf(store, {
      finalizing: true,
      finalizedBytes: 400,
      finalizedTotalBytes: 1000,
    });

    const text = mountPanel().text();
    expect(text).toContain('Finishing up');
    expect(text).toContain('40%');
    // The transfer's own 100% would be the misleading number here.
    expect(text).not.toContain('100%');
  });

  it('leaves the transfer alone when the server reports nothing to copy', () => {
    // A move within one filesystem is a rename: it returns before the client
    // could ask, so no copy is ever reported and the bar stays as it was.
    uploadOf(store, { finalizing: true, finalizedTotalBytes: 0 });

    expect(mountPanel().text()).toContain('100%');
  });
});
