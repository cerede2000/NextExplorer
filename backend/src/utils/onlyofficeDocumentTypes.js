/**
 * Which editor the Document Server opens a file with.
 *
 * These lists are the ones the Document Server itself validates against: it
 * ships them as a regular expression in web-apps/apps/api/documents/api.js and
 * refuses the config outright when documentType disagrees with the extension.
 * They are reproduced here so the disagreement never happens.
 *
 * Getting this wrong is not a soft failure. Announcing a drawing as a text
 * document gets it opened by the wrong editor, which answers "the file content
 * does not match the file extension" — true, unhelpful, and several steps away
 * from the setting that caused it. That was the case for every extension
 * outside the four-or-five-entry lists this used to hold, .odg among them,
 * which the Document Server counts as a slide rather than a word document.
 *
 * Kept beside the route rather than inside it so the mapping can be checked
 * against that regular expression in a test.
 */

const SUPPORTED_SHEET = new Set([
  'xls', 'xlsx', 'ods', 'csv', 'tsv', 'gsheet', 'xlsm', 'xlt', 'xltm', 'xltx',
  'fods', 'ots', 'xlsb', 'sxc', 'et', 'ett', 'numbers',
]);

const SUPPORTED_PRESENTATION = new Set([
  'pps', 'ppsx', 'ppt', 'pptx', 'odp', 'gslides', 'pot', 'potm', 'potx', 'ppsm',
  'pptm', 'fodp', 'otp', 'sxi', 'dps', 'dpt', 'key', 'odg',
]);

const SUPPORTED_PDF = new Set(['pdf', 'djvu', 'xps', 'oxps']);

const SUPPORTED_TEXT = new Set([
  'doc', 'docx', 'odt', 'gdoc', 'txt', 'rtf', 'mht', 'htm', 'html', 'mhtml',
  'epub', 'docm', 'dot', 'dotm', 'dotx', 'fodt', 'ott', 'fb2', 'xml', 'oform',
  'docxf', 'sxw', 'stw', 'wps', 'wpt', 'pages', 'hwp', 'hwpx', 'md', 'hml',
]);

const SUPPORTED_DIAGRAM = new Set(['vsdx', 'vssx', 'vstx', 'vsdm', 'vssm', 'vstm']);

/**
 * @param {string} ext lowercase extension, without the dot
 * @returns {string|null} the documentType to declare, or null when the Document
 * Server has no editor for it. Null rather than a guess: 'word' as a catch-all
 * is exactly what turned an unsupported extension into an error raised by the
 * editor instead of a refusal here.
 */
const getDocumentType = (ext) => {
  if (SUPPORTED_SHEET.has(ext)) return 'cell';
  if (SUPPORTED_PRESENTATION.has(ext)) return 'slide';
  if (SUPPORTED_PDF.has(ext)) return 'pdf';
  if (SUPPORTED_TEXT.has(ext)) return 'word';
  if (SUPPORTED_DIAGRAM.has(ext)) return 'diagram';
  return null;
};

module.exports = {
  getDocumentType,
};
