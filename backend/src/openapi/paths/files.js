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
  noContent,
  stream,
  errors,
  query,
  header,
  body,
  op,
} = require('../build');

const TAG = 'Files';

const itemRef = obj({ path: str('The folder it is in.'), name: str() }, ['path', 'name']);
const created = obj({ success: bool(), item: ref('Item') }, ['success', 'item']);

/**
 * What a long operation writes as it goes: one JSON object per line, ending
 * with `done` or `error`. A refusal found once the answer has begun can only
 * arrive this way, so a `200` is not a success until the last line says so.
 */
const ndjson = (done, description) => ({
  description,
  content: {
    'application/x-ndjson': {
      schema: {
        description: 'One line; the stream is a sequence of these.',
        oneOf: [
          obj({ type: { const: 'start' } }, ['type'], { additionalProperties: true }),
          obj({ type: { const: 'progress' } }, ['type'], { additionalProperties: true }),
          { allOf: [obj({ type: { const: 'done' } }, ['type']), done] },
          obj({ type: { const: 'error' }, message: str(), code: str() }, ['type', 'message'], {
            additionalProperties: true,
          }),
        ],
      },
    },
  },
});

const transferDone = obj(
  {
    success: bool(),
    destination: str(),
    items: arrayOf(obj({ from: str(), to: str() })),
  },
  [],
  { additionalProperties: true }
);

const deleteResult = obj(
  {
    path: str(),
    status: str(null, { examples: ['trashed', 'deleted', 'failed'] }),
    trashItemId: str(),
    error: str(),
  },
  ['path', 'status'],
  { additionalProperties: true }
);

const tusHeaders = [header('Tus-Resumable', '`1.0.0`.', { type: 'string', const: '1.0.0' }, true)];

module.exports = {
  '/api/files/folder': {
    post: op({
      id: 'createFolder',
      summary: 'Create a folder',
      tag: TAG,
      access: 'account',
      body: body(
        obj(
          {
            path: str('The folder to create it in.'),
            destination: str('Older name for `path`.', { deprecated: true }),
            name: str(),
          },
          ['name']
        )
      ),
      responses: { 201: json(created, 'Created.'), ...errors(400, 401, 403, 404, 409) },
    }),
  },
  '/api/files/rename': {
    post: op({
      id: 'rename',
      summary: 'Rename a file or folder',
      description:
        'Favourites, shares, recent destinations and folder preferences bound to the old path follow it.',
      tag: TAG,
      access: 'account',
      body: body(
        obj({ path: str('The folder it is in.'), name: str(), newName: str() }, ['name', 'newName'])
      ),
      responses: { 200: json(created), ...errors(400, 401, 403, 404, 409) },
    }),
  },
  '/api/files/copy': {
    post: op({
      id: 'copy',
      summary: 'Copy files and folders into a folder',
      description: 'A name already taken there becomes `name (1)`.',
      tag: TAG,
      access: 'account',
      body: body(obj({ items: arrayOf(itemRef), destination: str() }, ['items', 'destination'])),
      responses: {
        200: json(transferDone, 'What landed where, once it has all landed.'),
        ...errors(400, 401, 403, 404, 507),
      },
    }),
  },
  '/api/files/move': {
    post: op({
      id: 'move',
      summary: 'Move files and folders into a folder',
      description: 'What was bound to the old paths follows them.',
      tag: TAG,
      access: 'account',
      body: body(obj({ items: arrayOf(itemRef), destination: str() }, ['items', 'destination'])),
      responses: {
        200: json(transferDone, 'What landed where, once it has all landed.'),
        ...errors(400, 401, 403, 404, 507),
      },
    }),
  },
  '/api/files/delete-impact': {
    post: op({
      id: 'describeDeletion',
      summary: 'What deleting a selection would affect, before doing it',
      description:
        'The shares it would end, and for each item whether it goes to the trash or is removed.',
      tag: TAG,
      access: 'account',
      body: body(obj({ items: arrayOf(itemRef) }, ['items'])),
      responses: {
        200: json(
          obj(
            {
              shareCount: int(),
              shares: arrayOf(obj({}, [], { additionalProperties: true })),
              trash: obj({
                enabled: bool(),
                retentionDays: int(),
                items: arrayOf(
                  obj({
                    path: str(),
                    disposition: str(null, { examples: ['trash', 'delete'] }),
                    reason: nullable(str()),
                    shareCount: int(),
                  })
                ),
              }),
            },
            ['shareCount']
          )
        ),
        ...errors(400, 401, 403),
      },
    }),
  },
  '/api/files': {
    delete: op({
      id: 'delete',
      summary: 'Delete files and folders',
      description:
        'To the trash where it is on, unless `permanent`. What was bound to the paths — favourites, shares, preferences — is forgotten for everybody.',
      tag: TAG,
      access: 'account',
      body: body(obj({ items: arrayOf(itemRef), permanent: bool() }, ['items'])),
      responses: {
        200: json(obj({ success: bool(), items: arrayOf(deleteResult) }, ['success', 'items'])),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/files/delete-stream': {
    post: op({
      id: 'deleteWithProgress',
      summary: 'Delete a selection, reporting as it goes',
      description:
        'The same as `DELETE /api/files`, for selections large enough to want a progress bar.',
      tag: TAG,
      access: 'account',
      body: body(obj({ items: arrayOf(itemRef), permanent: bool() }, ['items'])),
      responses: {
        200: ndjson(
          obj({ success: bool(), items: arrayOf(deleteResult) }),
          'Progress, then the outcome per item.'
        ),
        ...errors(400, 401),
      },
    }),
  },
  '/api/editor': {
    get: op({
      id: 'readText',
      summary: 'Read a text file',
      description:
        'Carries an `ETag`; sent back in `If-None-Match` while the file is unchanged, the answer is `304` and the file is not read. Over 32 KB it is compressed when the request allows.',
      tag: 'Editing',
      access: 'account',
      params: [
        query('path', 'The file.', { type: 'string' }, true),
        header('If-None-Match', 'The ETag of the copy held.'),
      ],
      responses: {
        200: json(obj({ content: str() }, ['content'])),
        304: { description: 'Unchanged since the copy held.' },
        ...errors(400, 401, 403, 404, 415),
      },
    }),
    post: op({
      id: 'readTextByPost',
      summary: 'Read a text file, the path in the body',
      description: 'The same answer as `GET`, kept for clients written against it.',
      tag: 'Editing',
      access: 'account',
      body: body(obj({ path: str() }, ['path'])),
      responses: {
        200: json(obj({ content: str() }, ['content'])),
        ...errors(400, 401, 403, 404, 415),
      },
    }),
    put: op({
      id: 'saveText',
      summary: 'Save a text file',
      description:
        'In the encoding the file already had. The previous content is kept as a version where versions are on. Answers with the `ETag` the next read will carry.',
      tag: 'Editing',
      access: 'account',
      body: body(obj({ path: str(), content: str() }, ['path', 'content'])),
      responses: {
        200: json(obj({ success: bool() }, ['success'])),
        ...errors(400, 401, 403, 404, 413),
      },
    }),
  },
  '/api/raw': {
    get: op({
      id: 'readRawText',
      summary: 'A text file’s content alone',
      tag: 'Editing',
      access: 'account',
      params: [
        query('path', 'The file.', { type: 'string' }, true),
        header('If-None-Match', 'The ETag of the copy held.'),
      ],
      responses: {
        200: { description: 'The text.', content: { 'text/plain': { schema: str() } } },
        304: { description: 'Unchanged since the copy held.' },
        ...errors(400, 401, 403, 404, 415),
      },
    }),
  },
  '/api/archive/list': {
    get: op({
      id: 'listArchive',
      summary: 'What is inside an archive, one folder at a time',
      description:
        'Needs 7-Zip on the server. `outside` counts entries left out because their names point outside the archive.',
      tag: 'Archives',
      access: 'account',
      params: [
        query('path', 'The archive.', { type: 'string' }, true),
        query('inside', 'A folder inside it; the top when absent.'),
      ],
      responses: {
        200: json(
          obj(
            {
              path: str(),
              name: str(),
              inside: str(),
              entries: arrayOf(
                obj(
                  {
                    name: str(),
                    path: str(),
                    isDirectory: bool(),
                    size: nullable(num()),
                    modified: nullable(str()),
                    encrypted: bool(),
                  },
                  ['name', 'path', 'isDirectory']
                )
              ),
              total: int(),
              outside: int(),
            },
            ['path', 'entries', 'total', 'outside']
          )
        ),
        ...errors(400, 401, 403, 404, 409, 413, 422, 503),
      },
    }),
  },
  '/api/archive/entry': {
    get: op({
      id: 'readArchiveEntry',
      summary: 'One file out of an archive, without unpacking the rest',
      description:
        'Always an attachment, always `nosniff`: nothing out of an archive is opened as a page here.',
      tag: 'Archives',
      access: 'account',
      params: [
        query('path', 'The archive.', { type: 'string' }, true),
        query('entry', 'The entry, by the name the listing gave.', { type: 'string' }, true),
      ],
      responses: {
        200: stream('application/octet-stream', 'The entry.'),
        ...errors(400, 401, 403, 404, 409, 422, 503),
      },
    }),
  },
  '/api/archive/extract': {
    post: op({
      id: 'extractFromArchive',
      summary: 'Take part of an archive out onto the volume',
      description:
        'Into the archive’s own folder, or `destination`. A folder stands for everything under it; nothing is replaced, so an entry may land under another name, which `done` gives.',
      tag: 'Archives',
      access: 'account',
      body: body(
        obj({ path: str(), entries: arrayOf(str()), destination: str() }, ['path', 'entries'])
      ),
      responses: {
        200: ndjson(
          obj({}, [], { additionalProperties: true }),
          'Progress, then where each entry landed.'
        ),
        ...errors(400, 401, 403, 404, 409, 413, 422, 503),
      },
    }),
  },
  '/api/files/zip/compress': {
    post: op({
      id: 'compress',
      summary: 'Make a zip of a selection',
      tag: 'Archives',
      access: 'account',
      body: body(
        obj(
          {
            items: arrayOf(itemRef),
            destination: str('The folder to put it in; the first item’s when absent.'),
            name: str('Without `.zip`.'),
          },
          ['items']
        )
      ),
      responses: {
        200: ndjson(
          obj({ success: bool(), item: ref('Item') }),
          'Progress, then the archive made.'
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/files/zip/extract': {
    post: op({
      id: 'extract',
      summary: 'Unpack a whole archive',
      tag: 'Archives',
      access: 'account',
      body: body(
        obj(
          {
            path: str('The archive.'),
            destination: str('`folder` for a new folder named after it, `current` beside it.', {
              enum: ['folder', 'current'],
              default: 'folder',
            }),
            password: str('For an archive behind one.', { format: 'password' }),
          },
          ['path']
        )
      ),
      responses: {
        200: ndjson(
          obj({ success: bool(), item: ref('Item'), items: arrayOf(ref('Item')) }),
          'Progress, then what was made.'
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/upload': {
    post: op({
      id: 'upload',
      summary: 'Send files in one request',
      description:
        'For clients that do not speak TUS, or where chunked uploads are off. Each file under `name (1)` when its name is taken. `413` names the limit that refused it.',
      tag: 'Uploads',
      access: 'account',
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: obj(
              {
                uploadTo: str('The folder.'),
                relativePath: str('Where within it, for a folder sent file by file.'),
                filedata: arrayOf(str(null, { format: 'binary' })),
              },
              ['filedata']
            ),
          },
        },
      },
      responses: {
        200: json(
          arrayOf(
            obj({ name: str(), path: str(), dateModified: dateTime(), size: num(), kind: str() })
          )
        ),
        ...errors(400, 401, 403, 413, 507),
      },
    }),
  },
  '/api/upload/folder-session': {
    post: op({
      id: 'startFolderUpload',
      summary: 'Reserve the name a folder upload will land under',
      description:
        'Before any file of it is sent, so every file of one dropped folder goes to the same place even when the name was taken.',
      tag: 'Uploads',
      access: 'account',
      body: body(
        obj({ uploadTo: str(), sourceRoot: str('The dropped folder’s name.') }, ['sourceRoot'])
      ),
      responses: {
        201: json(
          obj({ targetRoot: str('The name it will land under.') }, ['targetRoot']),
          'Reserved.'
        ),
        ...errors(400, 401, 403),
      },
    }),
  },
  '/api/upload/finalizations': {
    get: op({
      id: 'listUploadFinalizations',
      summary: 'Uploads received and not yet in place',
      tag: 'Uploads',
      access: 'account',
      responses: {
        200: json(obj({ items: arrayOf(obj({}, [], { additionalProperties: true })) }, ['items'])),
        ...errors(401),
      },
    }),
  },
  '/api/upload/tus': {
    post: op({
      id: 'createUpload',
      summary: 'Start a resumable upload',
      description:
        '[TUS](https://tus.io) creation. `Upload-Metadata` carries `filename`, `uploadTo` and `relativePath`, each base64. The upload’s URL is in `Location`. Needs `UPLOAD_CHUNKED_ENABLED`.',
      tag: 'Uploads',
      access: 'account',
      params: [
        ...tusHeaders,
        header('Upload-Length', 'The whole size in bytes.', { type: 'integer' }, true),
        header(
          'Upload-Metadata',
          'Comma-separated `key base64value` pairs.',
          { type: 'string' },
          true
        ),
      ],
      responses: {
        201: {
          description: 'Created.',
          headers: { Location: { schema: str(), description: 'The upload’s URL.' } },
        },
        ...errors(400, 401, 403, 413),
      },
    }),
    options: op({
      id: 'describeUploads',
      summary: 'What this TUS server supports',
      tag: 'Uploads',
      access: 'public',
      responses: { 200: noContent('Its `Tus-*` headers.'), 204: noContent('Its `Tus-*` headers.') },
    }),
  },
  '/api/upload/tus/{id}': {
    head: op({
      id: 'getUploadOffset',
      summary: 'How much of an upload has arrived',
      description:
        '`Upload-Offset` says where to carry on from. Complete only once the file is in its folder; `423` with `Upload-Finalize-Error` while it cannot be placed.',
      tag: 'Uploads',
      access: 'account',
      params: [{ name: 'id', in: 'path', required: true, schema: str() }, ...tusHeaders],
      responses: {
        200: noContent('`Upload-Offset` and `Upload-Length`.'),
        ...errors(401, 404, 423),
      },
    }),
    patch: op({
      id: 'sendUploadBytes',
      summary: 'Send the next bytes of an upload',
      tag: 'Uploads',
      access: 'account',
      params: [
        { name: 'id', in: 'path', required: true, schema: str() },
        ...tusHeaders,
        header('Upload-Offset', 'Where these bytes start.', { type: 'integer' }, true),
      ],
      body: {
        required: true,
        content: { 'application/offset+octet-stream': { schema: str(null, { format: 'binary' }) } },
      },
      responses: {
        204: noContent('Received; `Upload-Offset` is the new position.'),
        ...errors(400, 401, 404, 409, 500, 507),
      },
    }),
    delete: op({
      id: 'cancelUpload',
      summary: 'Abandon an upload',
      tag: 'Uploads',
      access: 'account',
      params: [{ name: 'id', in: 'path', required: true, schema: str() }, ...tusHeaders],
      responses: { 204: noContent('Abandoned.'), ...errors(401, 404) },
    }),
  },
  '/api/files/file': {
    post: op({
      id: 'createFile',
      summary: 'Create an empty file',
      description: 'Under `name (1)` when the name is taken; nothing is ever written over.',
      tag: TAG,
      access: 'account',
      body: body(
        obj(
          {
            path: str('The folder.'),
            destination: str('Older name for `path`.', { deprecated: true }),
            name: str(),
          },
          ['name']
        )
      ),
      responses: { 201: json(created, 'Created.'), ...errors(400, 401, 403, 404, 409) },
    }),
  },
  '/api/files/office-document': {
    post: op({
      id: 'createOfficeDocument',
      summary: 'Create a new document from a template',
      tag: TAG,
      access: 'account',
      body: body(
        obj(
          {
            path: str('The folder.'),
            format: str(null, { enum: ['docx', 'xlsx', 'pptx', 'pdf', 'txt', 'md', 'csv'] }),
            name: str('What to call it; a name is chosen when absent.'),
          },
          ['format']
        )
      ),
      responses: { 201: json(created, 'Created.'), ...errors(400, 401, 403, 404) },
    }),
  },
};
