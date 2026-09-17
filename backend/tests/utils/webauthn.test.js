import { describe, expect, it } from 'vitest';

const crypto = require('node:crypto');

const {
  ALGORITHMS,
  FLAGS,
  authenticatorData,
  createCredential,
  encode,
  signAssertion,
} = require('../helpers/soft-authenticator');
const {
  WebAuthnError,
  parseAuthenticatorData,
  publicKeyFromCose,
  randomChallenge,
  verifyAssertion,
  verifyRegistration,
} = require('../../src/utils/webauthn');

/**
 * What a passkey has to prove before it opens anything.
 *
 * The signature is made here by an authenticator written from the format
 * (tests/helpers/soft-authenticator.js), so the checks can be taken apart one
 * at a time: change the site, the question, the counter or one byte of what
 * was signed, and see the refusal that belongs to it. Every refusal below is a
 * way into somebody's files if it is ever relaxed.
 */

const RP_ID = 'files.example.com';
const ORIGIN = 'https://files.example.com';

const register = (options = {}) => {
  const challenge = options.challenge || randomChallenge();
  const credential = createCredential({ challenge, ...options });
  const registration = verifyRegistration({
    attestationObject: credential.attestationObject,
    clientDataJSON: credential.clientDataJSON,
    expectedChallenge: challenge,
    expectedOrigins: [ORIGIN],
    expectedRpId: RP_ID,
    ...(options.verify || {}),
  });
  return { credential, registration, challenge };
};

const signIn = ({ credential, registration, ...options }) => {
  const challenge = options.challenge || randomChallenge();
  const assertion = signAssertion({ credential, challenge, signCount: 1, ...options });
  return verifyAssertion({
    ...assertion,
    credentialPublicKey: registration.credentialPublicKey,
    storedSignCount: registration.signCount,
    expectedChallenge: challenge,
    expectedOrigins: [ORIGIN],
    expectedRpId: RP_ID,
    ...(options.verify || {}),
  });
};

describe('registering a passkey', () => {
  it('keeps the credential, the key and the counter', () => {
    const { credential, registration } = register({ signCount: 7 });

    expect(registration.credentialId.equals(credential.credentialId)).toBe(true);
    expect(registration.credentialPublicKey.equals(credential.coseKey)).toBe(true);
    expect(registration).toMatchObject({ signCount: 7, userVerified: true, format: 'none' });
  });

  it.each([['ES256'], ['EdDSA'], ['RS256']])('accepts a %s key, and verifies with it', (name) => {
    const algorithm = ALGORITHMS[name];
    const { credential, registration } = register({ algorithm });

    expect(signIn({ credential, registration })).toMatchObject({ signCount: 1 });
  });

  it('refuses an answer to a different question', () => {
    const credential = createCredential({ challenge: randomChallenge() });

    expect(() =>
      verifyRegistration({
        attestationObject: credential.attestationObject,
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: randomChallenge(),
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/different question/);
  });

  it('refuses a passkey made on another site', () => {
    const challenge = randomChallenge();
    const credential = createCredential({
      challenge,
      origin: 'https://files.example.com.evil.test',
    });

    expect(() =>
      verifyRegistration({
        attestationObject: credential.attestationObject,
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/not here/);
  });

  it('refuses a name that merely starts the same', () => {
    const challenge = randomChallenge();
    const credential = createCredential({ challenge, rpId: 'files.example.com.evil.test' });

    expect(() =>
      verifyRegistration({
        attestationObject: credential.attestationObject,
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/another site/);
  });

  it('refuses one made inside another site’s page', () => {
    const challenge = randomChallenge();
    const credential = createCredential({ challenge });
    credential.clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: true })
    );

    expect(() =>
      verifyRegistration({
        attestationObject: credential.attestationObject,
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/another site’s page/);
  });

  it('refuses a sign-in answer offered as a registration', () => {
    const challenge = randomChallenge();
    const credential = createCredential({ challenge });
    credential.clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN })
    );

    expect(() =>
      verifyRegistration({
        attestationObject: credential.attestationObject,
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/different kind of request/);
  });

  it('refuses one nobody touched', () => {
    const challenge = randomChallenge();
    const credential = createCredential({
      challenge,
      flags: FLAGS.attestedCredential,
    });

    expect(() =>
      verifyRegistration({
        attestationObject: credential.attestationObject,
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/Nobody was there/);
  });

  it('refuses an unlocked-only server a passkey that was not unlocked', () => {
    const challenge = randomChallenge();
    const credential = createCredential({ challenge, userVerified: false });

    expect(() =>
      verifyRegistration({
        attestationObject: credential.attestationObject,
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
        requireUserVerification: true,
      })
    ).toThrow(/not unlocked/);
  });

  it('refuses an attestation object with no authenticator data', () => {
    const challenge = randomChallenge();
    const credential = createCredential({ challenge });

    expect(() =>
      verifyRegistration({
        attestationObject: encode(new Map([['fmt', 'none']])),
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/no authenticator data/);
  });

  it('refuses a key it could never verify with', () => {
    const challenge = randomChallenge();
    const credential = createCredential({ challenge });
    // An ES256 key relabelled as an algorithm this server does not accept.
    const authData = authenticatorData({
      rpId: RP_ID,
      flags: FLAGS.userPresent | FLAGS.userVerified | FLAGS.attestedCredential,
      credentialId: credential.credentialId,
      publicKey: new Map([
        [1, 2],
        [3, -36],
        [-1, 1],
        [-2, Buffer.alloc(32, 1)],
        [-3, Buffer.alloc(32, 2)],
      ]),
    });

    expect(() =>
      verifyRegistration({
        attestationObject: encode(
          new Map([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData],
          ])
        ),
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/does not accept/);
  });

  it('takes the passkey when more than one origin is allowed', () => {
    const challenge = randomChallenge();
    const credential = createCredential({ challenge, origin: 'http://localhost:3000' });

    expect(
      verifyRegistration({
        attestationObject: credential.attestationObject,
        clientDataJSON: credential.clientDataJSON,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN, 'http://localhost:3000'],
        expectedRpId: RP_ID,
      }).credentialId.equals(credential.credentialId)
    ).toBe(true);
  });
});

describe('signing in with one', () => {
  it('accepts the signature, and reports the counter it carried', () => {
    const { credential, registration } = register();

    expect(signIn({ credential, registration, signCount: 42 })).toMatchObject({
      signCount: 42,
      userVerified: true,
      origin: ORIGIN,
    });
  });

  it('refuses a signature over something else', () => {
    const { credential, registration } = register();
    const challenge = randomChallenge();
    const assertion = signAssertion({ credential, challenge, signCount: 3 });
    // One byte of what was signed, changed after the signing.
    assertion.authenticatorData[32] |= FLAGS.backedUp;

    expect(() =>
      verifyAssertion({
        ...assertion,
        credentialPublicKey: registration.credentialPublicKey,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/does not match/);
  });

  it('refuses another passkey’s signature', () => {
    const { registration } = register();
    const other = register();
    const challenge = randomChallenge();
    const assertion = signAssertion({ credential: other.credential, challenge, signCount: 2 });

    expect(() =>
      verifyAssertion({
        ...assertion,
        credentialPublicKey: registration.credentialPublicKey,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/does not match/);
  });

  it('refuses a replay of the counter it has already seen', () => {
    const { credential, registration } = register();
    signIn({ credential, registration, signCount: 9 });

    expect(() =>
      verifyAssertion({
        ...signAssertion({ credential, challenge: randomChallenge(), signCount: 9 }),
        credentialPublicKey: registration.credentialPublicKey,
        storedSignCount: 9,
        expectedChallenge: 'x',
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow();

    const challenge = randomChallenge();
    expect(() =>
      verifyAssertion({
        ...signAssertion({ credential, challenge, signCount: 9 }),
        credentialPublicKey: registration.credentialPublicKey,
        storedSignCount: 9,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/used before with that counter/);
  });

  it('lets a synchronised passkey keep its counter at zero', () => {
    const { credential, registration } = register({ signCount: 0 });

    expect(signIn({ credential, registration, signCount: 0 })).toMatchObject({ signCount: 0 });
    expect(signIn({ credential, registration, signCount: 0 })).toMatchObject({ signCount: 0 });
  });

  it('refuses a sign-in on another site with the same key', () => {
    const { credential, registration } = register();
    const challenge = randomChallenge();
    const assertion = signAssertion({
      credential,
      challenge,
      rpId: 'evil.test',
      origin: 'https://evil.test',
    });

    expect(() =>
      verifyAssertion({
        ...assertion,
        credentialPublicKey: registration.credentialPublicKey,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/not here/);
  });

  it('refuses a registration answer offered as a sign-in', () => {
    const { credential, registration } = register();
    const challenge = randomChallenge();
    const assertion = signAssertion({ credential, challenge, type: 'webauthn.create' });

    expect(() =>
      verifyAssertion({
        ...assertion,
        credentialPublicKey: registration.credentialPublicKey,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/different kind of request/);
  });

  it('refuses a missing signature', () => {
    const { credential, registration } = register();
    const challenge = randomChallenge();
    const assertion = signAssertion({ credential, challenge });

    expect(() =>
      verifyAssertion({
        ...assertion,
        signature: Buffer.alloc(0),
        credentialPublicKey: registration.credentialPublicKey,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/signature is missing/);
  });

  it('refuses a passkey that was not unlocked when the server asks that it is', () => {
    const { credential, registration } = register();
    const challenge = randomChallenge();
    const assertion = signAssertion({ credential, challenge, userVerified: false });

    expect(() =>
      verifyAssertion({
        ...assertion,
        credentialPublicKey: registration.credentialPublicKey,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
        requireUserVerification: true,
      })
    ).toThrow(/not unlocked/);
  });
});

describe('reading the authenticator data', () => {
  it('refuses data too short to be any', () => {
    expect(() => parseAuthenticatorData(Buffer.alloc(36))).toThrow(/too short/);
    expect(() => parseAuthenticatorData('not bytes')).toThrow(WebAuthnError);
  });

  it('reads one with no credential attached', () => {
    const data = authenticatorData({ rpId: RP_ID, flags: FLAGS.userPresent, signCount: 12 });
    const parsed = parseAuthenticatorData(data);

    expect(parsed.signCount).toBe(12);
    expect(parsed.credentialId).toBeNull();
    expect(parsed.flags).toMatchObject({ userPresent: true, attestedCredential: false });
  });

  it('refuses a promise of a credential that is not there', () => {
    const data = authenticatorData({
      rpId: RP_ID,
      flags: FLAGS.attestedCredential | FLAGS.userPresent,
    });

    expect(() => parseAuthenticatorData(data)).toThrow(/promises a credential/);
  });

  it('refuses bytes after the key that nothing declared', () => {
    const { credential } = register();
    const data = authenticatorData({
      rpId: RP_ID,
      flags: FLAGS.userPresent | FLAGS.attestedCredential,
      credentialId: credential.credentialId,
      publicKey: new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.alloc(32, 3)],
        [-3, Buffer.alloc(32, 4)],
      ]),
    });

    expect(() => parseAuthenticatorData(Buffer.concat([data, Buffer.from('extra')]))).toThrow(
      /did not declare/
    );
  });

  it('reads extension data when the flag says there is some', () => {
    const { credential } = register();
    const data = authenticatorData({
      rpId: RP_ID,
      flags: FLAGS.userPresent | FLAGS.attestedCredential | FLAGS.extensionData,
      credentialId: credential.credentialId,
      publicKey: new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.alloc(32, 3)],
        [-3, Buffer.alloc(32, 4)],
      ]),
      extensions: new Map([['credProtect', 2]]),
    });

    expect(parseAuthenticatorData(data).credentialId.equals(credential.credentialId)).toBe(true);
  });
});

describe('reading a COSE key', () => {
  it('refuses an ES256 key on the wrong curve', () => {
    expect(() =>
      publicKeyFromCose(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 2],
          [-2, Buffer.alloc(32, 1)],
          [-3, Buffer.alloc(32, 2)],
        ])
      )
    ).toThrow(/P-256/);
  });

  it('refuses an EdDSA key on a curve that is not Ed25519', () => {
    expect(() =>
      publicKeyFromCose(
        new Map([
          [1, 1],
          [3, -8],
          [-1, 4],
          [-2, Buffer.alloc(32, 1)],
        ])
      )
    ).toThrow(/Ed25519/);
  });

  it('refuses a key type and an algorithm that do not go together', () => {
    expect(() =>
      publicKeyFromCose(
        new Map([
          [1, 3],
          [3, -7],
          [-1, Buffer.alloc(32, 1)],
          [-2, Buffer.from([1, 0, 1])],
        ])
      )
    ).toThrow(/do not go together/);
  });

  it('refuses a key with a coordinate missing', () => {
    expect(() =>
      publicKeyFromCose(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.alloc(32, 1)],
        ])
      )
    ).toThrow(/no y coordinate/);
  });

  it('reads one out of the bytes it was stored as', () => {
    const { credential } = register();
    const key = publicKeyFromCose(credential.coseKey);

    expect(key.algorithm).toBe(ALGORITHMS.ES256);
    expect(key.key.asymmetricKeyType).toBe('ec');
  });
});

describe('the challenge', () => {
  it('is thirty-two bytes, and never the same twice', () => {
    const drawn = new Set(Array.from({ length: 200 }, () => randomChallenge()));

    expect(drawn.size).toBe(200);
    expect(Buffer.from([...drawn][0], 'base64url')).toHaveLength(32);
  });

  it('refuses one that is not base64url', () => {
    const { credential, registration } = register();
    const challenge = randomChallenge();
    const assertion = signAssertion({ credential, challenge });
    assertion.clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: 'not base64url!!', origin: ORIGIN })
    );

    expect(() =>
      verifyAssertion({
        ...assertion,
        credentialPublicKey: registration.credentialPublicKey,
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      })
    ).toThrow(/not base64url/);
  });

  it('refuses client data that is not JSON, and data far too large to be any', () => {
    const { registration } = register();
    const common = {
      authenticatorData: Buffer.alloc(37),
      signature: Buffer.alloc(64),
      credentialPublicKey: registration.credentialPublicKey,
      expectedChallenge: randomChallenge(),
      expectedOrigins: [ORIGIN],
      expectedRpId: RP_ID,
    };

    expect(() => verifyAssertion({ ...common, clientDataJSON: Buffer.from('{oh') })).toThrow(
      /not JSON/
    );
    expect(() => verifyAssertion({ ...common, clientDataJSON: crypto.randomBytes(9000) })).toThrow(
      /too large/
    );
    expect(() => verifyAssertion({ ...common, clientDataJSON: Buffer.alloc(0) })).toThrow(
      /client data is missing/
    );
  });
});
