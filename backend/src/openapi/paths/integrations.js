const {
  obj,
  arrayOf,
  str,
  int,
  num,
  bool,
  nullable,
  json,
  noContent,
  stream,
  errors,
  pathParam,
  query,
  header,
  body,
  op,
} = require('../build');

/**
 * The two editor integrations. Mounted only where configured — `404`
 * otherwise — and closed to API tokens: these are the editor pages’ own calls,
 * and the editor servers’ calls back, not an API for scripts.
 */

const OO = 'ONLYOFFICE';
const CO = 'Collabora';

const path = str('The document.');
const session = str('The editing session, from the configuration.');
const loose = (description) =>
  obj({}, [], { additionalProperties: true, ...(description ? { description } : {}) });

module.exports = {
  '/api/onlyoffice/config': {
    post: op({
      id: 'configureOnlyofficeEditor',
      summary: 'What the ONLYOFFICE editor is opened with',
      description:
        'The editor configuration, signed with `ONLYOFFICE_SECRET`, and the session the page reports on. With `versionId`, an earlier version opened to read.',
      tag: OO,
      access: 'session',
      body: body(
        obj(
          {
            path,
            mode: str(null, { enum: ['edit', 'view'], default: 'edit' }),
            theme: str('The page’s theme, passed on to the editor.'),
            versionId: str(),
          },
          ['path']
        )
      ),
      responses: {
        200: json(
          obj(
            {
              documentServerUrl: str(),
              config: loose('What `DocsAPI.DocEditor` takes, `token` included.'),
              forceSaveSessionId: str(),
              // The editing session this open belongs to, which every later
              // call about the document carries back.
              editorSessionId: str(),
              autoSaveIntervalMs: num(),
            },
            ['documentServerUrl', 'config']
          )
        ),
        ...errors(400, 401, 403, 404, 415),
      },
    }),
  },
  '/api/onlyoffice/session-heartbeat': {
    post: op({
      id: 'keepOnlyofficeSession',
      summary: 'Say the editor page is still open',
      tag: OO,
      access: 'session',
      body: body(obj({ path, sessionId: session }, ['path', 'sessionId'])),
      responses: { 200: json(obj({ active: bool() }, ['active'])), ...errors(400, 401, 403) },
    }),
  },
  '/api/onlyoffice/session-end': {
    post: op({
      id: 'endOnlyofficeSession',
      summary: 'Say the editor page closed',
      description: 'Asks the document server to save what is pending.',
      tag: OO,
      access: 'session',
      body: body(obj({ path, sessionId: session }, ['path', 'sessionId'])),
      responses: {
        200: json(obj({ ended: bool(), flushed: bool(), requestId: nullable(str()) }, ['ended'])),
        ...errors(400, 401, 403),
      },
    }),
  },
  '/api/onlyoffice/force-save': {
    post: op({
      id: 'forceSaveOnlyoffice',
      summary: 'Ask the document server to save now',
      tag: OO,
      access: 'session',
      body: body(
        obj(
          {
            path,
            sessionId: session,
            reason: str(null, { enum: ['close', 'auto'], default: 'close' }),
          },
          ['path', 'sessionId']
        )
      ),
      responses: {
        202: json(
          obj({ queued: bool(), requestId: str() }, [], { additionalProperties: true }),
          'Asked.'
        ),
        ...errors(400, 401, 403),
      },
    }),
  },
  '/api/onlyoffice/history': {
    post: op({
      id: 'getOnlyofficeHistory',
      summary: 'The versions of a document, as the editor lists them',
      tag: OO,
      access: 'session',
      body: body(obj({ path }, ['path'])),
      responses: {
        200: json(
          obj({ currentVersion: int(), history: arrayOf(loose()), canRestore: bool() }, [
            'currentVersion',
            'history',
          ])
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/onlyoffice/history-data': {
    post: op({
      id: 'getOnlyofficeHistoryData',
      summary: 'Where the editor reads one earlier version from',
      tag: OO,
      access: 'session',
      body: body(obj({ path, version: int(), versionId: str() }, ['path', 'version'])),
      responses: {
        200: json(loose('What `setHistoryData` takes, signed.')),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/onlyoffice/rename': {
    post: op({
      id: 'renameFromOnlyoffice',
      summary: 'Rename the document from inside the editor',
      tag: OO,
      access: 'session',
      body: body(
        obj({ path, sessionId: session, newName: str() }, ['path', 'sessionId', 'newName'])
      ),
      responses: {
        200: json(obj({ path: str(), name: str() }, ['path', 'name'])),
        ...errors(400, 401, 403, 409),
      },
    }),
  },
  '/api/onlyoffice/save-as': {
    post: op({
      id: 'saveAsFromOnlyoffice',
      summary: 'Save a copy the editor made, beside the document',
      description: 'The copy is fetched from the document server, and only from there.',
      tag: OO,
      access: 'session',
      body: body(obj({ path, url: str('On the document server.'), title: str() }, ['path', 'url'])),
      responses: {
        200: json(obj({ path: str(), name: str(), size: num() }, ['path', 'name'])),
        ...errors(400, 401, 403),
      },
    }),
  },
  '/api/onlyoffice/users': {
    get: op({
      id: 'listOnlyofficeUsers',
      summary: 'The accounts the editor may mention',
      tag: OO,
      access: 'session',
      responses: {
        200: json(
          obj({ users: arrayOf(obj({ id: str(), name: str(), email: nullable(str()) }, ['id'])) }, [
            'users',
          ])
        ),
        ...errors(401, 403),
      },
    }),
  },
  '/api/onlyoffice/notify': {
    post: op({
      id: 'notifyFromOnlyoffice',
      summary: 'Somebody was mentioned in a comment',
      description: 'Nothing is sent by mail; the answer says so.',
      tag: OO,
      access: 'session',
      body: body(obj({ path, emails: arrayOf(str()) }, ['path']), {
        description: 'At most fifty addresses.',
      }),
      responses: { 200: json(obj({ delivered: bool() }, ['delivered'])), ...errors(400, 401, 403) },
    }),
  },
  '/api/onlyoffice/activity-version': {
    get: op({
      id: 'waitForOnlyofficeActivity',
      summary: 'Wait for a change in the documents being edited',
      description:
        'A long poll: answered when something changed after `since`, or when it has waited long enough.',
      tag: OO,
      access: 'session',
      params: [query('since', 'The version already seen.', { type: 'integer' })],
      responses: {
        200: json(obj({ version: int(), changed: bool() }, ['version', 'changed'])),
        ...errors(401, 403),
      },
    }),
  },
  '/api/onlyoffice/file': {
    get: op({
      id: 'serveFileToOnlyoffice',
      summary: 'The document, fetched by the document server',
      description: 'Checked against the signed token the document server sends.',
      tag: OO,
      access: 'integration',
      params: [
        query('path', 'The document.', { type: 'string' }, true),
        header('Authorization', 'The document server’s signed token.'),
      ],
      responses: {
        200: stream('application/octet-stream', 'The document.'),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/onlyoffice/callback': {
    post: op({
      id: 'receiveOnlyofficeCallback',
      summary: 'The document server reporting a save',
      description:
        'Its callback protocol: `{ "error": 0 }` when handled, `{ "error": 1 }` otherwise, always with a `200`.',
      tag: OO,
      access: 'integration',
      params: [query('path', 'The document.', { type: 'string' }, true)],
      body: body(loose('As the document server sends it: `status`, `url`, `key`, `token`…')),
      responses: { 200: json(obj({ error: int(null, { enum: [0, 1] }) }, ['error'])) },
    }),
  },
  '/api/collabora/config': {
    post: op({
      id: 'configureCollaboraEditor',
      summary: 'Where the Collabora editor is opened, and its access token',
      description: 'Reads Collabora’s discovery to find the editor for this kind of file.',
      tag: CO,
      access: 'session',
      body: body(
        obj({ path, mode: str(null, { enum: ['edit', 'view'], default: 'edit' }) }, ['path'])
      ),
      responses: {
        200: json(
          obj(
            {
              urlSrc: str(),
              fileId: str(),
              accessToken: str(),
              accessTokenTtl: int('Milliseconds since the epoch.'),
            },
            ['urlSrc', 'fileId', 'accessToken']
          )
        ),
        ...errors(400, 401, 403, 404, 415, 500),
      },
    }),
  },
  '/api/collabora/wopi/files/{fileId}': {
    get: op({
      id: 'wopiCheckFileInfo',
      summary: 'WOPI CheckFileInfo',
      tag: CO,
      access: 'integration',
      params: [
        pathParam('fileId', 'From the configuration.'),
        query('access_token', 'From the configuration.', { type: 'string' }, true),
      ],
      responses: {
        200: json(
          obj({ BaseFileName: str(), Size: num(), UserCanWrite: bool() }, ['BaseFileName'], {
            additionalProperties: true,
          })
        ),
        ...errors(401, 404),
      },
    }),
    post: op({
      id: 'wopiLock',
      summary: 'WOPI Lock, Unlock, RefreshLock, UnlockAndRelock and GetLock',
      description: 'Chosen by `X-WOPI-Override`.',
      tag: CO,
      access: 'integration',
      params: [
        pathParam('fileId', 'From the configuration.'),
        query('access_token', 'From the configuration.', { type: 'string' }, true),
        header(
          'X-WOPI-Override',
          'The operation.',
          {
            type: 'string',
            enum: ['LOCK', 'UNLOCK', 'REFRESH_LOCK', 'UNLOCK_AND_RELOCK', 'GET_LOCK'],
          },
          true
        ),
        header('X-WOPI-Lock', 'The lock.'),
      ],
      responses: {
        200: noContent('Done; `X-WOPI-Lock` where the protocol says.'),
        409: noContent('Held under another lock.'),
        ...errors(400, 401, 404),
      },
    }),
  },
  '/api/collabora/wopi/files/{fileId}/contents': {
    get: op({
      id: 'wopiGetFile',
      summary: 'WOPI GetFile',
      tag: CO,
      access: 'integration',
      params: [
        pathParam('fileId', 'From the configuration.'),
        query('access_token', 'From the configuration.', { type: 'string' }, true),
      ],
      responses: { 200: stream('application/octet-stream', 'The document.'), ...errors(401, 404) },
    }),
    post: op({
      id: 'wopiPutFile',
      summary: 'WOPI PutFile',
      tag: CO,
      access: 'integration',
      params: [
        pathParam('fileId', 'From the configuration.'),
        query('access_token', 'From the configuration.', { type: 'string' }, true),
        header('X-WOPI-Lock', 'The lock held.'),
      ],
      body: {
        required: true,
        content: { 'application/octet-stream': { schema: str(null, { format: 'binary' }) } },
      },
      responses: {
        200: json(loose()),
        409: noContent('Held under another lock.'),
        ...errors(401, 403, 404, 413),
      },
    }),
  },
};
