import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { getDocumentType } = require('../../src/utils/onlyofficeDocumentTypes');

/**
 * The Document Server validates documentType against the extension and refuses
 * the config when the two disagree — the user sees "the file content does not
 * match the file extension", which names the file and never the mapping that
 * sent it to the wrong editor.
 *
 * This is the expression it validates with, copied from a running server's
 * web-apps/apps/api/documents/api.js. Its capture groups are, in order, the
 * five editors. Checking our mapping against it is the only way to know the
 * two agree; a hand-written list of examples would only prove the examples.
 */
const DOCUMENT_SERVER_GROUPS = [
  ['cell', 'xls|xlsx|ods|csv|tsv|gsheet|xlsm|xlt|xltm|xltx|fods|ots|xlsb|sxc|et|ett|numbers'],
  ['slide', 'pps|ppsx|ppt|pptx|odp|gslides|pot|potm|potx|ppsm|pptm|fodp|otp|sxi|dps|dpt|key|odg'],
  ['pdf', 'pdf|djvu|xps|oxps'],
  [
    'word',
    'doc|docx|odt|gdoc|txt|rtf|mht|htm|html|mhtml|epub|docm|dot|dotm|dotx|fodt|ott|fb2|xml|oform|docxf|sxw|stw|wps|wpt|pages|hwp|hwpx|md|hml',
  ],
  ['diagram', 'vsdx|vssx|vstx|vsdm|vssm|vstm'],
];

describe('ONLYOFFICE document types', () => {
  it('agrees with the Document Server on every extension it accepts', () => {
    const disagreements = [];

    for (const [expected, extensions] of DOCUMENT_SERVER_GROUPS) {
      for (const ext of extensions.split('|')) {
        const actual = getDocumentType(ext);
        if (actual !== expected) disagreements.push({ ext, expected, actual });
      }
    }

    expect(disagreements).toEqual([]);
  });

  it('opens a drawing with the slide editor, not the text one', () => {
    // The case that surfaced this: .odg went through the catch-all and was
    // announced as a word document, so the Document Server refused it.
    expect(getDocumentType('odg')).toBe('slide');
  });

  it('recognises the editors added after word/cell/slide', () => {
    expect(getDocumentType('pdf')).toBe('pdf');
    expect(getDocumentType('vsdx')).toBe('diagram');
  });

  it('refuses an extension the Document Server has no editor for', () => {
    // Null, not a guess. Guessing is what produced an error raised by the
    // editor rather than a refusal here, where the setting can be named.
    for (const ext of ['zip', 'png', 'mp4', 'iso', '']) {
      expect(getDocumentType(ext)).toBeNull();
    }
  });
});
