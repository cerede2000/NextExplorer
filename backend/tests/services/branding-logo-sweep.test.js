import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The logos nothing points at any more.
 *
 * A branding change writes the new logo, places it under a name of its own,
 * makes it the logo in the settings, and only then removes the one it
 * replaced. A stop in the middle of that, or a removal that fails, leaves a
 * file no setting names — and a logo's address is the name of its file, so
 * nothing can ask for it again. At up to 2 MB each they stayed for good.
 *
 * The sweep runs at start, where nothing of ours is being placed. What it may
 * remove is decided by the names this application writes, never by the
 * listing: `/config/logos` is a directory on somebody's disk, and what else
 * they keep there is theirs.
 */

const A_LOGO = 'logo-0b7f7c1e-3d44-4c55-9a8e-1f2a3b4c5d6e.png';
const ANOTHER_LOGO = 'logo-2c9a4d55-1b22-4e33-8f44-5a6b7c8d9e0f.svg';
const A_PLACED_ALONGSIDE = 'logo-3d0b5e66-2c33-4f44-9055-6b7c8d9e0f11 (1).jpg';

let env;

afterEach(async () => {
  if (env) await env.cleanup();
  env = null;
});

const logoDir = () => path.join(env.configDir, 'logos');

const seed = async (names, branding) => {
  env = await setupTestEnv({ tag: 'logo-sweep-' });
  const db = await env.requireFresh('src/services/db').getDb();
  if (branding !== undefined) {
    db.prepare(
      `INSERT INTO system_settings (id, category, key, value, updated_at)
       VALUES ('branding', 'branding', 'branding', ?, ?)`
    ).run(JSON.stringify(branding), new Date().toISOString());
  }
  await fs.mkdir(logoDir(), { recursive: true });
  for (const name of names) {
    await fs.writeFile(path.join(logoDir(), name), name);
  }
  return env.requireFresh('src/services/brandingLogo');
};

const remaining = async () => (await fs.readdir(logoDir())).sort();

describe('sweeping the logos no longer in use', () => {
  it('removes the ones this application wrote, and keeps the one in use', async () => {
    const service = await seed([A_LOGO, ANOTHER_LOGO, A_PLACED_ALONGSIDE], {
      appName: 'Explorer',
      appLogoUrl: `/static/logos/${A_LOGO}`,
      showPoweredBy: false,
    });

    await service.sweepUnreferencedLogos();

    expect(await remaining()).toEqual([A_LOGO]);
  });

  it('removes the fixed names earlier versions wrote, unless one is still the logo', async () => {
    const service = await seed(['custom-logo.svg', 'custom-logo.png', 'custom-logo.jpg', A_LOGO], {
      appName: 'Explorer',
      appLogoUrl: '/static/logos/custom-logo.png',
      showPoweredBy: false,
    });

    await service.sweepUnreferencedLogos();

    expect(await remaining()).toEqual(['custom-logo.png']);
  });

  it('removes every one of them when the branding is back to the default logo', async () => {
    const service = await seed([A_LOGO, 'custom-logo.jpg'], {
      appName: 'Explorer',
      appLogoUrl: '/logo.svg',
      showPoweredBy: false,
    });

    await service.sweepUnreferencedLogos();

    expect(await remaining()).toEqual([]);
  });

  /**
   * The names are the whole guard. Anything else in that directory was put
   * there by whoever owns the disk — including a file that merely looks like
   * one of ours, which is why the shape is matched exactly rather than by
   * prefix.
   */
  it('never touches a file somebody else put there', async () => {
    const theirs = [
      'branding-guidelines.pdf',
      'logo.png',
      'logo-old.png',
      'logo-0b7f7c1e-3d44-4c55-9a8e-1f2a3b4c5d6e.gif',
      'custom-logo.webp',
      'my-custom-logo.png',
      `${A_LOGO}.bak`,
    ];
    const service = await seed([...theirs, ANOTHER_LOGO], {
      appName: 'Explorer',
      appLogoUrl: '/logo.svg',
      showPoweredBy: false,
    });

    await service.sweepUnreferencedLogos();

    expect(await remaining()).toEqual([...theirs].sort());
  });

  it('leaves a directory alone, whatever it is called', async () => {
    const service = await seed([], { appName: 'Explorer', appLogoUrl: '/logo.svg' });
    await fs.mkdir(path.join(logoDir(), A_LOGO));

    await service.sweepUnreferencedLogos();

    expect(await remaining()).toEqual([A_LOGO]);
  });

  it('passes quietly when no logo was ever uploaded', async () => {
    env = await setupTestEnv({ tag: 'logo-sweep-' });
    await env.requireFresh('src/services/db').getDb();
    const service = env.requireFresh('src/services/brandingLogo');

    await expect(service.sweepUnreferencedLogos()).resolves.toBeUndefined();
    await expect(fs.access(logoDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
