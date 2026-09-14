import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

/**
 * Collabora and a document's history.
 *
 * Collabora keeps no history of its own here: its File > Revision history entry
 * asks the page, and NextExplorer answers with the Versions panel. So what
 * matters is that only the editor can ask — any window of the page can post a
 * message — that an earlier version opens to be read and never to be edited,
 * and that a restore made in the panel does not leave the frame showing what it
 * replaced.
 */

const fetchCollaboraConfig = vi.fn();
const panel = vi.hoisted(() => ({ store: null }));

vi.mock('@/api', () => ({
  fetchCollaboraConfig: (...args) => fetchCollaboraConfig(...args),
  searchUsersForMention: vi.fn(async () => []),
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));
vi.mock('@/stores/versionsPanel', async () => {
  const { reactive } = await import('vue');
  panel.store = reactive({ restored: 0, relativePath: '', openPath: vi.fn() });
  return { useVersionsPanelStore: () => panel.store };
});
vi.mock('@/utils/logger', () => ({
  default: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), warning: vi.fn() },
}));

const CollaboraPreview = (await import('./CollaboraPreview.vue')).default;

const URL_SRC = 'https://collabora.example.com/browser/dist/cool.html?WOPISrc=x';
const REPORT = { name: 'report.docx', path: 'Docs' };

let wrapper = null;

const mountOn = async (item = REPORT) => {
  wrapper = mount(CollaboraPreview, {
    props: { item, extension: 'docx', filePath: 'Docs/report.docx', previewUrl: '', api: {} },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
};

const frameWindow = () => wrapper.find('iframe').element.contentWindow;

const post = async (data, source) => {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify(data),
      origin: 'https://collabora.example.com',
      source,
    })
  );
  await flushPromises();
};

beforeEach(() => {
  fetchCollaboraConfig.mockReset();
  fetchCollaboraConfig.mockResolvedValue({ urlSrc: URL_SRC });
  if (panel.store) {
    Object.assign(panel.store, { restored: 0, relativePath: '' });
    panel.store.openPath.mockClear();
  }
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('the revision history', () => {
  it('opens the document for editing', async () => {
    await mountOn();

    expect(fetchCollaboraConfig).toHaveBeenCalledWith('Docs/report.docx', 'edit');
  });

  it('opens the Versions panel on the document when the editor asks for it', async () => {
    await mountOn();

    await post({ MessageId: 'UI_FileVersions', Values: {} }, frameWindow());

    expect(panel.store.openPath).toHaveBeenCalledWith('Docs/report.docx');
  });

  it('ignores the same message from any other window of the page', async () => {
    await mountOn();

    await post({ MessageId: 'UI_FileVersions', Values: {} }, window);

    expect(panel.store.openPath).not.toHaveBeenCalled();
  });
});

describe('an earlier version', () => {
  it('opens to be read, by its id, and offers no history of its own', async () => {
    await mountOn({ ...REPORT, versionId: 'v-older-0000000001' });

    expect(fetchCollaboraConfig).toHaveBeenCalledWith('Docs/report.docx', 'view', {
      versionId: 'v-older-0000000001',
    });

    await post({ MessageId: 'UI_FileVersions', Values: {} }, frameWindow());
    expect(panel.store.openPath).not.toHaveBeenCalled();
  });
});

describe('a restore made in the Versions panel', () => {
  it('opens this document again, and leaves the others alone', async () => {
    await mountOn();
    expect(fetchCollaboraConfig).toHaveBeenCalledTimes(1);

    panel.store.relativePath = 'Docs/other.docx';
    panel.store.restored += 1;
    await flushPromises();
    expect(fetchCollaboraConfig).toHaveBeenCalledTimes(1);

    panel.store.relativePath = 'Docs/report.docx';
    panel.store.restored += 1;
    await flushPromises();
    expect(fetchCollaboraConfig).toHaveBeenCalledTimes(2);
  });

  it('leaves an earlier version as it is', async () => {
    await mountOn({ ...REPORT, versionId: 'v-older-0000000001' });

    panel.store.relativePath = 'Docs/report.docx';
    panel.store.restored += 1;
    await flushPromises();

    expect(fetchCollaboraConfig).toHaveBeenCalledTimes(1);
  });
});
