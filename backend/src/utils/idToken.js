/**
 * The claims inside an id token, read without checking its signature.
 *
 * Every caller here reads a token this server has already accepted: the
 * library verifies the signature and the nonce before the after-callback
 * handler is handed the session, and nothing but this server writes into
 * sessions.db. So this answers "who does this token say it is", never "is this
 * token genuine" — a token arriving from outside must be verified first.
 *
 * Anything that is not a JWT, or whose payload is not an object, names nobody.
 *
 * @param {unknown} idToken
 * @returns {Record<string, unknown>|null}
 */
const readIdTokenClaims = (idToken) => {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

module.exports = { readIdTokenClaims };
