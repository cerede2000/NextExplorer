import { mount, flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createI18n } from 'vue-i18n';

/**
 * Reading one file out of an archive, without taking it out.
 *
 * Three things have to hold: what is drawn is decided by the name and not by
 * what the server says the bytes are, nothing enormous is ever pulled into the
 * tab, and markup that arrives inside somebody else's archive is sanitised
 * before it reaches the page.
 */

const readArchiveEntry = vi.hoisted(() => vi.fn());
vi.mock('@/api', () => ({ readArchiveEntry }));

// The explorer's notion of text comes from a store fed by the server; what it
// answers is not what this is about.
vi.mock('@/config/editor', () => ({
  isEditableExtension: (extension) => ['txt', 'json', 'log'].includes(extension),
}));

const ArchiveEntryReader = (await import('./ArchiveEntryReader.vue')).default;

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      common: { loading: 'Loading' },
      archive: {
        readFailed: 'This file could not be read.',
        notReadable: 'This kind of file cannot be shown here.',
        tooBigToRead: 'Too large: {size}, up to {ceiling}.',
      },
    },
  },
});

/** An answer from the entry endpoint: a length, and bytes of one shape or another. */
const answer = ({ length = null, text = '', blob = null } = {}) => ({
  headers: { get: (name) => (name.toLowerCase() === 'content-length' ? length : null) },
  text: async () => text,
  blob: async () => blob || new Blob([text]),
});

/**
 * Long enough for the markdown renderer to arrive.
 *
 * It is loaded on demand, and a module load is not a microtask: flushing
 * promises once returns while the import is still in flight.
 */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const read = async (entry, options = {}) => {
  const wrapper = mount(ArchiveEntryReader, {
    props: { filePath: 'Work/backup.zip', entry },
    global: { plugins: [i18n], ...options.global },
  });
  await flushPromises();
  return wrapper;
};

const urls = [];
const revoked = [];

beforeEach(() => {
  readArchiveEntry.mockReset();
  urls.length = 0;
  revoked.length = 0;
  // jsdom has no object URLs of its own.
  globalThis.URL.createObjectURL = vi.fn((blob) => {
    const url = `blob:archive/${urls.length}`;
    urls.push({ url, blob });
    return url;
  });
  globalThis.URL.revokeObjectURL = vi.fn((url) => revoked.push(url));
});

afterEach(() => {
  delete globalThis.URL.createObjectURL;
  delete globalThis.URL.revokeObjectURL;
});

describe('reading an entry', () => {
  it('shows a text file as it is', async () => {
    readArchiveEntry.mockResolvedValue(answer({ text: 'first line\nsecond line', length: '22' }));

    const wrapper = await read({ name: 'notes.txt', path: 'docs/notes.txt', size: 22 });

    expect(readArchiveEntry).toHaveBeenCalledWith(
      'Work/backup.zip',
      'docs/notes.txt',
      expect.anything()
    );
    expect(wrapper.find('[data-testid="archive-reader-text"]').text()).toContain('second line');
  });

  it('renders markdown, and keeps its script out of the page', async () => {
    readArchiveEntry.mockResolvedValue(
      answer({ text: '# Title\n\nA paragraph.\n\n<script>window.stolen = 1;</script>\n' })
    );

    const wrapper = await read({ name: 'notes.md', path: 'notes.md', size: 40 });
    await settle();

    const rendered = wrapper.find('[data-testid="archive-reader-markdown"]');
    expect(rendered.html()).toContain('<h1>Title</h1>');
    expect(rendered.html()).not.toContain('<script');
  });

  it('draws an image from the bytes themselves, and lets the URL go', async () => {
    const blob = new Blob(['not really a png'], { type: 'image/png' });
    readArchiveEntry.mockResolvedValue(answer({ blob, length: '16' }));

    const wrapper = await read({ name: 'photo.png', path: 'img/photo.png', size: 16 });

    const image = wrapper.find('[data-testid="archive-reader-image"]');
    expect(image.attributes('src')).toBe('blob:archive/0');
    expect(image.attributes('alt')).toBe('photo.png');
    expect(urls[0].blob).toBe(blob);

    wrapper.unmount();
    expect(revoked).toEqual(['blob:archive/0']);
  });

  it('refuses a file the listing already says is too large, without asking for it', async () => {
    const wrapper = await read({ name: 'huge.txt', path: 'huge.txt', size: 8 * 1024 * 1024 });

    expect(readArchiveEntry).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="archive-reader-error"]').text()).toContain('Too large');
  });

  it('refuses a file whose answer turns out to be too large, before reading its body', async () => {
    const text = vi.fn(async () => 'never read');
    readArchiveEntry.mockResolvedValue({
      headers: { get: () => String(8 * 1024 * 1024) },
      text,
      blob: vi.fn(),
    });

    const wrapper = await read({ name: 'unknown.txt', path: 'unknown.txt', size: null });

    expect(text).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="archive-reader-error"]').text()).toContain('Too large');
  });

  it('allows an image past the ceiling text stops at', async () => {
    readArchiveEntry.mockResolvedValue(answer({ blob: new Blob(['x']), length: '1' }));

    const wrapper = await read({ name: 'big.png', path: 'big.png', size: 8 * 1024 * 1024 });

    expect(readArchiveEntry).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="archive-reader-image"]').exists()).toBe(true);
  });

  it('says so when the panel cannot show this kind of file at all', async () => {
    const wrapper = await read({ name: 'devinv.dll', path: 'devinv.dll', size: 10 });

    expect(readArchiveEntry).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="archive-reader-error"]').text()).toBe(
      'This kind of file cannot be shown here.'
    );
  });

  it('repeats what the server said went wrong', async () => {
    readArchiveEntry.mockRejectedValue(new Error('This archive is protected by a password.'));

    const wrapper = await read({ name: 'notes.txt', path: 'notes.txt', size: 10 });

    expect(wrapper.find('[data-testid="archive-reader-error"]').text()).toBe(
      'This archive is protected by a password.'
    );
  });

  it('reads the entry again when another one is opened', async () => {
    readArchiveEntry.mockResolvedValue(answer({ text: 'one' }));
    const wrapper = await read({ name: 'a.txt', path: 'a.txt', size: 3 });

    readArchiveEntry.mockResolvedValue(answer({ text: 'two' }));
    await wrapper.setProps({ entry: { name: 'b.txt', path: 'b.txt', size: 3 } });
    await flushPromises();

    expect(readArchiveEntry).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="archive-reader-text"]').text()).toBe('two');
  });
});
