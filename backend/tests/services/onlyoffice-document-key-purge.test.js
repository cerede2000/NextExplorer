import { afterEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * ONLYOFFICE document keys past their expiry.
 *
 * A key past its expiry is never handed out again, yet its row stayed: only a
 * terminal callback from the Document Server released one, and an editor that
 * never sent it — a closed browser, a restarted server — left a row for every
 * document ever opened. The hourly expiry sweep now removes them.
 */

let env;

afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

const STAT = { mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000, size: 4096 };
const DAY = 24 * 60 * 60 * 1000;

const setup = async () => {
  env = await setupTestEnv({ tag: 'onlyoffice-key-purge-' });
  const keys = require(modulePath('src/services/onlyofficeDocumentKeyService'));
  const db = await require(modulePath('src/services/db')).getDb();
  const open = (relativePath) =>
    keys.resolveDocumentKey({ relativePath, stat: STAT, documentType: 'word', inUse: false });
  const expire = (relativePath, msAgo) =>
    db
      .prepare('UPDATE onlyoffice_document_keys SET expires_at = ? WHERE relative_path = ?')
      .run(new Date(Date.now() - msAgo).toISOString(), relativePath);
  const paths = () =>
    db
      .prepare('SELECT relative_path FROM onlyoffice_document_keys ORDER BY relative_path')
      .all()
      .map((row) => row.relative_path);
  return { keys, open, expire, paths };
};

describe('purging ONLYOFFICE document keys', () => {
  it('removes the keys past their expiry, and only those', async () => {
    const { keys, open, expire, paths } = await setup();
    await open('closed-a minute ago.docx');
    await open('closed-a month ago.docx');
    const stillOpen = await open('open.docx');
    expire('closed-a minute ago.docx', 60 * 1000);
    expire('closed-a month ago.docx', 30 * DAY);

    await expect(keys.purgeExpiredDocumentKeys()).resolves.toBe(2);

    expect(paths()).toEqual(['open.docx']);
    // The one still in use keeps its key: its editors share it.
    await expect(open('open.docx')).resolves.toBe(stillOpen);
  });

  it('has nothing to do when every key is current', async () => {
    const { keys, open, paths } = await setup();
    await open('report.docx');

    await expect(keys.purgeExpiredDocumentKeys()).resolves.toBe(0);
    expect(paths()).toEqual(['report.docx']);
  });
});
