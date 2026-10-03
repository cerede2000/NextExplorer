import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a page reads before anybody has done anything, read quietly.
 *
 * Three calls go out on every load, whoever is looking: what this installation
 * offers, what it is called, and whether there is a session. Each of them is
 * answered for by the application itself — the features fall back to defaults,
 * the branding to the built-in name, the status to "not signed in" — so a reader
 * cannot be told anything useful about their failure.
 *
 * They were not quiet, and a visitor opening a share link from outside a network
 * where an authentication proxy sits in front of the application was handed a red
 * banner for each of them, three in a row, before the share appeared anyway.
 */

const requestJson = vi.fn(async () => ({}));
vi.mock('./http', () => ({
  requestJson: (...args) => requestJson(...args),
  buildUrl: (path) => path,
}));

import { fetchFeatures } from './features.api';
import { getBranding } from './settings.api';
import { fetchAuthStatus } from './auth.api';

beforeEach(() => {
  requestJson.mockClear();
});

const optionsOf = (path) => requestJson.mock.calls.find(([called]) => called === path)?.[1] || {};

describe('the calls a page makes before anybody has done anything', () => {
  it('asks what this installation offers without a word about it going wrong', async () => {
    await fetchFeatures();

    expect(optionsOf('/api/features').suppressErrorHandler).toBe(true);
  });

  it('asks what it is called the same way', async () => {
    await getBranding();

    expect(optionsOf('/api/branding').suppressErrorHandler).toBe(true);
  });

  it('asks whether there is a session the same way', async () => {
    await fetchAuthStatus();

    expect(optionsOf('/api/auth/status').suppressErrorHandler).toBe(true);
  });
});
