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

/**
 * And asked where the visitor can reach them.
 *
 * Quiet was the answer when they could not be answered at all. Two of them can:
 * the feature flags and the branding are answered to anybody, so they are
 * answered under a share's prefix too — the only prefix a visitor behind an
 * authentication proxy reaches. Falling back to the defaults was not good enough
 * for these two: whether this installation has an office editor at all is one of
 * those flags, so a share holding a spreadsheet offered no way to open it.
 */
describe('the two a share can still be told', () => {
  const onPage = (pathname) => {
    window.history.replaceState({}, '', pathname);
  };

  it('asks for them under the prefix of the share the page is about', async () => {
    onPage('/share/TOKEN/browse/Deeper');

    await fetchFeatures();
    await getBranding();

    expect(requestJson.mock.calls.map(([called]) => called)).toEqual([
      '/api/share/TOKEN/features',
      '/api/share/TOKEN/branding',
    ]);
  });

  it('asks at the address it has always used anywhere else', async () => {
    onPage('/browse/Projects');

    await fetchFeatures();
    await getBranding();

    expect(requestJson.mock.calls.map(([called]) => called)).toEqual([
      '/api/features',
      '/api/branding',
    ]);
  });
});
