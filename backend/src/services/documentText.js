const path = require('path');

const {
  findOfficeTextMatch,
  isOfficeDocument,
  SUPPORTED_EXTENSIONS: OFFICE_EXTENSIONS,
} = require('./officeTextExtract');
const { extractPdfTextLines } = require('./pdfTextExtract');

/**
 * Searching inside the documents whose text a plain content search cannot see.
 *
 * Office files are zip archives, PDFs are compressed streams: ripgrep reads
 * both as binary and finds nothing in them, however the search is configured.
 * They are read differently — a zip in this process, a PDF through pdftotext —
 * and this is the one door the search goes through for either.
 */

const SEARCHABLE_EXTENSIONS = [...OFFICE_EXTENSIONS, 'pdf'];

const extensionOf = (filePath) => path.extname(filePath || '').slice(1).toLowerCase();

/** Whether this is a document whose text has to be extracted to be searched. */
const isSearchableDocument = (filePath) => SEARCHABLE_EXTENSIONS.includes(extensionOf(filePath));

/**
 * The first line of a document containing `needle`, or null.
 *
 * @returns {Promise<{ line: string, lineNumber: number }|null>}
 */
const findDocumentTextMatch = async (absolutePath, needle) => {
  const lowered = String(needle || '').toLowerCase();
  if (!lowered) return null;

  if (isOfficeDocument(absolutePath)) {
    return findOfficeTextMatch(absolutePath, lowered);
  }

  if (extensionOf(absolutePath) !== 'pdf') return null;

  const lines = await extractPdfTextLines(absolutePath);
  if (!lines) return null;

  const index = lines.findIndex((line) => line.toLowerCase().includes(lowered));
  return index === -1 ? null : { line: lines[index], lineNumber: index + 1 };
};

module.exports = { findDocumentTextMatch, isSearchableDocument, SEARCHABLE_EXTENSIONS };
