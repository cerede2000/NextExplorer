import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The passkey endpoints, and the translation around them.
 *
 * JSON carries no bytes and WebAuthn carries nothing else, so every value that
 * matters crosses this module as base64url in one direction and as an
 * ArrayBuffer in the other. A challenge that arrives at the authenticator as
 * text — or as the wrong bytes — produces a signature over something the
 * server never asked, which is a sign-in that cannot work and a failure with
 * nothing to read in it.
 */

const { requestJson } = vi.hoisted(() => ({ requestJson: vi.fn(async () => ({})) }));

vi.mock('./http', () => ({
  requestJson,
  buildUrl: (endpoint) => `/base${endpoint}`,
  normalizePath: (value) => String(value || '').replace(/^\/+|\/+$/g, ''),
}));

const api = await import('./passkeys.api');

const bytes = (...values) => new Uint8Array(values).buffer;

const call = (index = -1) => {
  const [endpoint, options] = requestJson.mock.calls.at(index);
  return {
    endpoint,
    method: options?.method,
    body: options?.body ? JSON.parse(options.body) : null,
  };
};

beforeEach(() => {
  requestJson.mockClear();
  requestJson.mockResolvedValue({});
});

describe('bytes and text', () => {
  it('reads base64url, including the two characters that differ from base64', () => {
    // 0xfb 0xff encodes as "-_8" in base64url and "+/8" in base64.
    expect(Array.from(api.toBytes('-_8'))).toEqual([251, 255]);
    expect(api.toBase64Url(new Uint8Array([251, 255]))).toBe('-_8');
  });

  it('reads a value whose length is not a multiple of four', () => {
    expect(Array.from(api.toBytes('AQ'))).toEqual([1]);
    expect(Array.from(api.toBytes('AQID'))).toEqual([1, 2, 3]);
  });

  it('comes back the same after a round trip', () => {
    const original = new Uint8Array(Array.from({ length: 64 }, (_, index) => (index * 7) % 256));

    expect(Array.from(api.toBytes(api.toBase64Url(original)))).toEqual(Array.from(original));
  });
});

describe('the options handed to the authenticator', () => {
  it('turns the challenge, the account and the known credentials into bytes', () => {
    const options = api.toCreationOptions({
      challenge: 'AQID',
      rp: { id: 'files.example.test', name: 'Files' },
      user: { id: 'BAUG', name: 'someone', displayName: 'Someone' },
      excludeCredentials: [{ type: 'public-key', id: 'BwgJ', transports: ['usb'] }],
      timeout: 120000,
    });

    expect(Array.from(options.challenge)).toEqual([1, 2, 3]);
    expect(Array.from(options.user.id)).toEqual([4, 5, 6]);
    expect(Array.from(options.excludeCredentials[0].id)).toEqual([7, 8, 9]);
    expect(options.excludeCredentials[0].transports).toEqual(['usb']);
    expect(options.rp).toEqual({ id: 'files.example.test', name: 'Files' });
    expect(options.timeout).toBe(120000);
  });

  it('copes with a server that named no credentials at all', () => {
    const options = api.toCreationOptions({ challenge: 'AQID', user: { id: 'BAUG' } });

    expect(options.excludeCredentials).toEqual([]);
  });

  it('turns a sign-in question into bytes the same way', () => {
    const options = api.toRequestOptions({
      challenge: 'AQID',
      rpId: 'files.example.test',
      allowCredentials: [{ type: 'public-key', id: 'BwgJ' }],
    });

    expect(Array.from(options.challenge)).toEqual([1, 2, 3]);
    expect(Array.from(options.allowCredentials[0].id)).toEqual([7, 8, 9]);
    expect(options.rpId).toBe('files.example.test');
  });
});

describe('what is sent back', () => {
  it('describes a new passkey as text, transports included', () => {
    const sent = api.fromNewCredential({
      id: 'credential-id',
      response: {
        attestationObject: bytes(1, 2, 3),
        clientDataJSON: bytes(4, 5, 6),
        getTransports: () => ['internal', 'hybrid'],
      },
    });

    expect(sent).toEqual({
      id: 'credential-id',
      attestationObject: 'AQID',
      clientDataJSON: 'BAUG',
      transports: ['internal', 'hybrid'],
    });
  });

  it('copes with an authenticator that will not say how it is reached', () => {
    const sent = api.fromNewCredential({
      id: 'credential-id',
      response: { attestationObject: bytes(1), clientDataJSON: bytes(2) },
    });

    expect(sent.transports).toEqual([]);
  });

  it('describes a sign-in, signature and all', () => {
    const sent = api.fromAssertion({
      id: 'credential-id',
      response: {
        authenticatorData: bytes(1, 2, 3),
        clientDataJSON: bytes(4, 5, 6),
        signature: bytes(7, 8, 9),
        userHandle: bytes(10),
      },
    });

    expect(sent).toEqual({
      id: 'credential-id',
      authenticatorData: 'AQID',
      clientDataJSON: 'BAUG',
      signature: 'BwgJ',
      userHandle: 'Cg',
    });
  });

  it('says so plainly when there was no user handle', () => {
    const sent = api.fromAssertion({
      id: 'credential-id',
      response: {
        authenticatorData: bytes(1),
        clientDataJSON: bytes(2),
        signature: bytes(3),
        userHandle: null,
      },
    });

    expect(sent.userHandle).toBeNull();
  });
});

describe('making one', () => {
  const credential = {
    id: 'new-credential',
    response: {
      attestationObject: bytes(1, 2, 3),
      clientDataJSON: bytes(4, 5, 6),
      getTransports: () => ['internal'],
    },
  };

  afterEach(() => {
    delete globalThis.navigator.credentials;
  });

  const withAuthenticator = (create) => {
    Object.defineProperty(globalThis.navigator, 'credentials', {
      value: { create, get: vi.fn() },
      configurable: true,
    });
  };

  it('asks for a question, answers it, and names the passkey', async () => {
    const create = vi.fn(async () => credential);
    withAuthenticator(create);
    requestJson.mockResolvedValueOnce({
      options: { challenge: 'AQID', user: { id: 'BAUG' }, excludeCredentials: [] },
    });

    await api.createPasskey({ name: 'The yellow key' });

    expect(call(-2).endpoint).toBe('/api/auth/passkeys/register/start');
    expect(Array.from(create.mock.calls[0][0].publicKey.challenge)).toEqual([1, 2, 3]);
    expect(call()).toMatchObject({
      endpoint: '/api/auth/passkeys/register/finish',
      method: 'POST',
      body: {
        name: 'The yellow key',
        response: { id: 'new-credential', transports: ['internal'] },
      },
    });
  });

  it('sends nothing on when the browser hands back nothing', async () => {
    withAuthenticator(vi.fn(async () => null));
    requestJson.mockResolvedValueOnce({ options: { challenge: 'AQID', user: { id: 'BAUG' } } });

    await expect(api.createPasskey({})).rejects.toThrow(/No passkey was created/);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('lets the browser’s refusal through as it is', async () => {
    const refusal = new DOMException('The operation either timed out or was not allowed.');
    withAuthenticator(vi.fn(async () => Promise.reject(refusal)));
    requestJson.mockResolvedValueOnce({ options: { challenge: 'AQID', user: { id: 'BAUG' } } });

    await expect(api.createPasskey({})).rejects.toBe(refusal);
  });
});

describe('signing in with one', () => {
  afterEach(() => {
    delete globalThis.navigator.credentials;
  });

  it('asks for a question and sends the signature back', async () => {
    const get = vi.fn(async () => ({
      id: 'known-credential',
      response: {
        authenticatorData: bytes(1),
        clientDataJSON: bytes(2),
        signature: bytes(3),
        userHandle: null,
      },
    }));
    Object.defineProperty(globalThis.navigator, 'credentials', {
      value: { get, create: vi.fn() },
      configurable: true,
    });
    requestJson.mockResolvedValueOnce({
      options: { challenge: 'AQID', rpId: 'files.example.test', allowCredentials: [] },
    });

    await api.signInWithPasskey();

    expect(call(-2).endpoint).toBe('/api/auth/login/passkey/start');
    expect(Array.from(get.mock.calls[0][0].publicKey.challenge)).toEqual([1, 2, 3]);
    expect(call()).toMatchObject({
      endpoint: '/api/auth/login/passkey/finish',
      method: 'POST',
      body: { response: { id: 'known-credential', signature: 'Aw' } },
    });
  });
});

describe('whether the browser can do this at all', () => {
  const originalSecure = window.isSecureContext;
  const originalApi = window.PublicKeyCredential;

  afterEach(() => {
    Object.defineProperty(window, 'isSecureContext', {
      value: originalSecure,
      configurable: true,
    });
    if (originalApi === undefined) delete window.PublicKeyCredential;
    else window.PublicKeyCredential = originalApi;
  });

  const setContext = ({ secure, supported }) => {
    Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
    if (supported) window.PublicKeyCredential = function PublicKeyCredential() {};
    else delete window.PublicKeyCredential;
  };

  it('is yes where the page is secure and the browser knows passkeys', () => {
    setContext({ secure: true, supported: true });

    expect(api.passkeysSupported()).toBe(true);
  });

  it('is no over plain http, where there is nothing to bind a passkey to', () => {
    setContext({ secure: false, supported: true });

    expect(api.passkeysSupported()).toBe(false);
  });

  it('is no in a browser that has never heard of them', () => {
    setContext({ secure: true, supported: false });

    expect(api.passkeysSupported()).toBe(false);
  });
});
