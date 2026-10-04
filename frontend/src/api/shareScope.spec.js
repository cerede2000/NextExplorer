import { describe, it, expect } from 'vitest';
import { shareScoped, shareTokenOfPath } from './shareScope.js';

describe('which share a path belongs to', () => {
  it('reads the token out of a path inside one', () => {
    expect(shareTokenOfPath('share/TOKEN')).toBe('TOKEN');
    expect(shareTokenOfPath('share/TOKEN/Deeper/notes.txt')).toBe('TOKEN');
  });

  it('is nothing for a path that is not in a share', () => {
    expect(shareTokenOfPath('Projects/notes.txt')).toBe('');
    expect(shareTokenOfPath('')).toBe('');
    expect(shareTokenOfPath(null)).toBe('');
  });

  /** A folder of somebody's called `shared` is not a share. */
  it('is not fooled by a name that starts the same way', () => {
    expect(shareTokenOfPath('shared/with-me/notes.txt')).toBe('');
    expect(shareTokenOfPath('sharelike/x')).toBe('');
  });
});

describe('where a request about a path is sent', () => {
  it('leaves an ordinary path at the address it has always had', () => {
    expect(shareScoped('/api/preview', 'Projects/picture.png')).toBe('/api/preview');
    expect(shareScoped('/api/download', '')).toBe('/api/download');
  });

  it('puts anything about a shared path under that share', () => {
    expect(shareScoped('/api/preview', 'share/TOKEN/picture.png')).toBe('/api/share/TOKEN/preview');
    expect(shareScoped('/api/download', 'share/TOKEN')).toBe('/api/share/TOKEN/download');
  });

  it('keeps the rest of the address, however deep it goes', () => {
    expect(shareScoped('/api/download/part/PLAN/3', 'share/TOKEN/Deeper')).toBe(
      '/api/share/TOKEN/download/part/PLAN/3'
    );
    expect(shareScoped('/api/folder-size/batch', 'share/TOKEN/Deeper')).toBe(
      '/api/share/TOKEN/folder-size/batch'
    );
  });

  /** A token is a path segment, and what goes in one is encoded. */
  it('encodes the token it puts in the address', () => {
    expect(shareScoped('/api/preview', 'share/a b/x.png')).toBe('/api/share/a%20b/preview');
  });
});
