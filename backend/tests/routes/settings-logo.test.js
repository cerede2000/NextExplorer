import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The custom logo: a file an administrator uploads, written into the config
 * directory and served to everyone, the sign-in page included.
 *
 * What is written is decided by the server, not by the upload: the name is
 * fixed and the kind of file is limited to the three image types the page can
 * show, at no more than two megabytes. A name taken from the upload would let
 * it choose where on disk it lands.
 *
 * And the file is deleted when the logo is reset to the default — but only
 * then. Branding is saved a field at a time, so a change to the application
 * name arrives without any logo in it, and must not be read as "no logo".
 *
 * The admin gate on the upload route is pinned in `admin-guards.test.js`.
 */

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

let currentEnv;

afterEach(async () => {
  if (currentEnv) {
    await currentEnv.cleanup();
    currentEnv = null;
  }
});

const seed = async () => {
  currentEnv = await setupTestEnv({ tag: 'settings-logo-' });
  await currentEnv.requireFresh('src/services/db').getDb();

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
  return app;
};

const logoDir = () => path.join(currentEnv.configDir, 'logos');

/** The files in the logo directory, or none when it was never created. */
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

describe('uploading a logo', () => {
  it('writes it under a fixed name, whatever the upload was called', async () => {
    const app = await seed();

    const response = await request(app)
      .post('/api/settings/upload-logo')
      .attach('logo', PNG, { filename: '../../escape.png', contentType: 'image/png' });

    expect(response.status).toBe(200);
    expect(response.body.logoUrl).toBe('/static/logos/custom-logo.png');
    expect(await logoFiles()).toEqual(['custom-logo.png']);
    expect(await fs.readFile(path.join(logoDir(), 'custom-logo.png'))).toEqual(PNG);
    expect(await exists(path.join(currentEnv.tmpRoot, 'escape.png'))).toBe(false);
  });

  it('refuses a file that is not an SVG, PNG or JPEG, and writes nothing', async () => {
    const app = await seed();

    const response = await request(app)
      .post('/api/settings/upload-logo')
      .attach('logo', Buffer.from('<script>alert(1)</script>'), {
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
    const app = await seed();

    const response = await request(app)
      .post('/api/settings/upload-logo')
      .attach('logo', Buffer.alloc(2 * 1024 * 1024 + 1), {
        filename: 'huge.png',
        contentType: 'image/png',
      });

    // 413 with the limit named, not multer's "File too large" as a 500.
    expect(response.status).toBe(413);
    expect(response.body.error.message).toBe('A logo can be at most 2 MB.');
    expect(await logoFiles()).toEqual([]);
  });

  it('refuses a logo sent in a field the route does not read, as a malformed request', async () => {
    const app = await seed();

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

describe('the custom logo files when branding is saved', () => {
  const placeLogos = async () => {
    await fs.mkdir(logoDir(), { recursive: true });
    await fs.writeFile(path.join(logoDir(), 'custom-logo.png'), PNG);
    await fs.writeFile(path.join(logoDir(), 'custom-logo.svg'), '<svg/>');
  };

  it.each([['/logo.svg'], ['']])('are deleted when the logo is reset to %j', async (appLogoUrl) => {
    const app = await seed();
    await placeLogos();

    const response = await request(app).patch('/api/settings').send({ branding: { appLogoUrl } });

    expect(response.status).toBe(200);
    expect(await logoFiles()).toEqual([]);
  });

  it('are kept when branding changes something other than the logo', async () => {
    const app = await seed();
    await placeLogos();

    const response = await request(app)
      .patch('/api/settings')
      .send({ branding: { appName: 'Renamed' } });

    expect(response.status).toBe(200);
    expect(await logoFiles()).toEqual(['custom-logo.png', 'custom-logo.svg']);
  });
});
