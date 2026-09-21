const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const AdmZip = require('adm-zip');

/**
 * A walk through the API the way a client would take it, recording every
 * exchange: which operation, what status came back, and the body.
 *
 * It is what the description is checked against. The shapes in it were
 * written from what these calls really answered, and the test that runs this
 * walk holds them to it — a field renamed in a route and not in the
 * description fails there, rather than in somebody's generated client.
 */

const PASSWORD = 'secret123';
const NEW_PASSWORD = 'another456';

// A one-pixel PNG, so thumbnails and previews have a real image to work on.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const seedVolume = async (volume) => {
  await fs.mkdir(path.join(volume, 'Documents', 'Projets'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Documents', 'notes.md'), '# Notes\n\nle mot pangolin\n');
  await fs.writeFile(path.join(volume, 'Documents', 'Projets', 'plan.txt'), 'un plan');
  await fs.writeFile(path.join(volume, 'Documents', 'photo.png'), PNG);
  const zip = new AdmZip();
  zip.addFile('docs/report.txt', Buffer.from('inside the archive'));
  zip.addFile('readme.txt', Buffer.from('hello'));
  await fs.writeFile(path.join(volume, 'Documents', 'backup.zip'), zip.toBuffer());
  await fs.mkdir(path.join(volume, 'Partage'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Partage', 'lisez-moi.txt'), 'pour le lien');
};

/**
 * @param {import('express').Express} app
 * @param {object} options
 * @param {string} options.volume  the volume root on disk
 * @param {(path: string) => any} options.requireFresh  the test environment's loader
 * @returns {Promise<{exchanges: Array<{operation: string, status: number, type: string, body: unknown}>}>}
 */
const tour = async (app, { volume, requireFresh }) => {
  await seedVolume(volume);
  const exchanges = [];
  const admin = request.agent(app);
  const visitor = request.agent(app);

  /** One call, recorded under the operation it exercises. */
  const call = async (operation, pending) => {
    const response = await pending;
    exchanges.push({
      operation,
      status: response.status,
      type: String(response.headers['content-type'] || '').split(';')[0],
      body: response.body,
      text: response.text,
    });
    return response;
  };

  // Signing in.
  await call('GET /api/auth/status', admin.get('/api/auth/status'));
  const setup = await call(
    'POST /api/auth/setup',
    admin
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', username: 'owner', password: PASSWORD })
  );
  const owner = setup.body.user;
  await call('GET /api/auth/status', admin.get('/api/auth/status'));
  await call('GET /api/auth/me', admin.get('/api/auth/me'));
  await call('GET /api/auth/methods', admin.get('/api/auth/methods'));
  await call(
    'POST /api/auth/login',
    request(app).post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD })
  );
  await call(
    'POST /api/auth/login',
    request(app).post('/api/auth/login').send({ identifier: 'owner', password: 'wrong-one' })
  );
  await call('GET /api/auth/totp', admin.get('/api/auth/totp'));
  await call('GET /api/auth/passkeys', admin.get('/api/auth/passkeys'));
  await call(
    'POST /api/auth/passkeys/register/start',
    admin.post('/api/auth/passkeys/register/start')
  );
  await call(
    'POST /api/auth/passkeys/register/finish',
    admin.post('/api/auth/passkeys/register/finish').send({ response: {} })
  );
  await call(
    'PATCH /api/auth/passkeys/{id}',
    admin.patch('/api/auth/passkeys/nothing').send({ name: 'x' })
  );
  await call(
    'DELETE /api/auth/passkeys/{id}',
    admin.delete('/api/auth/passkeys/nothing').send({ password: PASSWORD })
  );
  const passkeyDoor = request.agent(app);
  await call(
    'POST /api/auth/login/passkey/start',
    passkeyDoor.post('/api/auth/login/passkey/start')
  );
  await call(
    'POST /api/auth/login/passkey/finish',
    passkeyDoor.post('/api/auth/login/passkey/finish').send({ response: {} })
  );

  // A second factor, on and off again.
  const { totpCode } = requireFresh('src/utils/totp');
  const enrolment = await call('POST /api/auth/totp/start', admin.post('/api/auth/totp/start'));
  await call(
    'POST /api/auth/totp/confirm',
    admin.post('/api/auth/totp/confirm').send({ code: totpCode(enrolment.body.secret) })
  );
  const secondStep = request.agent(app);
  await call(
    'POST /api/auth/login',
    secondStep.post('/api/auth/login').send({ identifier: 'owner', password: PASSWORD })
  );
  await call(
    'POST /api/auth/login/totp',
    secondStep.post('/api/auth/login/totp').send({ code: '000000' })
  );
  await call(
    'POST /api/auth/totp/recovery-codes',
    admin.post('/api/auth/totp/recovery-codes').send({ password: PASSWORD })
  );
  await call('DELETE /api/auth/totp', admin.delete('/api/auth/totp').send({ password: PASSWORD }));

  // The password, changed and put back.
  await call(
    'POST /api/auth/password',
    admin.post('/api/auth/password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
  );
  await call(
    'POST /api/auth/password',
    admin.post('/api/auth/password').send({ currentPassword: NEW_PASSWORD, newPassword: PASSWORD })
  );
  await call(
    'POST /api/auth/password/add',
    admin.post('/api/auth/password/add').send({ password: PASSWORD })
  );
  await call('POST /api/auth/oidc/exchange', request(app).post('/api/auth/oidc/exchange').send({}));
  // No provider configured: each says so rather than redirecting.
  await call('GET /api/auth/oidc/login', request(app).get('/api/auth/oidc/login'));
  await call(
    'GET /api/auth/oidc/mobile/login',
    request(app)
      .get('/api/auth/oidc/mobile/login')
      .query({ code_challenge: 'x'.repeat(43) })
  );
  await call(
    'GET /api/auth/oidc/mobile/complete',
    request(app).get('/api/auth/oidc/mobile/complete')
  );

  // Tokens.
  const minted = await call(
    'POST /api/auth/tokens',
    admin
      .post('/api/auth/tokens')
      .send({ name: 'script', scope: 'read', expiresInDays: 30, password: PASSWORD })
  );
  await call('GET /api/auth/tokens', admin.get('/api/auth/tokens'));
  await call(
    'PATCH /api/auth/tokens/{id}',
    admin.patch(`/api/auth/tokens/${minted.body.token.id}`).send({ name: 'renamed' })
  );
  await call(
    'GET /api/volumes',
    request(app).get('/api/volumes').set('Authorization', `Bearer ${minted.body.secret}`)
  );
  await call(
    'DELETE /api/auth/tokens/{id}',
    admin.delete(`/api/auth/tokens/${minted.body.token.id}`)
  );

  // Public, before and after signing in.
  await call('GET /api/openapi.json', request(app).get('/api/openapi.json'));
  await call('GET /healthz', request(app).get('/healthz'));
  await call('GET /readyz', request(app).get('/readyz'));
  await call('GET /api/features', request(app).get('/api/features'));
  await call('GET /api/branding', request(app).get('/api/branding'));
  await call('GET /api/capabilities', admin.get('/api/capabilities'));

  // Looking around.
  await call('GET /api/volumes', admin.get('/api/volumes'));
  await call('GET /api/browse/{path}', admin.get('/api/browse/'));
  await call('GET /api/browse/{path}', admin.get('/api/browse/Documents'));
  await call('GET /api/browse/{path}', admin.get('/api/browse/Nowhere'));
  await call('GET /api/usage/{path}', admin.get('/api/usage/Documents'));
  await call('GET /api/metadata/{path}', admin.get('/api/metadata/Documents/notes.md'));
  await call('GET /api/metadata/{path}', admin.get('/api/metadata/Documents'));
  await call('GET /api/permissions/{path}', admin.get('/api/permissions/Documents/notes.md'));
  await call('GET /api/folder-size/{path}', admin.get('/api/folder-size/Documents'));
  await call(
    'POST /api/folder-size/batch',
    admin.post('/api/folder-size/batch').send({ paths: ['Documents'] })
  );
  await call(
    'POST /api/folder-size/refresh/{path}',
    admin.post('/api/folder-size/refresh/Documents')
  );
  await call('GET /api/thumbnails/{path}', admin.get('/api/thumbnails/Documents/photo.png'));
  await call('GET /api/preview', admin.get('/api/preview').query({ path: 'Documents/photo.png' }));
  await call(
    'GET /api/media/tracks',
    admin.get('/api/media/tracks').query({ path: 'Documents/photo.png' })
  );
  await call(
    'GET /api/media/subtitle',
    admin.get('/api/media/subtitle').query({ path: 'Documents/photo.png', stream: '0' })
  );
  await call('GET /api/preview', admin.get('/api/preview').query({ path: 'Documents/notes.md' }));
  await call('GET /api/search', admin.get('/api/search').query({ q: 'pangolin' }));
  await call('GET /api/search', admin.get('/api/search').query({ q: 'ab' }));

  // Reading and writing text.
  await call('GET /api/editor', admin.get('/api/editor').query({ path: 'Documents/notes.md' }));
  await call('POST /api/editor', admin.post('/api/editor').send({ path: 'Documents/notes.md' }));
  await call(
    'PUT /api/editor',
    admin.put('/api/editor').send({ path: 'Documents/notes.md', content: '# Notes\n\nautre\n' })
  );
  await call('GET /api/raw', admin.get('/api/raw').query({ path: 'Documents/notes.md' }));

  // Versions of what was just saved.
  const listed = await call(
    'GET /api/versions',
    admin.get('/api/versions').query({ path: 'Documents/notes.md' })
  );
  const version = (listed.body.versions || [])[0];
  if (version) {
    await call(
      'GET /api/versions/{id}/text',
      admin.get(`/api/versions/${version.id}/text`).query({ path: 'Documents/notes.md' })
    );
    await call(
      'PATCH /api/versions/{id}',
      admin
        .patch(`/api/versions/${version.id}`)
        .send({ path: 'Documents/notes.md', label: 'avant', pinned: true })
    );
    await call(
      'POST /api/versions/{id}/copy',
      admin.post(`/api/versions/${version.id}/copy`).send({ path: 'Documents/notes.md' })
    );
    await call(
      'POST /api/versions/{id}/restore',
      admin.post(`/api/versions/${version.id}/restore`).send({ path: 'Documents/notes.md' })
    );
  }
  if (version) {
    await call(
      'GET /api/versions/{id}/content',
      admin.get(`/api/versions/${version.id}/content`).query({ path: 'Documents/notes.md' })
    );
    await call(
      'POST /api/versions/{id}/copy',
      admin
        .post(`/api/versions/${version.id}/copy`)
        .send({ path: 'Documents/notes.md', destination: 'Documents/Projets' })
    );
    await call(
      'POST /api/versions/{id}/replace',
      admin
        .post(`/api/versions/${version.id}/replace`)
        .send({ path: 'Documents/notes.md', target: 'Documents/Projets/plan.txt' })
    );
  }
  // A listing now that a file there has versions to show.
  await call('GET /api/browse/{path}', admin.get('/api/browse/Documents'));
  const adminFiles = await call(
    'GET /api/versions/admin/files',
    admin.get('/api/versions/admin/files')
  );
  const kept = (adminFiles.body.files || [])[0];
  if (kept) {
    await call(
      'GET /api/versions/admin/files/{id}',
      admin.get(`/api/versions/admin/files/${kept.id}`)
    );
  }
  const again = await call(
    'GET /api/versions',
    admin.get('/api/versions').query({ path: 'Documents/notes.md' })
  );
  const unpinned = (again.body.versions || []).find((entry) => !entry.pinned);
  if (unpinned) {
    await call(
      'POST /api/versions/delete',
      admin.post('/api/versions/delete').send({ path: 'Documents/notes.md', ids: [unpinned.id] })
    );
  }
  if (kept) {
    await call(
      'POST /api/versions/admin/files/{id}/delete',
      admin.post(`/api/versions/admin/files/${kept.id}/delete`).send({ all: true })
    );
  }

  // Making, renaming, moving.
  await call(
    'POST /api/files/file',
    admin.post('/api/files/file').send({ path: 'Documents', name: 'nouveau.txt' })
  );
  await call(
    'POST /api/files/folder',
    admin.post('/api/files/folder').send({ path: 'Documents', name: 'Dossier' })
  );
  await call(
    'POST /api/files/office-document',
    admin
      .post('/api/files/office-document')
      .send({ path: 'Documents', format: 'docx', name: 'Rapport' })
  );
  await call(
    'POST /api/files/rename',
    admin
      .post('/api/files/rename')
      .send({ path: 'Documents', name: 'nouveau.txt', newName: 'renomme.txt' })
  );
  await call(
    'POST /api/files/copy',
    admin.post('/api/files/copy').send({
      items: [{ path: 'Documents', name: 'renomme.txt' }],
      destination: 'Documents/Dossier',
    })
  );
  await call(
    'POST /api/files/move',
    admin.post('/api/files/move').send({
      items: [{ path: 'Documents/Dossier', name: 'renomme.txt' }],
      destination: 'Documents/Projets',
    })
  );
  await call('GET /api/files/recent-destinations', admin.get('/api/files/recent-destinations'));
  await call(
    'POST /api/files/delete-impact',
    admin
      .post('/api/files/delete-impact')
      .send({ items: [{ path: 'Documents', name: 'renomme.txt' }] })
  );
  await call(
    'DELETE /api/files',
    admin.delete('/api/files').send({ items: [{ path: 'Documents', name: 'renomme.txt' }] })
  );

  await fs.mkdir(path.join(volume, 'Documents', 'Vieux'), { recursive: true });
  await fs.writeFile(path.join(volume, 'Documents', 'Vieux', 'a.txt'), 'ancien');
  await call(
    'POST /api/files/delete-stream',
    admin.post('/api/files/delete-stream').send({ items: [{ path: 'Documents', name: 'Vieux' }] })
  );

  // The trash.
  const inTrash = await call('GET /api/trash', admin.get('/api/trash'));
  await call('GET /api/trash/zones', admin.get('/api/trash/zones'));
  const trashedFile = (inTrash.body.items || []).find((item) => item.name === 'renomme.txt');
  const trashedFolder = (inTrash.body.items || []).find((item) => item.name === 'Vieux');
  if (trashedFolder) {
    await call(
      'GET /api/trash/items/{id}/entries',
      admin.get(`/api/trash/items/${trashedFolder.id}/entries`)
    );
    await call(
      'GET /api/trash/items/{id}/text',
      admin.get(`/api/trash/items/${trashedFolder.id}/text`).query({ path: 'a.txt' })
    );
    await call(
      'POST /api/trash/items/{id}/restore-to',
      admin
        .post(`/api/trash/items/${trashedFolder.id}/restore-to`)
        .send({ paths: ['a.txt'], destination: 'Documents/Projets' })
    );
    await call(
      'POST /api/trash/items/{id}/restore',
      admin.post(`/api/trash/items/${trashedFolder.id}/restore`).send({ paths: ['a.txt'] })
    );
    await call(
      'POST /api/trash/restore-to',
      admin
        .post('/api/trash/restore-to')
        .send({ ids: [trashedFolder.id], destination: 'Documents/Projets' })
    );
  }
  if (trashedFile) {
    await call(
      'POST /api/trash/restore',
      admin.post('/api/trash/restore').send({ ids: [trashedFile.id] })
    );
  }
  await call(
    'DELETE /api/files',
    admin.delete('/api/files').send({ items: [{ path: 'Documents', name: 'renomme.txt' }] })
  );
  const leftInTrash = await call('GET /api/trash', admin.get('/api/trash'));
  const toPurge = (leftInTrash.body.items || [])[0];
  if (toPurge) {
    await call(
      'POST /api/trash/delete',
      admin.post('/api/trash/delete').send({ ids: [toPurge.id] })
    );
  }
  await call('POST /api/trash/verify', admin.post('/api/trash/verify'));
  await call('POST /api/trash/maintenance', admin.post('/api/trash/maintenance'));
  await call('POST /api/trash/empty', admin.post('/api/trash/empty'));

  // Archives.
  await call(
    'GET /api/archive/list',
    admin.get('/api/archive/list').query({ path: 'Documents/backup.zip' })
  );
  await call(
    'GET /api/archive/entry',
    admin.get('/api/archive/entry').query({ path: 'Documents/backup.zip', entry: 'readme.txt' })
  );
  await call(
    'POST /api/archive/extract',
    admin
      .post('/api/archive/extract')
      .send({ path: 'Documents/backup.zip', entries: ['readme.txt'] })
  );
  await call(
    'POST /api/files/zip/compress',
    admin.post('/api/files/zip/compress').send({
      items: [{ path: 'Documents', name: 'Projets' }],
      destination: 'Documents',
      name: 'projets',
    })
  );
  await call(
    'POST /api/files/zip/extract',
    admin.post('/api/files/zip/extract').send({ path: 'Documents/backup.zip' })
  );

  // Downloads.
  await call(
    'POST /api/download',
    admin.post('/api/download').send({ basePath: 'Documents', paths: ['Documents/notes.md'] })
  );
  await call(
    'POST /api/download',
    admin.post('/api/download').send({ basePath: '', paths: ['Documents/Projets'] })
  );

  // Changing who owns what, as far as this machine allows.
  await call(
    'POST /api/permissions/chmod',
    admin.post('/api/permissions/chmod').send({ path: 'Documents/notes.md', mode: '644' })
  );
  await call(
    'POST /api/permissions/chown',
    admin.post('/api/permissions/chown').send({ path: 'Documents/notes.md', owner: 'root' })
  );

  // Favourites.
  const favourite = await call(
    'POST /api/favorites',
    admin.post('/api/favorites').send({ path: 'Documents', label: 'Docs' })
  );
  await call('GET /api/favorites', admin.get('/api/favorites'));
  await call(
    'PATCH /api/favorites/{id}',
    admin.patch(`/api/favorites/${favourite.body.id}`).send({ label: 'Mes documents' })
  );
  await call(
    'PATCH /api/favorites/reorder',
    admin.patch('/api/favorites/reorder').send({ order: [favourite.body.id] })
  );
  await call('DELETE /api/favorites', admin.delete('/api/favorites').send({ path: 'Documents' }));

  // Settings.
  await call('GET /api/settings', admin.get('/api/settings'));
  await call(
    'PATCH /api/settings',
    admin.patch('/api/settings').send({ activity: { enabled: true, retentionDays: 90 } })
  );
  await call(
    'POST /api/settings/upload-logo',
    admin.post('/api/settings/upload-logo').attach('logo', PNG, 'logo.png')
  );
  await call('GET /api/activity', admin.get('/api/activity'));
  await call('GET /api/activity/address', admin.get('/api/activity/address'));
  await call('DELETE /api/activity', admin.delete('/api/activity'));
  await call('POST /api/terminal/session', admin.post('/api/terminal/session').send({}));

  // Accounts.
  const created = await call(
    'POST /api/users',
    admin
      .post('/api/users')
      .send({ email: 'alice@example.com', username: 'alice', password: PASSWORD, roles: ['user'] })
  );
  const alice = created.body.user;
  await call('GET /api/users', admin.get('/api/users'));
  await call('GET /api/users/shareable', admin.get('/api/users/shareable'));
  await call('GET /api/users/search', admin.get('/api/users/search').query({ q: 'ali' }));
  await call(
    'PATCH /api/users/{id}',
    admin.patch(`/api/users/${alice.id}`).send({ displayName: 'Alice' })
  );
  await call(
    'POST /api/users/{id}/password',
    admin.post(`/api/users/${alice.id}/password`).send({ newPassword: 'another456' })
  );
  await call('DELETE /api/users/{id}/lock', admin.delete(`/api/users/${alice.id}/lock`));
  await call(
    'DELETE /api/users/{id}/two-factor',
    admin.delete(`/api/users/${alice.id}/two-factor`)
  );
  await call('DELETE /api/users/{id}/passkeys', admin.delete(`/api/users/${alice.id}/passkeys`));

  // A volume an administrator assigns.
  await call(
    'GET /api/admin/browse-directories',
    admin.get('/api/admin/browse-directories').query({ path: volume })
  );
  const assigned = await call(
    'POST /api/users/{userId}/volumes',
    admin
      .post(`/api/users/${alice.id}/volumes`)
      .send({ label: 'Equipe', path: path.join(volume, 'Partage'), accessMode: 'readonly' })
  );
  await call('GET /api/users/{userId}/volumes', admin.get(`/api/users/${alice.id}/volumes`));
  if (assigned.body.volume) {
    await call(
      'PATCH /api/users/{userId}/volumes/{volumeId}',
      admin
        .patch(`/api/users/${alice.id}/volumes/${assigned.body.volume.id}`)
        .send({ accessMode: 'readwrite' })
    );
    await call(
      'DELETE /api/users/{userId}/volumes/{volumeId}',
      admin.delete(`/api/users/${alice.id}/volumes/${assigned.body.volume.id}`)
    );
  }

  // Sharing.
  const share = await call(
    'POST /api/shares',
    admin.post('/api/shares').send({ sourcePath: 'Partage', sharingType: 'anyone' })
  );
  await call('GET /api/shares', admin.get('/api/shares'));
  await call('GET /api/shares/{id}', admin.get(`/api/shares/${share.body.id}`));
  await call(
    'PUT /api/shares/{id}',
    admin.put(`/api/shares/${share.body.id}`).send({ label: 'Pour le lien' })
  );
  await call('GET /api/shares/shared-with-me', admin.get('/api/shares/shared-with-me'));
  const token = share.body.shareToken;
  await call('GET /api/share/{token}/info', visitor.get(`/api/share/${token}/info`));
  await call('GET /api/share/{token}/access', visitor.get(`/api/share/${token}/access`));
  const verified = await call(
    'POST /api/share/{token}/verify',
    visitor.post(`/api/share/${token}/verify`).send({})
  );
  const guest = verified.body.guestSessionId;
  await call(
    'GET /api/share/{token}/browse/{path}',
    visitor.get(`/api/share/${token}/browse/`).set('X-Guest-Session', guest || '')
  );
  await call(
    'GET /api/share/{token}/file/{path}',
    visitor.get(`/api/share/${token}/file/lisez-moi.txt`).set('X-Guest-Session', guest || '')
  );
  await call(
    'GET /api/share/{token}/editor/{path}',
    visitor.get(`/api/share/${token}/editor/lisez-moi.txt`).set('X-Guest-Session', guest || '')
  );
  await call(
    'GET /api/share/{token}/browse/{path}',
    request(app).get(`/api/share/${token}/browse/`)
  );
  await call('DELETE /api/shares/{id}', admin.delete(`/api/shares/${share.body.id}`));

  // A file shared on its own, writable, behind a password.
  const fileShare = await call(
    'POST /api/shares',
    admin.post('/api/shares').send({
      sourcePath: 'Partage/lisez-moi.txt',
      sharingType: 'anyone',
      accessMode: 'readwrite',
      password: 'mot-de-passe',
    })
  );
  const fileToken = fileShare.body.shareToken;
  const fileVisitor = request.agent(app);
  await call('GET /api/share/{token}/info', fileVisitor.get(`/api/share/${fileToken}/info`));
  await call('GET /api/share/{token}/access', fileVisitor.get(`/api/share/${fileToken}/access`));
  await call(
    'POST /api/share/{token}/verify',
    fileVisitor.post(`/api/share/${fileToken}/verify`).send({ password: 'faux' })
  );
  const opened = await call(
    'POST /api/share/{token}/verify',
    fileVisitor.post(`/api/share/${fileToken}/verify`).send({ password: 'mot-de-passe' })
  );
  const fileGuest = opened.body.guestSessionId || '';
  await call(
    'GET /api/share/{token}/file',
    fileVisitor.get(`/api/share/${fileToken}/file`).set('X-Guest-Session', fileGuest)
  );
  await call(
    'GET /api/share/{token}',
    fileVisitor.get(`/api/share/${fileToken}`).set('X-Guest-Session', fileGuest)
  );
  await call(
    'GET /api/share/{token}/editor',
    fileVisitor.get(`/api/share/${fileToken}/editor`).set('X-Guest-Session', fileGuest)
  );
  await call(
    'PUT /api/share/{token}/editor',
    fileVisitor
      .put(`/api/share/${fileToken}/editor`)
      .set('X-Guest-Session', fileGuest)
      .send({ content: 'réécrit par le lien' })
  );
  await call(
    'PUT /api/share/{token}/editor/{path}',
    fileVisitor
      .put(`/api/share/${fileToken}/editor/lisez-moi.txt`)
      .set('X-Guest-Session', fileGuest)
      .send({ content: 'encore' })
  );
  await call('DELETE /api/shares/{id}', admin.delete(`/api/shares/${fileShare.body.id}`));

  // Uploads.
  await call(
    'POST /api/upload',
    admin
      .post('/api/upload')
      .field('uploadTo', 'Documents')
      .attach('filedata', Buffer.from('envoyé'), 'envoi.txt')
  );
  await call(
    'POST /api/upload/folder-session',
    admin.post('/api/upload/folder-session').send({ uploadTo: 'Documents', sourceRoot: 'Lot' })
  );
  const tusCreated = await call(
    'POST /api/upload/tus',
    admin
      .post('/api/upload/tus')
      .set('Tus-Resumable', '1.0.0')
      .set('Upload-Length', '6')
      .set(
        'Upload-Metadata',
        ['filename envoi2.txt', 'uploadTo Documents', 'relativePath envoi2.txt']
          .map((pair) => {
            const [key, value] = pair.split(' ');
            return `${key} ${Buffer.from(value).toString('base64')}`;
          })
          .join(',')
      )
  );
  const location = String(tusCreated.headers.location || '');
  const uploadId = location.slice(location.lastIndexOf('/') + 1);
  if (uploadId) {
    await call(
      'PATCH /api/upload/tus/{id}',
      admin
        .patch(`/api/upload/tus/${uploadId}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/offset+octet-stream')
        .send(Buffer.from('bonjou'))
    );
    await call(
      'HEAD /api/upload/tus/{id}',
      admin.head(`/api/upload/tus/${uploadId}`).set('Tus-Resumable', '1.0.0')
    );
  }
  const abandoned = await admin
    .post('/api/upload/tus')
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Length', '4')
    .set(
      'Upload-Metadata',
      `filename ${Buffer.from('jamais.txt').toString('base64')},uploadTo ${Buffer.from('Documents').toString('base64')}`
    );
  const abandonedUrl = String(abandoned.headers.location || '');
  await call(
    'DELETE /api/upload/tus/{id}',
    admin
      .delete(`/api/upload/tus/${abandonedUrl.slice(abandonedUrl.lastIndexOf('/') + 1)}`)
      .set('Tus-Resumable', '1.0.0')
  );
  await call('OPTIONS /api/upload/tus', admin.options('/api/upload/tus'));
  await call('GET /api/upload/finalizations', admin.get('/api/upload/finalizations'));

  // An editor integration, where one is configured.
  const office = await call(
    'POST /api/onlyoffice/config',
    admin.post('/api/onlyoffice/config').send({ path: 'Documents/Rapport.docx' })
  );
  await call('GET /api/onlyoffice/users', admin.get('/api/onlyoffice/users'));
  const sessionId = office.body?.forceSaveSessionId || 'none';
  await call(
    'POST /api/onlyoffice/session-heartbeat',
    admin
      .post('/api/onlyoffice/session-heartbeat')
      .send({ path: 'Documents/Rapport.docx', sessionId })
  );
  await call(
    'POST /api/onlyoffice/history',
    admin.post('/api/onlyoffice/history').send({ path: 'Documents/Rapport.docx' })
  );
  await call(
    'POST /api/onlyoffice/notify',
    admin.post('/api/onlyoffice/notify').send({ path: 'Documents/Rapport.docx', emails: [] })
  );
  await call(
    'GET /api/onlyoffice/activity-version',
    admin.get('/api/onlyoffice/activity-version').query({ since: 0 })
  );
  await call(
    'POST /api/onlyoffice/history-data',
    admin.post('/api/onlyoffice/history-data').send({ path: 'Documents/Rapport.docx', version: 1 })
  );
  await call(
    'POST /api/onlyoffice/storage-file',
    admin.post('/api/onlyoffice/storage-file').send({ path: 'Documents/notes.md' })
  );
  await call(
    'POST /api/onlyoffice/save-as',
    admin.post('/api/onlyoffice/save-as').send({
      path: 'Documents/Rapport.docx',
      url: 'http://elsewhere.invalid/x.docx',
      title: 'Copie.docx',
    })
  );
  await call(
    'POST /api/onlyoffice/force-save',
    admin.post('/api/onlyoffice/force-save').send({ path: 'Documents/Rapport.docx', sessionId })
  );
  await call(
    'POST /api/onlyoffice/rename',
    admin
      .post('/api/onlyoffice/rename')
      .send({ path: 'Documents/Rapport.docx', sessionId, newName: 'Rapport final.docx' })
  );
  await call(
    'POST /api/onlyoffice/session-end',
    admin.post('/api/onlyoffice/session-end').send({ path: 'Documents/Rapport.docx', sessionId })
  );
  await call(
    'GET /api/onlyoffice/file',
    request(app).get('/api/onlyoffice/file').query({ path: 'Documents/Rapport.docx' })
  );
  await call(
    'POST /api/onlyoffice/callback',
    request(app)
      .post('/api/onlyoffice/callback')
      .query({ path: 'Documents/Rapport.docx' })
      .send({ status: 1 })
  );
  await call(
    'POST /api/collabora/config',
    admin.post('/api/collabora/config').send({ path: 'Documents/Rapport.docx' })
  );
  await call(
    'GET /api/collabora/wopi/files/{fileId}',
    request(app).get('/api/collabora/wopi/files/nothing').query({ access_token: 'forged' })
  );
  await call(
    'POST /api/collabora/wopi/files/{fileId}',
    request(app)
      .post('/api/collabora/wopi/files/nothing')
      .query({ access_token: 'forged' })
      .set('X-WOPI-Override', 'LOCK')
  );
  await call(
    'GET /api/collabora/wopi/files/{fileId}/contents',
    request(app).get('/api/collabora/wopi/files/nothing/contents').query({ access_token: 'forged' })
  );
  await call(
    'POST /api/collabora/wopi/files/{fileId}/contents',
    request(app)
      .post('/api/collabora/wopi/files/nothing/contents')
      .query({ access_token: 'forged' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'))
  );

  // Somebody else, and then nobody.
  await call('DELETE /api/users/{id}', admin.delete(`/api/users/${alice.id}`));
  await call('GET /api/auth/me', request(app).get('/api/auth/me'));
  await call('GET /api/volumes', request(app).get('/api/volumes'));
  await call('POST /api/auth/logout', admin.post('/api/auth/logout'));

  return { exchanges, owner };
};

/** What the walk needs configured: every optional door open. */
const TOUR_ENVIRONMENT = {
  AUTH_ENABLED: 'true',
  AUTH_MODE: 'local',
  SEARCH_DEEP: 'true',
  FOLDER_SIZE_MODE: 'shallow',
  USER_VOLUMES: 'true',
  UPLOAD_CHUNKED_ENABLED: 'true',
  ONLYOFFICE_URL: 'http://onlyoffice.invalid',
  ONLYOFFICE_SECRET: 'tour-secret-that-is-long-enough-to-sign',
  COLLABORA_URL: 'http://collabora.invalid',
  COLLABORA_SECRET: 'tour-secret-that-is-long-enough-to-sign',
  PUBLIC_URL: 'http://127.0.0.1',
};

module.exports = { tour, PASSWORD, TOUR_ENVIRONMENT };
