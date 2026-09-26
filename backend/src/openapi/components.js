const { ref, obj, arrayOf, str, num, int, bool, dateTime, nullable } = require('./build');

/**
 * The shapes the API answers with, written from what it really answered: the
 * test that walks the API holds every response it receives to these.
 */

const User = obj(
  {
    id: str(),
    email: nullable(str()),
    emailVerified: bool(),
    username: nullable(str()),
    displayName: nullable(str()),
    roles: arrayOf(str(null, { enum: ['admin', 'user'] })),
    createdAt: dateTime(),
    updatedAt: dateTime(),
    personalFolderName: nullable(str('The folder this account owns, once it has been given one.')),
    provider: str('How this session signed in — `local` or `oidc`. On the signed-in account only.'),
  },
  ['id', 'roles']
);

const AdminUser = {
  allOf: [
    ref('User'),
    obj({
      authMethods: arrayOf(obj({ method: str(), provider: nullable(str()) })),
      lockedUntil: nullable(dateTime('Set while failed sign-ins keep the account locked.')),
      twoFactorEnabled: bool(),
    }),
  ],
};

const Access = obj(
  {
    canRead: bool(),
    canWrite: bool(),
    canUpload: bool(),
    canDelete: bool(),
    canCreateFolder: bool(),
    canCreateFile: bool(),
    canShare: bool(),
    canDownload: bool(),
    canSeeVersions: bool(),
    readOnly: nullable(
      str(
        'Why nothing can be written here when the storage itself refuses it, for everyone: `storage` for a read-only mount, `permission` for a folder the server may not write in. The write permissions above are then all false.',
        { enum: ['storage', 'permission', null] }
      )
    ),
  },
  [],
  {
    description:
      'What this caller may do here — asked before trying, rather than learned from a refusal.',
  }
);

const Item = obj(
  {
    name: str(),
    path: str('The folder it is in, not including its own name.'),
    kind: str(
      '`directory` for a folder, `volume` at the top, otherwise the extension in lower case — `pdf`, `md`, `unknown`.'
    ),
    size: num('Bytes. For a folder, what the file system reports for the folder itself.'),
    dateModified: dateTime(),
    access: ref('Access'),
    supportsThumbnail: bool('A thumbnail can be asked for at `/api/thumbnails/…`.'),
    versions: obj({ count: int(), bytes: num(), newest: nullable(dateTime()) }, [], {
      description: 'Earlier versions kept, where this caller may see them.',
    }),
    onlyofficeActivity: obj({}, [], {
      additionalProperties: true,
      description: 'Somebody has it open in ONLYOFFICE right now.',
    }),
  },
  ['name', 'path', 'kind']
);

const ErrorBody = obj(
  {
    success: { const: false },
    error: obj(
      {
        message: str('A sentence for a person.'),
        statusCode: int(),
        code: str(
          'A stable name for the refusal, where there is one — `AUTH_TOKEN_READ_ONLY`, `ARCHIVE_ENCRYPTED`.'
        ),
        requestId: str('Also in the server log: what to quote when something needs explaining.'),
        timestamp: dateTime(),
        details: {},
      },
      ['message', 'statusCode']
    ),
  },
  ['success', 'error']
);

/** The answer given before any route is reached, when nobody is signed in. */
const GateRefusal = obj({ error: str(), code: str() }, ['error']);

const Share = obj(
  {
    id: str(),
    shareToken: str('What the link carries.'),
    ownerId: str(),
    sourceSpace: str(null, { enum: ['volume', 'personal', 'user_volume'] }),
    sourcePath: str(),
    isDirectory: bool(),
    accessMode: str(null, { enum: ['readonly', 'readwrite'] }),
    allowDelete: bool(),
    allowCreateFolder: bool(),
    allowCreateFile: bool(),
    allowUpload: bool(),
    allowDownload: bool(),
    versionsVisible: bool(),
    versionsDownload: bool(),
    sharingType: str(null, { enum: ['anyone', 'users'] }),
    hasPassword: bool(),
    expiresAt: nullable(dateTime()),
    label: nullable(str()),
    accessCount: int(),
    downloadCount: int(),
    lastAccessedAt: nullable(dateTime()),
    lastAccessIp: nullable(str()),
    lastDownloadedAt: nullable(dateTime()),
    lastDownloadIp: nullable(str()),
    createdAt: dateTime(),
    updatedAt: dateTime(),
    userIds: arrayOf(str(), {
      description: 'The accounts it is shared with, when `sharingType` is `users`.',
    }),
    shareUrl: str('Built from `PUBLIC_URL` when it is set. On creation.'),
    directFileUrl: str('On creation.'),
  },
  ['id', 'shareToken', 'sourcePath', 'isDirectory', 'accessMode', 'sharingType']
);

const Version = obj(
  {
    id: str(),
    size: num(),
    modifiedAt: dateTime('When the file had this content.'),
    capturedAt: dateTime('When it was kept.'),
    author: nullable(obj({ id: nullable(str()), label: str() })),
    source: str('What kept it — a save from the editor, an upload over it, an office session.'),
    label: nullable(str()),
    pinned: bool('Kept whatever thinning would otherwise do.'),
    aside: bool('Set aside by a co-editor’s save rather than kept on a schedule.'),
    available: bool(),
  },
  ['id', 'size', 'modifiedAt']
);

const Favorite = obj(
  {
    id: str(),
    path: str(),
    label: nullable(str()),
    icon: nullable(str()),
    color: nullable(str()),
    position: int(),
    createdAt: dateTime(),
    updatedAt: dateTime(),
  },
  ['id', 'path']
);

const ApiToken = obj(
  {
    id: str(),
    name: str(),
    scope: str(null, { enum: ['read', 'write'] }),
    createdAt: dateTime(),
    expiresAt: nullable(dateTime()),
    lastUsedAt: nullable(dateTime()),
    lastUsedIp: nullable(str()),
  },
  ['id', 'name', 'scope']
);

const Passkey = obj(
  {
    id: str(),
    name: nullable(str()),
    createdAt: dateTime(),
    lastUsedAt: nullable(dateTime()),
    backedUp: bool(),
    transports: arrayOf(str()),
  },
  ['id']
);

const PasskeyOptions = obj(
  {
    options: obj({}, [], {
      description: 'What `navigator.credentials` expects, every byte as base64url.',
      additionalProperties: true,
    }),
    origins: arrayOf(str()),
  },
  ['options', 'origins']
);

const TrashItem = obj(
  {
    id: str(),
    name: str(),
    kind: str(),
    size: nullable(num()),
    deletedAt: dateTime(),
    expiresAt: nullable(dateTime()),
    deletedBy: nullable(obj({ id: nullable(str()), label: str(), isYou: bool() })),
    location: obj({ kind: str(), name: str(), parent: str() }),
    openPath: nullable(str()),
    available: bool(),
    shareCount: int(),
  },
  ['id', 'name']
);

const TrashZone = obj(
  {
    id: str(),
    kind: str(null, { enum: ['volume', 'personal', 'user_volume'] }),
    name: str(),
    available: bool(),
    reason: nullable(str()),
    itemCount: int(),
    usedBytes: num(),
    versionCount: int(),
    versionBytes: num(),
    budgetBytes: nullable(num()),
    freeBytes: nullable(num()),
    lastPass: nullable(obj({}, [], { additionalProperties: true })),
    events: arrayOf(obj({}, [], { additionalProperties: true })),
  },
  ['id', 'kind', 'name']
);

const FolderSize = obj(
  {
    path: str(),
    canEnter: bool(),
    sizeBytes: nullable(num()),
    entryCount: nullable(int()),
    lastUpdated: nullable(dateTime()),
    indexed: bool(),
    dirty: bool('Counted before something changed under it.'),
    excluded: bool(),
  },
  ['path']
);

const ActivityEvent = obj(
  {
    id: str(),
    at: dateTime(),
    action: str(),
    outcome: str(),
    userId: nullable(str()),
    actor: nullable(str()),
    target: nullable(str()),
    detail: nullable(str('JSON, as recorded.')),
    ip: nullable(str()),
  },
  ['id', 'at', 'action']
);

const UserVolume = obj(
  {
    id: str(),
    userId: str(),
    label: str(),
    path: str('Where it is on the server.'),
    accessMode: str(null, { enum: ['readonly', 'readwrite'] }),
    createdAt: dateTime(),
    updatedAt: dateTime(),
  },
  ['id', 'label', 'path', 'accessMode']
);

const schemas = {
  User,
  AdminUser,
  Access,
  Item,
  Error: ErrorBody,
  GateRefusal,
  Share,
  Version,
  Favorite,
  ApiToken,
  Passkey,
  PasskeyOptions,
  TrashItem,
  TrashZone,
  FolderSize,
  ActivityEvent,
  UserVolume,
};

const errorResponse = (description) => ({
  description,
  content: { 'application/json': { schema: ref('Error') } },
});

/**
 * A few routes answer a refusal the way the gate in front of them does, as
 * `{ "error" }`, rather than with the usual body: where those can occur, the
 * description admits both.
 */
const eitherError = (description) => ({
  description,
  content: { 'application/json': { schema: { anyOf: [ref('Error'), ref('GateRefusal')] } } },
});

const responses = {
  E400: errorResponse('The request is not one this operation can act on; the message says why.'),
  E401: eitherError(
    'Nobody is signed in, or the credential presented is not usable. The gate in front of every route answers `{ "error" }`; a route answers the usual error body.'
  ),
  E403: eitherError(
    'Signed in, and not allowed — including an API token at a door it never opens.'
  ),
  E404: eitherError('Not there, or not somewhere this caller may see.'),
  E409: errorResponse(
    'The state of things does not allow it — a name taken, an archive behind a password.'
  ),
  E413: errorResponse('Too large, or too many.'),
  E415: errorResponse('Not a kind of file this operation reads.'),
  E422: errorResponse('Understood, and impossible — a damaged archive.'),
  E423: errorResponse('Held by something else for the moment.'),
  E429: errorResponse('Too many attempts; wait before trying again.'),
  E500: errorResponse('Something failed on the server; the request id is in its log.'),
  E502: errorResponse(
    'A server this operation relies on — the identity provider — did not answer.'
  ),
  E503: eitherError(
    'A tool this operation needs is not installed on this server, or the feature is off.'
  ),
  E507: errorResponse('The volume is full.'),
};

const securitySchemes = {
  session: {
    type: 'apiKey',
    in: 'cookie',
    name: 'connect.sid',
    description:
      'The session the interface uses, from `POST /api/auth/login`. As wide as the account it belongs to.',
  },
  apiToken: {
    type: 'http',
    scheme: 'bearer',
    description:
      'An API token, `nxe_…`, from Settings → API tokens, in the `Authorization` header and nowhere else. A `read` token reaches reads only (and `POST /api/download`); no token reaches the account, administration, the terminal or an editor integration.',
  },
  guestSession: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Guest-Session',
    description:
      'What opening a shared link earns, from `POST /api/share/{token}/verify` or `GET /api/share/{token}/access`. Also accepted as the `guestSession` cookie.',
  },
};

module.exports = { schemas, responses, securitySchemes };
