import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Disk usage per volume, and the restraint around asking for it.
 *
 * Every write in the explorer schedules a refresh — upload, delete, move, folder
 * creation — so on a busy folder this is asked for constantly. Asking costs a
 * `statfs` per volume on the server, over a network mount if that is what it is.
 * Three guards keep that from becoming the load: a throttle, one in-flight
 * request shared by every caller, and a debounce on the scheduled kind.
 *
 * The fourth behaviour is per-volume degradation. One unreachable mount must not
 * blank the figures for the others — which is exactly when it happens, since a
 * mount goes away while the rest are fine.
 */

const getUsage = vi.fn();
const getVolumes = vi.fn();
let features;

vi.mock('@/api', () => ({
  getUsage: (...a) => getUsage(...a),
  getVolumes: (...a) => getVolumes(...a),
  normalizePath: (p = '') => String(p).replace(/^\/+|\/+$/g, ''),
}));
vi.mock('@/stores/features', () => ({ useFeaturesStore: () => features }));

import { useVolumeUsageStore } from './volumeUsage';

const VOLUMES = [{ path: 'Media' }, { path: 'Docs' }];

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useRealTimers();
  getUsage.mockReset();
  getVolumes.mockReset();
  getVolumes.mockResolvedValue(VOLUMES);
  getUsage.mockImplementation(async (path) => ({
    path,
    total: 1000,
    used: 250,
    free: 750,
  }));
  features = { ensureLoaded: vi.fn().mockResolvedValue(), volumeUsageEnabled: true };
});

describe('loading the volumes', () => {
  it('reads them and their usage in one go', async () => {
    const store = useVolumeUsageStore();

    await store.loadVolumes();

    expect(store.volumes).toHaveLength(2);
    expect(store.hasLoadedVolumes).toBe(true);
    expect(store.usage.Media.percentUsed).toBe(25);
  });

  it('does not reload what it already has', async () => {
    const store = useVolumeUsageStore();
    await store.loadVolumes();
    getVolumes.mockClear();

    await store.loadVolumes();

    expect(getVolumes).not.toHaveBeenCalled();
  });

  it('reloads when asked to force it', async () => {
    const store = useVolumeUsageStore();
    await store.loadVolumes();
    getVolumes.mockClear();

    await store.loadVolumes({ force: true });

    expect(getVolumes).toHaveBeenCalledTimes(1);
  });

  /** Two panels mounting at once must not each ask the server. */
  it('shares one request between callers that arrive together', async () => {
    const store = useVolumeUsageStore();

    await Promise.all([store.loadVolumes(), store.loadVolumes(), store.loadVolumes()]);

    expect(getVolumes).toHaveBeenCalledTimes(1);
  });

  it('reads the volumes but not their usage when the feature is off', async () => {
    features.volumeUsageEnabled = false;
    const store = useVolumeUsageStore();

    await store.loadVolumes();

    expect(store.volumes).toHaveLength(2);
    expect(getUsage).not.toHaveBeenCalled();
  });

  it('clears the busy flag when the request fails', async () => {
    getVolumes.mockRejectedValue(new Error('offline'));
    const store = useVolumeUsageStore();

    await expect(store.loadVolumes()).rejects.toThrow('offline');
    expect(store.isLoadingVolumes).toBe(false);
  });
});

describe('refreshing the usage', () => {
  it('empties the figures rather than showing stale ones when the feature goes off', async () => {
    const store = useVolumeUsageStore();
    await store.loadVolumes();
    features.volumeUsageEnabled = false;

    await store.refreshUsage({ force: true });

    expect(store.usage).toEqual({});
  });

  it('loads the volumes first when it has none', async () => {
    const store = useVolumeUsageStore();

    await store.refreshUsage();

    expect(getVolumes).toHaveBeenCalled();
    expect(store.usage.Media).toBeTruthy();
  });

  /**
   * Every write schedules one of these. Without the throttle, saving a file in
   * a loop asks the server for a statfs per volume per save.
   */
  it('does nothing again within the throttle window', async () => {
    const store = useVolumeUsageStore();
    await store.loadVolumes();
    getUsage.mockClear();

    await store.refreshUsage();

    expect(getUsage).not.toHaveBeenCalled();
  });

  it('goes anyway when forced', async () => {
    const store = useVolumeUsageStore();
    await store.loadVolumes();
    getUsage.mockClear();

    await store.refreshUsage({ force: true });

    expect(getUsage).toHaveBeenCalledTimes(2);
  });

  it('shares one refresh between callers that arrive together', async () => {
    const store = useVolumeUsageStore();
    await store.loadVolumes({ force: true });
    getUsage.mockClear();

    await Promise.all([
      store.refreshUsage({ force: true }),
      store.refreshUsage({ force: true }),
      store.refreshUsage({ force: true }),
    ]);

    expect(getUsage).toHaveBeenCalledTimes(2);
  });

  /**
   * A mount that has gone away is the normal case for this failing, and the
   * other volumes are fine. Blanking all of them would be the wrong report.
   */
  it('keeps the volumes that answered when one does not', async () => {
    const store = useVolumeUsageStore();
    getUsage.mockImplementation(async (path) => {
      if (path === 'Media') throw new Error('mount gone');
      return { path, total: 1000, used: 100, free: 900 };
    });

    await store.loadVolumes();

    expect(store.usage.Media).toBeUndefined();
    expect(store.usage.Docs.used).toBe(100);
  });

  it('leaves a previously known figure in place when a later read fails', async () => {
    const store = useVolumeUsageStore();
    await store.loadVolumes();
    getUsage.mockRejectedValue(new Error('mount gone'));

    await store.refreshUsage({ force: true });

    expect(store.usage.Media.used).toBe(250);
  });

  it('clears the busy flag afterwards', async () => {
    const store = useVolumeUsageStore();
    await store.loadVolumes();

    await store.refreshUsage({ force: true });

    expect(store.isLoadingUsage).toBe(false);
  });
});

describe('the figures it derives', () => {
  it('computes a percentage the server did not send', async () => {
    getUsage.mockResolvedValue({ path: 'Media', total: 400, used: 100, free: 300 });
    const store = useVolumeUsageStore();

    await store.loadVolumes();

    expect(store.usage.Media.percentUsed).toBe(25);
  });

  it('prefers the percentage the server did send', async () => {
    getUsage.mockResolvedValue({ path: 'Media', total: 400, used: 100, free: 300, percentUsed: 90 });
    const store = useVolumeUsageStore();

    await store.loadVolumes();

    expect(store.usage.Media.percentUsed).toBe(90);
  });

  /** A bar cannot be more than full, or less than empty. */
  it('clamps a percentage outside nought to a hundred', async () => {
    getUsage.mockResolvedValueOnce({ path: 'Media', total: 400, used: 100, percentUsed: 140 });
    getUsage.mockResolvedValueOnce({ path: 'Docs', total: 400, used: 100, percentUsed: -20 });
    const store = useVolumeUsageStore();

    await store.loadVolumes();

    expect(store.usage.Media.percentUsed).toBe(100);
    expect(store.usage.Docs.percentUsed).toBe(0);
  });

  /** Zero total is a mount that did not answer, not a full disk. */
  it('reports nought rather than dividing by zero', async () => {
    getUsage.mockResolvedValue({ path: 'Media', total: 0, used: 0, free: 0 });
    const store = useVolumeUsageStore();

    await store.loadVolumes();

    expect(store.usage.Media.percentUsed).toBe(0);
  });

  it('accepts `size` where a server sends that instead of `used`', async () => {
    getUsage.mockResolvedValue({ path: 'Media', total: 1000, size: 400 });
    const store = useVolumeUsageStore();

    await store.loadVolumes();

    expect(store.usage.Media.used).toBe(400);
  });

  it('treats missing numbers as zero rather than NaN', async () => {
    getUsage.mockResolvedValue({ path: 'Media' });
    const store = useVolumeUsageStore();

    await store.loadVolumes();

    expect(store.usage.Media).toMatchObject({ total: 0, used: 0, free: 0, percentUsed: 0 });
  });
});

describe('the scheduled refresh', () => {
  it('waits before asking', async () => {
    vi.useFakeTimers();
    const store = useVolumeUsageStore();
    store.volumes = VOLUMES;
    getUsage.mockClear();

    store.scheduleRefresh({ delayMs: 500 });
    expect(getUsage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(getUsage).toHaveBeenCalled();
  });

  /** Ten deletes in a row are one refresh, not ten. */
  it('collapses a burst into a single ask', async () => {
    vi.useFakeTimers();
    const store = useVolumeUsageStore();
    store.volumes = VOLUMES;
    getUsage.mockClear();

    for (let i = 0; i < 10; i += 1) store.scheduleRefresh({ delayMs: 500 });
    await vi.advanceTimersByTimeAsync(500);

    expect(getUsage).toHaveBeenCalledTimes(2); // one per volume, once
  });

  it('swallows a failure rather than leaving it unhandled', async () => {
    vi.useFakeTimers();
    getUsage.mockRejectedValue(new Error('offline'));
    const store = useVolumeUsageStore();
    store.volumes = VOLUMES;

    store.scheduleRefresh({ delayMs: 100 });

    await expect(vi.advanceTimersByTimeAsync(100)).resolves.not.toThrow();
  });
});
