import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ONLYOFFICE endpoints, as the editor calls them. The Document Server reads
 * its settings from what the backend signs, so a field left out of a request
 * cannot be added afterwards: a theme or a version id that does not travel is
 * simply lost. The close and heartbeat calls run while the editor is being torn
 * down, so they must stay quiet and survive the page going away.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal()),
  requestJson,
}));

const api = await import('./onlyoffice.api');

const call = () => {
  const [endpoint, options] = requestJson.mock.calls.at(-1);
  return {
    endpoint,
    method: options?.method,
    body: options?.body ? JSON.parse(options.body) : null,
  };
};

const options = () => requestJson.mock.calls.at(-1)[1];

beforeEach(() => {
  requestJson.mockClear();
});

describe('the ONLYOFFICE API', () => {
  it('asks for the editor configuration of a file, with the theme in the signed request', async () => {
    await api.fetchOnlyOfficeConfig('/Docs/report & plan.docx/', 'view', { theme: 'dark' });

    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/config',
      method: 'POST',
      body: { path: 'Docs/report & plan.docx', mode: 'view', theme: 'dark' },
    });
  });

  it('opens a file for editing unless told otherwise, and names a version only when one is asked for', async () => {
    await api.fetchOnlyOfficeConfig('Docs/report.docx');
    expect(call().body).toEqual({ path: 'Docs/report.docx', mode: 'edit' });

    await api.fetchOnlyOfficeConfig('Docs/report.docx', 'view', { versionId: 'v1' });
    expect(call().body).toEqual({ path: 'Docs/report.docx', mode: 'view', versionId: 'v1' });
  });

  it('refuses to ask for a configuration, a history or a storage file without a path', async () => {
    await expect(api.fetchOnlyOfficeConfig('/')).rejects.toThrow('Path is required.');
    await expect(api.fetchOnlyOfficeHistory('')).rejects.toThrow('Path is required.');
    await expect(api.fetchOnlyOfficeHistoryData(null, { version: 1 })).rejects.toThrow(
      'Path is required.'
    );
    await expect(api.fetchOnlyOfficeStorageFile(undefined, { c: 'add' })).rejects.toThrow(
      'Path is required.'
    );
    await expect(api.notifyOnlyOfficeMention('', { emails: [] })).rejects.toThrow(
      'Path is required.'
    );

    expect(requestJson).not.toHaveBeenCalled();
  });

  it('reads the history of a document', async () => {
    await api.fetchOnlyOfficeHistory('/Docs/report.docx');

    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/history',
      method: 'POST',
      body: { path: 'Docs/report.docx' },
    });
  });

  it('asks for one entry of the history, an earlier version by its id or the current state without one', async () => {
    await api.fetchOnlyOfficeHistoryData('Docs/report.docx', { version: 2, versionId: 'v 2' });
    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/history-data',
      method: 'POST',
      body: { path: 'Docs/report.docx', version: 2, versionId: 'v 2' },
    });

    await api.fetchOnlyOfficeHistoryData('Docs/report.docx', { version: 3 });
    expect(call().body).toEqual({ path: 'Docs/report.docx', version: 3 });
  });

  it('asks for a save when the editor closes, in a request that outlives the page and raises no alert', async () => {
    await api.requestOnlyOfficeForceSave('/Docs/report.docx', { sessionId: 's1' });

    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/force-save',
      method: 'POST',
      body: { path: 'Docs/report.docx', sessionId: 's1', reason: 'close' },
    });
    expect(options()).toMatchObject({ keepalive: true, suppressErrorHandler: true });
  });

  it('asks for an automatic save as an ordinary request, still without an alert', async () => {
    await api.requestOnlyOfficeForceSave('Docs/report.docx', { sessionId: 's1', reason: 'auto' });

    expect(call().body).toEqual({ path: 'Docs/report.docx', sessionId: 's1', reason: 'auto' });
    expect(options()).toMatchObject({ keepalive: false, suppressErrorHandler: true });
  });

  it('does not ask for a save without a path or an editing session', async () => {
    await expect(api.requestOnlyOfficeForceSave('Docs/report.docx', {})).resolves.toEqual({
      queued: false,
    });
    await expect(api.requestOnlyOfficeForceSave('', { sessionId: 's1' })).resolves.toEqual({
      queued: false,
    });

    expect(requestJson).not.toHaveBeenCalled();
  });

  it('saves the open document under a new name, from the converted file the editor points to', async () => {
    await api.saveOnlyOfficeDocumentAs('/Docs/report.docx', {
      url: 'https://docs.example/cache/report.pdf',
      title: 'report.pdf',
    });

    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/save-as',
      method: 'POST',
      body: {
        path: 'Docs/report.docx',
        url: 'https://docs.example/cache/report.pdf',
        title: 'report.pdf',
      },
    });
  });

  it('refuses to save a copy without the path, the url and the title', async () => {
    await expect(
      api.saveOnlyOfficeDocumentAs('Docs/report.docx', { title: 'report.pdf' })
    ).rejects.toThrow('Path, url and title are required.');
    await expect(
      api.saveOnlyOfficeDocumentAs('Docs/report.docx', { url: 'https://docs.example/x' })
    ).rejects.toThrow('Path, url and title are required.');
    await expect(
      api.saveOnlyOfficeDocumentAs('', { url: 'https://docs.example/x', title: 'x.pdf' })
    ).rejects.toThrow('Path, url and title are required.');

    expect(requestJson).not.toHaveBeenCalled();
  });

  it('renames the open document through its editing session', async () => {
    await api.renameOnlyOfficeDocument('/Docs/report.docx', {
      sessionId: 's1',
      newName: 'final report.docx',
    });

    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/rename',
      method: 'POST',
      body: { path: 'Docs/report.docx', sessionId: 's1', newName: 'final report.docx' },
    });
  });

  it('refuses to rename without the path, the session and the new name', async () => {
    const message = 'Path, session and new name are required.';
    await expect(
      api.renameOnlyOfficeDocument('Docs/report.docx', { newName: 'x.docx' })
    ).rejects.toThrow(message);
    await expect(
      api.renameOnlyOfficeDocument('Docs/report.docx', { sessionId: 's1' })
    ).rejects.toThrow(message);
    await expect(
      api.renameOnlyOfficeDocument('', { sessionId: 's1', newName: 'x.docx' })
    ).rejects.toThrow(message);

    expect(requestJson).not.toHaveBeenCalled();
  });

  it('turns a picked file into one the Document Server can fetch, passing the signed command through', async () => {
    await api.fetchOnlyOfficeStorageFile('/Pictures/logo.png', { c: 'add' });

    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/storage-file',
      method: 'POST',
      body: { path: 'Pictures/logo.png', c: 'add' },
    });
  });

  it('lists the people a comment can mention, without an alert when that fails', async () => {
    await api.fetchOnlyOfficeMentionUsers();

    expect(call()).toEqual({ endpoint: '/api/onlyoffice/users', method: 'GET', body: null });
    expect(options().suppressErrorHandler).toBe(true);
  });

  it('reports a comment that mentions someone, without an alert when that fails', async () => {
    await api.notifyOnlyOfficeMention('/Docs/report.docx', {
      emails: ['ann@example.com'],
      actionLink: { action: { type: 'comment', data: 'c1' } },
      comment: 'Please check',
    });

    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/notify',
      method: 'POST',
      body: {
        path: 'Docs/report.docx',
        emails: ['ann@example.com'],
        actionLink: { action: { type: 'comment', data: 'c1' } },
        comment: 'Please check',
      },
    });
    expect(options().suppressErrorHandler).toBe(true);
  });

  it('keeps an editing session alive quietly, and reports it inactive when there is none', async () => {
    await api.heartbeatOnlyOfficeSession('/Docs/report.docx', { sessionId: 's1' });
    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/session-heartbeat',
      method: 'POST',
      body: { path: 'Docs/report.docx', sessionId: 's1' },
    });
    expect(options().suppressErrorHandler).toBe(true);
    expect(options().keepalive).toBeUndefined();

    requestJson.mockClear();
    await expect(api.heartbeatOnlyOfficeSession('Docs/report.docx', {})).resolves.toEqual({
      active: false,
    });
    await expect(api.heartbeatOnlyOfficeSession('', { sessionId: 's1' })).resolves.toEqual({
      active: false,
    });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('closes an editing session in a request that outlives the page, and not at all without one', async () => {
    await api.closeOnlyOfficeSession('/Docs/report.docx/', { sessionId: 's1' });
    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/session-close',
      method: 'POST',
      body: { path: 'Docs/report.docx', sessionId: 's1' },
    });
    expect(options()).toMatchObject({ keepalive: true, suppressErrorHandler: true });

    requestJson.mockClear();
    await expect(api.closeOnlyOfficeSession('Docs/report.docx')).resolves.toBeUndefined();
    await expect(api.closeOnlyOfficeSession('', { sessionId: 's1' })).resolves.toBeUndefined();
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('waits for a change in who is editing, from the last version it saw, without retrying or alerting', async () => {
    const { signal } = new AbortController();

    await api.waitForOnlyOfficeActivityVersion(7, { signal });

    expect(call()).toEqual({
      endpoint: '/api/onlyoffice/activity-version?since=7',
      method: 'GET',
      body: null,
    });
    expect(options()).toMatchObject({
      signal,
      retryNetworkErrors: false,
      suppressErrorHandler: true,
    });
  });

  it('sends a starting version only when it is a whole number, zero included', async () => {
    await api.waitForOnlyOfficeActivityVersion(0);
    expect(call().endpoint).toBe('/api/onlyoffice/activity-version?since=0');

    for (const since of [undefined, null, '7', 1.5, Number.NaN]) {
      await api.waitForOnlyOfficeActivityVersion(since);
      expect(call().endpoint).toBe('/api/onlyoffice/activity-version');
    }
  });
});
