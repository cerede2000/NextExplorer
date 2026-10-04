import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * A load that failed must be a load that can be made again.
 *
 * `initialize` hands back the promise of the load in flight so a hundred
 * callers share one request. It used to hand back that promise for ever: the
 * one that failed was the only one this page would ever make, `ensureLoaded`
 * awaited the settled failure and returned happy, and the window went on
 * believing this installation has no office editor, no trash, no versions and
 * no shell — for as long as it stayed open.
 *
 * Which is exactly what one unanswered request at start produces, and a
 * session running out mid-sleep is how you get one.
 */

const fetchFeatures = vi.fn();

vi.mock('@/api', () => ({
  fetchFeatures: (...args) => fetchFeatures(...args),
}));

import { useFeaturesStore } from './features';

beforeEach(() => {
  setActivePinia(createPinia());
  fetchFeatures.mockReset();
});

describe('asking the server what this installation can do', () => {
  it('asks again after a load that failed', async () => {
    fetchFeatures.mockRejectedValueOnce(new Error('offline'));
    fetchFeatures.mockResolvedValue({ trash: { enabled: true, retentionDays: 30 } });
    const store = useFeaturesStore();

    await store.initialize();
    await store.initialize();

    expect(fetchFeatures).toHaveBeenCalledTimes(2);
    expect(store.trashEnabled).toBe(true);
  });

  it('asks again when a screen only wants to be sure they are loaded', async () => {
    fetchFeatures.mockRejectedValueOnce(new Error('offline'));
    fetchFeatures.mockResolvedValue({ versions: { enabled: true } });
    const store = useFeaturesStore();

    await store.ensureLoaded();
    await store.ensureLoaded();

    expect(store.versionsEnabled).toBe(true);
  });

  /** And one request is still one request, however many callers want it. */
  it('asks once for everybody who asks at the same moment', async () => {
    fetchFeatures.mockResolvedValue({ trash: { enabled: true } });
    const store = useFeaturesStore();

    await Promise.all([store.initialize(), store.initialize(), store.ensureLoaded()]);

    expect(fetchFeatures).toHaveBeenCalledTimes(1);
  });

  /** Loaded is loaded: nothing asks a second time for an answer in hand. */
  it('does not ask again once it has an answer', async () => {
    fetchFeatures.mockResolvedValue({ trash: { enabled: true } });
    const store = useFeaturesStore();

    await store.initialize();
    await store.initialize();
    await store.ensureLoaded();

    expect(fetchFeatures).toHaveBeenCalledTimes(1);
  });
});
