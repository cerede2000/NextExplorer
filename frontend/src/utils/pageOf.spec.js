import { describe, expect, it } from 'vitest';

import { pageOf } from './pageOf';

/**
 * Which addresses are the same page, and which are not.
 *
 * It is one line and it decides when a screen is thrown away and built again,
 * with everything it was in the middle of.
 */
describe('the page an address names', () => {
  it('is the path', () => {
    expect(pageOf('/browse/Projects')).toBe('/browse/Projects');
  });

  it('is the same page when the screen rewrites its own query', () => {
    expect(pageOf('/compare?left=a&right=b')).toBe(pageOf('/compare?left=b&right=a'));
  });

  /** A fragment is a place inside a page, not another one. */
  it('is the same page when the address names a place inside it', () => {
    expect(pageOf('/settings/user-preferences#tabs')).toBe(pageOf('/settings/user-preferences'));
  });

  it('is the same page for a query and a fragment together', () => {
    expect(pageOf('/settings/user-preferences?from=x#tabs')).toBe('/settings/user-preferences');
  });

  it('is another page when the path changes', () => {
    expect(pageOf('/browse/Here')).not.toBe(pageOf('/browse/Elsewhere'));
  });

  it('answers nothing for nothing', () => {
    expect(pageOf('')).toBe('');
    expect(pageOf(undefined)).toBe('');
    expect(pageOf(null)).toBe('');
  });
});
