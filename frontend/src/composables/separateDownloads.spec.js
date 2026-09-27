import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Taking a selection away as separate files (#487).
 *
 * The part that can go wrong quietly is the writing: a file the reader already
 * had, replaced without a word, and an empty file left behind by a download
 * that failed. Both look like success from the outside, so both are asserted
 * here rather than in a browser nobody watches.
 */

const api = vi.hoisted(() => ({ fetchDownloadPart: vi.fn(), downloadPartUrl: vi.fn() }));
vi.mock('@/api', () => ({
  fetchDownloadPart: (...args) => api.fetchDownloadPart(...args),
  downloadPartUrl: (...args) => api.downloadPartUrl(...args),
}));

import {
  clickPartsThrough,
  knownTotalBytes,
  partsOf,
  writePartsToFolder,
} from './separateDownloads';

const PLAN = {
  token: 'tok',
  files: [
    { index: 0, name: 'rapport.txt', size: 4 },
    { index: 1, name: 'notes.txt', size: 6 },
  ],
  archive: { name: 'Photos.zip', folders: 1 },
};

const bytes = (text) => new TextEncoder().encode(text);

/** A response whose body arrives in one chunk, as the writer reads it. */
const responseOf = (text) => ({
  body: {
    getReader: () => {
      let sent = false;
      return {
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes(text) };
        },
      };
    },
  },
});

/** A folder on the reader's own machine, with whatever is already in it. */
const makeFolder = (existing = []) => {
  const files = new Map(existing.map((name) => [name, { chunks: [], preexisting: true }]));
  return {
    name: 'Downloads',
    files,
    getFileHandle: async (name, options = {}) => {
      if (!files.has(name)) {
        if (!options.create) {
          const error = new Error(`${name} is not here`);
          error.name = 'NotFoundError';
          throw error;
        }
        files.set(name, { chunks: [] });
      }
      const entry = files.get(name);
      return {
        createWritable: async () => ({
          write: async (chunk) => {
            if (entry.failOnWrite) throw new Error('the disk said no');
            entry.chunks.push(chunk);
          },
          close: async () => {
            entry.closed = true;
          },
          abort: async () => {
            entry.aborted = true;
          },
        }),
      };
    },
    removeEntry: async (name) => {
      files.delete(name);
    },
  };
};

const textOf = (entry) => entry.chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');

beforeEach(() => {
  api.fetchDownloadPart.mockReset();
  api.downloadPartUrl.mockReset();
  api.downloadPartUrl.mockImplementation((token, part) => `https://x/part/${token}/${part}`);
});

describe('the parts of a plan', () => {
  it('are the files, then the one archive holding the folders', () => {
    expect(partsOf(PLAN)).toEqual([
      { part: 0, name: 'rapport.txt', size: 4 },
      { part: 1, name: 'notes.txt', size: 6 },
      { part: 'archive', name: 'Photos.zip', size: null },
    ]);
  });

  it('are only the files when nothing selected was a folder', () => {
    expect(partsOf({ ...PLAN, archive: null }).map(({ part }) => part)).toEqual([0, 1]);
  });

  /**
   * An archive is built as it is sent, so its length is not known beforehand. A
   * total that left it out would be passed while files were still arriving.
   */
  it('report a byte total only when every part has a length', () => {
    expect(knownTotalBytes({ ...PLAN, archive: null })).toBe(10);
    expect(knownTotalBytes(PLAN)).toBe(0);
  });
});

describe('writing the parts into a folder the reader picked', () => {
  it('writes each part under its own name', async () => {
    api.fetchDownloadPart
      .mockResolvedValueOnce(responseOf('abcd'))
      .mockResolvedValueOnce(responseOf('efghij'));
    const folder = makeFolder();

    const result = await writePartsToFolder({
      plan: { ...PLAN, archive: null },
      folder,
    });

    expect(textOf(folder.files.get('rapport.txt'))).toBe('abcd');
    expect(textOf(folder.files.get('notes.txt'))).toBe('efghij');
    expect(folder.files.get('rapport.txt').closed).toBe(true);
    expect(result).toMatchObject({ parts: 2, writtenBytes: 10, renamed: [] });
  });

  /** Never over a file that was already there: the one rule this app has. */
  it('takes another name rather than replacing what is there', async () => {
    api.fetchDownloadPart.mockResolvedValue(responseOf('abcd'));
    const folder = makeFolder(['rapport.txt']);

    const { renamed } = await writePartsToFolder({
      plan: { token: 'tok', files: [{ index: 0, name: 'rapport.txt', size: 4 }], archive: null },
      folder,
    });

    expect(folder.files.get('rapport.txt').preexisting).toBe(true);
    expect(folder.files.get('rapport.txt').chunks).toEqual([]);
    expect(textOf(folder.files.get('rapport (1).txt'))).toBe('abcd');
    expect(renamed).toEqual(['rapport (1).txt']);
  });

  it('keeps looking past a name that is taken twice', async () => {
    api.fetchDownloadPart.mockResolvedValue(responseOf('abcd'));
    const folder = makeFolder(['rapport.txt', 'rapport (1).txt']);

    await writePartsToFolder({
      plan: { token: 'tok', files: [{ index: 0, name: 'rapport.txt', size: 4 }], archive: null },
      folder,
    });

    expect(textOf(folder.files.get('rapport (2).txt'))).toBe('abcd');
  });

  /**
   * The name is taken the moment the handle is created, so a write that fails
   * would otherwise leave an empty file that looks like a download that worked.
   */
  it('leaves nothing behind when a write fails', async () => {
    api.fetchDownloadPart.mockResolvedValue(responseOf('abcd'));
    const folder = makeFolder();
    folder.getFileHandle = async (name, options = {}) => {
      if (!options.create) {
        const absent = new Error(`${name} is not here`);
        absent.name = 'NotFoundError';
        throw absent;
      }
      return {
        createWritable: async () => ({
          write: async () => {
            throw new Error('the disk said no');
          },
          close: async () => {},
          abort: async () => {
            folder.aborted = name;
          },
        }),
      };
    };
    const removed = [];
    folder.removeEntry = async (name) => removed.push(name);

    await expect(
      writePartsToFolder({
        plan: { token: 'tok', files: [{ index: 0, name: 'rapport.txt', size: 4 }], archive: null },
        folder,
      })
    ).rejects.toThrow('the disk said no');

    expect(folder.aborted).toBe('rapport.txt');
    expect(removed).toEqual(['rapport.txt']);
  });

  it('reports what has been written as it goes', async () => {
    api.fetchDownloadPart
      .mockResolvedValueOnce(responseOf('abcd'))
      .mockResolvedValueOnce(responseOf('efghij'));
    const seen = [];

    await writePartsToFolder({
      plan: { ...PLAN, archive: null },
      folder: makeFolder(),
      onProgress: (progress) => seen.push(progress),
    });

    expect(seen.at(-1)).toEqual({ writtenBytes: 10, finishedParts: 2, totalParts: 2 });
    expect(seen.map(({ writtenBytes }) => writtenBytes)).toEqual([4, 4, 10, 10]);
  });

  it('stops where it was asked to stop', async () => {
    api.fetchDownloadPart.mockResolvedValue(responseOf('abcd'));
    const controller = new AbortController();
    controller.abort();

    const result = await writePartsToFolder({
      plan: { ...PLAN, archive: null },
      folder: makeFolder(),
      signal: controller.signal,
    });

    expect(api.fetchDownloadPart).not.toHaveBeenCalled();
    expect(result.parts).toBe(2);
    expect(result.writtenBytes).toBe(0);
  });
});

describe('taking the parts as ordinary downloads', () => {
  it('clicks one anchor per part, each naming its file', async () => {
    const clicked = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function capture() {
        clicked.push({ href: this.getAttribute('href'), name: this.getAttribute('download') });
      });

    await clickPartsThrough({ plan: PLAN, spacingMs: 0 });

    expect(clicked).toEqual([
      { href: 'https://x/part/tok/0', name: 'rapport.txt' },
      { href: 'https://x/part/tok/1', name: 'notes.txt' },
      { href: 'https://x/part/tok/archive', name: 'Photos.zip' },
    ]);
    expect(document.querySelectorAll('a').length).toBe(0);
    click.mockRestore();
  });
});
