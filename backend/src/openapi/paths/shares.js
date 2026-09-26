const {
  ref,
  obj,
  arrayOf,
  str,
  int,
  bool,
  dateTime,
  nullable,
  json,
  noContent,
  stream,
  errors,
  pathParam,
  splatParam,
  header,
  body,
  op,
} = require('../build');

const TAG = 'Sharing';
const LINK = 'Shared links';

const token = pathParam('token', 'What the link carries.');
const id = pathParam('id', 'The share’s id — not its token.');

const shareSettings = {
  accessMode: str(null, { enum: ['readonly', 'readwrite'], default: 'readonly' }),
  allowDelete: bool(),
  allowCreateFolder: bool(),
  allowCreateFile: bool(),
  allowUpload: bool(),
  allowDownload: bool(),
  versionsVisible: bool(),
  versionsDownload: bool(),
  sharingType: str('`anyone` for a public link, `users` for named accounts.', {
    enum: ['anyone', 'users'],
    default: 'anyone',
  }),
  userIds: arrayOf(str(), { description: 'With `sharingType: users`.' }),
  password: nullable(
    str('Asked of anybody opening it; null to take it off.', { format: 'password' })
  ),
  expiresAt: nullable(dateTime('When it stops working; null for never.')),
  label: nullable(str()),
};

const editorText = obj(
  {
    name: str(),
    path: str(),
    content: str(),
    canDownload: bool(),
    canWrite: bool(),
  },
  ['name', 'content', 'canWrite']
);

const guestHeader = header('X-Guest-Session', 'The guest session the link earned.');

module.exports = {
  '/api/shares': {
    get: op({
      id: 'listShares',
      summary: 'The shares this account made',
      tag: TAG,
      access: 'account',
      responses: { 200: json(obj({ shares: arrayOf(ref('Share')) }, ['shares'])), ...errors(401) },
    }),
    post: op({
      id: 'createShare',
      summary: 'Share a file or folder',
      description:
        'Answers the share with `shareUrl`, built from `PUBLIC_URL` when it is set and from the request’s host otherwise.',
      tag: TAG,
      access: 'account',
      body: body(
        obj({ sourcePath: str('What to share, as the account names it.'), ...shareSettings }, [
          'sourcePath',
        ])
      ),
      responses: { 201: json(ref('Share'), 'Shared.'), ...errors(400, 401, 403, 404) },
    }),
  },
  '/api/shares/shared-with-me': {
    get: op({
      id: 'listSharesWithMe',
      summary: 'What other accounts shared with this one',
      tag: TAG,
      access: 'account',
      responses: { 200: json(obj({ shares: arrayOf(ref('Share')) }, ['shares'])), ...errors(401) },
    }),
  },
  '/api/shares/{id}': {
    get: op({
      id: 'getShare',
      summary: 'One share, with how it has been used',
      tag: TAG,
      access: 'account',
      params: [id],
      responses: {
        200: json({
          allOf: [
            ref('Share'),
            obj({
              stats: obj(
                {
                  accessCount: int(),
                  downloadCount: int(),
                  lastAccessedAt: nullable(dateTime()),
                  lastAccessIp: nullable(str()),
                  lastDownloadedAt: nullable(dateTime()),
                  lastDownloadIp: nullable(str()),
                  guestSessionCount: int(),
                },
                [],
                { additionalProperties: true }
              ),
            }),
          ],
        }),
        ...errors(401, 403, 404),
      },
    }),
    put: op({
      id: 'updateShare',
      summary: 'Change a share',
      description: 'Only the fields sent change.',
      tag: TAG,
      access: 'account',
      params: [id],
      body: body(obj(shareSettings)),
      responses: { 200: json(ref('Share')), ...errors(400, 401, 403, 404) },
    }),
    delete: op({
      id: 'deleteShare',
      summary: 'Stop sharing',
      description: 'The link stops working at once, and the guest sessions it opened end.',
      tag: TAG,
      access: 'account',
      params: [id],
      responses: { 204: noContent('Stopped.'), ...errors(401, 403, 404) },
    }),
  },
  '/api/share/{token}': {
    get: op({
      id: 'openSharedFile',
      summary: 'The file a link shares, directly',
      description:
        'For a link to a single file. Behind a password, only with the guest session it earned.',
      tag: LINK,
      access: 'share',
      params: [token, guestHeader],
      responses: {
        200: stream('application/octet-stream', 'The file, with its own content type.'),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/share/{token}/info': {
    get: op({
      id: 'describeLink',
      summary: 'What a link is, before opening it',
      description:
        'Enough for the page that asks for a password, and nothing about where it points.',
      tag: LINK,
      access: 'share',
      params: [token],
      responses: {
        200: json(
          obj(
            {
              shareToken: str(),
              label: nullable(str()),
              isDirectory: bool(),
              hasPassword: bool(),
              requiresPassword: bool('This caller still has to give it.'),
              sharingType: str(null, { enum: ['anyone', 'users'] }),
              expiresAt: nullable(dateTime()),
              isExpired: bool(),
            },
            ['shareToken', 'isDirectory', 'requiresPassword']
          )
        ),
        ...errors(404),
      },
    }),
  },
  '/api/share/{token}/access': {
    get: op({
      id: 'openLink',
      summary: 'Open a link that asks for no password',
      description:
        'Answers a guest session to send with what follows. A link behind a password answers `401` until `verify`.',
      tag: LINK,
      access: 'share',
      params: [token],
      responses: {
        200: json(
          obj(
            {
              share: obj({
                shareToken: str(),
                label: nullable(str()),
                sourcePath: str('`share/<token>`: where to browse from.'),
                accessMode: str(null, { enum: ['readonly', 'readwrite'] }),
                allowDownload: bool(),
                isDirectory: bool(),
              }),
              guestSessionId: str(),
            },
            ['share']
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/share/{token}/verify': {
    post: op({
      id: 'unlockLink',
      summary: 'Give a link’s password',
      description: 'Rate limited. Answers the guest session the password earned.',
      tag: LINK,
      access: 'share',
      params: [token],
      body: body(obj({ password: str(null, { format: 'password' }) }), { required: false }),
      responses: {
        200: json(obj({ success: bool(), guestSessionId: str() }, ['success', 'guestSessionId'])),
        ...errors(401, 403, 404, 429),
      },
    }),
  },
  '/api/share/{token}/browse/{path}': {
    get: op({
      id: 'browseLink',
      summary: 'What a shared folder holds',
      tag: LINK,
      access: 'shareVisitor',
      params: [token, splatParam('Inside the shared folder; empty for its top.'), guestHeader],
      responses: {
        200: json(
          obj(
            {
              items: arrayOf(ref('Item')),
              access: ref('Access'),
              current: obj({ isDirectory: bool() }),
              path: str('`share/<token>/…`'),
              shareInfo: obj({ label: nullable(str()), sourceFolderName: str() }),
            },
            ['items', 'access', 'path']
          )
        ),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/share/{token}/file': {
    get: op({
      id: 'downloadSharedFile',
      summary: 'The file a link shares',
      tag: LINK,
      access: 'share',
      params: [token, guestHeader, header('Range', 'Part of it.')],
      responses: {
        200: stream('application/octet-stream', 'The file.'),
        206: stream('application/octet-stream', 'The part asked for.'),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/share/{token}/file/{path}': {
    get: op({
      id: 'downloadFileInLink',
      summary: 'A file inside a shared folder',
      tag: LINK,
      access: 'share',
      params: [
        token,
        splatParam('The file, inside the shared folder.'),
        guestHeader,
        header('Range', 'Part of it.'),
      ],
      responses: {
        200: stream('application/octet-stream', 'The file.'),
        206: stream('application/octet-stream', 'The part asked for.'),
        ...errors(401, 403, 404),
      },
    }),
  },
  '/api/share/{token}/editor': {
    get: op({
      id: 'readSharedText',
      summary: 'The text of a file a link shares',
      description: 'Its `ETag` also changes when what the link allows does.',
      tag: LINK,
      access: 'share',
      params: [token, guestHeader, header('If-None-Match', 'The ETag of the copy held.')],
      responses: {
        200: json(editorText),
        304: { description: 'Unchanged.' },
        ...errors(401, 403, 404, 415),
      },
    }),
    put: op({
      id: 'saveSharedText',
      summary: 'Save the text of a file a link shares',
      description: 'Only through a writable link.',
      tag: LINK,
      access: 'share',
      params: [token, guestHeader],
      body: body(obj({ content: str() }, ['content'])),
      responses: {
        200: json(obj({ success: bool() }, ['success'])),
        ...errors(400, 401, 403, 404, 413),
      },
    }),
  },
  '/api/share/{token}/editor/{path}': {
    get: op({
      id: 'readTextInLink',
      summary: 'The text of a file inside a shared folder',
      tag: LINK,
      access: 'share',
      params: [token, splatParam('The file, inside the shared folder.'), guestHeader],
      responses: {
        200: json(editorText),
        304: { description: 'Unchanged.' },
        ...errors(401, 403, 404, 415),
      },
    }),
    put: op({
      id: 'saveTextInLink',
      summary: 'Save a text file inside a shared folder',
      tag: LINK,
      access: 'share',
      params: [token, splatParam('The file, inside the shared folder.'), guestHeader],
      body: body(obj({ content: str() }, ['content'])),
      responses: {
        200: json(obj({ success: bool() }, ['success'])),
        ...errors(400, 401, 403, 404, 413),
      },
    }),
  },
};
