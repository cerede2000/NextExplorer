import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * An entry in a listing, opened in a tab behind.
 *
 * The rule the row, the listing's keyboard and the middle button all ask, which
 * is why it is held here rather than in any of them: what counts as somewhere to
 * be, where the tab lands, and when there is no tab to land in at all.
 */

const findPlugin = vi.fn(() => ({ plugin: { id: 'preview' } }));
vi.mock('@/plugins/preview/manager', () => ({
  usePreviewManager: () => ({ findPlugin: (...args) => findPlugin(...args) }),
}));
const userSettings = { markdownOpensInEditor: false };
vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => ({ userSettings }) }));
vi.mock('@/config/editor', () => ({
  isEditableExtension: (extension) => ['txt', 'md'].includes(extension),
}));

import { useOpenItemInTab } from './itemAddress';
import { useTabsStore } from '@/stores/tabs';

const FOLDER = { name: '2026', path: '', kind: 'directory' };
const DOCUMENT = { name: 'report.docx', path: 'Docs', kind: 'docx' };

beforeEach(() => {
  setActivePinia(createPinia());
  findPlugin.mockReturnValue({ plugin: { id: 'preview' } });
  userSettings.markdownOpensInEditor = false;
});

/** Tabs on, and the reader looking at a folder. */
const browsing = () => {
  const tabs = useTabsStore();
  tabs.setEnabled(true);
  tabs.syncActive('/browse/Docs');
  return tabs;
};

describe('opening an entry in a tab', () => {
  it('opens a document at its own address, behind', () => {
    const tabs = browsing();
    const { openItemInTab } = useOpenItemInTab();

    expect(openItemInTab(DOCUMENT, 'Docs')).toBe(true);

    expect(tabs.tabs.map((tab) => tab.path)).toContain('/open/Docs/report.docx');
    // Behind: somebody queuing up three documents is still reading the folder.
    expect(tabs.activeTab.path).toBe('/browse/Docs');
  });

  it('opens a folder, named from where it was seen', () => {
    const tabs = browsing();
    const { openItemInTab } = useOpenItemInTab();

    expect(openItemInTab(FOLDER, 'Docs')).toBe(true);

    expect(tabs.tabs.map((tab) => tab.path)).toContain('/browse/Docs/2026');
  });

  /** A tab opened *for* this, which is what lets its own cross close it. */
  it('marks the tab as opened for what is in it', () => {
    const tabs = browsing();
    const { openItemInTab } = useOpenItemInTab();

    openItemInTab(DOCUMENT, 'Docs');

    expect(tabs.tabs.find((tab) => tab.path === '/open/Docs/report.docx').own).toBe(true);
  });

  /** A file with neither a preview nor an editor is a download, not a place. */
  it('does nothing for an entry with nowhere of its own', () => {
    const tabs = browsing();
    findPlugin.mockReturnValue(null);
    const { openItemInTab } = useOpenItemInTab();

    expect(openItemInTab({ name: 'firmware.bin', path: 'Docs', kind: 'bin' }, 'Docs')).toBe(false);
    expect(tabs.count).toBe(1);
  });

  /**
   * With tabs off the store has one tab and would take it there, which is a
   * navigation nobody asked for. So it is not offered at all.
   */
  it('does nothing, and says so, when tabs are off', () => {
    const tabs = useTabsStore();
    tabs.setEnabled(false);
    const before = tabs.activeTab.path;
    const { openItemInTab } = useOpenItemInTab();

    expect(openItemInTab(DOCUMENT, 'Docs')).toBe(false);

    expect(tabs.count).toBe(1);
    expect(tabs.activeTab.path).toBe(before);
  });
});
