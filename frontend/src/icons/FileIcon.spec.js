import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

/**
 * The icon on every row, and the thumbnail that replaces it.
 *
 * 117 statements at zero, rendered once per file in every listing — so this is
 * the most-executed component in the application and the least tested. The
 * icon choice is a chain of `v-else-if` where order is the whole meaning: a
 * directory before anything, a PDF before the thumbnail branch (PDF thumbnails
 * are deliberately not shown), and the thumbnail before the type icons.
 *
 * The half that goes wrong quietly is the requesting. A thumbnail is asked for
 * only when the row is near the viewport, only once per row, and a row whose
 * source is missing is flagged so the retry loop stops — twenty attempts with a
 * growing delay, per row, is what that guard is holding back on a folder of
 * several thousand.
 */

const ensureItemThumbnail = vi.fn();
let thumbnailsEnabled = true;

vi.mock('@/api', () => ({ apiBase: 'https://files.example.com' }));
vi.mock('@/stores/fileStore', () => ({
  useFileStore: () => ({ ensureItemThumbnail }),
}));
vi.mock('@/stores/appSettings', () => ({
  useAppSettings: () => ({
    get thumbnailsEnabledForSession() {
      return thumbnailsEnabled;
    },
  }),
}));
vi.mock('@/config/media', () => ({
  isPreviewableImage: (ext) => ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext),
  isPreviewableVideo: (ext) => ['mp4', 'mkv', 'webm'].includes(ext),
}));

import FileIcon from './FileIcon.vue';

/** Observers are created per instance; this keeps the last one reachable. */
let observers = [];
const fakeObserver = () => {
  observers = [];
  class FakeIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      observers.push(this);
    }

    observe(element) {
      this.observed.push(element);
    }

    disconnect() {
      this.disconnected = true;
    }

    /** Pretend the row scrolled into or out of view. */
    trigger(isIntersecting) {
      this.callback([{ isIntersecting }]);
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
};

const file = (overrides = {}) => ({
  name: 'a.txt',
  path: 'Docs',
  kind: 'txt',
  ...overrides,
});

const render = async (item, props = {}) => {
  const wrapper = mount(FileIcon, { props: { item, ...props } });
  await flushPromises();
  return wrapper;
};

/** Which of the icon components rendered, by its registered name. */
const iconName = (wrapper) => {
  for (const name of [
    'DirectoryIcon',
    'PdfIcon',
    'ImageIcon',
    'VideoIcon',
    'AudioIcon',
    'ArchiveIcon',
    'FileBadgeIcon',
    'CodeIcon',
    'TxtIcon',
  ]) {
    if (wrapper.findComponent({ name }).exists()) return name;
  }
  return null;
};

beforeEach(() => {
  ensureItemThumbnail.mockReset();
  ensureItemThumbnail.mockResolvedValue('/api/thumbnails/a.jpg');
  thumbnailsEnabled = true;
  fakeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('which icon a row gets', () => {
  it.each([
    ['directory', 'directory', 'DirectoryIcon'],
    ['pdf', 'pdf', 'PdfIcon'],
    ['jpg', 'jpg', 'ImageIcon'],
    ['mp4', 'mp4', 'VideoIcon'],
    ['flac', 'flac', 'AudioIcon'],
    ['7z', '7z', 'ArchiveIcon'],
    ['an unknown kind', 'xyzzy', 'TxtIcon'],
  ])('%s gets %s', async (_label, kind, expected) => {
    const wrapper = await render(file({ kind }));

    expect(iconName(wrapper)).toBe(expected);
  });

  it('gives a badge to a kind the badge table knows', async () => {
    const wrapper = await render(file({ kind: 'docx' }));

    expect(iconName(wrapper)).toBe('FileBadgeIcon');
  });

  it('matches the kind whatever its case', async () => {
    const wrapper = await render(file({ kind: 'JPG' }));

    expect(iconName(wrapper)).toBe('ImageIcon');
  });

  it('falls back to the text icon when there is no kind at all', async () => {
    const wrapper = await render({ name: 'LICENSE', path: 'Docs' });

    expect(iconName(wrapper)).toBe('TxtIcon');
  });
});

describe('the thumbnail, when there is one', () => {
  const withThumb = (overrides = {}) =>
    file({ kind: 'jpg', supportsThumbnail: true, thumbnail: '/api/thumbnails/a.jpg', ...overrides });

  it('replaces the type icon', async () => {
    const wrapper = await render(withThumb());

    expect(iconName(wrapper)).toBeNull();
    expect(wrapper.find('div[style]').attributes('style')).toContain(
      'https://files.example.com/api/thumbnails/a.jpg'
    );
  });

  it('uses an absolute url as given, without prefixing the api base', async () => {
    const wrapper = await render(withThumb({ thumbnail: 'https://cdn.example.com/a.jpg' }));

    expect(wrapper.find('div[style]').attributes('style')).toContain(
      'https://cdn.example.com/a.jpg'
    );
    expect(wrapper.find('div[style]').attributes('style')).not.toContain('files.example.com');
  });

  /**
   * A directory always shows a folder, and a PDF always shows the PDF icon.
   * Both branches sit above the thumbnail one on purpose.
   */
  it.each([
    ['a directory', 'directory', 'DirectoryIcon'],
    ['a PDF', 'pdf', 'PdfIcon'],
  ])('is not shown for %s even when one exists', async (_label, kind, expected) => {
    const wrapper = await render(withThumb({ kind }));

    expect(iconName(wrapper)).toBe(expected);
  });

  it('is not shown when the caller switched thumbnails off for this list', async () => {
    const wrapper = await render(withThumb(), { disableThumbnails: true });

    expect(iconName(wrapper)).toBe('ImageIcon');
  });

  it('is not shown when they are off for the session', async () => {
    thumbnailsEnabled = false;
    const wrapper = await render(withThumb());

    expect(iconName(wrapper)).toBe('ImageIcon');
  });

  it('is not shown for a file that does not support one', async () => {
    const wrapper = await render(withThumb({ supportsThumbnail: false }));

    expect(iconName(wrapper)).toBe('ImageIcon');
  });
});

describe('asking for a thumbnail that is not there yet', () => {
  const needsThumb = (overrides = {}) =>
    file({ kind: 'jpg', supportsThumbnail: true, ...overrides });

  it('does not ask before the row is anywhere near the viewport', async () => {
    await render(needsThumb());

    expect(ensureItemThumbnail).not.toHaveBeenCalled();
  });

  it('asks once the row scrolls into view', async () => {
    await render(needsThumb());

    observers[0].trigger(true);
    await flushPromises();

    expect(ensureItemThumbnail).toHaveBeenCalledTimes(1);
  });

  /** Scrolling back and forth over one row must not re-ask on every pass. */
  it('does not ask twice while the row stays in view', async () => {
    await render(needsThumb());

    observers[0].trigger(true);
    observers[0].trigger(true);
    await flushPromises();

    expect(ensureItemThumbnail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a directory', { kind: 'directory' }],
    ['a file that supports none', { supportsThumbnail: false }],
    ['one that already has one', { thumbnail: '/api/thumbnails/a.jpg' }],
    ['a kind with no preview', { kind: 'txt' }],
  ])('never asks for %s', async (_label, overrides) => {
    await render(needsThumb(overrides));

    observers[0]?.trigger(true);
    await flushPromises();

    expect(ensureItemThumbnail).not.toHaveBeenCalled();
  });

  /**
   * The flag the server sets when the source is missing or unsupported. Without
   * honouring it, every listing re-asks for a thumbnail that will never exist,
   * twenty times per row.
   */
  it('never asks again for one the server said it cannot make', async () => {
    await render(needsThumb({ thumbnailUnavailable: true }));

    observers[0].trigger(true);
    await flushPromises();

    expect(ensureItemThumbnail).not.toHaveBeenCalled();
  });

  it('does not ask when the caller switched thumbnails off', async () => {
    await render(needsThumb(), { disableThumbnails: true });

    observers[0]?.trigger(true);
    await flushPromises();

    expect(ensureItemThumbnail).not.toHaveBeenCalled();
  });
});

describe('retrying a thumbnail that is still being made', () => {
  const needsThumb = () => file({ kind: 'jpg', supportsThumbnail: true });

  it('tries again after a delay when nothing came back', async () => {
    vi.useFakeTimers();
    ensureItemThumbnail.mockResolvedValue(null);
    const wrapper = mount(FileIcon, { props: { item: needsThumb() } });
    await vi.advanceTimersByTimeAsync(0);

    observers[0].trigger(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ensureItemThumbnail).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1200);
    expect(ensureItemThumbnail).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('stops retrying once one arrives', async () => {
    vi.useFakeTimers();
    ensureItemThumbnail.mockResolvedValueOnce(null).mockResolvedValue('/api/thumbnails/a.jpg');
    const wrapper = mount(FileIcon, { props: { item: needsThumb() } });
    await vi.advanceTimersByTimeAsync(0);

    observers[0].trigger(true);
    await vi.advanceTimersByTimeAsync(5000);
    const settled = ensureItemThumbnail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);

    expect(ensureItemThumbnail).toHaveBeenCalledTimes(settled);
    wrapper.unmount();
  });

  /** Scrolling a row away must stop its retries, not leave them running. */
  it('stops retrying when the row leaves the viewport', async () => {
    vi.useFakeTimers();
    ensureItemThumbnail.mockResolvedValue(null);
    const wrapper = mount(FileIcon, { props: { item: needsThumb() } });
    await vi.advanceTimersByTimeAsync(0);
    observers[0].trigger(true);
    await vi.advanceTimersByTimeAsync(0);

    observers[0].trigger(false);
    const before = ensureItemThumbnail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);

    expect(ensureItemThumbnail).toHaveBeenCalledTimes(before);
    wrapper.unmount();
  });

  it('gives up rather than retrying for ever', async () => {
    vi.useFakeTimers();
    ensureItemThumbnail.mockResolvedValue(null);
    const wrapper = mount(FileIcon, { props: { item: needsThumb() } });
    await vi.advanceTimersByTimeAsync(0);
    observers[0].trigger(true);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(ensureItemThumbnail.mock.calls.length).toBeLessThanOrEqual(21);
    wrapper.unmount();
  });
});

describe('when the row is reused for a different file', () => {
  /**
   * Virtualised lists reuse a component for a new item. The request state has
   * to reset with it, or the new file inherits "already asked" and never gets
   * a thumbnail at all.
   */
  it('asks again for the new file', async () => {
    const wrapper = await render(file({ kind: 'jpg', supportsThumbnail: true }));
    observers[0].trigger(true);
    await flushPromises();
    ensureItemThumbnail.mockClear();

    await wrapper.setProps({
      item: file({ name: 'b.jpg', kind: 'jpg', supportsThumbnail: true }),
    });
    await flushPromises();
    observers.at(-1).trigger(true);
    await flushPromises();

    expect(ensureItemThumbnail).toHaveBeenCalled();
  });
});

describe('without an IntersectionObserver', () => {
  /** Older browsers, and jsdom in some setups: the rows must still get icons. */
  it('treats every row as visible rather than showing nothing', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);

    await render(file({ kind: 'jpg', supportsThumbnail: true }));
    await flushPromises();

    expect(ensureItemThumbnail).toHaveBeenCalled();
  });
});
