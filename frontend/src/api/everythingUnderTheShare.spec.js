import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Everything a share's visitor asks for, asked under the share's prefix.
 *
 * A visitor behind an authentication proxy reaches `/share/`, `/api/share/` and
 * `/assets/` and nothing else, because that is the hole somebody cut for a public
 * link. One call left outside is one thing that does not work, and it is never the
 * same one twice: a thumbnail, a download, a long poll waiting for an office
 * document to change. So this is a list rather than a case — every function that
 * takes a path, called with a path inside a share, and the address it produces.
 *
 * Add a function that takes a path, and add it here.
 */

const sent = [];
const record = (endpoint) => {
  sent.push(endpoint);
  return Promise.resolve({});
};

vi.mock('./http', () => ({
  requestJson: (endpoint) => record(endpoint),
  requestRaw: (endpoint) => record(endpoint),
  requestStream: (endpoint) => record(endpoint),
  buildUrl: (endpoint) => {
    sent.push(endpoint);
    return `http://test${endpoint}`;
  },
  apiBase: '',
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
  encodePath: (value) =>
    String(value || '')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/'),
}));

import * as files from './files.api';
import * as archive from './archive.api';
import * as versions from './versions.api';
import * as onlyoffice from './onlyoffice.api';
import { fetchCollaboraConfig } from './collabora.api';
import { directUploadEndpoint } from '@/composables/uploadTarget';
import { fetchFeatures } from './features.api';
import { getBranding } from './settings.api';

const INSIDE = 'share/TOKEN/Papers/report.docx';
const FOLDER = 'share/TOKEN/Papers';
const ITEM = { path: 'share/TOKEN/Papers', name: 'report.docx' };

/** Everything that takes a path, and how to call it with one. */
const CALLS = [
  ['a thumbnail', () => files.fetchThumbnail(INSIDE)],
  ['what is known about a file', () => files.fetchMetadata(INSIDE)],
  ['a file to look at', () => files.getPreviewUrl(INSIDE)],
  // Both reach the share's own editor endpoint rather than `/api/editor` under
  // the prefix, which is that endpoint's own address and means the share's root.
  ['a file to read as text', () => files.fetchFileContent(INSIDE)],
  ['a file saved from the editor', () => files.saveFileContent(INSIDE, 'x')],
  ['a file to take away', () => files.downloadItems([INSIDE], FOLDER)],
  ['a selection described before it is taken', () => files.createDownloadPlan([INSIDE], FOLDER)],
  ['one part of that selection', () => files.downloadPartUrl('PLAN', '0', FOLDER)],
  ['the tracks inside a film', () => files.fetchMediaTracks(INSIDE)],
  ['a subtitle track', () => files.getSubtitleUrl(INSIDE, { stream: 0 })],
  ['how big a folder is', () => files.getFolderSizesBatch([FOLDER])],
  ['that size measured again', () => files.refreshFolderSize(FOLDER)],
  ['a folder made', () => files.createFolder(FOLDER, 'New')],
  ['a file made', () => files.createFile(FOLDER, 'new.txt')],
  ['a document made', () => files.createOfficeDocument(FOLDER, { format: 'docx' })],
  ['something renamed', () => files.renameItem(INSIDE, 'report.docx', 'later.docx')],
  ['something copied', () => files.copyItems([ITEM], FOLDER)],
  ['something moved', () => files.moveItems([ITEM], FOLDER)],
  ['something deleted', () => files.deleteItems([ITEM])],
  ['what deleting it would mean', () => files.getDeleteImpact([ITEM])],
  ['a search', () => files.search(FOLDER, 'report')],
  ['an archive unpacked', () => files.extractZip(INSIDE)],
  ['a selection packed', () => files.compressToZip([ITEM], FOLDER, 'papers.zip')],
  ['a folder reserved for an upload', () => files.reserveFolderUploadTarget(FOLDER, 'Papers')],
  ['a file sent', () => directUploadEndpoint({ meta: { uploadTo: FOLDER } })],
  ['what is inside an archive', () => archive.browseArchive(INSIDE)],
  ['one entry of it', () => archive.archiveEntryUrl(INSIDE, 'inside.txt')],
  ['that entry read', () => archive.readArchiveEntry(INSIDE, 'inside.txt')],
  ['entries taken out of it', () => archive.extractFromArchive(INSIDE, ['inside.txt'])],
  ["a file's earlier versions", () => versions.getVersions(INSIDE)],
  ['one of them downloaded', () => versions.getVersionDownloadUrl(INSIDE, 'v1')],
  ['one of them read', () => versions.getVersionText(INSIDE, 'v1')],
  ['one of them put back', () => versions.restoreVersion(INSIDE, 'v1')],
  ['versions deleted', () => versions.deleteVersions(INSIDE, { all: true })],
  ['an office document opened', () => onlyoffice.fetchOnlyOfficeConfig(INSIDE)],
  ['its history', () => onlyoffice.fetchOnlyOfficeHistory(INSIDE)],
  [
    'it saved now rather than later',
    () => onlyoffice.requestOnlyOfficeForceSave(INSIDE, { sessionId: 's' }),
  ],
  [
    'its editing session still alive',
    () => onlyoffice.heartbeatOnlyOfficeSession(INSIDE, { sessionId: 's' }),
  ],
  ['its editing session ended', () => onlyoffice.endOnlyOfficeSession(INSIDE, { sessionId: 's' })],
  [
    'it renamed from the editor',
    () => onlyoffice.renameOnlyOfficeDocument(INSIDE, { sessionId: 's', newName: 'later.docx' }),
  ],
  [
    'a copy saved from the editor',
    () => onlyoffice.saveOnlyOfficeDocumentAs(INSIDE, { url: 'http://x', title: 'copy.docx' }),
  ],
  ['its history read', () => onlyoffice.fetchOnlyOfficeHistoryData(INSIDE, { version: 1 })],
  ['a version of it fetched for the editor', () => onlyoffice.fetchOnlyOfficeStorageFile(INSIDE)],
  [
    'somebody mentioned in it',
    () =>
      onlyoffice.notifyOnlyOfficeMention(INSIDE, {
        emails: ['a@b.c'],
        actionLink: {},
        comment: '',
      }),
  ],
  ['the same document in Collabora', () => fetchCollaboraConfig(INSIDE)],
];

beforeEach(() => {
  sent.length = 0;
});

describe('a request about something inside a share', () => {
  it.each(CALLS)('goes under the share: %s', async (_what, call) => {
    const returned = await call();
    const addresses = sent.length ? sent : [String(returned || '')];

    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      expect(address, `${_what}: ${address}`).toMatch(/^(http:\/\/test)?\/api\/share\/TOKEN\//);
    }
  });
});

describe('a request about something that is not in a share', () => {
  it('is addressed where it always was', async () => {
    await files.fetchThumbnail('Projects/report.docx');
    await files.downloadItems(['Projects/report.docx'], 'Projects');
    await onlyoffice.fetchOnlyOfficeConfig('Projects/report.docx');

    for (const address of sent) {
      expect(address.startsWith('/api/share/')).toBe(false);
    }
  });
});

/**
 * And the ones that are about the page rather than a path.
 *
 * A long poll waiting to be told an office document changed names no file, and
 * neither does what this installation offers. Refused, the first of those asks
 * again at once — the reader's console filled with a refusal a second — and the
 * second decides whether there is an office editor at all.
 */
describe('a request about the page a share is on', () => {
  const PAGE_CALLS = [
    ['what this installation offers', () => fetchFeatures()],
    ['what it is called', () => getBranding()],
    ['who can be mentioned in a document', () => onlyoffice.fetchOnlyOfficeMentionUsers()],
    ['word that a document changed', () => onlyoffice.waitForOnlyOfficeActivityVersion(1)],
    ['where things were last moved to', () => files.fetchRecentDestinations()],
  ];

  it.each(PAGE_CALLS)('goes under the share: %s', async (_what, call) => {
    window.history.replaceState({}, '', '/share/TOKEN/browse/Papers');
    try {
      await call();
      expect(sent.length).toBeGreaterThan(0);
      for (const address of sent) {
        expect(address, `${_what}: ${address}`).toMatch(/^\/api\/share\/TOKEN\//);
      }
    } finally {
      window.history.replaceState({}, '', '/browse/Projects');
    }
  });

  it('is addressed where it always was on any other page', async () => {
    window.history.replaceState({}, '', '/browse/Projects');

    await fetchFeatures();
    await onlyoffice.waitForOnlyOfficeActivityVersion(1);

    for (const address of sent) {
      expect(address.startsWith('/api/share/')).toBe(false);
    }
  });
});
