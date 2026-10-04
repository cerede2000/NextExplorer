import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import http from 'node:http';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

/**
 * Everything a share's visitor asks for, under the share's own prefix.
 *
 * A visitor used to ask at the application's own addresses — `/api/preview`,
 * `/api/download`, `/api/thumbnails/…`. The server checked the share behind each
 * of them, so none of it was open; but a share is what somebody opens from the far
 * side of an authentication proxy, and such a proxy lets a public link through by
 * path. With a visitor's requests scattered across the API, letting the link
 * through meant opening `/api/download` to the world, for every file in the
 * instance and not just the shared one.
 *
 * So the same handlers also answer under `/api/share/<token>/…`. The claim that
 * makes this safe is the one this file exists to hold: **the prefix adds a
 * requirement and removes none.** It is never anonymous, a guest session is only
 * good for the share it was issued for, and the handler's own access check runs
 * afterwards, unchanged.
 */

let envContext;

/** The stand-in Document Server's port, named in the environment above. */
const DOCUMENT_SERVER_PORT = 45197;

const buildApp = ({ user } = {}) => {
  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');

  const registerRoutes = envContext.requireFresh('src/routes/index');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
  const authMiddleware = envContext.requireFresh('src/middleware/authMiddleware');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.session = user ? { localUserId: user.id } : {};
    next();
  });
  app.use(authMiddleware);
  registerRoutes(app);
  app.use(errorHandler);
  return app;
};

/** An owner with a volume, and a public share of a folder on it. */
const seedShare = async ({
  suffix = '',
  password,
  accessMode,
  versionsVisible,
  versionsDownload,
} = {}) => {
  const usersService = envContext.requireFresh('src/services/users');
  const userVolumesService = envContext.requireFresh('src/services/userVolumesService');
  const root = path.join(envContext.tmpRoot, `scoped-volume${suffix}`);
  await fs.mkdir(path.join(root, 'handed-out'), { recursive: true });
  await fs.writeFile(path.join(root, 'handed-out', 'file.txt'), 'the shared bytes');
  await fs.writeFile(path.join(root, 'handed-out', 'report.docx'), 'not really a document');
  // The viewer only opens what it can draw, so the preview is asked about this.
  await fs.writeFile(
    path.join(root, 'handed-out', 'picture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  // Beside the shared folder, never inside it: what the prefix must not reach.
  await fs.writeFile(path.join(root, 'private.txt'), 'not shared with anybody');

  const owner = await usersService.createLocalUser({
    email: `scoped-owner${suffix}@example.com`,
    username: `scoped-owner${suffix}`,
    displayName: 'Owner',
    password: 'secret123',
    roles: ['user'],
  });
  await userVolumesService.addVolumeToUser({
    userId: owner.id,
    label: `ScopedVol${suffix}`,
    volumePath: root,
    accessMode: 'readwrite',
  });

  const created = await request(buildApp({ user: owner }))
    .post('/api/shares')
    .send({
      sourcePath: `ScopedVol${suffix}/handed-out`,
      sharingType: 'anyone',
      ...(accessMode ? { accessMode } : {}),
      ...(password ? { password } : {}),
      ...(versionsVisible === undefined ? {} : { versionsVisible }),
      ...(versionsDownload === undefined ? {} : { versionsDownload }),
    });
  expect(created.status).toBe(201);

  // A protected share hands out no session until somebody types the password,
  // which is exactly the case one of these asks about.
  const access = password
    ? null
    : await request(buildApp()).get(`/api/share/${created.body.shareToken}/access`);
  if (access) expect(access.status).toBe(200);

  return {
    owner,
    root,
    volume: `ScopedVol${suffix}`,
    token: created.body.shareToken,
    guestSession: access?.body?.guestSessionId || null,
  };
};

beforeEach(async () => {
  envContext = await setupTestEnv({
    tag: 'share-scoped-',
    // The resumable uploader is off unless an administrator turns it on, and one
    // of these asks where it tells a client to send the rest of a file.
    env: {
      USER_VOLUMES: 'true',
      UPLOAD_CHUNKED_ENABLED: 'true',
      ONLYOFFICE_URL: 'http://onlyoffice.invalid',
      ONLYOFFICE_SECRET: 'test-secret',
      PUBLIC_URL: 'https://files.example.test',
      // Where the editing server reaches this application: not the way in from
      // outside, which it cannot open.
      EDITOR_INTERNAL_URL: 'http://nextexplorer.internal:3000',
      // Where the bytes of a saved document may be fetched from: the stand-in
      // Document Server below listens here.
      ONLYOFFICE_DOWNLOAD_ORIGINS: `http://127.0.0.1:${DOCUMENT_SERVER_PORT}`,
    },
  });
});

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('the application, answering under a share prefix', () => {
  it('hands a visitor the file they came for', async () => {
    const { token, guestSession } = await seedShare();

    const preview = await request(buildApp())
      .get(`/api/share/${token}/preview`)
      .query({ path: `share/${token}/picture.png` })
      .set({ 'X-Guest-Session': guestSession });

    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toContain('image/png');
  });

  it('lets them take it away', async () => {
    const { token, guestSession } = await seedShare();

    const download = await request(buildApp())
      .post(`/api/share/${token}/download`)
      .set({ 'X-Guest-Session': guestSession })
      .send({ paths: [`share/${token}/file.txt`], basePath: `share/${token}` });

    expect(download.status).toBe(200);
  });
});

describe('what a share answers before anybody is identified', () => {
  /**
   * A visitor behind an authentication proxy reaches the share's prefix and
   * nothing else. Both of these are already answered to anybody at their own
   * addresses, and falling back to defaults is not good enough: whether this
   * installation has an office editor at all is one of these flags.
   */
  it('tells the page what it is drawing itself with', async () => {
    const { token } = await seedShare({ suffix: '-chrome' });
    const app = buildApp();

    const features = await request(app).get(`/api/share/${token}/features`);
    const branding = await request(app).get(`/api/share/${token}/branding`);

    expect(features.status).toBe(200);
    expect(branding.status).toBe(200);
    // The same answer as the address every other page reads them at.
    expect(features.body).toEqual((await request(app).get('/api/features')).body);
    expect(branding.body).toEqual((await request(app).get('/api/branding')).body);
  });
});

/**
 * The logo a share's page draws itself with.
 *
 * A chosen logo is a file this application holds, served at `/static/logos/<name>`
 * — a path of its own in front of an authentication proxy, exactly like the
 * `/logo.svg` that sent the default one to a broken image. So the branding a
 * share's page reads points at the logo under the share's own prefix, and the
 * bytes are there: before anybody is identified, because the door of a
 * password-protected share draws the logo too.
 */
describe('a logo somebody chose, inside a share', () => {
  /**
   * A logo chosen earlier: the file where the upload puts it, and the branding
   * pointing at it. Written rather than uploaded — the upload is an
   * administrator's endpoint and the share's owner is not one, and what this is
   * about is the address, not how the bytes got there.
   */
  const withALogo = async () => {
    const name = 'logo-11111111-2222-3333-4444-555555555555.png';
    const logos = path.join(envContext.configDir, 'logos');
    await fs.mkdir(logos, { recursive: true });
    await fs.writeFile(
      path.join(logos, name),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      )
    );

    const db = await envContext.requireFresh('src/services/db').getDb();
    db.prepare(
      `INSERT OR REPLACE INTO system_settings (id, category, key, value, updated_at)
       VALUES ('branding', 'branding', 'branding', ?, ?)`
    ).run(
      JSON.stringify({
        appName: 'Explorer',
        appLogoUrl: `/static/logos/${name}`,
        showPoweredBy: false,
      }),
      new Date().toISOString()
    );
    return `/static/logos/${name}`;
  };

  it('is pointed at under the share prefix, and served there to anybody', async () => {
    const { token } = await seedShare({ suffix: '-logo' });
    const stored = await withALogo();
    expect(stored).toMatch(/^\/static\/logos\//);

    // Read with nothing at all: no account, no guest session — the door's own case.
    const app = buildApp();
    const branding = await request(app).get(`/api/share/${token}/branding`);

    expect(branding.status, branding.text).toBe(200);
    expect(branding.body.appLogoUrl).toBe(
      `/api/share/${token}/branding/logo/${stored.slice('/static/logos/'.length)}`
    );

    const bytes = await request(app).get(branding.body.appLogoUrl);
    expect(bytes.status, bytes.text).toBe(200);
    expect(bytes.headers['content-type']).toContain('image/png');
    // The same sandbox `/static/logos` is served with: a logo may be an SVG.
    expect(bytes.headers['content-security-policy']).toBe('sandbox');
  });

  /** And every other page is told what the settings hold, as it always was. */
  it('is where the settings say for a page that is not a share', async () => {
    await seedShare({ suffix: '-logo-outside' });
    const stored = await withALogo();

    const branding = await request(buildApp()).get('/api/branding');

    expect(branding.body.appLogoUrl).toBe(stored);
  });
});

describe('an office document inside a share', () => {
  /**
   * The Document Server fetches the file and reports back to it, from wherever it
   * runs — through the same front door the reader came in by. Told to fetch
   * `/api/onlyoffice/file`, an authentication proxy that lets the public link
   * through and nothing else refuses it, and the editor says it cannot download
   * the document and then cannot save it.
   */
  it('is handed to the editing server under the share prefix', async () => {
    const { token, guestSession } = await seedShare({
      suffix: '-office',
      accessMode: 'readwrite',
    });

    const config = await request(buildApp())
      .post(`/api/share/${token}/onlyoffice/config`)
      .set({ 'X-Guest-Session': guestSession })
      .send({ path: `share/${token}/report.docx`, mode: 'edit' });

    expect(config.status, config.text).toBe(200);
    expect(config.body.config.document.url).toContain(`/api/share/${token}/onlyoffice/file`);
    expect(config.body.config.editorConfig.callbackUrl).toContain(
      `/api/share/${token}/onlyoffice/callback`
    );
  });

  /**
   * And that address answers the server it was given to.
   *
   * The Document Server carries no cookie, no session and no account — it has
   * the signed token in the address and nothing else. This takes the URL the
   * configuration hands out and fetches it exactly as it would: refused, the
   * editor says it failed to download the document, and then that it cannot
   * save it.
   */
  it('answers the server it was given to, which carries nothing', async () => {
    const { token, guestSession } = await seedShare({ suffix: '-fetch' });

    const config = await request(buildApp())
      .post(`/api/share/${token}/onlyoffice/config`)
      .set({ 'X-Guest-Session': guestSession })
      .send({ path: `share/${token}/report.docx`, mode: 'edit' });
    expect(config.status, config.text).toBe(200);

    // Signed the way the Document Server signs its own requests: the shared
    // secret, in an Authorization header, and nothing else about who it is.
    const jwt = require('jsonwebtoken');
    const asTheEditor = jwt.sign({ fetch: true }, 'test-secret', { algorithm: 'HS256' });

    const handedOut = new URL(config.body.config.document.url);
    const fetched = await request(buildApp())
      .get(`${handedOut.pathname}${handedOut.search}`)
      .set({ Authorization: `Bearer ${asTheEditor}` })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(fetched.status, fetched.text).toBe(200);
    expect(fetched.body.toString()).toContain('not really a document');
  });

  /**
   * And it is told to come back to an address it can actually reach.
   *
   * ONLYOFFICE fetches and reports from wherever it runs. Given the way in from
   * outside, it meets the authentication proxy and has nothing to show it. Given
   * the application's own address on the network it shares with it, it meets
   * nothing at all — which is why a document outside a share works without a
   * single path being opened in the proxy.
   */
  it('is told to come back to the address the editing server can reach', async () => {
    const { token, guestSession } = await seedShare({ suffix: '-internal' });

    const config = await request(buildApp())
      .post(`/api/share/${token}/onlyoffice/config`)
      .set({ 'X-Guest-Session': guestSession })
      .send({ path: `share/${token}/report.docx`, mode: 'edit' });

    expect(config.status, config.text).toBe(200);
    expect(config.body.config.document.url.startsWith('http://nextexplorer.internal:3000/')).toBe(
      true
    );
    expect(
      config.body.config.editorConfig.callbackUrl.startsWith('http://nextexplorer.internal:3000/')
    ).toBe(true);
    // And the page itself is still told the name people reach it by.
    expect(config.body.config.document.url).toContain(`/api/share/${token}/onlyoffice/file`);
  });

  /**
   * And it is heard when it reports back.
   *
   * Saving is the Document Server POSTing to the callback it was given. Refused
   * there, the editor says it cannot save the document and offers a download
   * instead — which is what a reader saw.
   */
  it('hears that server report the document back', async () => {
    const { token, guestSession } = await seedShare({
      suffix: '-callback-post',
      accessMode: 'readwrite',
    });

    const config = await request(buildApp())
      .post(`/api/share/${token}/onlyoffice/config`)
      .set({ 'X-Guest-Session': guestSession })
      .send({ path: `share/${token}/report.docx`, mode: 'edit' });
    expect(config.status, config.text).toBe(200);

    const jwt = require('jsonwebtoken');
    const reported = new URL(config.body.config.editorConfig.callbackUrl);
    // status 1 is "a user is editing": nothing to write, everything to check.
    const body = { status: 1, key: config.body.config.document.key, users: [] };
    const answer = await request(buildApp())
      .post(`${reported.pathname}${reported.search}`)
      .set({ Authorization: `Bearer ${jwt.sign({ payload: body }, 'test-secret')}` })
      .send(body);

    expect(answer.status, answer.text).toBe(200);
    expect(answer.body).toMatchObject({ error: 0 });
  });

  /** And those two are answered to it, which carries no session of any kind. */
  it('is fetched by an editing server that is signed in to nothing', async () => {
    const { token } = await seedShare({ suffix: '-callback' });
    const authMiddleware = envContext.requireFresh('src/middleware/authMiddleware');

    const reached = async (path) => {
      let refused = false;
      const res = {
        status: () => ({
          json: () => {
            refused = true;
          },
        }),
      };
      await authMiddleware(
        { path, method: 'GET', headers: {}, cookies: {}, session: {} },
        res,
        () => {}
      );
      return !refused;
    };

    expect(await reached(`/api/share/${token}/onlyoffice/file`)).toBe(true);
    expect(await reached(`/api/share/${token}/onlyoffice/callback`)).toBe(true);
    // Not everything under the prefix: only the two the editor is given.
    expect(await reached(`/api/share/${token}/onlyoffice/config`)).toBe(false);
  });
});

describe('an office document saved from inside a share', () => {
  /**
   * What saving is, from the server's side: the Document Server posts to the
   * callback with the status that means "the document is finished" and a URL to
   * fetch the new bytes from. This stands in for it, so that what is asserted is
   * the file on the disk and the state it replaced — not that a route answered.
   */
  const asTheDocumentServer = async (run) => {
    const stub = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('edited by a visitor');
    });
    await new Promise((resolve, reject) => {
      stub.once('error', reject);
      stub.listen(DOCUMENT_SERVER_PORT, '127.0.0.1', resolve);
    });
    try {
      return await run(`http://127.0.0.1:${DOCUMENT_SERVER_PORT}`);
    } finally {
      await new Promise((resolve) => stub.close(resolve));
    }
  };

  it('is written, and what it replaced is kept as a version', async () => {
    const seeded = await seedShare({ suffix: '-saving', accessMode: 'readwrite' });
    const { token, guestSession, owner, root } = seeded;
    const onDisk = path.join(root, 'handed-out', 'report.docx');

    await asTheDocumentServer(async (origin) => {
      const app = buildApp();
      const config = await request(app)
        .post(`/api/share/${token}/onlyoffice/config`)
        .set({ 'X-Guest-Session': guestSession })
        .send({ path: `share/${token}/report.docx`, mode: 'edit' });
      expect(config.status, config.text).toBe(200);

      const jwt = require('jsonwebtoken');
      const reported = new URL(config.body.config.editorConfig.callbackUrl);
      // 2 is "everybody has left and this is the document": a save on purpose.
      const body = {
        status: 2,
        key: config.body.config.document.key,
        url: `${origin}/edited.docx`,
        users: [],
      };
      const answer = await request(app)
        .post(`${reported.pathname}${reported.search}`)
        .set({ Authorization: `Bearer ${jwt.sign({ payload: body }, 'test-secret')}` })
        .send(body);

      expect(answer.status, answer.text).toBe(200);
      expect(answer.body).toMatchObject({ error: 0 });
    });

    expect(await fs.readFile(onDisk, 'utf8')).toBe('edited by a visitor');

    // And the owner can see what it replaced. A visitor editing somebody's file
    // without a way back to what it said is the thing versions exist to prevent.
    const history = await request(buildApp({ user: owner }))
      .get('/api/versions')
      .query({ path: `${seeded.volume}/handed-out/report.docx` });

    expect(history.status, history.text).toBe(200);
    expect(history.body.versions?.length || 0).toBeGreaterThan(0);
  });
});

/**
 * The Versions panel, inside a share.
 *
 * Everything this panel asks is `/api/versions/…`, and under a share's prefix
 * that address was served by nobody: the panel opened and answered 404. What it
 * may show has always been the share's own decision — `versionsVisible` and
 * `versionsDownload`, read by `services/versions` — and that decision is what is
 * checked here, at the address the reader's browser actually uses.
 */
describe('the history of a file inside a share', () => {
  /** Two saves, so there is something in the history to show. */
  const withHistory = async (seeded) => {
    const app = buildApp();
    for (const content of ['first words', 'second words']) {
      const written = await request(app)
        .put(`/api/share/${seeded.token}/editor/file.txt`)
        .set({ 'X-Guest-Session': seeded.guestSession })
        .send({ content });
      expect(written.status, written.text).toBe(200);
    }
    return seeded;
  };

  it('is shown to the visitor when the share shows it', async () => {
    const seeded = await withHistory(
      await seedShare({
        suffix: '-history',
        accessMode: 'readwrite',
        versionsVisible: true,
        versionsDownload: true,
      })
    );

    const history = await request(buildApp())
      .get(`/api/share/${seeded.token}/versions`)
      .query({ path: `share/${seeded.token}/file.txt` })
      .set({ 'X-Guest-Session': seeded.guestSession });

    expect(history.status, history.text).toBe(200);
    expect(history.body.versions.length).toBeGreaterThan(0);
    expect(history.body.rights).toMatchObject({ see: true, download: true });
  });

  it('hands over one of them, at the address the panel links to', async () => {
    const seeded = await withHistory(
      await seedShare({
        suffix: '-version-content',
        accessMode: 'readwrite',
        versionsVisible: true,
        versionsDownload: true,
      })
    );
    const app = buildApp();
    const history = await request(app)
      .get(`/api/share/${seeded.token}/versions`)
      .query({ path: `share/${seeded.token}/file.txt` })
      .set({ 'X-Guest-Session': seeded.guestSession });
    expect(history.status, history.text).toBe(200);
    const oldest = history.body.versions.at(-1);

    const taken = await request(app)
      .get(`/api/share/${seeded.token}/versions/${oldest.id}/content`)
      .query({ path: `share/${seeded.token}/file.txt` })
      .set({ 'X-Guest-Session': seeded.guestSession });

    expect(taken.status, taken.text).toBe(200);
    expect(taken.headers['content-disposition']).toContain('attachment');
  });

  /**
   * And the share's own decisions still decide. The address moved; what a
   * visitor may do with a history did not.
   */
  it('is refused where the share keeps it hidden', async () => {
    const seeded = await withHistory(
      await seedShare({ suffix: '-history-off', accessMode: 'readwrite', versionsVisible: false })
    );

    const history = await request(buildApp())
      .get(`/api/share/${seeded.token}/versions`)
      .query({ path: `share/${seeded.token}/file.txt` })
      .set({ 'X-Guest-Session': seeded.guestSession });

    expect(history.status).toBe(403);
  });

  it('is shown but not handed over where the share allows only that', async () => {
    const seeded = await withHistory(
      await seedShare({
        suffix: '-no-download',
        accessMode: 'readwrite',
        versionsVisible: true,
        versionsDownload: false,
      })
    );
    const app = buildApp();
    const history = await request(app)
      .get(`/api/share/${seeded.token}/versions`)
      .query({ path: `share/${seeded.token}/file.txt` })
      .set({ 'X-Guest-Session': seeded.guestSession });
    expect(history.status, history.text).toBe(200);
    expect(history.body.rights).toMatchObject({ see: true, download: false });

    const taken = await request(app)
      .get(`/api/share/${seeded.token}/versions/${history.body.versions[0].id}/content`)
      .query({ path: `share/${seeded.token}/file.txt` })
      .set({ 'X-Guest-Session': seeded.guestSession });

    expect(taken.status).toBe(403);
  });

  it('is not a way to read the history of a file beside the share', async () => {
    const seeded = await seedShare({ suffix: '-history-outside', versionsVisible: true });

    const history = await request(buildApp())
      .get(`/api/share/${seeded.token}/versions`)
      .query({ path: `${seeded.volume}/private.txt` })
      .set({ 'X-Guest-Session': seeded.guestSession });

    expect(history.status).toBe(403);
    // Named, so that this cannot start passing for another reason: the refusal
    // is the resolution's, before any history is looked for. A path outside the
    // share is not this visitor's to resolve at all.
    expect(history.body.error.message).toMatch(/guests cannot access/i);
  });
});

/**
 * And the editor is told whether this document has a history at all.
 *
 * It asks for one the moment the reader opens its menu, so the menu entry is
 * offered from what the configuration says rather than offered and refused.
 */
describe('the history an office document offers inside a share', () => {
  const configFor = async (seeded) =>
    request(buildApp())
      .post(`/api/share/${seeded.token}/onlyoffice/config`)
      .set({ 'X-Guest-Session': seeded.guestSession })
      .send({ path: `share/${seeded.token}/report.docx`, mode: 'edit' });

  it('is offered where the share shows histories', async () => {
    const answer = await configFor(
      await seedShare({
        suffix: '-office-history',
        accessMode: 'readwrite',
        versionsVisible: true,
      })
    );

    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.versionsVisible).toBe(true);
  });

  it('is withheld where the share keeps them hidden', async () => {
    const answer = await configFor(
      await seedShare({
        suffix: '-office-no-history',
        accessMode: 'readwrite',
        versionsVisible: false,
      })
    );

    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.versionsVisible).toBe(false);
  });
});

/**
 * Searching from inside a share.
 *
 * The box at the top of the window and Ctrl+K reach the same endpoint, and under
 * a share's prefix it answered 404 — a visitor typing anything was told nothing
 * at all. The search itself already resolved the folder it was given with the
 * visitor's own rights, which is what keeps the answer inside the share.
 */
describe('a search made from inside a share', () => {
  it('answers with what is in the share', async () => {
    const { token, guestSession } = await seedShare({ suffix: '-search' });

    const found = await request(buildApp())
      .get(`/api/share/${token}/search`)
      .query({ path: `share/${token}`, q: 'file' })
      .set({ 'X-Guest-Session': guestSession });

    expect(found.status, found.text).toBe(200);
    expect(found.body.items.map((item) => item.name)).toContain('file.txt');
  });

  it('is not a way to look outside it', async () => {
    const { token, guestSession, volume } = await seedShare({ suffix: '-search-outside' });

    const found = await request(buildApp())
      .get(`/api/share/${token}/search`)
      .query({ path: volume, q: 'private' })
      .set({ 'X-Guest-Session': guestSession });

    expect(found.status).toBe(403);
  });
});

describe('a document that is not in a share at all', () => {
  /**
   * The same walk, for somebody with an account opening a document of their own.
   *
   * Everything above moved an address; none of it may move this one. The
   * configuration must still point at `/api/onlyoffice/file`, and that must still
   * answer the editing server.
   */
  it('is opened, fetched and reported back exactly as before', async () => {
    const { owner, volume } = await seedShare({ suffix: '-plain' });
    const mine = `${volume}/handed-out/report.docx`;
    const app = buildApp({ user: owner });

    const config = await request(app)
      .post('/api/onlyoffice/config')
      .send({ path: mine, mode: 'edit' });
    expect(config.status, config.text).toBe(200);
    expect(config.body.config.document.url).toContain('/api/onlyoffice/file');
    expect(config.body.config.document.url).not.toContain('/api/share/');
    expect(config.body.config.editorConfig.callbackUrl).not.toContain('/api/share/');

    const jwt = require('jsonwebtoken');
    const asTheEditor = jwt.sign({ fetch: true }, 'test-secret', { algorithm: 'HS256' });
    const handedOut = new URL(config.body.config.document.url);

    const fetched = await request(buildApp())
      .get(`${handedOut.pathname}${handedOut.search}`)
      .set({ Authorization: `Bearer ${asTheEditor}` })
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(fetched.status, fetched.text).toBe(200);
    expect(fetched.body.toString()).toContain('not really a document');
  });
});

describe('an upload begun under a share prefix', () => {
  /**
   * A resumable upload is told where to send the rest of itself by the answer to
   * its first request. Built from the one path the server is configured with,
   * that answer pointed at `/api/upload/tus` — an address the visitor cannot
   * reach, so every chunk after the first was refused by the proxy.
   */
  it('is told to continue under the same prefix', async () => {
    const { token, guestSession } = await seedShare({
      suffix: '-tus',
      accessMode: 'readwrite',
    });

    const created = await request(buildApp())
      .post(`/api/share/${token}/upload/tus`)
      .set({
        'X-Guest-Session': guestSession,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '19',
        'Upload-Metadata': `uploadTo ${Buffer.from(`share/${token}`).toString('base64')},name ${Buffer.from('left-here.txt').toString('base64')}`,
      });

    expect(created.status, created.text || JSON.stringify(created.body)).toBe(201);
    expect(created.headers.location).toContain(`/api/share/${token}/upload/tus/`);
    expect(created.headers.location).not.toContain('/api/upload/tus');
  });
});

describe('what the share prefix refuses', () => {
  it('refuses anybody carrying nothing at all', async () => {
    const { token } = await seedShare();

    const preview = await request(buildApp())
      .get(`/api/share/${token}/preview`)
      .query({ path: `share/${token}/file.txt` });

    expect(preview.status).toBe(401);
  });

  it('refuses a session issued for another share', async () => {
    const mine = await seedShare();
    const theirs = await seedShare({ suffix: '-2' });

    const preview = await request(buildApp())
      .get(`/api/share/${theirs.token}/preview`)
      .query({ path: `share/${theirs.token}/file.txt` })
      .set({ 'X-Guest-Session': mine.guestSession });

    expect(preview.status).toBe(403);
  });

  /**
   * The prefix is an address, not a right. A visitor holding a session for a
   * share cannot use it to ask about anything outside that share — the handler
   * resolves the path it was given, exactly as it does at its own address.
   */
  it('refuses a path outside the share it was issued for', async () => {
    const { token, volume, guestSession } = await seedShare();

    for (const outside of [`${volume}/private.txt`, 'personal/anything.txt']) {
      const preview = await request(buildApp())
        .get(`/api/share/${token}/preview`)
        .query({ path: outside })
        .set({ 'X-Guest-Session': guestSession });

      expect(preview.status, outside).toBe(403);
    }
  });

  it('refuses a token that names no share', async () => {
    const { guestSession } = await seedShare();

    const preview = await request(buildApp())
      .get('/api/share/not-a-share/preview')
      .query({ path: 'share/not-a-share/file.txt' })
      .set({ 'X-Guest-Session': guestSession });

    expect(preview.status).toBe(404);
  });

  /**
   * A password is what the session proves. Without one the prefix is shut, which
   * is the same answer `/api/preview` gives — and the point is that it is the
   * same answer: moving the address moved no decision.
   */
  it('refuses a protected share to somebody who never typed the password', async () => {
    const { token } = await seedShare({ suffix: '-3', password: 'open-sesame' });

    const preview = await request(buildApp())
      .get(`/api/share/${token}/preview`)
      .query({ path: `share/${token}/file.txt` });

    expect(preview.status).toBe(401);
  });
});
