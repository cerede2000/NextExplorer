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

/** What a file's bytes add up to, under every algorithm this server takes. */
const digestsSchema = obj(
  {
    md5: str(),
    sha1: str(),
    sha256: str(),
  },
  ['md5', 'sha1', 'sha256']
);

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
    items: arrayOf(
      obj({
        from: str(),
        to: str(),
        unreadable: int(
          'How many entries under this one could not be read, so are not in the copy.'
        ),
        sourceKept: bool(
          'A move whose copy is short of something: the original stays where it is, since it holds the only copy of what could not be read.'
        ),
      })
    ),
    unreadable: int(
      'How many entries this transfer could not read at all — a name whose bytes are not valid UTF-8, usually written by Windows. They are missing from what arrived. Absent when there are none.'
    ),
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
            extension: str(
              'The extension to give it, for a format with no template — `json`, `yml`, `sh`. Empty for none. Refused where the format has a template, whose bytes decide what the file is.'
            ),
          },
          ['format']
        )
      ),
      responses: { 201: json(created, 'Created.'), ...errors(400, 401, 403, 404) },
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
      body: body(
        obj(
          {
            items: arrayOf(itemRef),
            destination: str(),
            taskId: str(
              'Add these items to an operation already running, for a selection too large for one body. The operation must be the caller\u2019s own, the same kind, and into the same folder.'
            ),
            continues: bool('More items for this operation are still to be sent.'),
          },
          ['items', 'destination']
        )
      ),
      responses: {
        200: ndjson(transferDone, 'Progress as it goes, and what landed where.'),
        202: json(
          obj({ taskId: str(), accepted: int() }, ['taskId', 'accepted']),
          'These items were added to the operation named by `taskId`, which is being watched elsewhere.'
        ),
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
      body: body(
        obj(
          {
            items: arrayOf(itemRef),
            destination: str(),
            taskId: str(
              'Add these items to an operation already running, for a selection too large for one body. The operation must be the caller\u2019s own, the same kind, and into the same folder.'
            ),
            continues: bool('More items for this operation are still to be sent.'),
          },
          ['items', 'destination']
        )
      ),
      responses: {
        200: ndjson(transferDone, 'Progress as it goes, and what landed where.'),
        202: json(
          obj({ taskId: str(), accepted: int() }, ['taskId', 'accepted']),
          'These items were added to the operation named by `taskId`, which is being watched elsewhere.'
        ),
        ...errors(400, 401, 403, 404, 507),
      },
    }),
  },
  '/api/files/checksums': {
    get: op({
      id: 'knownChecksums',
      summary: 'What is already known about a file',
      description:
        'Answers from what was remembered the last time the file was read, and reads nothing \u2014 `digests` is null until somebody asks for the bytes to be read. A checksum is remembered against the file it was taken from, so one taken before an edit is never answered afterwards.',
      tag: TAG,
      access: 'account',
      params: [query('path', 'The file.', { type: 'string' }, true)],
      responses: {
        200: json(
          obj(
            {
              path: str(),
              name: str(),
              size: int('Bytes.'),
              algorithms: arrayOf(str(), { description: 'What this server takes.' }),
              digests: nullable(digestsSchema),
              computedAt: nullable(dateTime('When the bytes were read.')),
            },
            ['path', 'name', 'size', 'algorithms', 'digests', 'computedAt']
          ),
          'What is known, which may be nothing.'
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
    post: op({
      id: 'takeChecksums',
      summary: 'Read files and answer what they add up to',
      description:
        'The slowest thing done to a file that is not being moved, so it is an operation of its own: it reports as it reads, `POST /api/tasks/{id}/cancel` stops it, and closing the tab no longer loses the reading. Files already read and unchanged since are answered from memory. With `compare`, the answer also says whether they are the same \u2014 and files of different sizes are answered without reading any of them, which `because: “size”` says.',
      tag: TAG,
      access: 'account',
      body: body(
        obj(
          {
            items: arrayOf(itemRef),
            compare: bool('Also say whether these files are the same.'),
          },
          ['items']
        )
      ),
      responses: {
        200: ndjson(
          obj(
            {
              success: bool(),
              items: arrayOf(
                obj(
                  {
                    path: str(),
                    name: str(),
                    size: int('Bytes.'),
                    digests: nullable(digestsSchema),
                    changedWhileReading: bool(
                      'The file was written to while it was being read, so this answer is of no file in particular and was not remembered.'
                    ),
                  },
                  ['path', 'name', 'size', 'digests']
                )
              ),
              identical: nullable(
                bool('Whether the files are the same; null unless `compare` was asked for.')
              ),
              because: str('What settled it without reading: `size`.'),
            },
            ['success', 'items', 'identical']
          ),
          'Progress as it reads, and what the files add up to.'
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/tasks': {
    get: op({
      id: 'listOperations',
      summary: 'Operations of the caller that are running or have just finished',
      description: `A copy or a move runs in the server, not in the request that asked for it: the
response to \`/api/files/copy\` is a window onto an operation, and closing it
stops nothing. This is how a window is reopened — after a reload, in another
tab — and it answers for the caller's own operations only.

\`interrupted\` is something else: nothing is resumed across a restart, so this
is the record of what was in flight when the server stopped, with the paths,
kept until the account that started it has been told. \`unreported\` is the other
half of an operation outliving its tab: one that *ended* with no window open on
it ended out of sight, so what became of it is kept as news too \u2014 a
cancellation apart, which is what its owner asked for.

What an operation *did* is not here, however it ended: every page load asks this,
and a copy of a hundred thousand files would answer it with all of them. It is in
the \`done\` event of the operation's own stream.`,
      tag: TAG,
      access: 'account',
      responses: {
        200: json(
          obj(
            {
              items: arrayOf(
                obj(
                  {
                    id: str(),
                    kind: str(null, {
                      examples: [
                        'copy',
                        'move',
                        'delete',
                        'extract',
                        'compress',
                        'restore',
                        'checksum',
                      ],
                    }),
                    state: str(null, { examples: ['running', 'done', 'failed', 'cancelled'] }),
                    destination: str(),
                    name: str(
                      'What it is about, where that is a name rather than a folder: the archive being unpacked, the name a new one took.'
                    ),
                    itemNames: arrayOf(str('What it is carrying, the first few.')),
                    totalItems: int(),
                    completedItems: int(),
                    totalBytes: int('Zero when a folder of unknown size is involved.'),
                    copiedBytes: int(),
                    currentName: str(),
                    percent: nullable(int('Only when the bytes are not known.')),
                    startedAt: num(),
                    finishedAt: nullable(num()),
                    error: obj({ message: str(), code: str() }, [], {
                      description: 'Why it did not finish, when it did not.',
                    }),
                  },
                  ['id', 'kind', 'state', 'destination']
                )
              ),
              interrupted: arrayOf(
                obj(
                  {
                    id: str(),
                    kind: str(),
                    destination: str(),
                    name: str(),
                    paths: arrayOf(str()),
                    startedAt: dateTime(),
                  },
                  ['id', 'kind', 'destination']
                )
              ),
              unreported: arrayOf(
                obj(
                  {
                    id: str(),
                    kind: str(),
                    outcome: str(null, { examples: ['done', 'failed'] }),
                    destination: str(),
                    name: str(),
                    paths: arrayOf(str()),
                    items: int('How many it got through.'),
                    startedAt: dateTime(),
                    finishedAt: dateTime(),
                  },
                  ['id', 'kind', 'outcome']
                )
              ),
            },
            ['items', 'interrupted', 'unreported']
          )
        ),
        ...errors(401),
      },
    }),
  },
  '/api/tasks/told': {
    post: op({
      id: 'acknowledgeOperationNews',
      summary: 'Acknowledge the news about operations',
      description:
        'What a restart was carrying, and what ended with no window open on it. Without `ids`, everything of the caller\u2019s that is waiting to be reported.',
      tag: TAG,
      access: 'account',
      body: body(obj({ ids: arrayOf(str()) })),
      responses: { 200: json(obj({ forgotten: int() }, ['forgotten'])), ...errors(401) },
    }),
  },
  '/api/tasks/{id}/stream': {
    get: op({
      id: 'watchOperation',
      summary: 'Follow one operation, from wherever it has got to',
      description:
        'The stream opens with a `start` event built from the operation as it is now, then reports as it goes. An operation that is not the caller\u2019s answers 404, exactly as one that does not exist.',
      tag: TAG,
      access: 'account',
      params: [{ name: 'id', in: 'path', required: true, schema: str() }],
      responses: {
        200: ndjson(transferDone, 'Progress as it goes, and what landed where.'),
        ...errors(401, 404, 429),
      },
    }),
  },
  '/api/tasks/{id}/cancel': {
    post: op({
      id: 'cancelOperation',
      summary: 'Stop one operation',
      description:
        'What has already landed stays where it is; a move that was stopped keeps its source. An operation that is not the caller\u2019s answers 404.',
      tag: TAG,
      access: 'account',
      params: [{ name: 'id', in: 'path', required: true, schema: str() }],
      responses: { 200: json(obj({ cancelled: bool() }, ['cancelled'])), ...errors(401, 404) },
    }),
  },
  '/api/files/recent-destinations': {
    get: op({
      id: 'listRecentDestinations',
      summary: 'Folders this account recently copied or moved into',
      description: 'Only those it can still reach.',
      tag: TAG,
      access: 'account',
      responses: { 200: json(obj({ items: arrayOf(str()) }, ['items'])), ...errors(401) },
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
      description: `The same as \`DELETE /api/files\`, for selections large enough to want a progress bar.

The deletion runs in the server and this response is a window onto it: closing it
stops nothing, \`taskId\` in the \`start\` event is what a tab opened later watches
it again by, and \`POST /api/tasks/{id}/cancel\` is how one is stopped. A selection
too large for one body is sent as several requests that all name the same
operation.`,
      tag: TAG,
      access: 'account',
      body: body(
        obj(
          {
            items: arrayOf(itemRef),
            permanent: bool(),
            taskId: str('Add these items to an operation already running.'),
            continues: bool('More items for this operation are still to be sent.'),
          },
          ['items']
        )
      ),
      responses: {
        200: ndjson(
          obj({ success: bool(), items: arrayOf(deleteResult) }),
          'Progress, then the outcome per item.'
        ),
        202: json(
          obj({ taskId: str(), accepted: int() }, ['taskId', 'accepted']),
          'These items were added to the operation named by `taskId`, which is being watched elsewhere.'
        ),
        ...errors(400, 401, 404, 409),
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
        'Into the archive’s own folder, or `destination`. A folder stands for everything under it; nothing is replaced, so an entry may land under another name, which `done` gives. ' +
        'The work runs in the server and this response is a window onto it: closing it stops nothing, `taskId` in the `start` event is what a tab opened later watches it again by, and `POST /api/tasks/{id}/cancel` is how one is stopped.',
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
      description:
        'The name it will take is in the `start` event and the one it took is in `done`: nothing is replaced, so a name already held becomes “name (1)”. ' +
        'The work runs in the server and this response is a window onto it: closing it stops nothing, `taskId` in the `start` event is what a tab opened later watches it again by, and `POST /api/tasks/{id}/cancel` is how one is stopped.',
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
      description:
        'Into a new folder beside it, or into the archive’s own folder with `destination: current`. ' +
        'The work runs in the server and this response is a window onto it: closing it stops nothing, `taskId` in the `start` event is what a tab opened later watches it again by, and `POST /api/tasks/{id}/cancel` is how one is stopped.',
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
        'Before any file of it is sent, so every file of one dropped folder goes to the same place even when the name was taken. The folder is created here, so a client that reserves and then sends nothing gives it back with `DELETE`.',
      tag: 'Uploads',
      access: 'account',
      body: body(
        obj(
          {
            uploadTo: str(),
            sourceRoot: str('The dropped folder’s name.'),
            uploadBatchId: str(
              'The client’s name for this batch, which a file of it arriving without a resolved path is placed by — and which the folder is given back under.'
            ),
          },
          ['sourceRoot']
        )
      ),
      responses: {
        201: json(
          obj({ targetRoot: str('The name it will land under.') }, ['targetRoot']),
          'Reserved.'
        ),
        ...errors(400, 401, 403),
      },
    }),
    delete: op({
      id: 'releaseFolderUpload',
      summary: 'Give back a reserved folder nothing arrived in',
      description: `Reserving creates the folder, so a drop called off before a byte went out left an
empty one behind — and the next attempt at the same folder was given the next
name, \`photos (1)\`, then \`photos (2)\`.

Removes the folder a reservation of this caller's own created, named by the
batch it was reserved for, where it is still there and holds no file at any
depth. Anything else is left exactly as it stands: one file in it means bytes
arrived, and those are worth more than a tidy name.`,
      tag: 'Uploads',
      access: 'account',
      body: body(
        obj(
          {
            uploadTo: str(),
            sourceRoot: str('The dropped folder’s name, as it was reserved for.'),
            uploadBatchId: str('The batch it was reserved for.'),
          },
          ['sourceRoot', 'uploadBatchId']
        )
      ),
      responses: {
        200: json(
          obj({ removed: bool('Whether the folder is gone.') }, ['removed']),
          'Nothing more is held.'
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
  '/api/upload/unfinished': {
    get: op({
      id: 'listUnfinishedUploads',
      summary: 'Uploads the caller started and did not finish',
      description: `An upload cannot carry on by itself the way a copy does: the bytes are in the
browser, so when the tab goes away nobody is sending any. What arrived is kept
with the position it reached (\`TUS_INCOMPLETE_UPLOAD_TTL_MS\`, a day by
default), and sending the same file again continues from \`offset\` instead of
sending it all over. This is how a client finds out there is anything to
continue \u2014 including from another browser, where it has no record of its own.

The caller's own, and only the ones started under the share they are asking
from. A direct upload is never here: one request carrying a whole body has no
position to come back to.`,
      tag: 'Uploads',
      access: 'account',
      responses: {
        200: json(
          obj(
            {
              items: arrayOf(
                obj(
                  {
                    id: str('The upload, as `/api/upload/tus/{id}`.'),
                    name: str('What it will be called where it is going.'),
                    size: nullable(int()),
                    offset: int('How many bytes arrived.'),
                    destination: str(),
                    uploadTo: str('The folder it is going into.'),
                    lastModified: nullable(int('Of the file it is waiting for.')),
                    startedAt: dateTime(),
                  },
                  ['id', 'name', 'offset']
                )
              ),
            },
            ['items']
          )
        ),
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
};
