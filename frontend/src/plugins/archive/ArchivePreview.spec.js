import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createI18n } from 'vue-i18n';

/**
 * Looking inside an archive.
 *
 * What the panel has to get right is small and easy to lose: a folder is a way
 * in and a file is a way out, going back is a step of the trail rather than a
 * reload, and an archive that carries names pointing outside itself says so
 * instead of quietly showing fewer files than it holds.
 */

const browseArchive = vi.hoisted(() => vi.fn());
const extractFromArchive = vi.hoisted(() => vi.fn());
const archiveEntryUrl = vi.hoisted(() =>
  vi.fn(
    (path, entry) =>
      `/api/archive/entry?path=${encodeURIComponent(path)}&entry=${encodeURIComponent(entry)}`
  )
);

vi.mock('@/api', () => ({ browseArchive, archiveEntryUrl, extractFromArchive }));

// The explorer's own icon, which reaches for the file store and thumbnails it
// has no business loading for something that is not on disk.
vi.mock('@/icons/FileIcon.vue', () => ({
  default: { name: 'FileIconStub', props: ['item'], template: '<span />' },
}));

const ArchivePreview = (await import('./ArchivePreview.vue')).default;

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: { loading: 'Loading', name: 'Name', size: 'Size', modified: 'Modified' },
      archive: {
        breadcrumb: 'Inside the archive',
        empty: 'This folder is empty.',
        download: 'Download',
        downloadNamed: 'Download {name}',
        outside:
          'One entry is not shown: its name points outside the archive. | {count} entries are not shown: their names point outside the archive.',
        unreadable: 'This archive could not be read.',
        count: 'One entry in this archive | {count} entries in this archive',
        extract: 'Extract here',
        extractNamed: 'Extract {name} here',
        extracted: 'Extracted: {name}',
        extractedNothing: 'Nothing came out of it.',
        extractFailed: 'This could not be extracted.',
      },
    },
  },
});

const TOP = {
  path: 'Work/backup.zip',
  name: 'backup.zip',
  inside: '',
  total: 4,
  outside: 0,
  entries: [
    { name: 'docs', path: 'docs', isDirectory: true, size: null, modified: null },
    {
      name: 'notes.txt',
      path: 'notes.txt',
      isDirectory: false,
      size: 12,
      modified: '2026-09-16 11:22:33',
    },
  ],
};

const INSIDE_DOCS = {
  ...TOP,
  inside: 'docs',
  entries: [
    { name: 'report.txt', path: 'docs/report.txt', isDirectory: false, size: 4096, modified: null },
  ],
};

const open = async (levels = [TOP]) => {
  browseArchive.mockReset();
  for (const level of levels) browseArchive.mockResolvedValueOnce(level);
  const wrapper = mount(ArchivePreview, {
    props: {
      item: { name: 'backup.zip', kind: 'zip', path: 'Work' },
      extension: 'zip',
      filePath: 'Work/backup.zip',
    },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return wrapper;
};

/** The name of each row: the button that opens a folder, or the file's own text. */
/** The name of each row: the button that opens a folder, or the file's own text. */
const rowNames = (wrapper) =>
  wrapper
    .findAll('[data-testid="archive-entries"] li')
    .map((row) => row.find('button[title], span[title]').text());

beforeEach(() => {
  archiveEntryUrl.mockClear();
  extractFromArchive.mockReset();
});

describe('opening an archive', () => {
  it('asks for the top of it, and lists what is there', async () => {
    const wrapper = await open();

    expect(browseArchive).toHaveBeenCalledWith('Work/backup.zip', '');
    expect(rowNames(wrapper)).toEqual(['docs', 'notes.txt']);
  });

  it('shows the size of a file and nothing for a folder', async () => {
    const wrapper = await open();
    const rows = wrapper.findAll('[data-testid="archive-entries"] li');

    expect(rows[1].text()).toContain('12 Bytes');
    expect(rows[0].text()).not.toContain('Bytes');
  });

  it('offers a file for download, by the address the server hands it out at', async () => {
    const wrapper = await open();
    const link = wrapper.find('[data-testid="archive-entries"] a');

    expect(link.attributes('href')).toBe(
      '/api/archive/entry?path=Work%2Fbackup.zip&entry=notes.txt'
    );
    expect(link.attributes('download')).toBeDefined();
  });

  /** A folder inside an archive is not a file: there is nothing to hand over. */
  it('offers no download for a folder', async () => {
    const wrapper = await open();
    const rows = wrapper.findAll('[data-testid="archive-entries"] li');

    expect(rows[0].find('a').exists()).toBe(false);
  });

  it('says how many entries the whole archive holds', async () => {
    const wrapper = await open();

    expect(wrapper.find('[data-testid="archive-count"]').text()).toBe('4 entries in this archive');
  });

  it('says a folder is empty rather than showing nothing at all', async () => {
    const wrapper = await open([{ ...TOP, entries: [] }]);

    expect(wrapper.find('[data-testid="archive-empty"]').text()).toBe('This folder is empty.');
  });
});

describe('going down and back up', () => {
  it('opens a folder by asking the server for that level', async () => {
    const wrapper = await open([TOP, INSIDE_DOCS]);

    await wrapper.find('[data-testid="archive-entries"] button[title="docs"]').trigger('click');
    await flushPromises();

    expect(browseArchive).toHaveBeenLastCalledWith('Work/backup.zip', 'docs');
    expect(rowNames(wrapper)).toEqual(['report.txt']);
  });

  it('keeps the archive and every folder of the way as a step back', async () => {
    const wrapper = await open([TOP, INSIDE_DOCS]);
    await wrapper.find('[data-testid="archive-entries"] button[title="docs"]').trigger('click');
    await flushPromises();

    const trail = wrapper.findAll('nav button').map((button) => button.text());
    expect(trail).toEqual(['backup.zip', 'docs']);

    browseArchive.mockResolvedValueOnce(TOP);
    await wrapper.findAll('nav button')[0].trigger('click');
    await flushPromises();

    expect(browseArchive).toHaveBeenLastCalledWith('Work/backup.zip', '');
    expect(rowNames(wrapper)).toEqual(['docs', 'notes.txt']);
  });

  /** Where you already are is not a link. */
  it('leaves the step you are on unclickable', async () => {
    const wrapper = await open([TOP, INSIDE_DOCS]);
    await wrapper.find('[data-testid="archive-entries"] button[title="docs"]').trigger('click');
    await flushPromises();

    const trail = wrapper.findAll('nav button');
    expect(trail[0].attributes('disabled')).toBeUndefined();
    expect(trail[1].attributes('disabled')).toBeDefined();
  });
});

describe('an archive that has something to hide', () => {
  it('says how many entries point outside it', async () => {
    const wrapper = await open([{ ...TOP, outside: 2 }]);

    expect(wrapper.find('[data-testid="archive-outside"]').text()).toBe(
      '2 entries are not shown: their names point outside the archive.'
    );
  });

  it('says nothing when every entry is where it says it is', async () => {
    const wrapper = await open();

    expect(wrapper.find('[data-testid="archive-outside"]').exists()).toBe(false);
  });

  /**
   * The server tells an archive behind a password from a damaged one, in its
   * own sentence. Replacing that with one of ours would lose the difference.
   */
  it('shows what the server said it could not do', async () => {
    browseArchive.mockReset();
    browseArchive.mockRejectedValueOnce(
      new Error('This archive is protected by a password and cannot be browsed.')
    );
    const wrapper = mount(ArchivePreview, {
      props: {
        item: { name: 'secret.zip', kind: 'zip', path: 'Work' },
        extension: 'zip',
        filePath: 'Work/secret.zip',
      },
      global: { plugins: [i18n] },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="archive-error"]').text()).toBe(
      'This archive is protected by a password and cannot be browsed.'
    );
    expect(wrapper.find('[data-testid="archive-entries"]').exists()).toBe(false);
  });

  it('has something to say even when the failure does not', async () => {
    browseArchive.mockReset();
    browseArchive.mockRejectedValueOnce(new Error(''));
    const wrapper = mount(ArchivePreview, {
      props: {
        item: { name: 'secret.zip', kind: 'zip', path: 'Work' },
        extension: 'zip',
        filePath: 'Work/secret.zip',
      },
      global: { plugins: [i18n] },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="archive-error"]').text()).toBe(
      'This archive could not be read.'
    );
  });
});

/**
 * Taking something out onto the volume.
 *
 * The half that makes the panel more than a viewer: what is found here is
 * wanted *there*, and downloading it to put it back is not an answer on a
 * server somebody reaches from a phone.
 */
describe('extracting an entry', () => {
  const extractButton = (wrapper, name) =>
    wrapper.find(`[data-testid="archive-entries"] button[aria-label="Extract ${name} here"]`);

  it('asks the server for that entry, and says what it was called when it landed', async () => {
    const wrapper = await open();
    extractFromArchive.mockResolvedValueOnce({ items: [{ name: 'notes (1).txt' }] });

    await extractButton(wrapper, 'notes.txt').trigger('click');
    await flushPromises();

    expect(extractFromArchive).toHaveBeenCalledWith('Work/backup.zip', ['notes.txt']);
    expect(wrapper.find('[data-testid="archive-took"]').text()).toBe('Extracted: notes (1).txt');
  });

  /** A folder is taken out whole, which is the point of offering it at all. */
  it('offers it for a folder too', async () => {
    const wrapper = await open();
    extractFromArchive.mockResolvedValueOnce({ items: [{ name: 'docs' }] });

    await extractButton(wrapper, 'docs').trigger('click');
    await flushPromises();

    expect(extractFromArchive).toHaveBeenCalledWith('Work/backup.zip', ['docs']);
  });

  it('shows what the server said when it refused', async () => {
    const wrapper = await open();
    extractFromArchive.mockRejectedValueOnce(new Error('Destination is read-only.'));

    await extractButton(wrapper, 'notes.txt').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="archive-error"]').text()).toBe('Destination is read-only.');
  });
});
