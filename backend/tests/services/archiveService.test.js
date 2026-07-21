import { describe, expect, it } from 'vitest';

// eslint-disable-next-line global-require
const {
  normalizeArchivePassword,
  isArchivePasswordError,
} = require('../../src/services/archiveService');

describe('archive service password handling', () => {
  it('accepts a short-lived password without transforming it', () => {
    expect(normalizeArchivePassword('correct horse battery staple')).toBe(
      'correct horse battery staple'
    );
    expect(normalizeArchivePassword('')).toBe('');
    expect(normalizeArchivePassword(undefined)).toBeNull();
  });

  it('rejects values that cannot safely be sent to the extractor prompt', () => {
    expect(() => normalizeArchivePassword('line one\nline two')).toThrow('Invalid archive password.');
    expect(() => normalizeArchivePassword('x'.repeat(4097))).toThrow('Invalid archive password.');
    expect(() => normalizeArchivePassword({ secret: 'nope' })).toThrow('Invalid archive password.');
  });

  it('recognizes encrypted archive failures without exposing extractor output', () => {
    expect(isArchivePasswordError(new Error('ERROR: Wrong password : secret.7z'))).toBe(true);
    expect(isArchivePasswordError(new Error('Data Error in encrypted file. Wrong password?'))).toBe(
      true
    );
    expect(isArchivePasswordError(new Error('Enter password (will not be echoed):'))).toBe(true);
    expect(isArchivePasswordError(new Error('Unexpected end of archive'))).toBe(false);
  });
});
