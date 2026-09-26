import { requestJson } from './http';

/**
 * Passkeys, from the browser's side.
 *
 * The server speaks base64url — JSON carries no bytes — and the WebAuthn API
 * speaks ArrayBuffers. Everything here is that translation and the two calls
 * around it, kept apart from the components so the conversion can be read, and
 * tested, without a browser that has an authenticator in it.
 */

const toBytes = (value) => {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const toBase64Url = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Whether this browser can do it at all.
 *
 * Not a question of support alone: a passkey is bound to a name, and a page
 * served over plain http has nothing to bind to, so the browser refuses before
 * anything is asked. Saying so here keeps a button that cannot work off the
 * screen.
 */
const passkeysSupported = () =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential === 'function' &&
  window.isSecureContext === true;

/** The options the server drew, in the shape `navigator.credentials` wants. */
const toCreationOptions = (options) => ({
  ...options,
  challenge: toBytes(options.challenge),
  user: { ...options.user, id: toBytes(options.user.id) },
  excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
    ...credential,
    id: toBytes(credential.id),
  })),
});

const toRequestOptions = (options) => ({
  ...options,
  challenge: toBytes(options.challenge),
  allowCredentials: (options.allowCredentials || []).map((credential) => ({
    ...credential,
    id: toBytes(credential.id),
  })),
});

/** What the server is told about a passkey that was just made. */
const fromNewCredential = (credential) => ({
  id: credential.id,
  attestationObject: toBase64Url(credential.response.attestationObject),
  clientDataJSON: toBase64Url(credential.response.clientDataJSON),
  transports:
    typeof credential.response.getTransports === 'function'
      ? credential.response.getTransports()
      : [],
});

/** What the server is told about a passkey that was just used. */
const fromAssertion = (credential) => ({
  id: credential.id,
  authenticatorData: toBase64Url(credential.response.authenticatorData),
  clientDataJSON: toBase64Url(credential.response.clientDataJSON),
  signature: toBase64Url(credential.response.signature),
  userHandle: credential.response.userHandle ? toBase64Url(credential.response.userHandle) : null,
});

const listPasskeys = () => requestJson('/api/auth/passkeys', { method: 'GET' });

const renamePasskey = (id, name) =>
  requestJson(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });

const deletePasskey = (id, password) =>
  requestJson(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ password }),
  });

/**
 * Make one: ask for a question, hand it to the authenticator, send the answer.
 *
 * The browser is what asks the person for a fingerprint or a PIN, and what
 * refuses if the page is not what it claims to be. Nothing here can hurry it,
 * and a refusal comes back as an exception to show as it is.
 */
const createPasskey = async ({ name } = {}) => {
  const { options } = await requestJson('/api/auth/passkeys/register/start', {
    method: 'POST',
    body: JSON.stringify({}),
  });

  const credential = await navigator.credentials.create({
    publicKey: toCreationOptions(options),
  });
  if (!credential) throw new Error('No passkey was created.');

  return requestJson('/api/auth/passkeys/register/finish', {
    method: 'POST',
    body: JSON.stringify({ name, response: fromNewCredential(credential) }),
  });
};

/** Use one. Nobody is named: the authenticator offers what it holds for this site. */
const signInWithPasskey = async () => {
  const { options } = await requestJson('/api/auth/login/passkey/start', {
    method: 'POST',
    body: JSON.stringify({}),
  });

  const credential = await navigator.credentials.get({ publicKey: toRequestOptions(options) });
  if (!credential) throw new Error('No passkey was used.');

  return requestJson('/api/auth/login/passkey/finish', {
    method: 'POST',
    body: JSON.stringify({ response: fromAssertion(credential) }),
  });
};

export {
  createPasskey,
  deletePasskey,
  fromAssertion,
  fromNewCredential,
  listPasskeys,
  passkeysSupported,
  renamePasskey,
  signInWithPasskey,
  toBase64Url,
  toBytes,
  toCreationOptions,
  toRequestOptions,
};
