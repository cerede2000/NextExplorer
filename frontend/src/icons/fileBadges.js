/**
 * The little coloured square on a file with no thumbnail.
 *
 * This was seventy-two branches of a switch — the single most complex function
 * in the frontend — for what it plainly is: a table. Written as data it can be
 * read at a glance, added to without touching any logic, and checked as a
 * whole rather than one branch at a time.
 *
 * Grouped by what the extensions are, because that is the order someone
 * looking for a missing one will read.
 */

const BADGES = [
  // Documents
  [['doc', 'docx', 'rtf'], { label: 'DOC', bg: '#2563EB', fg: '#FFFFFF' }],
  [['xls', 'xlsx'], { label: 'XLS', bg: '#16A34A', fg: '#FFFFFF' }],
  [['ppt', 'pptx'], { label: 'PPT', bg: '#F97316', fg: '#FFFFFF' }],
  [['csv'], { label: 'CSV', bg: '#22C55E', fg: '#FFFFFF' }],
  [['txt'], { label: 'TXT', bg: '#6B7280', fg: '#FFFFFF' }],
  [['md', 'markdown'], { label: 'MD', bg: '#0EA5E9', fg: '#FFFFFF' }],

  // Web & styles
  [['html', 'htm'], { label: 'HTML', bg: '#E44D26', fg: '#FFFFFF' }],
  [['css'], { label: 'CSS', bg: '#2965F1', fg: '#FFFFFF' }],
  [['scss'], { label: 'SCSS', bg: '#C6538C', fg: '#FFFFFF' }],
  [['less'], { label: 'LESS', bg: '#1D365D', fg: '#FFFFFF' }],

  // Scripts & code
  [['js'], { label: 'JS', bg: '#F7DF1E', fg: '#000000' }],
  [['ts'], { label: 'TS', bg: '#3178C6', fg: '#FFFFFF' }],
  [['jsx'], { label: 'JSX', bg: '#61DAFB', fg: '#000000' }],
  [['tsx'], { label: 'TSX', bg: '#3178C6', fg: '#FFFFFF' }],
  [['vue'], { label: 'VUE', bg: '#41B883', fg: '#0B1921' }],
  [['json'], { label: 'JSON', bg: '#8B5CF6', fg: '#FFFFFF' }],
  [['yml', 'yaml'], { label: 'YAML', bg: '#14B8A6', fg: '#073B3A' }],
  [['xml'], { label: 'XML', bg: '#EC4899', fg: '#FFFFFF' }],
  [['sh', 'bash', 'zsh'], { label: 'SH', bg: '#374151', fg: '#FFFFFF' }],
  [['py'], { label: 'PY', bg: '#3776AB', fg: '#FFFFFF' }],
  [['rb'], { label: 'RB', bg: '#CC342D', fg: '#FFFFFF' }],
  [['php'], { label: 'PHP', bg: '#777BB4', fg: '#FFFFFF' }],
  [['go'], { label: 'GO', bg: '#00ADD8', fg: '#073B4C' }],
  [['rs'], { label: 'RS', bg: '#DEA584', fg: '#000000' }],
  [['java'], { label: 'JAVA', bg: '#E11D48', fg: '#FFFFFF' }],
  [['kt', 'kts'], { label: 'KT', bg: '#7F52FF', fg: '#FFFFFF' }],
  [['swift'], { label: 'SWIFT', bg: '#FA7343', fg: '#FFFFFF' }],
  [['c'], { label: 'C', bg: '#5C6BC0', fg: '#FFFFFF' }],
  [['cpp', 'cc', 'cxx'], { label: 'CPP', bg: '#00599C', fg: '#FFFFFF' }],
  [['cs'], { label: 'CS', bg: '#239120', fg: '#FFFFFF' }],

  // Data & config
  [['sql'], { label: 'SQL', bg: '#0EA5E9', fg: '#FFFFFF' }],
  [['db', 'sqlite', 'sqlite3'], { label: 'DB', bg: '#0EA5E9', fg: '#FFFFFF' }],
  [['ini', 'conf', 'cfg'], { label: 'CFG', bg: '#6B7280', fg: '#FFFFFF' }],
  [['toml'], { label: 'TOML', bg: '#0F766E', fg: '#FFFFFF' }],
  [['env'], { label: 'ENV', bg: '#059669', fg: '#FFFFFF' }],

  // Fonts & vector
  [['svg'], { label: 'SVG', bg: '#8B5CF6', fg: '#FFFFFF' }],
  [['ttf', 'otf', 'woff', 'woff2'], { label: 'FONT', bg: '#9CA3AF', fg: '#111827' }],

  // Locks
  [['lock'], { label: 'LOCK', bg: '#6B7280', fg: '#FFFFFF' }],

  // Creative & design
  [['psd'], { label: 'PSD', bg: '#001E36', fg: '#00C8FF' }],
  [['ai'], { label: 'AI', bg: '#300000', fg: '#FF9A00' }],
  [['fig'], { label: 'FIG', bg: '#A259FF', fg: '#FFFFFF' }],
  [['sketch'], { label: 'SKETCH', bg: '#FDB300', fg: '#111827' }],

  // Packages / installers
  [['exe'], { label: 'EXE', bg: '#111827', fg: '#FFFFFF' }],
  [['msi'], { label: 'MSI', bg: '#0EA5E9', fg: '#FFFFFF' }],
  [['apk'], { label: 'APK', bg: '#34D399', fg: '#073B3A' }],
  [['dmg'], { label: 'DMG', bg: '#6B7280', fg: '#FFFFFF' }],
  [['pkg'], { label: 'PKG', bg: '#F59E0B', fg: '#111827' }],
  [['deb'], { label: 'DEB', bg: '#CC0000', fg: '#FFFFFF' }],
  [['rpm'], { label: 'RPM', bg: '#EE0000', fg: '#FFFFFF' }],

  // Misc
  [['log'], { label: 'LOG', bg: '#9CA3AF', fg: '#111827' }],
  [['tmp'], { label: 'TMP', bg: '#D1D5DB', fg: '#111827' }],
  [['bak'], { label: 'BAK', bg: '#D1D5DB', fg: '#111827' }],
];

const byExtension = new Map(
  BADGES.flatMap(([extensions, badge]) => extensions.map((extension) => [extension, badge]))
);

/**
 * @param {string} extension lower-case, without the dot
 * @returns {{label: string, bg: string, fg: string}|null} null when this kind
 *   of file has no badge of its own and falls back to a plain file icon
 */
export const badgeForExtension = (extension) => byExtension.get(extension) || null;

export { BADGES };
