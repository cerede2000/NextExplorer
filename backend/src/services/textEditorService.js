const fs = require('fs/promises');
const path = require('path');

const config = require('../config');
const { ValidationError, UnsupportedMediaTypeError } = require('../errors/AppError');

const MAX_EDITOR_FILE_SIZE = config.editor?.maxFileSizeBytes ?? 1 * 1024 * 1024;
const VIDEO_EXTENSIONS = Array.isArray(config.extensions?.videos) ? config.extensions.videos : [];

function isProbablyBinaryBuffer(buffer) {
  const length = Math.min(buffer.length, 4096);
  if (!length) return false;

  let suspicious = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }

  return suspicious / length > 0.3;
}

async function readTextFile(absolutePath) {
  const stats = await fs.stat(absolutePath);

  if (stats.isDirectory()) {
    throw new ValidationError('Cannot open a directory in the text editor.');
  }

  if (typeof stats.size === 'number' && stats.size > MAX_EDITOR_FILE_SIZE) {
    throw new ValidationError('This file is too large to open in the text editor.');
  }

  const ext = path.extname(absolutePath).slice(1).toLowerCase();
  if (VIDEO_EXTENSIONS.includes(ext)) {
    throw new UnsupportedMediaTypeError('This file type cannot be opened in the text editor.');
  }

  const buffer = await fs.readFile(absolutePath);
  if (isProbablyBinaryBuffer(buffer)) {
    throw new UnsupportedMediaTypeError(
      'This file appears to be binary and cannot be opened in the text editor.'
    );
  }

  return { buffer, stats };
}

module.exports = { readTextFile, MAX_EDITOR_FILE_SIZE };
