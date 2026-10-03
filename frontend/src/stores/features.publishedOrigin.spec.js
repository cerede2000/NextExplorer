import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The name the instance is published under, handed to whoever builds a link.
 *
 * `PUBLIC_URL` is the server's answer to "what address can somebody else reach this
 * at", and it reaches the browser in `/api/features`. Until it was handed on, every
 * link the browser built came from the address bar instead — so an administrator
 * sitting on the local network created share links reading
 * `http://192.168.1.250:3017/...`, which nobody outside that network can open.
 */

const fetchFeatures = vi.fn();
vi.mock('@/api', () => ({ fetchFeatures: (...args) => fetchFeatures(...args) }));

const setPublishedOrigin = vi.fn();
vi.mock('@/api/shares.api', () => ({
  setPublishedOrigin: (...args) => setPublishedOrigin(...args),
}));

import { useFeaturesStore } from './features';

beforeEach(() => {
  setActivePinia(createPinia());
  fetchFeatures.mockReset();
  setPublishedOrigin.mockReset();
});

describe('features store: the name this instance is published under', () => {
  it('hands it to whoever builds a link', async () => {
    fetchFeatures.mockResolvedValue({
      public: { url: 'https://files.example.com/', origin: 'https://files.example.com' },
    });

    const store = useFeaturesStore();
    await store.initialize();

    expect(store.publicOrigin).toBe('https://files.example.com');
    expect(setPublishedOrigin).toHaveBeenCalledWith('https://files.example.com');
  });

  /** A server that publishes no name leaves the builder on the browser's own origin. */
  it('hands over nothing when the server publishes no name', async () => {
    fetchFeatures.mockResolvedValue({});

    const store = useFeaturesStore();
    await store.initialize();

    expect(setPublishedOrigin).toHaveBeenCalledWith('');
  });

  it('takes it back when the features cannot be read at all', async () => {
    fetchFeatures.mockRejectedValue(new Error('unreachable'));

    const store = useFeaturesStore();
    await store.initialize();

    expect(setPublishedOrigin).toHaveBeenCalledWith('');
  });
});
