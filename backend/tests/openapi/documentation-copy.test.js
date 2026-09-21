import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildOpenApi } = require('../../src/openapi');

/**
 * The copy the documentation site publishes is the description, not a
 * snapshot of it that drifts: compared by content, so its layout is
 * Prettier's business and its substance is this one's.
 */
it('publishes the description as it is', () => {
  const copy = path.join(__dirname, '..', '..', '..', 'docs', 'public', 'openapi.json');
  const published = JSON.parse(fs.readFileSync(copy, 'utf8'));

  // `npm run openapi` in backend/ writes it again.
  expect(published).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
});
