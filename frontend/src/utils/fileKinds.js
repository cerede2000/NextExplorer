// Centralized file kind → human label helpers

// Images
const imageMap = {
  jpg: 'JPEG image',
  jpeg: 'JPEG image',
  png: 'PNG image',
  gif: 'GIF image',
  webp: 'WebP image',
  svg: 'SVG image',
  heic: 'HEIC image',
  heif: 'HEIF image',
  bmp: 'Bitmap image',
  tiff: 'TIFF image',
  tif: 'TIFF image',
  avif: 'AVIF image',
};

// Video
const videoMap = {
  mp4: 'MP4 video',
  mov: 'MOV video',
  mkv: 'MKV video',
  webm: 'WebM video',
  avi: 'AVI video',
  m4v: 'M4V video',
};

// Audio
const audioMap = {
  mp3: 'MP3 audio',
  wav: 'WAV audio',
  flac: 'FLAC audio',
  aac: 'AAC audio',
  m4a: 'M4A audio',
  ogg: 'OGG audio',
  opus: 'OPUS audio',
  wma: 'WMA audio',
};

// Archives
const archiveMap = {
  zip: 'ZIP archive',
  rar: 'RAR archive',
  '7z': '7z archive',
  tar: 'TAR archive',
  gz: 'GZip archive',
  bz2: 'Bzip2 archive',
  xz: 'XZ archive',
  tgz: 'TAR.GZ archive',
};

// Documents
const docMap = {
  pdf: 'PDF document',
  txt: 'Plain text document',
  rtf: 'Rich text document',
  md: 'Markdown document',
  markdown: 'Markdown document',
  csv: 'CSV document',
  doc: 'Word document',
  docx: 'Word document',
  xls: 'Excel spreadsheet',
  xlsx: 'Excel spreadsheet',
  ppt: 'PowerPoint presentation',
  pptx: 'PowerPoint presentation',
};

// Web & code
const codeMap = {
  html: 'HTML document',
  htm: 'HTML document',
  css: 'CSS stylesheet',
  scss: 'SCSS stylesheet',
  less: 'LESS stylesheet',
  js: 'JavaScript source',
  jsx: 'JavaScript source',
  ts: 'TypeScript source',
  tsx: 'TypeScript source',
  json: 'JSON document',
  yml: 'YAML document',
  yaml: 'YAML document',
  xml: 'XML document',
  sh: 'Shell script',
  bash: 'Shell script',
  zsh: 'Shell script',
  py: 'Python script',
  rb: 'Ruby script',
  php: 'PHP script',
  go: 'Go source',
  rs: 'Rust source',
  java: 'Java source',
  kt: 'Kotlin source',
  kts: 'Kotlin script',
  swift: 'Swift source',
  c: 'C source',
  cpp: 'C++ source',
  cc: 'C++ source',
  cxx: 'C++ source',
  cs: 'C# source',
};

// Fonts & vector
const fontMap = {
  ttf: 'TrueType font',
  otf: 'OpenType font',
  woff: 'Web font',
  woff2: 'Web font',
};

// Packages / installers
const pkgMap = {
  exe: 'Windows executable',
  msi: 'Windows installer',
  apk: 'Android package',
  dmg: 'Disk image',
  pkg: 'Package',
  deb: 'Linux package',
  rpm: 'Linux package',
};

// Data & config
const dataMap = {
  db: 'Database file',
  sqlite: 'SQLite database',
  sqlite3: 'SQLite database',
  ini: 'Configuration file',
  conf: 'Configuration file',
  cfg: 'Configuration file',
  toml: 'TOML configuration',
  env: 'Environment file',
  lock: 'Lock file',
  log: 'Log file',
  tmp: 'Temporary file',
  bak: 'Backup file',
};

const LOOKUP_TABLES = [
  imageMap,
  videoMap,
  audioMap,
  archiveMap,
  docMap,
  codeMap,
  fontMap,
  pkgMap,
  dataMap,
];

const lookup = (extension) => {
  for (const table of LOOKUP_TABLES) {
    if (Object.prototype.hasOwnProperty.call(table, extension)) {
      return table[extension];
    }
  }
  return null;
};

/**
 * The longest run of characters still plausibly an extension.
 *
 * The same rule the listing uses when it decides between an extension and
 * `unknown`. Without it, a name ending in `.superlongextension` — which the
 * server refused to call an extension — comes back through this door and is
 * shown as one anyway.
 */
const MAX_PLAUSIBLE_EXTENSION = 10;

/** The extension a filename ends with, or '' — a leading dot is a hidden name. */
const extensionOfName = (name) => {
  const nm = String(name || '');
  const idx = nm.lastIndexOf('.');
  if (idx <= 0 || idx >= nm.length - 1) return '';
  const extension = nm.slice(idx + 1).toLowerCase();
  return extension.length > MAX_PLAUSIBLE_EXTENSION ? '' : extension;
};

/**
 * What to call a thing in the Kind column.
 *
 * The listing sends `directory`, the file's extension, or the literal string
 * `unknown` — which it uses for a file with no extension at all, and for one
 * whose extension is too long to be plausible. `unknown` is a statement about
 * what the *server* could work out, not something to show anybody: it used to
 * reach the column as "UNKNOWN file", which is what a LICENSE or a Makefile
 * read as.
 *
 * So an unhelpful kind falls through to the filename, and the filename goes
 * through the same tables the kind does. Before, it did not: a file arriving
 * without a kind read as "MD file" where the same file with one read as
 * "Markdown document" — one file, two labels, depending on which screen asked.
 */
function labelFromKind(kind, name) {
  const k = String(kind || '').toLowerCase();

  if (k === 'directory') return 'Folder';
  if (k === 'volume') return 'Volume';

  const known = k && k !== 'unknown' ? lookup(k) : null;
  if (known) return known;
  if (k && k !== 'unknown') return `${k.toUpperCase()} file`;

  const extension = extensionOfName(name);
  if (!extension) return 'File';
  return lookup(extension) ?? `${extension.toUpperCase()} file`;
}

function getKindLabel(item) {
  if (!item) return '';
  return labelFromKind(item.kind, item.name);
}

export {
  getKindLabel,
  // export tables for potential reuse/testing
  };
