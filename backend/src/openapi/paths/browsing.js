const {
  ref,
  obj,
  arrayOf,
  str,
  num,
  int,
  bool,
  nullable,
  dateTime,
  json,
  stream,
  errors,
  splatParam,
  query,
  header,
  body,
  op,
} = require('../build');

const TAG = 'Browsing';

const volume = obj(
  {
    name: str(),
    path: str(),
    kind: str(null, { enum: ['volume', 'personal'] }),
    readOnly: nullable(
      str(
        'Why nothing can be written in it, for the mark beside its name: `storage` for a read-only mount, `permission` for a folder the server may not write in, `access` when a rule or its assignment keeps this account to reading. Null when something can be written.',
        { enum: ['storage', 'permission', 'access', null] }
      )
    ),
  },
  ['name', 'path', 'kind']
);

module.exports = {
  '/api/volumes': {
    get: op({
      id: 'listVolumes',
      summary: 'The places this account can start from',
      description:
        'The volume’s top folders, the personal folder when there is one, and for somebody given assigned volumes, those instead.',
      tag: TAG,
      access: 'account',
      responses: { 200: json(arrayOf(volume)), ...errors(401) },
    }),
  },
  '/api/browse/{path}': {
    get: op({
      id: 'browse',
      summary: 'What a folder holds, and what this caller may do there',
      description:
        '`path` is a volume path (`Documents/2026`), `personal/…` for the personal folder, or an assigned volume’s label. Hidden files are listed when the account has asked to see them.',
      tag: TAG,
      access: 'account',
      params: [splatParam()],
      responses: {
        200: json(
          obj(
            {
              items: arrayOf(ref('Item')),
              access: ref('Access'),
              current: obj({ isDirectory: bool() }),
              path: str('The folder, as it was resolved.'),
            },
            ['items', 'access', 'path']
          )
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/usage/{path}': {
    get: op({
      id: 'getVolumeUsage',
      summary: 'How full the file system under a path is',
      tag: TAG,
      access: 'account',
      params: [splatParam()],
      responses: {
        200: json(
          obj(
            {
              path: str(),
              size: num(),
              used: num(),
              free: num(),
              total: num(),
              percentUsed: num(),
            },
            ['path']
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/metadata/{path}': {
    get: op({
      id: 'getMetadata',
      summary: 'What is known about one file or folder',
      description:
        'For a folder, the total of what is inside it, counted now and stopped at a bound (`truncated`). For an image, a video or a document, what reading it says — dimensions, duration, pages.',
      tag: TAG,
      access: 'account',
      params: [splatParam('The file or folder.')],
      responses: {
        200: json(
          obj(
            {
              path: str(),
              name: str(),
              kind: str(),
              size: num(),
              dateModified: dateTime(),
              dateCreated: dateTime(),
              directory: obj({
                totalSize: num(),
                fileCount: int(),
                dirCount: int(),
                truncated: bool(),
              }),
            },
            ['path', 'name', 'kind'],
            { additionalProperties: true }
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/search': {
    get: op({
      id: 'search',
      summary: 'Find files by name and by what they say',
      description:
        'Names first, closest match first; then documents that contain the term, the most relevant first. The term is a word or the beginning of one, three characters at least; `*` and `?` make it a pattern for names. `truncated` says the search ran out of time before looking everywhere, `complete` that the page is the whole answer.',
      tag: 'Search',
      access: 'account',
      params: [
        query('q', 'What to look for.', { type: 'string', minLength: 3 }, true),
        query('path', 'Where to start; the top when absent.'),
        query('limit', 'How many, up to 500.', {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 100,
        }),
      ],
      responses: {
        200: json(
          obj(
            {
              items: arrayOf(
                obj(
                  {
                    name: str(),
                    path: str(),
                    kind: str(null, { enum: ['file', 'dir'] }),
                    matchLine: str('The line that holds the term, for a match inside a file.'),
                    matchLineNumber: int(),
                    matchedName: bool(),
                    matchedContent: bool(),
                  },
                  ['name', 'path', 'kind']
                )
              ),
              truncated: bool(),
              limit: int(),
              complete: bool(),
            },
            ['items', 'truncated', 'limit', 'complete']
          )
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/permissions/{path}': {
    get: op({
      id: 'getFilePermissions',
      summary: 'Owner, group and mode of a file on the server',
      tag: TAG,
      access: 'account',
      params: [splatParam('The file or folder.')],
      responses: {
        200: json(
          obj(
            {
              path: str(),
              mode: int('The full `st_mode`.'),
              owner: str(),
              group: str(),
              uid: int(),
              gid: int(),
              isDirectory: bool(),
            },
            ['path', 'mode']
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/permissions/chmod': {
    post: op({
      id: 'changeFileMode',
      summary: 'Change the mode of a file on the server',
      tag: 'Administration',
      access: 'admin',
      body: body(
        obj(
          {
            path: str(),
            mode: str('Octal, as `chmod` takes it — `644`, `0755`.'),
            recursive: bool(),
          },
          ['path', 'mode']
        )
      ),
      responses: {
        200: json(obj({ success: bool(), path: str(), mode: int() }, ['success', 'path', 'mode'])),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/permissions/chown': {
    post: op({
      id: 'changeFileOwner',
      summary: 'Change the owner or group of a file on the server',
      description: 'Usually refused unless the server runs as root.',
      tag: 'Administration',
      access: 'admin',
      body: body(obj({ path: str(), owner: str(), group: str() }, ['path'])),
      responses: {
        200: json(
          obj({ success: bool(), path: str() }, ['success', 'path'], { additionalProperties: true })
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/folder-size/{path}': {
    get: op({
      id: 'getFolderSize',
      summary: 'How much a folder holds, from the index',
      description: '`404` when folder sizes are off.',
      tag: 'Folder sizes',
      access: 'account',
      params: [splatParam('The folder.')],
      responses: { 200: json(ref('FolderSize')), ...errors(401, 403, 404) },
    }),
  },
  '/api/folder-size/batch': {
    post: op({
      id: 'getFolderSizes',
      summary: 'Sizes of several folders at once',
      tag: 'Folder sizes',
      access: 'account',
      body: body(obj({ paths: arrayOf(str()) }, ['paths'])),
      responses: {
        200: json(
          obj(
            {
              results: arrayOf(ref('FolderSize')),
              truncated: bool('More paths were asked for than one call answers.'),
            },
            ['results', 'truncated']
          )
        ),
        ...errors(400, 401, 404),
      },
    }),
  },
  '/api/folder-size/refresh/{path}': {
    post: op({
      id: 'refreshFolderSize',
      summary: 'Count a folder again',
      description: 'Queued; `400` until the index has finished its first pass.',
      tag: 'Folder sizes',
      access: 'account',
      params: [splatParam('The folder.')],
      responses: {
        202: json(obj({}, [], { additionalProperties: true }), 'Queued.'),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/thumbnails/{path}': {
    get: op({
      id: 'getThumbnail',
      summary: 'Where the thumbnail of an image or video is, once it exists',
      description:
        '`thumbnail` is a URL under `/static/thumbnails`, or empty while it is being made (`202`, `pending`).',
      tag: 'Previews',
      access: 'account',
      params: [
        splatParam('The file.'),
        query('background', '`1` for a prefetch that may wait behind what is on screen.', {
          type: 'string',
          enum: ['1'],
        }),
      ],
      responses: {
        200: json(obj({ thumbnail: str(), pending: bool() }, ['thumbnail'])),
        202: json(
          obj({ thumbnail: str(), pending: bool(), queued: bool() }, ['thumbnail']),
          'Being made.'
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/preview': {
    get: op({
      id: 'getPreview',
      summary: 'A file’s content, for showing it',
      description:
        'Images, video, audio and PDF, with `Range` for media. `415` for a kind that has no preview.',
      tag: 'Previews',
      access: 'account',
      params: [
        query('path', 'The file.', { type: 'string' }, true),
        header('Range', 'Part of it, for media.'),
      ],
      responses: {
        200: stream('application/octet-stream', 'The file, with its own content type.'),
        206: stream('application/octet-stream', 'The part asked for.'),
        ...errors(401, 403, 404, 415),
        416: { description: 'The range is outside the file.' },
      },
    }),
  },
  '/api/media/tracks': {
    get: op({
      id: 'getMediaTracks',
      summary: 'The video, audio and subtitle tracks of a media file',
      tag: 'Previews',
      access: 'account',
      params: [query('path', 'The file.', { type: 'string' }, true)],
      responses: {
        200: json(
          obj(
            {
              available: bool('Whether the tracks could be read at all.'),
              video: arrayOf(obj({}, [], { additionalProperties: true })),
              audio: arrayOf(obj({}, [], { additionalProperties: true })),
              subtitles: arrayOf(obj({}, [], { additionalProperties: true })),
            },
            ['available']
          )
        ),
        ...errors(401, 403, 404, 415),
      },
    }),
  },
  '/api/media/subtitle': {
    get: op({
      id: 'getSubtitle',
      summary: 'One subtitle track, as WebVTT',
      tag: 'Previews',
      access: 'account',
      params: [
        query('path', 'The media file.', { type: 'string' }, true),
        query('stream', 'A track inside the file, from `/api/media/tracks`.'),
        query('file', 'A subtitle file beside it, by name.'),
      ],
      responses: {
        200: stream('text/vtt', 'The track.'),
        ...errors(400, 401, 403, 404, 415),
      },
    }),
  },
  '/api/download': {
    post: op({
      id: 'download',
      summary: 'Download a file, or several as one zip',
      description:
        'One file comes back as itself; several, or a folder, as a zip made as it is sent. The one POST a `read` API token may make.',
      tag: 'Files',
      access: 'account',
      body: body(
        obj({
          basePath: str('The folder the names are relative to, which the zip starts from.'),
          currentPath: str('Older name for `basePath`.', { deprecated: true }),
          path: str('One path.'),
          paths: arrayOf(str()),
          items: arrayOf(obj({ path: str(), name: str() })),
        })
      ),
      responses: {
        200: {
          description: 'The file, or a zip.',
          content: {
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            'application/zip': { schema: { type: 'string', format: 'binary' } },
          },
        },
        ...errors(400, 401, 403, 404),
      },
    }),
  },
};
