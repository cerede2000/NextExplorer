import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the client actually sends for each thing a person does.
 *
 * These are thin functions, and thin is why they were untested and why they are
 * worth pinning: every one of them is half of a contract whose other half lives
 * in `backend/src/routes`, and nothing checks that the two halves agree. A path
 * that stops being normalised, an encoding dropped from a filename with a `#`
 * in it, a payload field renamed — none of that fails a type check, and none of
 * it fails until somebody clicks the thing.
 *
 * The refusals matter as much as the requests. Several of these throw rather
 * than send an empty path, because an empty path at these endpoints means the
 * volume root: a download of everything, a thumbnail of a directory.
 */

const requestJson = vi.fn();
const requestStream = vi.fn();
const requestRaw = vi.fn();

vi.mock('./http', () => ({
  requestJson: (...a) => requestJson(...a),
  requestStream: (...a) => requestStream(...a),
  requestRaw: (...a) => requestRaw(...a),
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
  encodePath: (p = '') =>
    String(p)
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/'),
  buildUrl: (p) => `https://files.example.com${p}`,
}));

import {
  browse,
  createFile,
  createFolder,
  createOfficeDocument,
  compressToZip,
  extractZip,
  fetchFileContent,
  fetchMetadata,
  fetchSharedFileContent,
  fetchThumbnail,
  getPreviewUrl,
  getRawFileUrl,
  renameItem,
  reserveFolderUploadTarget,
  saveFileContent,
  saveSharedFileContent,
  search,
} from './files.api';

/** The endpoint and parsed body of the single request that was made. */
const sent = (mock = requestJson) => {
  const [endpoint, options = {}] = mock.mock.calls[0];
  return {
    endpoint,
    method: options.method,
    body: options.body ? JSON.parse(options.body) : undefined,
    options,
  };
};

const rejection = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

beforeEach(() => {
  [requestJson, requestStream, requestRaw].forEach((m) => m.mockReset());
  requestJson.mockResolvedValue({});
  requestStream.mockResolvedValue({});
});

describe('creating things', () => {
  it('posts a folder to its destination', async () => {
    await createFolder('/Docs/2026/', 'New folder');

    expect(sent()).toMatchObject({
      endpoint: '/api/files/folder',
      method: 'POST',
      body: { path: 'Docs/2026', name: 'New folder' },
    });
  });

  /** No name means "you choose one", which is not the same as an empty one. */
  it('omits the name rather than sending an empty one', async () => {
    await createFolder('Docs', '   ');

    expect(sent().body).toEqual({ path: 'Docs' });
  });

  it('posts a file to the same shape at its own endpoint', async () => {
    await createFile('Docs', 'notes.txt');

    expect(sent()).toMatchObject({
      endpoint: '/api/files/file',
      body: { path: 'Docs', name: 'notes.txt' },
    });
  });

  /**
   * A document is not a file with an office extension — an empty .docx opens in
   * nothing — so it has its own endpoint and carries the format.
   */
  it('posts a document with its format', async () => {
    await createOfficeDocument('Docs', { format: 'docx', name: 'Report' });

    expect(sent()).toMatchObject({
      endpoint: '/api/files/office-document',
      body: { path: 'Docs', format: 'docx', name: 'Report' },
    });
  });

  it('trims the document name', async () => {
    await createOfficeDocument('Docs', { format: 'xlsx', name: '  Budget  ' });

    expect(sent().body.name).toBe('Budget');
  });

  it('creates at the volume root when the destination is empty', async () => {
    await createFolder('', 'Top');

    expect(sent().body.path).toBe('');
  });
});

describe('reserving a folder upload', () => {
  it('sends the destination and the folder being uploaded', async () => {
    await reserveFolderUploadTarget('/Docs/', 'photos');

    expect(sent()).toMatchObject({
      endpoint: '/api/upload/folder-session',
      body: { uploadTo: 'Docs', sourceRoot: 'photos' },
    });
  });

  it.each([
    ['no destination', ['', 'photos']],
    ['no folder name', ['Docs', '   ']],
    ['a folder name that is not a string', ['Docs', 42]],
  ])('refuses %s rather than sending it', async (_label, args) => {
    expect(await rejection(reserveFolderUploadTarget(...args))).toBeInstanceOf(Error);
    expect(requestJson).not.toHaveBeenCalled();
  });
});

describe('renaming', () => {
  it('sends the folder, the old name and the new one separately', async () => {
    await renameItem('/Docs/2026/', 'old.txt', 'new.txt');

    expect(sent()).toMatchObject({
      endpoint: '/api/files/rename',
      body: { path: 'Docs/2026', name: 'old.txt', newName: 'new.txt' },
    });
  });
});

describe('the editor', () => {
  it('asks for a file by posting its path, not by putting it in the url', async () => {
    await fetchFileContent('Docs/notes #1.md');

    expect(sent()).toMatchObject({
      endpoint: '/api/editor',
      method: 'POST',
      body: { path: 'Docs/notes #1.md' },
    });
  });

  it('saves with a PUT', async () => {
    await saveFileContent('Docs/notes.md', '# hello');

    expect(sent()).toMatchObject({ endpoint: '/api/editor', method: 'PUT' });
    expect(sent().body.content).toBe('# hello');
  });
});

describe('the editor inside a share', () => {
  /** The token is in the path, so it has to be encoded like one. */
  it('encodes the token and every segment of the inner path', async () => {
    await fetchSharedFileContent('tok/en+1', '/My Folder/notes #1.md/');

    expect(sent().endpoint).toBe(
      '/api/share/tok%2Fen%2B1/editor/My%20Folder/notes%20%231.md'
    );
  });

  it('drops the inner path entirely when the share is one file', async () => {
    await fetchSharedFileContent('abc');

    expect(sent().endpoint).toBe('/api/share/abc/editor');
  });

  it('saves to the same address with a PUT', async () => {
    await saveSharedFileContent('abc', 'notes.md', 'body');

    expect(sent()).toMatchObject({
      endpoint: '/api/share/abc/editor/notes.md',
      method: 'PUT',
      body: { content: 'body' },
    });
  });
});

describe('thumbnails', () => {
  it('encodes the path into the url', async () => {
    await fetchThumbnail('Media/holiday photos/#1.jpg');

    expect(sent().endpoint).toBe('/api/thumbnails/Media/holiday%20photos/%231.jpg');
  });

  /** A missing thumbnail is normal. It must not put a toast on screen. */
  it('opts out of the global error handler', async () => {
    await fetchThumbnail('Media/a.jpg');

    expect(sent().options.suppressErrorHandler).toBe(true);
  });

  it('marks a background request so the server can deprioritise it', async () => {
    await fetchThumbnail('Media/a.jpg', { background: true });

    expect(sent().endpoint).toContain('?background=1');
  });

  it('refuses an empty path, which would mean the volume root', async () => {
    expect(await rejection(fetchThumbnail(''))).toBeInstanceOf(Error);
    expect(requestJson).not.toHaveBeenCalled();
  });
});

describe('metadata', () => {
  it('encodes the path into the url', async () => {
    await fetchMetadata('/Docs/a b.txt');

    expect(sent().endpoint).toBe('/api/metadata/Docs/a%20b.txt');
  });

  it('refuses an empty path, and a path of only slashes', async () => {
    expect(await rejection(fetchMetadata(''))).toBeInstanceOf(Error);
    expect(await rejection(fetchMetadata('///'))).toBeInstanceOf(Error);
    expect(requestJson).not.toHaveBeenCalled();
  });
});

describe('urls built for the browser to fetch directly', () => {
  it('puts the path in a query parameter, encoded by URLSearchParams', () => {
    expect(getRawFileUrl('Docs/a b#1.txt')).toBe(
      'https://files.example.com/api/raw?path=Docs%2Fa+b%231.txt'
    );
  });

  it('refuses to build a raw url with no path', () => {
    expect(() => getRawFileUrl('')).toThrow();
  });

  it('builds a preview url the same way', () => {
    expect(getPreviewUrl('Media/a.jpg')).toContain('path=Media%2Fa.jpg');
  });

  /** A preview of nothing is not an error the caller should have to catch. */
  it('answers null for a preview with no path rather than throwing', () => {
    expect(getPreviewUrl('')).toBeNull();
  });
});

describe('archives', () => {
  it('streams an extraction, since it reports progress', async () => {
    await extractZip('/Docs/backup.zip');

    expect(sent(requestStream)).toMatchObject({
      endpoint: '/api/files/zip/extract',
      method: 'POST',
      body: { path: 'Docs/backup.zip' },
    });
  });

  it('says where to extract only when asked to use the current folder', async () => {
    await extractZip('Docs/a.zip');
    expect(sent(requestStream).body.destination).toBeUndefined();

    requestStream.mockClear();
    await extractZip('Docs/a.zip', { destination: 'current' });
    expect(sent(requestStream).body.destination).toBe('current');
  });

  /** An absent password and an empty one are different to an extractor. */
  it('sends a password only when there is one, empty string included', async () => {
    await extractZip('Docs/a.zip');
    expect('password' in sent(requestStream).body).toBe(false);

    requestStream.mockClear();
    await extractZip('Docs/a.zip', { password: '' });
    expect(sent(requestStream).body.password).toBe('');
  });

  it('refuses an empty archive path', async () => {
    expect(await rejection(extractZip(''))).toBeInstanceOf(Error);
    expect(requestStream).not.toHaveBeenCalled();
  });

  it('streams a compression with its items and destination', async () => {
    await compressToZip(['Docs/a.txt', 'Docs/b.txt'], '/Docs/', '  archive  ');

    expect(sent(requestStream)).toMatchObject({
      endpoint: '/api/files/zip/compress',
      body: { items: ['Docs/a.txt', 'Docs/b.txt'], destination: 'Docs', name: 'archive' },
    });
  });

  it('sends an empty list rather than undefined when given nothing', async () => {
    await compressToZip(null, 'Docs');

    expect(sent(requestStream).body.items).toEqual([]);
  });

  it('omits an empty name so the server picks one', async () => {
    await compressToZip(['a'], 'Docs', '   ');

    expect('name' in sent(requestStream).body).toBe(false);
  });
});

describe('searching', () => {
  it('sends the term, the folder and the limit', async () => {
    await search('/Docs/', '  pangolin  ', 50);

    expect(sent().endpoint).toBe('/api/search?path=Docs&q=pangolin&limit=50');
  });

  it('omits what was not given rather than sending it empty', async () => {
    await search('', 'pangolin');

    expect(sent().endpoint).toBe('/api/search?q=pangolin');
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['not a number', 'lots'],
  ])('ignores a limit that is %s', async (_label, limit) => {
    await search('', 'x', limit);

    expect(sent().endpoint).not.toContain('limit');
  });

  /**
   * A deep search runs for seconds and nobody reads the answer to a query they
   * have moved on from, so the signal has to reach the request.
   */
  it('passes the abort signal through', async () => {
    const controller = new AbortController();

    await search('', 'x', 10, { signal: controller.signal });

    expect(sent().options.signal).toBe(controller.signal);
  });
});

describe('browsing', () => {
  it('asks for a folder by its normalised path', async () => {
    await browse('/Docs/2026/');

    expect(requestJson).toHaveBeenCalled();
    expect(sent().endpoint).toContain('Docs/2026');
  });
});
