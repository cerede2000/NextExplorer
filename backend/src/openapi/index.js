const fs = require('fs');
const path = require('path');

const { schemas, responses, securitySchemes } = require('./components');

/**
 * The HTTP API, described.
 *
 * Written by hand, as the reference page is, and held to the application by
 * tests rather than generated from it: every route the application mounts is
 * described here and nothing else is, the rules on who may call what agree
 * with the gates that enforce them, and the shapes were written from — and are
 * checked against — what a walk through the API really answers.
 *
 * Nothing here reads the configuration. The description is the same for every
 * installation of a release; which integrations one has switched on is
 * `GET /api/features`’s business.
 */

const AREAS = ['auth', 'browsing', 'files', 'shares', 'keeping', 'admin', 'integrations'];

const TAGS = [
  ['Accounts and signing in', 'Sessions, passwords, second factors and passkeys.'],
  ['API tokens', 'Credentials for scripts, managed from a session.'],
  ['Browsing', 'Volumes, folders and what is known about a file.'],
  ['Search', 'Names and contents.'],
  ['Files', 'Making, renaming, copying, moving, deleting and downloading.'],
  ['Editing', 'Text files, read and saved.'],
  ['Previews', 'Thumbnails, media and what the viewer shows.'],
  ['Archives', 'Looking inside, taking out, making and unpacking.'],
  ['Uploads', 'In one request, or resumable over TUS.'],
  ['Folder sizes', 'What a folder holds, from the folder-size index.'],
  ['Sharing', 'Links and shares, made and managed by their owner.'],
  ['Shared links', 'What somebody holding a link can do with it.'],
  ['Trash', 'What was deleted, and bringing it back.'],
  ['Versions', 'Earlier contents of a file.'],
  ['Favourites', 'Folders kept at hand.'],
  ['Settings', 'The installation’s and the account’s.'],
  ['Accounts (administration)', 'Accounts, and the volumes assigned to them.'],
  ['Administration', 'The activity log, the server’s files, the terminal.'],
  ['ONLYOFFICE', 'Mounted only where ONLYOFFICE is configured.'],
  ['Collabora', 'Mounted only where Collabora is configured.'],
  ['Health', 'For probes; outside `/api`.'],
];

const DESCRIPTION = `Everything the interface does, it does over this API: there is no reduced
API for automation.

**Signing in.** A script should use an API token, from Settings → API tokens,
in \`Authorization: Bearer nxe_…\`. A \`read\` token reaches reads only; no
token reaches the account, administration, the terminal or the editor
integrations. The interface uses a session cookie from \`POST /api/auth/login\`.
Who may call each operation is in its security requirements and, in words, in
\`x-access\`.

**Paths.** Files are named by where they are: a volume path
(\`Documents/2026/report.pdf\`), \`personal/…\` for the account’s own folder, an
assigned volume’s label, or \`share/<token>/…\` inside a link.

**Errors** are JSON and carry a \`requestId\` that also appears in the server
log. **Nothing is ever written over:** a name already taken becomes \`name (1)\`.

**Not versioned.** This is the interface’s own API and changes with it; an
instance serves the description of its own release at \`/api/openapi.json\`.`;

const appVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))
      .version;
  } catch {
    return null;
  }
};

/**
 * @param {object} [options]
 * @param {string} [options.version]  the release being described; the
 *   documentation's copy leaves it out, so a release does not change it
 */
const buildOpenApi = ({ version } = {}) => {
  const paths = {};
  for (const area of AREAS) {
    for (const [route, operations] of Object.entries(require(`./paths/${area}`))) {
      if (paths[route]) throw new Error(`${route} is described twice`);
      paths[route] = operations;
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'NextExplorer API',
      version: version || 'unversioned',
      description: DESCRIPTION,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/', description: 'The instance serving this description.' }],
    tags: TAGS.map(([name, description]) => ({ name, description })),
    security: [{ session: [] }, { apiToken: [] }],
    paths,
    components: { schemas, responses, securitySchemes },
  };
};

module.exports = { buildOpenApi, appVersion };
