import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { modulePath, setupTestEnv } from '../helpers/env-test-utils.js';

/**
 * The language an account reads in.
 *
 * The interface followed the browser, which is right for somebody who has not
 * said otherwise and wrong for everybody who has: a shared machine, a browser
 * in one language and a reader in another, a phone that cannot be changed.
 *
 * Checked for shape rather than against the list of translations: that list
 * changes with a release, and a tag we no longer ship should fall back on the
 * screen, not be refused on the way in.
 */

let env;
let alice;

const load = (relative) => require(modulePath(relative));
const settings = () => load('src/services/settingsService');

beforeEach(async () => {
  env = await setupTestEnv({ tag: 'account-language-' });
  alice = await load('src/services/users').createLocalUser({
    email: 'alice@example.com',
    username: 'alice',
    displayName: 'Alice',
    password: 'secret123',
    roles: ['user'],
  });
});

afterEach(async () => {
  load('src/services/trash/maintenance').stop();
  await env.cleanup();
});

describe('a language on the account', () => {
  it.each(['fr', 'pt-BR', 'zh-Hans-CN'])('keeps %s as it was written', async (tag) => {
    await settings().setUserSetting(alice.id, 'locale', tag);

    expect((await settings().getUserSettings(alice.id)).locale).toBe(tag);
  });

  it('takes nothing as "follow the browser"', async () => {
    await settings().setUserSetting(alice.id, 'locale', 'fr');

    await settings().setUserSetting(alice.id, 'locale', null);

    expect((await settings().getUserSettings(alice.id)).locale).toBeNull();
  });

  /** A tag that is not a tag leaves what was there alone. */
  it.each(['not a tag', '../../etc/passwd', '<script>', 42])(
    'refuses %s without losing the language already chosen',
    async (bad) => {
      await settings().setUserSetting(alice.id, 'locale', 'fr');

      await settings().setUserSetting(alice.id, 'locale', bad);

      expect((await settings().getUserSettings(alice.id)).locale).toBe('fr');
    }
  );

  /**
   * A tag naming a translation that is not shipped is stored all the same: the
   * screen falls back, and a later release may add it.
   */
  it('keeps a tag for a language this build does not have', async () => {
    await settings().setUserSetting(alice.id, 'locale', 'is');

    expect((await settings().getUserSettings(alice.id)).locale).toBe('is');
  });

  it('is a preference the settings route accepts', async () => {
    const { USER_SETTING_KEYS } = settings();

    expect(USER_SETTING_KEYS.has('locale')).toBe(true);
  });
});
