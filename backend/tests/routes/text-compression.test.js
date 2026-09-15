import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import zlib from 'node:zlib';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * A 19 MB Markdown file, opened from a server reached by its local address,
 * travelled as 22 MB of JSON: nothing in the application compressed a response.
 *
 * Read with node's own client rather than supertest, which decompresses what it
 * receives and would hide whether the bytes on the wire were compressed at all.
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

const build = async () => {
  envContext = await setupTestEnv({ tag: 'text-compression-test-' });
  const destination = path.join(envContext.volumeDir, 'Notes');
  await fs.mkdir(destination, { recursive: true });

  const express = require('express');
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

  const server = http.createServer(app);
  const baseUrl = await startServer(server);
  return { destination, server, baseUrl };
};

/** The response exactly as it arrived: status, headers and undecoded bytes. */
const exchange = (baseUrl, { method = 'GET', target, headers = {}, body }) =>
  new Promise((resolve, reject) => {
    const request = http.request(new URL(target, baseUrl), { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        })
      );
      response.on('error', reject);
    });
    request.on('error', reject);
    if (body === undefined) {
      request.end();
    } else {
      request.setHeader('Content-Type', 'application/json');
      request.end(JSON.stringify(body));
    }
  });

const openInEditor = (baseUrl, filePath, headers) =>
  exchange(baseUrl, { method: 'POST', target: '/api/editor', headers, body: { path: filePath } });

/** Prose and code with characters outside ASCII, well past the threshold. */
const LARGE = Array.from(
  { length: 2500 },
  (_, index) =>
    `## Section ${index} — été, 日本語\n\n\`\`\`js\nconst value${index} = "quoted \\"${index}\\"";\n\`\`\`\n`
).join('\n');

/**
 * Under the threshold, and as compressible as text gets: a few bytes of text
 * come out of gzip larger than they went in, and would stay uncompressed with
 * no threshold at all.
 */
const SMALL = '# A short note\n\nNothing worth compressing here.\n'.repeat(300);

const varies = (response) =>
  String(response.headers.vary || '')
    .toLowerCase()
    .split(',')
    .map((field) => field.trim())
    .includes('accept-encoding');

afterEach(async () => {
  if (envContext) await envContext.cleanup();
  envContext = null;
});

describe('a large text file over the wire', () => {
  it('goes gzip-compressed to a browser on plain http, and decodes to the exact JSON', async () => {
    const { destination, server, baseUrl } = await build();
    await fs.writeFile(path.join(destination, 'big.md'), LARGE);

    try {
      const response = await openInEditor(baseUrl, 'Notes/big.md', {
        'Accept-Encoding': 'gzip, deflate',
      });

      const expected = Buffer.from(JSON.stringify({ content: LARGE }));
      expect(response.status).toBe(200);
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(varies(response)).toBe(true);
      expect(Number(response.headers['content-length'])).toBe(response.body.length);
      expect(response.body.length).toBeLessThan(expected.length / 2);
      expect(zlib.gunzipSync(response.body).equals(expected)).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('goes as brotli when that is offered', async () => {
    const { destination, server, baseUrl } = await build();
    await fs.writeFile(path.join(destination, 'big.md'), LARGE);

    try {
      const response = await openInEditor(baseUrl, 'Notes/big.md', {
        'Accept-Encoding': 'gzip, deflate, br, zstd',
      });

      expect(response.headers['content-encoding']).toBe('br');
      expect(Number(response.headers['content-length'])).toBe(response.body.length);
      expect(zlib.brotliDecompressSync(response.body).toString('utf8')).toBe(
        JSON.stringify({ content: LARGE })
      );
    } finally {
      await closeServer(server);
    }
  });

  it('goes as it is to a client that accepts no coding, still varying on it', async () => {
    const { destination, server, baseUrl } = await build();
    await fs.writeFile(path.join(destination, 'big.md'), LARGE);

    try {
      const response = await openInEditor(baseUrl, 'Notes/big.md');

      expect(response.headers['content-encoding']).toBeUndefined();
      expect(varies(response)).toBe(true);
      expect(JSON.parse(response.body.toString('utf8'))).toEqual({ content: LARGE });
    } finally {
      await closeServer(server);
    }
  });

  it('is not compressed in a coding the client refused with q=0', async () => {
    const { destination, server, baseUrl } = await build();
    await fs.writeFile(path.join(destination, 'big.md'), LARGE);

    try {
      const refused = await openInEditor(baseUrl, 'Notes/big.md', {
        'Accept-Encoding': 'br;q=0, gzip;q=0',
      });
      expect(refused.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(refused.body.toString('utf8'))).toEqual({ content: LARGE });

      const onlyGzip = await openInEditor(baseUrl, 'Notes/big.md', {
        'Accept-Encoding': 'br;q=0, gzip',
      });
      expect(onlyGzip.headers['content-encoding']).toBe('gzip');
    } finally {
      await closeServer(server);
    }
  });

  it('leaves a small file uncompressed', async () => {
    const { destination, server, baseUrl } = await build();
    await fs.writeFile(path.join(destination, 'small.md'), SMALL);

    try {
      const response = await openInEditor(baseUrl, 'Notes/small.md', {
        'Accept-Encoding': 'gzip, deflate, br',
      });

      expect(response.headers['content-encoding']).toBeUndefined();
      expect(varies(response)).toBe(true);
      expect(JSON.parse(response.body.toString('utf8'))).toEqual({ content: SMALL });
    } finally {
      await closeServer(server);
    }
  });

  it('compresses the raw text the same way', async () => {
    const { destination, server, baseUrl } = await build();
    await fs.writeFile(path.join(destination, 'big.md'), LARGE);

    try {
      const response = await exchange(baseUrl, {
        target: `/api/raw?path=${encodeURIComponent('Notes/big.md')}`,
        headers: { 'Accept-Encoding': 'gzip, deflate' },
      });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(response.headers['content-encoding']).toBe('gzip');
      expect(varies(response)).toBe(true);
      expect(zlib.gunzipSync(response.body).toString('utf8')).toBe(LARGE);
    } finally {
      await closeServer(server);
    }
  });
});
