import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Whether saves keep versions, as the server says it. The menu and the details
 * panel offer a file's history on this; anything unclear reads as off, so no
 * one is offered a history the server does not keep.
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

describe('features store: file versions', () => {
  it('keeps what the server says, independently of the trash', async () => {
    fetchFeatures.mockResolvedValue({ trash: { enabled: false }, versions: { enabled: true } });

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.versionsEnabled).toBe(true);
    expect(store.trashEnabled).toBe(false);
  });

  it('reads a server that says nothing about them as no versions', async () => {
    fetchFeatures.mockResolvedValue({ trash: { enabled: true } });

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.versionsEnabled).toBe(false);
  });

  it('reads anything but a plain yes as no versions', async () => {
    fetchFeatures.mockResolvedValue({ versions: { enabled: 'yes' } });

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.versionsEnabled).toBe(false);
  });

  it('reads a failure to ask as no versions', async () => {
    fetchFeatures.mockRejectedValue(new Error('offline'));

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.versionsEnabled).toBe(false);
  });
});
