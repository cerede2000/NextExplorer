import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The custom logo: a file an administrator uploads, written into the config
 * directory and served to everyone, the sign-in page included.
 *
 * What is written is decided by the server, not by the upload: a name of its
 * own for every logo, and one of the three image types the page can show, at
 * no more than two megabytes. A name taken from the upload would let it choose
 * where on disk it lands.
 *
 * A logo used to be written over the one in use, under a fixed name per type,
 * as soon as it was chosen, so nothing could bring the old one back. The upload
 * is now the save: the file is written under a new name, the settings are
 * switched to it, and only then is the logo it replaced removed. A step that
 * fails leaves the logo in use as it was and nothing of the new one behind, and
 * nothing already in the directory is ever replaced.
 *
 * The admin gate on the upload route is pinned in `admin-guards.test.js`.
 */

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const OTHER_PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000020806000000', 'hex');
const OWN_NAME = /^logo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;
const FIXED_ID = '0b7f7c1e-3d44-4c55-9a8e-1f2a3b4c5d6e';

let currentEnv;

afterEach(async () => {
  vi.restoreAllMocks();
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

/**
 * @param {object} [options]
 * @param {() => void} [options.beforeRoutes] runs with fresh modules, before the
 *   routes load, so that a test can stand in for one step of the save
 */
const seed = async ({ beforeRoutes } = {}) => {
  currentEnv = await setupTestEnv({ tag: 'settings-logo-' });
  const db = await currentEnv.requireFresh('src/services/db').getDb();
  beforeRoutes?.();

  const routes = currentEnv.requireFresh('src/routes/settings');
  const { errorHandler } = currentEnv.requireFresh('src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', email: 'admin@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', routes);
  app.use(errorHandler);
  return { app, db };
};

const logoDir = () => path.join(currentEnv.configDir, 'logos');

/** The files in the logo directory, hidden ones included, or none when it was never created. */
const logoFiles = async () => {
  try {
    return (await fs.readdir(logoDir())).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false
  );

const upload = (
  app,
  buffer,
  { filename = 'logo.png', contentType = 'image/png', branding } = {}
) => {
  let pending = request(app).post('/api/settings/upload-logo');
  if (branding !== undefined) {
    pending = pending.field(
      'branding',
      typeof branding === 'string' ? branding : JSON.stringify(branding)
    );
  }
  return pending.attach('logo', buffer, { filename, contentType });
};

const storedLogo = async (app) => (await request(app).get('/api/branding')).body.appLogoUrl;

/** Branding as an earlier version left it, written straight into the database. */
const storeBranding = (db, branding) =>
  db
    .prepare(
      `INSERT INTO system_settings (id, category, key, value, updated_at)
       VALUES ('legacy-branding', 'branding', 'branding', ?, ?)`
    )
    .run(JSON.stringify(branding), new Date().toISOString());

describe('uploading a logo', () => {
  it('writes it under a name of its own, whatever the upload was called, and makes it the logo', async () => {
    const { app } = await seed();

    const response = await upload(app, PNG, { filename: '../../escape.png' });

    expect(response.status).toBe(200);
    const files = await logoFiles();
    expect(files).toEqual([expect.stringMatching(OWN_NAME)]);
    expect(response.body.logoUrl).toBe(`/static/logos/${files[0]}`);
    expect(response.body.branding.appLogoUrl).toBe(response.body.logoUrl);
    expect(await storedLogo(app)).toBe(response.body.logoUrl);
    expect(await fs.readFile(path.join(logoDir(), files[0]))).toEqual(PNG);
    expect(await exists(path.join(currentEnv.tmpRoot, 'escape.png'))).toBe(false);
  });

  it('saves the name and the footer link sent with it, in the same request', async () => {
    const { app } = await seed();

    const response = await upload(app, PNG, {
      branding: { appName: 'Files', showPoweredBy: true },
    });

    expect(response.status).toBe(200);
    expect(response.body.branding).toEqual({
      appName: 'Files',
      appLogoUrl: response.body.logoUrl,
      showPoweredBy: true,
    });
  });

  it('keeps the stored name when the one sent with it is blank, as a patch does', async () => {
    const { app } = await seed();
    await request(app)
      .patch('/api/settings')
      .send({ branding: { appName: 'Files' } });

    const response = await upload(app, PNG, { branding: { appName: '   ' } });

    expect(response.status).toBe(200);
    expect(response.body.branding.appName).toBe('Files');
  });

  it('refuses branding sent with it that is not JSON, writing nothing and changing nothing', async () => {
    const { app } = await seed();

    const response = await upload(app, PNG, { branding: '{not json' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('The branding sent with the logo is not JSON.');
    expect(await logoFiles()).toEqual([]);
    expect(await storedLogo(app)).toBe('/logo.svg');
  });

  it('refuses a file that is not an SVG, PNG or JPEG, and writes nothing', async () => {
    const { app } = await seed();

    const response = await upload(app, Buffer.from('<script>alert(1)</script>'), {
      filename: 'logo.html',
      contentType: 'text/html',
    });

    // 400, not the 500 a plain Error from the file filter used to become.
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe(
      'Invalid file type. Only SVG, PNG, and JPG are allowed.'
    );
    expect(await logoFiles()).toEqual([]);
  });

  it('refuses a logo over two megabytes, and writes nothing', async () => {
    const { app } = await seed();

    const response = await upload(app, Buffer.alloc(2 * 1024 * 1024 + 1), { filename: 'huge.png' });

    // 413 with the limit named, not multer's "File too large" as a 500.
    expect(response.status).toBe(413);
    expect(response.body.error.message).toBe('A logo can be at most 2 MB.');
    expect(await logoFiles()).toEqual([]);
  });

  it('refuses a logo sent in a field the route does not read, as a malformed request', async () => {
    const { app } = await seed();

    const response = await request(app)
      .post('/api/settings/upload-logo')
      .attach('image', PNG, { filename: 'logo.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe(
      'A file was sent in a field this request does not take.'
    );
    expect(await logoFiles()).toEqual([]);
  });
});

describe('replacing a logo', () => {
  it('puts a PNG chosen over a PNG at a new address, and removes the old one only once the new one is the logo', async () => {
    let oldFileWhenSwitched = null;
    const { app } = await seed({
      beforeRoutes: () => {
        const settings = currentEnv.requireFresh('src/services/settingsService');
        const replaceBranding = settings.replaceBranding;
        vi.spyOn(settings, 'replaceBranding').mockImplementation(async (update) => {
          const before = (await settings.getPublicSettings()).branding.appLogoUrl;
          if (before.startsWith('/static/logos/')) {
            oldFileWhenSwitched = await exists(path.join(logoDir(), before.slice(14)));
          }
          return replaceBranding(update);
        });
      },
    });
    const first = await upload(app, PNG);
    const [firstName] = await logoFiles();

    const second = await upload(app, OTHER_PNG);

    expect(second.status).toBe(200);
    expect(second.body.logoUrl).not.toBe(first.body.logoUrl);
    expect(oldFileWhenSwitched).toBe(true);
    const files = await logoFiles();
    expect(files).toEqual([expect.stringMatching(OWN_NAME)]);
    expect(files[0]).not.toBe(firstName);
    expect(await fs.readFile(path.join(logoDir(), files[0]))).toEqual(OTHER_PNG);
    expect(await storedLogo(app)).toBe(second.body.logoUrl);
  });

  it('removes what an earlier version wrote under its fixed names once a new logo is in place', async () => {
    const { app, db } = await seed();
    await fs.mkdir(logoDir(), { recursive: true });
    await fs.writeFile(path.join(logoDir(), 'custom-logo.png'), PNG);
    await fs.writeFile(path.join(logoDir(), 'custom-logo.svg'), '<svg/>');
    storeBranding(db, { appName: 'Old', appLogoUrl: '/static/logos/custom-logo.png' });

    const response = await upload(app, OTHER_PNG);

    expect(response.status).toBe(200);
    expect(await logoFiles()).toEqual([expect.stringMatching(OWN_NAME)]);
    expect(response.body.branding.appName).toBe('Old');
  });

  it('takes the next name rather than replace a file already holding the one it chose', async () => {
    const { app } = await seed();
    await fs.mkdir(logoDir(), { recursive: true });
    await fs.writeFile(path.join(logoDir(), `logo-${FIXED_ID}.png`), 'not ours');
    vi.spyOn(require('node:crypto'), 'randomUUID').mockReturnValueOnce(FIXED_ID);

    const response = await upload(app, PNG);

    expect(response.status).toBe(200);
    expect(response.body.logoUrl).toBe(`/static/logos/logo-${FIXED_ID}%20(1).png`);
    expect(await fs.readFile(path.join(logoDir(), `logo-${FIXED_ID}.png`), 'utf8')).toBe(
      'not ours'
    );
    expect(await fs.readFile(path.join(logoDir(), `logo-${FIXED_ID} (1).png`))).toEqual(PNG);

    // Replaced in turn, the logo goes, and the file that was never the logo stays.
    await upload(app, OTHER_PNG);

    const files = await logoFiles();
    expect(files).toContain(`logo-${FIXED_ID}.png`);
    expect(files).not.toContain(`logo-${FIXED_ID} (1).png`);
  });
});

describe('a logo that cannot be put in place', () => {
  it('leaves the logo in use, and removes the new file, when the settings cannot be switched to it', async () => {
    let failing = false;
    const { app } = await seed({
      beforeRoutes: () => {
        const settings = currentEnv.requireFresh('src/services/settingsService');
        const replaceBranding = settings.replaceBranding;
        vi.spyOn(settings, 'replaceBranding').mockImplementation(async (update) => {
          if (failing) throw new Error('database is locked');
          return replaceBranding(update);
        });
      },
    });
    const first = await upload(app, PNG);
    const [firstName] = await logoFiles();
    failing = true;

    const second = await upload(app, OTHER_PNG, { branding: { appName: 'Renamed' } });

    expect(second.status).toBe(500);
    expect(await logoFiles()).toEqual([firstName]);
    expect(await fs.readFile(path.join(logoDir(), firstName))).toEqual(PNG);
    const branding = (await request(app).get('/api/branding')).body;
    expect(branding.appLogoUrl).toBe(first.body.logoUrl);
    expect(branding.appName).toBe('Explorer');
  });

  it('leaves the logo in use, and nothing of the new one, when the file cannot take its name', async () => {
    let failing = false;
    const { app } = await seed({
      beforeRoutes: () => {
        const placement = currentEnv.requireFresh('src/utils/placeWithoutOverwrite');
        const place = placement.placeWithoutOverwrite;
        vi.spyOn(placement, 'placeWithoutOverwrite').mockImplementation(async (...args) => {
          if (failing) throw Object.assign(new Error('input/output error'), { code: 'EIO' });
          return place(...args);
        });
      },
    });
    const first = await upload(app, PNG);
    const [firstName] = await logoFiles();
    failing = true;

    const second = await upload(app, OTHER_PNG);

    expect(second.status).toBe(500);
    // The hidden file it was being written under is gone too.
    expect(await logoFiles()).toEqual([firstName]);
    expect(await storedLogo(app)).toBe(first.body.logoUrl);
  });
});

describe('the logo files when branding is saved', () => {
  it.each([['/logo.svg'], ['']])(
    'are removed when the logo is reset to %j, with what earlier versions left',
    async (appLogoUrl) => {
      const { app } = await seed();
      await upload(app, PNG);
      await fs.writeFile(path.join(logoDir(), 'custom-logo.svg'), '<svg/>');

      const response = await request(app).patch('/api/settings').send({ branding: { appLogoUrl } });

      expect(response.status).toBe(200);
      expect(await logoFiles()).toEqual([]);
    }
  );

  it('are kept when branding changes something other than the logo', async () => {
    const { app } = await seed();
    await upload(app, PNG);
    const before = await logoFiles();

    const response = await request(app)
      .patch('/api/settings')
      .send({ branding: { appName: 'Renamed' } });

    expect(response.status).toBe(200);
    expect(await logoFiles()).toEqual(before);
  });

  it('keep serving a logo an earlier version stored under a fixed name, with nothing to migrate', async () => {
    const { app, db } = await seed();
    await fs.mkdir(logoDir(), { recursive: true });
    await fs.writeFile(path.join(logoDir(), 'custom-logo.png'), PNG);
    storeBranding(db, { appName: 'Old', appLogoUrl: '/static/logos/custom-logo.png' });

    await request(app)
      .patch('/api/settings')
      .send({ branding: { appName: 'Renamed' } });

    expect(await storedLogo(app)).toBe('/static/logos/custom-logo.png');
    expect(await logoFiles()).toEqual(['custom-logo.png']);
  });

  it.each([['/static/logos/notes.txt'], ['/static/logos/../app.db']])(
    'never remove a file the application did not write as a logo, even when pointed at as %j',
    async (appLogoUrl) => {
      const { app } = await seed();
      await fs.mkdir(logoDir(), { recursive: true });
      await fs.writeFile(path.join(logoDir(), 'notes.txt'), 'someone else’s');
      await request(app).patch('/api/settings').send({ branding: { appLogoUrl } });

      await request(app)
        .patch('/api/settings')
        .send({ branding: { appLogoUrl: '/logo.svg' } });

      expect(await logoFiles()).toEqual(['notes.txt']);
      expect(await exists(path.join(currentEnv.configDir, 'app.db'))).toBe(true);
    }
  );
});
