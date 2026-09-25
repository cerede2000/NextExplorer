/**
 * Start a fresh session for a newly authenticated user.
 *
 * Reusing the pre-login session id would let an attacker who managed to plant
 * a known id in the victim's browser keep using it once they sign in
 * (session fixation). Regenerating gives the authenticated user a new id.
 */
const startAuthenticatedSession = (req, userId) =>
  new Promise((resolve, reject) => {
    if (!req.session) {
      resolve();
      return;
    }
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }
      req.session.localUserId = userId;
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });

module.exports = { startAuthenticatedSession };
