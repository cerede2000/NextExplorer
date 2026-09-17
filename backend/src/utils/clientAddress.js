const logger = require('./logger');

/**
 * The address a request came from — the one worth writing down.
 *
 * Express already works out `req.ip`: the socket's peer, or the client named
 * by the chain of proxies when `trust proxy` says those proxies may be
 * believed. Two things it does not do, and both end up in a log somebody
 * reads:
 *
 * - an IPv4 client on a dual-stack socket arrives as `::ffff:192.168.1.7`,
 *   which is the same address wearing a costume;
 * - a proxy that announces the client in `X-Real-IP` and nothing else — which
 *   is what nginx's own example configuration does — is not read at all, so
 *   every line names the proxy instead of the person.
 *
 * What a proxy says is believed only when `trust proxy` says that peer may be
 * believed. Without that rule anybody on the network could choose what the log
 * says about them, and a log that can be written by the people in it is worse
 * than one that names the proxy.
 */

/** Headers a proxy uses to name the client it is speaking for. */
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded'];

/** `::ffff:192.168.1.7` is 192.168.1.7 in a dual-stack coat. */
const unmask = (value) => {
  const text = String(value).trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  return mapped ? mapped[1] : text;
};

const normalizeAddress = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = unmask(value);
  return text.length > 0 && text.length <= 100 ? text : null;
};

/** A header may arrive more than once; the first value is the one meant. */
const firstValue = (value) => {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' ? text.split(',')[0].trim() : null;
};

/**
 * Whether the machine at the other end of the socket is one this server was
 * told to believe. Express keeps the rule it compiled from `trust proxy`.
 */
const peerIsTrusted = (req) => {
  const decide = req?.app?.get?.('trust proxy fn');
  const peer = req?.socket?.remoteAddress;
  if (typeof decide !== 'function' || !peer) return false;
  try {
    return decide(peer, 0) === true;
  } catch {
    return false;
  }
};

/** A proxy is speaking for somebody, whether or not anybody is listening. */
const hasForwarding = (req) =>
  FORWARDING_HEADERS.some((name) => Boolean(firstValue(req?.headers?.[name])));

const clientAddress = (req) => {
  const peer = normalizeAddress(req?.socket?.remoteAddress);
  const resolved = normalizeAddress(req?.ip);

  if (!peerIsTrusted(req)) return resolved || peer;
  // Express read `X-Forwarded-For` for us when there was one to read.
  if (resolved && resolved !== peer) return resolved;
  return normalizeAddress(firstValue(req?.headers?.['x-real-ip'])) || resolved || peer;
};

/**
 * Say once that a proxy is being ignored.
 *
 * The failure this prevents is a quiet one: every line of the log names the
 * same address — the proxy's, or the Docker bridge's — and nothing anywhere
 * says why, so the log looks broken rather than misconfigured.
 */
let alreadySaid = false;

const forgetForwardingWarning = () => {
  alreadySaid = false;
};

const warnAboutIgnoredForwarding = (req) => {
  if (alreadySaid || !hasForwarding(req) || peerIsTrusted(req)) return null;
  alreadySaid = true;
  const details = {
    announced: normalizeAddress(
      firstValue(req?.headers?.['x-forwarded-for'] ?? req?.headers?.['x-real-ip'])
    ),
    recorded: clientAddress(req),
    hint: 'Set TRUST_PROXY (for example TRUST_PROXY=loopback,uniquelocal) so the address recorded is the one of the person rather than of the proxy.',
  };
  logger.warn(
    details,
    'A proxy is announcing a client address and this server is not believing it'
  );
  // Handed back rather than only logged, so what was said can be read at the
  // layer it was decided, instead of through a spy on the logger.
  return details;
};

const forwardedAddressWarning = (req, _res, next) => {
  warnAboutIgnoredForwarding(req);
  next();
};

module.exports = {
  clientAddress,
  forgetForwardingWarning,
  forwardedAddressWarning,
  hasForwarding,
  normalizeAddress,
  peerIsTrusted,
  warnAboutIgnoredForwarding,
};
