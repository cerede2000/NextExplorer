import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every address the upload path builds is the share's, inside a share.
 *
 * A visitor holding a link asks for the same things as anybody else, and a
 * share answers them under its own prefix so that one rule in front of this
 * application can let a public link through without opening the rest of the
 * API. `shareScoped` is where that is applied — and it has to be applied at
 * *every* place an address is built, which is the half that is easy to miss.
 *
 * It was missed. The resumable uploader holds one endpoint for all its files
 * and it is set twice: once when the plugin is put in, and again as each file
 * is queued. Only the second was scoped. The first is reached exactly when the
 * upload switches itself to chunks — which is what happens to a file too big
 * to go in one piece, the one case a visitor cannot work around — so a visitor
 * dropping a large file into a shared folder had it refused for its size, saw
 * the switch to chunks happen, and then had the first chunk answered by the
 * authentication proxy instead of by this server.
 *
 * So this does not check an address. It checks that **none is built any other
 * way**, by reading the source and refusing anything left over: a new endpoint
 * added here without a prefix fails this, which is what the one that was added
 * without a prefix did not do.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The files that build the addresses a visitor's bytes travel to. */
const SOURCES = ['uploadEngine.js', 'fileUploader.js'];

/** Import lines name modules, not endpoints: `@/api/shareScope` is not a call. */
const withoutImports = (source) =>
  source
    .split('\n')
    .filter((line) => !/^\s*import\b/.test(line))
    .join('\n');

/** What is left once every properly prefixed address is taken out. */
const unscopedAddressesIn = (source) => {
  const scopedRemoved = withoutImports(source).replace(/shareScoped\(\s*'\/api\/[^']*'/g, '');
  return [...new Set(scopedRemoved.match(/\/api\/[A-Za-z0-9/_.-]*/g) || [])];
};

describe('the addresses an upload is sent to', () => {
  for (const name of SOURCES) {
    it(`are all asked under the share's prefix in ${name}`, () => {
      const source = fs.readFileSync(
        path.join(here, name === 'fileUploader.js' ? name : name),
        'utf8'
      );

      expect(unscopedAddressesIn(source)).toEqual([]);
    });
  }

  // The instrument itself: a file that names an address outside `shareScoped`
  // has to be reported, or the three cases above would pass on anything.
  it('reports an address that is not', () => {
    const careless = `
      import { shareScoped } from '@/api/shareScope';
      const good = shareScoped('/api/upload/finalizations', here);
      const bad = \`\${apiBase}/api/upload/tus\`;
    `;

    expect(unscopedAddressesIn(careless)).toEqual(['/api/upload/tus']);
  });
});
