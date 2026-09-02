import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Settings, and who they belong to.
 *
 * The subtle part is not loading them, it is that they are held per account.
 * Signing out and signing in as somebody else while a request is in flight is
 * ordinary on a shared machine, and both `load` and `save` capture the user id
 * before they start so a late answer cannot apply one person's preferences to
 * another's session. Nothing was covering either guard.
 *
 * The other piece is `thumbnailsEnabledForSession`, which fails *open*: a guest
 * on a share link has no settings to read, and refusing thumbnails because
 * nothing was loaded would leave a gallery of grey squares. It only says no
 * when it has actually been told no.
 */

const getSettingsApi = vi.fn();
const patchSettingsApi = vi.fn();
const getBrandingApi = vi.fn();
let authStore;

vi.mock('@/api', () => ({
  getSettings: (...a) => getSettingsApi(...a),
  patchSettings: (...a) => patchSettingsApi(...a),
  getBranding: (...a) => getBrandingApi(...a),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: () => authStore }));

import { useAppSettings } from './appSettings';

const ALICE = { id: 'alice', roles: ['user'] };
const BOB = { id: 'bob', roles: ['user'] };

beforeEach(() => {
  setActivePinia(createPinia());
  [getSettingsApi, patchSettingsApi, getBrandingApi].forEach((m) => m.mockReset());
  getSettingsApi.mockResolvedValue({
    branding: { appName: 'NextExplorer' },
    user: { showThumbnails: true },
    thumbnails: { enabled: true },
  });
  patchSettingsApi.mockResolvedValue({});
  getBrandingApi.mockResolvedValue({ appName: 'NextExplorer' });
  authStore = { currentUser: ALICE };
});

describe('branding', () => {
  it('takes what the server sent and fills the rest in', async () => {
    getBrandingApi.mockResolvedValue({ appName: 'Chez Benjy' });
    const settings = useAppSettings();

    await settings.loadBranding();

    expect(settings.publicSettings.branding).toMatchObject({
      appName: 'Chez Benjy',
      appLogoUrl: '/logo.svg',
      showPoweredBy: false,
    });
  });

  /** The login page loads branding before anyone is signed in; it must not fail. */
  it('keeps its defaults and raises nothing when the request fails', async () => {
    getBrandingApi.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const settings = useAppSettings();

    await settings.loadBranding();

    expect(settings.publicSettings.branding.appName).toBe('Explorer');
    expect(settings.lastError).toBeNull();
    vi.restoreAllMocks();
  });

  it('survives a server answering with nothing at all', async () => {
    getBrandingApi.mockResolvedValue(null);
    const settings = useAppSettings();

    await settings.loadBranding();

    expect(settings.publicSettings.branding.appName).toBe('Explorer');
  });
});

describe('loading', () => {
  it('reads the settings and marks itself loaded', async () => {
    const settings = useAppSettings();

    await settings.load();

    expect(settings.loaded).toBe(true);
    expect(settings.loading).toBe(false);
    expect(settings.publicSettings.branding.appName).toBe('NextExplorer');
  });

  it('does not read them again for the same person', async () => {
    const settings = useAppSettings();
    await settings.ensureLoaded();

    await settings.ensureLoaded();

    expect(getSettingsApi).toHaveBeenCalledTimes(1);
  });

  /**
   * The guard that matters on a shared machine: Bob must not inherit Alice's
   * preferences because the store still holds them.
   */
  it('reads them again when a different person signs in', async () => {
    const settings = useAppSettings();
    await settings.ensureLoaded();

    authStore.currentUser = BOB;
    await settings.ensureLoaded();

    expect(getSettingsApi).toHaveBeenCalledTimes(2);
  });

  it('reads them again after a sign-out', async () => {
    const settings = useAppSettings();
    await settings.ensureLoaded();

    authStore.currentUser = null;
    await settings.ensureLoaded();

    expect(getSettingsApi).toHaveBeenCalledTimes(2);
  });

  it('clears the busy flag when the request fails', async () => {
    getSettingsApi.mockRejectedValue(new Error('offline'));
    const settings = useAppSettings();

    await settings.load();

    expect(settings.loading).toBe(false);
  });
});

describe('saving', () => {
  it('sends the change and keeps what came back', async () => {
    patchSettingsApi.mockResolvedValue({ user: { showThumbnails: false } });
    const settings = useAppSettings();
    await settings.load();

    await settings.save({ user: { showThumbnails: false } });

    expect(patchSettingsApi).toHaveBeenCalledWith({ user: { showThumbnails: false } });
    expect(settings.userSettings.showThumbnails).toBe(false);
  });

  it('merges rather than replacing, so untouched preferences survive', async () => {
    getSettingsApi.mockResolvedValue({
      user: { showThumbnails: true, defaultView: 'grid' },
      thumbnails: { enabled: true },
    });
    patchSettingsApi.mockResolvedValue({ user: { showThumbnails: false } });
    const settings = useAppSettings();
    await settings.load();

    await settings.save({ user: { showThumbnails: false } });

    expect(settings.userSettings.defaultView).toBe('grid');
  });

  /**
   * The race this exists for. Somebody saves a preference, signs out, and
   * somebody else signs in before the answer lands — applying it then would put
   * Alice's preference into Bob's session.
   */
  it('discards an answer that arrives after somebody else has signed in', async () => {
    let settle;
    patchSettingsApi.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const settings = useAppSettings();
    await settings.load();

    const saving = settings.save({ user: { showThumbnails: false } });
    authStore.currentUser = BOB;
    settle({ user: { showThumbnails: false } });
    await saving;

    expect(settings.userSettings.showThumbnails).not.toBe(false);
  });

  it('updates the branding when the answer carries it', async () => {
    patchSettingsApi.mockResolvedValue({ branding: { appName: 'Renamed' } });
    const settings = useAppSettings();
    await settings.load();

    await settings.save({ branding: { appName: 'Renamed' } });

    expect(settings.publicSettings.branding.appName).toBe('Renamed');
  });
});

describe('whether thumbnails are on for this session', () => {
  /**
   * Fails open. A guest on a share link has no settings to read, and grey
   * squares because nothing loaded is worse than a thumbnail nobody wanted.
   */
  it('says yes before anything has been loaded', () => {
    const settings = useAppSettings();

    expect(settings.thumbnailsEnabledForSession).toBe(true);
  });

  it('says yes for a guest, who has no preference of their own', async () => {
    authStore.currentUser = null;
    getSettingsApi.mockResolvedValue({ thumbnails: { enabled: true } });
    const settings = useAppSettings();
    await settings.load();

    expect(settings.thumbnailsEnabledForSession).toBe(true);
  });

  it('says no when the deployment switched them off', async () => {
    getSettingsApi.mockResolvedValue({ thumbnails: { enabled: false }, user: {} });
    const settings = useAppSettings();
    await settings.load();

    expect(settings.thumbnailsEnabledForSession).toBe(false);
  });

  it('says no when a signed-in person switched them off', async () => {
    getSettingsApi.mockResolvedValue({
      thumbnails: { enabled: true },
      user: { showThumbnails: false },
    });
    const settings = useAppSettings();
    await settings.load();

    expect(settings.thumbnailsEnabledForSession).toBe(false);
  });

  /** A preference belongs to an account; nobody else inherits it. */
  it('ignores a stored preference when nobody is signed in', async () => {
    getSettingsApi.mockResolvedValue({
      thumbnails: { enabled: true },
      user: { showThumbnails: false },
    });
    const settings = useAppSettings();
    await settings.load();
    authStore.currentUser = null;

    expect(settings.thumbnailsEnabledForSession).toBe(true);
  });

  /** The deployment's answer wins: a person cannot switch on what is switched off. */
  it('stays off when the deployment says off and the person says on', async () => {
    getSettingsApi.mockResolvedValue({
      thumbnails: { enabled: false },
      user: { showThumbnails: true },
    });
    const settings = useAppSettings();
    await settings.load();

    expect(settings.thumbnailsEnabledForSession).toBe(false);
  });
});
