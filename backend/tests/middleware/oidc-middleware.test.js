import { describe, it, expect, afterEach } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * This is the path that decides who someone is, in the deployments that use
 * it, and nothing exercised any of it. A regression here would be both silent
 * and serious — the roles half of it already was: membership was read once, at
 * account creation, while the documentation said otherwise.
 */

let envContext;

const build = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'oidc-middleware-', env });
  const middleware = envContext.requireFresh('src/middleware/oidc');
  const dbService = envContext.requireFresh('src/services/db');
  const db = await dbService.getDb();
  return { middleware, db };
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('where the provider is told to come back to', () => {
  it('takes the origin of the callback URL when there is one', async () => {
    const { middleware } = await build();

    expect(middleware.deriveBaseUrl({ callbackUrl: 'https://files.example.com/callback' })).toBe(
      'https://files.example.com'
    );
  });

  it('falls back to the public URL', async () => {
    const { middleware } = await build({ PUBLIC_URL: 'https://files.example.com' });

    expect(middleware.deriveBaseUrl({})).toBe('https://files.example.com');
  });

  it('answers nothing rather than guessing', async () => {
    const { middleware } = await build();

    expect(middleware.deriveBaseUrl({})).toBeNull();
  });

  // A malformed value is a misconfiguration, not a reason to fail at startup.
  it('survives a callback URL that is not one', async () => {
    const { middleware } = await build();

    expect(middleware.deriveBaseUrl({ callbackUrl: 'https://' })).toBeNull();
  });
});

describe('whether the session cookie is marked secure', () => {
  it('marks it on https and not on http', async () => {
    const { middleware } = await build();

    expect(middleware.shouldOidcCookieBeSecure('https://files.example.com')).toBe(true);
    // Marking it on plain http would send a cookie the browser never returns,
    // and the login would loop.
    expect(middleware.shouldOidcCookieBeSecure('http://localhost:3000')).toBe(false);
    expect(middleware.shouldOidcCookieBeSecure(null)).toBe(false);
    expect(middleware.shouldOidcCookieBeSecure('not a url')).toBe(false);
  });
});

describe('what is asked of the provider', () => {
  it('always asks for openid, once', async () => {
    const { middleware } = await build();

    expect(middleware.resolveOidcScopes({ scopes: ['openid', 'profile'] })).toBe('openid profile');
    expect(middleware.resolveOidcScopes({ scopes: ['profile', 'email'] })).toBe(
      'openid profile email'
    );
  });

  it('has a usable default', async () => {
    const { middleware } = await build();

    expect(middleware.resolveOidcScopes({})).toBe('openid profile email');
  });

  // Without the groups scope the provider returns no group claim, which looks
  // exactly like a user who belongs to nothing.
  it('asks for groups when they are configured', async () => {
    const { middleware } = await build();

    expect(middleware.resolveOidcScopes({ scopes: ['openid', 'profile', 'groups'] })).toContain(
      'groups'
    );
  });
});

describe('what happens when someone comes back from the provider', () => {
  const callbackWith = async ({ claims, adminGroups = null, env = {} }) => {
    const { middleware, db } = await build(env);
    const handler = middleware.createAfterCallbackHandler(
      { issuer: 'https://idp.example' },
      { oidc: { adminGroups } }
    );

    const req = { oidc: { user: claims } };
    const session = { id_token_claims: claims };
    const returned = await handler(req, {}, session);

    return { db, returned, session };
  };

  const rolesOf = (db, email) => {
    const row = db.prepare('SELECT roles FROM users WHERE email = ?').get(email);
    return row ? JSON.parse(row.roles) : null;
  };

  it('creates the account the claims describe', async () => {
    const { db } = await callbackWith({
      claims: {
        sub: 'sub-1',
        email: 'someone@example.com',
        email_verified: true,
        preferred_username: 'someone',
        name: 'Some One',
      },
    });

    const row = db.prepare('SELECT * FROM users WHERE email = ?').get('someone@example.com');
    expect(row).toBeTruthy();
    expect(row.username).toBe('someone');
    expect(row.display_name).toBe('Some One');
  });

  it('hands the session back untouched', async () => {
    const { returned, session } = await callbackWith({
      claims: { sub: 'sub-1', email: 'someone@example.com', email_verified: true },
    });

    expect(returned).toBe(session);
  });

  // Claims without a subject are not an identity. The login is refused rather
  // than an account made from whatever else the provider sent — and refused as
  // an authentication failure, which the error handler turns into a trip back
  // to the login screen rather than a server fault.
  it('refuses claims with no subject, and makes no account from them', async () => {
    const { middleware, db } = await build();
    const handler = middleware.createAfterCallbackHandler(
      { issuer: 'https://idp.example' },
      { oidc: { adminGroups: null } }
    );
    const claims = { email: 'nobody@example.com', email_verified: true };

    await expect(
      handler({ oidc: { user: claims } }, {}, { id_token_claims: claims })
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0);
  });

  it('grants admin when the configured group is claimed', async () => {
    const { db } = await callbackWith({
      claims: {
        sub: 'sub-1',
        email: 'boss@example.com',
        email_verified: true,
        groups: ['nx-admins'],
      },
      adminGroups: ['nx-admins'],
    });

    expect(rolesOf(db, 'boss@example.com')).toContain('admin');
  });

  // The regression this must never cause: with no group configured every login
  // derives the plain `user` role, and applying it would demote the
  // administrator promoted from Settings at their next sign-in.
  it('leaves the roles alone when no group is configured', async () => {
    const { middleware, db } = await build();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
       VALUES ('u-1', 'boss@example.com', 1, 'boss', 'Boss', '["admin"]', ?, ?)`
    ).run(now, now);
    db.prepare(
      `INSERT INTO auth_methods (id, user_id, method_type, provider_issuer, provider_sub, provider_name, created_at)
       VALUES ('a-1', 'u-1', 'oidc', 'https://idp.example', 'sub-1', 'OIDC', ?)`
    ).run(now);

    const handler = middleware.createAfterCallbackHandler(
      { issuer: 'https://idp.example' },
      { oidc: { adminGroups: null } }
    );
    const claims = {
      sub: 'sub-1',
      email: 'boss@example.com',
      email_verified: true,
      groups: ['staff'],
    };
    await handler({ oidc: { user: claims } }, {}, { id_token_claims: claims });

    expect(JSON.parse(db.prepare("SELECT roles FROM users WHERE id = 'u-1'").get().roles)).toEqual([
      'admin',
    ]);
  });
});
