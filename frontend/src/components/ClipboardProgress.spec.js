import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
      clipboard: {
        working: 'Working…',
        perSecond: '{value}/s',
        activeTasks: '{count} tasks',
      },
      upload: { uploads: 'Uploading {count} {items}', finalizing: 'Finishing up' },
    },
  },
});

const mountPanel = () => mount(ClipboardProgress, { global: { plugins: [i18n] } });

const MB = 1024 * 1024;

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

/**
 * The panel also reports how fast things are moving. What matters is that the
 * figure describes the transfer the reader is looking at: the summary speaks
 * for every upload at once, each row of the expanded list only for itself, and
 * a paused transfer speaks for nothing at all.
 */
describe('ClipboardProgress rate', () => {
  let store;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useOperationTasksStore();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive an operation's byte count forward over real elapsed time. */
  const transfer = (id, points) => {
    points.forEach(({ afterMs, bytes }) => {
      vi.advanceTimersByTime(afterMs);
      store.updateOperation(id, { copiedBytes: bytes });
    });
  };

  it('reports the rate the bytes are actually arriving at', () => {
    const id = uploadOf(store, { totalBytes: 100 * MB, copiedBytes: 0 });
    transfer(id, [
      { afterMs: 1000, bytes: 4 * MB },
      { afterMs: 1000, bytes: 8 * MB },
    ]);

    expect(mountPanel().text()).toContain('4 MB/s');
  });

  it('adds up the uploads when several are running at once', () => {
    // One file's share of the link is not what the person watching wants to
    // know; the panel is speaking for the whole batch.
    const first = uploadOf(store, { name: 'a.iso', totalBytes: 100 * MB, copiedBytes: 0 });
    const second = uploadOf(store, { name: 'b.iso', totalBytes: 100 * MB, copiedBytes: 0 });

    vi.advanceTimersByTime(1000);
    store.updateOperation(first, { copiedBytes: 3 * MB });
    store.updateOperation(second, { copiedBytes: 5 * MB });
    vi.advanceTimersByTime(1000);
    store.updateOperation(first, { copiedBytes: 6 * MB });
    store.updateOperation(second, { copiedBytes: 10 * MB });

    expect(mountPanel().text()).toContain('8 MB/s');
  });

  it('stops naming a rate once the bytes stop arriving', () => {
    // Pausing an upload ends the progress events. A rate left on screen would
    // claim the transfer is still moving.
    const id = uploadOf(store, { totalBytes: 100 * MB, copiedBytes: 0 });
    transfer(id, [
      { afterMs: 1000, bytes: 4 * MB },
      { afterMs: 1000, bytes: 8 * MB },
    ]);

    const panel = mountPanel();
    expect(panel.text()).toContain('MB/s');

    vi.advanceTimersByTime(5000);
    expect(mountPanel().text()).not.toContain('MB/s');
  });

  it('measures the server-side copy separately from the transfer', () => {
    // Finalizing is a second run of bytes at its own pace. Measured against the
    // transfer that preceded it, the first reading would be nonsense.
    const id = uploadOf(store, { totalBytes: 100 * MB, copiedBytes: 0 });
    transfer(id, [
      { afterMs: 1000, bytes: 50 * MB },
      { afterMs: 1000, bytes: 100 * MB },
    ]);

    store.updateOperation(id, {
      finalizing: true,
      finalizedBytes: 0,
      finalizedTotalBytes: 100 * MB,
    });
    vi.advanceTimersByTime(1000);
    store.updateOperation(id, { finalizedBytes: 20 * MB });

    const text = mountPanel().text();
    expect(text).toContain('Finishing up');
    expect(text).toContain('20 MB/s');
    // The 50 MB/s of the transfer must not leak into the copy's figure.
    expect(text).not.toContain('50 MB/s');
  });

  it('says nothing for an operation that only reports a percentage', () => {
    // Archive extraction streams a percentage and no byte counts at all.
    store.startOperation({ type: 'extract', name: 'archive.zip', percent: 40 });

    const text = mountPanel().text();
    expect(text).toContain('40%');
    expect(text).not.toContain('/s');
  });

  it('forgets the rate when the operation is done', () => {
    // Ids are not reused, but a meter left behind would be a slow leak.
    const id = uploadOf(store, { totalBytes: 100 * MB, copiedBytes: 0 });
    transfer(id, [
      { afterMs: 1000, bytes: 4 * MB },
      { afterMs: 1000, bytes: 8 * MB },
    ]);
    expect(store.rateFor(id)).not.toBeNull();

    store.finishOperation(id);
    expect(store.rateFor(id)).toBeNull();
  });

  it('gives each row in the list its own rate, not the batch total', async () => {
    // The summary speaks for the whole batch; a row that borrowed that figure
    // would claim a single file is moving at everyone's combined speed.
    const first = uploadOf(store, { name: 'a.iso', totalBytes: 100 * MB, copiedBytes: 0 });
    const second = uploadOf(store, { name: 'b.iso', totalBytes: 100 * MB, copiedBytes: 0 });

    vi.advanceTimersByTime(1000);
    store.updateOperation(first, { copiedBytes: 2 * MB });
    store.updateOperation(second, { copiedBytes: 6 * MB });
    vi.advanceTimersByTime(1000);
    store.updateOperation(first, { copiedBytes: 4 * MB });
    store.updateOperation(second, { copiedBytes: 12 * MB });

    const panel = mountPanel();
    expect(panel.text()).toContain('8 MB/s');

    await panel.find('button[aria-expanded]').trigger('click');

    const rows = panel.findAll('[data-testid="operation-row"]');
    const text = rows.length ? rows.map((row) => row.text()).join(' | ') : panel.text();
    expect(text).toContain('2 MB/s');
    expect(text).toContain('6 MB/s');
  });
});
