import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { setupTestEnv, clearModuleCache } from '../helpers/env-test-utils.js';

let envContext;

beforeAll(async () => {
  envContext = await setupTestEnv({
    tag: 'shares-routes-test-',
    env: {
      USER_VOLUMES: 'true',
    },
    modules: [
      'src/services/db',
      'src/services/users',
      'src/services/userVolumesService',
      'src/services/sharesService',
      'src/services/guestSessionService',
      'src/utils/pathUtils',
      'src/middleware/errorHandler',
      'src/routes/shares',
      'src/routes/files/delete',
      'src/services/fileTransferService',
    ],
  });
});

afterAll(async () => {
  await envContext.cleanup();
});

const buildApp = ({ user } = {}) => {
  if (!envContext) throw new Error('Test environment not initialized');

  clearModuleCache('src/config/env');
  clearModuleCache('src/config/index');

  const sharesRoutes = envContext.requireFresh('src/routes/shares');
  const deleteRoutes = envContext.requireFresh('src/routes/files/delete');
  const { errorHandler } = envContext.requireFresh('src/middleware/errorHandler');

  const app = express();
  app.use(express.json());

  app.use(async (req, _res, next) => {
    if (user) req.user = user;
    const guestSessionId = req.headers['x-guest-session'];
    if (guestSessionId) {
      const { getGuestSession } = envContext.requireFresh('src/services/guestSessionService');
      req.guestSession = await getGuestSession(guestSessionId);
    }
    next();
  });

  app.use('/api/shares', sharesRoutes);
  app.use('/api/share', sharesRoutes);
  app.use('/api', deleteRoutes);
  app.use(errorHandler);
  return app;
};

describe('Shares Routes', () => {
  describe('User Volumes', () => {
    it('should create and browse share from assigned volume path', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume');
      await fs.mkdir(assignedRoot, { recursive: true });

      const sharedFolder = path.join(assignedRoot, 'myfolder');
      await fs.mkdir(sharedFolder, { recursive: true });
      await fs.writeFile(path.join(sharedFolder, 'hello.txt'), 'hello');

      const user = await usersService.createLocalUser({
        email: 'user@example.com',
        username: 'user',
        displayName: 'User',
        password: 'secret123',
        roles: ['user'],
      });

      const vol = await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'MyVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const app = buildApp({ user });

      const create = await request(app).post('/api/shares').send({
        sourcePath: 'MyVol/myfolder',
        accessMode: 'readonly',
        sharingType: 'anyone',
      });

      expect(create.status).toBe(201);
      expect(create.body.shareToken).toBeDefined();
      expect(create.body.sourceSpace).toBe('user_volume');
      expect(create.body.sourcePath).toBe(`${vol.id}/myfolder`);

      const browse = await request(app).get(`/api/share/${create.body.shareToken}/browse/`);

      expect(browse.status).toBe(200);
      const names = (browse.body.items || []).map((item) => item.name);
      expect(names).toContain('hello.txt');
    });

    it('should not allow read-write share for readonly assigned volume', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-readonly');
      await fs.mkdir(assignedRoot, { recursive: true });
      await fs.mkdir(path.join(assignedRoot, 'folder'), { recursive: true });

      const user = await usersService.createLocalUser({
        email: 'user2@example.com',
        username: 'user2',
        displayName: 'User2',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'ReadOnlyVol',
        volumePath: assignedRoot,
        accessMode: 'readonly',
      });

      const app = buildApp({ user });

      const response = await request(app).post('/api/shares').send({
        sourcePath: 'ReadOnlyVol/folder',
        accessMode: 'readwrite',
        sharingType: 'anyone',
      });

      expect(response.status).toBe(400);
    });
  });

  describe('Share Expiry', () => {
    it('should not allow access or browse of expired shares', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-expiry');
      await fs.mkdir(assignedRoot, { recursive: true });

      const sharedFolder = path.join(assignedRoot, 'myfolder');
      await fs.mkdir(sharedFolder, { recursive: true });
      await fs.writeFile(path.join(sharedFolder, 'hello.txt'), 'hello');

      const user = await usersService.createLocalUser({
        email: 'user-expiry@example.com',
        username: 'user-expiry',
        displayName: 'User Expiry',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'ExpiryVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const app = buildApp({ user });

      const create = await request(app)
        .post('/api/shares')
        .send({
          sourcePath: 'ExpiryVol/myfolder',
          accessMode: 'readonly',
          sharingType: 'anyone',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

      expect(create.status).toBe(201);
      const { id: shareId, shareToken } = create.body;
      expect(shareId).toBeDefined();
      expect(shareToken).toBeDefined();

      // Expire the share
      const updateResponse = await request(app)
        .put(`/api/shares/${shareId}`)
        .send({ expiresAt: '2000-01-01T00:00:00.000Z' });
      expect(updateResponse.status).toBe(200);

      // Check info shows expired
      const info = await request(app).get(`/api/share/${shareToken}/info`);
      expect(info.status).toBe(200);
      expect(info.body.isExpired).toBe(true);

      // Access should be forbidden
      const access = await request(app).get(`/api/share/${shareToken}/access`);
      expect(access.status).toBe(403);

      // Browse should be forbidden
      const browse = await request(app).get(`/api/share/${shareToken}/browse/`);
      expect(browse.status).toBe(403);
    });
  });

  describe('Delete Cleanup', () => {
    it('should report and remove linked shares when deleting a shared file', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-delete-file');
      await fs.mkdir(assignedRoot, { recursive: true });
      await fs.writeFile(path.join(assignedRoot, 'shared.txt'), 'shared file');

      const user = await usersService.createLocalUser({
        email: 'delete-file@example.com',
        username: 'delete-file',
        displayName: 'Delete File',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'DeleteFileVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const app = buildApp({ user });
      const create = await request(app).post('/api/shares').send({
        sourcePath: 'DeleteFileVol/shared.txt',
        accessMode: 'readonly',
        sharingType: 'anyone',
      });

      expect(create.status).toBe(201);

      const items = [{ path: 'DeleteFileVol', name: 'shared.txt', kind: 'txt' }];
      const impact = await request(app).post('/api/files/delete-impact').send({ items });
      expect(impact.status).toBe(200);
      expect(impact.body.shareCount).toBe(1);

      const deleted = await request(app).delete('/api/files').send({ items });
      expect(deleted.status).toBe(200);
      expect(deleted.body.items[0].status).toBe('deleted');
      expect(deleted.body.items[0].deletedShareCount).toBe(1);

      const shareAfterDelete = await request(app).get(`/api/shares/${create.body.id}`);
      expect(shareAfterDelete.status).toBe(404);
    });

    it('should remove shares inside a deleted folder tree', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-delete-folder');
      await fs.mkdir(path.join(assignedRoot, 'folder'), { recursive: true });
      await fs.writeFile(path.join(assignedRoot, 'folder', 'nested.txt'), 'nested file');

      const user = await usersService.createLocalUser({
        email: 'delete-folder@example.com',
        username: 'delete-folder',
        displayName: 'Delete Folder',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'DeleteFolderVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const app = buildApp({ user });
      const create = await request(app).post('/api/shares').send({
        sourcePath: 'DeleteFolderVol/folder/nested.txt',
        accessMode: 'readonly',
        sharingType: 'anyone',
      });

      expect(create.status).toBe(201);

      const items = [{ path: 'DeleteFolderVol', name: 'folder', kind: 'directory' }];
      const impact = await request(app).post('/api/files/delete-impact').send({ items });
      expect(impact.status).toBe(200);
      expect(impact.body.shareCount).toBe(1);

      const deleted = await request(app).delete('/api/files').send({ items });
      expect(deleted.status).toBe(200);
      expect(deleted.body.items[0].status).toBe('deleted');
      expect(deleted.body.items[0].deletedShareCount).toBe(1);

      const shareAfterDelete = await request(app).get(`/api/shares/${create.body.id}`);
      expect(shareAfterDelete.status).toBe(404);
    });
  });

  describe('Direct File Links', () => {
    it('should stream an anyone-with-link file share without a prior guest session', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-direct-public');
      await fs.mkdir(assignedRoot, { recursive: true });
      await fs.writeFile(path.join(assignedRoot, 'hello.txt'), 'hello direct link');

      const user = await usersService.createLocalUser({
        email: 'direct-public@example.com',
        username: 'direct-public',
        displayName: 'Direct Public',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'DirectPublicVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const ownerApp = buildApp({ user });
      const create = await request(ownerApp).post('/api/shares').send({
        sourcePath: 'DirectPublicVol/hello.txt',
        accessMode: 'readonly',
        sharingType: 'anyone',
      });

      expect(create.status).toBe(201);
      expect(create.body.directFileUrl).toContain(`/api/share/${create.body.shareToken}/file`);

      const publicApp = buildApp();
      const direct = await request(publicApp).get(`/api/share/${create.body.shareToken}/file`);

      expect(direct.status).toBe(200);
      expect(direct.headers['content-disposition']).toContain('inline');
      expect(direct.headers['content-disposition']).toContain('hello.txt');
      expect(direct.text).toBe('hello direct link');

      const download = await request(publicApp).get(
        `/api/share/${create.body.shareToken}/file?mode=download`
      );

      expect(download.status).toBe(200);
      expect(download.headers['content-disposition']).toContain('attachment');
      expect(download.headers['content-disposition']).toContain('hello.txt');
    });

    it('should redirect a password-protected direct file until the password is verified', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-direct-password');
      await fs.mkdir(assignedRoot, { recursive: true });
      await fs.writeFile(path.join(assignedRoot, 'secret.txt'), 'protected direct link');

      const user = await usersService.createLocalUser({
        email: 'direct-password@example.com',
        username: 'direct-password',
        displayName: 'Direct Password',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'DirectPasswordVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const ownerApp = buildApp({ user });
      const create = await request(ownerApp).post('/api/shares').send({
        sourcePath: 'DirectPasswordVol/secret.txt',
        accessMode: 'readonly',
        sharingType: 'anyone',
        password: 'open-sesame',
      });

      expect(create.status).toBe(201);

      const publicApp = buildApp();
      const directBeforePassword = await request(publicApp).get(
        `/api/share/${create.body.shareToken}/file`
      );
      expect(directBeforePassword.status).toBe(302);
      expect(directBeforePassword.headers.location).toContain(`/share/${create.body.shareToken}`);
      expect(directBeforePassword.headers.location).toContain('redirect=');

      const verify = await request(publicApp)
        .post(`/api/share/${create.body.shareToken}/verify`)
        .send({ password: 'open-sesame' });

      expect(verify.status).toBe(200);
      expect(verify.body.guestSessionId).toBeDefined();

      const directAfterPassword = await request(publicApp)
        .get(`/api/share/${create.body.shareToken}/file`)
        .set('X-Guest-Session', verify.body.guestSessionId);

      expect(directAfterPassword.status).toBe(200);
      expect(directAfterPassword.text).toBe('protected direct link');
    });

    it('should stream direct directory links as ZIP downloads', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-direct-folder');
      await fs.mkdir(path.join(assignedRoot, 'folder'), { recursive: true });
      await fs.writeFile(path.join(assignedRoot, 'folder', 'nested.txt'), 'nested file');

      const user = await usersService.createLocalUser({
        email: 'direct-folder@example.com',
        username: 'direct-folder',
        displayName: 'Direct Folder',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'DirectFolderVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const ownerApp = buildApp({ user });
      const create = await request(ownerApp).post('/api/shares').send({
        sourcePath: 'DirectFolderVol/folder',
        accessMode: 'readonly',
        sharingType: 'anyone',
      });

      expect(create.status).toBe(201);
      expect(create.body.directFileUrl).toContain(`/api/share/${create.body.shareToken}/file`);

      const publicApp = buildApp();
      const direct = await request(publicApp).get(`/api/share/${create.body.shareToken}/file`);

      expect(direct.status).toBe(200);
      expect(direct.headers['content-type']).toContain('application/zip');
      expect(direct.headers['content-disposition']).toContain('attachment');
      expect(direct.headers['content-disposition']).toContain('folder.zip');
    });

    it('should force binary direct links to download in automatic mode', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-direct-binary');
      await fs.mkdir(assignedRoot, { recursive: true });
      await fs.writeFile(path.join(assignedRoot, 'archive.zip'), Buffer.from('fake zip payload'));

      const user = await usersService.createLocalUser({
        email: 'direct-binary@example.com',
        username: 'direct-binary',
        displayName: 'Direct Binary',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'DirectBinaryVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const ownerApp = buildApp({ user });
      const create = await request(ownerApp).post('/api/shares').send({
        sourcePath: 'DirectBinaryVol/archive.zip',
        accessMode: 'readonly',
        sharingType: 'anyone',
      });

      expect(create.status).toBe(201);

      const publicApp = buildApp();
      const direct = await request(publicApp).get(`/api/share/${create.body.shareToken}/file`);

      expect(direct.status).toBe(200);
      expect(direct.headers['content-disposition']).toContain('attachment');
      expect(direct.headers['content-disposition']).toContain('archive.zip');
    });

    it('should reject direct file access for expired shares', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-direct-expired');
      await fs.mkdir(assignedRoot, { recursive: true });
      await fs.writeFile(path.join(assignedRoot, 'expired.txt'), 'expired direct link');

      const user = await usersService.createLocalUser({
        email: 'direct-expired@example.com',
        username: 'direct-expired',
        displayName: 'Direct Expired',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'DirectExpiredVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const app = buildApp({ user });
      const create = await request(app)
        .post('/api/shares')
        .send({
          sourcePath: 'DirectExpiredVol/expired.txt',
          accessMode: 'readonly',
          sharingType: 'anyone',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

      expect(create.status).toBe(201);

      const updateResponse = await request(app)
        .put(`/api/shares/${create.body.id}`)
        .send({ expiresAt: '2000-01-01T00:00:00.000Z' });
      expect(updateResponse.status).toBe(200);

      const publicApp = buildApp();
      const direct = await request(publicApp).get(`/api/share/${create.body.shareToken}/file`);

      expect(direct.status).toBe(403);
    });
  });

  describe('Shared Pastebin Editor', () => {
    it('should read a public text share without exposing a write route', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-shared-editor');
      await fs.mkdir(assignedRoot, { recursive: true });
      await fs.writeFile(
        path.join(assignedRoot, 'Analyze-FileServerData.ps1'),
        'Write-Output hello'
      );

      const user = await usersService.createLocalUser({
        email: 'shared-editor@example.com',
        username: 'shared-editor',
        displayName: 'Shared Editor',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'SharedEditorVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const ownerApp = buildApp({ user });
      const create = await request(ownerApp).post('/api/shares').send({
        sourcePath: 'SharedEditorVol/Analyze-FileServerData.ps1',
        accessMode: 'readonly',
        sharingType: 'anyone',
      });
      expect(create.status).toBe(201);

      const publicApp = buildApp();
      const editor = await request(publicApp).get(`/api/share/${create.body.shareToken}/editor`);
      expect(editor.status).toBe(200);
      expect(editor.headers['cache-control']).toContain('no-store');
      expect(editor.body).toMatchObject({
        name: 'Analyze-FileServerData.ps1',
        content: 'Write-Output hello',
        canDownload: true,
      });

      // Friendly links may include the source filename, but no arbitrary child path.
      const friendly = await request(publicApp).get(
        `/api/share/${create.body.shareToken}/editor/Analyze-FileServerData.ps1`
      );
      expect(friendly.status).toBe(200);

      const write = await request(publicApp)
        .put(`/api/share/${create.body.shareToken}/editor`)
        .send({ content: 'should never be written' });
      expect(write.status).toBe(404);
    });

    it('should require a verified guest session and reject binary shared files', async () => {
      const usersService = envContext.requireFresh('src/services/users');
      const userVolumesService = envContext.requireFresh('src/services/userVolumesService');

      const assignedRoot = path.join(envContext.tmpRoot, 'assigned-volume-shared-editor-protected');
      await fs.mkdir(assignedRoot, { recursive: true });
      await fs.writeFile(path.join(assignedRoot, 'protected.txt'), 'protected text');
      await fs.writeFile(path.join(assignedRoot, 'binary.dat'), Buffer.from([0, 1, 2, 3]));

      const user = await usersService.createLocalUser({
        email: 'shared-editor-protected@example.com',
        username: 'shared-editor-protected',
        displayName: 'Shared Editor Protected',
        password: 'secret123',
        roles: ['user'],
      });

      await userVolumesService.addVolumeToUser({
        userId: user.id,
        label: 'SharedEditorProtectedVol',
        volumePath: assignedRoot,
        accessMode: 'readwrite',
      });

      const ownerApp = buildApp({ user });
      const protectedShare = await request(ownerApp).post('/api/shares').send({
        sourcePath: 'SharedEditorProtectedVol/protected.txt',
        accessMode: 'readonly',
        sharingType: 'anyone',
        password: 'open-sesame',
      });
      const binaryShare = await request(ownerApp).post('/api/shares').send({
        sourcePath: 'SharedEditorProtectedVol/binary.dat',
        accessMode: 'readonly',
        sharingType: 'anyone',
      });
      expect(protectedShare.status).toBe(201);
      expect(binaryShare.status).toBe(201);

      const publicApp = buildApp();
      const beforeVerification = await request(publicApp).get(
        `/api/share/${protectedShare.body.shareToken}/editor`
      );
      expect(beforeVerification.status).toBe(302);

      const verify = await request(publicApp)
        .post(`/api/share/${protectedShare.body.shareToken}/verify`)
        .send({ password: 'open-sesame' });
      expect(verify.status).toBe(200);

      const afterVerification = await request(publicApp)
        .get(`/api/share/${protectedShare.body.shareToken}/editor`)
        .set('X-Guest-Session', verify.body.guestSessionId);
      expect(afterVerification.status).toBe(200);
      expect(afterVerification.body.content).toBe('protected text');

      const binary = await request(publicApp).get(
        `/api/share/${binaryShare.body.shareToken}/editor`
      );
      expect(binary.status).toBe(415);
    });
  });
});
