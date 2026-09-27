import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The count behind the mark a listing puts on a file.
 *
 * One query answers a whole folder, so what it must get right is which rows
 * it answers for. The route tests cover the folder boundary; these cover the
 * three states it has to read through — a history whose file went to the
 * trash, a version half-written or half-deleted, and a root registered twice.
 */

let env;
let versions;
let store;
let trashStore;
let db;

const load = (relative) => require(modulePath(relative));

const volume = (...segments) => path.join(env.volumeDir, ...segments);

const write = async (relative, content) => {
  await fs.mkdir(path.dirname(volume(relative)), { recursive: true });
  await fs.writeFile(volume(relative), content);
};

/** Save the way the editor does, which is what makes a version. */
const save = (relative, content) =>
  load('src/services/versions/operations').saveFile(
    volume(relative),
    (temporary) => fs.writeFile(temporary, content),
    { source: 'editor' }
  );

const marks = (folder) => versions.marksForFolder(volume(folder));

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'version-marks-' });
  versions = load('src/services/versions');
  store = load('src/services/versions/store');
  trashStore = load('src/services/trash/store');
  db = await load('src/services/db').getDb();
  await write('Projects/notes.md', 'one\n');
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  vi.restoreAllMocks();
  await env.cleanup();
});

const historyOf = (relativePath) =>
  store.listFiles(db, {}).find((file) => file.relativePath === relativePath);

describe('what the count reads', () => {
  it('answers the top of a zone, which is a folder like any other', async () => {
    // `locateZoneRoot` refuses to name the zone of the root itself — true for
    // a file being deleted, which cannot go into its own volume's trash, and
    // useless for a listing. The files at the top of a volume have histories
    // like any others.
    await save('Projects/notes.md', 'two\n');

    expect((await marks('Projects')).get('notes.md')).toMatchObject({ versions: 1 });
  });

  it('leaves out the history of a file that has gone to the trash', async () => {
    // A file deleted and then a new one created at the same path: the old
    // history is still on the books, under the same path, and would put its
    // count on a file that has nothing to do with it.
    await save('Projects/notes.md', 'two\n');
    const history = historyOf('notes.md');
    store.setFileState(db, history.id, 'trashed');

    expect((await marks('Projects')).get('notes.md')).toBeUndefined();
  });

  it('counts a version that is kept, and not one on its way in or out', async () => {
    await save('Projects/notes.md', 'two\n');
    await save('Projects/notes.md', 'three\n');
    const history = historyOf('notes.md');
    const [first, second] = store.listVersionsOfFile(db, history.id);

    expect((await marks('Projects')).get('notes.md').versions).toBe(2);

    // Written before the disk is touched, and not yet a version anybody has.
    store.setVersionState(db, first.id, 'capturing');
    expect((await marks('Projects')).get('notes.md').versions).toBe(1);

    // On its way out, on a volume that was not available to remove it from.
    store.setVersionState(db, second.id, 'purging');
    expect((await marks('Projects')).get('notes.md')).toBeUndefined();
  });

  it('adds up a root that has been registered twice', async () => {
    // One physical tree, two zone rows: the second is what an installation
    // that lost its database and rebuilt it looks like, and a file's history
    // may sit under either.
    await save('Projects/notes.md', 'two\n');
    const first = trashStore.listZones(db).find((zone) => zone.root === volume('Projects'));
    const second = trashStore.insertZone(db, {
      id: 'second-row-same-root',
      root: first.root,
      space: first.space,
    });
    const history = historyOf('notes.md');
    store.insertFile(db, {
      id: 'history-under-the-other-row',
      zoneId: second.id,
      relativePath: 'notes.md',
    });
    store.insertVersion(db, {
      id: 'version-under-the-other-row',
      fileId: 'history-under-the-other-row',
      zoneId: second.id,
      state: 'kept',
      size: 100,
      modifiedAt: new Date().toISOString(),
    });

    expect(historyOf('notes.md').id).toBe(history.id);
    expect((await marks('Projects')).get('notes.md')).toMatchObject({
      versions: 2,
      bytes: 4 + 100,
    });
  });

  it('answers nothing for a folder in no zone at all', async () => {
    expect((await marks('.')).size).toBe(0);
  });
});
