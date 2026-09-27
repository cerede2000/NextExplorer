const crypto = require('node:crypto');

/**
 * An authenticator made of software, for the tests.
 *
 * It writes what a real one writes — the CBOR, the authenticator data, the
 * signature over both halves — with an encoder of its own, written from the
 * format rather than from the reader it is used to test. A test that encoded
 * with the production code would only prove the reader agrees with the writer
 * beside it; this one can disagree, which is the point.
 */

const encode = (value) => {
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('This writes whole numbers only.');
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (Array.isArray(value)) {
    return Buffer.concat([head(4, value.length), ...value.map(encode)]);
  }
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [key, item] of value) parts.push(encode(key), encode(item));
    return Buffer.concat(parts);
  }
  throw new Error(`Nothing here writes ${typeof value}.`);
};

const head = (major, argument) => {
  const prefix = major << 5;
  if (argument < 24) return Buffer.from([prefix | argument]);
  if (argument < 0x100) return Buffer.from([prefix | 24, argument]);
  if (argument < 0x10000) {
    const buffer = Buffer.alloc(3);
    buffer.writeUInt8(prefix | 25, 0);
    buffer.writeUInt16BE(argument, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(5);
  buffer.writeUInt8(prefix | 26, 0);
  buffer.writeUInt32BE(argument, 1);
  return buffer;
};

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64u = (value) => Buffer.from(value, 'base64url');

const ALGORITHMS = {
  ES256: -7,
  EdDSA: -8,
  RS256: -257,
};

const generateKeyPair = (algorithm) => {
  if (algorithm === ALGORITHMS.ES256) {
    return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  }
  if (algorithm === ALGORITHMS.EdDSA) return crypto.generateKeyPairSync('ed25519');
  if (algorithm === ALGORITHMS.RS256) {
    return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  }
  throw new Error(`No key for algorithm ${algorithm}.`);
};

/** The public half, as a COSE key (RFC 9052). */
const coseKey = (publicKey, algorithm) => {
  const jwk = publicKey.export({ format: 'jwk' });
  if (algorithm === ALGORITHMS.ES256) {
    return new Map([
      [1, 2],
      [3, algorithm],
      [-1, 1],
      [-2, fromB64u(jwk.x)],
      [-3, fromB64u(jwk.y)],
    ]);
  }
  if (algorithm === ALGORITHMS.EdDSA) {
    return new Map([
      [1, 1],
      [3, algorithm],
      [-1, 6],
      [-2, fromB64u(jwk.x)],
    ]);
  }
  return new Map([
    [1, 3],
    [3, algorithm],
    [-1, fromB64u(jwk.n)],
    [-2, fromB64u(jwk.e)],
  ]);
};

const FLAGS = {
  userPresent: 0x01,
  userVerified: 0x04,
  backedUp: 0x10,
  attestedCredential: 0x40,
  extensionData: 0x80,
};

const authenticatorData = ({
  rpId,
  flags,
  signCount = 0,
  aaguid = null,
  credentialId = null,
  publicKey = null,
  extensions = null,
}) => {
  const parts = [crypto.createHash('sha256').update(rpId, 'utf8').digest(), Buffer.from([flags])];
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount);
  parts.push(counter);

  if (credentialId) {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length);
    parts.push(aaguid || Buffer.alloc(16), length, credentialId, encode(publicKey));
  }
  if (extensions) parts.push(encode(extensions));
  return Buffer.concat(parts);
};

const clientData = ({ type, challenge, origin, crossOrigin = false }) =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin }), 'utf8');

/**
 * Make a passkey, the way a browser would hand one over.
 *
 * @returns what the registration route receives, plus the key to sign with later.
 */
const createCredential = ({
  rpId = 'files.example.com',
  origin = 'https://files.example.com',
  challenge,
  algorithm = ALGORITHMS.ES256,
  userVerified = true,
  signCount = 0,
  format = 'none',
  credentialId = crypto.randomBytes(32),
  aaguid = Buffer.alloc(16),
  flags = null,
} = {}) => {
  const { publicKey, privateKey } = generateKeyPair(algorithm);
  const key = coseKey(publicKey, algorithm);
  const bits =
    flags ?? FLAGS.userPresent | FLAGS.attestedCredential | (userVerified ? FLAGS.userVerified : 0);

  const authData = authenticatorData({
    rpId,
    flags: bits,
    signCount,
    aaguid,
    credentialId,
    publicKey: key,
  });

  return {
    credentialId,
    privateKey,
    algorithm,
    coseKey: encode(key),
    attestationObject: encode(
      new Map([
        ['fmt', format],
        ['attStmt', new Map()],
        ['authData', authData],
      ])
    ),
    clientDataJSON: clientData({ type: 'webauthn.create', challenge, origin }),
  };
};

/** Sign in with a passkey already made. */
const signAssertion = ({
  credential,
  rpId = 'files.example.com',
  origin = 'https://files.example.com',
  challenge,
  signCount = 1,
  userVerified = true,
  crossOrigin = false,
  type = 'webauthn.get',
  flags = null,
}) => {
  const bits = flags ?? FLAGS.userPresent | (userVerified ? FLAGS.userVerified : 0);
  const authData = authenticatorData({ rpId, flags: bits, signCount });
  const clientDataJSON = clientData({ type, challenge, origin, crossOrigin });
  const signedData = Buffer.concat([
    authData,
    crypto.createHash('sha256').update(clientDataJSON).digest(),
  ]);
  const signature =
    credential.algorithm === ALGORITHMS.EdDSA
      ? crypto.sign(null, signedData, credential.privateKey)
      : crypto.sign('sha256', signedData, credential.privateKey);

  return { authenticatorData: authData, clientDataJSON, signature };
};

module.exports = {
  ALGORITHMS,
  FLAGS,
  authenticatorData,
  b64u,
  clientData,
  coseKey,
  createCredential,
  encode,
  signAssertion,
};
