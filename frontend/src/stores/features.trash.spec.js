import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Whether deleting goes to the trash, as the server says it. The delete dialog
 * and the sidebar read these; a wrong default would promise a trash that is not
 * there, so anything unclear reads as off.
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

describe('features store: the trash', () => {
  it('keeps what the server says', async () => {
    fetchFeatures.mockResolvedValue({ trash: { enabled: true, retentionDays: 45 } });

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.trashEnabled).toBe(true);
    expect(store.trashRetentionDays).toBe(45);
  });

  it('reads a server that says nothing about it as no trash', async () => {
    fetchFeatures.mockResolvedValue({});

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.trashEnabled).toBe(false);
    expect(store.trashRetentionDays).toBeNull();
  });

  it('reads a failure to ask as no trash', async () => {
    fetchFeatures.mockRejectedValue(new Error('offline'));

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.trashEnabled).toBe(false);
  });
});
