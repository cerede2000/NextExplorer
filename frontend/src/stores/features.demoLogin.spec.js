import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const fetchFeatures = vi.fn();

vi.mock('@/api', () => ({
  fetchFeatures: (...args) => fetchFeatures(...args),
}));

import { useFeaturesStore } from './features';

const baseFeatures = (extra = {}) => ({
  public: { url: '', origin: '', origins: [] },
  onlyoffice: { enabled: false, extensions: [] },
  collabora: { enabled: false, extensions: [] },
  ...extra,
});

describe('features store: demo sign-in credentials', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    fetchFeatures.mockReset();
  });

  it('keeps the credentials the server publishes', async () => {
    fetchFeatures.mockResolvedValue(
      baseFeatures({ demoLogin: { email: 'demo@example.com', password: 'demo1234' } })
    );

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.demoLogin).toEqual({ email: 'demo@example.com', password: 'demo1234' });
  });

  // The server sends null on every instance that is not a demo, which is what
  // leaves the sign-in form untouched.
  it('holds nothing when the server publishes none', async () => {
    fetchFeatures.mockResolvedValue(baseFeatures({ demoLogin: null }));

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.demoLogin).toBeNull();
  });

  it('holds nothing when the field is absent altogether', async () => {
    fetchFeatures.mockResolvedValue(baseFeatures());

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.demoLogin).toBeNull();
  });

  // Half a credential pre-fills a form that then fails, which is worse than
  // leaving it empty.
  it('holds nothing when only one half arrives', async () => {
    fetchFeatures.mockResolvedValue(
      baseFeatures({ demoLogin: { email: 'demo@example.com', password: '' } })
    );

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.demoLogin).toBeNull();
  });

  it('holds nothing when the request fails', async () => {
    fetchFeatures.mockRejectedValue(new Error('offline'));

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.demoLogin).toBeNull();
  });
});
