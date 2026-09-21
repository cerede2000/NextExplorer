/**
 * Write the API's description where the documentation site publishes it.
 *
 *   npm run openapi            → ../docs/public/openapi.json
 *   node src/scripts/writeOpenApi.js <file>
 *
 * The documentation's copy carries no version: it describes the release the
 * site was built from, and an instance serves its own at `/api/openapi.json`.
 * A test fails when the copy is behind the description, which is the reminder
 * to run this.
 */
const fs = require('fs');
const path = require('path');

const { buildOpenApi } = require('../openapi');

const target = path.resolve(
  process.argv[2] || path.join(__dirname, '..', '..', '..', 'docs', 'public', 'openapi.json')
);

const main = async () => {
  let text = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
  try {
    // In the repository's own style, so the format check has nothing to say.
    const prettier = require('prettier');
    const options = (await prettier.resolveConfig(target)) || {};
    text = await prettier.format(text, { ...options, filepath: target });
  } catch {
    // Without Prettier the content is the same; only the layout differs.
  }
  fs.writeFileSync(target, text);
  process.stdout.write(`Wrote ${path.relative(process.cwd(), target)}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
