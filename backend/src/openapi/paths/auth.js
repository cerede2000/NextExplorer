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
  errors,
  pathParam,
  query,
  body,
  op,
} = require('../build');

const TAG = 'Accounts and signing in';

const userAnswer = obj({ user: ref('User') }, ['user']);
const secondStep = obj({ totpRequired: { const: true } }, ['totpRequired'], {
  description: 'The password was right; finish at `POST /api/auth/login/totp`.',
});
const password = str('The account’s current password.', { format: 'password' });
const tokenAnswer = obj({ token: ref('ApiToken') }, ['token']);

module.exports = {
  '/api/auth/status': {
    get: op({
      id: 'getAuthStatus',
      summary: 'What the sign-in screen needs to know',
      description:
        'Whether the installation still needs its first account, which ways in are offered, and who this browser is, if anybody. Answered to anybody.',
      tag: TAG,
      access: 'public',
      responses: {
        200: json(
          obj(
            {
              requiresSetup: bool(
                'No account exists yet: `POST /api/auth/setup` creates the first.'
              ),
              strategies: obj({ local: bool(), oidc: bool(), passkey: bool() }),
              totpPending: bool('A password was accepted and the code is still awaited.'),
              authEnabled: bool(),
              authMode: str(null, { enum: ['local', 'oidc', 'both'] }),
              authenticated: bool(),
              user: nullable(ref('User')),
              oidc: obj({
                enabled: bool(),
                issuer: nullable(str()),
                scopes: arrayOf(str()),
                status: str('What configuring the provider concluded.'),
              }),
            },
            ['requiresSetup', 'strategies', 'authEnabled', 'authMode', 'authenticated']
          )
        ),
      },
    }),
  },
  '/api/auth/setup': {
    post: op({
      id: 'setUpFirstAccount',
      summary: 'Create the first account, an administrator',
      description: 'Only while no account exists. Signs the new account in.',
      tag: TAG,
      access: 'public',
      body: body(
        obj(
          {
            email: str(null, { format: 'email' }),
            username: str('Defaults to what is before the @.'),
            password: str(null, { format: 'password' }),
          },
          ['email', 'password']
        )
      ),
      responses: { 201: json(userAnswer, 'Created and signed in.'), ...errors(400, 403, 429) },
    }),
  },
  '/api/auth/login': {
    post: op({
      id: 'signIn',
      summary: 'Sign in with a password',
      description:
        'Answers the account and sets the session cookie. An account with a second factor answers `{ "totpRequired": true }` instead, and the session holds the sign-in for five minutes until the code arrives.',
      tag: TAG,
      access: 'public',
      body: body(
        obj(
          {
            identifier: str('An email address or a username.'),
            email: str('Older name for `identifier`.', { deprecated: true }),
            username: str('Older name for `identifier`.', { deprecated: true }),
            password: str(null, { format: 'password' }),
          },
          ['password']
        )
      ),
      responses: {
        200: json({ oneOf: [userAnswer, secondStep] }, 'Signed in, or halfway there.'),
        ...errors(400, 401, 403, 429),
      },
    }),
  },
  '/api/auth/login/totp': {
    post: op({
      id: 'signInSecondStep',
      summary: 'Finish signing in with a code',
      description:
        'The six digits from the authenticator, or one recovery code. A wrong code counts against the same lockout as a wrong password (`AUTH_INVALID_TOTP_CODE`).',
      tag: TAG,
      access: 'public',
      body: body(obj({ code: str('Six digits, or a recovery code.') }, ['code'])),
      responses: {
        200: json(
          obj(
            {
              user: ref('User'),
              usedRecoveryCode: bool(),
              recoveryCodesLeft: nullable(int()),
            },
            ['user']
          ),
          'Signed in.'
        ),
        ...errors(401, 429),
      },
    }),
  },
  '/api/auth/login/passkey/start': {
    post: op({
      id: 'startPasskeySignIn',
      summary: 'Begin signing in with a passkey',
      description: 'The challenge inside `options` is spent by the matching finish.',
      tag: TAG,
      access: 'public',
      responses: { 200: json(ref('PasskeyOptions')), ...errors(403, 429) },
    }),
  },
  '/api/auth/login/passkey/finish': {
    post: op({
      id: 'finishPasskeySignIn',
      summary: 'Sign in with the passkey’s answer',
      description:
        'Every refusal is `401` with `AUTH_PASSKEY_REJECTED`, whatever the reason. A passkey that was not unlocked on an account with a second factor answers `{ "totpRequired": true }`.',
      tag: TAG,
      access: 'public',
      body: body(
        obj(
          {
            response: obj({}, [], {
              additionalProperties: true,
              description: 'What `navigator.credentials.get` returned.',
            }),
          },
          ['response']
        )
      ),
      responses: {
        200: json({ oneOf: [userAnswer, secondStep] }),
        ...errors(401, 429),
      },
    }),
  },
  '/api/auth/logout': {
    post: op({
      id: 'signOut',
      summary: 'Sign out this session',
      description:
        'Ends the application’s session. Signing out at the identity provider as well is `GET /logout`, which a browser navigates to.',
      tag: TAG,
      access: 'public',
      responses: { 204: noContent('Signed out.') },
    }),
  },
  '/api/auth/me': {
    get: op({
      id: 'whoAmI',
      summary: 'The account this request is made as',
      description:
        '`{ "user": null }` when nobody is signed in. The one account route an API token may call.',
      tag: TAG,
      access: 'public',
      responses: { 200: json(obj({ user: nullable(ref('User')) }, ['user'])) },
    }),
  },
  '/api/auth/methods': {
    get: op({
      id: 'listSignInMethods',
      summary: 'The ways this account signs in',
      tag: TAG,
      access: 'session',
      responses: {
        200: json(
          obj(
            {
              methods: arrayOf(
                obj({
                  id: str(),
                  type: str(null, { examples: ['local_password', 'oidc'] }),
                  provider: str(),
                  lastUsedAt: nullable(dateTime()),
                  createdAt: dateTime(),
                })
              ),
            },
            ['methods']
          )
        ),
        ...errors(401, 403),
      },
    }),
  },
  '/api/auth/password': {
    post: op({
      id: 'changePassword',
      summary: 'Change this account’s password',
      description:
        'Signs out every other session of the account, and moves this one to a new cookie, which the response sets.',
      tag: TAG,
      access: 'session',
      body: body(
        obj({ currentPassword: password, newPassword: str(null, { format: 'password' }) }, [
          'currentPassword',
          'newPassword',
        ])
      ),
      responses: { 204: noContent('Changed.'), ...errors(400, 401, 403, 429) },
    }),
  },
  '/api/auth/password/add': {
    post: op({
      id: 'addPassword',
      summary: 'Give a password to an account that signs in elsewhere',
      description: 'For an account made through the identity provider. `409` when it has one.',
      tag: TAG,
      access: 'session',
      body: body(obj({ password: str(null, { format: 'password' }) }, ['password'])),
      responses: {
        200: json(obj({ message: str() }, ['message'])),
        ...errors(400, 401, 403, 409, 429),
      },
    }),
  },
  '/api/auth/totp': {
    get: op({
      id: 'getSecondFactor',
      summary: 'Whether this account asks for a code',
      tag: TAG,
      access: 'session',
      responses: {
        200: json(
          obj(
            {
              enabled: bool(),
              pending: bool('Started and not yet confirmed.'),
              confirmedAt: nullable(dateTime()),
              recoveryCodesLeft: int(),
            },
            ['enabled', 'pending', 'recoveryCodesLeft']
          )
        ),
        ...errors(401, 403),
      },
    }),
    delete: op({
      id: 'turnOffSecondFactor',
      summary: 'Stop asking this account for a code',
      tag: TAG,
      access: 'session',
      body: body(obj({ password }, ['password'])),
      responses: { 204: noContent('Off.'), ...errors(401, 403, 429) },
    }),
  },
  '/api/auth/totp/start': {
    post: op({
      id: 'startSecondFactor',
      summary: 'Draw a secret for an authenticator',
      description:
        'From a session opened with the password. Nothing is asked of the account until `confirm` proves the phone holds the same secret.',
      tag: TAG,
      access: 'session',
      responses: {
        200: json(
          obj({ secret: str('Base32.'), uri: str('`otpauth://…`, for a QR code.') }, [
            'secret',
            'uri',
          ])
        ),
        ...errors(401, 403, 429),
      },
    }),
  },
  '/api/auth/totp/confirm': {
    post: op({
      id: 'confirmSecondFactor',
      summary: 'Turn the second factor on with a first code',
      description: 'Answers the recovery codes, once.',
      tag: TAG,
      access: 'session',
      body: body(obj({ code: str('Six digits.') }, ['code'])),
      responses: {
        200: json(obj({ recoveryCodes: arrayOf(str()) }, ['recoveryCodes'])),
        ...errors(401, 403, 429),
      },
    }),
  },
  '/api/auth/totp/recovery-codes': {
    post: op({
      id: 'replaceRecoveryCodes',
      summary: 'Draw new recovery codes',
      description: 'The old ones stop working.',
      tag: TAG,
      access: 'session',
      body: body(obj({ password }, ['password'])),
      responses: {
        200: json(obj({ recoveryCodes: arrayOf(str()) }, ['recoveryCodes'])),
        ...errors(401, 403, 429),
      },
    }),
  },
  '/api/auth/passkeys': {
    get: op({
      id: 'listPasskeys',
      summary: 'The passkeys on this account',
      tag: TAG,
      access: 'session',
      responses: {
        200: json(obj({ passkeys: arrayOf(ref('Passkey')) }, ['passkeys'])),
        ...errors(401, 403),
      },
    }),
  },
  '/api/auth/passkeys/register/start': {
    post: op({
      id: 'startPasskeyRegistration',
      summary: 'Begin adding a passkey',
      description: 'From a session opened with the password.',
      tag: TAG,
      access: 'session',
      responses: { 200: json(ref('PasskeyOptions')), ...errors(401, 403, 429) },
    }),
  },
  '/api/auth/passkeys/register/finish': {
    post: op({
      id: 'finishPasskeyRegistration',
      summary: 'Keep the passkey the browser just made',
      tag: TAG,
      access: 'session',
      body: body(
        obj(
          {
            response: obj({}, [], {
              additionalProperties: true,
              description: 'What `navigator.credentials.create` returned.',
            }),
            name: str('What to call it.'),
          },
          ['response']
        )
      ),
      responses: {
        201: json(obj({ passkey: ref('Passkey') }, ['passkey']), 'Kept.'),
        ...errors(400, 401, 403, 429),
      },
    }),
  },
  '/api/auth/passkeys/{id}': {
    patch: op({
      id: 'renamePasskey',
      summary: 'Rename a passkey',
      tag: TAG,
      access: 'session',
      params: [pathParam('id', 'The passkey.')],
      body: body(obj({ name: str() }, ['name'])),
      responses: {
        200: json(obj({ passkey: ref('Passkey') }, ['passkey'])),
        ...errors(400, 401, 403, 404),
      },
    }),
    delete: op({
      id: 'removePasskey',
      summary: 'Remove a passkey',
      tag: TAG,
      access: 'session',
      params: [pathParam('id', 'The passkey.')],
      body: body(obj({ password }), {
        required: false,
        description: 'The password, when the account has one.',
      }),
      responses: { 204: noContent('Removed.'), ...errors(401, 403, 404, 429) },
    }),
  },
  '/api/auth/tokens': {
    get: op({
      id: 'listApiTokens',
      summary: 'The live API tokens of this account',
      tag: 'API tokens',
      access: 'session',
      responses: {
        200: json(obj({ tokens: arrayOf(ref('ApiToken')) }, ['tokens'])),
        ...errors(401, 403),
      },
    }),
    post: op({
      id: 'issueApiToken',
      summary: 'Issue an API token',
      description:
        'The only time `secret` exists: it is stored hashed. Fifty per account; asks for the password when the account has one.',
      tag: 'API tokens',
      access: 'session',
      body: body(
        obj(
          {
            name: str(),
            scope: str(null, { enum: ['read', 'write'], default: 'read' }),
            expiresInDays: nullable(
              int('Up to 3650; null for one that lasts until revoked.', {
                minimum: 1,
                maximum: 3650,
              })
            ),
            password,
          },
          ['name']
        )
      ),
      responses: {
        201: json(
          obj({ token: ref('ApiToken'), secret: str('`nxe_…`, shown this once.') }, [
            'token',
            'secret',
          ]),
          'Issued.'
        ),
        ...errors(400, 401, 403, 429),
      },
    }),
  },
  '/api/auth/tokens/{id}': {
    patch: op({
      id: 'renameApiToken',
      summary: 'Rename an API token',
      tag: 'API tokens',
      access: 'session',
      params: [pathParam('id', 'The token’s id, not its secret.')],
      body: body(obj({ name: str() }, ['name'])),
      responses: { 200: json(tokenAnswer), ...errors(400, 401, 403, 404) },
    }),
    delete: op({
      id: 'revokeApiToken',
      summary: 'Revoke an API token',
      description:
        'It stops working on the next request. Asks for nothing, so a leak can be stopped at once.',
      tag: 'API tokens',
      access: 'session',
      params: [pathParam('id', 'The token’s id, not its secret.')],
      responses: { 204: noContent('Revoked.'), ...errors(401, 403, 404) },
    }),
  },
  '/api/auth/oidc/login': {
    get: op({
      id: 'signInWithProvider',
      summary: 'Go to the identity provider',
      description:
        'A browser navigation, answered with a redirect; `404` where no provider is configured.',
      tag: TAG,
      access: 'public',
      params: [
        query('redirect', 'Where to land afterwards, inside this application.'),
        query('prompt', 'Passed on to the provider — `login`, `consent`, `select_account`.'),
      ],
      responses: {
        302: { description: 'To the provider.' },
        ...errors(400, 404, 502, 503),
      },
    }),
  },
  '/api/auth/oidc/mobile/login': {
    get: op({
      id: 'signInWithProviderFromApp',
      summary: 'Go to the identity provider, for the mobile application',
      description:
        'PKCE: the application later trades the code it receives at `POST /api/auth/oidc/exchange`.',
      tag: TAG,
      access: 'public',
      params: [
        query('code_challenge', 'S256 challenge.', { type: 'string' }, true),
        query('code_challenge_method', 'Only `S256`.', { type: 'string', enum: ['S256'] }),
        query('redirect_uri', 'One of `OIDC_MOBILE_REDIRECT_URIS`.'),
      ],
      responses: {
        302: { description: 'To the provider.' },
        ...errors(400, 404, 502, 503),
      },
    }),
  },
  '/api/auth/oidc/mobile/complete': {
    get: op({
      id: 'returnToApp',
      summary: 'Back from the provider, on the way to the mobile application',
      tag: TAG,
      access: 'public',
      responses: {
        302: { description: 'To the application’s redirect URI, with `code` or `error`.' },
        ...errors(400),
      },
    }),
  },
  '/api/auth/oidc/exchange': {
    post: op({
      id: 'exchangeMobileCode',
      summary: 'Trade the mobile application’s code for a session',
      tag: TAG,
      access: 'public',
      body: body(obj({ code: str(), code_verifier: str() }, ['code', 'code_verifier'])),
      responses: { 200: json(userAnswer, 'Signed in.'), ...errors(400, 401) },
    }),
  },
};
