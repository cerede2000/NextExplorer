import { describe, expect, it } from 'vitest';
import { documentRoute } from './documentRoute';

/**
 * The address a document is opened at.
 *
 * This one is worth more care than a route helper usually is: its result is
 * handed to `window.open`, so a file name that escapes the encoding does not
 * produce a broken link — it produces a second tab on somewhere else. Every
 * case below is a name somebody can create, because a file name is whatever
 * the person who uploaded it typed.
 */
describe('the address of a document', () => {
  it('keeps the slashes between segments and encodes what is inside them', () => {
    expect(documentRoute('Docs/Reports/Q3 plan.docx')).toEqual({
      path: '/open/Docs/Reports/Q3%20plan.docx',
    });
  });

  it('encodes the characters that would otherwise change the address', () => {
    expect(documentRoute('Notes/a b#c?d.png')).toEqual({ path: '/open/Notes/a%20b%23c%3Fd.png' });
    expect(documentRoute('Notes/100%.txt')).toEqual({ path: '/open/Notes/100%25.txt' });
    expect(documentRoute('Notes/a&b=c.txt')).toEqual({ path: '/open/Notes/a%26b%3Dc.txt' });
  });

  it('cannot be talked into an address somewhere else', () => {
    // A scheme in a file name stays a file name: the path it builds always
    // begins with `/open/`, so nothing here can become a destination.
    for (const name of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://evil.example/steal',
      '//evil.example/steal',
      '\\\\evil.example\\steal',
    ]) {
      const { path } = documentRoute(`Notes/${name}`);
      expect(path.startsWith('/open/Notes/'), `${name} left the folder`).toBe(true);
      expect(path).not.toContain('//evil');
      expect(path.toLowerCase()).not.toContain('javascript:');
      expect(path.toLowerCase()).not.toContain('data:');
    }
  });

  it('drops the empty segments a doubled or leading slash leaves behind', () => {
    expect(documentRoute('//Notes//deep///file.txt')).toEqual({
      path: '/open/Notes/deep/file.txt',
    });
  });

  it('answers with the listing rather than an address for nothing at all', () => {
    for (const nothing of ['', '/', null, undefined]) {
      expect(documentRoute(nothing)).toEqual({ path: '/browse/' });
    }
  });
});
