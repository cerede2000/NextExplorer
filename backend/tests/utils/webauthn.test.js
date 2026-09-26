import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  WebAuthnError,
  fromBase64Url,
  parseAuthenticatorData,
  publicKeyFromCose,
  randomChallenge,
  rpIdHash,
  toBase64Url,
  verifyAssertion,
} from '../../src/utils/webauthn.js';

/**
 * What a passkey's signature has to prove, checked here rather than trusted.
 *
 * This is written by hand instead of taken from a library, so the parts a
 * library would hide are the parts worth pinning: the question being answered,
 * the domain the key was made for, the flags that say somebody was actually
 * there, and the counter that betrays a copied key.
 */

const RP_ID = 'files.example.com';
const ORIGIN = 'https://files.example.com';

/** Authenticator data as an authenticator writes it: hash, flags, counter. */
const authenticatorData = ({ rpId = RP_ID, flags = 0x05, counter = 1 } = {}) => {
  const buffer = Buffer.alloc(37);
  rpIdHash(rpId).copy(buffer, 0);
  buffer[32] = flags;
  buffer.writeUInt32BE(counter, 33);
  return buffer;
};

const clientDataJson = (challenge, { origin = ORIGIN, type = 'webauthn.get' } = {}) =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

/**
 * The public half as an authenticator hands it over: a COSE key, which is CBOR.
 * Written out by hand — five small entries — so the test exercises the same
 * decoder a real authenticator's answer goes through.
 */
const coseKey = () => {
  const raw = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  // An uncompressed P-256 point is the last 65 bytes of the SPKI encoding.
  const point = raw.subarray(raw.length - 65);
  const x = point.subarray(1, 33);
  const y = point.subarray(33, 65);
  return Buffer.concat([
    Buffer.from([0xa5]), // map of five
    Buffer.from([0x01, 0x02]), // kty: EC2
    Buffer.from([0x03, 0x26]), // alg: ES256 (-7)
    Buffer.from([0x20, 0x01]), // crv: P-256
    Buffer.from([0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
};

const signed = (authData, client) => {
  const payload = Buffer.concat([authData, crypto.createHash('sha256').update(client).digest()]);
  return crypto.sign('sha256', payload, { key: keyPair.privateKey, dsaEncoding: 'der' });
};

const answer = (challenge, overrides = {}) => {
  const authData = authenticatorData(overrides.authenticator);
  const client = clientDataJson(challenge, overrides.client);
  return {
    authenticatorData: authData,
    clientDataJSON: client,
    signature: signed(authData, client),
    credentialPublicKey: coseKey(),
    expectedChallenge: challenge,
    expectedOrigins: [ORIGIN],
    expectedRpId: RP_ID,
    storedSignCount: 0,
  };
};

describe('the authenticator data', () => {
  it('says which domain the key was made for', () => {
    const parsed = parseAuthenticatorData(authenticatorData());

    expect(parsed.rpIdHash.equals(rpIdHash(RP_ID))).toBe(true);
    expect(parsed.rpIdHash.equals(rpIdHash('somewhere.else'))).toBe(false);
  });

  it('says whether somebody was there, and whether they were checked', () => {
    // 0x01 present, 0x04 verified.
    expect(parseAuthenticatorData(authenticatorData({ flags: 0x01 })).flags.userPresent).toBe(true);
    expect(parseAuthenticatorData(authenticatorData({ flags: 0x01 })).flags.userVerified).toBe(
      false
    );
    expect(parseAuthenticatorData(authenticatorData({ flags: 0x05 })).flags.userVerified).toBe(
      true
    );
  });

  it('carries the counter that betrays a copied key', () => {
    expect(parseAuthenticatorData(authenticatorData({ counter: 42 })).signCount).toBe(42);
  });

  it('refuses something too short to be authenticator data', () => {
    expect(() => parseAuthenticatorData(Buffer.alloc(10))).toThrow(WebAuthnError);
  });
});

describe('the public key an authenticator hands over', () => {
  it('is read back out of its COSE encoding', () => {
    expect(() => publicKeyFromCose(coseKey())).not.toThrow();
  });
});

describe('a signature', () => {
  const challenge = randomChallenge();

  it('is accepted when everything matches', () => {
    const outcome = verifyAssertion(answer(challenge));

    expect(outcome.userVerified).toBe(true);
    expect(outcome.signCount).toBe(1);
    expect(outcome.origin).toBe(ORIGIN);
  });

  /** A recording of an earlier sign-in must not be a sign-in. */
  it('is refused when it answers a different question', () => {
    expect(() =>
      verifyAssertion({ ...answer(randomChallenge()), expectedChallenge: challenge })
    ).toThrow(WebAuthnError);
  });

  /** The whole point of binding a key to a domain. */
  it('is refused when it comes from somewhere else', () => {
    expect(() =>
      verifyAssertion(answer(challenge, { client: { origin: 'https://evil.example' } }))
    ).toThrow(WebAuthnError);
  });

  it('is refused when it was made for another domain', () => {
    expect(() =>
      verifyAssertion(answer(challenge, { authenticator: { rpId: 'other.example' } }))
    ).toThrow(WebAuthnError);
  });

  it('is refused when nobody was there', () => {
    expect(() => verifyAssertion(answer(challenge, { authenticator: { flags: 0x00 } }))).toThrow(
      WebAuthnError
    );
  });

  it('is refused when the answer is not to this kind of question', () => {
    expect(() =>
      verifyAssertion(answer(challenge, { client: { type: 'webauthn.create' } }))
    ).toThrow(WebAuthnError);
  });

  /**
   * The counter only ever goes up. One that has not moved is a key that exists
   * in two places — or one that was replayed.
   */
  it('is refused when the counter has not moved on', () => {
    expect(() =>
      verifyAssertion({
        ...answer(challenge, { authenticator: { counter: 3 } }),
        storedSignCount: 9,
      })
    ).toThrow(WebAuthnError);
  });

  /** Synchronised passkeys report zero for ever; that is evidence of nothing. */
  it('accepts a counter of zero from a key that never counts', () => {
    const outcome = verifyAssertion(answer(challenge, { authenticator: { counter: 0 } }));

    expect(outcome.signCount).toBe(0);
  });

  it('is refused when a byte of the signature is changed', () => {
    const tampered = answer(challenge);
    tampered.signature[tampered.signature.length - 1] ^= 0xff;

    expect(() => verifyAssertion(tampered)).toThrow(WebAuthnError);
  });

  it('is refused when it carries no signature at all', () => {
    expect(() => verifyAssertion({ ...answer(challenge), signature: Buffer.alloc(0) })).toThrow(
      WebAuthnError
    );
  });
});

describe('base64url', () => {
  it('survives a round trip', () => {
    const bytes = crypto.randomBytes(64);

    expect(fromBase64Url(toBase64Url(bytes)).equals(bytes)).toBe(true);
  });

  it('never leaves the characters a URL would have to escape', () => {
    expect(toBase64Url(Buffer.from([251, 255, 190, 0]))).not.toMatch(/[+/=]/);
  });
});
