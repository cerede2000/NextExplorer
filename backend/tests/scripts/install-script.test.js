import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The script that installs NextExplorer without Docker.
 *
 * The promise worth testing is not that it installs — the smoke test in CI
 * does that on a bare Debian and a bare Fedora, as root, with systemd. It is
 * that running it again is safe: an update must replace the program and leave
 * the configuration file, the database and the volumes exactly as they were.
 * Somebody's `nextexplorer.env` is the one file in the tree that cannot be
 * made again, and this is what stands between it and a well-meaning `sed`.
 *
 * Everything here runs under `--prefix`, so nothing touches this machine.
 */

const PACKAGING = path.join(__dirname, '..', '..', '..', 'packaging');
const OPTIONAL_TOOLS = {
  ffprobe: 'video thumbnails',
  rg: 'searching inside files',
  pdftotext: 'reading text out of PDFs',
  perl: 'RAW photos',
  rsync: 'copying and moving large folders',
};

let sandbox;
let release;
let prefix;

/** The architecture the script will work out for itself. */
const machineArch = () => {
  const machine = execFileSync('uname', ['-m']).toString().trim();
  if (machine === 'x86_64') return 'x64';
  if (machine === 'aarch64' || machine === 'arm64') return 'arm64';
  return machine;
};

/**
 * An unpacked release, with the pieces the script insists on and a stand-in
 * for the Node runtime: what is being tested is the installing, not the
 * program.
 */
const buildRelease = ({ version = '9.9.9', arch = machineArch(), minimal = false } = {}) => {
  // From nothing every time: a tree built over another one keeps whatever the
  // first put there, and a leftover runtime is precisely what the minimal
  // archive is the absence of.
  fs.rmSync(release, { recursive: true, force: true });
  fs.mkdirSync(path.join(release, 'app', 'src'), { recursive: true });
  fs.mkdirSync(path.join(release, 'app', 'node_modules'), { recursive: true });

  fs.writeFileSync(path.join(release, 'app', 'src', 'server.js'), `// ${version}\n`);
  fs.writeFileSync(path.join(release, 'app', 'package.json'), '{"name":"stand-in"}\n');

  // The minimal archive brings neither: the machine's Node runs it, and its
  // 7-Zip comes from the distribution.
  if (!minimal) {
    fs.mkdirSync(path.join(release, 'runtime', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(release, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(release, 'runtime', 'bin', 'node'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(release, 'runtime', 'bin', 'node'), 0o755);
    fs.writeFileSync(path.join(release, 'bin', '7z'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(release, 'bin', '7z'), 0o755);
  }

  fs.writeFileSync(path.join(release, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(release, 'ARCH'), `${arch}\n`);

  for (const name of [
    'install.sh',
    'upgrade.sh',
    'nextexplorer.service.in',
    'config.env.example',
  ]) {
    fs.copyFileSync(path.join(PACKAGING, name), path.join(release, name));
  }
  fs.chmodSync(path.join(release, 'install.sh'), 0o755);
  fs.chmodSync(path.join(release, 'upgrade.sh'), 0o755);
};

/**
 * Run it the way a test may: under a prefix, touching nothing privileged.
 *
 * Both streams come back together, because what it says about a missing tool
 * or a missing systemctl it says on stderr — and that is exactly what the
 * tests below read.
 */
const install = (extra = [], { expectFailure = false, env } = {}) => {
  const result = spawnSync(
    'bash',
    [path.join(release, 'install.sh'), '--prefix', prefix, '--skip-deps', '--no-account', ...extra],
    { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env }
  );
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0 && !expectFailure) {
    throw new Error(`install.sh exited ${result.status}:\n${output}`);
  }
  if (result.status === 0 && expectFailure) {
    throw new Error(`install.sh was expected to refuse, and did not:\n${output}`);
  }
  return output;
};

const at = (...segments) => path.join(prefix, ...segments);
const read = (...segments) => fs.readFileSync(at(...segments), 'utf8');
const exists = (...segments) => fs.existsSync(at(...segments));

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-install-'));
  release = path.join(sandbox, 'release');
  prefix = path.join(sandbox, 'root');
  fs.mkdirSync(release, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });
  buildRelease();
});

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  sandbox = null;
});

describe('a first installation', () => {
  it('lays out the program, the configuration and the directories', () => {
    install(['--no-service']);

    expect(exists('opt', 'nextexplorer', 'app', 'src', 'server.js')).toBe(true);
    expect(exists('opt', 'nextexplorer', 'runtime', 'bin', 'node')).toBe(true);
    expect(exists('opt', 'nextexplorer', 'bin', '7z')).toBe(true);
    expect(read('opt', 'nextexplorer', 'VERSION').trim()).toBe('9.9.9');
    expect(exists('etc', 'nextexplorer', 'nextexplorer.env')).toBe(true);
    expect(exists('var', 'lib', 'nextexplorer')).toBe(true);
    expect(exists('var', 'cache', 'nextexplorer')).toBe(true);
    expect(exists('srv', 'nextexplorer')).toBe(true);
    // The command that installs the next release, installed by this one.
    expect(exists('usr', 'local', 'bin', 'nextexplorer-upgrade')).toBe(true);
  });

  it('writes a configuration with the answers in it and no placeholder left', () => {
    install(['--no-service', '--port', '8080', '--volumes', path.join(prefix, 'mnt', 'files')]);

    const configuration = read('etc', 'nextexplorer', 'nextexplorer.env');
    expect(configuration).toContain('PORT=8080');
    expect(configuration).toContain('VOLUME_ROOT=/mnt/files');
    expect(configuration).toContain('CONFIG_DIR=/var/lib/nextexplorer');
    expect(configuration).toContain('CACHE_DIR=/var/cache/nextexplorer');
    // The terminal opens a shell on this machine rather than inside a
    // container, so it is off until somebody says otherwise.
    expect(configuration).toContain('TERMINAL_ENABLED=false');
    expect(configuration).not.toMatch(/@[A-Z_]+@/);
    expect(exists('mnt', 'files')).toBe(true);
  });

  it('renders a unit that names the paths it may write to', () => {
    // No --no-service, so the unit is written — and under a prefix this
    // machine's systemd is left alone, which is the whole point of a staged
    // install and the reason this test says the same thing on a laptop with no
    // systemctl and on a runner that has one.
    const output = install([]);
    expect(output).toMatch(/systemd was not asked to do anything/);

    const unit = read('etc', 'systemd', 'system', 'nextexplorer.service');
    expect(unit).toContain('User=nextexplorer');
    expect(unit).toContain('ExecStart=/opt/nextexplorer/runtime/bin/node src/server.js');
    expect(unit).toContain('EnvironmentFile=/etc/nextexplorer/nextexplorer.env');
    expect(unit).toContain(
      'ReadWritePaths=/var/lib/nextexplorer /var/cache/nextexplorer /srv/nextexplorer'
    );
    expect(unit).toContain('ProtectSystem=strict');
    // The same environment the image runs with. The container has set the
    // thread pool since it was built and this install did not, so the same
    // release was quietly slower outside Docker than inside it (#9).
    expect(unit).toContain('Environment=NODE_ENV=production');
    expect(unit).toContain('Environment=UV_THREADPOOL_SIZE=16');
    expect(unit).not.toMatch(/@[A-Z_]+@/);
  });

  it('says which optional tools are missing, and what each one is for', () => {
    const output = install(['--no-service']);

    for (const [tool, reason] of Object.entries(OPTIONAL_TOOLS)) {
      if (hasTool(tool)) continue;
      expect(output).toContain(`${tool} is missing`);
      expect(output).toContain(reason);
    }
    // Asked to leave the package manager alone, it says so rather than
    // quietly doing nothing.
    expect(output).toMatch(/Left alone, as asked/);
  });
});

describe('running it again, which is what an update is', () => {
  it('leaves a configuration somebody has edited exactly as it is', () => {
    install(['--no-service']);
    const edited = `${read('etc', 'nextexplorer', 'nextexplorer.env')}\nPUBLIC_URL=https://files.example.com\n`;
    fs.writeFileSync(at('etc', 'nextexplorer', 'nextexplorer.env'), edited);

    const output = install(['--no-service', '--port', '9999']);

    // Not merged, not rewritten, and the port argument does not reach back
    // into a file that already exists.
    expect(read('etc', 'nextexplorer', 'nextexplorer.env')).toBe(edited);
    expect(output).toMatch(/was not touched/);
  });

  it('keeps the database and the volumes', () => {
    install(['--no-service']);
    fs.writeFileSync(at('var', 'lib', 'nextexplorer', 'app.db'), 'pretend');
    fs.mkdirSync(at('srv', 'nextexplorer', 'Photos'), { recursive: true });

    install(['--no-service']);

    expect(read('var', 'lib', 'nextexplorer', 'app.db')).toBe('pretend');
    expect(exists('srv', 'nextexplorer', 'Photos')).toBe(true);
  });

  it('installs the new version and stops installing what left the release', () => {
    install(['--no-service']);
    // A file from an older release, which a merge would leave behind for ever.
    fs.writeFileSync(at('opt', 'nextexplorer', 'app', 'src', 'gone-in-the-next-one.js'), 'old\n');

    buildRelease({ version: '9.9.10' });
    install(['--no-service']);

    expect(read('opt', 'nextexplorer', 'VERSION').trim()).toBe('9.9.10');
    expect(exists('opt', 'nextexplorer', 'app', 'src', 'gone-in-the-next-one.js')).toBe(false);
    expect(read('opt', 'nextexplorer', 'app', 'src', 'server.js')).toContain('9.9.10');
  });

  it('says it is updating rather than installing', () => {
    install(['--no-service']);

    expect(install(['--no-service'])).toMatch(/Updating an existing installation/);
  });

  it('changes nothing else between two identical runs', () => {
    install(['--no-service']);
    const before = snapshot();

    install(['--no-service']);

    expect(snapshot()).toEqual(before);
  });
});

describe('refusing rather than guessing', () => {
  it('will not install an archive built for another architecture', () => {
    buildRelease({ arch: machineArch() === 'x64' ? 'arm64' : 'x64' });

    const output = install(['--no-service'], { expectFailure: true });

    expect(output).toMatch(/Take the other one/);
    expect(exists('opt', 'nextexplorer')).toBe(false);
  });

  it('will not install from a directory that is not an unpacked release', () => {
    // The program itself, and not the runtime beside it: an archive without a
    // runtime is the minimal one, which is a release and installs.
    fs.rmSync(path.join(release, 'app', 'src'), { recursive: true });

    const output = install(['--no-service'], { expectFailure: true });

    expect(output).toMatch(/does not look like an unpacked release/);
  });

  it('will not run as somebody who cannot write to the real filesystem', () => {
    // Without a prefix, root is the only account that can do any of this, and
    // finding out halfway through is worse than being told at the start.
    const result = spawnSync(
      'bash',
      [path.join(release, 'install.sh'), '--no-service', '--skip-deps'],
      { encoding: 'utf8' }
    );
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    // Running these tests as root would make this one meaningless.
    if (process.getuid && process.getuid() !== 0) {
      expect(output).toMatch(/run this as root/);
    }
  });
});

describe('taking it off again', () => {
  it('removes the program and keeps everything that is somebody’s', () => {
    install(['--no-service']);
    fs.writeFileSync(at('var', 'lib', 'nextexplorer', 'app.db'), 'pretend');

    const output = install(['--no-service', '--uninstall']);

    expect(exists('opt', 'nextexplorer')).toBe(false);
    expect(exists('usr', 'local', 'bin', 'nextexplorer-upgrade')).toBe(false);
    expect(exists('etc', 'nextexplorer', 'nextexplorer.env')).toBe(true);
    expect(read('var', 'lib', 'nextexplorer', 'app.db')).toBe('pretend');
    expect(output).toMatch(/Kept, because they are yours/);
  });
});

/**
 * The archive that brings no runtime.
 *
 * Asked for by somebody packaging this for a distribution, where a bundled
 * Node is 121 MB the package manager could have provided (#9). What has to be
 * right is the version check: the three native modules in this tree are
 * prebuilt for one ABI, and another major refuses them with
 * NODE_MODULE_VERSION three seconds after the service starts — which is a
 * failure nobody reads. It is said at install time instead.
 */
describe('installing the minimal archive', () => {
  /** A Node on PATH, of whichever major the test needs. */
  const nodeSaying = (version) => {
    const binaries = path.join(prefix, 'fake-bin');
    fs.mkdirSync(binaries, { recursive: true });
    fs.writeFileSync(
      path.join(binaries, 'node'),
      `#!/bin/sh\ncase "$*" in\n  *process.versions.node*) echo '${version}' ;;\n  *) exit 0 ;;\nesac\n`
    );
    fs.chmodSync(path.join(binaries, 'node'), 0o755);
    return { PATH: `${binaries}:${process.env.PATH}` };
  };

  it('runs on the Node this machine already has', () => {
    buildRelease({ minimal: true });

    const output = install([], { env: nodeSaying('24') });

    const unit = read('etc', 'systemd', 'system', 'nextexplorer.service');
    expect(unit).toContain(`ExecStart=${path.join(prefix, 'fake-bin', 'node')} src/server.js`);
    expect(unit).not.toContain('@NODE@');
    expect(output).toContain('fake-bin/node');

    // The program is there, without the two directories the archive did not
    // carry — and nothing pretends they are.
    expect(exists('opt', 'nextexplorer', 'app', 'src', 'server.js')).toBe(true);
    expect(exists('opt', 'nextexplorer', 'runtime')).toBe(false);
    expect(exists('opt', 'nextexplorer', 'bin')).toBe(false);
  });

  it('refuses a Node no native module has a prebuild for, and says which', () => {
    buildRelease({ minimal: true });

    const output = install([], { expectFailure: true, env: nodeSaying('22') });

    expect(output).toMatch(/prebuilds for Node 24 or 26/i);
    expect(output).toContain('22');
    expect(exists('opt', 'nextexplorer', 'app')).toBe(false);
  });

  it('takes a Node that is not the one the archive would have carried', () => {
    // 26 rather than 24: what ships is one major, because the archive carries
    // one runtime, but an archive that carries none accepts every major the
    // native modules have prebuilds for. Refusing 26 would be refusing a
    // runtime that works.
    buildRelease({ minimal: true });

    install([], { env: nodeSaying('26') });

    expect(read('etc', 'systemd', 'system', 'nextexplorer.service')).toContain(
      `ExecStart=${path.join(prefix, 'fake-bin', 'node')} src/server.js`
    );
    expect(exists('opt', 'nextexplorer', 'app', 'src', 'server.js')).toBe(true);
  });

  it('refuses the major that is no longer supported upstream, whatever its ABI', () => {
    // Node 25 has an ABI the terminal and the SQLite driver both publish, so
    // nothing would fail at load. It reached end of life on 31 March 2026,
    // and a list that accepts it is an invitation to install it.
    buildRelease({ minimal: true });

    const output = install([], { expectFailure: true, env: nodeSaying('25') });

    expect(output).toMatch(/prebuilds for Node 24 or 26/i);
    expect(exists('opt', 'nextexplorer', 'app')).toBe(false);
  });

  it('refuses when there is no Node at all, and says where to get one', () => {
    buildRelease({ minimal: true });

    // Everything the script needs except a Node: emptying PATH outright would
    // take `sed` and `id` with it and the script would fail for another
    // reason entirely, which is not the refusal being tested.
    const withoutNode = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((entry) => entry && !fs.existsSync(path.join(entry, 'node')))
      .join(path.delimiter);

    const output = install([], { expectFailure: true, env: { PATH: withoutNode } });

    expect(output).toMatch(/no Node runtime/i);
    // The way out that needs nothing installed.
    expect(output).toContain('-minimal');
    expect(exists('opt', 'nextexplorer', 'app')).toBe(false);
  });

  it('takes the Node it is given, which is what sudo makes necessary', () => {
    buildRelease({ minimal: true });
    const { PATH } = nodeSaying('24');
    const named = path.join(prefix, 'fake-bin', 'node');

    // Nothing on PATH: under `sudo` the PATH is root's, and a Node installed
    // for somebody's own account is not on it. Naming it is the way out, and
    // the only way out for most people who have Node through nvm or fnm.
    const withoutNode = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((entry) => entry && !fs.existsSync(path.join(entry, 'node')))
      .join(path.delimiter);
    expect(PATH).toContain('fake-bin');

    install(['--node', named], { env: { PATH: withoutNode } });

    expect(read('etc', 'systemd', 'system', 'nextexplorer.service')).toContain(
      `ExecStart=${named} src/server.js`
    );
  });

  it('refuses a --node that is not there', () => {
    buildRelease({ minimal: true });

    const output = install(['--node', path.join(prefix, 'nowhere', 'node')], {
      expectFailure: true,
    });

    expect(output).toMatch(/is not something this can run/);
    expect(exists('opt', 'nextexplorer', 'app')).toBe(false);
  });

  it('takes the runtime away when a full install is replaced by a minimal one', () => {
    buildRelease();
    install();
    expect(exists('opt', 'nextexplorer', 'runtime', 'bin', 'node')).toBe(true);

    fs.rmSync(release, { recursive: true, force: true });
    buildRelease({ minimal: true });
    install([], { env: nodeSaying('24') });

    // A runtime left behind would be the old version answering for a release
    // that never shipped one.
    expect(exists('opt', 'nextexplorer', 'runtime')).toBe(false);
    expect(read('etc', 'systemd', 'system', 'nextexplorer.service')).toContain(
      `ExecStart=${path.join(prefix, 'fake-bin', 'node')}`
    );
  });
});

/** Everything under the prefix, with the contents of each file. */
function snapshot() {
  const entries = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const key = path.relative(prefix, full);
      if (entry.isDirectory()) {
        entries[key] = 'directory';
        walk(full);
      } else if (entry.isFile()) {
        entries[key] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(prefix);
  return entries;
}

function hasTool(tool) {
  try {
    execFileSync('command', ['-v', tool], { shell: '/bin/bash', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
