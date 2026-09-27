import { describe, expect, it, vi } from 'vitest';

/**
 * The feature flags, read once when the app starts. Every optional screen
 * (editors, terminal, user volumes) decides whether to exist from this answer,
 * so a call that reaches the wrong route hides them all without an error.
 */

const { requestJson } = vi.hoisted(() => ({
  requestJson: vi.fn(async () => ({ onlyoffice: true })),
}));

vi.mock('./http', async (importOriginal) => ({
  ...(await importOriginal()),
  requestJson,
}));

const api = await import('./features.api');

describe('the features API', () => {
  it('reads the feature flags and hands back what the server answered', async () => {
    await expect(api.fetchFeatures()).resolves.toEqual({ onlyoffice: true });

    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledWith('/api/features', { method: 'GET' });
  });
});
