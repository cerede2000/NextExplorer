const {
  ref,
  obj,
  arrayOf,
  str,
  num,
  int,
  bool,
  dateTime,
  nullable,
  json,
  stream,
  errors,
  pathParam,
  query,
  body,
  op,
} = require('../build');

/** The trash, the versions of files, and favourites: what is kept for later. */

const TRASH = 'Trash';
const VERSIONS = 'Versions';

const itemId = pathParam('id', 'The trashed item.');
const versionId = pathParam('id', 'The version.');
const shares = bool('Bring back the shares that ended with the deletion.');

const outcome = (fields) =>
  obj({ items: arrayOf(obj(fields, ['status'], { additionalProperties: true })) }, ['items']);

const restored = outcome({
  id: str(),
  entry: str(),
  status: str(null, { examples: ['restored', 'missing', 'conflict', 'failed'] }),
  name: str(),
  restoredName: str('The name it came back under, when the old one was taken.'),
  renamed: bool(),
  path: str('The folder it came back into.'),
  reason: nullable(str()),
});

const restoreStream = {
  description: 'Progress as the copy goes, then what came back where. One JSON object per line.',
  content: {
    'application/x-ndjson': {
      schema: obj({ type: str(null, { enum: ['start', 'progress', 'done', 'error'] }) }, ['type'], {
        additionalProperties: true,
        description: 'One line; the stream is a sequence of these.',
      }),
    },
  },
};

const pathOfFile = str('The file whose versions these are.');
const listedVersions = obj(
  {
    enabled: bool(),
    file: obj({
      name: str(),
      path: str(),
      size: num(),
      modifiedAt: dateTime(),
      author: nullable(obj({ id: nullable(str()), label: str() })),
      source: nullable(str()),
    }),
    versions: arrayOf(ref('Version')),
    totalBytes: num(),
    rights: obj({ see: bool(), download: bool(), restore: bool(), remove: bool() }),
  },
  ['enabled', 'versions']
);

const zoneRef = obj({ id: str(), kind: str(), name: str() });
const keptFile = obj(
  {
    id: str(),
    name: str(),
    relativePath: str(),
    folder: str(),
    path: nullable(str()),
    state: str(),
    versions: int(),
    bytes: num(),
    newest: nullable(dateTime()),
    zone: zoneRef,
  },
  ['id', 'name']
);

module.exports = {
  '/api/trash': {
    get: op({
      id: 'listTrash',
      summary: 'What this account deleted, and can still bring back',
      tag: TRASH,
      access: 'account',
      responses: {
        200: json(
          obj({ enabled: bool(), retentionDays: int(), items: arrayOf(ref('TrashItem')) }, [
            'enabled',
            'items',
          ])
        ),
        ...errors(401),
      },
    }),
  },
  '/api/trash/restore': {
    post: op({
      id: 'restoreFromTrash',
      summary: 'Put deleted items back where they were',
      description: 'Under `name (1)` when the name has been taken since.',
      tag: TRASH,
      access: 'account',
      body: body(obj({ ids: arrayOf(str()), shares }, ['ids'])),
      responses: { 200: json(restored), ...errors(400, 401, 403) },
    }),
  },
  '/api/trash/restore-to': {
    post: op({
      id: 'restoreFromTrashTo',
      summary: 'Bring deleted items back somewhere else',
      tag: TRASH,
      access: 'account',
      body: body(obj({ ids: arrayOf(str()), destination: str(), shares }, ['ids', 'destination'])),
      responses: { 200: restoreStream, ...errors(400, 401, 403, 404) },
    }),
  },
  '/api/trash/items/{id}/entries': {
    get: op({
      id: 'listTrashedFolder',
      summary: 'What a deleted folder held',
      tag: TRASH,
      access: 'account',
      params: [itemId, query('path', 'A folder inside it; its top when absent.')],
      responses: {
        200: json(
          obj(
            {
              item: ref('TrashItem'),
              path: str(),
              entries: arrayOf(
                obj(
                  {
                    name: str(),
                    kind: str(),
                    size: nullable(num()),
                    modifiedAt: dateTime(),
                    shareCount: int(),
                  },
                  ['name', 'kind']
                )
              ),
            },
            ['item', 'entries']
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/trash/items/{id}/text': {
    get: op({
      id: 'readTrashedText',
      summary: 'The text of a deleted file, or of a file inside a deleted folder',
      tag: TRASH,
      access: 'account',
      params: [itemId, query('path', 'Inside a deleted folder.')],
      responses: {
        200: json(
          obj({ name: str(), size: num(), modifiedAt: dateTime(), content: str() }, ['content'])
        ),
        ...errors(401, 403, 404, 413, 415),
      },
    }),
  },
  '/api/trash/items/{id}/restore': {
    post: op({
      id: 'restoreFromTrashedFolder',
      summary: 'Bring back part of a deleted folder',
      tag: TRASH,
      access: 'account',
      params: [itemId],
      body: body(obj({ paths: arrayOf(str('Inside the folder.')), shares }, ['paths'])),
      responses: { 200: json(restored), ...errors(400, 401, 403, 404) },
    }),
  },
  '/api/trash/items/{id}/restore-to': {
    post: op({
      id: 'restoreFromTrashedFolderTo',
      summary: 'Bring back part of a deleted folder, somewhere else',
      tag: TRASH,
      access: 'account',
      params: [itemId],
      body: body(
        obj({ paths: arrayOf(str()), destination: str(), shares }, ['paths', 'destination'])
      ),
      responses: { 200: restoreStream, ...errors(400, 401, 403, 404) },
    }),
  },
  '/api/trash/delete': {
    post: op({
      id: 'purgeFromTrash',
      summary: 'Remove items from the trash for good',
      tag: TRASH,
      access: 'account',
      body: body(
        obj(
          {
            ids: arrayOf(str()),
            forgetUnavailable: bool('Also forget items whose storage is not there any more.'),
          },
          ['ids']
        )
      ),
      responses: {
        200: json(outcome({ id: str(), status: str(), name: str(), reason: nullable(str()) })),
        ...errors(400, 401, 403),
      },
    }),
  },
  '/api/trash/empty': {
    post: op({
      id: 'emptyTrash',
      summary: 'Empty this account’s trash',
      tag: TRASH,
      access: 'account',
      responses: {
        200: json(obj({ purged: int(), unavailable: int(), failed: int() }, ['purged'])),
        ...errors(401),
      },
    }),
  },
  '/api/trash/zones': {
    get: op({
      id: 'listTrashZones',
      summary: 'Every place the trash keeps things, and what it holds',
      tag: TRASH,
      access: 'admin',
      responses: {
        200: json(obj({ zones: arrayOf(ref('TrashZone')) }, ['zones'])),
        ...errors(401, 403),
      },
    }),
  },
  '/api/trash/verify': {
    post: op({
      id: 'verifyTrash',
      summary: 'Check that what the trash records matches what is on disk',
      tag: TRASH,
      access: 'admin',
      responses: {
        200: json(
          obj(
            { zones: arrayOf(obj({ zoneId: str() }, ['zoneId'], { additionalProperties: true })) },
            ['zones']
          )
        ),
        ...errors(401, 403),
      },
    }),
  },
  '/api/trash/maintenance': {
    post: op({
      id: 'runTrashMaintenance',
      summary: 'Run the trash’s upkeep now',
      description:
        'What the daily pass does: expire, keep within budget, finish or undo what a crash interrupted.',
      tag: TRASH,
      access: 'admin',
      responses: {
        200: json(
          obj(
            { zones: arrayOf(obj({ zoneId: str() }, ['zoneId'], { additionalProperties: true })) },
            ['zones']
          )
        ),
        ...errors(401, 403),
      },
    }),
  },
  '/api/versions': {
    get: op({
      id: 'listVersions',
      summary: 'The earlier versions of a file',
      tag: VERSIONS,
      access: 'account',
      params: [query('path', 'The file.', { type: 'string' }, true)],
      responses: { 200: json(listedVersions), ...errors(400, 401, 403, 404) },
    }),
  },
  '/api/versions/{id}/content': {
    get: op({
      id: 'downloadVersion',
      summary: 'An earlier version’s content',
      tag: VERSIONS,
      access: 'account',
      params: [versionId, query('path', 'The file.', { type: 'string' }, true)],
      responses: {
        200: stream('application/octet-stream', 'The content.'),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/versions/{id}/text': {
    get: op({
      id: 'readVersionText',
      summary: 'An earlier version’s text',
      tag: VERSIONS,
      access: 'account',
      params: [versionId, query('path', 'The file.', { type: 'string' }, true)],
      responses: {
        200: json(
          obj({ name: str(), size: num(), modifiedAt: dateTime(), content: str() }, ['content'])
        ),
        ...errors(400, 401, 403, 404, 413, 415),
      },
    }),
  },
  '/api/versions/{id}/restore': {
    post: op({
      id: 'restoreVersion',
      summary: 'Make an earlier version the current one',
      description: 'What it replaces is kept as a version in its turn.',
      tag: VERSIONS,
      access: 'account',
      params: [versionId],
      body: body(obj({ path: pathOfFile }, ['path'])),
      responses: {
        200: json(obj({ status: str(), path: str() }, ['status', 'path'])),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
  },
  '/api/versions/{id}/copy': {
    post: op({
      id: 'copyVersion',
      summary: 'Save an earlier version as a new file',
      tag: VERSIONS,
      access: 'account',
      params: [versionId],
      body: body(
        obj({ path: pathOfFile, destination: str('The folder.'), name: str() }, [
          'path',
          'destination',
        ])
      ),
      responses: {
        200: json(obj({ path: str(), name: str() }, ['path', 'name'])),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/versions/{id}/replace': {
    post: op({
      id: 'replaceWithVersion',
      summary: 'Write an earlier version over another file',
      description: 'What is replaced is kept as a version of that file.',
      tag: VERSIONS,
      access: 'account',
      params: [versionId],
      body: body(
        obj({ path: pathOfFile, target: str('The file to replace.') }, ['path', 'target'])
      ),
      responses: {
        200: json(obj({ status: str(), path: str() }, ['status', 'path'])),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/versions/{id}': {
    patch: op({
      id: 'updateVersion',
      summary: 'Name or pin a version',
      tag: VERSIONS,
      access: 'account',
      params: [versionId],
      body: body(obj({ path: pathOfFile, label: nullable(str()), pinned: bool() }, ['path'])),
      responses: { 200: json(ref('Version')), ...errors(400, 401, 403, 404) },
    }),
  },
  '/api/versions/delete': {
    post: op({
      id: 'deleteVersions',
      summary: 'Remove versions of a file',
      tag: VERSIONS,
      access: 'account',
      body: body(obj({ path: pathOfFile, ids: arrayOf(str()), all: bool() }, ['path'])),
      responses: {
        200: json(
          obj({ items: arrayOf(obj({ id: str(), status: str() })), deleted: int() }, [
            'items',
            'deleted',
          ])
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/versions/admin/files': {
    get: op({
      id: 'listVersionedFiles',
      summary: 'Every file with versions kept, across the instance',
      tag: VERSIONS,
      access: 'admin',
      params: [
        query('zone', 'One zone.'),
        query('state', 'Whether the file is still there.'),
        query('q', 'Part of a name or path.'),
        query('sort', 'Default `bytes`.'),
        query('limit', 'How many.', { type: 'integer' }),
        query('offset', 'From where.', { type: 'integer' }),
      ],
      responses: {
        200: json(
          obj(
            {
              files: arrayOf(keptFile),
              total: int(),
              totalBytes: num(),
              totalVersions: int(),
              limit: int(),
              offset: int(),
              zones: arrayOf(zoneRef),
              states: arrayOf(str()),
              sorts: arrayOf(str()),
            },
            ['files', 'total']
          )
        ),
        ...errors(401, 403),
      },
    }),
  },
  '/api/versions/admin/files/{id}': {
    get: op({
      id: 'getVersionedFile',
      summary: 'One file’s kept versions, for an administrator',
      tag: VERSIONS,
      access: 'admin',
      params: [pathParam('id', 'The file’s record.')],
      responses: {
        200: json(
          obj(
            {
              file: obj({
                id: str(),
                name: str(),
                relativePath: str(),
                path: nullable(str()),
                state: str(),
                zone: zoneRef,
              }),
              versions: arrayOf(ref('Version')),
              totalBytes: num(),
            },
            ['file', 'versions']
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/versions/admin/files/{id}/delete': {
    post: op({
      id: 'deleteVersionsOfFile',
      summary: 'Remove kept versions of a file, for an administrator',
      tag: VERSIONS,
      access: 'admin',
      params: [pathParam('id', 'The file’s record.')],
      body: body(obj({ ids: arrayOf(str()), all: bool() })),
      responses: {
        200: json(
          obj(
            { items: arrayOf(obj({ id: str(), status: str() })), deleted: int(), remaining: int() },
            ['items', 'deleted']
          )
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/favorites': {
    get: op({
      id: 'listFavorites',
      summary: 'This account’s favourites, in order',
      tag: 'Favourites',
      access: 'account',
      responses: { 200: json(arrayOf(ref('Favorite'))), ...errors(401) },
    }),
    post: op({
      id: 'addFavorite',
      summary: 'Add a favourite',
      description: 'Adding a path already there updates it.',
      tag: 'Favourites',
      access: 'account',
      body: body(obj({ path: str(), label: str(), icon: str(), color: nullable(str()) }, ['path'])),
      responses: { 200: json(ref('Favorite')), ...errors(400, 401, 403, 404) },
    }),
    delete: op({
      id: 'removeFavorite',
      summary: 'Remove a favourite',
      description: 'Answers what is left.',
      tag: 'Favourites',
      access: 'account',
      body: body(obj({ path: str() }, ['path'])),
      responses: { 200: json(arrayOf(ref('Favorite'))), ...errors(400, 401) },
    }),
  },
  '/api/favorites/reorder': {
    patch: op({
      id: 'reorderFavorites',
      summary: 'Put the favourites in a new order',
      tag: 'Favourites',
      access: 'account',
      body: body(obj({ order: arrayOf(str('A favourite’s id.')) }, ['order'])),
      responses: { 200: json(arrayOf(ref('Favorite'))), ...errors(400, 401) },
    }),
  },
  '/api/favorites/{id}': {
    patch: op({
      id: 'updateFavorite',
      summary: 'Change a favourite',
      tag: 'Favourites',
      access: 'account',
      params: [pathParam('id', 'The favourite.')],
      body: body(obj({ label: str(), icon: str(), color: nullable(str()), position: int() })),
      responses: { 200: json(ref('Favorite')), ...errors(400, 401, 404) },
    }),
  },
};
