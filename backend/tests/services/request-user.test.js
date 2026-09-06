import { afterEach, describe, expect, it } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * Who the application decides you are.
 *
 * This is where an account is looked up, and where it is given the personal
 * folder name it keeps for the rest of its life. It had the lowest coverage of
 * anything in the personal-folder feature — forty-four per cent of statements,
 * twenty-eight of branches — and the whole OIDC half of it was untouched.
 *
 * That half held a defect. An account whose row does not exist yet gets a user
 * object assembled from the provider's claims, and it carried no folder name at
 * all. A name absent is a name derived, and `USER_FOLDER_NAME_ORDER` — in the
 * order the reference recommends for reusing /home — puts `username` first,
 * which two identities from two providers can share. The claim mechanism that
 * exists to prevent exactly that cannot run without a row to write to.
 */

const MODULES = [
  'src/config/env',
  'src/config/index',
  'src/services/db',
  'src/services/users/requestUser',
];

const OIDC_ENV = {
  AUTH_ENABLED: 'true',
  OIDC_ENABLED: 'true',
  OIDC_ISSUER: 'https://idp.example',
  OIDC_CLIENT_ID: 'nextexplorer',
  USER_DIR_ENABLED: 'true',
};

let envContext;

const build = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'request-user-', env: { ...OIDC_ENV, ...env }, modules: MODULES });
  const { getRequestUser } = envContext.requireFresh('src/services/users/requestUser');
  const db = await envContext.requireFresh('src/services/db').getDb();
  return { getRequestUser, db };
};

const seedAccount = (db, { id = 'user-1', username = 'someone', folderName = null } = {}) => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, personal_folder_name, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?, ?)`
  ).run(id, `${username}@example.com`, username, username, folderName, now, now);
  return id;
};

const linkOidc = (db, { userId = 'user-1', sub = 'sub-1' } = {}) => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO auth_methods (id, user_id, method_type, provider_issuer, provider_sub, provider_name, created_at)
     VALUES (?, ?, 'oidc', 'https://idp.example', ?, 'OIDC', ?)`
  ).run(`auth-${sub}`, userId, sub, now);
};

const oidcRequest = (claims) => ({
  oidc: { isAuthenticated: () => true, user: claims },
});

afterEach(async () => {
  if (envContext) {
    await envContext.cleanup();
    envContext = null;
  }
});

describe('a request that already carries a user', () => {
  it('is answered with that user', async () => {
    const { getRequestUser } = await build();
    const user = { id: 'synthetic', roles: ['admin'] };

    expect(await getRequestUser({ user })).toBe(user);
  });

  it('is not answered by an object with no id', async () => {
    const { getRequestUser, db } = await build();
    seedAccount(db, { folderName: 'someone' });

    const result = await getRequestUser({ user: {}, session: { localUserId: 'user-1' } });

    expect(result.id).toBe('user-1');
  });
});

describe('a local session', () => {
  it('finds the account', async () => {
    const { getRequestUser, db } = await build();
    seedAccount(db, { folderName: 'someone' });

    const user = await getRequestUser({ session: { localUserId: 'user-1' } });

    expect(user).toMatchObject({ id: 'user-1', provider: 'local' });
  });

  /** The claim happens here for an account created any other way. */
  it('gives an account without a folder name one, and keeps it', async () => {
    const { getRequestUser, db } = await build();
    seedAccount(db, { folderName: null });

    const first = await getRequestUser({ session: { localUserId: 'user-1' } });
    const second = await getRequestUser({ session: { localUserId: 'user-1' } });

    expect(first.personalFolderName).toBeTruthy();
    expect(second.personalFolderName).toBe(first.personalFolderName);
  });

  it('leaves a name it already holds alone', async () => {
    const { getRequestUser, db } = await build();
    seedAccount(db, { folderName: 'chosen-long-ago' });

    const user = await getRequestUser({ session: { localUserId: 'user-1' } });

    expect(user.personalFolderName).toBe('chosen-long-ago');
  });
});

describe('an OIDC session for an account that exists', () => {
  it('finds it through its provider subject', async () => {
    const { getRequestUser, db } = await build();
    seedAccount(db, { folderName: 'someone' });
    linkOidc(db);

    const user = await getRequestUser(oidcRequest({ sub: 'sub-1' }));

    expect(user).toMatchObject({ id: 'user-1', provider: 'oidc', oidcIssuer: 'https://idp.example' });
  });

  it('takes the picture from the claims when the account has none', async () => {
    const { getRequestUser, db } = await build();
    seedAccount(db, { folderName: 'someone' });
    linkOidc(db);

    const user = await getRequestUser(
      oidcRequest({ sub: 'sub-1', picture: '  https://idp.example/me.png  ' })
    );

    expect(user.avatarUrl).toBe('https://idp.example/me.png');
  });

  it('ignores a picture claim that is only whitespace', async () => {
    const { getRequestUser, db } = await build();
    seedAccount(db, { folderName: 'someone' });
    linkOidc(db);

    const user = await getRequestUser(oidcRequest({ sub: 'sub-1', picture: '   ' }));

    expect(user.avatarUrl).toBeFalsy();
  });

  it('claims a folder name for it if it has none yet', async () => {
    const { getRequestUser, db } = await build();
    seedAccount(db, { folderName: null });
    linkOidc(db);

    const user = await getRequestUser(oidcRequest({ sub: 'sub-1' }));

    expect(user.personalFolderName).toBeTruthy();
  });
});

describe('an OIDC session for an account with no row yet', () => {
  const claims = {
    sub: 'sub-unsynced',
    email: 'Someone@Example.com',
    preferred_username: 'someone',
    name: 'Someone',
  };

  it('is answered from the claims', async () => {
    const { getRequestUser } = await build();

    const user = await getRequestUser(oidcRequest(claims));

    expect(user).toMatchObject({ id: 'oidc:sub-unsynced', provider: 'oidc', username: 'someone' });
  });

  it('normalises the email', async () => {
    const { getRequestUser } = await build();

    const user = await getRequestUser(oidcRequest(claims));

    expect(user.email).toBe('someone@example.com');
  });

  /**
   * The defect this file was written for. Without a name of its own the folder
   * is derived, and `username` is the first candidate in the order the
   * documentation recommends — so two identities sharing a preferred username
   * would be handed the same directory, with no row for the claim to protect.
   */
  it('carries a folder name of its own', async () => {
    const { getRequestUser } = await build();

    const user = await getRequestUser(oidcRequest(claims));

    expect(user.personalFolderName).toBeTruthy();
  });

  it('takes that name from the subject, not from the username', async () => {
    const { getRequestUser } = await build();

    const user = await getRequestUser(oidcRequest(claims));

    expect(user.personalFolderName).toContain('sub-unsynced');
    expect(user.personalFolderName).not.toBe('someone');
  });

  it('gives two identities sharing a username two different folders', async () => {
    const { getRequestUser } = await build();

    const first = await getRequestUser(oidcRequest({ ...claims, sub: 'sub-a' }));
    const second = await getRequestUser(oidcRequest({ ...claims, sub: 'sub-b' }));

    expect(first.personalFolderName).not.toBe(second.personalFolderName);
  });

  /** With auto-creation off, an unknown subject is nobody rather than somebody. */
  it('is nobody when accounts are not created automatically', async () => {
    const { getRequestUser } = await build({ OIDC_AUTO_CREATE_USERS: 'false' });

    expect(await getRequestUser(oidcRequest(claims))).toBeNull();
  });
});

describe('a request with nothing to go on', () => {
  it('is nobody', async () => {
    const { getRequestUser } = await build();

    expect(await getRequestUser({})).toBeNull();
  });

  it('is nobody when there is no request at all', async () => {
    const { getRequestUser } = await build();

    expect(await getRequestUser(undefined)).toBeNull();
  });
});
