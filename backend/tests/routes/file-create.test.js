import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { setupTestEnv, createTestApp } from '../helpers/env-test-utils.js';

let envContext;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'file-create-routes-test-',
    modules: [
      'src/utils/pathUtils',
      'src/services/accessManager',
      'src/services/authorizationService',
      'src/routes/files/file',
      'src/middleware/errorHandler',
    ],
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

describe('File creation route', () => {
  it('never truncates an existing file when the browser listing is stale', async () => {
    const directory = path.join(envContext.volumeDir, 'Documents');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'Untitled.txt'), 'keep this content');

    const router = envContext.requireFresh('src/routes/files/file');
    const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
    const app = createTestApp({
      router,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });

    const created = await request(app).post('/api/files/file').send({ path: 'Documents' });
    expect(created.status).toBe(201);
    expect(created.body.item.name).toBe('Untitled 2.txt');
    expect(await fs.readFile(path.join(directory, 'Untitled.txt'), 'utf-8')).toBe(
      'keep this content'
    );
    expect(await fs.readFile(path.join(directory, 'Untitled 2.txt'), 'utf-8')).toBe('');
  });

  it('allocates distinct names for concurrent creation requests', async () => {
    const directory = path.join(envContext.volumeDir, 'Concurrent');
    await fs.mkdir(directory, { recursive: true });

    const router = envContext.requireFresh('src/routes/files/file');
    const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');
    const app = createTestApp({
      router,
      mountPath: '/api',
      user: { id: 'admin-user', roles: ['admin'] },
      errorHandler,
    });

    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app).post('/api/files/file').send({ path: 'Concurrent' })
      )
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    expect(new Set(responses.map((response) => response.body.item.name))).toEqual(
      new Set(['Untitled.txt', 'Untitled 2.txt', 'Untitled 3.txt'])
    );
  });
});
