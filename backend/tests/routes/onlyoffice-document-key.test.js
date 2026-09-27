import { afterEach, describe, expect, it } from 'vitest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * What makes a document the document it is, as far as the Document Server's
 * cache is concerned.
 *
 * The signature is not the key — the key is what everyone in a document shares,
 * and it deliberately outlives their saves (see onlyoffice-coediting.test.js).
 * The signature is what tells a *new* document from the one that was cached, and
 * these are the properties it has to keep.
 *
 * Previously reproduced inline here, which meant the test could keep passing
 * against a copy of the code it was supposed to be pinning.
 */

describe('ONLYOFFICE document signature', () => {
  let env;
  let buildSignature;

  const setup = async () => {
    env = await setupTestEnv({
      tag: 'onlyoffice-signature-',
      modules: ['src/services/onlyofficeDocumentKeyService'],
    });
    ({ buildSignature } = env.requireFresh('src/services/onlyofficeDocumentKeyService'));
  };

  const STAT = { mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000, size: 4096 };

  afterEach(async () => {
    if (env) {
      await env.cleanup();
      env = null;
    }
  });

  it('changes when the same file is opened with a different editor', async () => {
    // The cache holds the file as one editor prepared it. A drawing once opened
    // as a text document kept answering with that failed attempt, from cache,
    // long after the mapping was corrected — nothing was reconverted, so nothing
    // appeared in the converter logs either.
    await setup();

    expect(buildSignature('drawing.odg', STAT, 'slide')).not.toBe(
      buildSignature('drawing.odg', STAT, 'word')
    );
  });

  it('stays the same across opens while nothing changes', async () => {
    await setup();

    expect(buildSignature('report.docx', STAT, 'word')).toBe(
      buildSignature('report.docx', STAT, 'word')
    );
  });

  it('changes when the file itself changes', async () => {
    await setup();

    const before = buildSignature('report.docx', STAT, 'word');

    expect(buildSignature('report.docx', { ...STAT, mtimeMs: STAT.mtimeMs + 1 }, 'word')).not.toBe(
      before
    );
    expect(buildSignature('report.docx', { ...STAT, size: STAT.size + 1 }, 'word')).not.toBe(
      before
    );
  });

  it('separates two files that differ only by path', async () => {
    await setup();

    expect(buildSignature('a/report.docx', STAT, 'word')).not.toBe(
      buildSignature('b/report.docx', STAT, 'word')
    );
  });
});
