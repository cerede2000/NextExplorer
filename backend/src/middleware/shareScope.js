const asyncHandler = require('../utils/asyncHandler');
const { ForbiddenError, NotFoundError, UnauthorizedError } = require('../errors/AppError');
const { getShareByToken, isShareExpired } = require('../services/sharesService');

/**
 * The door in front of `/api/share/<token>/…`, where a visitor's whole visit now
 * happens.
 *
 * Everything somebody with no account asks for — the listing, a file read in the
 * viewer, a thumbnail, a download, an office document — was answered at the
 * address the signed-in application uses: `/api/preview`, `/api/download`,
 * `/api/thumbnails/…`. Each of those checks the share for itself, so none of it
 * was ever open; but anybody putting an authentication proxy in front of this had
 * to name half the API to let a public link through, and naming `/api/download`
 * in front of a proxy means naming it for everyone, which is a hole nobody wants.
 * So the same handlers also answer under the share's own prefix, and this is what
 * stands in front of them.
 *
 * The rule it enforces, and the reason this is safe: **the prefix adds a
 * requirement and removes none.** Reaching a handler here means satisfying this
 * gate *and* then the handler's own access check, unchanged — the same
 * `resolvePathWithAccess` on the same logical path with the same caller. Nothing
 * is reachable through `/api/share/<token>/…` that the same caller could not
 * already reach at the handler's own address.
 */
const requireShareScope = asyncHandler(async (req, _res, next) => {
  const token = req.params.shareToken;
  const share = token ? await getShareByToken(token) : null;

  if (!share) throw new NotFoundError('Share not found');
  if (isShareExpired(share)) throw new ForbiddenError('Share has expired');

  // Never anonymous. The endpoints behind this prefix are the application's own,
  // and the door of a share — what it is, its password, the session typing it
  // earns — is elsewhere.
  if (!req.user && !req.guestSession) {
    throw new UnauthorizedError('Share access required');
  }

  // A guest session is issued for one share and is good for that one. Without
  // this, the prefix of a share anybody may open would be a way to carry a
  // session to the prefix of a share they may not.
  if (!req.user && String(req.guestSession.shareId) !== String(share.id)) {
    throw new ForbiddenError('Invalid guest session for this share');
  }

  req.shareScope = { token: share.shareToken, shareId: share.id };
  next();
});

module.exports = { requireShareScope };
