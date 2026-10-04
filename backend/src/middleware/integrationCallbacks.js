/**
 * The paths an editor's server calls back on, which carry their own signed token
 * and are checked by the route.
 *
 * Open only while the integration is configured — otherwise they are
 * unauthenticated endpoints for no reason.
 *
 * A document inside a share is handed to the editing server under the share's own
 * prefix, because that server fetches it through the same front door the reader
 * came in by, and an authentication proxy lets a public link through by path. The
 * prefix is only where it is reachable: what authorises the fetch is the token in
 * the address, unchanged.
 */

const ONLYOFFICE = ['/api/onlyoffice/file', '/api/onlyoffice/callback'];
const COLLABORA = ['/api/collabora/wopi/'];

/** The same path, as a share's visitor reaches it. */
const withoutShareScope = (requestPath) =>
  requestPath.replace(/^\/api\/share\/[^/]+(?=\/)/, '/api');

const isConfiguredIntegrationCallback = (requestPath) => {
  try {
    const { onlyoffice, collabora } = require('../config/index');
    const path = withoutShareScope(String(requestPath || ''));

    if (onlyoffice?.serverUrl && ONLYOFFICE.some((one) => path.startsWith(one))) {
      return true;
    }

    if (collabora?.url && collabora?.secret && COLLABORA.some((one) => path.startsWith(one))) {
      return true;
    }
  } catch (_) {
    /* an integration that cannot be read about is an integration that is off */
  }

  return false;
};

module.exports = { isConfiguredIntegrationCallback };
