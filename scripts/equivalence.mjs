#!/usr/bin/env node
/**
 * Are the two of them the same application?
 *
 * `parity.mjs` reads the two source trees. Everything it knows, it knows from
 * what the source says — and every gap that got through this phase was invisible
 * there:
 *
 *   - a call nobody made, so the indexes never left app.db. The code was
 *     identical; only a running server told the difference.
 *   - a control that left with the file holding it. Both trees were spoken for.
 *   - a sentence written into a component in French. There was no key to compare.
 *   - a `.static` rule in the shipped stylesheet, from a word in a comment in a
 *     test server, because Tailwind reads everything not ignored.
 *   - documentation describing an application the batches had already changed.
 *
 * So this compares what reaches somebody, not what produces it. Four things do:
 * the built frontend, the answers a running server gives, the database a first
 * start creates, and the pages. A difference in any of them is a difference a
 * reader can find, whatever the source says.
 *
 * It takes minutes, so it is not a gate on every push — it is the one to run
 * before saying the two are the same.
 *
 *   node scripts/equivalence.mjs --theirs <path-to-checkout> [--ours .]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const THEIRS = flag('theirs', null);
const OURS = path.resolve(flag('ours', process.cwd()));
if (!THEIRS) {
  console.error('usage: node scripts/equivalence.mjs --theirs <path-to-checkout> [--ours .]');
  process.exit(2);
}
const T = path.resolve(THEIRS);

const findings = [];
const fail = (area, detail) => findings.push({ area, detail });
const say = (line) => console.log(line);

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── 1. what the build produces ──────────────────────────────────────────────
// Chunk names carry a hash of their contents, and every chunk that imports
// another names it by that hash — so one difference renames half the bundle.
// The names are normalised and the contents compared as a multiset: same files,
// same contents, whatever they ended up called.
const NORMALISE = (text) => text.replace(/-[A-Za-z0-9_-]{8}\.(js|css)/g, '-<hash>.$1');
const NAME_ROLE = (rel) => rel.replace(/-[A-Za-z0-9_-]{8}\.([a-z]+)$/, '.$1');
const builtBag = (root) => {
  const bag = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const bytes = fs.readFileSync(full);
      let body;
      try {
        body = Buffer.from(NORMALISE(bytes.toString('utf8')));
      } catch {
        body = bytes;
      }
      const key = `${NAME_ROLE(path.relative(root, full))}\u0000${createHash('sha256')
        .update(body)
        .digest('hex')}`;
      bag.set(key, (bag.get(key) || 0) + 1);
    }
  };
  walk(root);
  return bag;
};

const build = (root) => {
  const dist = path.join(root, 'frontend', 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  run('npm', ['run', 'build'], root);
  if (!fs.existsSync(dist)) throw new Error(`no frontend/dist under ${root}`);
  return builtBag(dist);
};

say('building both, which is the slow part');
const builtT = build(T);
const builtO = build(OURS);
const onlyIn = (a, b) => [...a.keys()].filter((k) => (b.get(k) || 0) < a.get(k));
for (const key of onlyIn(builtO, builtT)) fail('build', `only here: ${key.split('\u0000')[0]}`);
for (const key of onlyIn(builtT, builtO)) fail('build', `only theirs: ${key.split('\u0000')[0]}`);
say(
  `  the built frontend            ${findings.length ? `${findings.length} file(s) differ` : `${builtO.size} files, none differing`}`
);

// ── 2. what a running server answers ────────────────────────────────────────
// Read-only, so nothing here changes anything. A fresh config and cache for each,
// and the same volume, so the only variable left is the code.
const READ_ONLY = [
  '/healthz',
  '/readyz',
  '/api/features',
  '/api/settings',
  '/api/capabilities',
  '/api/volumes',
  '/api/browse/',
  '/api/browse/Projects',
  '/api/trash',
  '/api/trash/zones',
  '/api/favorites',
  '/api/shares',
  '/api/shares/shared-with-me',
  '/api/versions?path=Projects/note.txt',
  '/api/activity',
  '/api/auth/status',
  '/api/settings/access',
  '/api/usage',
  '/api/openapi.json',
  '/api/onlyoffice/activity-version',
  '/api/upload/finalizations',
  '/api/search?q=note',
  '/api/tokens',
  '/api/users',
  '/api/settings/users',
  '/api/performance',
  '/api/folder-size?path=Projects',
];

// Things that are a different value every time by their nature, and say nothing
// about whether the two are the same application.
const OF_THE_MOMENT = new Set([
  'requestId',
  'timestamp',
  'uptime',
  'startedAt',
  'now',
  'at',
  'id',
  'token',
  'secret',
  'mtime',
  'modifiedAt',
  'createdAt',
  'updatedAt',
  'freeBytes',
  'totalBytes',
  'usedBytes',
  'availableBytes',
  'rss',
  'heapUsed',
  'heapTotal',
  'external',
  'loadavg',
  'cpu',
  'memory',
  'version',
]);
const scrub = (value) => {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, OF_THE_MOMENT.has(key) ? '<of the moment>' : scrub(value[key])])
    );
  }
  return value;
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'equivalence-'));
const volume = path.join(sandbox, 'volume');
fs.mkdirSync(path.join(volume, 'Projects', 'below'), { recursive: true });
fs.writeFileSync(path.join(volume, 'Projects', 'note.txt'), 'some words\n');
fs.writeFileSync(path.join(volume, 'Projects', 'below', 'picture.jpg'), 'x');

const start = (root, port, tag) => {
  const config = path.join(sandbox, `config-${tag}`);
  const cache = path.join(sandbox, `cache-${tag}`);
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const child = spawn('node', ['backend/src/server.js'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      ADDRESS: '127.0.0.1',
      AUTH_ENABLED: 'false',
      VOLUME_ROOT: volume,
      CONFIG_DIR: config,
      CACHE_DIR: cache,
      SESSION_SECRET: 'equivalence',
    },
  });
  return { child, config };
};

const reachable = async (port) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

const ask = async (port, endpoint) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
    const text = await response.text();
    let body;
    try {
      body = JSON.stringify(scrub(JSON.parse(text)));
    } catch {
      body = text.slice(0, 400);
    }
    return `${response.status} ${body}`;
  } catch (error) {
    return `unreachable: ${error.message}`;
  }
};

const theirs = start(T, 3720, 'theirs');
const ours = start(OURS, 3721, 'ours');
try {
  const both = (await reachable(3720)) && (await reachable(3721));
  if (!both) {
    fail('runtime', 'one of the two never answered /healthz');
  } else {
    let differing = 0;
    for (const endpoint of READ_ONLY) {
      const [a, b] = await Promise.all([ask(3720, endpoint), ask(3721, endpoint)]);
      if (a !== b) {
        differing += 1;
        fail(
          'runtime',
          `${endpoint}\n      theirs: ${a.slice(0, 160)}\n      ours:   ${b.slice(0, 160)}`
        );
      }
    }
    say(
      `  what a running server says    ${differing ? `${differing} of ${READ_ONLY.length} endpoints differ` : `${READ_ONLY.length} endpoints, all the same`}`
    );
  }

  // ── 3. the database a first start creates ─────────────────────────────────
  // Two ladders of migrations, each its own history, are allowed to differ. What
  // they build is not.
  const shapeOf = (config) => {
    const file = path.join(config, 'app.db');
    if (!fs.existsSync(file)) return null;
    const sql = `
      SELECT type || ' ' || name FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger')
       ORDER BY type, name;`;
    const objects = run('sqlite3', [file, sql], OURS).trim().split('\n').filter(Boolean);
    const columns = [];
    for (const line of objects) {
      if (!line.startsWith('table ')) continue;
      const table = line.slice(6);
      const info = run('sqlite3', [file, `PRAGMA table_info("${table}");`], OURS);
      for (const row of info.trim().split('\n').filter(Boolean)) {
        columns.push(`${table}.${row.split('|')[1]}`);
      }
    }
    return [...objects, ...columns.sort()].join('\n');
  };
  let shapeT = null;
  let shapeO = null;
  try {
    shapeT = shapeOf(theirs.config);
    shapeO = shapeOf(ours.config);
  } catch (error) {
    say(`  the database it creates       not compared: ${error.message.split('\n')[0]}`);
  }
  if (shapeT !== null && shapeO !== null) {
    if (shapeT === shapeO) {
      say(
        `  the database it creates       ${shapeO.split('\n').filter((l) => l.startsWith('table ')).length} tables, the same shape`
      );
    } else {
      const a = new Set(shapeT.split('\n'));
      const b = new Set(shapeO.split('\n'));
      for (const x of [...b].filter((y) => !a.has(y))) fail('database', `only here: ${x}`);
      for (const x of [...a].filter((y) => !b.has(y))) fail('database', `only theirs: ${x}`);
      say('  the database it creates       differs');
    }
  }
} finally {
  theirs.child.kill();
  ours.child.kill();
}

// ── 4. the pages ────────────────────────────────────────────────────────────
// A page is what somebody reads to learn what the application does. One that
// describes the other application is as wrong as code that does.
const pagesOf = (root) => {
  const found = new Map();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        const body = fs
          .readFileSync(full, 'utf8')
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.trim())
          .join('\n');
        found.set(path.relative(root, full), createHash('sha256').update(body).digest('hex'));
      }
    }
  };
  walk(path.join(root, 'docs'));
  return found;
};
const allowed = (() => {
  const file = path.join(OURS, 'scripts', 'parity-manifest.json');
  if (!fs.existsSync(file)) return [];
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Both halves of the manifest: `residue` is where a shared file's remaining
  // difference is spoken for, and `rules` is where a file belonging to one side
  // only is. A page nobody has spoken for is what this is looking for.
  return [...(manifest.residue || []), ...(manifest.rules || [])].map(
    (entry) => new RegExp(entry.match)
  );
})();
const spokenFor = (id) => allowed.some((pattern) => pattern.test(id));
{
  const a = pagesOf(T);
  const b = pagesOf(OURS);
  let differing = 0;
  for (const [page, hash] of b) {
    if (spokenFor(page)) continue;
    if (!a.has(page)) {
      differing += 1;
      fail('pages', `only here: ${page}`);
    } else if (a.get(page) !== hash) {
      differing += 1;
      fail('pages', `says something else: ${page}`);
    }
  }
  for (const page of a.keys()) {
    if (spokenFor(page) || b.has(page)) continue;
    differing += 1;
    fail('pages', `only theirs: ${page}`);
  }
  say(
    `  the pages                     ${differing ? `${differing} differ` : `${b.size} pages, the same or spoken for`}`
  );
}

fs.rmSync(sandbox, { recursive: true, force: true });

say('');
if (findings.length === 0) {
  say('The two are the same application: what it builds, what it answers, what it');
  say('writes and what it says.');
  process.exit(0);
}
say(`${findings.length} difference(s) somebody could find:`);
for (const { area, detail } of findings) say(`  ${area.padEnd(9)} ${detail}`);
process.exit(1);
