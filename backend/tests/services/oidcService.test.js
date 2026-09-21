import http from 'node:http';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { fetchUserInfoClaims } = require('../../src/services/oidcService');

/**
 * The claims this fetches are who somebody is after an OIDC sign-in, and the
 * middleware has somewhere to go when it gets nothing back: the id token's own
 * claims. So every way this can fail matters in the same direction — it must
 * answer null and let the sign-in carry on, not take the sign-in down.
 *
 * Exercised against a real HTTP server standing in for the identity provider,
 * not a stubbed fetch: the timeout is an AbortController on a real socket, the
 * bearer token is a real header, and a stub would have agreed with whatever the
 * code assumed about both.
 */

const DISCOVERY = '/.well-known/openid-configuration';

let server;
let origin;
let routes;
let requests;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const handler = routes.get(req.url);
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  // A handler that never answers holds its socket open; close would wait on it.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.useRealTimers();
});

// The discovery document is cached per issuer for the life of the process, so
// each test gets an issuer of its own rather than inheriting another's cache.
let realmCounter = 0;
const freshRealm = () => {
  realmCounter += 1;
  routes = new Map();
  requests = [];
  return `/realm-${realmCounter}`;
};

const json =
  (body, status = 200) =>
  (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

const provider = (realm, { configuration, userinfo } = {}) => {
  const userinfoPath = `${realm}/userinfo`;
  routes.set(
    `${realm}${DISCOVERY}`,
    json(configuration ?? { userinfo_endpoint: `${origin}${userinfoPath}` })
  );
  routes.set(userinfoPath, userinfo ?? json({ sub: 'alice', email: 'alice@example.com' }));
  return { issuer: `${origin}${realm}`, userinfoPath };
};

const hits = (path) => requests.filter((r) => r.url === path).length;

describe('the claims a provider hands back', () => {
  it('are fetched from the endpoint discovery names, with the access token', async () => {
    const realm = freshRealm();
    const { issuer, userinfoPath } = provider(realm);

    const claims = await fetchUserInfoClaims({ issuer, accessToken: 'tok-1' });

    expect(claims).toEqual({ sub: 'alice', email: 'alice@example.com' });
    expect(requests.map((r) => r.url)).toEqual([`${realm}${DISCOVERY}`, userinfoPath]);
    expect(requests[1].authorization).toBe('Bearer tok-1');
  });

  it('are fetched for an issuer written with trailing slashes', async () => {
    const realm = freshRealm();
    const { issuer } = provider(realm);

    const claims = await fetchUserInfoClaims({ issuer: `${issuer}//`, accessToken: 't' });

    expect(claims?.sub).toBe('alice');
    // Not `${realm}//.well-known/...`, which most providers answer 404.
    expect(hits(`${realm}${DISCOVERY}`)).toBe(1);
  });
});

describe('asking for nothing', () => {
  it('without an issuer sends no request at all', async () => {
    freshRealm();

    expect(await fetchUserInfoClaims({ accessToken: 't' })).toBeNull();
    expect(requests).toEqual([]);
  });

  it('without an access token sends no request at all', async () => {
    const realm = freshRealm();
    const { issuer } = provider(realm);

    expect(await fetchUserInfoClaims({ issuer })).toBeNull();
    expect(requests).toEqual([]);
  });
});

describe('an explicit userinfo URL', () => {
  it('is used instead of discovery', async () => {
    const realm = freshRealm();
    const { issuer, userinfoPath } = provider(realm);

    const claims = await fetchUserInfoClaims({
      issuer,
      accessToken: 't',
      userInfoURL: `${origin}${userinfoPath}`,
    });

    expect(claims?.sub).toBe('alice');
    expect(hits(`${realm}${DISCOVERY}`)).toBe(0);
  });

  it.each([
    ['a file URL', 'file:///etc/passwd'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['something that is not a URL', 'not a url'],
  ])('is ignored when it is %s, and discovery is used instead', async (_label, userInfoURL) => {
    const realm = freshRealm();
    const { issuer, userinfoPath } = provider(realm);

    const claims = await fetchUserInfoClaims({ issuer, accessToken: 't', userInfoURL });

    expect(claims?.sub).toBe('alice');
    expect(hits(`${realm}${DISCOVERY}`)).toBe(1);
    expect(hits(userinfoPath)).toBe(1);
  });
});

describe('the discovery document', () => {
  it('is fetched once and then answered from memory', async () => {
    const realm = freshRealm();
    const { issuer, userinfoPath } = provider(realm);

    await fetchUserInfoClaims({ issuer, accessToken: 't' });
    await fetchUserInfoClaims({ issuer, accessToken: 't' });

    expect(hits(`${realm}${DISCOVERY}`)).toBe(1);
    expect(hits(userinfoPath)).toBe(2);
  });

  it('is fetched again once ten minutes have passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const realm = freshRealm();
    const { issuer } = provider(realm);

    await fetchUserInfoClaims({ issuer, accessToken: 't' });
    vi.setSystemTime(Date.now() + 9 * 60 * 1000);
    await fetchUserInfoClaims({ issuer, accessToken: 't' });
    expect(hits(`${realm}${DISCOVERY}`)).toBe(1);

    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    await fetchUserInfoClaims({ issuer, accessToken: 't' });
    expect(hits(`${realm}${DISCOVERY}`)).toBe(2);
  });

  it('is kept for as long as the provider says, when it says', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const realm = freshRealm();
    const { issuer } = provider(realm, {
      configuration: { userinfo_endpoint: `${origin}${realm}/userinfo`, configuration_ttl: 1000 },
    });

    await fetchUserInfoClaims({ issuer, accessToken: 't' });
    vi.setSystemTime(Date.now() + 1500);
    await fetchUserInfoClaims({ issuer, accessToken: 't' });

    expect(hits(`${realm}${DISCOVERY}`)).toBe(2);
  });

  it('falls back to ten minutes when the lifetime it declares is nonsense', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const realm = freshRealm();
    const { issuer } = provider(realm, {
      configuration: { userinfo_endpoint: `${origin}${realm}/userinfo`, configuration_ttl: -5 },
    });

    await fetchUserInfoClaims({ issuer, accessToken: 't' });
    vi.setSystemTime(Date.now() + 60 * 1000);
    await fetchUserInfoClaims({ issuer, accessToken: 't' });

    // A negative lifetime taken at face value would expire it at once.
    expect(hits(`${realm}${DISCOVERY}`)).toBe(1);
  });

  it('that names no userinfo endpoint means there are no claims to fetch', async () => {
    const realm = freshRealm();
    const { issuer } = provider(realm, { configuration: { issuer: 'x' } });

    expect(await fetchUserInfoClaims({ issuer, accessToken: 't' })).toBeNull();
  });
});

describe('a userinfo endpoint that does not cooperate', () => {
  it('refusing the token gives null', async () => {
    const realm = freshRealm();
    const { issuer } = provider(realm, { userinfo: json({ error: 'invalid_token' }, 401) });

    expect(await fetchUserInfoClaims({ issuer, accessToken: 'expired' })).toBeNull();
  });

  it('answering with something that is not JSON gives null', async () => {
    const realm = freshRealm();
    const { issuer } = provider(realm, {
      userinfo: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>Sign in again</html>');
      },
    });

    expect(await fetchUserInfoClaims({ issuer, accessToken: 't' })).toBeNull();
  });

  it('never answering gives null once the timeout has passed', async () => {
    const realm = freshRealm();
    const { issuer } = provider(realm, { userinfo: () => {} });

    const started = Date.now();
    const claims = await fetchUserInfoClaims({ issuer, accessToken: 't', timeoutMs: 150 });

    expect(claims).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/**
 * The sign-in has already succeeded by the time this runs, and the middleware
 * falls back to the id token's claims when it gets null. A provider whose
 * discovery document is briefly unavailable is therefore no reason to refuse
 * someone — but discovery sat outside the try that guards the userinfo fetch,
 * so any of these took the whole sign-in down with it.
 */
describe('a discovery document that cannot be had', () => {
  it('because the provider errors gives null rather than throwing', async () => {
    const realm = freshRealm();
    routes.set(`${realm}${DISCOVERY}`, json({ error: 'unavailable' }, 503));

    await expect(
      fetchUserInfoClaims({ issuer: `${origin}${realm}`, accessToken: 't' })
    ).resolves.toBeNull();
  });

  it('because it is not JSON gives null rather than throwing', async () => {
    const realm = freshRealm();
    routes.set(`${realm}${DISCOVERY}`, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>Maintenance</html>');
    });

    await expect(
      fetchUserInfoClaims({ issuer: `${origin}${realm}`, accessToken: 't' })
    ).resolves.toBeNull();
  });

  it('because nothing is listening gives null rather than throwing', async () => {
    freshRealm();
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));

    await expect(
      fetchUserInfoClaims({ issuer: `http://127.0.0.1:${port}/realm`, accessToken: 't' })
    ).resolves.toBeNull();
  });

  it('because it never answers gives null once the timeout has passed', async () => {
    const realm = freshRealm();
    routes.set(`${realm}${DISCOVERY}`, () => {});

    await expect(
      fetchUserInfoClaims({ issuer: `${origin}${realm}`, accessToken: 't', timeoutMs: 150 })
    ).resolves.toBeNull();
  });

  it('is not remembered, so the next sign-in asks again', async () => {
    const realm = freshRealm();
    routes.set(`${realm}${DISCOVERY}`, json({ error: 'unavailable' }, 503));
    await fetchUserInfoClaims({ issuer: `${origin}${realm}`, accessToken: 't' });

    provider(realm);
    const claims = await fetchUserInfoClaims({ issuer: `${origin}${realm}`, accessToken: 't' });

    expect(claims?.sub).toBe('alice');
  });
});
