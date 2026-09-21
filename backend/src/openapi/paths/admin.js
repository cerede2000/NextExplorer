const {
  ref,
  obj,
  arrayOf,
  str,
  int,
  bool,
  nullable,
  json,
  noContent,
  errors,
  pathParam,
  query,
  body,
  op,
} = require('../build');

const ADMIN = 'Administration';
const ACCOUNTS = 'Accounts (administration)';

const section = (description) => obj({}, [], { additionalProperties: true, description });

const settings = obj(
  {
    branding: obj({ appName: str(), appLogoUrl: str(), showPoweredBy: bool() }, [], {
      additionalProperties: true,
    }),
    user: section('This account’s own preferences: sorting and view per folder, hidden files.'),
    uploads: section('Chunked uploads.'),
    thumbnails: section('Whether, how large, how good, how many at once.'),
    access: obj({
      rules: arrayOf(
        obj(
          {
            path: str(),
            recursive: bool(),
            permissions: str(null, { enum: ['rw', 'ro', 'hidden'] }),
          },
          [],
          { additionalProperties: true }
        )
      ),
    }),
    folderSize: section(
      'Mode and excluded folders — those from the environment cannot be changed here.'
    ),
    searchIndex: section('Whether the index is on, and excluded folders.'),
    trash: section('Retention and budget.'),
    versions: section('How versions are thinned and kept.'),
    activity: obj({ enabled: bool(), retentionDays: int() }),
  },
  [],
  {
    description:
      'Every section is answered to an administrator; to anybody else, only `branding` and `user`. A section sent replaces what it names and leaves the rest.',
  }
);

const userId = pathParam('id', 'The account.');
const volumeUserId = pathParam('userId', 'The account.');
const userAnswer = obj({ user: ref('User') }, ['user']);
const volumeAnswer = obj({ volume: ref('UserVolume') }, ['volume']);

module.exports = {
  '/api/settings': {
    get: op({
      id: 'getSettings',
      summary: 'The settings this account may see',
      tag: 'Settings',
      access: 'account',
      responses: { 200: json(settings), ...errors(401) },
    }),
    patch: op({
      id: 'updateSettings',
      summary: 'Change settings',
      description:
        'An account’s own `user` preferences, by anybody; every other section, by an administrator — `403` otherwise, and nothing is changed.',
      tag: 'Settings',
      access: 'account',
      body: body(settings),
      responses: { 200: json(settings), ...errors(400, 401, 403) },
    }),
  },
  '/api/settings/upload-logo': {
    post: op({
      id: 'uploadLogo',
      summary: 'Replace the logo',
      tag: 'Settings',
      access: 'admin',
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: obj(
              {
                logo: str('PNG, JPEG, SVG or WebP.', { format: 'binary' }),
                branding: str('JSON: the rest of the branding, saved with it.'),
              },
              ['logo']
            ),
          },
        },
      },
      responses: {
        200: json({ allOf: [settings, obj({ logoUrl: str() }, ['logoUrl'])] }),
        ...errors(400, 401, 403, 413),
      },
    }),
  },
  '/api/branding': {
    get: op({
      id: 'getBranding',
      summary: 'Name and logo, for the sign-in page',
      tag: 'Settings',
      access: 'public',
      responses: {
        200: json(obj({ appName: str(), appLogoUrl: str(), showPoweredBy: bool() }, ['appName'])),
      },
    }),
  },
  '/api/features': {
    get: op({
      id: 'getFeatures',
      summary: 'What this installation offers',
      description:
        'Which integrations, limits and optional features are on, and which release this is. Answered to anybody: the interface needs it before signing in.',
      tag: 'Settings',
      access: 'public',
      responses: {
        200: json(
          obj(
            {
              public: obj({
                url: nullable(str()),
                origin: nullable(str()),
                origins: arrayOf(str()),
              }),
              version: obj({ app: str(), gitCommit: str(), gitBranch: str(), repoUrl: str() }),
            },
            ['version'],
            { additionalProperties: true }
          )
        ),
      },
    }),
  },
  '/api/capabilities': {
    get: op({
      id: 'getCapabilities',
      summary: 'Which optional tools are installed, and what each makes possible',
      tag: ADMIN,
      access: 'admin',
      responses: {
        200: json(
          obj(
            {
              capabilities: arrayOf(
                obj(
                  {
                    name: str(),
                    available: bool(),
                    version: nullable(
                      str(
                        'What the tool says its version is, as it prints it; null when it is missing or its answer does not say.'
                      )
                    ),
                    enables: str(),
                    install: str('The package that provides it.'),
                    source: nullable(str('Where ExifTool comes from; null when there is none.')),
                    used: bool(),
                    missingFormats: arrayOf(str()),
                    installMissing: str('The package that adds the formats it lacks.'),
                  },
                  ['name', 'available']
                )
              ),
            },
            ['capabilities']
          )
        ),
        ...errors(401, 403),
      },
    }),
  },
  '/api/users': {
    get: op({
      id: 'listUsers',
      summary: 'Every account',
      tag: ACCOUNTS,
      access: 'admin',
      responses: {
        200: json(obj({ users: arrayOf(ref('AdminUser')) }, ['users'])),
        ...errors(401, 403),
      },
    }),
    post: op({
      id: 'createUser',
      summary: 'Create an account',
      tag: ACCOUNTS,
      access: 'admin',
      body: body(
        obj(
          {
            email: str(null, { format: 'email' }),
            username: str(),
            password: str(null, { format: 'password' }),
            displayName: str(),
            roles: arrayOf(str(null, { enum: ['admin', 'user'] })),
          },
          ['email', 'password']
        )
      ),
      responses: { 201: json(userAnswer, 'Created.'), ...errors(400, 401, 403, 409) },
    }),
  },
  '/api/users/shareable': {
    get: op({
      id: 'listShareableUsers',
      summary: 'The accounts something can be shared with',
      tag: 'Sharing',
      access: 'account',
      responses: {
        200: json(
          obj(
            {
              users: arrayOf(
                obj(
                  {
                    id: str(),
                    email: nullable(str()),
                    username: nullable(str()),
                    displayName: nullable(str()),
                  },
                  ['id']
                )
              ),
            },
            ['users']
          )
        ),
        ...errors(401),
      },
    }),
  },
  '/api/users/search': {
    get: op({
      id: 'searchUsers',
      summary: 'Accounts matching a name, for mentions in an editor',
      description: 'Answered in the field names an office editor expects.',
      tag: 'Sharing',
      access: 'account',
      params: [query('q', 'Part of a name or an address.')],
      responses: {
        200: json(
          obj(
            {
              users: arrayOf(
                obj({ UserId: str(), UserFriendlyName: str(), UserEmail: nullable(str()) }, [
                  'UserId',
                ])
              ),
            },
            ['users']
          )
        ),
        ...errors(401),
      },
    }),
  },
  '/api/users/{id}': {
    patch: op({
      id: 'updateUser',
      summary: 'Change an account',
      description: 'The last administrator cannot be made an ordinary account.',
      tag: ACCOUNTS,
      access: 'admin',
      params: [userId],
      body: body(
        obj({
          email: str(null, { format: 'email' }),
          username: str(),
          displayName: str(),
          roles: arrayOf(str(null, { enum: ['admin', 'user'] })),
        })
      ),
      responses: { 200: json(userAnswer), ...errors(400, 401, 403, 404, 409) },
    }),
    delete: op({
      id: 'deleteUser',
      summary: 'Delete an account',
      description: 'Its sessions and API tokens end with it.',
      tag: ACCOUNTS,
      access: 'admin',
      params: [userId],
      responses: { 204: noContent('Deleted.'), ...errors(400, 401, 403, 404) },
    }),
  },
  '/api/users/{id}/password': {
    post: op({
      id: 'resetUserPassword',
      summary: 'Set an account’s password',
      description: 'Signs out every session of that account.',
      tag: ACCOUNTS,
      access: 'admin',
      params: [userId],
      body: body(obj({ newPassword: str(null, { format: 'password' }) }, ['newPassword'])),
      responses: { 204: noContent('Set.'), ...errors(400, 401, 403, 404) },
    }),
  },
  '/api/users/{id}/lock': {
    delete: op({
      id: 'unlockUser',
      summary: 'Lift the lock failed sign-ins put on an account',
      tag: ACCOUNTS,
      access: 'admin',
      params: [userId],
      responses: { 204: noContent('Unlocked.'), ...errors(401, 403, 404) },
    }),
  },
  '/api/users/{id}/two-factor': {
    delete: op({
      id: 'removeUserSecondFactor',
      summary: 'Take the second factor off an account that lost it',
      tag: ACCOUNTS,
      access: 'admin',
      params: [userId],
      responses: { 204: noContent('Removed.'), ...errors(401, 403, 404) },
    }),
  },
  '/api/users/{id}/passkeys': {
    delete: op({
      id: 'removeUserPasskeys',
      summary: 'Take every passkey off an account',
      tag: ACCOUNTS,
      access: 'admin',
      params: [userId],
      responses: { 204: noContent('Removed.'), ...errors(401, 403, 404) },
    }),
  },
  '/api/users/{userId}/volumes': {
    get: op({
      id: 'listUserVolumes',
      summary: 'The volumes assigned to an account',
      description: 'With `USER_VOLUMES` on.',
      tag: ACCOUNTS,
      access: 'admin',
      params: [volumeUserId],
      responses: {
        200: json(obj({ volumes: arrayOf(ref('UserVolume')) }, ['volumes'])),
        ...errors(401, 403, 404),
      },
    }),
    post: op({
      id: 'assignVolume',
      summary: 'Assign a folder of the server to an account',
      tag: ACCOUNTS,
      access: 'admin',
      params: [volumeUserId],
      body: body(
        obj(
          {
            label: str('What the account sees it as.'),
            path: str('An absolute path on the server.'),
            accessMode: str(null, { enum: ['readonly', 'readwrite'], default: 'readwrite' }),
          },
          ['label', 'path']
        )
      ),
      responses: { 201: json(volumeAnswer, 'Assigned.'), ...errors(400, 401, 403, 404, 409) },
    }),
  },
  '/api/users/{userId}/volumes/{volumeId}': {
    patch: op({
      id: 'updateAssignedVolume',
      summary: 'Rename an assigned volume or change its access',
      tag: ACCOUNTS,
      access: 'admin',
      params: [volumeUserId, pathParam('volumeId', 'The assigned volume.')],
      body: body(obj({ label: str(), accessMode: str(null, { enum: ['readonly', 'readwrite'] }) })),
      responses: { 200: json(volumeAnswer), ...errors(400, 401, 403, 404, 409) },
    }),
    delete: op({
      id: 'unassignVolume',
      summary: 'Take an assigned volume away',
      tag: ACCOUNTS,
      access: 'admin',
      params: [volumeUserId, pathParam('volumeId', 'The assigned volume.')],
      responses: { 204: noContent('Taken away.'), ...errors(401, 403, 404) },
    }),
  },
  '/api/admin/browse-directories': {
    get: op({
      id: 'browseServerFolders',
      summary: 'Folders of the server, to pick one to assign',
      tag: ACCOUNTS,
      access: 'admin',
      params: [query('path', 'An absolute path; the volume when absent.')],
      responses: {
        200: json(
          obj(
            {
              current: str(),
              parent: nullable(str()),
              directories: arrayOf(obj({ name: str(), path: str() }, ['name', 'path'])),
            },
            ['current', 'directories']
          )
        ),
        ...errors(400, 401, 403, 404),
      },
    }),
  },
  '/api/activity': {
    get: op({
      id: 'readActivity',
      summary: 'What was recorded, newest first',
      description: 'Carry on from a page with `before` set to its `nextBefore`.',
      tag: ADMIN,
      access: 'admin',
      params: [
        query('action', 'One kind of event, from `actions`.'),
        query('outcome', '`done` or `refused`.'),
        query('user', 'One account.'),
        query('from', 'Not before.', { type: 'string', format: 'date-time' }),
        query('to', 'Not after.', { type: 'string', format: 'date-time' }),
        query('q', 'Words in the target or the detail.'),
        query('before', 'Where the previous page ended.'),
        query('limit', 'How many.', { type: 'integer' }),
      ],
      responses: {
        200: json(
          obj(
            {
              events: arrayOf(ref('ActivityEvent')),
              nextBefore: nullable(str()),
              enabled: bool(),
              actions: arrayOf(str()),
            },
            ['events', 'enabled', 'actions']
          )
        ),
        ...errors(400, 401, 403),
      },
    }),
    delete: op({
      id: 'clearActivity',
      summary: 'Empty the activity log',
      description: 'Writes one last line, naming who asked and how many went.',
      tag: ADMIN,
      access: 'admin',
      responses: { 200: json(obj({ removed: int() }, ['removed'])), ...errors(401, 403) },
    }),
  },
  '/api/activity/address': {
    get: op({
      id: 'explainRecordedAddress',
      summary: 'Why the log records the address it records',
      tag: ADMIN,
      access: 'admin',
      responses: {
        200: json(
          obj(
            {
              recorded: nullable(str()),
              peer: nullable(str()),
              trustsPeer: bool(),
              trustProxy: { description: 'The rule in force.' },
              announced: obj({}, [], {
                additionalProperties: true,
                description: 'Every forwarding header that arrived.',
              }),
            },
            ['recorded', 'peer', 'trustsPeer']
          )
        ),
        ...errors(401, 403),
      },
    }),
  },
  '/api/terminal/session': {
    post: op({
      id: 'openTerminal',
      summary: 'A short-lived ticket for a terminal on the server',
      description: 'For the WebSocket at `/api/terminal`. `503` when the terminal is off.',
      tag: ADMIN,
      access: 'admin',
      body: body(obj({ cwd: str('A volume path to start in.') }), { required: false }),
      responses: { 200: json(obj({ token: str() }, ['token'])), ...errors(401, 403, 503) },
    }),
  },
  '/api/openapi.json': {
    get: op({
      id: 'describeApi',
      summary: 'This description',
      description:
        'For a generated client or an explorer; `info.version` is the release this instance runs.',
      tag: 'Settings',
      access: 'public',
      responses: {
        200: json(
          obj(
            { openapi: str(), info: obj({}, [], { additionalProperties: true }) },
            ['openapi', 'info'],
            { additionalProperties: true }
          )
        ),
      },
    }),
  },
  '/healthz': {
    get: op({
      id: 'isAlive',
      summary: 'Whether the process answers',
      description:
        'Before the session store, the identity provider and every route: a probe that waited on those would report them, not this process.',
      tag: 'Health',
      access: 'public',
      responses: { 200: json(obj({ status: { const: 'ok' } }, ['status'])) },
    }),
  },
  '/readyz': {
    get: op({
      id: 'isReady',
      summary: 'Whether the application has started',
      tag: 'Health',
      access: 'public',
      responses: { 200: json(obj({ status: { const: 'ready' } }, ['status'])) },
    }),
  },
};
