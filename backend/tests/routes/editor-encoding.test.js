import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A text file the editor called binary.
 *
 * A 3.5 MB `.txt` was refused with "this file appears to be binary and cannot
 * be opened in the text editor". It was UTF-16 — every ASCII character stored
 * with a zero byte beside it, and a zero byte is what the binary test looks
 * for. PowerShell wrote UTF-16LE from `Out-File` until PowerShell 6 and Notepad
 * still offers it as "Unicode", so this is what a Windows log or export
 * ordinarily is.
 *
 * Driven through the route rather than the detector, because the round trip is
 * the thing: open it, save it, and find the file still written the way whatever
 * produced it will read it back.
 */

let envContext;

const startServer = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

const closeServer = (server) =>
  new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((err) => (err ? reject(err) : resolve()));
  });

const build = async (env = {}) => {
  envContext = await setupTestEnv({ tag: 'editor-encoding-test-', env });
  const destination = path.join(envContext.volumeDir, 'Nvm');
  await fs.mkdir(destination, { recursive: true });

  const express = require('express');
  const http = require('node:http');
  const { uploads } = envContext.requireFresh('src/config/index');
  const editorRoutes = envContext.requireFresh('src/routes/editor');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json({ limit: uploads.maxJsonBodyBytes }));
  app.use((req, _res, next) => {
    req.user = { id: 'admin', email: 'admin@example.com', roles: ['admin'] };
    next();
  });
  app.use('/api', editorRoutes);
  app.use(errorHandler);

  return { destination, server: http.createServer(app) };
};

const LOG = 'Nom de la machine : POSTE-042\r\nStatut : à jour\r\n'.repeat(30);

const write = async (destination, name, buffer) =>
  fs.writeFile(path.join(destination, name), buffer);

const utf16le = (text, { bom = true } = {}) => {
  const body = Buffer.from(text, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
};

const utf16be = (text, { bom = true } = {}) => {
  const body = Buffer.from(text, 'utf16le').swap16();
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body;
};

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('opening a text file that is not UTF-8', () => {
  it('opens a UTF-16 file rather than calling it binary', async () => {
    const { destination, server } = await build();
    await write(destination, 'rapport.txt', utf16le(LOG));
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl).post('/api/editor').send({ path: 'Nvm/rapport.txt' });

      expect(response.status).toBe(200);
      expect(response.body.content).toBe(LOG);
    } finally {
      await closeServer(server);
    }
  });

  it('opens one written the other way round', async () => {
    const { destination, server } = await build();
    await write(destination, 'rapport.txt', utf16be(LOG));
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl).post('/api/editor').send({ path: 'Nvm/rapport.txt' });

      expect(response.status).toBe(200);
      expect(response.body.content).toBe(LOG);
    } finally {
      await closeServer(server);
    }
  });

  it('opens one with no mark to announce it', async () => {
    const { destination, server } = await build();
    await write(destination, 'rapport.txt', utf16le(LOG, { bom: false }));
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl).post('/api/editor').send({ path: 'Nvm/rapport.txt' });

      expect(response.status).toBe(200);
      expect(response.body.content).toBe(LOG);
    } finally {
      await closeServer(server);
    }
  });

  it('serves it as text at the raw endpoint too', async () => {
    const { destination, server } = await build();
    await write(destination, 'rapport.txt', utf16le(LOG));
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl).get('/api/raw').query({ path: 'Nvm/rapport.txt' });

      expect(response.status).toBe(200);
      expect(response.text).toBe(LOG);
    } finally {
      await closeServer(server);
    }
  });

  /** Something genuinely binary is still refused, and still says so. */
  it('still refuses a file that really is binary', async () => {
    const { destination, server } = await build();
    await write(destination, 'image.txt', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]));
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl).post('/api/editor').send({ path: 'Nvm/image.txt' });

      expect(response.status).toBe(415);
      expect(response.body.error.message).toMatch(/binary/i);
    } finally {
      await closeServer(server);
    }
  });
});

describe('saving a text file that is not UTF-8', () => {
  /**
   * The file keeps the encoding it had. Saving it back as UTF-8 would read
   * perfectly well here and break whatever wrote it.
   */
  it('writes a UTF-16 file back as UTF-16', async () => {
    const { destination, server } = await build();
    const target = path.join(destination, 'rapport.txt');
    await write(destination, 'rapport.txt', utf16le(LOG));
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .put('/api/editor')
        .send({ path: 'Nvm/rapport.txt', content: `${LOG}Statut : terminé\r\n` });

      expect(response.status).toBe(200);
      const written = await fs.readFile(target);
      expect(written.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
      expect(written.subarray(2).toString('utf16le')).toBe(`${LOG}Statut : terminé\r\n`);
    } finally {
      await closeServer(server);
    }
  });

  it('keeps a big-endian file big-endian', async () => {
    const { destination, server } = await build();
    const target = path.join(destination, 'rapport.txt');
    await write(destination, 'rapport.txt', utf16be(LOG));
    const baseUrl = await startServer(server);

    try {
      await request(baseUrl).put('/api/editor').send({ path: 'Nvm/rapport.txt', content: 'Fini' });

      const written = await fs.readFile(target);
      expect(written).toEqual(utf16be('Fini'));
    } finally {
      await closeServer(server);
    }
  });

  it('keeps a UTF-8 file without a mark exactly that', async () => {
    const { destination, server } = await build();
    const target = path.join(destination, 'notes.md');
    await write(destination, 'notes.md', Buffer.from('# Notes\n', 'utf8'));
    const baseUrl = await startServer(server);

    try {
      await request(baseUrl).put('/api/editor').send({ path: 'Nvm/notes.md', content: '# Autres\n' });

      expect(await fs.readFile(target)).toEqual(Buffer.from('# Autres\n', 'utf8'));
    } finally {
      await closeServer(server);
    }
  });

  it('writes a file that did not exist in UTF-8', async () => {
    const { destination, server } = await build();
    const baseUrl = await startServer(server);

    try {
      await request(baseUrl).put('/api/editor').send({ path: 'Nvm/nouveau.md', content: 'Bonjour' });

      expect(await fs.readFile(path.join(destination, 'nouveau.md'))).toEqual(
        Buffer.from('Bonjour', 'utf8')
      );
    } finally {
      await closeServer(server);
    }
  });

  /**
   * The limit is about what lands on disk, and a UTF-16 file takes two bytes
   * per character — so the same text is twice the file.
   */
  it('measures the size against the bytes it is about to write', async () => {
    const { destination, server } = await build({ EDITOR_MAX_FILESIZE: '4K' });
    await write(destination, 'rapport.txt', utf16le('court'));
    const baseUrl = await startServer(server);

    try {
      const response = await request(baseUrl)
        .put('/api/editor')
        .send({ path: 'Nvm/rapport.txt', content: 'x'.repeat(3 * 1024) });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/too large to save/i);
    } finally {
      await closeServer(server);
    }
  });
});
