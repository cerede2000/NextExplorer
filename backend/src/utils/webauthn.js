const crypto = require('crypto');

const { decode, decodeFirst } = require('./cbor');

/**
 * What a passkey proves, and what has to be checked before believing it.
 *
 * WebAuthn is a signature over two things the server chose: a challenge it
 * drew a moment ago, and the name of the site asking. That is the whole of the
 * phishing resistance — a signature made for another site carries another
 * site's name and does not verify here — so the checks below are not
 * formalities to be relaxed when something does not work. They are the
 * feature.
 *
 * Attestation is deliberately not verified. It says which company made the
 * authenticator, which is a question a file server has no business asking; the
 * browser is asked for `none`, and what arrives is read for its authenticator
 * data and nothing else. Nothing in an attestation statement is trusted here,
 * so nothing in it can lie to us.
 *
 * Reading order follows §7.1 and §7.2 of the Web Authentication standard.
 */

class WebAuthnError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebAuthnError';
  }
}

/** Flags in the authenticator data byte. */
const FLAG = {
  USER_PRESENT: 0x01,
  USER_VERIFIED: 0x04,
  BACKUP_ELIGIBLE: 0x08,
  BACKED_UP: 0x10,
  ATTESTED_CREDENTIAL: 0x40,
  EXTENSION_DATA: 0x80,
};

/** The algorithms this offers, most preferred first. */
const ES256 = -7;
const EDDSA = -8;
const RS256 = -257;
const SUPPORTED_ALGORITHMS = [ES256, EDDSA, RS256];

/** A credential id is at most 1023 bytes (§6.5.1). */
const MAX_CREDENTIAL_ID_BYTES = 1023;

/** Client data is a small JSON document; anything larger is not one. */
const MAX_CLIENT_DATA_BYTES = 8 * 1024;

const toBase64Url = (bytes) => Buffer.from(bytes).toString('base64url');

/**
 * Bytes from base64url, refusing anything that is not exactly that.
 *
 * Buffer's decoder ignores what it does not understand, so `"!!!!"` would
 * arrive as an empty credential id rather than as an error.
 */
const fromBase64Url = (value, what = 'value') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new WebAuthnError(`The ${what} is not base64url.`);
  }
  return Buffer.from(value, 'base64url');
};

/** Equal, without saying where they stopped being equal. */
const sameBytes = (a, b) =>
  a.length === b.length && crypto.timingSafeEqual(Uint8Array.from(a), Uint8Array.from(b));

/** A challenge: thirty-two bytes nobody can guess, spent once. */
const randomChallenge = () => crypto.randomBytes(32).toString('base64url');

const rpIdHash = (rpId) => crypto.createHash('sha256').update(String(rpId), 'utf8').digest();

/**
 * The authenticator's own account of what happened, byte by byte (§6.1).
 *
 * The public key sits at the end, so the credential and the extensions after
 * it are only reachable by reading it — which is why the reader reports where
 * the value ended.
 */
const parseAuthenticatorData = (data) => {
  if (!Buffer.isBuffer(data) || data.length < 37) {
    throw new WebAuthnError('The authenticator data is too short to be authenticator data.');
  }
  const flags = data.readUInt8(32);
  const parsed = {
    rpIdHash: data.subarray(0, 32),
    flagBits: flags,
    flags: {
      userPresent: Boolean(flags & FLAG.USER_PRESENT),
      userVerified: Boolean(flags & FLAG.USER_VERIFIED),
      backupEligible: Boolean(flags & FLAG.BACKUP_ELIGIBLE),
      backedUp: Boolean(flags & FLAG.BACKED_UP),
      attestedCredential: Boolean(flags & FLAG.ATTESTED_CREDENTIAL),
      extensionData: Boolean(flags & FLAG.EXTENSION_DATA),
    },
    signCount: data.readUInt32BE(33),
    aaguid: null,
    credentialId: null,
    credentialPublicKey: null,
  };

  if (!parsed.flags.attestedCredential) return parsed;

  if (data.length < 55) {
    throw new WebAuthnError('The authenticator data promises a credential it does not carry.');
  }
  const idLength = data.readUInt16BE(53);
  if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES) {
    throw new WebAuthnError('The credential id is not a credential id.');
  }
  if (data.length < 55 + idLength) {
    throw new WebAuthnError('The authenticator data ends inside the credential id.');
  }

  parsed.aaguid = Buffer.from(data.subarray(37, 53));
  parsed.credentialId = Buffer.from(data.subarray(55, 55 + idLength));

  const keyStart = 55 + idLength;
  const { value, bytesRead } = decodeFirst(data.subarray(keyStart));
  if (!(value instanceof Map)) {
    throw new WebAuthnError('The public key is not a COSE key.');
  }
  parsed.credentialPublicKey = Buffer.from(data.subarray(keyStart, keyStart + bytesRead));
  parsed.coseKey = value;

  // Anything after the key is extension data, and only if the flag says so.
  const trailing = data.length - (keyStart + bytesRead);
  if (trailing > 0 && !parsed.flags.extensionData) {
    throw new WebAuthnError('The authenticator data carries bytes it did not declare.');
  }
  return parsed;
};

/**
 * A COSE key (RFC 9052) as something node can verify with.
 *
 * Node reads JWK, and the distance from one to the other is a rename: the
 * labels are integers instead of names, and the numbers are bytes instead of
 * base64url. Three algorithms are offered and three are accepted — a key
 * arriving under a fourth is refused rather than verified with a guess.
 */
const publicKeyFromCose = (coseKey) => {
  const map = coseKey instanceof Map ? coseKey : decode(coseKey);
  if (!(map instanceof Map)) throw new WebAuthnError('The public key is not a COSE key.');

  const kty = map.get(1);
  const algorithm = map.get(3);
  if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
    throw new WebAuthnError(`This key signs with an algorithm this server does not accept.`);
  }

  const bytes = (label, what) => {
    const value = map.get(label);
    if (!Buffer.isBuffer(value) || value.length === 0) {
      throw new WebAuthnError(`The public key has no ${what}.`);
    }
    return value;
  };

  // EC2, on the curve ES256 is defined over.
  if (kty === 2 && algorithm === ES256) {
    if (map.get(-1) !== 1)
      throw new WebAuthnError('ES256 keys sit on P-256 and this one does not.');
    return {
      algorithm,
      key: crypto.createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: toBase64Url(bytes(-2, 'x coordinate')),
          y: toBase64Url(bytes(-3, 'y coordinate')),
        },
        format: 'jwk',
      }),
    };
  }

  // OKP, Ed25519.
  if (kty === 1 && algorithm === EDDSA) {
    if (map.get(-1) !== 6)
      throw new WebAuthnError('The only EdDSA curve accepted here is Ed25519.');
    return {
      algorithm,
      key: crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(bytes(-2, 'public point')) },
        format: 'jwk',
      }),
    };
  }

  // RSA.
  if (kty === 3 && algorithm === RS256) {
    return {
      algorithm,
      key: crypto.createPublicKey({
        key: {
          kty: 'RSA',
          n: toBase64Url(bytes(-1, 'modulus')),
          e: toBase64Url(bytes(-2, 'exponent')),
        },
        format: 'jwk',
      }),
    };
  }

  throw new WebAuthnError('The key type and the algorithm it claims do not go together.');
};

const verifySignature = ({ algorithm, key }, signedData, signature) => {
  if (algorithm === EDDSA) return crypto.verify(null, signedData, key, signature);
  return crypto.verify('sha256', signedData, key, signature);
};

/**
 * The client's account of what it was asked (§7.1 step 5 onwards).
 *
 * The origin is compared whole. A prefix test would accept
 * `https://example.com.attacker.example`, which is the shape of the attack
 * this protocol exists to stop.
 */
const readClientData = ({ clientDataJSON, expectedType, expectedChallenge, expectedOrigins }) => {
  if (!Buffer.isBuffer(clientDataJSON) || clientDataJSON.length === 0) {
    throw new WebAuthnError('The client data is missing.');
  }
  if (clientDataJSON.length > MAX_CLIENT_DATA_BYTES) {
    throw new WebAuthnError('The client data is too large to be client data.');
  }

  let clientData;
  try {
    clientData = JSON.parse(clientDataJSON.toString('utf8'));
  } catch (_) {
    throw new WebAuthnError('The client data is not JSON.');
  }
  if (!clientData || typeof clientData !== 'object') {
    throw new WebAuthnError('The client data is not an object.');
  }
  if (clientData.type !== expectedType) {
    throw new WebAuthnError('This answer was made for a different kind of request.');
  }
  if (clientData.crossOrigin === true) {
    throw new WebAuthnError('A passkey is not used from inside another site’s page here.');
  }

  const challenge = fromBase64Url(String(clientData.challenge || ''), 'challenge');
  if (!sameBytes(challenge, fromBase64Url(expectedChallenge, 'challenge'))) {
    throw new WebAuthnError('That answer was made for a different question.');
  }

  const origins = Array.isArray(expectedOrigins) ? expectedOrigins : [expectedOrigins];
  if (!origins.some((origin) => origin && origin === clientData.origin)) {
    throw new WebAuthnError(
      `This passkey was used on ${clientData.origin || 'nowhere'}, not here.`
    );
  }

  return clientData;
};

const checkAuthenticatorData = (authenticatorData, { expectedRpId, requireUserVerification }) => {
  const parsed = parseAuthenticatorData(authenticatorData);
  if (!sameBytes(parsed.rpIdHash, rpIdHash(expectedRpId))) {
    throw new WebAuthnError('This passkey belongs to another site.');
  }
  if (!parsed.flags.userPresent) {
    throw new WebAuthnError('Nobody was there: the authenticator reported no user.');
  }
  if (requireUserVerification && !parsed.flags.userVerified) {
    throw new WebAuthnError('This passkey was not unlocked, and this server asks that it is.');
  }
  return parsed;
};

/**
 * A new passkey (§7.1).
 *
 * What comes back is what gets stored: the credential id it will be found by,
 * the public key its signatures are checked against, and the counter its next
 * signature has to beat.
 */
const verifyRegistration = ({
  attestationObject,
  clientDataJSON,
  expectedChallenge,
  expectedOrigins,
  expectedRpId,
  requireUserVerification = false,
}) => {
  readClientData({
    clientDataJSON,
    expectedType: 'webauthn.create',
    expectedChallenge,
    expectedOrigins,
  });

  if (!Buffer.isBuffer(attestationObject) || attestationObject.length === 0) {
    throw new WebAuthnError('The attestation object is missing.');
  }
  const attestation = decode(attestationObject);
  if (!(attestation instanceof Map)) {
    throw new WebAuthnError('The attestation object is not an attestation object.');
  }
  const authenticatorData = attestation.get('authData');
  if (!Buffer.isBuffer(authenticatorData)) {
    throw new WebAuthnError('The attestation object carries no authenticator data.');
  }

  const parsed = checkAuthenticatorData(authenticatorData, {
    expectedRpId,
    requireUserVerification,
  });
  if (!parsed.flags.attestedCredential || !parsed.credentialId) {
    throw new WebAuthnError('The authenticator returned no credential to remember.');
  }

  // Read it now rather than at the first sign-in: a key this server cannot
  // verify with is a passkey that would be saved and then never work.
  publicKeyFromCose(parsed.coseKey);

  return {
    credentialId: parsed.credentialId,
    credentialPublicKey: parsed.credentialPublicKey,
    signCount: parsed.signCount,
    aaguid: parsed.aaguid,
    userVerified: parsed.flags.userVerified,
    backedUp: parsed.flags.backedUp,
    format: typeof attestation.get('fmt') === 'string' ? attestation.get('fmt') : null,
  };
};

/**
 * A sign-in with a passkey already known (§7.2).
 *
 * The counter is the clone check. Authenticators that keep one increase it
 * every time; a signature carrying a count that has been seen before is either
 * a replay or a second copy of a key that should only exist once, and both are
 * refusals. Passkeys synchronised between devices report zero and always will,
 * which is why zero on both sides is left alone.
 */
const verifyAssertion = ({
  authenticatorData,
  clientDataJSON,
  signature,
  credentialPublicKey,
  storedSignCount = 0,
  expectedChallenge,
  expectedOrigins,
  expectedRpId,
  requireUserVerification = false,
}) => {
  const clientData = readClientData({
    clientDataJSON,
    expectedType: 'webauthn.get',
    expectedChallenge,
    expectedOrigins,
  });

  const parsed = checkAuthenticatorData(authenticatorData, {
    expectedRpId,
    requireUserVerification,
  });

  if (!Buffer.isBuffer(signature) || signature.length === 0) {
    throw new WebAuthnError('The signature is missing.');
  }

  const key = publicKeyFromCose(credentialPublicKey);
  const signedData = Buffer.concat([
    authenticatorData,
    crypto.createHash('sha256').update(clientDataJSON).digest(),
  ]);
  let verified;
  try {
    verified = verifySignature(key, signedData, signature);
  } catch (_) {
    verified = false;
  }
  if (!verified) throw new WebAuthnError('That signature does not match this passkey.');

  const stored = Number(storedSignCount) || 0;
  if ((parsed.signCount > 0 || stored > 0) && parsed.signCount <= stored) {
    throw new WebAuthnError('This passkey has been used before with that counter.');
  }

  return {
    signCount: parsed.signCount,
    userVerified: parsed.flags.userVerified,
    backedUp: parsed.flags.backedUp,
    origin: clientData.origin,
  };
};

module.exports = {
  ES256,
  EDDSA,
  RS256,
  SUPPORTED_ALGORITHMS,
  WebAuthnError,
  fromBase64Url,
  parseAuthenticatorData,
  publicKeyFromCose,
  randomChallenge,
  rpIdHash,
  toBase64Url,
  verifyAssertion,
  verifyRegistration,
};
