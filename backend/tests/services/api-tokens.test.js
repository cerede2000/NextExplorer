import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What the token store holds, and what it refuses to hand back.
 *
 * The routes cover somebody issuing a token from the interface; this covers
 * the properties the interface cannot show — that the value is not in the
 * table, that a revoked row can never authenticate again, that a token belongs
 * to one account and answers to no other. Each of those is the difference
 * between a credential and a liability.
 */

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'api-tokens-service-' });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  const now = new Date().toISOString();
  const addUser = db.prepare(
    `INSERT INTO users (id, email, email_verified, username, display_name, roles, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, '["user"]', ?, ?)`
  );
  addUser.run('u1', 'someone@example.com', 'someone', 'Someone', now, now);
  addUser.run('u2', 'other@example.com', 'other', 'Other', now, now);

  const apiTokens = currentEnv.requireFresh('src/services/apiTokens');
  apiTokens.forgetUseThrottles();
  return { db, apiTokens };
};

/**
 * The secret half of a token value.
 *
 * Not `split('_')`: the secret is base64url, whose alphabet includes `_`, so
 * splitting on it returns a fragment about half the time — and a test that
 * searches for a fragment of the secret is a test that would pass while the
 * whole of it sat in the reply. The identifier is fixed-length hexadecimal,
 * so the separator that matters is the second underscore and no other.
 */
const secretHalf = (token) => String(token).slice(String(token).indexOf('_', 4) + 1);

const mint = async (apiTokens, options = {}) => {
  const outcome = await apiTokens.mintToken({ userId: 'u1', name: 'Backup script', ...options });
  expect(outcome.error).toBeUndefined();
  return outcome;
};

describe('the API token store', () => {
  it('hands the value back once and keeps no readable copy of it', async () => {
    const { db, apiTokens } = await seed();
    const { secret, token } = await mint(apiTokens);

    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(token.id);

    // The secret half appears nowhere in the row — not in the hash, not in a
    // column somebody added later without thinking about it.
    const stored = JSON.stringify(row);
    const half = secretHalf(secret);
    expect(half.length).toBe(43);
    expect(stored).not.toContain(half);
    expect(stored).not.toContain(secret);

    // What it does hold is the hash, and the hash is of the secret half only.
    expect(row.secret_hash).toBe(crypto.createHash('sha256').update(half).digest('hex'));

    // And nothing that lists tokens ever carries it.
    const [listed] = await apiTokens.listTokens('u1');
    expect(JSON.stringify(listed)).not.toContain(half);
  });

  it('names itself, so a leaked value can be recognised and looked up', async () => {
    const { apiTokens } = await seed();
    const { secret, token } = await mint(apiTokens);

    expect(secret.startsWith('nxe_')).toBe(true);
    expect(apiTokens.parseToken(secret)).toEqual({ id: token.id, secret: expect.any(String) });
    expect(apiTokens.TOKEN_PATTERN.test(secret)).toBe(true);
  });

  it('draws a different value every time', async () => {
    const { apiTokens } = await seed();
    const values = new Set();
    for (let index = 0; index < 20; index += 1) {
      const { secret } = await mint(apiTokens, { name: `Token ${index}` });
      values.add(secret);
    }
    expect(values.size).toBe(20);
  });

  it('authenticates the value it issued, and nothing near it', async () => {
    const { apiTokens } = await seed();
    const { secret, token } = await mint(apiTokens, { scope: 'write' });

    const good = await apiTokens.authenticateToken(secret);
    expect(good).toMatchObject({ ok: true, userId: 'u1', tokenId: token.id, scope: 'write' });

    // The identifier is sixteen hexadecimal characters after `nxe_`, and the
    // secret is everything after it — which may itself contain an underscore,
    // so neither half is found by splitting on one.
    const id = secret.slice(4, 20);
    const value = secretHalf(secret);
    expect(value.length).toBe(43);
    const nearMisses = [
      `nxe_${id}_${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`, // one character out
      `nxe_${'0'.repeat(16)}_${value}`, // right secret, wrong name
      `nxe_${id}_${value.slice(0, -1)}`, // truncated
      `nxe_${id}_${value}x`, // lengthened
      secret.toUpperCase(),
      secret.replace('nxe_', 'nxf_'),
      '',
      'Bearer',
      null,
      undefined,
      42,
      {},
    ];

    for (const candidate of nearMisses) {
      const outcome = await apiTokens.authenticateToken(candidate);
      expect(outcome.ok, `accepted ${String(candidate)}`).toBe(false);
    }
  });

  it('works when the secret contains the character that separates the halves', async () => {
    const { apiTokens } = await seed();

    // base64url includes `_`, so about half of all secrets contain one. Both
    // halves are found by position rather than by splitting — the identifier
    // is sixteen hexadecimal characters — and a value that happens to carry an
    // underscore has to authenticate like any other.
    let withUnderscore = null;
    for (let attempt = 0; attempt < 60 && !withUnderscore; attempt += 1) {
      const minted = await mint(apiTokens, { name: `n${attempt}` });
      if (secretHalf(minted.secret).includes('_')) withUnderscore = minted;
    }
    expect(withUnderscore, 'sixty secrets and not one underscore').not.toBeNull();

    const parsed = apiTokens.parseToken(withUnderscore.secret);
    expect(parsed.id).toBe(withUnderscore.token.id);
    expect(parsed.secret).toBe(secretHalf(withUnderscore.secret));
    expect(await apiTokens.authenticateToken(withUnderscore.secret)).toMatchObject({
      ok: true,
      tokenId: withUnderscore.token.id,
    });
  });

  it('refuses what it cannot parse before the database is ever asked', async () => {
    const { apiTokens } = await seed();

    // An identifier is matched as sixteen hexadecimal characters, so nothing
    // else can reach a query in its place.
    expect(apiTokens.parseToken("nxe_' OR 1=1 --_aaaa")).toBeNull();
    expect(apiTokens.parseToken('nxe_../../etc/passwd_aaaa')).toBeNull();
    expect(apiTokens.parseToken(`nxe_${'a'.repeat(16)}_${'A'.repeat(43)}`)).toEqual({
      id: 'a'.repeat(16),
      secret: 'A'.repeat(43),
    });
    expect(apiTokens.parseToken(`nxe_${'g'.repeat(16)}_${'A'.repeat(43)}`)).toBeNull();
  });

  it('stops working the moment it is revoked, and says which token it was', async () => {
    const { db, apiTokens } = await seed();
    const { secret, token } = await mint(apiTokens);

    expect((await apiTokens.authenticateToken(secret)).ok).toBe(true);
    expect(await apiTokens.revokeToken({ userId: 'u1', id: token.id })).toMatchObject({
      revoked: true,
    });

    const refused = await apiTokens.authenticateToken(secret);
    expect(refused).toMatchObject({ ok: false, reason: 'revoked', tokenId: token.id });

    // The row stays as a tombstone, and holds nothing that could authenticate.
    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(token.id);
    expect(row.revoked_at).toBeTruthy();
    expect(row.secret_hash).toBe('revoked');

    // And it is gone from the account's list.
    expect(await apiTokens.listTokens('u1')).toEqual([]);
  });

  it('refuses a token past its day', async () => {
    const { db, apiTokens } = await seed();
    const { secret, token } = await mint(apiTokens, { expiresInDays: 30 });

    expect(token.expiresAt).toBeTruthy();
    expect((await apiTokens.authenticateToken(secret)).ok).toBe(true);

    db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      token.id
    );

    expect(await apiTokens.authenticateToken(secret)).toMatchObject({
      ok: false,
      reason: 'expired',
      tokenId: token.id,
    });
  });

  it('refuses an expiry that is not a number of days it will honour', async () => {
    const { apiTokens } = await seed();
    for (const expiresInDays of [0, -1, 'soon', Number.NaN, Infinity, 3651]) {
      expect(await apiTokens.mintToken({ userId: 'u1', expiresInDays })).toEqual({
        error: 'expiry',
      });
    }
    expect((await apiTokens.mintToken({ userId: 'u1', expiresInDays: null })).token.expiresAt).toBe(
      null
    );
  });

  it('refuses a scope nobody defined', async () => {
    const { apiTokens } = await seed();
    for (const scope of ['admin', 'ADMIN', 'write ', '', 'read-write', null]) {
      expect(await apiTokens.mintToken({ userId: 'u1', scope })).toEqual({ error: 'scope' });
    }
  });

  it('belongs to one account, and answers to no other', async () => {
    const { apiTokens } = await seed();
    const { token } = await mint(apiTokens);

    expect(await apiTokens.listTokens('u2')).toEqual([]);
    expect(await apiTokens.revokeToken({ userId: 'u2', id: token.id })).toEqual({ revoked: false });
    expect(
      await apiTokens.renameToken({ userId: 'u2', id: token.id, name: 'mine now' })
    ).toBeNull();

    // Still the owner's, still working, still called what it was called.
    const [held] = await apiTokens.listTokens('u1');
    expect(held.name).toBe('Backup script');
  });

  it('caps how many an account may hold', async () => {
    const { apiTokens } = await seed();
    for (let index = 0; index < apiTokens.MAX_TOKENS_PER_USER; index += 1) {
      expect(
        (await apiTokens.mintToken({ userId: 'u1', name: `n${index}` })).error
      ).toBeUndefined();
    }
    expect(await apiTokens.mintToken({ userId: 'u1' })).toEqual({ error: 'too-many' });

    // Revoking one makes room again: the cap counts live tokens, not history.
    const [first] = await apiTokens.listTokens('u1');
    await apiTokens.revokeToken({ userId: 'u1', id: first.id });
    expect((await apiTokens.mintToken({ userId: 'u1' })).error).toBeUndefined();
  });

  it('keeps names short, printable and never empty', async () => {
    const { apiTokens } = await seed();

    const { token: long } = await mint(apiTokens, { name: 'x'.repeat(500) });
    expect(long.name.length).toBe(apiTokens.MAX_NAME_LENGTH);

    const { token: nasty } = await mint(apiTokens, { name: 'one two\nthree' });
    expect(nasty.name).not.toContain(' ');
    expect(nasty.name).not.toContain('\n');

    const { token: blank } = await mint(apiTokens, { name: '   ' });
    expect(blank.name.length).toBeGreaterThan(0);
  });

  it('writes down when it was last used, and not on every request', async () => {
    const { db, apiTokens } = await seed();
    const { token } = await mint(apiTokens);

    expect(await apiTokens.noteUse({ tokenId: token.id, address: '192.168.1.7' })).toBe(true);
    const first = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(token.id);
    expect(first.last_used_at).toBeTruthy();
    expect(first.last_used_ip).toBe('192.168.1.7');

    // A second use a moment later costs no write at all.
    expect(await apiTokens.noteUse({ tokenId: token.id, address: '10.0.0.1' })).toBe(false);
    const second = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(token.id);
    expect(second.last_used_at).toBe(first.last_used_at);
    expect(second.last_used_ip).toBe('192.168.1.7');
  });

  it('says a refused token is worth reporting once an hour, not once a request', async () => {
    const { apiTokens } = await seed();
    expect(apiTokens.shouldReportRefusal('abc')).toBe(true);
    for (let index = 0; index < 100; index += 1) {
      expect(apiTokens.shouldReportRefusal('abc')).toBe(false);
    }
    expect(apiTokens.shouldReportRefusal('def')).toBe(true);
    expect(apiTokens.shouldReportRefusal(null)).toBe(false);
    expect(apiTokens.shouldReportRefusal(undefined)).toBe(false);
  });

  it('goes with the account it belongs to', async () => {
    const { db, apiTokens } = await seed();
    await mint(apiTokens);
    expect((await apiTokens.listTokens('u1')).length).toBe(1);

    db.prepare('DELETE FROM users WHERE id = ?').run('u1');

    // The cascade is the point: a way into an account must not outlive it.
    expect(db.prepare('SELECT COUNT(*) FROM api_tokens WHERE user_id = ?').pluck().get('u1')).toBe(
      0
    );
  });

  it('takes every token off an account at once when asked', async () => {
    const { apiTokens } = await seed();
    const held = [];
    for (let index = 0; index < 3; index += 1) {
      held.push(await mint(apiTokens, { name: `n${index}` }));
    }
    await apiTokens.mintToken({ userId: 'u2', name: 'theirs' });

    expect(await apiTokens.revokeAllTokens('u1')).toBe(3);
    for (const { secret } of held) {
      expect((await apiTokens.authenticateToken(secret)).ok).toBe(false);
    }
    // Somebody else's account is untouched.
    expect((await apiTokens.listTokens('u2')).length).toBe(1);
  });
});
