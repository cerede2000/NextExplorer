const { ForbiddenError } = require('../errors/AppError');

/**
 * Allow only administrators past this point.
 *
 * Several route files carried their own copy of this check, which is how
 * /permissions/chmod and /permissions/chown ended up with none at all.
 */
const ensureAdmin = (req, _res, next) => {
  // An API token never administers the server, whoever it belongs to and
  // whatever scope it carries. Checked here rather than against a list of
  // paths because this is the one place every administrative route already
  // passes through — a route added tomorrow is covered without anybody
  // remembering to add it anywhere.
  if (req.apiToken) {
    throw new ForbiddenError('An API token cannot be used for administration.');
  }

  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  if (!roles.includes('admin')) {
    throw new ForbiddenError('Admin access required.');
  }
  next();
};

module.exports = { ensureAdmin };
