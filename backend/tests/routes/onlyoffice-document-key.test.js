import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';

/**
 * The Document Server caches the prepared document under the key we send, and
 * nothing else. So the key has to change whenever what it would serve changes.
 *
 * File contents were already covered. The editor was not: a drawing first
 * opened as a text document — the mapping bug this followed — kept answering
 * with that failed attempt from cache long after the mapping was corrected.
 * Nothing was reconverted, so nothing showed up in the converter logs either,
 * and the only way out was touching the file to change its mtime.
 *
 * The key is built inline in the route, so this reproduces it. Keep the two in
 * step: the property being pinned is that the editor is part of the identity.
 */
const buildDocumentKey = (relativePath, stat, documentType) =>
  crypto
    .createHash('sha256')
    .update(relativePath)
    .update(String(stat.mtimeMs))
    .update(String(stat.ctimeMs))
    .update(String(stat.size))
    .update(String(documentType))
    .digest('hex');

const STAT = { mtimeMs: 1_700_000_000_000, ctimeMs: 1_700_000_000_000, size: 4096 };

describe('ONLYOFFICE document key', () => {
  it('changes when the same file is opened with a different editor', () => {
    const asText = buildDocumentKey('drawing.odg', STAT, 'word');
    const asSlide = buildDocumentKey('drawing.odg', STAT, 'slide');

    expect(asSlide).not.toBe(asText);
  });

  it('stays stable across opens while nothing changes', () => {
    // Two opens of an untouched document must reuse the cache, which is what
    // makes reopening a large file fast.
    expect(buildDocumentKey('report.docx', STAT, 'word')).toBe(
      buildDocumentKey('report.docx', STAT, 'word')
    );
  });

  it('still changes when the file itself changes', () => {
    const before = buildDocumentKey('report.docx', STAT, 'word');
    const edited = buildDocumentKey('report.docx', { ...STAT, mtimeMs: STAT.mtimeMs + 1 }, 'word');
    const grown = buildDocumentKey('report.docx', { ...STAT, size: STAT.size + 1 }, 'word');

    expect(edited).not.toBe(before);
    expect(grown).not.toBe(before);
  });

  it('separates two files that differ only by path', () => {
    expect(buildDocumentKey('a/report.docx', STAT, 'word')).not.toBe(
      buildDocumentKey('b/report.docx', STAT, 'word')
    );
  });
});
