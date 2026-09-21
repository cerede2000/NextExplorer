const posix = require('path').posix;

const apiTokens = require('../services/apiTokens');
const { clientAddress } = require('../utils/clientAddress');
const logger = require('../utils/logger');

/**
 * Authenticating a request with an API token, and the two doors it never opens.
 *
 * A token is presented the way every HTTP credential is presented — an
 * `Authorization: Bearer` header — and deliberately nowhere else. Not a query
 * parameter, which lands in every access log and every browser history; not a
 * cookie, which a form on another site can make a browser send for you. This
 * application has no CSRF token: its defence is that the session cookie is
 * `SameSite=Lax` and that nothing else authenticates. Accepting a token from
 * anywhere a browser attaches automatically would take that defence away.
 *
 * Two doors stay shut whatever the token's scope:
 *
 * - **the account**, `/api/auth/*` — a token cannot change the password, add a
 *   passkey, take off the second factor, or mint another token. A credential
 *   that can issue credentials is one revocation that does not revoke;
 * - **administration** — every route behind `ensureAdmin`, and the terminal,
 *   which guards itself. An automation credential that can create an
 *   administrator is an automation credential that can take the server.
 *
 * Read `GET /api/auth/me` is the one thing left open behind the first door, so
 * a script can ask who it is without being able to change who it is.
 *
 * The live editors are shut for a third reason, and a smaller one: a token has
 * no browser, so it has no editing session — every route there either belongs
 * to one somebody else opened, or opens one nothing will ever use. A write
 * token holding a session identifier could end a colleague's editing session;
 * one calling `/config` could mark a document as being edited by a script that
 * is not editing it. Neither is a disaster, and neither is anything automation
 * wants: a script that needs the document downloads it and uploads it back.
 * The Document Server's own callbacks are not affected — they carry their own
 * signed token and never reach this file.
 */

/** What a token's value starts with, and therefore what this middleware owns. */
const TOKEN_MARKER = `${apiTokens.TOKEN_PREFIX}_`;

/** Methods that ask rather than change. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Shut to every token. */
const CLOSED_PREFIXES = ['/api/auth', '/api/terminal', '/api/onlyoffice', '/api/collabora'];

/** Except this, which only says who the caller is. */
const ALWAYS_OPEN = new Set(['/api/auth/me']);

/**
 * The reads that arrive as a POST.
 *
 * Downloading a selection sends the list of names in a body because a hundred
 * of them do not fit in a URL. It writes nothing, so refusing it to a
 * read-only token would be refusing a read — and an allowlist of one is easier
 * to keep honest than a rule about which POSTs are really reads.
 */
const READ_ONLY_POSTS = new Set(['/api/download']);

/**
 * Every way this path could be read, reduced to one spelling each.
 *
 * Express routes case-insensitively and forgives a trailing slash, so
 * `/API/Auth/tokens/` reaches the same handler `/api/auth/tokens` does — and a
 * door that compared the path as it arrived would have let it through. The
 * same goes for a percent-encoded letter and for a `..` that climbs back into
 * a place it was not supposed to reach.
 *
 * So the path is reduced rather than trusted: lower-cased, its repeated
 * slashes collapsed, its `..` resolved, and the same again after decoding.
 * Every form it could be read as goes into the list, and a door shuts when
 * *any* of them would open it. Fail-closed: a path this cannot make sense of
 * is refused rather than waved past.
 */
const readings = (value) => {
  const found = new Set();
  const raw = String(value || '');

  const add = (text) => {
    if (!text) return;
    const lowered = text.toLowerCase().replace(/\/{2,}/g, '/');
    const trimmed = lowered.length > 1 ? lowered.replace(/\/+$/, '') : lowered;
    found.add(trimmed);
    const resolved = posix.normalize(trimmed);
    found.add(resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved);
  };

  add(raw);
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) add(decoded);
  } catch {
    // A path that is not valid percent-encoding is one this cannot reduce, and
    // an unreadable path is not one to hold a door open for.
    found.add('/api/auth');
  }

  return [...found];
};

/**
 * A path that climbs.
 *
 * No endpoint here is reached by going up a level, so a `..` in a path — typed
 * or percent-encoded — is somebody reaching for somewhere else. Resolving it
 * is not enough: `/api/%2e%2e/auth/tokens` resolves to `/auth/tokens`, which
 * matches no closed prefix and would have been waved through on a server that
 * routed it. Refused as a shape rather than reasoned about.
 */
const climbs = (path) => path.split('/').includes('..');

const behindAClosedDoor = (paths) =>
  paths.some(
    (path) =>
      climbs(path) ||
      (!ALWAYS_OPEN.has(path) &&
        CLOSED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
  );

/**
 * Whether a token of this scope may make this request.
 *
 * @returns {{allowed: boolean, reason?: string}}
 */
const tokenMayReach = ({ path, method, scope }) => {
  const paths = readings(path);

  if (behindAClosedDoor(paths)) return { allowed: false, reason: 'closed-door' };

  if (scope !== 'read') return { allowed: true };
  if (SAFE_METHODS.has(String(method || '').toUpperCase())) return { allowed: true };
  if (
    String(method || '').toUpperCase() === 'POST' &&
    paths.every((candidate) => READ_ONLY_POSTS.has(candidate))
  ) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'read-only' };
};

/** The value presented, when the caller presented one of ours. */
const presentedToken = (req) => {
  const header = req?.headers?.authorization;
  const text = Array.isArray(header) ? header[0] : header;
  if (typeof text !== 'string') return null;
  const matched = /^Bearer[ \t]+(\S+)$/i.exec(text.trim());
  if (!matched) return null;
  // Anything that is not one of ours is left alone: the editors' integrations
  // send their own bearer JWTs through the same header, and a token that does
  // not start with our marker is not a token this file has an opinion about.
  return matched[1].startsWith(TOKEN_MARKER) ? matched[1] : null;
};

/**
 * Authenticate this request with the token it presented, if it presented one.
 *
 * @returns {Promise<null | {ok: true, token: object} | {ok: false, status: number,
 *   error: string, code: string, refused: object}>}
 *   null when no token of ours was presented and the request is somebody else's
 *   business.
 */
const applyApiToken = async (req) => {
  const presented = presentedToken(req);
  if (!presented) return null;

  const outcome = await apiTokens.authenticateToken(presented);

  if (!outcome.ok) {
    // One refusal for all four reasons. Which of them it was is written down
    // where an administrator can read it, and never answered to whoever asked:
    // "that token was revoked" tells somebody holding a stolen value that they
    // have the right server and the wrong moment.
    return {
      ok: false,
      status: 401,
      error: 'That API token is not valid.',
      code: 'AUTH_TOKEN_INVALID',
      refused: outcome,
    };
  }

  const allowed = tokenMayReach({ path: req.path || '', method: req.method, scope: outcome.scope });
  if (!allowed.allowed) {
    return {
      ok: false,
      status: 403,
      error:
        allowed.reason === 'closed-door'
          ? 'An API token cannot be used for the account or for administration.'
          : 'This API token may only read.',
      code: allowed.reason === 'closed-door' ? 'AUTH_TOKEN_NOT_ALLOWED' : 'AUTH_TOKEN_READ_ONLY',
      refused: { reason: allowed.reason, tokenId: outcome.tokenId, name: outcome.name },
      token: outcome,
    };
  }

  // Recorded after the request was allowed, not before: a token refused at the
  // door was not used, and a "last used" that moves on refusals hides the day
  // it was really last used by something that worked.
  apiTokens
    .noteUse({ tokenId: outcome.tokenId, address: clientAddress(req) })
    .catch((error) => logger.debug({ err: error }, 'Could not record an API token use'));

  return { ok: true, token: outcome };
};

module.exports = {
  ALWAYS_OPEN,
  CLOSED_PREFIXES,
  READ_ONLY_POSTS,
  SAFE_METHODS,
  applyApiToken,
  presentedToken,
  readings,
  tokenMayReach,
};
