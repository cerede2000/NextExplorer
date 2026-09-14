import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';
import { createRandom, seedsFor } from '../helpers/seeded-random.js';

/**
 * The trash, through sequences of what people and time do to it, drawn at
 * random.
 *
 * Each step is one thing: a file or folder created, deleted, restored, purged,
 * recreated under a name something in the trash still claims; days passing;
 * the volume shrinking under the trash's budget; an operation dying half-way
 * and the zone being recovered. A model of a hundred lines says what the disk
 * and the records must hold afterwards, and after every single step both are
 * compared with it and the oracle is asked for its verdict.
 *
 * The suites beside this one check each rule. This checks that the rules, in
 * any order anyone could reach, never leave a file lost, duplicated, or
 * recorded where it is not.
 *
 * A failure prints its seed and the last steps; `TEST_SEED=<n>` replays it.
 * `TRASH_CYCLE_SEQUENCES` and `TRASH_CYCLE_STEPS` run longer ones locally.
 */

const SEQUENCES = Number(process.env.TRASH_CYCLE_SEQUENCES) || 200;
const STEPS = Number(process.env.TRASH_CYCLE_STEPS) || 25;
const DAY = 24 * 60 * 60 * 1000;
const VOLUMES = ['Projects', 'Photos'];
const HUGE = 1_000_000_000;

const load = (relative) => require(modulePath(relative));

const CRASH_POINTS = {
  trash: ['trash:after-row', 'trash:after-sidecar', 'trash:after-rename'],
  restore: ['restore:after-intent', 'restore:after-rename'],
  purge: ['purge:after-intent', 'purge:after-remove'],
};

const WEIGHTS = {
  create: 4,
  trash: 4,
  restore: 2,
  purge: 1,
  recreate: 1,
  time: 1,
  squeeze: 1,
  crash: 3,
};

const runSequence = async (envContext, seed) => {
  const clock = load('src/services/trash/clock');
  const zones = load('src/services/trash/zones');
  const store = load('src/services/trash/store');
  const failpoints = load('src/services/trash/failpoints');
  const policy = load('src/services/trash/policy');
  const operations = load('src/services/trash/operations');
  const maintenance = load('src/services/trash/maintenance');
  const verify = load('src/services/trash/verify');
  const db = await load('src/services/db').getDb();

  let now = Date.UTC(2026, 0, 1);
  let totalBytes = HUGE;
  vi.spyOn(clock, 'now').mockImplementation(() => now);
  vi.spyOn(maintenance, 'measureVolume').mockImplementation(async () => ({
    totalBytes,
    freeBytes: HUGE,
  }));

  const random = createRandom(seed);
  const abs = (relative) => path.join(envContext.volumeDir, relative);
  for (const volume of VOLUMES) await fs.mkdir(abs(volume), { recursive: true });

  // The model: what is on the disk, and what is in the trash.
  const live = new Map(); // 'Projects/f3.txt' -> { kind, content }
  const trashed = new Map(); // item id -> { original, kind, content, deletedAt, size }
  let counter = 0;
  const log = [];

  const volumeOf = (relative) => relative.split('/')[0];

  const writeEntry = async (relative, kind, content) => {
    if (kind === 'file') {
      await fs.writeFile(abs(relative), content);
    } else {
      await fs.mkdir(abs(relative));
      await fs.writeFile(path.join(abs(relative), 'inner.txt'), content);
    }
  };

  const readEntry = async (absolutePath, kind) =>
    fs.readFile(kind === 'file' ? absolutePath : path.join(absolutePath, 'inner.txt'), 'utf8');

  /** The name a restore must choose: the original, or the first free "name (n)". */
  const availableName = (relative) => {
    const directory = path.posix.dirname(relative);
    const name = path.posix.basename(relative);
    const extension = path.posix.extname(name);
    const base = extension ? name.slice(0, -extension.length) : name;
    let candidate = name;
    for (let n = 1; live.has(`${directory}/${candidate}`); n += 1) {
      candidate = `${base} (${n})${extension}`;
    }
    return `${directory}/${candidate}`;
  };

  /** What a maintenance pass must purge, zone by zone, from the model alone. */
  const expectedPurges = () => {
    const purged = [];
    for (const volume of VOLUMES) {
      const items = [...trashed]
        .filter(([, item]) => volumeOf(item.original) === volume)
        .map(([id, item]) => ({ id, size: item.size, deletedAt: item.deletedAt }));
      const plan = policy.planMaintenance({
        items,
        now,
        retentionDays: 30,
        budgetBytes: policy.budgetFor({ totalBytes, maxPercent: 10 }),
        freeBytes: HUGE,
        floorBytes: 0,
      });
      purged.push(...plan.purge.map((entry) => entry.id));
    }
    return purged;
  };

  const recoverAll = async () => {
    failpoints.clear();
    // A process that died holds nothing in flight.
    operations.inflight.clear();
    for (const zone of store.listZones(db)) {
      // eslint-disable-next-line no-await-in-loop
      await operations.recoverZone(zone);
    }
  };

  const recordTrashed = (id, relative, entry) => {
    trashed.set(id, {
      original: relative,
      ...entry,
      deletedAt: now,
      size: Buffer.byteLength(entry.content),
    });
  };

  const actions = {
    create: async () => {
      counter += 1;
      const kind = random.chance(0.3) ? 'directory' : 'file';
      const relative = `${random.pick(VOLUMES)}/${kind === 'file' ? `f${counter}.txt` : `d${counter}`}`;
      const content = `c${counter}-`.repeat(random.int(1, 30));
      await writeEntry(relative, kind, content);
      live.set(relative, { kind, content });
      return `create ${relative}`;
    },

    trash: async () => {
      if (live.size === 0) return null;
      const relative = random.pick([...live.keys()]);
      const entry = live.get(relative);
      const result = await operations.moveToTrash({ absolutePath: abs(relative) });
      expect(result.status).toBe('trashed');
      live.delete(relative);
      recordTrashed(result.item.id, relative, entry);
      return `trash ${relative}`;
    },

    restore: async () => {
      if (trashed.size === 0) return null;
      const id = random.pick([...trashed.keys()]);
      const item = trashed.get(id);
      const expected = availableName(item.original);
      const result = await operations.restoreItem(id);
      expect(result.status).toBe('restored');
      expect(result.restorePath).toBe(abs(expected));
      trashed.delete(id);
      live.set(expected, { kind: item.kind, content: item.content });
      return `restore ${item.original} as ${expected}`;
    },

    purge: async () => {
      if (trashed.size === 0) return null;
      const id = random.pick([...trashed.keys()]);
      expect((await operations.purgeItem(id)).status).toBe('purged');
      const { original } = trashed.get(id);
      trashed.delete(id);
      return `purge ${original}`;
    },

    recreate: async () => {
      const candidates = [...trashed.values()].filter((item) => !live.has(item.original));
      if (candidates.length === 0) return null;
      const item = random.pick(candidates);
      counter += 1;
      const content = `recreated ${counter}`;
      await writeEntry(item.original, item.kind, content);
      live.set(item.original, { kind: item.kind, content });
      return `recreate ${item.original}`;
    },

    time: async () => {
      now += random.int(0, 40) * DAY;
      const purged = expectedPurges();
      await maintenance.runPass();
      purged.forEach((id) => trashed.delete(id));
      return `time to ${new Date(now).toISOString().slice(0, 10)}, ${purged.length} expired`;
    },

    squeeze: async () => {
      totalBytes = random.int(0, 4000);
      const purged = expectedPurges();
      await maintenance.runPass();
      totalBytes = HUGE;
      purged.forEach((id) => trashed.delete(id));
      return `squeeze, ${purged.length} evicted`;
    },

    crash: async () => {
      const possible = [];
      if (live.size) possible.push('trash');
      if (trashed.size) possible.push('restore', 'purge');
      if (possible.length === 0) return null;
      const operation = random.pick(possible);
      const point = random.pick(CRASH_POINTS[operation]);
      failpoints.set(point, () => failpoints.crash(point));

      if (operation === 'trash') {
        const relative = random.pick([...live.keys()]);
        const entry = live.get(relative);
        const known = new Set(store.listItems(db).map((row) => row.id));
        await expect(operations.moveToTrash({ absolutePath: abs(relative) })).rejects.toMatchObject(
          { simulatedCrash: true }
        );
        await recoverAll();
        if (point === 'trash:after-rename') {
          const row = store.listItems(db).find((candidate) => !known.has(candidate.id));
          expect(row?.state).toBe('trashed');
          live.delete(relative);
          recordTrashed(row.id, relative, entry);
        }
      } else if (operation === 'restore') {
        const id = random.pick([...trashed.keys()]);
        const item = trashed.get(id);
        const expected = availableName(item.original);
        await expect(operations.restoreItem(id)).rejects.toMatchObject({ simulatedCrash: true });
        await recoverAll();
        if (point === 'restore:after-rename') {
          trashed.delete(id);
          live.set(expected, { kind: item.kind, content: item.content });
        }
      } else {
        const id = random.pick([...trashed.keys()]);
        await expect(operations.purgeItem(id)).rejects.toMatchObject({ simulatedCrash: true });
        await recoverAll();
        trashed.delete(id);
      }
      return `crash ${operation} at ${point}`;
    },
  };

  const weighted = Object.entries(WEIGHTS).flatMap(([name, weight]) => Array(weight).fill(name));

  const compare = async () => {
    const context = `seed ${seed} after: ${log.slice(-8).join(' | ')}`;

    for (const volume of VOLUMES) {
      // eslint-disable-next-line no-await-in-loop
      const onDisk = (await fs.readdir(abs(volume))).filter((name) => name !== '.nextexplorer');
      const expected = [...live.keys()]
        .filter((relative) => volumeOf(relative) === volume)
        .map((relative) => relative.slice(volume.length + 1));
      expect(onDisk.sort(), context).toEqual(expected.sort());
    }
    for (const [relative, entry] of live) {
      // eslint-disable-next-line no-await-in-loop
      expect(await readEntry(abs(relative), entry.kind), context).toBe(entry.content);
    }

    const rows = store.listItems(db);
    expect(rows.map((row) => row.id).sort(), context).toEqual([...trashed.keys()].sort());
    for (const row of rows) {
      const item = trashed.get(row.id);
      const zone = store.getZone(db, row.zoneId);
      expect(row.state, context).toBe('trashed');
      expect(row.originalPath, context).toBe(abs(item.original));
      // eslint-disable-next-line no-await-in-loop
      expect(await readEntry(zones.itemPaths(zone.root, row.id).payload, item.kind), context).toBe(
        item.content
      );
    }
    for (const zone of store.listZones(db)) {
      // eslint-disable-next-line no-await-in-loop
      expect((await verify.verifyZone(zone)).violations, context).toEqual([]);
    }
  };

  for (let step = 0; step < STEPS; step += 1) {
    const name = random.pick(weighted);
    // eslint-disable-next-line no-await-in-loop
    const done = await actions[name]();
    if (done) log.push(done);
    // eslint-disable-next-line no-await-in-loop
    await compare();
  }

  failpoints.clear();
};

describe('the trash, through random sequences of what people and time do', () => {
  it.each(seedsFor(SEQUENCES, 1000))(
    'never loses, duplicates or misplaces anything, seed %i',
    async (seed) => {
      const envContext = await setupTestEnv({
        tag: 'trash-cycle-',
        env: { UPLOAD_STORAGE_RESERVE: '0' },
      });
      try {
        await runSequence(envContext, seed);
      } finally {
        vi.restoreAllMocks();
        await envContext.cleanup();
      }
    },
    60_000
  );
});
